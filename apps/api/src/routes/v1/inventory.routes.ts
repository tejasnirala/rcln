/**
 * Inventory: locations, batches, serials, movements, balances and the ledger.
 *
 * The standard chain, and the order IS the security model:
 *
 *   requireTenant -> authenticate -> requireAuth -> authorize -> validate -> handler
 *
 * Four routers, mounted at four paths in `index.ts`, in one file — they share
 * one domain, one branch-scoping story and one set of permission codes, and four
 * near-identical files are how one of them ends up with a different guard.
 *
 * ── WHICH CODE GATES WHAT, AND WHY ──────────────────────────────────────────
 *
 *   reading anything                    ->  `inventory.stock.read`
 *   creating a shelf                    ->  `inventory.location.manage`   ⚠
 *   creating a lot or a serial          ->  `inventory.batch.manage`
 *   recording a movement                ->  `inventory.stock.adjust`
 *   holding or recalling a lot          ->  `inventory.batch.manage`
 *
 * ⚠️ READS ARE ALL BEHIND ONE CODE, DELIBERATELY, and it is the same call
 *   `product.definition.read` makes for the catalogue masters. Every stock
 *   screen needs the NAME of the shelf a thing is on; gating that behind the
 *   permission to CREATE shelves means a storekeeper sees a page of uuids.
 *
 * ⚠️ `inventory.location.manage` IS NOT A NARROWER `inventory.stock.adjust`.
 *   Adjusting stock is a daily operational act; defining that a branch HAS a
 *   controlled cabinet is a configuration decision about how the site is laid
 *   out. Different people, and a different blast radius — a bad adjustment is
 *   one compensating movement from correct, while a location change moves the
 *   meaning of every balance under it. See PI-ADR-012 and codes.ts.
 *
 * ── PHI ─────────────────────────────────────────────────────────────────────
 * ⚠️ THE SERIALS SURFACE IS THE ONLY ONE THAT TOUCHES IT, through
 *   `serials.assigned_patient_id` — "which patient has device 7742". Those
 *   handlers pass the request's ip and user agent down so `recordDataAccess` can
 *   record the disclosure (PI-ADR-016). Nothing else on this router does, and
 *   nothing on it logs a product name beside a patient id.
 *
 * ⚠️ THE BRANCH IS NEVER TRUSTED FROM THE BODY. Every service asserts the branch
 *   is in `ctx.branchIds` and throws NOT FOUND — never FORBIDDEN — when it is
 *   not, because RLS has already made it invisible and a 403 would confirm the
 *   id is real to somebody probing.
 */
import { Router, type IRouter, type Request, type Response } from 'express';
import { z } from 'zod';
import {
  allocationPlanRequest,
  assignSerialRequest,
  batchHoldRequest,
  batchQuery,
  cancelStockTransferRequest,
  createBatchRequest,
  createStockReasonCodeRequest,
  createStockReservationRequest,
  createStockTransferRequest,
  createInventoryLocationRequest,
  createSerialRequest,
  expiryReportQuery,
  inventoryLocationQuery,
  receiveStockTransferRequest,
  recordMovementRequest,
  releaseStockReservationRequest,
  replaceStorageAreasRequest,
  serialQuery,
  stockBalanceQuery,
  stockLedgerQuery,
  stockReasonCodeQuery,
  stockReservationQuery,
  stockTransferQuery,
  updateBatchRequest,
  updateStockReasonCodeRequest,
  updateStockTransferRequest,
  updateInventoryLocationRequest,
  updateSerialRequest,
  type AllocationPlanRequest,
  type AssignSerialRequest,
  type BatchHoldRequest,
  type BatchQuery,
  type CancelStockTransferRequest,
  type CreateBatchRequest,
  type CreateStockReasonCodeRequest,
  type CreateStockReservationRequest,
  type CreateStockTransferRequest,
  type CreateInventoryLocationRequest,
  type CreateSerialRequest,
  type ExpiryReportQuery,
  type InventoryLocationQuery,
  type ReceiveStockTransferRequest,
  type RecordMovementRequest,
  type ReleaseStockReservationRequest,
  type ReplaceStorageAreasRequest,
  type SerialQuery,
  type StockBalanceQuery,
  type StockLedgerQuery,
  type StockReasonCodeQuery,
  type StockReservationQuery,
  type StockTransferQuery,
  type UpdateBatchRequest,
  type UpdateStockReasonCodeRequest,
  type UpdateStockTransferRequest,
  type UpdateInventoryLocationRequest,
  type UpdateSerialRequest,
} from '@rcln/contracts';
import { PERMISSIONS } from '@rcln/permissions';
import {
  authenticate,
  authorize,
  requireAuth,
  tenantContextFrom,
} from '../../middleware/auth.middleware.js';
import { loadUserAccess, permissionsFor } from '../../services/auth/access.service.js';
import { requireTenant } from '../../middleware/tenant.middleware.js';
import { validate } from '../../middleware/validate.middleware.js';
import {
  createLocation,
  getLocation,
  listLocations,
  replaceStorageAreas,
  updateLocation,
} from '../../services/inventory/location.service.js';
import {
  createBatch,
  getBatch,
  listBatches,
  setBatchHold,
  updateBatch,
} from '../../services/inventory/batch.service.js';
import {
  assignSerial,
  createSerial,
  getSerial,
  listSerials,
  updateSerial,
} from '../../services/inventory/serial.service.js';
import {
  listBalances,
  listLedger,
  verifyBalances,
} from '../../services/inventory/balance.service.js';
import { expiryReport } from '../../services/inventory/expiry.service.js';
import { recordMovement } from '../../services/inventory/movement.service.js';
import {
  createReasonCode,
  deleteReasonCode,
  listReasonCodes,
  updateReasonCode,
} from '../../services/inventory/reason-code.service.js';
import {
  cancelTransfer,
  createTransfer,
  dispatchTransfer,
  getTransfer,
  listTransfers,
  receiveTransfer,
  updateTransfer,
} from '../../services/inventory/transfer.service.js';
import {
  listReservations,
  releaseReservation,
  reserveStock,
} from '../../services/inventory/reservation.service.js';
import { planStockAllocation } from '../../services/inventory/allocation.service.js';
import { sendSuccess } from '../../utils/response.js';

const READ = PERMISSIONS.STOCK_READ;
const LOCATION_MANAGE = PERMISSIONS.INVENTORY_LOCATION_MANAGE;
const BATCH_MANAGE = PERMISSIONS.BATCH_MANAGE;
const ADJUST = PERMISSIONS.STOCK_ADJUST;
const TRANSFER = PERMISSIONS.STOCK_TRANSFER;
const RESERVE = PERMISSIONS.STOCK_RESERVE;
const REASON_CODE_MANAGE = PERMISSIONS.INVENTORY_REASON_CODE_MANAGE;

const auditMeta = (req: Request): { ipAddress?: string; userAgent?: string } => ({
  ...(req.ip !== undefined ? { ipAddress: req.ip } : {}),
  ...(req.get('user-agent') !== undefined ? { userAgent: req.get('user-agent') as string } : {}),
});

/**
 * `auditMeta`, plus the caller's effective permissions (PI-8, KNOWN_ISSUES #5).
 *
 * ⚠️ ONLY THE TWO ENDPOINTS THAT CONSULT `@rcln/regulatory` USE THIS, AND THE
 *   REST STAY ON THE SYNCHRONOUS `auditMeta`. Resolving permissions is a cache
 *   read, but it is a read on every request, and paperwork endpoints — creating
 *   a draft, editing a line — reach no rule engine and would pay for something
 *   nothing looks at.
 *
 * ⚠️ PERMISSION CODES FOR THE BRANCH BEING ACTED ON, resolved here rather than
 *   inside a service, because `TenantContext` deliberately carries no
 *   permissions — it is an isolation boundary, not an authorization one.
 *   `authorize()` has already warmed this cache on the way in, so it is a hit.
 */
async function actorMeta(req: Request): Promise<{
  ipAddress?: string;
  userAgent?: string;
  roleCodes: readonly string[];
}> {
  const ctx = tenantContextFrom(req);
  const access = await loadUserAccess(ctx.userId, ctx.organizationId);
  return {
    ...auditMeta(req),
    roleCodes: access ? permissionsFor(access, ctx.userId, req.auth?.branchId ?? null, false) : [],
  };
}

/** Applied to each router below. Extracted so one cannot be missed. */
function guarded(): IRouter {
  const r: IRouter = Router();
  r.use(requireTenant, authenticate, requireAuth);
  return r;
}

// ---------------------------------------------------------------------------
// Locations  ->  /v1/inventory-locations
// ---------------------------------------------------------------------------

export const inventoryLocationRoutes: IRouter = guarded();

const locationParams = z.object({ locationId: z.uuid() });

inventoryLocationRoutes.get(
  '/',
  authorize(READ),
  validate(inventoryLocationQuery, 'query'),
  async (req: Request, res: Response): Promise<void> => {
    const query = req.query as unknown as InventoryLocationQuery;
    sendSuccess(res, await listLocations(tenantContextFrom(req), query));
  }
);

inventoryLocationRoutes.get(
  '/:locationId',
  authorize(READ),
  validate(locationParams, 'params'),
  async (req: Request, res: Response): Promise<void> => {
    const { locationId } = req.params as z.infer<typeof locationParams>;
    sendSuccess(res, await getLocation(tenantContextFrom(req), locationId));
  }
);

inventoryLocationRoutes.post(
  '/',
  authorize(LOCATION_MANAGE),
  validate(createInventoryLocationRequest),
  async (req: Request, res: Response): Promise<void> => {
    const body = req.body as CreateInventoryLocationRequest;
    const created = await createLocation(tenantContextFrom(req), body, auditMeta(req));
    sendSuccess(res, created, 'Location added', 201);
  }
);

inventoryLocationRoutes.patch(
  '/:locationId',
  authorize(LOCATION_MANAGE),
  validate(locationParams, 'params'),
  validate(updateInventoryLocationRequest),
  async (req: Request, res: Response): Promise<void> => {
    const { locationId } = req.params as z.infer<typeof locationParams>;
    const body = req.body as UpdateInventoryLocationRequest;
    sendSuccess(
      res,
      await updateLocation(tenantContextFrom(req), locationId, body, auditMeta(req))
    );
  }
);

/**
 * Shelving is replaced whole, not patched row by row — a layout is edited as a
 * layout. Safe here and nowhere else in this domain because areas and bins are
 * ADDRESSES: `stock_balances` is keyed by location, so deleting a bin loses a
 * label and never a number.
 */
inventoryLocationRoutes.put(
  '/:locationId/areas',
  authorize(LOCATION_MANAGE),
  validate(locationParams, 'params'),
  validate(replaceStorageAreasRequest),
  async (req: Request, res: Response): Promise<void> => {
    const { locationId } = req.params as z.infer<typeof locationParams>;
    const body = req.body as ReplaceStorageAreasRequest;
    sendSuccess(
      res,
      await replaceStorageAreas(tenantContextFrom(req), locationId, body, auditMeta(req))
    );
  }
);

// ---------------------------------------------------------------------------
// Batches  ->  /v1/batches
// ---------------------------------------------------------------------------

export const batchRoutes: IRouter = guarded();

const batchParams = z.object({ batchId: z.uuid() });

batchRoutes.get(
  '/',
  authorize(READ),
  validate(batchQuery, 'query'),
  async (req: Request, res: Response): Promise<void> => {
    const query = req.query as unknown as BatchQuery;
    sendSuccess(res, await listBatches(tenantContextFrom(req), query));
  }
);

batchRoutes.get(
  '/:batchId',
  authorize(READ),
  validate(batchParams, 'params'),
  async (req: Request, res: Response): Promise<void> => {
    const { batchId } = req.params as z.infer<typeof batchParams>;
    sendSuccess(res, await getBatch(tenantContextFrom(req), batchId));
  }
);

batchRoutes.post(
  '/',
  authorize(BATCH_MANAGE),
  validate(createBatchRequest),
  async (req: Request, res: Response): Promise<void> => {
    const body = req.body as CreateBatchRequest;
    sendSuccess(
      res,
      await createBatch(tenantContextFrom(req), body, auditMeta(req)),
      'Lot recorded',
      201
    );
  }
);

batchRoutes.patch(
  '/:batchId',
  authorize(BATCH_MANAGE),
  validate(batchParams, 'params'),
  validate(updateBatchRequest),
  async (req: Request, res: Response): Promise<void> => {
    const { batchId } = req.params as z.infer<typeof batchParams>;
    const body = req.body as UpdateBatchRequest;
    sendSuccess(res, await updateBatch(tenantContextFrom(req), batchId, body, auditMeta(req)));
  }
);

/**
 * Hold a lot, release it, or recall it.
 *
 * ⚠️ ITS OWN ENDPOINT RATHER THAN A FIELD ON THE PATCH ABOVE, because it is not
 *   a column edit: it MOVES QUANTITY between status buckets in the same
 *   transaction as the flag. A batch marked QUARANTINED whose stock is still in
 *   the AVAILABLE bucket is dispensable, since allocation reads the balance and
 *   not the batch — so the two halves have to commit together or not at all.
 */
batchRoutes.post(
  '/:batchId/hold',
  authorize(BATCH_MANAGE),
  validate(batchParams, 'params'),
  validate(batchHoldRequest),
  async (req: Request, res: Response): Promise<void> => {
    const { batchId } = req.params as z.infer<typeof batchParams>;
    const body = req.body as BatchHoldRequest;
    sendSuccess(
      res,
      await setBatchHold(
        tenantContextFrom(req),
        batchId,
        body.action,
        { reason: body.reason, recallReference: body.recallReference },
        auditMeta(req)
      )
    );
  }
);

// ---------------------------------------------------------------------------
// Serials  ->  /v1/serials
//
// ⚠️ THE ONLY PHI SURFACE IN THIS DOMAIN. `auditMeta` is passed to the READS as
//   well as the writes here, which it is nowhere else on this router: the
//   service uses it to attribute the `data_access_logs` row, and a disclosure
//   with no ip and no user agent is a disclosure nobody can follow up.
// ---------------------------------------------------------------------------

export const serialRoutes: IRouter = guarded();

const serialParams = z.object({ serialId: z.uuid() });

serialRoutes.get(
  '/',
  authorize(READ),
  validate(serialQuery, 'query'),
  async (req: Request, res: Response): Promise<void> => {
    const query = req.query as unknown as SerialQuery;
    sendSuccess(res, await listSerials(tenantContextFrom(req), query, auditMeta(req)));
  }
);

serialRoutes.get(
  '/:serialId',
  authorize(READ),
  validate(serialParams, 'params'),
  async (req: Request, res: Response): Promise<void> => {
    const { serialId } = req.params as z.infer<typeof serialParams>;
    sendSuccess(res, await getSerial(tenantContextFrom(req), serialId, auditMeta(req)));
  }
);

serialRoutes.post(
  '/',
  authorize(BATCH_MANAGE),
  validate(createSerialRequest),
  async (req: Request, res: Response): Promise<void> => {
    const body = req.body as CreateSerialRequest;
    sendSuccess(
      res,
      await createSerial(tenantContextFrom(req), body, auditMeta(req)),
      'Serial recorded',
      201
    );
  }
);

serialRoutes.patch(
  '/:serialId',
  authorize(BATCH_MANAGE),
  validate(serialParams, 'params'),
  validate(updateSerialRequest),
  async (req: Request, res: Response): Promise<void> => {
    const { serialId } = req.params as z.infer<typeof serialParams>;
    const body = req.body as UpdateSerialRequest;
    sendSuccess(res, await updateSerial(tenantContextFrom(req), serialId, body, auditMeta(req)));
  }
);

/**
 * Fit or issue a device to a patient. A PHI WRITE.
 *
 * ⚠️ GATED BY `inventory.stock.adjust`, NOT `patient.update`. What changes is
 *   the device's disposition, and whoever hands over an implant in theatre is
 *   the storekeeper rather than the person who maintains the demographic record.
 *   It is deliberately not the read code either: seeing that a device is fitted
 *   and deciding that it is are different claims.
 */
serialRoutes.post(
  '/:serialId/assign',
  authorize(ADJUST),
  validate(serialParams, 'params'),
  validate(assignSerialRequest),
  async (req: Request, res: Response): Promise<void> => {
    const { serialId } = req.params as z.infer<typeof serialParams>;
    const body = req.body as AssignSerialRequest;
    sendSuccess(res, await assignSerial(tenantContextFrom(req), serialId, body, auditMeta(req)));
  }
);

// ---------------------------------------------------------------------------
// Stock  ->  /v1/stock
// ---------------------------------------------------------------------------

export const stockRoutes: IRouter = guarded();

stockRoutes.get(
  '/balances',
  authorize(READ),
  validate(stockBalanceQuery, 'query'),
  async (req: Request, res: Response): Promise<void> => {
    const query = req.query as unknown as StockBalanceQuery;
    sendSuccess(res, await listBalances(tenantContextFrom(req), query));
  }
);

stockRoutes.get(
  '/ledger',
  authorize(READ),
  validate(stockLedgerQuery, 'query'),
  async (req: Request, res: Response): Promise<void> => {
    const query = req.query as unknown as StockLedgerQuery;
    sendSuccess(res, await listLedger(tenantContextFrom(req), query));
  }
);

stockRoutes.get(
  '/expiring',
  authorize(READ),
  validate(expiryReportQuery, 'query'),
  async (req: Request, res: Response): Promise<void> => {
    const query = req.query as unknown as ExpiryReportQuery;
    sendSuccess(res, await expiryReport(tenantContextFrom(req), query));
  }
);

/**
 * Replay the ledger and compare it with the balance cache.
 *
 * ⚠️ A READ, AND IT NEVER REPAIRS. A cache that heals itself hides the trigger
 *   bug that broke it, and a trigger bug is broken for every clinic rather than
 *   for this one row (PI-ADR-004 rule 4). Behind `inventory.stock.adjust` rather
 *   than the plain read code because it is a full-table replay: cheap on a small
 *   clinic, not free on a large one, and not something a dashboard should poll.
 */
stockRoutes.get(
  '/verify',
  authorize(ADJUST),
  validate(z.object({ branchId: z.uuid().optional(), productId: z.uuid().optional() }), 'query'),
  async (req: Request, res: Response): Promise<void> => {
    const query = req.query as { branchId?: string; productId?: string };
    sendSuccess(res, await verifyBalances(tenantContextFrom(req), query));
  }
);

/**
 * Record a movement. THE only write path into `stock_ledger` over HTTP.
 *
 * ⚠️ THE BODY CARRIES NO SIGN AND NO BASE QUANTITY. The caller says what
 *   happened and how much of what they were holding; the server derives the
 *   direction from `movementType`, converts through the product's packaging or
 *   unit graph, and refuses a conversion that does not come out exactly.
 *
 * ⚠️ AND `manualMovementType` IS A SUBSET OF THE LEDGER'S ENUM. Dispensing is
 *   PI-7 and must consult the regulatory engine first; consumption is PI-9;
 *   transfers are PI-3 and are only ever written as a PAIR in one transaction,
 *   which a single-movement endpoint cannot guarantee. Exposing them here would
 *   let a caller write one leg and leave stock that has left one branch and
 *   arrived at none.
 */
stockRoutes.post(
  '/movements',
  authorize(ADJUST),
  validate(recordMovementRequest),
  async (req: Request, res: Response): Promise<void> => {
    const body = req.body as RecordMovementRequest;
    sendSuccess(
      res,
      await recordMovement(tenantContextFrom(req), body, auditMeta(req)),
      'Movement recorded',
      201
    );
  }
);

// ---------------------------------------------------------------------------
// Reason codes  ->  /v1/stock/reason-codes  (PI-3.1)
//
// ⚠️ READING IS BEHIND `inventory.stock.read` AND WRITING IS NOT BEHIND
//   `inventory.stock.adjust`. The picker on the adjustment form is part of the
//   surface the read code gates; DEFINING what reasons exist decides what every
//   future adjustment can be filed under and what every shrinkage report can
//   aggregate, which is a configuration decision and sits beside
//   `inventory.location.manage`. See the code's own comment.
// ---------------------------------------------------------------------------

const reasonCodeParams = z.object({ reasonCodeId: z.uuid() });

stockRoutes.get(
  '/reason-codes',
  authorize(READ),
  validate(stockReasonCodeQuery, 'query'),
  async (req: Request, res: Response): Promise<void> => {
    const query = req.query as unknown as StockReasonCodeQuery;
    sendSuccess(res, await listReasonCodes(tenantContextFrom(req), query));
  }
);

stockRoutes.post(
  '/reason-codes',
  authorize(REASON_CODE_MANAGE),
  validate(createStockReasonCodeRequest),
  async (req: Request, res: Response): Promise<void> => {
    const body = req.body as CreateStockReasonCodeRequest;
    const created = await createReasonCode(tenantContextFrom(req), body, auditMeta(req));
    sendSuccess(res, created, 'Reason code added', 201);
  }
);

stockRoutes.patch(
  '/reason-codes/:reasonCodeId',
  authorize(REASON_CODE_MANAGE),
  validate(reasonCodeParams, 'params'),
  validate(updateStockReasonCodeRequest),
  async (req: Request, res: Response): Promise<void> => {
    const { reasonCodeId } = req.params as z.infer<typeof reasonCodeParams>;
    const body = req.body as UpdateStockReasonCodeRequest;
    sendSuccess(
      res,
      await updateReasonCode(tenantContextFrom(req), reasonCodeId, body, auditMeta(req)),
      'Reason code updated'
    );
  }
);

stockRoutes.delete(
  '/reason-codes/:reasonCodeId',
  authorize(REASON_CODE_MANAGE),
  validate(reasonCodeParams, 'params'),
  async (req: Request, res: Response): Promise<void> => {
    const { reasonCodeId } = req.params as z.infer<typeof reasonCodeParams>;
    await deleteReasonCode(tenantContextFrom(req), reasonCodeId, auditMeta(req));
    sendSuccess(res, null, 'Reason code removed');
  }
);

// ---------------------------------------------------------------------------
// Reservations  ->  /v1/stock/reservations  (PI-3.4)
//
// ⚠️ THERE IS NO PATCH. A reservation is created and released, and nothing in
//   between is editable: changing its quantity would mean moving stock between
//   the AVAILABLE and RESERVED buckets, which is a MOVEMENT, and a PATCH that
//   quietly wrote one would be a second write path into the ledger. Holding a
//   different amount is a release and a new reservation, both of which leave a
//   row somebody can read.
// ---------------------------------------------------------------------------

const reservationParams = z.object({ reservationId: z.uuid() });

stockRoutes.get(
  '/reservations',
  authorize(READ),
  validate(stockReservationQuery, 'query'),
  async (req: Request, res: Response): Promise<void> => {
    const query = req.query as unknown as StockReservationQuery;
    sendSuccess(res, await listReservations(tenantContextFrom(req), query));
  }
);

stockRoutes.post(
  '/reservations',
  authorize(RESERVE),
  validate(createStockReservationRequest),
  async (req: Request, res: Response): Promise<void> => {
    const body = req.body as CreateStockReservationRequest;
    const created = await reserveStock(tenantContextFrom(req), body, auditMeta(req));
    sendSuccess(res, created, 'Stock reserved', 201);
  }
);

stockRoutes.post(
  '/reservations/:reservationId/release',
  authorize(RESERVE),
  validate(reservationParams, 'params'),
  validate(releaseStockReservationRequest),
  async (req: Request, res: Response): Promise<void> => {
    const { reservationId } = req.params as z.infer<typeof reservationParams>;
    const body = req.body as ReleaseStockReservationRequest;
    sendSuccess(
      res,
      await releaseReservation(tenantContextFrom(req), reservationId, body, auditMeta(req)),
      'Reservation released'
    );
  }
);

// ---------------------------------------------------------------------------
// Allocation  ->  /v1/stock/allocations/plan  (PI-3.5)
//
// ⚠️ A POST THAT WRITES NOTHING, WHICH IS DELIBERATE AND IS NOT A REST MISTAKE.
//   The request carries a quantity, a unit and an optional strategy — a body,
//   not a filter — and putting it in a query string would mean encoding decimal
//   quantities into URLs that end up in access logs and browser history. It is
//   gated on the READ code because that is what it is: a question about what
//   would happen, answered without holding anything.
// ---------------------------------------------------------------------------

stockRoutes.post(
  '/allocations/plan',
  authorize(READ),
  validate(allocationPlanRequest),
  async (req: Request, res: Response): Promise<void> => {
    const body = req.body as AllocationPlanRequest;
    sendSuccess(res, await planStockAllocation(tenantContextFrom(req), body));
  }
);

// ---------------------------------------------------------------------------
// Transfers  ->  /v1/stock-transfers  (PI-3.2, PI-3.3)
//
// ⚠️ EVERY WRITE HERE IS BEHIND `inventory.stock.transfer` AND NOT
//   `inventory.stock.adjust`, INCLUDING THE CANCELLATION THAT WRITES A
//   COMPENSATING MOVEMENT. Moving stock between places does not change what the
//   clinic holds; adjusting changes the count, which is where shrinkage hides
//   and why that code carries a mandatory reason. Somebody who may move boxes
//   between shelves is not thereby somebody who may declare a box missing.
//
// ⚠️ AND THE THREE STATE CHANGES ARE POSTS TO SUB-PATHS, NOT A `PATCH { status }`.
//   Dispatching writes ledger rows and takes a document number; receiving writes
//   ledger rows at the OTHER branch and may create lot rows; cancelling writes
//   compensating rows. A status column a client can set would make all three
//   look like one field assignment, and the first caller to set it directly
//   would move stock in no direction at all.
// ---------------------------------------------------------------------------

export const stockTransferRoutes: IRouter = guarded();

const transferParams = z.object({ transferId: z.uuid() });

stockTransferRoutes.get(
  '/',
  authorize(READ),
  validate(stockTransferQuery, 'query'),
  async (req: Request, res: Response): Promise<void> => {
    const query = req.query as unknown as StockTransferQuery;
    sendSuccess(res, await listTransfers(tenantContextFrom(req), query));
  }
);

stockTransferRoutes.get(
  '/:transferId',
  authorize(READ),
  validate(transferParams, 'params'),
  async (req: Request, res: Response): Promise<void> => {
    const { transferId } = req.params as z.infer<typeof transferParams>;
    sendSuccess(res, await getTransfer(tenantContextFrom(req), transferId));
  }
);

stockTransferRoutes.post(
  '/',
  authorize(TRANSFER),
  validate(createStockTransferRequest),
  async (req: Request, res: Response): Promise<void> => {
    const body = req.body as CreateStockTransferRequest;
    const created = await createTransfer(tenantContextFrom(req), body, auditMeta(req));
    sendSuccess(res, created, 'Transfer drafted', 201);
  }
);

stockTransferRoutes.patch(
  '/:transferId',
  authorize(TRANSFER),
  validate(transferParams, 'params'),
  validate(updateStockTransferRequest),
  async (req: Request, res: Response): Promise<void> => {
    const { transferId } = req.params as z.infer<typeof transferParams>;
    const body = req.body as UpdateStockTransferRequest;
    sendSuccess(
      res,
      await updateTransfer(tenantContextFrom(req), transferId, body, auditMeta(req)),
      'Transfer updated'
    );
  }
);

stockTransferRoutes.post(
  '/:transferId/dispatch',
  authorize(TRANSFER),
  validate(transferParams, 'params'),
  async (req: Request, res: Response): Promise<void> => {
    const { transferId } = req.params as z.infer<typeof transferParams>;
    sendSuccess(
      res,
      await dispatchTransfer(tenantContextFrom(req), transferId, auditMeta(req)),
      'Transfer sent'
    );
  }
);

stockTransferRoutes.post(
  '/:transferId/receive',
  authorize(TRANSFER),
  validate(transferParams, 'params'),
  validate(receiveStockTransferRequest),
  async (req: Request, res: Response): Promise<void> => {
    const { transferId } = req.params as z.infer<typeof transferParams>;
    const body = req.body as ReceiveStockTransferRequest;
    sendSuccess(
      res,
      await receiveTransfer(tenantContextFrom(req), transferId, body, await actorMeta(req)),
      'Transfer received'
    );
  }
);

stockTransferRoutes.post(
  '/:transferId/cancel',
  authorize(TRANSFER),
  validate(transferParams, 'params'),
  validate(cancelStockTransferRequest),
  async (req: Request, res: Response): Promise<void> => {
    const { transferId } = req.params as z.infer<typeof transferParams>;
    const body = req.body as CancelStockTransferRequest;
    sendSuccess(
      res,
      await cancelTransfer(tenantContextFrom(req), transferId, body, auditMeta(req)),
      'Transfer cancelled'
    );
  }
);
