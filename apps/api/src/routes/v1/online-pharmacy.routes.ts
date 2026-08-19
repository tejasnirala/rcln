/**
 * Online pharmacy: the order, the parcel and where it got to (PI-12).
 *
 * The standard chain, and the order IS the security model:
 *
 *   requireTenant -> authenticate -> requireAuth -> authorize -> validate -> handler
 *
 * ── WHICH CODE GATES WHAT, AND WHY ──────────────────────────────────────────
 *
 *   the list, an order, a tracking number   ->  `pharmacy.online_order.read`
 *   taking one, amending it, accepting it,
 *   standing it down                        ->  `pharmacy.online_order.manage`
 *   ⚠️ MAKING THE PARCEL UP                  ->  `pharmacy.dispense.create`
 *   the courier, the delivery, the failure   ->  `pharmacy.online_order.dispatch`
 *
 * ⚠️ PACKING IS GATED ON `pharmacy.dispense.create` AND THAT IS THE MOST
 *   IMPORTANT LINE IN THIS HEADER. It writes the dispense, moves the ledger and
 *   raises the charge request — it IS the supply, and the only thing distinguishing
 *   it from the counter is that the person receiving it is not in the room. A
 *   fourth online-specific code would be a second door to that authority,
 *   grantable to somebody a clinic had deliberately kept away from the counter.
 *
 * ⚠️ ACCEPTING AN ORDER IS NOT READING ONE. `confirm` writes `RESERVATION`
 *   movements that take stock out of `AVAILABLE`, so the shelf can no longer
 *   sell it to the next person through the door. That is a real inventory act
 *   and it is why `.manage` exists rather than everything sitting behind `.read`.
 *
 * ⚠️ NOTHING ON THIS ROUTER WRITES THE CLINICAL RECORD (invariant 7). It READS a
 *   prescription to fill it, and the only clinical row it ever touches is read.
 *
 * ⚠️ AND A REGULATORY REFUSAL IS A `422`, NEVER A `403` — the note
 *   `pharmacy.routes.ts` carries. So is the remote-supply gate, which is a 422
 *   from the service rather than from the engine and says which product and what
 *   to do about it.
 *
 * ── PHI ─────────────────────────────────────────────────────────────────────
 * ⚠️ EVERY READ ON THIS ROUTER DISCLOSES A NAMED PERSON'S HOME ADDRESS BESIDE
 *   THE MEDICINES GOING TO IT — a broader disclosure than the dispensing surface
 *   makes, and the reason `data_access_logs` gets its own `ONLINE_ORDER`
 *   resource. Every read passes the matched route PATTERN, never
 *   `req.originalUrl`.
 */
import { Router, type IRouter, type Request, type Response } from 'express';
import { z } from 'zod';
import {
  cancelOnlineOrderRequest,
  confirmOnlineOrderRequest,
  createOnlineOrderRequest,
  deliverOnlineOrderRequest,
  failOnlineOrderDeliveryRequest,
  onlineOrderQuery,
  packOnlineOrderRequest,
  shipOnlineOrderRequest,
  updateOnlineOrderRequest,
  type CancelOnlineOrderRequest,
  type ConfirmOnlineOrderRequest,
  type CreateOnlineOrderRequest,
  type DeliverOnlineOrderRequest,
  type FailOnlineOrderDeliveryRequest,
  type OnlineOrderQuery,
  type PackOnlineOrderRequest,
  type ShipOnlineOrderRequest,
  type UpdateOnlineOrderRequest,
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
import { loadUserAccess, permissionsFor } from '../../services/auth/access.service.js';
import {
  cancelOnlineOrder,
  confirmOnlineOrder,
  createOnlineOrder,
  getOnlineOrder,
  listOnlineOrders,
  updateOnlineOrder,
} from '../../services/pharmacy/online-order.service.js';
import {
  deliverOnlineOrder,
  failOnlineOrderDelivery,
  packOnlineOrder,
  shipOnlineOrder,
} from '../../services/pharmacy/fulfilment.service.js';
import type { PharmacyActionOptions } from '../../services/pharmacy/queue.service.js';
import { sendSuccess } from '../../utils/response.js';

const ORDER_READ = PERMISSIONS.ONLINE_ORDER_READ;
const ORDER_MANAGE = PERMISSIONS.ONLINE_ORDER_MANAGE;
const ORDER_DISPATCH = PERMISSIONS.ONLINE_ORDER_DISPATCH;
const DISPENSE_CREATE = PERMISSIONS.DISPENSE_CREATE;

const router: IRouter = Router();
router.use(requireTenant, authenticate, requireAuth);

const orderParams = z.object({ orderId: z.uuid() });

/**
 * Everything the services need about WHO is asking and from WHERE.
 *
 * ⚠️ `roleCodes` IS THE CALLER'S EFFECTIVE PERMISSIONS FOR THE BRANCH BEING
 *   ACTED ON, resolved here rather than inside a service, because
 *   `TenantContext` deliberately carries no permissions — it is an isolation
 *   boundary, not an authorization one. The regulatory engine judges the person
 *   supplying: a `PHARMACIST_AUTHORITY` rule reads permission codes, and it
 *   reads them on a parcel exactly as it does at a counter.
 */
async function orderOptions(req: Request, route: string): Promise<PharmacyActionOptions> {
  const ctx = tenantContextFrom(req);
  const access = await loadUserAccess(ctx.userId, ctx.organizationId);
  const roleCodes = access
    ? permissionsFor(access, ctx.userId, req.auth?.branchId ?? null, false)
    : [];

  return {
    route,
    roleCodes,
    actingBranchId: req.auth?.branchId ?? null,
    ...(req.ip !== undefined ? { ipAddress: req.ip } : {}),
    ...(req.get('user-agent') !== undefined ? { userAgent: req.get('user-agent') as string } : {}),
  };
}

// ---------------------------------------------------------------------------
// Reading  ->  /v1/online-orders
// ---------------------------------------------------------------------------

router.get(
  '/',
  authorize(ORDER_READ),
  validate(onlineOrderQuery, 'query'),
  async (req: Request, res: Response): Promise<void> => {
    const query = req.query as unknown as OnlineOrderQuery;
    const options = await orderOptions(req, 'GET /v1/online-orders');
    sendSuccess(res, await listOnlineOrders(tenantContextFrom(req), query, options));
  }
);

router.get(
  '/:orderId',
  authorize(ORDER_READ),
  validate(orderParams, 'params'),
  async (req: Request, res: Response): Promise<void> => {
    const { orderId } = req.params as z.infer<typeof orderParams>;
    const options = await orderOptions(req, 'GET /v1/online-orders/:orderId');
    sendSuccess(res, await getOnlineOrder(tenantContextFrom(req), orderId, options));
  }
);

// ---------------------------------------------------------------------------
// Taking the order
// ---------------------------------------------------------------------------

router.post(
  '/',
  authorize(ORDER_MANAGE),
  validate(createOnlineOrderRequest),
  async (req: Request, res: Response): Promise<void> => {
    const body = req.body as CreateOnlineOrderRequest;
    const options = await orderOptions(req, 'POST /v1/online-orders');
    sendSuccess(
      res,
      await createOnlineOrder(tenantContextFrom(req), body, options),
      'Order taken',
      201
    );
  }
);

router.patch(
  '/:orderId',
  authorize(ORDER_MANAGE),
  validate(orderParams, 'params'),
  validate(updateOnlineOrderRequest),
  async (req: Request, res: Response): Promise<void> => {
    const { orderId } = req.params as z.infer<typeof orderParams>;
    const body = req.body as UpdateOnlineOrderRequest;
    const options = await orderOptions(req, 'PATCH /v1/online-orders/:orderId');
    sendSuccess(
      res,
      await updateOnlineOrder(tenantContextFrom(req), orderId, body, options),
      'Order updated'
    );
  }
);

/**
 * ⚠️ THIS HOLDS STOCK. It asks the law about every line, snapshots the answer,
 *   plans FEFO and writes one `RESERVATION` movement per lot. A 422 here is the
 *   remote-supply gate or a refusal; a 409 is the shelf losing a race.
 */
router.post(
  '/:orderId/confirm',
  authorize(ORDER_MANAGE),
  validate(orderParams, 'params'),
  validate(confirmOnlineOrderRequest),
  async (req: Request, res: Response): Promise<void> => {
    const { orderId } = req.params as z.infer<typeof orderParams>;
    const body = req.body as ConfirmOnlineOrderRequest;
    const options = await orderOptions(req, 'POST /v1/online-orders/:orderId/confirm');
    sendSuccess(
      res,
      await confirmOnlineOrder(tenantContextFrom(req), orderId, body, options),
      'Order accepted'
    );
  }
);

router.post(
  '/:orderId/cancel',
  authorize(ORDER_MANAGE),
  validate(orderParams, 'params'),
  validate(cancelOnlineOrderRequest),
  async (req: Request, res: Response): Promise<void> => {
    const { orderId } = req.params as z.infer<typeof orderParams>;
    const body = req.body as CancelOnlineOrderRequest;
    const options = await orderOptions(req, 'POST /v1/online-orders/:orderId/cancel');
    sendSuccess(
      res,
      await cancelOnlineOrder(tenantContextFrom(req), orderId, body, options),
      'Order stood down'
    );
  }
);

// ---------------------------------------------------------------------------
// Fulfilment
// ---------------------------------------------------------------------------

/**
 * ⚠️ GATED ON `pharmacy.dispense.create`, NOT ON AN ONLINE CODE. Making the
 *   parcel up IS the supply — see the file header.
 */
router.post(
  '/:orderId/pack',
  authorize(DISPENSE_CREATE),
  validate(orderParams, 'params'),
  validate(packOnlineOrderRequest),
  async (req: Request, res: Response): Promise<void> => {
    const { orderId } = req.params as z.infer<typeof orderParams>;
    const body = req.body as PackOnlineOrderRequest;
    const options = await orderOptions(req, 'POST /v1/online-orders/:orderId/pack');
    sendSuccess(
      res,
      await packOnlineOrder(tenantContextFrom(req), orderId, body, options),
      'Packed'
    );
  }
);

router.post(
  '/:orderId/ship',
  authorize(ORDER_DISPATCH),
  validate(orderParams, 'params'),
  validate(shipOnlineOrderRequest),
  async (req: Request, res: Response): Promise<void> => {
    const { orderId } = req.params as z.infer<typeof orderParams>;
    const body = req.body as ShipOnlineOrderRequest;
    const options = await orderOptions(req, 'POST /v1/online-orders/:orderId/ship');
    sendSuccess(
      res,
      await shipOnlineOrder(tenantContextFrom(req), orderId, body, options),
      'Handed to the carrier'
    );
  }
);

router.post(
  '/:orderId/deliver',
  authorize(ORDER_DISPATCH),
  validate(orderParams, 'params'),
  validate(deliverOnlineOrderRequest),
  async (req: Request, res: Response): Promise<void> => {
    const { orderId } = req.params as z.infer<typeof orderParams>;
    const body = req.body as DeliverOnlineOrderRequest;
    const options = await orderOptions(req, 'POST /v1/online-orders/:orderId/deliver');
    sendSuccess(
      res,
      await deliverOnlineOrder(tenantContextFrom(req), orderId, body, options),
      'Delivered'
    );
  }
);

/**
 * ⚠️ IT MOVES NO STOCK. The parcel is somewhere, and the clinic does not have it
 *   back — putting the quantity on the shelf here would make the balance say the
 *   clinic holds medicine it cannot find. What comes back comes back as a
 *   dispense return.
 */
router.post(
  '/:orderId/delivery-failed',
  authorize(ORDER_DISPATCH),
  validate(orderParams, 'params'),
  validate(failOnlineOrderDeliveryRequest),
  async (req: Request, res: Response): Promise<void> => {
    const { orderId } = req.params as z.infer<typeof orderParams>;
    const body = req.body as FailOnlineOrderDeliveryRequest;
    const options = await orderOptions(req, 'POST /v1/online-orders/:orderId/delivery-failed');
    sendSuccess(
      res,
      await failOnlineOrderDelivery(tenantContextFrom(req), orderId, body, options),
      'Failed attempt recorded'
    );
  }
);

export default router;
