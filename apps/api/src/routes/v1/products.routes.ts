/**
 * The product catalogue: browsing it, curating it, and the facets hanging off a
 * product.
 *
 * The standard chain, and the order IS the security model:
 *
 *   requireTenant -> authenticate -> requireAuth -> authorize -> validate -> handler
 *
 * ── THREE DIFFERENT PERMISSIONS GATE THIS ONE RESOURCE, ON PURPOSE ───────────
 * A product row is edited by whoever runs the store, but two of its facets are
 * somebody else's decision entirely:
 *
 *   · the product itself, its packaging and its clone  →  `product.definition.*`
 *   · its identifiers                                  →  `product.identifier.manage`
 *   · its TAX CLASSIFICATION                           →  `billing.tax.manage`   ⚠
 *   · its MEDICINE DETAIL                              →  `pharmacy.medicine.*`  ⚠
 *
 * ⚠️ `billing.tax.manage` ON THE TAX ROUTE IS NOT A COPY-PASTE MISTAKE. Setting
 *   a product's tax category decides what every future patient is charged for
 *   it, on a legal document. That is the accountant's decision, not the
 *   storekeeper's, and this codebase already draws the same line for fee
 *   schedules and tax rules. Do not "tidy" it into a product code.
 *
 * ⚠️ `pharmacy.medicine.manage` ON THE MEDICINE ROUTE IS THE OTHER HALF OF
 *   PI-ADR-011. A lab manager maintains reagents and a dental store manager
 *   maintains materials — both hold `product.definition.manage`, and neither
 *   should be recording a prescription classification.
 *
 * ── WRITES CANNOT TOUCH A PLATFORM ROW, AND IT IS ENFORCED TWICE ─────────────
 * `tenant_isolation` on `products` reads permissively but its WITH CHECK
 * requires `organization_id = app_current_org()`, which a platform row can never
 * satisfy — Postgres refuses the write outright. `assertMutable` in the service
 * runs first only so the caller sees a sentence rather than a row-level-security
 * error. A clinic customises a platform product by cloning it.
 *
 * NO PHI ON THIS SURFACE. A product is not a patient, so nothing here writes
 * `data_access_logs`. That changes the moment dispensing links a product to a
 * person (PI-ADR-016) — and that is a different router.
 */
import { Router, type IRouter, type Request, type Response } from 'express';
import { z } from 'zod';
import {
  createProductIdentifierRequest,
  createProductRequest,
  medicineDetailRequest,
  productListQuery,
  replaceProductPackagingRequest,
  replaceProductTaxClassificationsRequest,
  resolveIdentifierQuery,
  updateProductRequest,
  type CreateProductIdentifierRequest,
  type CreateProductRequest,
  type MedicineDetailRequest,
  type ProductListQuery,
  type ReplaceProductPackagingRequest,
  type ReplaceProductTaxClassificationsRequest,
  type ResolveIdentifierQuery,
  type UpdateProductRequest,
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
  cloneProduct,
  createProduct,
  getProduct,
  listEquivalentProducts,
  listProducts,
  updateProduct,
  withdrawProduct,
} from '../../services/product/product.service.js';
import {
  addIdentifier,
  expireIdentifier,
  listIdentifiers,
  resolveIdentifier,
} from '../../services/product/identifier.service.js';
import { listPackagings, replacePackagings } from '../../services/product/packaging.service.js';
import {
  listTaxClassifications,
  replaceTaxClassifications,
} from '../../services/product/tax-classification.service.js';
import {
  getMedicineDetail,
  upsertMedicineDetail,
} from '../../services/product/medicine.service.js';
import { sendSuccess } from '../../utils/response.js';

const router: IRouter = Router();

router.use(requireTenant, authenticate, requireAuth);

const productParams = z.object({ productId: z.uuid() });
const identifierParams = productParams.extend({ identifierId: z.uuid() });
const cloneBody = z.object({ code: z.string().trim().min(2).max(64).optional() });

const auditMeta = (req: Request): { ipAddress?: string; userAgent?: string } => ({
  ...(req.ip !== undefined ? { ipAddress: req.ip } : {}),
  ...(req.get('user-agent') !== undefined ? { userAgent: req.get('user-agent') as string } : {}),
});

// --- reads -----------------------------------------------------------------

/**
 * ⚠️ MOUNTED BEFORE `/:productId`, AND THAT ORDERING IS LOAD-BEARING. Express
 *   matches in declaration order, so a `/resolve` declared after the parameter
 *   route is swallowed by it and answers "not a uuid" instead of resolving a
 *   barcode. The clinical taxonomy carries the same warning for the same reason.
 */
router.get(
  '/resolve',
  authorize(PERMISSIONS.PRODUCT_DEFINITION_READ),
  validate(resolveIdentifierQuery, 'query'),
  async (req: Request, res: Response): Promise<void> => {
    const query = req.query as unknown as ResolveIdentifierQuery;
    sendSuccess(res, await resolveIdentifier(tenantContextFrom(req), query));
  }
);

router.get(
  '/',
  authorize(PERMISSIONS.PRODUCT_DEFINITION_READ),
  validate(productListQuery, 'query'),
  async (req: Request, res: Response): Promise<void> => {
    const query = req.query as unknown as ProductListQuery;
    sendSuccess(res, await listProducts(tenantContextFrom(req), query));
  }
);

router.get(
  '/:productId',
  authorize(PERMISSIONS.PRODUCT_DEFINITION_READ),
  validate(productParams, 'params'),
  async (req: Request, res: Response): Promise<void> => {
    const { productId } = req.params as z.infer<typeof productParams>;
    sendSuccess(res, await getProduct(tenantContextFrom(req), productId));
  }
);

/**
 * What else shares this product's composition.
 *
 * ⚠️ EQUIVALENCE, NOT PERMISSION TO SUBSTITUTE. That is a regulatory question
 *   answered by PI-5, per jurisdiction, and it also depends on what the
 *   prescriber wrote. Behind the plain read code because it discloses nothing a
 *   catalogue listing does not.
 */
router.get(
  '/:productId/equivalents',
  authorize(PERMISSIONS.PRODUCT_DEFINITION_READ),
  validate(productParams, 'params'),
  async (req: Request, res: Response): Promise<void> => {
    const { productId } = req.params as z.infer<typeof productParams>;
    sendSuccess(res, await listEquivalentProducts(tenantContextFrom(req), productId));
  }
);

router.get(
  '/:productId/packagings',
  authorize(PERMISSIONS.PRODUCT_DEFINITION_READ),
  validate(productParams, 'params'),
  async (req: Request, res: Response): Promise<void> => {
    const { productId } = req.params as z.infer<typeof productParams>;
    sendSuccess(res, { levels: await listPackagings(tenantContextFrom(req), productId) });
  }
);

router.get(
  '/:productId/identifiers',
  authorize(PERMISSIONS.PRODUCT_DEFINITION_READ),
  validate(productParams, 'params'),
  async (req: Request, res: Response): Promise<void> => {
    const { productId } = req.params as z.infer<typeof productParams>;
    sendSuccess(res, { identifiers: await listIdentifiers(tenantContextFrom(req), productId) });
  }
);

/*
 * Reading the tax classification is the ORDINARY product read, while writing it
 * is `billing.tax.manage`. Anyone who can see the product can see what it is
 * classified as — that is what explains a line on a bill they are looking at.
 */
router.get(
  '/:productId/tax-classifications',
  authorize(PERMISSIONS.PRODUCT_DEFINITION_READ),
  validate(productParams, 'params'),
  async (req: Request, res: Response): Promise<void> => {
    const { productId } = req.params as z.infer<typeof productParams>;
    sendSuccess(res, {
      classifications: await listTaxClassifications(tenantContextFrom(req), productId),
    });
  }
);

/*
 * The medicine facet is behind the NARROWER pharmacy code on BOTH sides, unlike
 * the tax facet above. Dosage form, route and the prescription hint are
 * clinical, and a storekeeper reading them learns something the catalogue does
 * not otherwise tell them.
 */
router.get(
  '/:productId/medicine',
  authorize(PERMISSIONS.MEDICINE_READ),
  validate(productParams, 'params'),
  async (req: Request, res: Response): Promise<void> => {
    const { productId } = req.params as z.infer<typeof productParams>;
    sendSuccess(res, await getMedicineDetail(tenantContextFrom(req), productId));
  }
);

// --- writes ----------------------------------------------------------------

router.post(
  '/',
  authorize(PERMISSIONS.PRODUCT_DEFINITION_MANAGE),
  validate(createProductRequest, 'body'),
  async (req: Request, res: Response): Promise<void> => {
    const product = await createProduct(
      tenantContextFrom(req),
      req.body as CreateProductRequest,
      auditMeta(req)
    );
    sendSuccess(res, product, 'Product added', 201);
  }
);

router.patch(
  '/:productId',
  authorize(PERMISSIONS.PRODUCT_DEFINITION_MANAGE),
  validate(productParams, 'params'),
  validate(updateProductRequest, 'body'),
  async (req: Request, res: Response): Promise<void> => {
    const { productId } = req.params as z.infer<typeof productParams>;
    const product = await updateProduct(
      tenantContextFrom(req),
      productId,
      req.body as UpdateProductRequest,
      auditMeta(req)
    );
    sendSuccess(res, product, 'Product updated');
  }
);

/**
 * Copy a platform product into this clinic's catalogue.
 *
 * The ONLY way to customise a platform row, and the database makes it so: a
 * tenant child row cannot reference a platform parent through the composite FK,
 * so there is no path by which a clinic could add its own packaging or
 * identifier to a shared product. The copy arrives as `DRAFT`.
 */
router.post(
  '/:productId/clone',
  authorize(PERMISSIONS.PRODUCT_DEFINITION_MANAGE),
  validate(productParams, 'params'),
  validate(cloneBody, 'body'),
  async (req: Request, res: Response): Promise<void> => {
    const { productId } = req.params as z.infer<typeof productParams>;
    const { code } = req.body as z.infer<typeof cloneBody>;
    const product = await cloneProduct(tenantContextFrom(req), productId, { code }, auditMeta(req));
    sendSuccess(res, product, 'Product copied into your catalogue', 201);
  }
);

/**
 * PUT, not PATCH, and the whole ladder arrives at once.
 *
 * A packaging hierarchy is only meaningful complete — level 3 with no level 2
 * describes a box of nothing. Patching one level at a time is what lets a caller
 * build that gap one request at a time.
 */
router.put(
  '/:productId/packagings',
  authorize(PERMISSIONS.PRODUCT_DEFINITION_MANAGE),
  validate(productParams, 'params'),
  validate(replaceProductPackagingRequest, 'body'),
  async (req: Request, res: Response): Promise<void> => {
    const { productId } = req.params as z.infer<typeof productParams>;
    const levels = await replacePackagings(
      tenantContextFrom(req),
      productId,
      req.body as ReplaceProductPackagingRequest,
      auditMeta(req)
    );
    sendSuccess(res, { levels }, 'Packaging updated');
  }
);

router.post(
  '/:productId/identifiers',
  authorize(PERMISSIONS.PRODUCT_IDENTIFIER_MANAGE),
  validate(productParams, 'params'),
  validate(createProductIdentifierRequest, 'body'),
  async (req: Request, res: Response): Promise<void> => {
    const { productId } = req.params as z.infer<typeof productParams>;
    const identifier = await addIdentifier(
      tenantContextFrom(req),
      productId,
      req.body as CreateProductIdentifierRequest,
      auditMeta(req)
    );
    sendSuccess(res, identifier, 'Identifier added', 201);
  }
);

/**
 * Expire, not delete — the route says DELETE only because that is the verb the
 * client has. Stock received under this identifier must keep resolving, or the
 * traceability chain from a receipt back to what was scanned is broken.
 */
router.delete(
  '/:productId/identifiers/:identifierId',
  authorize(PERMISSIONS.PRODUCT_IDENTIFIER_MANAGE),
  validate(identifierParams, 'params'),
  async (req: Request, res: Response): Promise<void> => {
    const { productId, identifierId } = req.params as z.infer<typeof identifierParams>;
    await expireIdentifier(tenantContextFrom(req), productId, identifierId, auditMeta(req));
    sendSuccess(res, null, 'Identifier expired');
  }
);

/** ⚠️ `billing.tax.manage`. See the file header — this is not a product code. */
router.put(
  '/:productId/tax-classifications',
  authorize(PERMISSIONS.BILLING_TAX_MANAGE),
  validate(productParams, 'params'),
  validate(replaceProductTaxClassificationsRequest, 'body'),
  async (req: Request, res: Response): Promise<void> => {
    const { productId } = req.params as z.infer<typeof productParams>;
    const classifications = await replaceTaxClassifications(
      tenantContextFrom(req),
      productId,
      req.body as ReplaceProductTaxClassificationsRequest,
      auditMeta(req)
    );
    sendSuccess(res, { classifications }, 'Tax classification updated');
  }
);

router.put(
  '/:productId/medicine',
  authorize(PERMISSIONS.MEDICINE_MANAGE),
  validate(productParams, 'params'),
  validate(medicineDetailRequest, 'body'),
  async (req: Request, res: Response): Promise<void> => {
    const { productId } = req.params as z.infer<typeof productParams>;
    const medicine = await upsertMedicineDetail(
      tenantContextFrom(req),
      productId,
      req.body as MedicineDetailRequest,
      auditMeta(req)
    );
    sendSuccess(res, medicine, 'Medicine details updated');
  }
);

/**
 * Withdraw. NOT a hard delete.
 *
 * Batches, ledger rows and dispensing records will reference this product
 * forever; removing it would destroy the record of what was dispensed.
 * `WITHDRAWN` takes it out of every picker while history keeps resolving — and
 * it is deliberately not `DISCONTINUED`, which means "we stopped buying it" and
 * leaves existing stock dispensable (PI-ADR-013).
 */
router.delete(
  '/:productId',
  authorize(PERMISSIONS.PRODUCT_DEFINITION_MANAGE),
  validate(productParams, 'params'),
  async (req: Request, res: Response): Promise<void> => {
    const { productId } = req.params as z.infer<typeof productParams>;
    await withdrawProduct(tenantContextFrom(req), productId, auditMeta(req));
    sendSuccess(res, null, 'Product withdrawn');
  }
);

export default router;
