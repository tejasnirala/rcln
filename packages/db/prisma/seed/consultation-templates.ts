/**
 * Writes the platform's default consultation templates as PLATFORM rows.
 *
 * The list lives in `data/consultation-templates.ts` — this file is only write
 * logic.
 *
 * ⚠️ EVERY DOCUMENT IS PARSED BEFORE IT IS WRITTEN, BY THE SAME PARSER THE API
 *   USES (CD-10). The seed is not exempt: a default that no longer matches the
 *   grammar would otherwise reach the database, resolve at consultation time,
 *   and fail with a patient in the chair — with the failure looking like a bug
 *   in the engine rather than a stale fixture. Failing the seed is the loud
 *   version of the same information.
 *
 * ⚠️ AND THE FAILURE IS FATAL, UNLIKE THE VOCABULARY SEED'S MISSING SCOPE. That
 *   asymmetry is deliberate: a missing scope makes a term sort lower, and a
 *   broken template means no consultation can be opened at all in that care
 *   context.
 */
import { parseTemplateDefinition } from '@rcln/clinical';
import { prisma } from './client.js';
import { CONSULTATION_TEMPLATES } from './data/consultation-templates.js';

export async function seedConsultationTemplates(): Promise<void> {
  for (const template of CONSULTATION_TEMPLATES) {
    const parsed = parseTemplateDefinition(template.definition);
    if (!parsed.ok) {
      throw new Error(`Consultation template ${template.code} is not usable: ${parsed.problem}`);
    }

    const careContext = await prisma.specialty.findFirst({
      where: { organizationId: null, code: template.careContextCode, type: 'CARE_CONTEXT' },
      select: { id: true },
    });
    if (!careContext) {
      /*
       * ⚠️ FATAL, NOT SKIPPED. A care context with no template means an
       *   appointment for a patient of that kind resolves to nothing and the
       *   consultation cannot be opened — and `seedClinicalMasters` runs before
       *   this, so a missing root is a broken seed order rather than a missing
       *   feature.
       */
      throw new Error(
        `Care context ${template.careContextCode} is missing — seed the clinical taxonomy first.`
      );
    }

    /*
     * ⚠️ A NAMED SPECIALTY THAT IS MISSING IS FATAL, AND THIS IS THE ONE PLACE
     *   IN THE SEED WHERE THAT ASYMMETRY GOES THE OTHER WAY. A missing scope on
     *   a clinical term makes it sort lower; a missing specialty here does not
     *   make a template apply less — it makes it apply to EVERYTHING. A
     *   `specialty_id` of NULL is the care-context default, so the dentistry
     *   template would land at depth 0 beside the general one and win the tie
     *   on its code, handing every human consultation in the product an
     *   odontogram. See `ConsultationTemplateSeed.specialtyCode`.
     */
    const specialty =
      template.specialtyCode === undefined
        ? null
        : await prisma.specialty.findFirst({
            where: { organizationId: null, code: template.specialtyCode },
            select: { id: true },
          });
    if (template.specialtyCode !== undefined && specialty === null) {
      throw new Error(
        `Consultation template ${template.code} names the specialty ${template.specialtyCode}, which is missing — seed the clinical taxonomy first.`
      );
    }

    /*
     * ⚠️ `findFirst` THEN create/update, NOT `upsert`. The unique is
     *   (organization_id, code) NULLS NOT DISTINCT, and Prisma refuses to build
     *   a `where` for a compound unique with a nullable component —
     *   `organization_id` is NULL on every platform row. The same constraint and
     *   the same workaround as the taxonomy, settings and vocabulary seeds. See
     *   PITFALLS.
     */
    const existing = await prisma.consultationTemplate.findFirst({
      where: { organizationId: null, code: template.code },
      select: { id: true },
    });

    const id = existing
      ? (
          await prisma.consultationTemplate.update({
            where: { id: existing.id },
            data: {
              name: template.name,
              description: template.description,
              careContextId: careContext.id,
              /* ⚠️ UPDATED, NOT ONLY SET ON CREATE. A template that moved node
                 between releases must move in every database that already has
                 it, or the deploy leaves it resolving at the old depth. */
              specialtyId: specialty?.id ?? null,
            },
          })
        ).id
      : (
          await prisma.consultationTemplate.create({
            data: {
              organizationId: null,
              code: template.code,
              name: template.name,
              description: template.description,
              careContextId: careContext.id,
              /* ⚠️ NULL specialty_id IS THE CARE-CONTEXT DEFAULT — the template
                 that always resolves. The reference configurations name a node
                 instead; see the check above. */
              specialtyId: specialty?.id ?? null,
            },
          })
        ).id;

    const published = await prisma.consultationTemplateVersion.findFirst({
      where: { templateId: id, status: 'PUBLISHED' },
      select: { id: true, version: true },
    });

    if (published) {
      /*
       * ⚠️ THE PUBLISHED DOCUMENT IS REFRESHED IN PLACE, AND THIS IS THE ONE
       *   PLACE IN THE PRODUCT THAT MAY DO IT. `assertVersionIsDraft` refuses it
       *   everywhere else, for the reason §29 gives — but a PLATFORM template is
       *   shipped configuration rather than a clinic's decision, no clinic can
       *   edit it, and the alternative is a new version on every deploy and a
       *   version history that counts releases instead of changes.
       *
       *   The moment `encounters` exists (CE-3) this stays correct because a
       *   finalized encounter renders from its own frozen `template_snapshot`,
       *   never from this row.
       */
      await prisma.consultationTemplateVersion.update({
        where: { id: published.id },
        data: { definition: parsed.value as object },
      });
      continue;
    }

    await prisma.consultationTemplateVersion.create({
      data: {
        organizationId: null,
        templateId: id,
        version: 1,
        definition: parsed.value as object,
        status: 'PUBLISHED',
        publishedAt: new Date(),
      },
    });
  }
}
