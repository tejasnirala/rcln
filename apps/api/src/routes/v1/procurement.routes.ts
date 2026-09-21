/**
 * Procurement: suppliers, the price book, requisitions, orders, receipts, returns
 * and what it all cost.
 *
 * The standard chain, and the order IS the security model:
 *
 *   requireTenant -> authenticate -> requireAuth -> authorize -> validate -> handler
 *
 * Six routers, mounted under `/v1/procurement` in `index.ts`, in one file — they
 * share one domain, one branch-scoping story and one set of permission codes, and
 * six near-identical files are how one of them ends up with a different guard.
 *
 * ── WHICH CODE GATES WHAT, AND WHY ──────────────────────────────────────────
 *
 *   suppliers + price book, read and write  ->  `pharmacy.supplier.manage`
 *   raising a requisition                   ->  `procurement.requisition.create`
 *   approving or rejecting one              ->  `procurement.requisition.approve`  ⚠
 *   orders, read                            ->  `pharmacy.purchase_order.read`
 *   orders, write and issue                 ->  `pharmacy.purchase_order.manage`
 *   receipts, returns, inspection           ->  `pharmacy.goods_receipt.manage`
 *   what it cost                            ->  `inventory.stock.read`
 *
 * ⚠️ THE APPROVAL SPLIT IS A SEGREGATION-OF-DUTY CONTROL AND THE PERMISSION CODE IS
 *   ONLY ITS FIRST LAYER. Holding `.approve` does not let anybody approve their OWN
 *   requisition: the service refuses it and the
 *   `purchase_requisitions_approver_is_not_creator` CHECK refuses it again. A clinic
 *   may grant both codes to one person — a single-doctor clinic has nobody else —
 *   and that still cannot self-approve one document. See requisition.service.ts.
 *
 * ⚠️ AND IT GUARDS THE INTERNAL **ASK** ONLY — NOT THE MONEY. `pharmacy.purchase_order
 *   .manage` predates this split, so whoever holds it can raise AND issue a purchase
 *   order with no requisition and nobody's second signature, then receive against it.
 *   `PHARMACIST` holds it. Nothing in this phase widened that and nothing narrowed it
 *   either — revoking a code every existing clinic already holds is the one thing a
 *   permission change must not do silently — but "enforced three times" describes the
 *   requisition and must not be read as covering the order. See KNOWN_ISSUES.
 *
 * ⚠️ READING THE SUPPLIER LIST IS BEHIND `supplier.manage` AND NOT A SEPARATE READ
 *   CODE, WHICH IS THE OPPOSITE CALL FROM THE INVENTORY ROUTER'S. There is no
 *   `pharmacy.supplier.read` in the catalogue and inventing one now would be a code
 *   no existing clinic holds, so every supplier picker would come back empty for
 *   everybody until each clinic re-granted it. Recorded in KNOWN_ISSUES; the shape
 *   to aim at is the inventory one, where reads sit behind a single read code.
 *
 * ⚠️ COST AVERAGES SIT BEHIND `inventory.stock.read` RATHER THAN A PURCHASING CODE.
 *   What stock is worth is a stock question — it is read on valuation and stock
 *   screens by people who never raise an order — and gating it behind
 *   `purchase_order.read` would mean a storekeeper counting a shelf cannot see what
 *   is on it is worth.
 *
 * ── PHI ─────────────────────────────────────────────────────────────────────
 * ⚠️ NOTHING ON THIS SURFACE TOUCHES IT, AND THAT IS WORTH STATING BECAUSE ONE PATH
 *   COMES CLOSE. A goods receipt CREATES serials and a purchase return refuses one
 *   that has been issued to a patient — neither ever returns
 *   `serials.assigned_patient_id`, and the refusal message deliberately does not
 *   name the patient. No handler here calls `recordDataAccess`, because none of them
 *   discloses anything about a named person.
 *
 * ⚠️ THE BRANCH IS NEVER TRUSTED FROM THE BODY. Every service asserts the branch is
 *   in `ctx.branchIds` and throws NOT FOUND — never FORBIDDEN — when it is not,
 *   because RLS has already made it invisible and a 403 would confirm the id is real
 *   to somebody probing.
 */
import { Router, type IRouter, type Request, type Response } from 'express';
import { z } from 'zod';
import {
  cancelGoodsReceiptRequest,
  cancelPurchaseOrderRequest,
  cancelPurchaseReturnRequest,
  closePurchaseOrderRequest,
  createGoodsReceiptRequest,
  createPurchaseOrderRequest,
  createPurchaseRequisitionRequest,
  createPurchaseReturnRequest,
  createSupplierProductRequest,
  createSupplierRequest,
  createSupplierTaxIdentifierRequest,
  decideGoodsReceiptQualityRequest,
  goodsReceiptQuery,
  productCostAverageQuery,
  purchaseOrderQuery,
  purchaseRequisitionQuery,
  purchaseReturnQuery,
  rejectPurchaseRequisitionRequest,
  supplierProductQuery,
  supplierQuery,
  updateGoodsReceiptRequest,
  updatePurchaseOrderRequest,
  updatePurchaseRequisitionRequest,
  updatePurchaseReturnRequest,
  updateSupplierProductRequest,
  updateSupplierRequest,
  updateSupplierTaxIdentifierRequest,
  type CancelGoodsReceiptRequest,
  type CancelPurchaseOrderRequest,
  type CancelPurchaseReturnRequest,
  type ClosePurchaseOrderRequest,
  type CreateGoodsReceiptRequest,
  type CreatePurchaseOrderRequest,
  type CreatePurchaseRequisitionRequest,
  type CreatePurchaseReturnRequest,
  type CreateSupplierProductRequest,
  type CreateSupplierRequest,
  type CreateSupplierTaxIdentifierRequest,
  type DecideGoodsReceiptQualityRequest,
  type GoodsReceiptQuery,
  type ProductCostAverageQuery,
  type PurchaseOrderQuery,
  type PurchaseRequisitionQuery,
  type PurchaseReturnQuery,
  type RejectPurchaseRequisitionRequest,
  type SupplierProductQuery,
  type SupplierQuery,
  type UpdateGoodsReceiptRequest,
  type UpdatePurchaseOrderRequest,
  type UpdatePurchaseRequisitionRequest,
  type UpdatePurchaseReturnRequest,
  type UpdateSupplierProductRequest,
  type UpdateSupplierRequest,
  type UpdateSupplierTaxIdentifierRequest,
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
  addSupplierTaxIdentifier,
  createSupplier,
  deleteSupplier,
  getSupplier,
  listSuppliers,
  removeSupplierTaxIdentifier,
  updateSupplier,
  updateSupplierTaxIdentifier,
} from '../../services/procurement/supplier.service.js';
import {
  createSupplierProduct,
  deleteSupplierProduct,
  listSupplierProducts,
  updateSupplierProduct,
} from '../../services/procurement/supplier-product.service.js';
import {
  approveRequisition,
  cancelRequisition,
  createRequisition,
  getRequisition,
  listRequisitions,
  rejectRequisition,
  submitRequisition,
  updateRequisition,
} from '../../services/procurement/requisition.service.js';
import {
  cancelPurchaseOrder,
  closePurchaseOrder,
  createPurchaseOrder,
  getPurchaseOrder,
  issuePurchaseOrder,
  listPurchaseOrders,
  updatePurchaseOrder,
} from '../../services/procurement/purchase-order.service.js';
import {
  cancelGoodsReceipt,
  createGoodsReceipt,
  decideGoodsReceiptQuality,
  getGoodsReceipt,
  listGoodsReceipts,
  postGoodsReceipt,
  updateGoodsReceipt,
} from '../../services/procurement/goods-receipt.service.js';
import {
  cancelPurchaseReturn,
  createPurchaseReturn,
  getPurchaseReturn,
  listPurchaseReturns,
  sendPurchaseReturn,
  updatePurchaseReturn,
} from '../../services/procurement/purchase-return.service.js';
import { listCostAverages } from '../../services/procurement/costing.service.js';
import { sendSuccess } from '../../utils/response.js';

const SUPPLIER_MANAGE = PERMISSIONS.SUPPLIER_MANAGE;
const REQUISITION_CREATE = PERMISSIONS.REQUISITION_CREATE;
const REQUISITION_APPROVE = PERMISSIONS.REQUISITION_APPROVE;
const ORDER_READ = PERMISSIONS.PURCHASE_ORDER_READ;
const ORDER_MANAGE = PERMISSIONS.PURCHASE_ORDER_MANAGE;
const RECEIPT_MANAGE = PERMISSIONS.GOODS_RECEIPT_MANAGE;
const STOCK_READ = PERMISSIONS.STOCK_READ;

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
// Suppliers  ->  /v1/procurement/suppliers
// ---------------------------------------------------------------------------

export const supplierRoutes: IRouter = guarded();

const supplierParams = z.object({ supplierId: z.uuid() });
const taxIdentifierParams = z.object({ supplierId: z.uuid(), identifierId: z.uuid() });

supplierRoutes.get(
  '/',
  authorize(SUPPLIER_MANAGE),
  validate(supplierQuery, 'query'),
  async (req: Request, res: Response): Promise<void> => {
    const query = req.query as unknown as SupplierQuery;
    sendSuccess(res, await listSuppliers(tenantContextFrom(req), query));
  }
);

supplierRoutes.get(
  '/:supplierId',
  authorize(SUPPLIER_MANAGE),
  validate(supplierParams, 'params'),
  async (req: Request, res: Response): Promise<void> => {
    const { supplierId } = req.params as z.infer<typeof supplierParams>;
    sendSuccess(res, await getSupplier(tenantContextFrom(req), supplierId));
  }
);

supplierRoutes.post(
  '/',
  authorize(SUPPLIER_MANAGE),
  validate(createSupplierRequest),
  async (req: Request, res: Response): Promise<void> => {
    const body = req.body as CreateSupplierRequest;
    const created = await createSupplier(tenantContextFrom(req), body, auditMeta(req));
    sendSuccess(res, created, 'Supplier added', 201);
  }
);

supplierRoutes.patch(
  '/:supplierId',
  authorize(SUPPLIER_MANAGE),
  validate(supplierParams, 'params'),
  validate(updateSupplierRequest),
  async (req: Request, res: Response): Promise<void> => {
    const { supplierId } = req.params as z.infer<typeof supplierParams>;
    const body = req.body as UpdateSupplierRequest;
    sendSuccess(
      res,
      await updateSupplier(tenantContextFrom(req), supplierId, body, auditMeta(req))
    );
  }
);

supplierRoutes.delete(
  '/:supplierId',
  authorize(SUPPLIER_MANAGE),
  validate(supplierParams, 'params'),
  async (req: Request, res: Response): Promise<void> => {
    const { supplierId } = req.params as z.infer<typeof supplierParams>;
    await deleteSupplier(tenantContextFrom(req), supplierId, auditMeta(req));
    sendSuccess(res, null, 'Supplier removed');
  }
);

/**
 * Tax identifiers are a path under the supplier rather than a top-level surface.
 *
 * ⚠️ THEY ARE NEVER READ ON THEIR OWN AND NOTHING PRICES ANYTHING FROM THEM. A
 *   supplier's GSTIN is only ever wanted beside the supplier, and giving it a
 *   top-level router would imply otherwise. `@rcln/tax` prices SALES and never sees
 *   these. Each write returns the whole supplier, so a screen showing the list has
 *   the list.
 */
supplierRoutes.post(
  '/:supplierId/tax-identifiers',
  authorize(SUPPLIER_MANAGE),
  validate(supplierParams, 'params'),
  validate(createSupplierTaxIdentifierRequest),
  async (req: Request, res: Response): Promise<void> => {
    const { supplierId } = req.params as z.infer<typeof supplierParams>;
    const body = req.body as CreateSupplierTaxIdentifierRequest;
    const updated = await addSupplierTaxIdentifier(
      tenantContextFrom(req),
      supplierId,
      body,
      auditMeta(req)
    );
    sendSuccess(res, updated, 'Tax number recorded', 201);
  }
);

supplierRoutes.patch(
  '/:supplierId/tax-identifiers/:identifierId',
  authorize(SUPPLIER_MANAGE),
  validate(taxIdentifierParams, 'params'),
  validate(updateSupplierTaxIdentifierRequest),
  async (req: Request, res: Response): Promise<void> => {
    const { supplierId, identifierId } = req.params as z.infer<typeof taxIdentifierParams>;
    const body = req.body as UpdateSupplierTaxIdentifierRequest;
    sendSuccess(
      res,
      await updateSupplierTaxIdentifier(
        tenantContextFrom(req),
        supplierId,
        identifierId,
        body,
        auditMeta(req)
      )
    );
  }
);

supplierRoutes.delete(
  '/:supplierId/tax-identifiers/:identifierId',
  authorize(SUPPLIER_MANAGE),
  validate(taxIdentifierParams, 'params'),
  async (req: Request, res: Response): Promise<void> => {
    const { supplierId, identifierId } = req.params as z.infer<typeof taxIdentifierParams>;
    sendSuccess(
      res,
      await removeSupplierTaxIdentifier(
        tenantContextFrom(req),
        supplierId,
        identifierId,
        auditMeta(req)
      ),
      'Tax number removed'
    );
  }
);

/**
 * The price book, as a path under the supplier for CREATION and a top-level surface
 * for READING.
 *
 * ⚠️ TWO SHAPES BECAUSE THERE ARE TWO QUESTIONS. "What does MediDist sell us" is a
 *   supplier's page; "who sells amoxicillin, and for how much" is the question a
 *   buyer asks from a PRODUCT, and answering it would otherwise mean fanning out one
 *   request per supplier. `/supplier-products` takes `productId` for exactly that.
 */
supplierRoutes.post(
  '/:supplierId/products',
  authorize(SUPPLIER_MANAGE),
  validate(supplierParams, 'params'),
  validate(createSupplierProductRequest),
  async (req: Request, res: Response): Promise<void> => {
    const { supplierId } = req.params as z.infer<typeof supplierParams>;
    const body = req.body as CreateSupplierProductRequest;
    const created = await createSupplierProduct(
      tenantContextFrom(req),
      supplierId,
      body,
      auditMeta(req)
    );
    sendSuccess(res, created, 'Added to the price book', 201);
  }
);

// ---------------------------------------------------------------------------
// The price book  ->  /v1/procurement/supplier-products
// ---------------------------------------------------------------------------

export const supplierProductRoutes: IRouter = guarded();

const supplierProductParams = z.object({ supplierProductId: z.uuid() });

supplierProductRoutes.get(
  '/',
  authorize(SUPPLIER_MANAGE),
  validate(supplierProductQuery, 'query'),
  async (req: Request, res: Response): Promise<void> => {
    const query = req.query as unknown as SupplierProductQuery;
    sendSuccess(res, await listSupplierProducts(tenantContextFrom(req), query));
  }
);

supplierProductRoutes.patch(
  '/:supplierProductId',
  authorize(SUPPLIER_MANAGE),
  validate(supplierProductParams, 'params'),
  validate(updateSupplierProductRequest),
  async (req: Request, res: Response): Promise<void> => {
    const { supplierProductId } = req.params as z.infer<typeof supplierProductParams>;
    const body = req.body as UpdateSupplierProductRequest;
    sendSuccess(
      res,
      await updateSupplierProduct(tenantContextFrom(req), supplierProductId, body, auditMeta(req))
    );
  }
);

supplierProductRoutes.delete(
  '/:supplierProductId',
  authorize(SUPPLIER_MANAGE),
  validate(supplierProductParams, 'params'),
  async (req: Request, res: Response): Promise<void> => {
    const { supplierProductId } = req.params as z.infer<typeof supplierProductParams>;
    await deleteSupplierProduct(tenantContextFrom(req), supplierProductId, auditMeta(req));
    sendSuccess(res, null, 'Removed from the price book');
  }
);

// ---------------------------------------------------------------------------
// Requisitions  ->  /v1/procurement/requisitions
// ---------------------------------------------------------------------------

export const requisitionRoutes: IRouter = guarded();

const requisitionParams = z.object({ requisitionId: z.uuid() });

/**
 * ⚠️ READING IS BEHIND `.create` AND NOT `.approve`, AND BOTH WOULD BE WRONG ALONE.
 *   A storekeeper has to see what they asked for; an approver has to see what they
 *   are approving. Express has no "any of these" form in `authorize`, so reads sit
 *   behind the WIDER of the two — the one every participant in the flow holds — and
 *   the approval ACTIONS are gated separately. `BRANCH_ADMIN` holds both anyway.
 */
requisitionRoutes.get(
  '/',
  authorize(REQUISITION_CREATE),
  validate(purchaseRequisitionQuery, 'query'),
  async (req: Request, res: Response): Promise<void> => {
    const query = req.query as unknown as PurchaseRequisitionQuery;
    sendSuccess(res, await listRequisitions(tenantContextFrom(req), query));
  }
);

requisitionRoutes.get(
  '/:requisitionId',
  authorize(REQUISITION_CREATE),
  validate(requisitionParams, 'params'),
  async (req: Request, res: Response): Promise<void> => {
    const { requisitionId } = req.params as z.infer<typeof requisitionParams>;
    sendSuccess(res, await getRequisition(tenantContextFrom(req), requisitionId));
  }
);

requisitionRoutes.post(
  '/',
  authorize(REQUISITION_CREATE),
  validate(createPurchaseRequisitionRequest),
  async (req: Request, res: Response): Promise<void> => {
    const body = req.body as CreatePurchaseRequisitionRequest;
    const created = await createRequisition(tenantContextFrom(req), body, auditMeta(req));
    sendSuccess(res, created, 'Requisition drafted', 201);
  }
);

requisitionRoutes.patch(
  '/:requisitionId',
  authorize(REQUISITION_CREATE),
  validate(requisitionParams, 'params'),
  validate(updatePurchaseRequisitionRequest),
  async (req: Request, res: Response): Promise<void> => {
    const { requisitionId } = req.params as z.infer<typeof requisitionParams>;
    const body = req.body as UpdatePurchaseRequisitionRequest;
    sendSuccess(
      res,
      await updateRequisition(tenantContextFrom(req), requisitionId, body, auditMeta(req))
    );
  }
);

requisitionRoutes.post(
  '/:requisitionId/submit',
  authorize(REQUISITION_CREATE),
  validate(requisitionParams, 'params'),
  async (req: Request, res: Response): Promise<void> => {
    const { requisitionId } = req.params as z.infer<typeof requisitionParams>;
    sendSuccess(
      res,
      await submitRequisition(tenantContextFrom(req), requisitionId, auditMeta(req)),
      'Sent for approval'
    );
  }
);

requisitionRoutes.post(
  '/:requisitionId/approve',
  authorize(REQUISITION_APPROVE),
  validate(requisitionParams, 'params'),
  async (req: Request, res: Response): Promise<void> => {
    const { requisitionId } = req.params as z.infer<typeof requisitionParams>;
    sendSuccess(
      res,
      await approveRequisition(tenantContextFrom(req), requisitionId, auditMeta(req)),
      'Approved'
    );
  }
);

requisitionRoutes.post(
  '/:requisitionId/reject',
  authorize(REQUISITION_APPROVE),
  validate(requisitionParams, 'params'),
  validate(rejectPurchaseRequisitionRequest),
  async (req: Request, res: Response): Promise<void> => {
    const { requisitionId } = req.params as z.infer<typeof requisitionParams>;
    const body = req.body as RejectPurchaseRequisitionRequest;
    sendSuccess(
      res,
      await rejectRequisition(tenantContextFrom(req), requisitionId, body, auditMeta(req)),
      'Rejected'
    );
  }
);

requisitionRoutes.post(
  '/:requisitionId/cancel',
  authorize(REQUISITION_CREATE),
  validate(requisitionParams, 'params'),
  async (req: Request, res: Response): Promise<void> => {
    const { requisitionId } = req.params as z.infer<typeof requisitionParams>;
    sendSuccess(
      res,
      await cancelRequisition(tenantContextFrom(req), requisitionId, auditMeta(req)),
      'Withdrawn'
    );
  }
);

// ---------------------------------------------------------------------------
// Purchase orders  ->  /v1/procurement/purchase-orders
// ---------------------------------------------------------------------------

export const purchaseOrderRoutes: IRouter = guarded();

const orderParams = z.object({ purchaseOrderId: z.uuid() });

purchaseOrderRoutes.get(
  '/',
  authorize(ORDER_READ),
  validate(purchaseOrderQuery, 'query'),
  async (req: Request, res: Response): Promise<void> => {
    const query = req.query as unknown as PurchaseOrderQuery;
    sendSuccess(res, await listPurchaseOrders(tenantContextFrom(req), query));
  }
);

purchaseOrderRoutes.get(
  '/:purchaseOrderId',
  authorize(ORDER_READ),
  validate(orderParams, 'params'),
  async (req: Request, res: Response): Promise<void> => {
    const { purchaseOrderId } = req.params as z.infer<typeof orderParams>;
    sendSuccess(res, await getPurchaseOrder(tenantContextFrom(req), purchaseOrderId));
  }
);

purchaseOrderRoutes.post(
  '/',
  authorize(ORDER_MANAGE),
  validate(createPurchaseOrderRequest),
  async (req: Request, res: Response): Promise<void> => {
    const body = req.body as CreatePurchaseOrderRequest;
    const created = await createPurchaseOrder(tenantContextFrom(req), body, auditMeta(req));
    sendSuccess(res, created, 'Order drafted', 201);
  }
);

purchaseOrderRoutes.patch(
  '/:purchaseOrderId',
  authorize(ORDER_MANAGE),
  validate(orderParams, 'params'),
  validate(updatePurchaseOrderRequest),
  async (req: Request, res: Response): Promise<void> => {
    const { purchaseOrderId } = req.params as z.infer<typeof orderParams>;
    const body = req.body as UpdatePurchaseOrderRequest;
    sendSuccess(
      res,
      await updatePurchaseOrder(tenantContextFrom(req), purchaseOrderId, body, auditMeta(req))
    );
  }
);

purchaseOrderRoutes.post(
  '/:purchaseOrderId/issue',
  authorize(ORDER_MANAGE),
  validate(orderParams, 'params'),
  async (req: Request, res: Response): Promise<void> => {
    const { purchaseOrderId } = req.params as z.infer<typeof orderParams>;
    sendSuccess(
      res,
      await issuePurchaseOrder(tenantContextFrom(req), purchaseOrderId, auditMeta(req)),
      'Order issued'
    );
  }
);

purchaseOrderRoutes.post(
  '/:purchaseOrderId/close',
  authorize(ORDER_MANAGE),
  validate(orderParams, 'params'),
  validate(closePurchaseOrderRequest),
  async (req: Request, res: Response): Promise<void> => {
    const { purchaseOrderId } = req.params as z.infer<typeof orderParams>;
    const body = req.body as ClosePurchaseOrderRequest;
    sendSuccess(
      res,
      await closePurchaseOrder(tenantContextFrom(req), purchaseOrderId, body, auditMeta(req)),
      'Order closed'
    );
  }
);

purchaseOrderRoutes.post(
  '/:purchaseOrderId/cancel',
  authorize(ORDER_MANAGE),
  validate(orderParams, 'params'),
  validate(cancelPurchaseOrderRequest),
  async (req: Request, res: Response): Promise<void> => {
    const { purchaseOrderId } = req.params as z.infer<typeof orderParams>;
    const body = req.body as CancelPurchaseOrderRequest;
    sendSuccess(
      res,
      await cancelPurchaseOrder(tenantContextFrom(req), purchaseOrderId, body, auditMeta(req)),
      'Order cancelled'
    );
  }
);

// ---------------------------------------------------------------------------
// Goods receipts  ->  /v1/procurement/goods-receipts
// ---------------------------------------------------------------------------

export const goodsReceiptRoutes: IRouter = guarded();

const receiptParams = z.object({ goodsReceiptId: z.uuid() });

goodsReceiptRoutes.get(
  '/',
  authorize(RECEIPT_MANAGE),
  validate(goodsReceiptQuery, 'query'),
  async (req: Request, res: Response): Promise<void> => {
    const query = req.query as unknown as GoodsReceiptQuery;
    sendSuccess(res, await listGoodsReceipts(tenantContextFrom(req), query));
  }
);

goodsReceiptRoutes.get(
  '/:goodsReceiptId',
  authorize(RECEIPT_MANAGE),
  validate(receiptParams, 'params'),
  async (req: Request, res: Response): Promise<void> => {
    const { goodsReceiptId } = req.params as z.infer<typeof receiptParams>;
    sendSuccess(res, await getGoodsReceipt(tenantContextFrom(req), goodsReceiptId));
  }
);

goodsReceiptRoutes.post(
  '/',
  authorize(RECEIPT_MANAGE),
  validate(createGoodsReceiptRequest),
  async (req: Request, res: Response): Promise<void> => {
    const body = req.body as CreateGoodsReceiptRequest;
    const created = await createGoodsReceipt(tenantContextFrom(req), body, auditMeta(req));
    sendSuccess(res, created, 'Delivery drafted', 201);
  }
);

goodsReceiptRoutes.patch(
  '/:goodsReceiptId',
  authorize(RECEIPT_MANAGE),
  validate(receiptParams, 'params'),
  validate(updateGoodsReceiptRequest),
  async (req: Request, res: Response): Promise<void> => {
    const { goodsReceiptId } = req.params as z.infer<typeof receiptParams>;
    const body = req.body as UpdateGoodsReceiptRequest;
    sendSuccess(
      res,
      await updateGoodsReceipt(tenantContextFrom(req), goodsReceiptId, body, auditMeta(req))
    );
  }
);

/**
 * ⚠️ THE ONE ENDPOINT ON THIS ROUTER THAT WRITES `stock_ledger`, AND IT WRITES
 *   EVERY LEG, EVERY LOT ROW, EVERY SERIAL AND THE COST ROLL-UP IN ONE TRANSACTION.
 *   Everything before it is paperwork. See postGoodsReceipt.
 */
goodsReceiptRoutes.post(
  '/:goodsReceiptId/post',
  authorize(RECEIPT_MANAGE),
  validate(receiptParams, 'params'),
  async (req: Request, res: Response): Promise<void> => {
    const { goodsReceiptId } = req.params as z.infer<typeof receiptParams>;
    sendSuccess(
      res,
      await postGoodsReceipt(tenantContextFrom(req), goodsReceiptId, await actorMeta(req)),
      'Delivery received'
    );
  }
);

goodsReceiptRoutes.post(
  '/:goodsReceiptId/quality',
  authorize(RECEIPT_MANAGE),
  validate(receiptParams, 'params'),
  validate(decideGoodsReceiptQualityRequest),
  async (req: Request, res: Response): Promise<void> => {
    const { goodsReceiptId } = req.params as z.infer<typeof receiptParams>;
    const body = req.body as DecideGoodsReceiptQualityRequest;
    sendSuccess(
      res,
      await decideGoodsReceiptQuality(tenantContextFrom(req), goodsReceiptId, body, auditMeta(req)),
      'Inspection recorded'
    );
  }
);

goodsReceiptRoutes.post(
  '/:goodsReceiptId/cancel',
  authorize(RECEIPT_MANAGE),
  validate(receiptParams, 'params'),
  validate(cancelGoodsReceiptRequest),
  async (req: Request, res: Response): Promise<void> => {
    const { goodsReceiptId } = req.params as z.infer<typeof receiptParams>;
    const body = req.body as CancelGoodsReceiptRequest;
    sendSuccess(
      res,
      await cancelGoodsReceipt(tenantContextFrom(req), goodsReceiptId, body, auditMeta(req)),
      'Delivery cancelled'
    );
  }
);

// ---------------------------------------------------------------------------
// Purchase returns  ->  /v1/procurement/returns
// ---------------------------------------------------------------------------

export const purchaseReturnRoutes: IRouter = guarded();

const returnParams = z.object({ purchaseReturnId: z.uuid() });

purchaseReturnRoutes.get(
  '/',
  authorize(RECEIPT_MANAGE),
  validate(purchaseReturnQuery, 'query'),
  async (req: Request, res: Response): Promise<void> => {
    const query = req.query as unknown as PurchaseReturnQuery;
    sendSuccess(res, await listPurchaseReturns(tenantContextFrom(req), query));
  }
);

purchaseReturnRoutes.get(
  '/:purchaseReturnId',
  authorize(RECEIPT_MANAGE),
  validate(returnParams, 'params'),
  async (req: Request, res: Response): Promise<void> => {
    const { purchaseReturnId } = req.params as z.infer<typeof returnParams>;
    sendSuccess(res, await getPurchaseReturn(tenantContextFrom(req), purchaseReturnId));
  }
);

purchaseReturnRoutes.post(
  '/',
  authorize(RECEIPT_MANAGE),
  validate(createPurchaseReturnRequest),
  async (req: Request, res: Response): Promise<void> => {
    const body = req.body as CreatePurchaseReturnRequest;
    const created = await createPurchaseReturn(tenantContextFrom(req), body, auditMeta(req));
    sendSuccess(res, created, 'Return drafted', 201);
  }
);

purchaseReturnRoutes.patch(
  '/:purchaseReturnId',
  authorize(RECEIPT_MANAGE),
  validate(returnParams, 'params'),
  validate(updatePurchaseReturnRequest),
  async (req: Request, res: Response): Promise<void> => {
    const { purchaseReturnId } = req.params as z.infer<typeof returnParams>;
    const body = req.body as UpdatePurchaseReturnRequest;
    sendSuccess(
      res,
      await updatePurchaseReturn(tenantContextFrom(req), purchaseReturnId, body, auditMeta(req))
    );
  }
);

purchaseReturnRoutes.post(
  '/:purchaseReturnId/send',
  authorize(RECEIPT_MANAGE),
  validate(returnParams, 'params'),
  async (req: Request, res: Response): Promise<void> => {
    const { purchaseReturnId } = req.params as z.infer<typeof returnParams>;
    sendSuccess(
      res,
      await sendPurchaseReturn(tenantContextFrom(req), purchaseReturnId, auditMeta(req)),
      'Sent back to the supplier'
    );
  }
);

purchaseReturnRoutes.post(
  '/:purchaseReturnId/cancel',
  authorize(RECEIPT_MANAGE),
  validate(returnParams, 'params'),
  validate(cancelPurchaseReturnRequest),
  async (req: Request, res: Response): Promise<void> => {
    const { purchaseReturnId } = req.params as z.infer<typeof returnParams>;
    const body = req.body as CancelPurchaseReturnRequest;
    sendSuccess(
      res,
      await cancelPurchaseReturn(tenantContextFrom(req), purchaseReturnId, body, auditMeta(req)),
      'Return cancelled'
    );
  }
);

// ---------------------------------------------------------------------------
// What it cost  ->  /v1/procurement/cost-averages
// ---------------------------------------------------------------------------

export const costAverageRoutes: IRouter = guarded();

costAverageRoutes.get(
  '/',
  authorize(STOCK_READ),
  validate(productCostAverageQuery, 'query'),
  async (req: Request, res: Response): Promise<void> => {
    const query = req.query as unknown as ProductCostAverageQuery;
    sendSuccess(res, await listCostAverages(tenantContextFrom(req), query));
  }
);
