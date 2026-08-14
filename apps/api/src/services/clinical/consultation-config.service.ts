/**
 * appointment → screen. The one place that decides which template applies.
 *
 * ⚠️ `apps/web` DECIDES NOTHING (§33). There is no specialty in a component, no
 *   `if (specialty === 'DENTISTRY')` in a page, and no fallback in the browser
 *   for a configuration that did not resolve. This service answers the whole
 *   question and the engine renders exactly what it is handed — which is what
 *   makes adding a specialty a configuration row rather than a screen.
 *
 * ── THE WALK ─────────────────────────────────────────────────────────────────
 *
 *   appointment ─→ patient.subject_type ──────→ CARE CONTEXT root (CD-3, CD-4)
 *               └→ doctor_profile
 *                    └→ doctor_specialties (is_primary)
 *                         └→ ancestors, root-first  = the taxonomy PATH
 *
 *   candidates = active templates in that care context, attached to a node ON
 *   the path or to the context itself, each with its published version
 *                         │
 *                         ▼
 *              `resolveTemplate` in @rcln/clinical — most specific wins
 *                         │
 *                         ▼
 *   the definition's SCOPE CODES → taxonomy ids, for the selectors to rank by
 *
 * ⚠️ THE PATIENT DECIDES THE CARE CONTEXT, NOT THE DOCTOR. A veterinary practice
 *   whose vet is classified under a HUMAN node — which is the state every
 *   veterinary clinic starts in, because the veterinary subtree ships empty
 *   (§42.7) — must not be given a human consultation for a dog. So the subject's
 *   context is authoritative and the doctor's classification only narrows WITHIN
 *   it; a doctor whose path leads to a different root contributes nothing but
 *   the root itself.
 *
 * ⚠️ NO `data_access_logs` ROW, AND THAT IS A DECISION RATHER THAN AN OMISSION.
 *   This response discloses CONFIGURATION — section labels, field descriptors,
 *   which vocabulary to rank — and no clinical content whatever about the person
 *   in the chair. The reads that DO disclose one patient are audited
 *   (`GET /appointments/:id`, the episode reads, the vitals), and burying them
 *   under a row per consultation screen open is the same mistake as auditing the
 *   day board. Ids only, as everywhere.
 */
import { withTenant, type TenantContext, type TxClient } from '@rcln/db';
import {
  resolveTemplate,
  visibleSections,
  type FieldDescriptor,
  type TemplateCandidate,
} from '@rcln/clinical';
import type {
  ConsultationConfigResponse,
  ConsultationFieldConfig,
  ConsultationSectionConfig,
} from '@rcln/contracts';
import { NotFoundError, ValidationError } from '../../utils/errors.js';
import { parseStoredDefinition } from './definition.js';

/**
 * Which care-context ROOT a subject belongs under.
 *
 * ⚠️ THE ONLY THING IN THE ENTIRE CONSULTATION ENGINE THAT BRANCHES ON
 *   `subject_type`, and the schema comment on `CareSubjectType` says so. §4 asks
 *   that the architecture stop assuming humans; §42.7 forbids building
 *   veterinary functionality now. This mapping satisfies the first without doing
 *   the second: two codes, resolved to rows, and nothing else in the product
 *   knows the difference.
 *
 * The codes are the platform taxonomy's, seeded in `data/specialties.ts`.
 */
const CARE_CONTEXT_CODE: Readonly<Record<string, string>> = {
  HUMAN: 'HUMAN',
  ANIMAL: 'VET',
};

/**
 * A parsed descriptor onto the wire shape.
 *
 * ⚠️ COPIED RATHER THAN PASSED THROUGH, AND NOT ONLY BECAUSE THE PARSED FORM IS
 *   DEEPLY READONLY. The two types are allowed to diverge — the engine's
 *   descriptor is what the parser guarantees, and the contract is what a
 *   consumer may rely on — and a spread would silently ship any key the engine
 *   later adds for its own use.
 */
function toFieldConfig(field: FieldDescriptor): ConsultationFieldConfig {
  return {
    key: field.key,
    type: field.type,
    label: field.label,
    required: field.required,
    ...(field.hint !== undefined ? { hint: field.hint } : {}),
    ...(field.placeholder !== undefined ? { placeholder: field.placeholder } : {}),
    ...(field.options !== undefined
      ? { options: field.options.map((option) => ({ value: option.value, label: option.label })) }
      : {}),
    ...(field.unit !== undefined ? { unit: field.unit } : {}),
    ...(field.precision !== undefined ? { precision: field.precision } : {}),
    ...(field.min !== undefined ? { min: field.min } : {}),
    ...(field.max !== undefined ? { max: field.max } : {}),
    ...(field.maxLength !== undefined ? { maxLength: field.maxLength } : {}),
    ...(field.masterKind !== undefined ? { masterKind: field.masterKind } : {}),
    ...(field.source !== undefined ? { source: field.source } : {}),
  };
}

interface CareContextRow {
  id: string;
  code: string;
  name: string;
}

/**
 * The taxonomy path, ROOT FIRST, from the care context down to the doctor's
 * primary classification.
 *
 * Returns just the root when the doctor has no classification, or when theirs
 * hangs off a different care context — see the file header.
 */
async function taxonomyPath(
  tx: TxClient,
  careContext: CareContextRow,
  doctorProfileId: string
): Promise<string[]> {
  const primary = await tx.doctorSpecialty.findFirst({
    where: { doctorProfileId, isActive: true, isPrimary: true },
    select: { specialtyId: true },
  });
  /*
   * ⚠️ FALLS BACK TO ANY ACTIVE CLASSIFICATION RATHER THAN TO NONE. Zero primary
   *   specialties is legal — `doctor_specialties.is_primary` says so in as many
   *   words — and a doctor with one recorded specialty that nobody nominated as
   *   the headline should still get that specialty's template rather than the
   *   care context's general one.
   */
  const fallback =
    primary ??
    (await tx.doctorSpecialty.findFirst({
      where: { doctorProfileId, isActive: true },
      select: { specialtyId: true },
      orderBy: { createdAt: 'asc' },
    }));

  if (!fallback) return [careContext.id];

  const rows = await tx.$queryRaw<{ id: string; depth: number }[]>`
    WITH RECURSIVE up AS (
      SELECT s.id, s.parent_id, 0 AS depth
        FROM specialties s
       WHERE s.id = ${fallback.specialtyId}::uuid AND s.deleted_at IS NULL
      UNION ALL
      SELECT p.id, p.parent_id, u.depth + 1
        FROM specialties p
        JOIN up u ON u.parent_id = p.id
       WHERE p.deleted_at IS NULL
    )
    SELECT up.id, up.depth FROM up ORDER BY up.depth DESC
  `;

  const path = rows.map((row) => row.id);
  /*
   * ⚠️ THE ROOT OF THE DOCTOR'S PATH MUST BE THE SUBJECT'S CARE CONTEXT. If it
   *   is not, the doctor is classified under another context entirely and their
   *   path says nothing about this consultation — see the header. The root is
   *   still known, so resolution still succeeds; it just lands on the default.
   */
  if (path[0] !== careContext.id) return [careContext.id];
  return path;
}

async function careContextFor(tx: TxClient, subjectType: string): Promise<CareContextRow> {
  const code = CARE_CONTEXT_CODE[subjectType];
  if (code === undefined) {
    throw new ValidationError(`This patient's care context (${subjectType}) is not configured.`);
  }

  const row = await tx.specialty.findFirst({
    where: { code, type: 'CARE_CONTEXT', deletedAt: null },
    select: { id: true, code: true, name: true },
    /* A clinic's own node of that code first, then the platform's. Same
       precedence every other platform-extensible read uses. */
    orderBy: { organizationId: 'desc' },
  });
  if (!row) {
    throw new ValidationError(
      `The "${code}" care context is missing from the clinical taxonomy, so no consultation template can be resolved. Seed it, or add the node.`
    );
  }
  return row;
}

/**
 * Resolve the consultation configuration for one appointment.
 *
 * ⚠️ A FAILURE HERE IS AN ERROR, NOT AN EMPTY SCREEN. "No template applies" is a
 *   state somebody has to fix — usually by publishing the draft that was never
 *   published — and a clinician must not discover it as a blank consultation
 *   with a patient in the chair.
 */
export async function getConsultationConfig(
  ctx: TenantContext,
  appointmentId: string
): Promise<ConsultationConfigResponse> {
  return withTenant(ctx, async (tx) => {
    const appointment = await tx.appointment.findFirst({
      where: { id: appointmentId, deletedAt: null },
      select: {
        id: true,
        branchId: true,
        patientId: true,
        doctorProfileId: true,
        clinicalEpisodeId: true,
        patient: { select: { subjectType: true } },
      },
    });
    /* 404, never 403 — RLS has already filtered another tenant's booking out. */
    if (!appointment) throw new NotFoundError('Appointment');
    /*
     * ⚠️ 404 FOR A BRANCH OUTSIDE THE CALLER'S SCOPE, for the reason every other
     *   service in this codebase gives: whether a branch exists is itself tenant
     *   information, and the two responses tell an outsider apart from a
     *   colleague.
     */
    if (!ctx.branchIds.includes(appointment.branchId)) throw new NotFoundError('Appointment');

    const careContext = await careContextFor(tx, appointment.patient.subjectType);
    const path = await taxonomyPath(tx, careContext, appointment.doctorProfileId);

    /*
     * Candidates: every active template in this care context whose node is on
     * the path (or which IS the context default), with its published version.
     *
     * ⚠️ THE `specialtyId: null` BRANCH IS NOT AN OPTIMISATION. It is the
     *   care-context default — the template a doctor with no classification at
     *   all resolves to (Scenario 3), and the reason resolution never returns
     *   nothing.
     */
    const rows = await tx.consultationTemplate.findMany({
      where: {
        deletedAt: null,
        isActive: true,
        careContextId: careContext.id,
        OR: [{ specialtyId: null }, { specialtyId: { in: path } }],
      },
      select: {
        id: true,
        organizationId: true,
        code: true,
        name: true,
        specialtyId: true,
      },
    });

    /*
     * ⚠️ THE PUBLISHED VERSIONS ARE LOADED BY `template_id` AND NOT THROUGH THE
     *   `versions` RELATION, AND THIS IS NOT A STYLE CHOICE — IT IS THE ONE
     *   THING THAT MAKES THE PLATFORM TEMPLATE RESOLVE AT ALL.
     *
     *   The relation is composite: (organization_id, template_id) ->
     *   (organization_id, id). For a PLATFORM row `organization_id` is NULL, so
     *   Prisma's join compiles to `organization_id = NULL`, which is NULL rather
     *   than true — and the relation comes back EMPTY for exactly the rows every
     *   clinic depends on. Nothing errors: the template is found, it simply
     *   appears never to have been published, and resolution refuses with "no
     *   published template applies" for every unclassified doctor on the
     *   platform.
     *
     *   `master.service.ts` loads its codings the same way, for the same reason.
     *   RLS still scopes this read — the policy is on the table, not the join.
     */
    const versions = await tx.consultationTemplateVersion.findMany({
      where: { templateId: { in: rows.map((row) => row.id) }, status: 'PUBLISHED' },
      select: { id: true, templateId: true, version: true, definition: true },
    });
    const publishedByTemplate = new Map(versions.map((version) => [version.templateId, version]));

    const candidates: TemplateCandidate[] = rows.map((row) => {
      const published = publishedByTemplate.get(row.id);
      return {
        templateId: row.id,
        code: row.code,
        specialtyId: row.specialtyId,
        isOwn: row.organizationId !== null,
        publishedVersion:
          published === undefined
            ? null
            : {
                versionId: published.id,
                version: published.version,
                definition: parseStoredDefinition(
                  published.definition,
                  `${row.code} version ${published.version}`
                ),
              },
      };
    });

    const resolution = resolveTemplate({ taxonomyPath: path, candidates });
    if (!resolution.ok) throw new ValidationError(resolution.problem);

    const template = rows.find((row) => row.id === resolution.value.templateId);
    if (!template) throw new NotFoundError('Consultation template');

    /*
     * ── SCOPE CODES → TAXONOMY IDS ─────────────────────────────────────────
     *
     * ⚠️ RESOLVED HERE AND NEVER STORED IN THE DOCUMENT (CD-6, ADR-0006). The
     *   template names `DENTISTRY`; the id it maps to belongs to one tenant and
     *   would make the document uncopyable and unconstrained.
     *
     * ⚠️ AND A CODE THAT MATCHES NOTHING IS DROPPED RATHER THAN FATAL. A scope
     *   RANKS and never FILTERS (§34), so losing one makes a term sort lower and
     *   changes nothing about what a clinician can record. Refusing the whole
     *   consultation over a display preference would be the wrong trade — the
     *   same asymmetry the vocabulary seed makes.
     */
    const definition = resolution.value.definition;
    const wantedCodes = new Set<string>(definition.scopes);
    for (const section of definition.sections) {
      for (const code of section.scopes ?? []) wantedCodes.add(code);
    }

    const scopeNodes =
      wantedCodes.size === 0
        ? []
        : await tx.specialty.findMany({
            where: { code: { in: [...wantedCodes] }, deletedAt: null },
            select: { id: true, code: true },
          });
    const idsByCode = new Map<string, string[]>();
    for (const node of scopeNodes) {
      const list = idsByCode.get(node.code) ?? [];
      list.push(node.id);
      idsByCode.set(node.code, list);
    }
    const idsFor = (codes: readonly string[]): string[] => [
      ...new Set(codes.flatMap((code) => idsByCode.get(code) ?? [])),
    ];

    const sections: ConsultationSectionConfig[] = visibleSections(definition.sections).map(
      (section) => ({
        type: section.type,
        key: section.key,
        label: section.label,
        order: section.order,
        required: section.required,
        ...(section.fields !== undefined ? { fields: section.fields.map(toFieldConfig) } : {}),
        /* The section's own scopes if it names any, otherwise the template's. */
        scopeIds: idsFor(section.scopes ?? definition.scopes),
        ...(section.mapCode !== undefined ? { mapCode: section.mapCode } : {}),
      })
    );

    return {
      appointmentId: appointment.id,
      patientId: appointment.patientId,
      clinicalEpisodeId: appointment.clinicalEpisodeId,
      doctorProfileId: appointment.doctorProfileId,
      careContext,
      template: {
        id: template.id,
        code: template.code,
        name: template.name,
        versionId: resolution.value.versionId,
        version: resolution.value.version,
        matchedSpecialtyId: resolution.value.matchedSpecialtyId,
        matchedDepth: resolution.value.matchedDepth,
      },
      sections,
    };
  });
}
