/**
 * Importing a catalogue from a spreadsheet (PI-24).
 *
 * ⚠️ THIS EXISTS BECAUSE A NEW CLINIC OTHERWISE TYPES ITS ENTIRE FORMULARY IN BY
 *   HAND, ONE PRODUCT AT A TIME (KNOWN_ISSUES KI-9). The platform ships no
 *   product data and has no source for any, so "add your medicines" was a
 *   four-hundred-row data-entry job through a form built for adding one — which
 *   is the kind of onboarding cost that decides whether a clinic ever finishes
 *   setting up. Nothing here invents product data; it accepts what a clinic
 *   already has.
 *
 * ── WHAT MAKES IT AN IMPORT RATHER THAN A LOOP OVER `createProduct` ─────────
 * ⚠️ IT REPORTS EVERY ROW, NOT THE FIRST FAILURE. A hand-assembled spreadsheet
 *   is wrong the first time, and a 400 naming row 7 means fixing row 7,
 *   re-uploading, and discovering row 12. The whole file is checked and the
 *   whole verdict comes back, which is why `dryRun` is a first-class part of the
 *   contract rather than a convenience.
 *
 * ⚠️ IT RESOLVES CODES, NOT UUIDS. See `productImportRow` — a spreadsheet has no
 *   ids in it. Units, categories and manufacturers are looked up by their own
 *   codes, ONCE for the whole file rather than per row, because four hundred
 *   rows sharing one unit should not be four hundred lookups.
 *
 * ⚠️ AND THE CLINIC'S OWN MASTER BEATS THE PLATFORM'S. All three tables carry a
 *   nullable `organization_id` where NULL means a platform row, so a code can
 *   legitimately match twice. PI-23 shipped a live defect of exactly this shape
 *   — a bare `orderBy: { organizationId: 'desc' }` puts the PLATFORM row first,
 *   because Postgres sorts DESC as NULLS FIRST — so the preference is expressed
 *   here as an explicit partition rather than as an ordering nobody re-reads.
 *
 * ── ONE TRANSACTION ─────────────────────────────────────────────────────────
 * Either the file lands or none of it does. A half-imported catalogue is worse
 * than no catalogue: nobody can tell which half, and re-running it produces a
 * page of "already exists" that hides the rows that genuinely failed. The row
 * cap in the contract is what keeps that transaction short.
 */
import { withTenant, type TenantContext, type TxClient } from '@rcln/db';
import type { ProductImportRequest, ProductImportResponse } from '@rcln/contracts';

import { recordAudit } from '../audit/audit.service.js';
import type { CatalogueActionOptions } from './unit.service.js';

interface RowResult {
  row: number;
  code: string;
  outcome: 'CREATED' | 'SKIPPED_EXISTS' | 'FAILED';
  productId: string | null;
  message: string | null;
}

/**
 * Every master the file mentions, resolved once.
 *
 * ⚠️ THE CLINIC'S ROW WINS. Read both, then prefer the tenant's — stated rather
 *   than ordered, so nobody has to remember how Postgres sorts NULLs.
 */
async function resolveMasters(
  tx: TxClient,
  codes: { units: string[]; categories: string[]; manufacturers: string[] }
): Promise<{
  units: Map<string, string>;
  categories: Map<string, string>;
  manufacturers: Map<string, string>;
  inactiveUnits: Set<string>;
}> {
  const preferOwn = <T extends { code: string; organizationId: string | null; id: string }>(
    rows: T[]
  ): Map<string, string> => {
    const byCode = new Map<string, T>();
    for (const row of rows) {
      const held = byCode.get(row.code);
      if (!held || (held.organizationId === null && row.organizationId !== null)) {
        byCode.set(row.code, row);
      }
    }
    return new Map([...byCode].map(([code, row]) => [code, row.id]));
  };

  const [units, categories, manufacturers] = await Promise.all([
    codes.units.length === 0
      ? []
      : tx.unitOfMeasure.findMany({
          where: { code: { in: codes.units } },
          select: { id: true, code: true, organizationId: true, isActive: true },
        }),
    codes.categories.length === 0
      ? []
      : tx.productCategory.findMany({
          where: { code: { in: codes.categories } },
          select: { id: true, code: true, organizationId: true },
        }),
    codes.manufacturers.length === 0
      ? []
      : tx.manufacturer.findMany({
          where: { code: { in: codes.manufacturers } },
          select: { id: true, code: true, organizationId: true },
        }),
  ]);

  return {
    units: preferOwn(units),
    categories: preferOwn(categories),
    manufacturers: preferOwn(manufacturers),
    /* An inactive unit is a different message from a missing one. */
    inactiveUnits: new Set(units.filter((u) => !u.isActive).map((u) => u.code)),
  };
}

export async function importProducts(
  ctx: TenantContext,
  input: ProductImportRequest,
  options: CatalogueActionOptions = {}
): Promise<ProductImportResponse> {
  return withTenant(ctx, async (tx) => {
    /* RLS scopes these reads to this clinic plus the platform rows, which is
     * exactly the set `preferOwn` then chooses between. */
    const masters = await resolveMasters(tx, {
      units: [...new Set(input.rows.map((r) => r.baseUnitCode))],
      categories: [...new Set(input.rows.flatMap((r) => (r.categoryCode ? [r.categoryCode] : [])))],
      manufacturers: [
        ...new Set(input.rows.flatMap((r) => (r.manufacturerCode ? [r.manufacturerCode] : []))),
      ],
    });

    /* Codes already in the catalogue, read once. */
    const existing = new Set(
      (
        await tx.product.findMany({
          where: {
            organizationId: ctx.organizationId,
            code: { in: input.rows.map((r) => r.code) },
            deletedAt: null,
          },
          select: { code: true },
        })
      ).map((row) => row.code)
    );

    /*
     * ⚠️ A CODE REPEATED WITHIN THE FILE IS THE FILE'S OWN MISTAKE, and it has to
     *   be caught here rather than by the unique index — the index would abort
     *   the transaction on the second one and lose the report for every other
     *   row, which is the behaviour this service exists to avoid.
     */
    const seen = new Set<string>();
    const results: RowResult[] = [];

    for (const [index, row] of input.rows.entries()) {
      const at = index + 1;
      const fail = (message: string): void => {
        results.push({ row: at, code: row.code, outcome: 'FAILED', productId: null, message });
      };

      if (seen.has(row.code)) {
        fail('This product code appears more than once in the file.');
        continue;
      }
      seen.add(row.code);

      if (existing.has(row.code)) {
        results.push({
          row: at,
          code: row.code,
          outcome: 'SKIPPED_EXISTS',
          productId: null,
          /* Skipped, not failed, and not updated either: an import that quietly
           * rewrote an existing product would let a stale spreadsheet undo a
           * correction somebody made on the screen. */
          message: 'A product with this code already exists, so this row was left alone.',
        });
        continue;
      }

      const baseUnitId = masters.units.get(row.baseUnitCode);
      if (!baseUnitId) {
        fail(`No unit has the code "${row.baseUnitCode}".`);
        continue;
      }
      if (masters.inactiveUnits.has(row.baseUnitCode)) {
        fail(`The unit "${row.baseUnitCode}" is no longer in use.`);
        continue;
      }

      const categoryId = row.categoryCode ? masters.categories.get(row.categoryCode) : undefined;
      if (row.categoryCode && !categoryId) {
        fail(`No category has the code "${row.categoryCode}".`);
        continue;
      }

      const manufacturerId = row.manufacturerCode
        ? masters.manufacturers.get(row.manufacturerCode)
        : undefined;
      if (row.manufacturerCode && !manufacturerId) {
        fail(`No manufacturer has the code "${row.manufacturerCode}".`);
        continue;
      }

      const created = await tx.product.create({
        data: {
          organizationId: ctx.organizationId,
          type: row.type,
          code: row.code,
          name: row.name,
          brandName: row.brandName ?? null,
          genericName: row.genericName ?? null,
          categoryId: categoryId ?? null,
          manufacturerId: manufacturerId ?? null,
          baseUnitId,
          trackingMode: row.trackingMode,
          isExpiryControlled: row.isExpiryControlled,
          defaultShelfLifeDays: row.defaultShelfLifeDays ?? null,
          reorderLevelBase: row.reorderLevelBase ?? null,
          reorderQuantityBase: row.reorderQuantityBase ?? null,
          isStockItem: row.isStockItem,
          /* Level 0 with the product, always — see `createProduct` for why a
           * product without it is a product whose packaging maths refuses. */
          packagings: { create: { level: 0, unitId: baseUnitId, quantityOfChild: '1' } },
          ...(row.barcode
            ? {
                identifiers: {
                  create: {
                    type: 'GTIN' as const,
                    value: row.barcode,
                    isPrimary: true,
                  },
                },
              }
            : {}),
        },
        select: { id: true },
      });

      results.push({
        row: at,
        code: row.code,
        outcome: 'CREATED',
        productId: created.id,
        message: null,
      });
    }

    const created = results.filter((r) => r.outcome === 'CREATED').length;
    const skipped = results.filter((r) => r.outcome === 'SKIPPED_EXISTS').length;
    const failed = results.filter((r) => r.outcome === 'FAILED').length;

    /*
     * ⚠️ ANY FAILURE ABORTS THE WHOLE FILE, and so does a dry run. Rolling back
     *   by throwing is how a Prisma interactive transaction is undone; the
     *   response is assembled first so the caller still gets the full report.
     *   A partially applied import is the state nobody can reason about.
     */
    const response: ProductImportResponse = {
      dryRun: input.dryRun,
      created: input.dryRun ? 0 : created,
      skipped,
      failed,
      results,
    };

    if (!input.dryRun && failed === 0 && created > 0) {
      await recordAudit(tx, ctx, {
        action: 'CREATE',
        entityType: 'product_import',
        entityId: ctx.organizationId,
        after: { created, skipped, rows: input.rows.length },
        ...(options.ipAddress ? { ipAddress: options.ipAddress } : {}),
        ...(options.userAgent ? { userAgent: options.userAgent } : {}),
      });
      return response;
    }

    throw new ImportRolledBack(response);
  }).catch((error: unknown) => {
    if (error instanceof ImportRolledBack) return error.response;
    throw error;
  });
}

/**
 * Carries the report out through the rollback.
 *
 * ⚠️ NOT AN ERROR THE CALLER SEES. A dry run and a file with a bad row both have
 *   to leave the database untouched, and the only way to undo a Prisma
 *   interactive transaction is to throw out of it — so the verdict rides on the
 *   exception and is unwrapped immediately outside. The route returns 200 with
 *   the report either way: "your file has four bad rows" is an answer, not a
 *   server error.
 */
class ImportRolledBack extends Error {
  constructor(readonly response: ProductImportResponse) {
    super('import rolled back');
  }
}
