/**
 * Writes the clinical taxonomy and the qualification list as PLATFORM rows.
 *
 * The lists themselves live in `data/` — this file is only the write logic.
 */
import type { TaxonomyNodeType } from '../../generated/prisma/index.js';

import { prisma } from './client.js';
import { QUALIFICATIONS } from './data/qualifications.js';
import { SPECIALTIES } from './data/specialties.js';

export async function seedClinicalMasters(): Promise<void> {
  /*
   * `findFirst` then create/update rather than `upsert`.
   *
   * The unique is (organization_id, code) NULLS NOT DISTINCT, and Prisma refuses
   * to build a `where` for a compound unique with a nullable component —
   * organization_id is null on every platform row. Same constraint, and the same
   * workaround, as the settings seed. See PITFALLS.
   */
  const byCode = new Map(SPECIALTIES.map((s) => [s.code, s]));
  const orderOf = new Map(SPECIALTIES.map((s, i) => [s.code, i]));
  const resolved = new Map<string, string>();
  const inFlight = new Set<string>();

  /*
   * Write one node, having first written its parent. Memoised on `code`, so the
   * whole tree costs one pass regardless of how the list is ordered.
   *
   * ⚠️ A NODE IS NEVER PERSISTED WITHOUT ITS PARENT. The old seed inserted every
   *   row flat and re-parented afterwards, which `specialties_sibling_name_key`
   *   now forbids: with parent_id NULL and NULLS NOT DISTINCT, every row in the
   *   file is momentarily a sibling of every other, so any two nodes sharing a
   *   name anywhere in the tree collide. "Sports Medicine" under Orthopaedics
   *   and "Sports Nutrition" under Dietetics are fine; two nodes both called
   *   "Clinical Nutrition" under different parents would not have been.
   *
   * `inFlight` catches a cycle in THIS FILE — a typo'd parent code — with a
   * legible error, rather than letting it recurse until the stack gives out or
   * the database trigger fires mid-write.
   */
  async function ensureNode(code: string): Promise<string> {
    const cached = resolved.get(code);
    if (cached) return cached;

    const spec = byCode.get(code);
    if (!spec) throw new Error(`SPECIALTIES references unknown parent code "${code}"`);

    if (inFlight.has(code)) {
      throw new Error(
        `SPECIALTIES contains a parent cycle through "${code}" — check the \`parent\` fields`
      );
    }
    inFlight.add(code);
    const parentId = spec.parent ? await ensureNode(spec.parent) : null;
    inFlight.delete(code);

    /*
     * `findFirst` then create/update rather than `upsert`.
     *
     * The unique is (organization_id, code) NULLS NOT DISTINCT, and Prisma
     * refuses to build a `where` for a compound unique with a nullable component
     * — organization_id is null on every platform row. Same constraint, and the
     * same workaround, as the settings seed. See PITFALLS.
     */
    const payload = {
      name: spec.name,
      parentId,
      type: spec.type ?? ('SPECIALTY' as TaxonomyNodeType),
      description: spec.description ?? null,
      // Position in the source array. Sibling order is therefore whatever this
      // file reads as, and `ORDER BY display_order, name` is total.
      displayOrder: orderOf.get(code) ?? 0,
    };

    const existing = await prisma.specialty.findFirst({
      where: { organizationId: null, code },
      select: { id: true },
    });

    const id = existing
      ? (await prisma.specialty.update({ where: { id: existing.id }, data: payload })).id
      : (
          await prisma.specialty.create({
            data: { organizationId: null, code, ...payload },
          })
        ).id;

    resolved.set(code, id);
    return id;
  }

  for (const spec of SPECIALTIES) {
    await ensureNode(spec.code);
  }

  for (const q of QUALIFICATIONS) {
    const existing = await prisma.qualification.findFirst({
      where: { organizationId: null, code: q.code },
      select: { id: true },
    });
    if (existing) {
      await prisma.qualification.update({ where: { id: existing.id }, data: { name: q.name } });
    } else {
      await prisma.qualification.create({
        data: { organizationId: null, code: q.code, name: q.name },
      });
    }
  }

  console.warn(`  specialties      ${SPECIALTIES.length}`);
  console.warn(`  qualifications   ${QUALIFICATIONS.length}`);
}
