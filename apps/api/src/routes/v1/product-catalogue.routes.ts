/**
 * The masters a product POINTS AT: units, categories, manufacturers,
 * ingredients, compositions and storage profiles.
 *
 * Six small surfaces in one file rather than six files, because they share one
 * chain, one pair of permission codes and one tenancy story — and because six
 * near-identical files are how one of them ends up with a different guard.
 * Each is exported as its own router and mounted at its own path in `index.ts`,
 * so the HTTP surface is exactly what `.kb/PharmacyInventory/API_ARCHITECTURE.md`
 * describes.
 *
 * ── READS ARE BEHIND `product.definition.read`, NOT THE MANAGE CODE ──────────
 * Every screen that renders a product needs its category, manufacturer and unit
 * NAME. Gating the masters behind the permission to EDIT them means a
 * pharmacist sees blanks where the catalogue should be. Same reasoning as
 * `GET /clinical-taxonomy`, which this mirrors deliberately.
 *
 * ── WRITES CANNOT TOUCH A PLATFORM ROW ───────────────────────────────────────
 * Enforced twice on every table here: the RLS WITH CHECK refuses it in the
 * database, and the service's `assertMutable` runs first so the caller gets a
 * sentence instead of a policy error. See `unit.service.ts`.
 *
 * NO PHI on any of these.
 */
import { Router, type IRouter, type Request, type Response } from 'express';
import { z } from 'zod';
import {
  createActiveIngredientRequest,
  createCompositionRequest,
  createManufacturerRequest,
  createProductCategoryRequest,
  createStorageProfileRequest,
  createUnitConversionRequest,
  createUnitRequest,
  unitQuery,
  updateActiveIngredientRequest,
  updateCompositionRequest,
  updateManufacturerRequest,
  updateProductCategoryRequest,
  updateUnitRequest,
  type CreateActiveIngredientRequest,
  type CreateCompositionRequest,
  type CreateManufacturerRequest,
  type CreateProductCategoryRequest,
  type CreateStorageProfileRequest,
  type CreateUnitConversionRequest,
  type CreateUnitRequest,
  type UnitQuery,
  type UpdateActiveIngredientRequest,
  type UpdateCompositionRequest,
  type UpdateManufacturerRequest,
  type UpdateProductCategoryRequest,
  type UpdateUnitRequest,
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
  createUnit,
  createUnitConversion,
  deleteUnitConversion,
  listUnits,
  updateUnit,
} from '../../services/product/unit.service.js';
import {
  createCategory,
  deactivateCategory,
  listCategories,
  updateCategory,
} from '../../services/product/category.service.js';
import {
  createActiveIngredient,
  createComposition,
  createManufacturer,
  createStorageProfile,
  getComposition,
  listActiveIngredients,
  listCompositions,
  listManufacturers,
  listStorageProfiles,
  updateActiveIngredient,
  updateComposition,
  updateManufacturer,
} from '../../services/product/catalogue.service.js';
import { sendSuccess } from '../../utils/response.js';

const READ = PERMISSIONS.PRODUCT_DEFINITION_READ;
const MANAGE = PERMISSIONS.PRODUCT_DEFINITION_MANAGE;

const auditMeta = (req: Request): { ipAddress?: string; userAgent?: string } => ({
  ...(req.ip !== undefined ? { ipAddress: req.ip } : {}),
  ...(req.get('user-agent') !== undefined ? { userAgent: req.get('user-agent') as string } : {}),
});

/** Every one of these masters takes the same list query. */
const listQuery = z.object({
  q: z.string().trim().min(2).max(100).optional(),
  includeInactive: z.stringbool().default(false),
  limit: z.coerce.number().int().min(1).max(200).default(100),
});
type ListQuery = z.infer<typeof listQuery>;

/** Applied to each router below. Extracted so one cannot be missed. */
function guarded(): IRouter {
  const r: IRouter = Router();
  r.use(requireTenant, authenticate, requireAuth);
  return r;
}

// ---------------------------------------------------------------------------
// Units  ->  /v1/units
// ---------------------------------------------------------------------------

export const unitRoutes: IRouter = guarded();

unitRoutes.get(
  '/',
  authorize(READ),
  validate(unitQuery, 'query'),
  async (req: Request, res: Response): Promise<void> => {
    const query = req.query as unknown as UnitQuery;
    sendSuccess(res, await listUnits(tenantContextFrom(req), query));
  }
);

unitRoutes.post(
  '/',
  authorize(MANAGE),
  validate(createUnitRequest, 'body'),
  async (req: Request, res: Response): Promise<void> => {
    const unit = await createUnit(
      tenantContextFrom(req),
      req.body as CreateUnitRequest,
      auditMeta(req)
    );
    sendSuccess(res, unit, 'Unit added', 201);
  }
);

unitRoutes.patch(
  '/:unitId',
  authorize(MANAGE),
  validate(z.object({ unitId: z.uuid() }), 'params'),
  validate(updateUnitRequest, 'body'),
  async (req: Request, res: Response): Promise<void> => {
    const { unitId } = req.params as { unitId: string };
    const unit = await updateUnit(
      tenantContextFrom(req),
      unitId,
      req.body as UpdateUnitRequest,
      auditMeta(req)
    );
    sendSuccess(res, unit, 'Unit updated');
  }
);

/*
 * Conversions are a sub-path of units rather than their own surface: a
 * conversion has no meaning without the two units it joins, and every screen
 * that edits one is already showing both.
 */
unitRoutes.post(
  '/conversions',
  authorize(MANAGE),
  validate(createUnitConversionRequest, 'body'),
  async (req: Request, res: Response): Promise<void> => {
    const conversion = await createUnitConversion(
      tenantContextFrom(req),
      req.body as CreateUnitConversionRequest,
      auditMeta(req)
    );
    sendSuccess(res, conversion, 'Conversion added', 201);
  }
);

unitRoutes.delete(
  '/conversions/:conversionId',
  authorize(MANAGE),
  validate(z.object({ conversionId: z.uuid() }), 'params'),
  async (req: Request, res: Response): Promise<void> => {
    const { conversionId } = req.params as { conversionId: string };
    await deleteUnitConversion(tenantContextFrom(req), conversionId, auditMeta(req));
    sendSuccess(res, null, 'Conversion removed');
  }
);

// ---------------------------------------------------------------------------
// Categories  ->  /v1/product-categories
// ---------------------------------------------------------------------------

export const productCategoryRoutes: IRouter = guarded();

productCategoryRoutes.get(
  '/',
  authorize(READ),
  validate(listQuery, 'query'),
  async (req: Request, res: Response): Promise<void> => {
    const { includeInactive } = req.query as unknown as ListQuery;
    sendSuccess(res, { categories: await listCategories(tenantContextFrom(req), includeInactive) });
  }
);

productCategoryRoutes.post(
  '/',
  authorize(MANAGE),
  validate(createProductCategoryRequest, 'body'),
  async (req: Request, res: Response): Promise<void> => {
    const category = await createCategory(
      tenantContextFrom(req),
      req.body as CreateProductCategoryRequest,
      auditMeta(req)
    );
    sendSuccess(res, category, 'Category added', 201);
  }
);

productCategoryRoutes.patch(
  '/:categoryId',
  authorize(MANAGE),
  validate(z.object({ categoryId: z.uuid() }), 'params'),
  validate(updateProductCategoryRequest, 'body'),
  async (req: Request, res: Response): Promise<void> => {
    const { categoryId } = req.params as { categoryId: string };
    const category = await updateCategory(
      tenantContextFrom(req),
      categoryId,
      req.body as UpdateProductCategoryRequest,
      auditMeta(req)
    );
    sendSuccess(res, category, 'Category updated');
  }
);

/** Deactivate, not delete — products reference it with ON DELETE RESTRICT. */
productCategoryRoutes.delete(
  '/:categoryId',
  authorize(MANAGE),
  validate(z.object({ categoryId: z.uuid() }), 'params'),
  async (req: Request, res: Response): Promise<void> => {
    const { categoryId } = req.params as { categoryId: string };
    await deactivateCategory(tenantContextFrom(req), categoryId, auditMeta(req));
    sendSuccess(res, null, 'Category deactivated');
  }
);

// ---------------------------------------------------------------------------
// Manufacturers  ->  /v1/manufacturers
// ---------------------------------------------------------------------------

export const manufacturerRoutes: IRouter = guarded();

manufacturerRoutes.get(
  '/',
  authorize(READ),
  validate(listQuery, 'query'),
  async (req: Request, res: Response): Promise<void> => {
    const { includeInactive } = req.query as unknown as ListQuery;
    sendSuccess(res, {
      manufacturers: await listManufacturers(tenantContextFrom(req), includeInactive),
    });
  }
);

manufacturerRoutes.post(
  '/',
  authorize(MANAGE),
  validate(createManufacturerRequest, 'body'),
  async (req: Request, res: Response): Promise<void> => {
    const manufacturer = await createManufacturer(
      tenantContextFrom(req),
      req.body as CreateManufacturerRequest,
      auditMeta(req)
    );
    sendSuccess(res, manufacturer, 'Manufacturer added', 201);
  }
);

manufacturerRoutes.patch(
  '/:manufacturerId',
  authorize(MANAGE),
  validate(z.object({ manufacturerId: z.uuid() }), 'params'),
  validate(updateManufacturerRequest, 'body'),
  async (req: Request, res: Response): Promise<void> => {
    const { manufacturerId } = req.params as { manufacturerId: string };
    const manufacturer = await updateManufacturer(
      tenantContextFrom(req),
      manufacturerId,
      req.body as UpdateManufacturerRequest,
      auditMeta(req)
    );
    sendSuccess(res, manufacturer, 'Manufacturer updated');
  }
);

// ---------------------------------------------------------------------------
// Active ingredients  ->  /v1/active-ingredients
// ---------------------------------------------------------------------------

export const activeIngredientRoutes: IRouter = guarded();

activeIngredientRoutes.get(
  '/',
  authorize(READ),
  validate(listQuery, 'query'),
  async (req: Request, res: Response): Promise<void> => {
    const query = req.query as unknown as ListQuery;
    sendSuccess(res, {
      ingredients: await listActiveIngredients(tenantContextFrom(req), query),
    });
  }
);

activeIngredientRoutes.post(
  '/',
  authorize(MANAGE),
  validate(createActiveIngredientRequest, 'body'),
  async (req: Request, res: Response): Promise<void> => {
    const ingredient = await createActiveIngredient(
      tenantContextFrom(req),
      req.body as CreateActiveIngredientRequest,
      auditMeta(req)
    );
    sendSuccess(res, ingredient, 'Ingredient added', 201);
  }
);

activeIngredientRoutes.patch(
  '/:ingredientId',
  authorize(MANAGE),
  validate(z.object({ ingredientId: z.uuid() }), 'params'),
  validate(updateActiveIngredientRequest, 'body'),
  async (req: Request, res: Response): Promise<void> => {
    const { ingredientId } = req.params as { ingredientId: string };
    const ingredient = await updateActiveIngredient(
      tenantContextFrom(req),
      ingredientId,
      req.body as UpdateActiveIngredientRequest,
      auditMeta(req)
    );
    sendSuccess(res, ingredient, 'Ingredient updated');
  }
);

// ---------------------------------------------------------------------------
// Compositions  ->  /v1/compositions
// ---------------------------------------------------------------------------

export const compositionRoutes: IRouter = guarded();

compositionRoutes.get(
  '/',
  authorize(READ),
  validate(listQuery, 'query'),
  async (req: Request, res: Response): Promise<void> => {
    const query = req.query as unknown as ListQuery;
    sendSuccess(res, { compositions: await listCompositions(tenantContextFrom(req), query) });
  }
);

compositionRoutes.get(
  '/:compositionId',
  authorize(READ),
  validate(z.object({ compositionId: z.uuid() }), 'params'),
  async (req: Request, res: Response): Promise<void> => {
    const { compositionId } = req.params as { compositionId: string };
    sendSuccess(res, await getComposition(tenantContextFrom(req), compositionId));
  }
);

compositionRoutes.post(
  '/',
  authorize(MANAGE),
  validate(createCompositionRequest, 'body'),
  async (req: Request, res: Response): Promise<void> => {
    const composition = await createComposition(
      tenantContextFrom(req),
      req.body as CreateCompositionRequest,
      auditMeta(req)
    );
    sendSuccess(res, composition, 'Composition added', 201);
  }
);

compositionRoutes.patch(
  '/:compositionId',
  authorize(MANAGE),
  validate(z.object({ compositionId: z.uuid() }), 'params'),
  validate(updateCompositionRequest, 'body'),
  async (req: Request, res: Response): Promise<void> => {
    const { compositionId } = req.params as { compositionId: string };
    const composition = await updateComposition(
      tenantContextFrom(req),
      compositionId,
      req.body as UpdateCompositionRequest,
      auditMeta(req)
    );
    sendSuccess(res, composition, 'Composition updated');
  }
);

// ---------------------------------------------------------------------------
// Storage profiles  ->  /v1/storage-profiles
// ---------------------------------------------------------------------------

export const storageProfileRoutes: IRouter = guarded();

storageProfileRoutes.get(
  '/',
  authorize(READ),
  validate(listQuery, 'query'),
  async (req: Request, res: Response): Promise<void> => {
    const { includeInactive } = req.query as unknown as ListQuery;
    sendSuccess(res, {
      profiles: await listStorageProfiles(tenantContextFrom(req), includeInactive),
    });
  }
);

storageProfileRoutes.post(
  '/',
  authorize(MANAGE),
  validate(createStorageProfileRequest, 'body'),
  async (req: Request, res: Response): Promise<void> => {
    const profile = await createStorageProfile(
      tenantContextFrom(req),
      req.body as CreateStorageProfileRequest,
      auditMeta(req)
    );
    sendSuccess(res, profile, 'Storage profile added', 201);
  }
);
