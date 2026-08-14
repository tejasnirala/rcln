/**
 * Writes the reference clinical vocabulary as PLATFORM rows.
 *
 * The list lives in `data/clinical-masters.ts` — this file is only write logic.
 *
 * ⚠️ NAMED `seedClinicalVocabulary`, NOT `seedClinicalMasters`. That name is
 *   already taken by the seed that writes the TAXONOMY and the qualifications,
 *   which are a different kind of master entirely: one says what a practitioner
 *   is trained in, this one says what any of them can write down.
 */
import { prisma } from './client.js';
import { CLINICAL_MASTERS } from './data/clinical-masters.js';

export async function seedClinicalVocabulary(): Promise<void> {
  /*
   * ⚠️ `findFirst` THEN create/update, NOT `upsert`.
   *
   *   The unique is (organization_id, kind, code) NULLS NOT DISTINCT, and Prisma
   *   refuses to build a `where` for a compound unique with a nullable
   *   component — `organization_id` is NULL on every platform row. The same
   *   constraint, and the same workaround, as the taxonomy and settings seeds.
   *   See PITFALLS.
   */
  const specialtyIdByCode = new Map<string, string>();
  const needed = new Set(CLINICAL_MASTERS.flatMap((m) => m.specialties ?? []));
  if (needed.size > 0) {
    const nodes = await prisma.specialty.findMany({
      where: { organizationId: null, code: { in: [...needed] } },
      select: { id: true, code: true },
    });
    for (const n of nodes) specialtyIdByCode.set(n.code, n.id);
  }

  for (const [index, item] of CLINICAL_MASTERS.entries()) {
    const existing = await prisma.clinicalMasterItem.findFirst({
      where: { organizationId: null, kind: item.kind, code: item.code },
      select: { id: true },
    });

    const data = {
      kind: item.kind,
      code: item.code,
      name: item.name,
      displayOrder: index,
      ...(item.description !== undefined ? { description: item.description } : {}),
    };

    const id = existing
      ? (await prisma.clinicalMasterItem.update({ where: { id: existing.id }, data })).id
      : (await prisma.clinicalMasterItem.create({ data: { organizationId: null, ...data } })).id;

    /*
     * Codings and scopes are replaced rather than diffed. Both are derived
     * entirely from this file, so a replace makes the seed idempotent and makes
     * REMOVING a coding from the list actually remove it — which a create-only
     * seed would silently fail to do, leaving a code nobody can find the source
     * of.
     */
    if (item.codings !== undefined && item.codings.length > 0) {
      await prisma.clinicalMasterCoding.deleteMany({ where: { itemId: id } });
      await prisma.clinicalMasterCoding.createMany({
        data: item.codings.map((c, i) => ({
          organizationId: null,
          itemId: id,
          system: c.system,
          code: c.code,
          /* First one wins. A single scheme with two "primary" codes is exactly
             what the partial unique index refuses. */
          isPrimary: i === 0,
        })),
      });
    }

    if (item.specialties !== undefined && item.specialties.length > 0) {
      await prisma.clinicalMasterScope.deleteMany({ where: { itemId: id } });
      const rows = item.specialties
        .map((code) => specialtyIdByCode.get(code))
        .filter((v): v is string => v !== undefined)
        .map((specialtyId) => ({ organizationId: null, itemId: id, specialtyId }));
      /*
       * ⚠️ A MISSING TAXONOMY NODE IS SKIPPED, NOT FATAL, AND THAT IS A
       *   DELIBERATE ASYMMETRY. A scope is a RANKING hint (§34) — losing one
       *   makes a word sort lower and changes nothing about what a clinician can
       *   record. Failing the whole seed over a display preference would be the
       *   wrong trade. A missing CODING would be different, and there is no path
       *   here that invents one.
       */
      if (rows.length > 0) await prisma.clinicalMasterScope.createMany({ data: rows });
    }
  }
}
