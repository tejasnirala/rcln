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
  assignSerialRequest,
  batchHoldRequest,
  batchQuery,
  createBatchRequest,
  createInventoryLocationRequest,
  createSerialRequest,
  expiryReportQuery,
  inventoryLocationQuery,
  recordMovementRequest,
  replaceStorageAreasRequest,
  serialQuery,
  stockBalanceQuery,
  stockLedgerQuery,
  updateBatchRequest,
  updateInventoryLocationRequest,
  updateSerialRequest,
  type AssignSerialRequest,
  type BatchHoldRequest,
  type BatchQuery,
  type CreateBatchRequest,
  type CreateInventoryLocationRequest,
  type CreateSerialRequest,
  type ExpiryReportQuery,
  type InventoryLocationQuery,
  type RecordMovementRequest,
  type ReplaceStorageAreasRequest,
  type SerialQuery,
  type StockBalanceQuery,
  type StockLedgerQuery,
  type UpdateBatchRequest,
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
import { sendSuccess } from '../../utils/response.js';

const READ = PERMISSIONS.STOCK_READ;
const LOCATION_MANAGE = PERMISSIONS.INVENTORY_LOCATION_MANAGE;
const BATCH_MANAGE = PERMISSIONS.BATCH_MANAGE;
const ADJUST = PERMISSIONS.STOCK_ADJUST;

const auditMeta = (req: Request): { ipAddress?: string; userAgent?: string } => ({
  ...(req.ip !== undefined ? { ipAddress: req.ip } : {}),
  ...(req.get('user-agent') !== undefined ? { userAgent: req.get('user-agent') as string } : {}),
});

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
