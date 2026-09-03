/**
 * PI-23 — one scanned string in, the product AND the lot AND the device out.
 *
 * The `act` half of decode → resolve → act belongs to whichever screen is doing
 * the acting; this file is the middle one, and it is the only place in the
 * programme that turns a barcode into rows.
 *
 * ── WHY THIS IS NOT `GET /products/resolve` WITH MORE FIELDS ────────────────
 * That endpoint answers "which product carries these digits", is behind
 * `product.definition.read`, and parses nothing — it was built in PI-1 and is
 * still exactly right for the catalogue screens. This one decodes a GS1 element
 * string first and then asks THREE questions of the stock tables, so it is
 * behind the stock read code as well. They share `currentIdentifierWhere`, which
 * is the part that must never disagree.
 *
 * ── THE FOUR THINGS THIS DOES THAT A NAIVE VERSION WOULD NOT ────────────────
 *
 * 1. ⚠️ IT SEARCHES EVERY LENGTH OF THE GTIN. A clinic types the thirteen digits
 *    printed under the bars; the DataMatrix carries fourteen with a leading
 *    zero. Matching one form is a scanner that "does not work for this product",
 *    reported months later, for a product nobody can reproduce it on.
 *
 * 2. ⚠️ IT FINDS THE LOT EVEN WHEN THE PRODUCT IS UNKNOWN. A GTIN nobody has
 *    catalogued still carries a lot number, and that lot number is very often
 *    already on file from a delivery somebody keyed by hand. Refusing to look
 *    because the product half failed throws away the half that succeeded.
 *
 * 3. ⚠️ IT COMPARES THE SCANNED EXPIRY WITH THE STORED ONE. The pack says one
 *    date, the lot on file says another: either the wrong lot was picked or the
 *    wrong date was typed at receipt, and this is the only moment anybody is
 *    holding both. `expiryMatchesScan` is the single most useful field here.
 *
 * 4. ⚠️ IT RETURNS NO PATIENT FIELD, ON PURPOSE. `serials.assigned_patient_id`
 *    answers "which patient has device 7742", and every read of it writes a
 *    `data_access_logs` row (PI-ADR-016). This is the hottest endpoint in the
 *    programme and it runs at a loading bay: putting a PHI disclosure on every
 *    scan would drown the disclosure log in reads nobody made about a patient.
 *    Whoever needs that asks `/v1/serials/:id`, which logs it.
 *
 * NO PHI. Nothing selected here names or identifies a person.
 */
import { Prisma, withTenant, type TenantContext, type TxClient } from '@rcln/db';
import { decodeScan, type DecodedScan as DecodedPayload } from '@rcln/inventory';
import type { ScanResolveQuery, ScanResolveResponse, ScannedBatch } from '@rcln/contracts';
import { currentIdentifierWhere } from '../product/identifier.service.js';
import { assertBranchInScope } from '../shared/branch.js';
import { calendarToday, toCalendarDate } from '../product/values.js';

/** How many rows of any one kind a single scan may come back with. */
const MATCH_LIMIT = 25;

/**
 * The values worth looking up as a PRODUCT identifier.
 *
 * A GS1 payload gives the GTIN and its shorter forms. Anything else — a plain
 * SKU, a national code the decoder left as an element, a hand-typed catalogue
 * number — is tried verbatim, because `product_identifiers` holds internal SKUs
 * and national codes as readily as it holds GTINs.
 */
function identifierCandidates(decoded: DecodedPayload): string[] {
  const values = new Set<string>(decoded.gtinCandidates);
  if (decoded.format !== 'GS1') values.add(decoded.raw);
  /*
   * The national reimbursement numbers (AI 710–715) and the additional product
   * identifier (AI 240) are product codes in their own right, and for several
   * countries they are the ONLY code on the pack. They are tried by value; the
   * country qualification is the caller's, exactly as for any national code.
   */
  for (const element of decoded.elements) {
    if (['240', '241', '710', '711', '712', '713', '714', '715'].includes(element.ai)) {
      values.add(element.value);
    }
  }
  return [...values].filter((v) => v !== '');
}

/**
 * The branches this scan may see.
 *
 * A named branch is asserted in scope and used alone; an unnamed one searches
 * everything the caller holds, which is what a group with a central store wants.
 * ⚠️ NOT `resolveBranchId`: that helper refuses when somebody covers two sites
 *   and names neither, which is correct for a WRITE and wrong for a lookup — the
 *   whole value of scanning a box at head office is finding out which site it
 *   belongs to.
 */
function branchScope(ctx: TenantContext, branchId: string | undefined): string[] {
  if (branchId === undefined) return [...ctx.branchIds];
  assertBranchInScope(ctx, branchId);
  return [branchId];
}

const batchInclude = Prisma.validator<Prisma.BatchInclude>()({
  product: { select: { name: true, baseUnit: { select: { symbol: true } } } },
  branch: { select: { name: true } },
  balances: { select: { status: true, quantity: true } },
});

type BatchRow = Prisma.BatchGetPayload<{ include: typeof batchInclude }>;

/**
 * Sum through `Prisma.Decimal`, never through `Number`.
 *
 * The same reason `batch.service.ts` gives: these are `Decimal(18,6)` and a
 * double has already lost the tail at eighteen digits, silently, in the number a
 * pharmacist reconciles against a shelf.
 */
function sum(balances: { status: string; quantity: Prisma.Decimal }[], only?: string): string {
  return balances
    .filter((b) => only === undefined || b.status === only)
    .reduce((total, b) => total.add(b.quantity), new Prisma.Decimal(0))
    .toString();
}

function toScannedBatch(row: BatchRow, scannedExpiry: string | null, today: string): ScannedBatch {
  const expiresOn = row.expiresOn === null ? null : toCalendarDate(row.expiresOn);
  /*
   * ⚠️ EXPIRY IS COMPARED AS A CALENDAR DAY AND THE COLUMN IS `@db.Date`. Both
   *   sides are `YYYY-MM-DD` strings by the time they meet — turning either into
   *   an instant would compare a day against a moment and mark a correctly
   *   received lot as mismatched somewhere west of Greenwich.
   */
  const expiryMatchesScan =
    scannedExpiry === null || expiresOn === null ? null : scannedExpiry === expiresOn;

  return {
    id: row.id,
    branchId: row.branchId,
    branchName: row.branch.name,
    productId: row.productId,
    productName: row.product.name,
    lotNumber: row.lotNumber,
    expiresOn,
    status: row.status,
    /*
     * ⚠️ THE SAME TWO CONDITIONS `allocation.service.ts` NARROWS ITS CANDIDATES
     *   BY, AND NOT A THIRD. ACTIVE, and not past its expiry — a lot expiring
     *   TODAY is still dispensable today, because the date printed on the pack
     *   is the last day of use. Quarantine and recall are already in `status`
     *   (`quarantineBatch` and `recallBatch` set it in the same transaction as
     *   the movement), so testing the timestamps as WELL would look like extra
     *   safety and would in fact be a second, quieter definition of
     *   dispensability that a screen shows and allocation ignores. The two
     *   timestamps travel beside this so the screen can say WHY.
     */
    isDispensable: row.status === 'ACTIVE' && (expiresOn === null || expiresOn >= today),
    quarantinedAt: row.quarantinedAt?.toISOString() ?? null,
    recalledAt: row.recalledAt?.toISOString() ?? null,
    availableQuantityBase: sum(row.balances, 'AVAILABLE'),
    quantityOnHandBase: sum(row.balances),
    baseUnitSymbol: row.product.baseUnit.symbol,
    expiryMatchesScan,
  };
}

async function findBatches(
  tx: TxClient,
  organizationId: string,
  branchIds: string[],
  lotNumber: string,
  productIds: string[],
  scannedExpiry: string | null
): Promise<ScannedBatch[]> {
  /*
   * Built from an ISO date string rather than from `new Date()`, exactly as
   * `allocation.service.ts` builds its own — the container's clock time must not
   * be able to push a midnight query into yesterday.
   */
  const today = toCalendarDate(calendarToday());
  const rows = await tx.batch.findMany({
    where: {
      /*
       * ⚠️ EXPLICIT, NOT LEFT TO RLS (ADR-0003's second layer). The policy is
       *   the backstop, not the scoping — and the same phase group says so out
       *   loud at `fulfilment.service.ts`. `branchIds` comes from
       *   `branchScope`, which cannot yield a branch outside the caller's
       *   context today, so this is not exploitable; it becomes exploitable the
       *   day somebody widens that function and leaves one layer standing on
       *   the hottest new read in the programme. (PI-24 review.)
       */
      organizationId,
      branchId: { in: branchIds },
      /*
       * ⚠️ EXACT, CASE-SENSITIVE. A lot number is an identifier and `AB12` is not
       *   `ab12` to a regulator — the schema says so in a comment on the column,
       *   and a `mode: 'insensitive'` here would quietly join two lots that a
       *   recall notice distinguishes.
       */
      lotNumber,
      // Narrowed to the resolved product where there is one; every lot with
      // these digits where there is not. See the file header, point 2.
      ...(productIds.length > 0 ? { productId: { in: productIds } } : {}),
    },
    include: batchInclude,
    orderBy: [{ expiresOn: 'asc' }, { receivedAt: 'asc' }],
    take: MATCH_LIMIT,
  });
  return rows.map((row) => toScannedBatch(row, scannedExpiry, today));
}

/**
 * Resolve one scan.
 *
 * Never throws for "nothing matched" — a payload that reaches no product is
 * answered with the decode and three empty arrays, because "GTIN 08901234567890,
 * lot AB12, expiring January 2027, and this clinic has never stocked it" is the
 * sentence that tells a storekeeper the DELIVERY is wrong rather than the reader.
 */
export async function resolveScan(
  ctx: TenantContext,
  query: ScanResolveQuery
): Promise<ScanResolveResponse> {
  const decoded = decodeScan(query.code);

  return withTenant(ctx, async (tx) => {
    const branchIds = branchScope(ctx, query.branchId);

    const candidates = identifierCandidates(decoded);
    const identifierRows =
      candidates.length === 0
        ? []
        : await tx.productIdentifier.findMany({
            where: currentIdentifierWhere({
              values: candidates,
              ...(query.countryCode !== undefined ? { countryCode: query.countryCode } : {}),
            }),
            include: {
              product: {
                select: {
                  id: true,
                  code: true,
                  name: true,
                  brandName: true,
                  genericName: true,
                  trackingMode: true,
                  isExpiryControlled: true,
                  organizationId: true,
                  baseUnit: { select: { symbol: true } },
                },
              },
            },
            /*
             * The clinic's own row before a platform row, exactly as
             * `resolveIdentifier` orders it.
             *
             * ⚠️ `nulls: 'last'` IS REQUIRED, AND WITHOUT IT THIS ORDERED THE
             *   OTHER WAY. `organization_id` is NULL on a platform row, and
             *   Postgres defaults `DESC` to NULLS FIRST — so a bare
             *   `{ organizationId: 'desc' }` put the PLATFORM definition ahead
             *   of the clinic's own. A clinic that clones a platform product and
             *   keeps its GTIN then scans to the catalogue entry it does not
             *   use, and with `take: MATCH_LIMIT` a GTIN on many platform rows
             *   could push the clinic's own row out of the result entirely.
             *   The same trap is documented at three other call sites in this
             *   codebase, each with this fix applied. (PI-24 review.)
             */
            orderBy: [{ organizationId: { sort: 'desc', nulls: 'last' } }, { isPrimary: 'desc' }],
            take: MATCH_LIMIT,
          });

    /*
     * ⚠️ DE-DUPLICATED BY PRODUCT, NOT BY IDENTIFIER ROW. One product legitimately
     *   carries the GTIN-13 and the GTIN-14 of the same trade item, and searching
     *   every length (point 1 in the header) is what makes both match at once.
     *   Returning it twice would make one product look like the ambiguity that
     *   `isAmbiguous` exists to report.
     */
    const byProduct = new Map<string, ScanResolveResponse['products'][number]>();
    for (const row of identifierRows) {
      const p = row.product;
      // Optional in the generated types because the composite FK has a nullable
      // component; never actually absent. No `!` in this repository.
      if (!p || byProduct.has(p.id)) continue;
      byProduct.set(p.id, {
        productId: p.id,
        productCode: p.code,
        productName: p.name,
        brandName: p.brandName,
        genericName: p.genericName,
        trackingMode: p.trackingMode,
        isExpiryControlled: p.isExpiryControlled,
        baseUnitSymbol: p.baseUnit.symbol,
        matchedOn: { type: row.type, value: row.value },
      });
    }
    const products = [...byProduct.values()];
    const productIds = products.map((p) => p.productId);

    const batches =
      decoded.lotNumber === null
        ? []
        : await findBatches(
            tx,
            ctx.organizationId,
            branchIds,
            decoded.lotNumber,
            productIds,
            decoded.expiresOn
          );

    /*
     * A serial is unique per (tenant, product, serial number), so a scan with no
     * resolved product can still match one device at one branch — and that is
     * the recall case: somebody is holding an implant whose GTIN was never
     * catalogued and needs to know whether it is on a notice.
     */
    const serialRows =
      decoded.serialNumber === null
        ? []
        : await tx.serial.findMany({
            where: {
              /* Explicit for the same reason as `findBatches` above. */
              organizationId: ctx.organizationId,
              branchId: { in: branchIds },
              serialNumber: decoded.serialNumber,
              ...(productIds.length > 0 ? { productId: { in: productIds } } : {}),
            },
            select: {
              id: true,
              branchId: true,
              productId: true,
              serialNumber: true,
              status: true,
              batchId: true,
              currentLocationId: true,
              expiresOn: true,
              product: { select: { name: true } },
              branch: { select: { name: true } },
              batch: { select: { lotNumber: true } },
              currentLocation: { select: { name: true } },
              // ⚠️ `assignedPatientId` IS NOT SELECTED. See the file header,
              //   point 4. Adding it here silently turns this into a PHI read.
            },
            orderBy: { createdAt: 'asc' },
            take: MATCH_LIMIT,
          });

    return {
      decoded: {
        format: decoded.format,
        raw: decoded.raw,
        gtin: decoded.gtin,
        lotNumber: decoded.lotNumber,
        serialNumber: decoded.serialNumber,
        expiresOn: decoded.expiresOn,
        producedOn: decoded.producedOn,
        quantity: decoded.quantity,
        elements: decoded.elements.map((e) => ({ ai: e.ai, label: e.label, value: e.value })),
        unparsed: decoded.unparsed,
        warnings: [...decoded.warnings],
      },
      products,
      batches,
      serials: serialRows.map((row) => ({
        id: row.id,
        branchId: row.branchId,
        branchName: row.branch.name,
        productId: row.productId,
        productName: row.product.name,
        serialNumber: row.serialNumber,
        status: row.status,
        batchId: row.batchId,
        lotNumber: row.batch?.lotNumber ?? null,
        currentLocationId: row.currentLocationId,
        currentLocationName: row.currentLocation?.name ?? null,
        expiresOn: row.expiresOn === null ? null : toCalendarDate(row.expiresOn),
      })),
      isAmbiguous: products.length > 1,
    };
  });
}
