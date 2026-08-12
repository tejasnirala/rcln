/**
 * The product catalogue: what a thing IS.
 *
 * One catalogue for medicines, gloves, implants, reagents and dental materials
 * (PI-ADR-001). Nothing here carries a quantity, a location or a price — the
 * ledger lands in PI-2, and price is per payer and per contract, which belongs
 * to billing.
 *
 * ── QUANTITIES ARE STRINGS ON THE WIRE, AND THAT IS NOT A STYLE CHOICE ───────
 * Base quantities are `Decimal(18,6)`. A JSON number is an IEEE-754 double, so
 * `0.1` does not survive the round trip and an eighteen-digit quantity loses its
 * tail silently. Every quantity, strength and pack size below is therefore a
 * string matched by `decimalString`, parsed exactly on the server by
 * `services/product/units.ts`, and never touched by `Number()` on either side.
 *
 * ⚠️ THE WEB NEVER REDECLARES THESE TYPES. Both apps import from here, which is
 *   what stops a field being optional in one and required in the other.
 */
import { z } from 'zod';
import { uuid } from './common.js';

// ---------------------------------------------------------------------------
// Vocabulary — mirrors the Prisma enums
// ---------------------------------------------------------------------------

export const unitClass = z.enum(['COUNT', 'VOLUME', 'MASS', 'LENGTH', 'AREA']);

export const productType = z.enum([
  'MEDICINE',
  'VACCINE',
  'CONSUMABLE',
  'SURGICAL_SUPPLY',
  'MEDICAL_DEVICE',
  'IMPLANT',
  'DENTAL_MATERIAL',
  'LAB_REAGENT',
  'DIAGNOSTIC_KIT',
  'VETERINARY_MEDICINE',
  'VETERINARY_CONSUMABLE',
  'GENERAL_CLINICAL_SUPPLY',
]);

export const productStatus = z.enum(['DRAFT', 'ACTIVE', 'DISCONTINUED', 'WITHDRAWN']);

export const trackingMode = z.enum(['NONE', 'LOT_BATCH', 'SERIAL', 'LOT_AND_SERIAL']);

export const productIdentifierType = z.enum([
  'GTIN',
  'EAN',
  'UPC',
  'NDC',
  'NATIONAL_CODE',
  'MANUFACTURER_CODE',
  'INTERNAL_SKU',
  'LOCAL_REGULATORY',
]);

export const dosageForm = z.enum([
  'TABLET',
  'CAPSULE',
  'SYRUP',
  'SUSPENSION',
  'SOLUTION',
  'INJECTION',
  'INFUSION',
  'CREAM',
  'OINTMENT',
  'GEL',
  'LOTION',
  'DROPS',
  'SPRAY',
  'INHALER',
  'PATCH',
  'SUPPOSITORY',
  'PESSARY',
  'POWDER',
  'GRANULES',
  'LOZENGE',
  'IMPLANT',
  'OTHER',
]);

export const administrationRoute = z.enum([
  'ORAL',
  'SUBLINGUAL',
  'BUCCAL',
  'INTRAVENOUS',
  'INTRAMUSCULAR',
  'SUBCUTANEOUS',
  'INTRADERMAL',
  'TOPICAL',
  'TRANSDERMAL',
  'INHALATION',
  'NASAL',
  'OPHTHALMIC',
  'OTIC',
  'RECTAL',
  'VAGINAL',
  'INTRATHECAL',
  'INTRA_ARTICULAR',
  'OTHER',
]);

export const releaseType = z.enum([
  'IMMEDIATE',
  'MODIFIED',
  'SUSTAINED',
  'EXTENDED',
  'DELAYED',
  'CONTROLLED',
]);

export const lightSensitivity = z.enum([
  'NONE',
  'PROTECT_FROM_LIGHT',
  'PROTECT_FROM_DIRECT_SUNLIGHT',
]);

// ---------------------------------------------------------------------------
// Shared primitives
// ---------------------------------------------------------------------------

/**
 * A non-negative decimal, as a string. See the file header for why not a number.
 *
 * Bounded at 6 decimal places because that is the ledger's scale — accepting
 * more would let a caller send precision the database silently discards, which
 * is exactly the class of quiet rounding this domain is built to avoid.
 */
export const decimalString = z
  .string()
  .trim()
  .regex(/^\d+(\.\d{1,6})?$/, 'a number with up to 6 decimal places, e.g. 12.5');

/**
 * A catalogue code. Flat and stable — it is what the seed upserts on and what
 * every identifier and import keys against.
 *
 * ⚠️ NO HYPHENS, FOR THE SAME REASON `taxonomyCode` FORBIDS THEM: a code with
 *   separators becomes a path (`MED-ANTIB-AMOX`), a path encodes a position in
 *   the tree, and re-parenting then forces a rename that forks one row into two.
 *   The hierarchy is `parentId`.
 */
export const catalogueCode = z
  .string()
  .trim()
  .min(2)
  .max(64)
  .regex(/^[A-Z0-9_]+$/, 'uppercase letters, digits and underscores only');

/** ISO 3166-1 alpha-2. Uppercased, so `in` from a form stores as `IN`. */
export const countryCode = z
  .string()
  .trim()
  .length(2)
  .regex(/^[A-Za-z]{2}$/, 'two letters, e.g. IN')
  .toUpperCase();

/** `YYYY-MM-DD`. A calendar date — an identifier is assigned on a day, in
 *  nobody's particular timezone. */
export const effectiveDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'expected YYYY-MM-DD');

// ---------------------------------------------------------------------------
// Units of measure
// ---------------------------------------------------------------------------

export const createUnitRequest = z.object({
  code: catalogueCode.max(32),
  name: z.string().trim().min(1).max(128),
  symbol: z.string().trim().min(1).max(16),
  unitClass,
  /*
   * ⚠️ `isBase` IS ABSENT AND CANNOT BE SET BY A TENANT. Only the platform
   *   declares the canonical unit of a class — a CHECK constraint enforces it.
   *   A clinic with its own base unit would have two roots in its conversion
   *   graph, so the same product would convert differently for it than for
   *   everyone else. See units_of_measure_base_is_platform.
   */
});

export const updateUnitRequest = z
  .object({
    name: z.string().trim().min(1).max(128),
    symbol: z.string().trim().min(1).max(16),
    isActive: z.boolean(),
  })
  .partial()
  .refine((v) => Object.keys(v).length > 0, 'at least one field must be supplied');

export const unitQuery = z.object({
  unitClass: unitClass.optional(),
  includeInactive: z.stringbool().default(false),
});

export const unitSummary = z.object({
  id: uuid,
  code: z.string(),
  name: z.string(),
  symbol: z.string(),
  unitClass,
  isBase: z.boolean(),
  isActive: z.boolean(),
  /** False for a platform row, true for one this clinic added. Drives editability. */
  isOwn: z.boolean(),
});

export const createUnitConversionRequest = z.object({
  fromUnitId: uuid,
  toUnitId: uuid,
  /*
   * An exact integer ratio: `from` x numerator / denominator = `to`.
   *
   * ⚠️ NOT A DECIMAL `factor`. 1 fluid ounce is 29.5735 mL and a third of a gram
   *   is not representable at all in binary floating point; a factor compounds
   *   its error through every level of a packaging hierarchy. Both are bounded
   *   well inside Number.MAX_SAFE_INTEGER so they survive JSON, and become
   *   `bigint` the moment they reach the server.
   */
  numerator: z.number().int().positive().max(1_000_000_000),
  denominator: z.number().int().positive().max(1_000_000_000).default(1),
});

export const unitConversionSummary = z.object({
  id: uuid,
  fromUnitId: uuid,
  fromUnitCode: z.string(),
  toUnitId: uuid,
  toUnitCode: z.string(),
  numerator: z.number().int(),
  denominator: z.number().int(),
  isOwn: z.boolean(),
});

export const unitListResponse = z.object({
  units: z.array(unitSummary),
  conversions: z.array(unitConversionSummary),
});

// ---------------------------------------------------------------------------
// Categories — the same `parentId`-only tree shape as the clinical taxonomy
// ---------------------------------------------------------------------------

export const createProductCategoryRequest = z.object({
  code: catalogueCode,
  name: z.string().trim().min(2).max(255),
  /** Omitted or null creates a root. */
  parentId: uuid.nullish(),
  description: z.string().max(2000).nullish(),
  displayOrder: z.number().int().min(0).max(100_000).default(0),
});

export const updateProductCategoryRequest = z
  .object({
    name: z.string().trim().min(2).max(255),
    parentId: uuid.nullable(),
    description: z.string().max(2000).nullable(),
    displayOrder: z.number().int().min(0).max(100_000),
    isActive: z.boolean(),
  })
  .partial()
  .refine((v) => Object.keys(v).length > 0, 'at least one field must be supplied');

export const productCategory = z.object({
  id: uuid,
  code: z.string(),
  name: z.string(),
  parentId: uuid.nullable(),
  description: z.string().nullable(),
  displayOrder: z.number().int(),
  isActive: z.boolean(),
  isOwn: z.boolean(),
  /** Distance from the root of the tenant-visible tree. 0 for a root. */
  depth: z.number().int(),
  /** Lets a selector render a chevron without a second round trip. */
  hasChildren: z.boolean(),
});

export type ProductCategoryTreeNode = z.infer<typeof productCategory> & {
  children: ProductCategoryTreeNode[];
};

export const productCategoryTreeNode: z.ZodType<ProductCategoryTreeNode> = productCategory.extend({
  children: z.lazy(() => z.array(productCategoryTreeNode)),
});

export const productCategoryListResponse = z.object({
  categories: z.array(productCategory),
});

// ---------------------------------------------------------------------------
// Manufacturers
// ---------------------------------------------------------------------------

export const createManufacturerRequest = z.object({
  code: catalogueCode,
  name: z.string().trim().min(2).max(255),
  countryCode: countryCode.nullish(),
  licenceNumber: z.string().trim().max(128).nullish(),
  gs1Prefix: z.string().trim().max(16).regex(/^\d+$/, 'digits only').nullish(),
});

export const updateManufacturerRequest = createManufacturerRequest
  .omit({ code: true })
  .extend({ isActive: z.boolean() })
  .partial()
  .refine((v) => Object.keys(v).length > 0, 'at least one field must be supplied');

export const manufacturerSummary = z.object({
  id: uuid,
  code: z.string(),
  name: z.string(),
  countryCode: z.string().nullable(),
  licenceNumber: z.string().nullable(),
  gs1Prefix: z.string().nullable(),
  isActive: z.boolean(),
  isOwn: z.boolean(),
});

// ---------------------------------------------------------------------------
// Ingredients and compositions — the generic/brand triangle
// ---------------------------------------------------------------------------

export const createActiveIngredientRequest = z.object({
  code: catalogueCode,
  name: z.string().trim().min(2).max(255),
  /** The International Nonproprietary Name — the one identifier that means the
   *  same substance in every country, and what equivalence is answered on. */
  innName: z.string().trim().max(255).nullish(),
  /** Alternative spellings and local names, for search only. */
  synonyms: z.array(z.string().trim().min(1).max(255)).max(50).optional(),
  description: z.string().max(2000).nullish(),
});

export const updateActiveIngredientRequest = createActiveIngredientRequest
  .omit({ code: true })
  .extend({ isActive: z.boolean() })
  .partial()
  .refine((v) => Object.keys(v).length > 0, 'at least one field must be supplied');

export const activeIngredientSummary = z.object({
  id: uuid,
  code: z.string(),
  name: z.string(),
  innName: z.string().nullable(),
  synonyms: z.array(z.string()),
  description: z.string().nullable(),
  isActive: z.boolean(),
  isOwn: z.boolean(),
});

/**
 * One ingredient at one strength.
 *
 * ⚠️ A MEDICINE IS NEVER ONE INGREDIENT. The strength is here rather than on the
 *   composition for exactly that reason: co-amoxiclav is two substances at two
 *   strengths, and a single strength on the parent can express one of them.
 */
export const compositionIngredientRequest = z.object({
  ingredientId: uuid,
  strength: decimalString,
  strengthUnitId: uuid,
  /** The denominator of a concentration — "per 5 mL". Printed, never computed with. */
  perQuantity: decimalString.nullish(),
  displayOrder: z.number().int().min(0).max(1000).default(0),
});

export const createCompositionRequest = z.object({
  code: catalogueCode,
  name: z.string().trim().min(2).max(500),
  dosageForm: dosageForm.nullish(),
  ingredients: z.array(compositionIngredientRequest).min(1).max(50),
});

export const updateCompositionRequest = z
  .object({
    name: z.string().trim().min(2).max(500),
    dosageForm: dosageForm.nullable(),
    isActive: z.boolean(),
    /** Replaces the whole set — PUT semantics on the children, because an
     *  omitted ingredient means "this is no longer in it". */
    ingredients: z.array(compositionIngredientRequest).min(1).max(50),
  })
  .partial()
  .refine((v) => Object.keys(v).length > 0, 'at least one field must be supplied');

export const compositionIngredientDetail = z.object({
  ingredientId: uuid,
  ingredientName: z.string(),
  innName: z.string().nullable(),
  strength: decimalString,
  strengthUnitId: uuid,
  strengthUnitSymbol: z.string(),
  perQuantity: decimalString.nullable(),
  displayOrder: z.number().int(),
});

export const compositionSummary = z.object({
  id: uuid,
  code: z.string(),
  name: z.string(),
  dosageForm: dosageForm.nullable(),
  isActive: z.boolean(),
  isOwn: z.boolean(),
  ingredients: z.array(compositionIngredientDetail),
  /** How many products reference this composition. What makes substitution
   *  browsable — see `equivalentProducts`. */
  productCount: z.number().int(),
});

// ---------------------------------------------------------------------------
// Storage requirement profiles
// ---------------------------------------------------------------------------

export const createStorageProfileRequest = z
  .object({
    code: catalogueCode,
    name: z.string().trim().min(2).max(255),
    /** Celsius. A signed decimal string: a freezer is -20. */
    minTemperatureC: z
      .string()
      .regex(/^-?\d{1,3}(\.\d{1,2})?$/, 'degrees Celsius, e.g. 2 or -20.5')
      .nullish(),
    maxTemperatureC: z
      .string()
      .regex(/^-?\d{1,3}(\.\d{1,2})?$/, 'degrees Celsius, e.g. 8 or -15')
      .nullish(),
    minHumidityPct: z.number().int().min(0).max(100).nullish(),
    maxHumidityPct: z.number().int().min(0).max(100).nullish(),
    lightSensitivity: lightSensitivity.default('NONE'),
    requiresControlledAccess: z.boolean().default(false),
    hazardClass: z.string().trim().max(64).nullish(),
    handlingNotes: z.string().max(2000).nullish(),
  })
  /*
   * Checked here as well as by the CHECK constraint, because a range the wrong
   * way round matches no fridge at all and the database's error names a
   * constraint rather than the field the user typed into.
   */
  .refine(
    (v) =>
      v.minTemperatureC == null ||
      v.maxTemperatureC == null ||
      Number(v.minTemperatureC) <= Number(v.maxTemperatureC),
    { message: 'the minimum temperature must not be above the maximum', path: ['minTemperatureC'] }
  )
  .refine(
    (v) =>
      v.minHumidityPct == null || v.maxHumidityPct == null || v.minHumidityPct <= v.maxHumidityPct,
    { message: 'the minimum humidity must not be above the maximum', path: ['minHumidityPct'] }
  );

export const storageProfileSummary = z.object({
  id: uuid,
  code: z.string(),
  name: z.string(),
  minTemperatureC: z.string().nullable(),
  maxTemperatureC: z.string().nullable(),
  minHumidityPct: z.number().int().nullable(),
  maxHumidityPct: z.number().int().nullable(),
  lightSensitivity,
  requiresControlledAccess: z.boolean(),
  hazardClass: z.string().nullable(),
  handlingNotes: z.string().nullable(),
  isActive: z.boolean(),
  isOwn: z.boolean(),
});

// ---------------------------------------------------------------------------
// Products
// ---------------------------------------------------------------------------

/**
 * Inventory configuration. Split out so the create and update shapes cannot
 * drift apart, and because these five fields are the ones PI-2 reads.
 */
const productInventoryConfig = z.object({
  trackingMode: trackingMode.default('NONE'),
  isExpiryControlled: z.boolean().default(false),
  defaultShelfLifeDays: z.number().int().positive().max(36_500).nullish(),
  reorderLevelBase: decimalString.nullish(),
  reorderQuantityBase: decimalString.nullish(),
  isStockItem: z.boolean().default(true),
});

/**
 * ⚠️ EXPIRY CONTROL REQUIRES BATCH TRACKING, AND IT IS CHECKED IN THREE PLACES.
 *   `batches.expires_on` is the only column in the programme that holds an
 *   expiry date, and a product tracked `NONE` or `SERIAL` never gets a batch
 *   row — so marking it expiry-controlled asserts a control nothing can record,
 *   and PI-2's expiry sweep would skip it forever without complaining. The
 *   database CHECKs it, the service checks it, and this refines it here so the
 *   error lands on the field the user just ticked.
 */
const expiryNeedsBatchTracking = <T extends z.ZodTypeAny>(schema: T): T =>
  schema.superRefine((value: unknown, ctx: z.RefinementCtx) => {
    const v = value as { isExpiryControlled?: boolean; trackingMode?: string };
    if (
      v.isExpiryControlled === true &&
      v.trackingMode !== undefined &&
      v.trackingMode !== 'LOT_BATCH' &&
      v.trackingMode !== 'LOT_AND_SERIAL'
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['isExpiryControlled'],
        message:
          'An expiry date is recorded against a batch, so expiry control needs batch tracking. Set tracking to Lot/batch first.',
      });
    }
  }) as unknown as T;

export const createProductRequest = expiryNeedsBatchTracking(
  z.object({
    type: productType,
    code: catalogueCode,
    name: z.string().trim().min(2).max(500),
    brandName: z.string().trim().max(255).nullish(),
    genericName: z.string().trim().max(255).nullish(),
    description: z.string().max(4000).nullish(),
    categoryId: uuid.nullish(),
    manufacturerId: uuid.nullish(),
    /** NULL for anything that is not a medicinal product. The nullability is
     *  the discriminator, and it is more honest than a boolean. */
    compositionId: uuid.nullish(),
    storageProfileId: uuid.nullish(),
    /** The denomination every quantity for this product resolves to. */
    baseUnitId: uuid,
    ...productInventoryConfig.shape,
  })
);

export const updateProductRequest = expiryNeedsBatchTracking(
  z
    .object({
      type: productType,
      status: productStatus,
      name: z.string().trim().min(2).max(500),
      brandName: z.string().trim().max(255).nullable(),
      genericName: z.string().trim().max(255).nullable(),
      description: z.string().max(4000).nullable(),
      categoryId: uuid.nullable(),
      manufacturerId: uuid.nullable(),
      compositionId: uuid.nullable(),
      storageProfileId: uuid.nullable(),
      trackingMode,
      isExpiryControlled: z.boolean(),
      defaultShelfLifeDays: z.number().int().positive().max(36_500).nullable(),
      reorderLevelBase: decimalString.nullable(),
      reorderQuantityBase: decimalString.nullable(),
      isStockItem: z.boolean(),
    })
    /*
     * `code` and `baseUnitId` are absent, and neither is an oversight.
     *
     * `code` is the stable identity every identifier, import and future
     * supplier catalogue keys on — a clinic that needs a different code needs a
     * different product.
     *
     * `baseUnitId` is the denomination the LEDGER is written in. Changing it
     * would silently reinterpret every historical movement: 100 becomes 100
     * millilitres where it used to mean 100 tablets, with no row updated and
     * nothing to detect it. PI-2 makes this refusal load-bearing; it is here
     * from the start so no code is ever written that expects to change it.
     */
    .partial()
    .refine((v) => Object.keys(v).length > 0, 'at least one field must be supplied')
);

/**
 * The list query.
 *
 * ⚠️ SERVER-SIDE SEARCH AND PAGINATION, ALWAYS. A mature catalogue is tens of
 *   thousands of rows; loading it into the browser to filter there is the
 *   default that makes this screen unusable at the only clinics that need it.
 */
export const productListQuery = z.object({
  q: z.string().trim().min(2).max(100).optional(),
  type: productType.optional(),
  status: productStatus.optional(),
  categoryId: uuid.optional(),
  manufacturerId: uuid.optional(),
  compositionId: uuid.optional(),
  /** `own` hides the platform catalogue; `platform` hides the clinic's own. */
  source: z.enum(['ALL', 'OWN', 'PLATFORM']).default('ALL'),
  isStockItem: z.stringbool().optional(),
  /**
   * Narrow to products tracked a particular way.
   *
   * ⚠️ ADDED BY PI-2, FOR THE PICKERS. A lot may only be recorded against a
   *   batch-tracked product and a serial only against a serial-tracked one — the
   *   services refuse anything else with a sentence. Offering the whole
   *   catalogue in those two forms and explaining the refusal afterwards is a
   *   worse screen than not offering the impossible choice.
   */
  trackingMode: trackingMode.optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  sortBy: z.enum(['name', 'code', 'createdAt']).default('name'),
  sortOrder: z.enum(['asc', 'desc']).default('asc'),
});

export const productSummary = z.object({
  id: uuid,
  code: z.string(),
  name: z.string(),
  type: productType,
  status: productStatus,
  brandName: z.string().nullable(),
  genericName: z.string().nullable(),
  categoryId: uuid.nullable(),
  categoryName: z.string().nullable(),
  manufacturerId: uuid.nullable(),
  manufacturerName: z.string().nullable(),
  baseUnitId: uuid,
  baseUnitSymbol: z.string(),
  trackingMode,
  isExpiryControlled: z.boolean(),
  isStockItem: z.boolean(),
  /** False for a platform row. A clinic clones rather than edits one. */
  isOwn: z.boolean(),
});

export const productListResponse = z.object({
  products: z.array(productSummary),
  meta: z.object({
    page: z.number().int(),
    limit: z.number().int(),
    total: z.number().int(),
    totalPages: z.number().int(),
  }),
});

// ---------------------------------------------------------------------------
// Packaging
// ---------------------------------------------------------------------------

export const productPackagingRequest = z.object({
  /** 0 is the base unit itself and must contain exactly 1. */
  level: z.number().int().min(0).max(10),
  unitId: uuid,
  quantityOfChild: decimalString,
  isDefaultPurchase: z.boolean().default(false),
  isDefaultSale: z.boolean().default(false),
  barcode: z.string().trim().max(128).nullish(),
});

/**
 * PUT semantics: the whole hierarchy is replaced.
 *
 * A packaging chain is only meaningful complete — level 3 with no level 2 does
 * not describe a box of anything. PATCHing one level would let a caller create
 * that gap one request at a time, so the whole ladder arrives together and is
 * validated as a unit by `assertValidPackaging`.
 */
export const replaceProductPackagingRequest = z.object({
  /*
   * ⚠️ `.min(1)` IS LOad-BEARING, NOT TIDINESS. A PUT of `{"levels": []}` used
   *   to be accepted: the delete-then-recreate ran with nothing to recreate,
   *   `assertValidPackaging` returns early on an empty ladder, and the level-0
   *   guard was written `if (base && …)` so it was skipped when there was no
   *   base at all. The product came out the far side with NO base packaging row
   *   — the one state `createProduct` goes out of its way to make unreachable,
   *   because `quantityInBaseUnits` then throws on every stock movement the
   *   product is ever part of.
   *
   *   Emptying a ladder is not a thing a caller should be able to ask for. A
   *   product that is no longer stocked is `WITHDRAWN`; it still needs to know
   *   what its own base unit is.
   */
  levels: z.array(productPackagingRequest).min(1).max(11),
});

export const productPackagingDetail = z.object({
  id: uuid,
  level: z.number().int(),
  unitId: uuid,
  unitCode: z.string(),
  unitSymbol: z.string(),
  quantityOfChild: decimalString,
  /** How many base units one of this level holds. Computed, never stored. */
  quantityInBase: decimalString,
  isDefaultPurchase: z.boolean(),
  isDefaultSale: z.boolean(),
  barcode: z.string().nullable(),
});

// ---------------------------------------------------------------------------
// Identifiers
// ---------------------------------------------------------------------------

export const createProductIdentifierRequest = z.object({
  type: productIdentifierType,
  value: z.string().trim().min(1).max(128),
  /** NULL = valid everywhere. A GTIN usually is; a national code never is. */
  countryCode: countryCode.nullish(),
  effectiveFrom: effectiveDate.optional(),
  effectiveTo: effectiveDate.nullish(),
  isPrimary: z.boolean().default(false),
});

export const productIdentifierDetail = z.object({
  id: uuid,
  type: productIdentifierType,
  value: z.string(),
  countryCode: z.string().nullable(),
  effectiveFrom: effectiveDate,
  effectiveTo: effectiveDate.nullable(),
  isPrimary: z.boolean(),
  /** False once `effectiveTo` has passed. An expired identifier is kept, not
   *  deleted — stock received under it must still resolve. */
  isCurrent: z.boolean(),
});

/** `GET /v1/products/resolve?value=…` — the barcode lookup PI-23 builds on. */
export const resolveIdentifierQuery = z.object({
  value: z.string().trim().min(1).max(128),
  type: productIdentifierType.optional(),
  countryCode: countryCode.optional(),
});

export const resolveIdentifierResponse = z.object({
  /**
   * Every match, not the first.
   *
   * ⚠️ THE SAME DIGITS LEGITIMATELY RESOLVE TO MORE THAN ONE PRODUCT — a
   *   repackager reuses a GTIN, and two countries assign one national code to
   *   different medicines. Answering with the first row would dispense whichever
   *   the planner happened to return, which is a patient-safety defect wearing
   *   the costume of a convenience. The caller disambiguates, or refuses.
   */
  matches: z.array(
    z.object({
      product: productSummary,
      identifier: productIdentifierDetail,
    })
  ),
});

// ---------------------------------------------------------------------------
// Tax classification
// ---------------------------------------------------------------------------

/**
 * ⚠️ THIS PROGRAMME WRITES NO TAX LOGIC (PI-ADR-006). A classification resolves
 *   a `taxCategory` STRING, which keys `tax_rules` by exact match, and
 *   `@rcln/tax` does everything after it. No rate, no split, no label.
 */
export const productTaxClassificationRequest = z.object({
  countryCode,
  /** NULL = the whole country. A region row beats a country row on the same date. */
  regionCode: z.string().trim().max(16).nullish(),
  /** The exact-match key into `tax_rules`. Never a rate. */
  taxCategory: z.string().trim().min(1).max(64),
  /** HSN / SAC / commodity code. Printed on the invoice, never looked up. */
  itemCode: z.string().trim().max(32).nullish(),
  effectiveFrom: effectiveDate,
  effectiveTo: effectiveDate.nullish(),
});

export const replaceProductTaxClassificationsRequest = z.object({
  classifications: z.array(productTaxClassificationRequest).max(50),
});

export const productTaxClassificationDetail = productTaxClassificationRequest.extend({
  id: uuid,
  regionCode: z.string().nullable(),
  itemCode: z.string().nullable(),
  effectiveTo: effectiveDate.nullable(),
});

/** What the invoice engine will be handed. `null` is a visible configuration
 *  gap, never a default — the engine already refuses an UNRATED line. */
export const resolvedTaxCategoryResponse = z.object({
  taxCategory: z.string().nullable(),
  itemCode: z.string().nullable(),
});

// ---------------------------------------------------------------------------
// Medicine details
// ---------------------------------------------------------------------------

export const medicineDetailRequest = z.object({
  dosageForm: dosageForm.nullish(),
  route: administrationRoute.nullish(),
  releaseType: releaseType.nullish(),
  isNarrowTherapeuticIndex: z.boolean().default(false),
  /**
   * ⚠️ A HINT, AND NOT THE ANSWER. Whether a product needs a prescription is a
   *   per-jurisdiction regulatory fact that lands in PI-5. This records what a
   *   clinic believes while the engine does not exist, and gives PI-5 something
   *   to migrate from. Nothing may gate a dispense on it.
   */
  prescriptionClassificationHint: z.string().trim().max(64).nullish(),
  labelInstructions: z.string().max(2000).nullish(),
  defaultCourseDays: z.number().int().positive().max(3650).nullish(),
});

export const medicineDetail = medicineDetailRequest.extend({
  id: uuid,
  productId: uuid,
});

// ---------------------------------------------------------------------------
// The detail response
// ---------------------------------------------------------------------------

export const productDetail = productSummary.extend({
  description: z.string().nullable(),
  compositionId: uuid.nullable(),
  compositionName: z.string().nullable(),
  storageProfileId: uuid.nullable(),
  storageProfileName: z.string().nullable(),
  baseUnitCode: z.string(),
  defaultShelfLifeDays: z.number().int().nullable(),
  reorderLevelBase: decimalString.nullable(),
  reorderQuantityBase: decimalString.nullable(),
  packagings: z.array(productPackagingDetail),
  identifiers: z.array(productIdentifierDetail),
  taxClassifications: z.array(productTaxClassificationDetail),
  medicine: medicineDetail.nullable(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});

/**
 * "What else is the same medicine?"
 *
 * Answered by shared `compositionId` and nothing else — never by comparing
 * names, which is how "Amoxycillin" and "Amoxicillin" become two medicines.
 *
 * ⚠️ THIS SAYS WHAT IS CHEMICALLY EQUIVALENT, NOT WHAT MAY BE SUBSTITUTED.
 *   Substitution permission is regulatory (PI-5) and depends on jurisdiction,
 *   prescriber instruction and whether the drug has a narrow therapeutic index.
 *   A screen rendering this list must not call it "can be swapped for".
 */
export const equivalentProductsResponse = z.object({
  compositionId: uuid.nullable(),
  products: z.array(productSummary),
});

// ---------------------------------------------------------------------------
// Inferred types
// ---------------------------------------------------------------------------

export type UnitClass = z.infer<typeof unitClass>;
export type ProductType = z.infer<typeof productType>;
export type ProductStatus = z.infer<typeof productStatus>;
export type TrackingMode = z.infer<typeof trackingMode>;
export type ProductIdentifierType = z.infer<typeof productIdentifierType>;
export type DosageForm = z.infer<typeof dosageForm>;
export type AdministrationRoute = z.infer<typeof administrationRoute>;
export type ReleaseType = z.infer<typeof releaseType>;
export type LightSensitivity = z.infer<typeof lightSensitivity>;

export type CreateUnitRequest = z.infer<typeof createUnitRequest>;
export type UpdateUnitRequest = z.infer<typeof updateUnitRequest>;
export type UnitQuery = z.infer<typeof unitQuery>;
export type UnitSummary = z.infer<typeof unitSummary>;
export type CreateUnitConversionRequest = z.infer<typeof createUnitConversionRequest>;
export type UnitConversionSummary = z.infer<typeof unitConversionSummary>;
export type UnitListResponse = z.infer<typeof unitListResponse>;

export type CreateProductCategoryRequest = z.infer<typeof createProductCategoryRequest>;
export type UpdateProductCategoryRequest = z.infer<typeof updateProductCategoryRequest>;
export type ProductCategory = z.infer<typeof productCategory>;
export type ProductCategoryListResponse = z.infer<typeof productCategoryListResponse>;

export type CreateManufacturerRequest = z.infer<typeof createManufacturerRequest>;
export type UpdateManufacturerRequest = z.infer<typeof updateManufacturerRequest>;
export type ManufacturerSummary = z.infer<typeof manufacturerSummary>;

export type CreateActiveIngredientRequest = z.infer<typeof createActiveIngredientRequest>;
export type UpdateActiveIngredientRequest = z.infer<typeof updateActiveIngredientRequest>;
export type ActiveIngredientSummary = z.infer<typeof activeIngredientSummary>;

export type CompositionIngredientRequest = z.infer<typeof compositionIngredientRequest>;
export type CreateCompositionRequest = z.infer<typeof createCompositionRequest>;
export type UpdateCompositionRequest = z.infer<typeof updateCompositionRequest>;
export type CompositionIngredientDetail = z.infer<typeof compositionIngredientDetail>;
export type CompositionSummary = z.infer<typeof compositionSummary>;

export type CreateStorageProfileRequest = z.infer<typeof createStorageProfileRequest>;
export type StorageProfileSummary = z.infer<typeof storageProfileSummary>;

export type CreateProductRequest = z.infer<typeof createProductRequest>;
export type UpdateProductRequest = z.infer<typeof updateProductRequest>;
export type ProductListQuery = z.infer<typeof productListQuery>;
export type ProductSummary = z.infer<typeof productSummary>;
export type ProductListResponse = z.infer<typeof productListResponse>;
export type ProductDetail = z.infer<typeof productDetail>;

export type ProductPackagingRequest = z.infer<typeof productPackagingRequest>;
export type ReplaceProductPackagingRequest = z.infer<typeof replaceProductPackagingRequest>;
export type ProductPackagingDetail = z.infer<typeof productPackagingDetail>;

export type CreateProductIdentifierRequest = z.infer<typeof createProductIdentifierRequest>;
export type ProductIdentifierDetail = z.infer<typeof productIdentifierDetail>;
export type ResolveIdentifierQuery = z.infer<typeof resolveIdentifierQuery>;
export type ResolveIdentifierResponse = z.infer<typeof resolveIdentifierResponse>;

export type ProductTaxClassificationRequest = z.infer<typeof productTaxClassificationRequest>;
export type ReplaceProductTaxClassificationsRequest = z.infer<
  typeof replaceProductTaxClassificationsRequest
>;
export type ProductTaxClassificationDetail = z.infer<typeof productTaxClassificationDetail>;
export type ResolvedTaxCategoryResponse = z.infer<typeof resolvedTaxCategoryResponse>;

export type MedicineDetailRequest = z.infer<typeof medicineDetailRequest>;
export type MedicineDetail = z.infer<typeof medicineDetail>;
export type EquivalentProductsResponse = z.infer<typeof equivalentProductsResponse>;
