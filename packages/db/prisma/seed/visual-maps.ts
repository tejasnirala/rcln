/**
 * Writes the platform's visual maps and their regions as PLATFORM rows.
 *
 * The list lives in `data/visual-maps.ts` — this file is only write logic.
 *
 * ⚠️ EVERY MAP IS PARSED BEFORE IT IS WRITTEN, BY THE SAME PARSER THE API USES
 *   (CD-10, CD-17). The seed is not exempt: a geometry document that no longer
 *   matches the grammar would otherwise reach the database, resolve at
 *   consultation time and throw with a patient in the chair — looking like a bug
 *   in the engine rather than a stale fixture. Failing the seed is the loud
 *   version of the same information.
 *
 * ⚠️ AND THE FAILURE IS FATAL, LIKE THE TEMPLATE SEED'S AND UNLIKE THE
 *   VOCABULARY SEED'S MISSING SCOPE. A missing scope makes a term sort lower; a
 *   broken chart means a dentist's consultation cannot be drawn on at all.
 */
import { parseVisualMap } from '@rcln/clinical';

import type { Prisma } from '../../generated/prisma/index.js';

import { prisma } from './client.js';
import { VISUAL_MAPS } from './data/visual-maps.js';

export async function seedVisualMaps(): Promise<void> {
  let regionTotal = 0;

  for (const map of VISUAL_MAPS) {
    /*
     * ⚠️ PARSED FROM THE SEED DATA, BEFORE A ROW EXISTS. The ids the parser
     *   wants are the graph's, not the database's — codes stand in for them
     *   here, which is enough to catch a malformed shape, a duplicate code, a
     *   parent that is not on the map and a cycle.
     */
    const parsed = parseVisualMap({
      code: map.code,
      viewBox: map.viewBox,
      regions: map.regions.map((region, index) => ({
        id: region.code,
        code: region.code,
        label: region.label,
        parentId: region.parentCode ?? null,
        displayOrder: index * 10,
        metadata: region.metadata ?? null,
      })),
    });
    if (!parsed.ok) throw new Error(`Visual map ${map.code} is not usable: ${parsed.problem}`);

    const careContext = await prisma.specialty.findFirst({
      where: { organizationId: null, code: map.careContextCode, type: 'CARE_CONTEXT' },
      select: { id: true },
    });
    if (!careContext) {
      throw new Error(
        `Care context ${map.careContextCode} is missing — seed the clinical taxonomy first.`
      );
    }

    /*
     * ⚠️ A MISSING SPECIALTY IS SKIPPED, NOT FATAL, AND THAT IS THE SAME
     *   ASYMMETRY THE VOCABULARY SEED DRAWS. `specialty_id` says which node the
     *   chart is especially for; NULL means "offered across the care context",
     *   which is a wider answer rather than a broken one.
     */
    const specialty =
      map.specialtyCode === undefined
        ? null
        : await prisma.specialty.findFirst({
            where: { organizationId: null, code: map.specialtyCode },
            select: { id: true },
          });

    /*
     * ⚠️ `findFirst` THEN create/update, NOT `upsert`. The unique is
     *   (organization_id, code) NULLS NOT DISTINCT, and Prisma refuses to build
     *   a `where` for a compound unique with a nullable component. The same
     *   constraint and the same workaround as every other platform seed here.
     */
    const existing = await prisma.visualMap.findFirst({
      where: { organizationId: null, code: map.code },
      select: { id: true },
    });

    const data = {
      name: map.name,
      description: map.description,
      careContextId: careContext.id,
      specialtyId: specialty?.id ?? null,
      viewBox: map.viewBox,
    };

    const mapId = existing
      ? (await prisma.visualMap.update({ where: { id: existing.id }, data })).id
      : (await prisma.visualMap.create({ data: { organizationId: null, code: map.code, ...data } }))
          .id;

    /*
     * ⚠️ REGIONS ARE UPSERTED BY CODE AND NEVER REPLACED WHOLESALE, WHICH IS THE
     *   OPPOSITE OF WHAT THE VOCABULARY SEED DOES WITH ITS CODINGS. A coding is
     *   derived entirely from the seed and nothing points at it; a REGION is
     *   cited by `clinical_findings` and `encounter_procedures` with
     *   `onDelete: Restrict`, so a delete-and-recreate would fail against any
     *   database that has ever had a consultation on it — and would reissue
     *   every id if it somehow succeeded.
     */
    for (const [index, region] of map.regions.entries()) {
      const parentCode = region.parentCode;
      const parent =
        parentCode === undefined
          ? null
          : await prisma.visualRegion.findFirst({
              where: { organizationId: null, mapId, code: parentCode },
              select: { id: true },
            });
      if (parentCode !== undefined && parent === null) {
        /* The data file lists every quadrant before the teeth that group under
           it, so this is a broken fixture rather than an ordering accident. */
        throw new Error(
          `Visual map ${map.code}: region ${region.code} has no parent ${parentCode}`
        );
      }

      const existingRegion = await prisma.visualRegion.findFirst({
        where: { organizationId: null, mapId, code: region.code },
        select: { id: true },
      });

      /*
       * ⚠️ THE KEY IS OMITTED WHEN THERE IS NO METADATA, NOT SET TO `undefined`.
       *   Under `exactOptionalPropertyTypes` those are different things, and
       *   Prisma's JSON input accepts neither `undefined` nor a bare
       *   `Record<string, unknown>` — an explicit `undefined` would ask it to
       *   write a JSON value it has no representation for. Surfaced when PI-24
       *   gave this directory a typecheck for the first time.
       */
      const regionData = {
        label: region.label,
        parentId: parent?.id ?? null,
        displayOrder: index * 10,
        ...(region.metadata !== undefined
          ? { metadata: region.metadata as Prisma.InputJsonObject }
          : {}),
      };

      if (existingRegion) {
        await prisma.visualRegion.update({ where: { id: existingRegion.id }, data: regionData });
      } else {
        await prisma.visualRegion.create({
          data: { organizationId: null, mapId, code: region.code, ...regionData },
        });
      }
      regionTotal += 1;
    }
  }

  console.warn(`  visual maps      ${VISUAL_MAPS.length} (${regionTotal} regions)`);
}
