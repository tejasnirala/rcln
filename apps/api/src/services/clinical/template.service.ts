/**
 * Consultation templates — the configuration a consultation is built from (CE-2).
 *
 * ⚠️ NO PHI IN THIS FILE. A template names no patient and no clinician; its
 *   labels are dictionary entries. Nothing here is read-audited, and nothing
 *   here joins to `patients`. Contrast `episode.service.ts`, where every read of
 *   one record writes a `data_access_logs` row.
 *
 * ── THE TWO RULES THAT MATTER, AND WHAT BREAKS WITHOUT THEM ──────────────────
 *
 *   1. NOTHING READS A RAW `definition`. Every path in and out of this file goes
 *      through `parseTemplateDefinition` from `@rcln/clinical`, which refuses a
 *      document that says nothing checkable (CD-10). The moment one caller
 *      reaches into the JSONB directly, `{ "require": true }` becomes a
 *      mandatory field silently switched off on a clinical form.
 *
 *   2. A PUBLISHED VERSION IS IMMUTABLE IN EVERY FIELD, INCLUDING ITS DATES.
 *      `assertVersionIsDraft` guards every writer — the lesson PI-5's
 *      `assertPackIsOpen` records. Editing a live template is PUBLISHING A NEW
 *      VERSION, because a finalized consultation's snapshot (§29) is a statement
 *      about the configuration that existed when it was made, and rewriting v3
 *      makes every record citing v3 a claim about a document that no longer
 *      exists.
 *
 * ⚠️ THE WRITE PATH CANNOT TOUCH A PLATFORM TEMPLATE, AND THAT IS ENFORCED THREE
 *   TIMES — `tenant_isolation`'s WITH CHECK, the `platform_rows_immutable`
 *   trigger, and `assertMutable` below, which runs first only so the caller gets
 *   a sentence rather than a constraint name. Same shape as `master.service.ts`.
 */
import { withTenant, type TenantContext, type TxClient } from '@rcln/db';
import { parseTemplateDefinition, visibleSections } from '@rcln/clinical';
import type {
  ConsultationTemplate,
  ConsultationTemplateDetail,
  ConsultationTemplateListResponse,
  ConsultationTemplateQuery,
  ConsultationTemplateVersionSummary,
  CreateConsultationTemplateRequest,
  SaveTemplateVersionRequest,
  UpdateConsultationTemplateRequest,
} from '@rcln/contracts';
import { ConflictError, NotFoundError, ValidationError } from '../../utils/errors.js';
import { recordAudit } from '../audit/audit.service.js';
import { parseStoredDefinition } from './definition.js';

export interface TemplateActionOptions {
  ipAddress?: string | undefined;
  userAgent?: string | undefined;
}

interface VersionRow {
  id: string;
  version: number;
  status: 'DRAFT' | 'PUBLISHED' | 'RETIRED';
  publishedAt: Date | null;
  retiredAt: Date | null;
  definition: unknown;
}

function assertMutable(row: { organizationId: string | null }): void {
  if (row.organizationId === null) {
    throw new ValidationError(
      'This is a platform-wide consultation template and cannot be modified. Create your own for the same specialty instead — yours will take precedence.'
    );
  }
}

/**
 * ⚠️ THE GUARD, AND IT IS DELIBERATELY NOT "if (status === 'PUBLISHED')". A
 *   RETIRED version is not editable either: encounters cite it, and its whole
 *   purpose is to render a five-year-old record exactly as it was made.
 */
function assertVersionIsDraft(row: { status: string; version: number }): void {
  if (row.status !== 'DRAFT') {
    throw new ConflictError(
      `Version ${row.version} is ${row.status.toLowerCase()} and cannot be edited. Consultations already cite it. Create a new draft instead.`
    );
  }
}

function summarize(row: VersionRow): ConsultationTemplateVersionSummary {
  /*
   * The counts come from the PARSED document, which is why a broken one is an
   * error here too — a summary claiming "8 sections" over a document nothing can
   * read is worse than no summary at all.
   */
  const definition = parseStoredDefinition(row.definition, `Version ${row.version}`);
  return {
    id: row.id,
    version: row.version,
    status: row.status,
    publishedAt: row.publishedAt?.toISOString() ?? null,
    retiredAt: row.retiredAt?.toISOString() ?? null,
    sectionCount: definition.sections.length,
    visibleSectionCount: visibleSections(definition.sections).length,
  };
}

const VERSION_SELECT = {
  id: true,
  version: true,
  status: true,
  publishedAt: true,
  retiredAt: true,
  definition: true,
} as const;

const TEMPLATE_SELECT = {
  id: true,
  organizationId: true,
  code: true,
  name: true,
  description: true,
  careContextId: true,
  specialtyId: true,
  isActive: true,
  careContext: { select: { name: true } },
  specialty: { select: { name: true } },
} as const;

interface TemplateRow {
  id: string;
  organizationId: string | null;
  code: string;
  name: string;
  description: string | null;
  careContextId: string;
  specialtyId: string | null;
  isActive: boolean;
  careContext: { name: string };
  specialty: { name: string } | null;
}

function toTemplate(row: TemplateRow, versions: readonly VersionRow[]): ConsultationTemplate {
  const published = versions.find((v) => v.status === 'PUBLISHED');
  const draft = versions.find((v) => v.status === 'DRAFT');
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    description: row.description,
    careContextId: row.careContextId,
    careContextName: row.careContext.name,
    specialtyId: row.specialtyId,
    specialtyName: row.specialty?.name ?? null,
    isActive: row.isActive,
    isOwn: row.organizationId !== null,
    publishedVersion: published ? summarize(published) : null,
    draftVersion: draft ? summarize(draft) : null,
  };
}

async function loadTemplate(tx: TxClient, templateId: string): Promise<TemplateRow> {
  const row = await tx.consultationTemplate.findFirst({
    where: { id: templateId, deletedAt: null },
    select: TEMPLATE_SELECT,
  });
  /*
   * ⚠️ 404, NEVER 403, for a template belonging to another tenant. RLS has
   *   already filtered it out of the read, so it is genuinely indistinguishable
   *   from one that does not exist — and a 403 would confirm the id is real to
   *   somebody probing for it.
   */
  if (!row) throw new NotFoundError('Consultation template');
  return row;
}

async function versionsOf(tx: TxClient, templateId: string): Promise<VersionRow[]> {
  return tx.consultationTemplateVersion.findMany({
    where: { templateId },
    select: VERSION_SELECT,
    orderBy: { version: 'desc' },
  });
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export async function listTemplates(
  ctx: TenantContext,
  query: ConsultationTemplateQuery
): Promise<ConsultationTemplateListResponse> {
  return withTenant(ctx, async (tx) => {
    const where = {
      deletedAt: null,
      ...(query.includeInactive ? {} : { isActive: true }),
      ...(query.careContextId !== undefined ? { careContextId: query.careContextId } : {}),
    };

    const [rows, total] = await Promise.all([
      tx.consultationTemplate.findMany({
        where,
        select: TEMPLATE_SELECT,
        /*
         * A clinic's own templates first, then by care context and code. The
         * order is total — `code` is unique per tenant — so two runs of the same
         * query return the same page, which an offset-paginated list otherwise
         * cannot promise.
         */
        orderBy: [{ organizationId: 'desc' }, { careContextId: 'asc' }, { code: 'asc' }],
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
      }),
      tx.consultationTemplate.count({ where }),
    ]);

    const versions = await tx.consultationTemplateVersion.findMany({
      where: { templateId: { in: rows.map((r) => r.id) }, status: { in: ['DRAFT', 'PUBLISHED'] } },
      select: { ...VERSION_SELECT, templateId: true },
    });
    const byTemplate = new Map<string, VersionRow[]>();
    for (const version of versions) {
      const list = byTemplate.get(version.templateId) ?? [];
      list.push(version);
      byTemplate.set(version.templateId, list);
    }

    return {
      templates: rows.map((row) => toTemplate(row, byTemplate.get(row.id) ?? [])),
      total,
      page: query.page,
      pageSize: query.pageSize,
    };
  });
}

/**
 * One template, its whole version history, and one version's document.
 *
 * `versionId` absent means the published version, or the draft if nothing is
 * published — which is what an admin screen wants to open on, and which is
 * deliberately NOT "the newest row": a retired v2 is newer than a published v1
 * only in the sense that nobody is using it.
 */
export async function getTemplate(
  ctx: TenantContext,
  templateId: string,
  versionId?: string | undefined
): Promise<ConsultationTemplateDetail> {
  return withTenant(ctx, async (tx) => {
    const row = await loadTemplate(tx, templateId);
    const versions = await versionsOf(tx, templateId);

    const chosen =
      versionId !== undefined
        ? versions.find((v) => v.id === versionId)
        : (versions.find((v) => v.status === 'PUBLISHED') ??
          versions.find((v) => v.status === 'DRAFT'));
    if (versionId !== undefined && chosen === undefined)
      throw new NotFoundError('Template version');

    return {
      ...toTemplate(row, versions),
      versions: versions.map(summarize),
      definition: chosen
        ? parseStoredDefinition(chosen.definition, `Version ${chosen.version}`)
        : null,
    };
  });
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

/**
 * Create a template, and its first draft.
 *
 * ⚠️ THE FIRST DRAFT IS CREATED HERE RATHER THAN LEFT TO A SECOND CALL. A
 *   template with no version at all resolves to nothing, appears in the admin
 *   list as though it were configuration, and is indistinguishable on screen
 *   from one whose draft is simply unpublished. The draft ships with the default
 *   consultation in it, which is a starting point rather than a blank document.
 */
export async function createTemplate(
  ctx: TenantContext,
  input: CreateConsultationTemplateRequest,
  defaultDefinition: unknown,
  options: TemplateActionOptions = {}
): Promise<ConsultationTemplateDetail> {
  const definition = parseStoredDefinition(defaultDefinition, 'The starting configuration');

  const templateId = await withTenant(ctx, async (tx) => {
    /*
     * ⚠️ THE DUPLICATE CHECK SPANS PLATFORM ROWS TOO. The unique is
     *   (organization_id, code) NULLS NOT DISTINCT, so a clinic CAN legally
     *   create `GENERAL_HUMAN` beside the platform's — and then has two templates
     *   that render identically in the admin list with no way to tell which one
     *   a consultation used. Refusing is the useful answer.
     */
    const clash = await tx.consultationTemplate.findFirst({
      where: { code: input.code, deletedAt: null },
      select: { organizationId: true },
    });
    if (clash) {
      throw new ConflictError(
        clash.organizationId === null
          ? 'A platform-wide template already uses that code.'
          : 'That code is already in use.'
      );
    }

    const careContext = await tx.specialty.findFirst({
      where: { id: input.careContextId, deletedAt: null },
      select: { id: true, type: true, parentId: true },
    });
    if (!careContext) throw new NotFoundError('Care context');
    /*
     * ⚠️ THE CARE CONTEXT MUST BE A `CARE_CONTEXT` ROOT (CD-3). A template
     *   anchored halfway down the tree resolves for the doctors beneath it and
     *   silently not for anybody else — and the symptom is "no template applies"
     *   for a doctor whose classification looks perfectly ordinary.
     */
    if (careContext.type !== 'CARE_CONTEXT') {
      throw new ValidationError(
        'A template belongs to a care context — the root of the clinical taxonomy, such as Human or Veterinary.'
      );
    }

    if (input.specialtyId !== undefined) {
      const node = await tx.specialty.findFirst({
        where: { id: input.specialtyId, deletedAt: null },
        select: { id: true },
      });
      if (!node) throw new NotFoundError('Specialty');
      /*
       * ⚠️ AND IT MUST SIT UNDER THAT CARE CONTEXT. A dentistry template
       *   anchored under the veterinary root is a document nobody can ever
       *   resolve — the walk starts at the patient's care context, so a node
       *   under a different root is never on the path.
       */
      const underContext = await tx.$queryRaw<{ ok: boolean }[]>`
        WITH RECURSIVE up AS (
          SELECT s.id, s.parent_id
            FROM specialties s
           WHERE s.id = ${input.specialtyId}::uuid AND s.deleted_at IS NULL
          UNION ALL
          SELECT p.id, p.parent_id
            FROM specialties p
            JOIN up ON up.parent_id = p.id
           WHERE p.deleted_at IS NULL
        )
        SELECT EXISTS (SELECT 1 FROM up WHERE up.id = ${input.careContextId}::uuid) AS ok
      `;
      if (underContext[0]?.ok !== true) {
        throw new ValidationError(
          'That specialty does not sit under the care context this template belongs to.'
        );
      }
    }

    const created = await tx.consultationTemplate.create({
      data: {
        organizationId: ctx.organizationId,
        code: input.code,
        name: input.name,
        ...(input.description !== undefined ? { description: input.description } : {}),
        careContextId: input.careContextId,
        ...(input.specialtyId !== undefined ? { specialtyId: input.specialtyId } : {}),
        /*
         * ⚠️ THE NESTED CREATE SETS NO `organizationId` OF ITS OWN, AND IT MUST
         *   NOT. The relation is composite — (organization_id, template_id) ->
         *   (organization_id, id) — so Prisma writes both halves from the parent
         *   it is nested under. Naming it here is not a belt-and-braces: it is a
         *   second source of truth for the column the composite FK exists to
         *   constrain.
         */
        versions: { create: { version: 1, definition: definition as object } },
      },
      select: { id: true },
    });

    await recordAudit(tx, ctx, {
      action: 'CREATE',
      entityType: 'consultation_template',
      entityId: created.id,
      after: {
        id: created.id,
        code: input.code,
        name: input.name,
        careContextId: input.careContextId,
        specialtyId: input.specialtyId ?? null,
      },
      ...options,
    });

    return created.id;
  });

  return getTemplate(ctx, templateId);
}

export async function updateTemplate(
  ctx: TenantContext,
  templateId: string,
  input: UpdateConsultationTemplateRequest,
  options: TemplateActionOptions = {}
): Promise<ConsultationTemplateDetail> {
  await withTenant(ctx, async (tx) => {
    const existing = await loadTemplate(tx, templateId);
    assertMutable(existing);

    const updated = await tx.consultationTemplate.update({
      where: { id: templateId },
      data: {
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.description !== undefined ? { description: input.description } : {}),
        ...(input.isActive !== undefined ? { isActive: input.isActive } : {}),
      },
      select: { name: true, description: true, isActive: true },
    });

    await recordAudit(tx, ctx, {
      action: 'UPDATE',
      entityType: 'consultation_template',
      entityId: templateId,
      before: {
        name: existing.name,
        description: existing.description,
        isActive: existing.isActive,
      },
      after: updated,
      ...options,
    });
  });

  return getTemplate(ctx, templateId);
}

/**
 * Start a new draft, seeded from the published version.
 *
 * ⚠️ SEEDED, NOT BLANK. "Editing a live template" is what a clinic means when it
 *   asks for this, and handing back an empty document means the next publish
 *   silently discards every section anybody configured. The draft is a COPY, so
 *   the published version keeps rendering every consultation in progress until
 *   the moment the new one goes live.
 */
export async function createDraft(
  ctx: TenantContext,
  templateId: string,
  options: TemplateActionOptions = {}
): Promise<ConsultationTemplateDetail> {
  await withTenant(ctx, async (tx) => {
    const template = await loadTemplate(tx, templateId);
    assertMutable(template);

    const versions = await versionsOf(tx, templateId);
    const existingDraft = versions.find((v) => v.status === 'DRAFT');
    if (existingDraft) {
      /*
       * ⚠️ THE PARTIAL UNIQUE INDEX REFUSES THIS TOO. This check runs first so
       *   the caller gets a sentence naming the draft they already have, rather
       *   than a constraint name — and so two people editing the same
       *   configuration find out from each other's draft rather than from a 500.
       */
      throw new ConflictError(
        `This template already has an open draft (version ${existingDraft.version}). Edit or publish that one.`
      );
    }

    const published = versions.find((v) => v.status === 'PUBLISHED');
    const source = published ?? versions[0];
    if (!source) throw new NotFoundError('Template version');

    const nextVersion = Math.max(...versions.map((v) => v.version)) + 1;
    const created = await tx.consultationTemplateVersion.create({
      data: {
        organizationId: ctx.organizationId,
        templateId,
        version: nextVersion,
        definition: parseStoredDefinition(source.definition, `Version ${source.version}`) as object,
      },
      select: { id: true, version: true },
    });

    await recordAudit(tx, ctx, {
      action: 'CREATE',
      entityType: 'consultation_template_version',
      entityId: created.id,
      after: { templateId, version: created.version, status: 'DRAFT', copiedFrom: source.version },
      ...options,
    });
  });

  return getTemplate(ctx, templateId);
}

/**
 * Save a draft's document.
 *
 * ⚠️ THE PARSE IS THE VALIDATION, AND IT HAPPENS BEFORE THE WRITE. A document
 *   that says nothing checkable never reaches the column, so nothing downstream
 *   has to cope with one — which is what lets the resolver treat a stored
 *   definition as trustworthy.
 */
export async function saveDraft(
  ctx: TenantContext,
  templateId: string,
  versionId: string,
  input: SaveTemplateVersionRequest,
  options: TemplateActionOptions = {}
): Promise<ConsultationTemplateDetail> {
  const parsed = parseTemplateDefinition(input.definition);
  if (!parsed.ok) throw new ValidationError(`This configuration is not usable: ${parsed.problem}`);

  await withTenant(ctx, async (tx) => {
    const template = await loadTemplate(tx, templateId);
    assertMutable(template);

    const version = await tx.consultationTemplateVersion.findFirst({
      where: { id: versionId, templateId },
      select: { id: true, version: true, status: true },
    });
    if (!version) throw new NotFoundError('Template version');
    assertVersionIsDraft(version);

    await tx.consultationTemplateVersion.update({
      where: { id: versionId },
      data: { definition: parsed.value as object },
    });

    /*
     * ⚠️ THE AUDIT ROW CARRIES THE SHAPE, NOT THE DOCUMENT. A definition is a
     *   few kilobytes of labels and descriptors; writing it into `audit_logs` on
     *   every keystroke-driven save would bury every other entry in the table.
     *   The version is what a reader needs, and the document is one read away.
     */
    await recordAudit(tx, ctx, {
      action: 'UPDATE',
      entityType: 'consultation_template_version',
      entityId: versionId,
      after: {
        templateId,
        version: version.version,
        sectionCount: parsed.value.sections.length,
        visibleSectionCount: visibleSections(parsed.value.sections).length,
      },
      ...options,
    });
  });

  return getTemplate(ctx, templateId, versionId);
}

/**
 * Put a draft live.
 *
 * ⚠️ RETIRE THEN PUBLISH, IN THAT ORDER, IN ONE TRANSACTION. The partial unique
 *   index allows one PUBLISHED version per template and is checked per
 *   statement, so publishing first would violate it — and, far worse, a split
 *   into two transactions leaves a window in which two versions are live and the
 *   resolver's answer depends on which row the planner returned.
 */
export async function publishVersion(
  ctx: TenantContext,
  templateId: string,
  versionId: string,
  options: TemplateActionOptions = {}
): Promise<ConsultationTemplateDetail> {
  await withTenant(ctx, async (tx) => {
    const template = await loadTemplate(tx, templateId);
    assertMutable(template);

    const version = await tx.consultationTemplateVersion.findFirst({
      where: { id: versionId, templateId },
      select: { id: true, version: true, status: true, definition: true },
    });
    if (!version) throw new NotFoundError('Template version');
    assertVersionIsDraft(version);

    /*
     * ⚠️ RE-PARSED AT PUBLISH TIME, EVEN THOUGH THE SAVE ALREADY PARSED IT. The
     *   two are different moments and the grammar can move between them: a
     *   document saved before a section type was withdrawn would otherwise go
     *   live against an engine that no longer has a component for it. Publishing
     *   is the assertion "this is how consultations are conducted", and it is
     *   the right place to make the check again.
     */
    parseStoredDefinition(version.definition, `Version ${version.version}`);

    await tx.consultationTemplateVersion.updateMany({
      where: { templateId, status: 'PUBLISHED' },
      data: { status: 'RETIRED', retiredAt: new Date() },
    });

    await tx.consultationTemplateVersion.update({
      where: { id: versionId },
      data: { status: 'PUBLISHED', publishedAt: new Date(), publishedBy: ctx.userId },
    });

    await recordAudit(tx, ctx, {
      action: 'UPDATE',
      entityType: 'consultation_template_version',
      entityId: versionId,
      before: { status: 'DRAFT' },
      after: { templateId, version: version.version, status: 'PUBLISHED' },
      ...options,
    });
  });

  return getTemplate(ctx, templateId, versionId);
}

/**
 * Discard a draft.
 *
 * ⚠️ ONLY A DRAFT, AND IT IS A HARD DELETE. A draft was never a statement about
 *   how consultations are conducted and no encounter can cite one, so there is
 *   nothing to preserve — the audit row records that it existed and was thrown
 *   away. A PUBLISHED or RETIRED version is not deletable by any path in this
 *   service: a five-year-old record renders from it.
 */
export async function discardDraft(
  ctx: TenantContext,
  templateId: string,
  versionId: string,
  options: TemplateActionOptions = {}
): Promise<void> {
  await withTenant(ctx, async (tx) => {
    const template = await loadTemplate(tx, templateId);
    assertMutable(template);

    const version = await tx.consultationTemplateVersion.findFirst({
      where: { id: versionId, templateId },
      select: { id: true, version: true, status: true },
    });
    if (!version) throw new NotFoundError('Template version');
    assertVersionIsDraft(version);

    const total = await tx.consultationTemplateVersion.count({ where: { templateId } });
    if (total === 1) {
      /*
       * ⚠️ THE LAST VERSION MAY NOT BE DISCARDED. A template with no versions
       *   resolves to nothing while still appearing in the admin list as
       *   configuration — the same failure the create path avoids by making the
       *   first draft itself.
       */
      throw new ConflictError(
        "This is the template's only version. Deactivate the template instead of emptying it."
      );
    }

    await tx.consultationTemplateVersion.delete({ where: { id: versionId } });

    await recordAudit(tx, ctx, {
      action: 'DELETE',
      entityType: 'consultation_template_version',
      entityId: versionId,
      before: { templateId, version: version.version, status: 'DRAFT' },
      ...options,
    });
  });
}
