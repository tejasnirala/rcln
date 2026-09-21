/**
 * The masters a product POINTS AT — units, categories, manufacturers,
 * ingredients, compositions and storage profiles.
 *
 * Six small surfaces sharing one chain, one pair of permission codes and one
 * tenancy story.
 *
 * ⚠️ READS ARE BEHIND `product.definition.read`, NOT THE MANAGE CODE. Every
 *   screen that renders a product needs its category, manufacturer and unit
 *   NAME. Gating the masters behind the permission to edit them shows a
 *   pharmacist blanks where the catalogue should be — the same call
 *   `/clinical-taxonomy` makes, deliberately mirrored.
 *
 * ⚠️ A PLATFORM ROW CANNOT BE WRITTEN, enforced twice on every table here: the
 *   RLS `WITH CHECK` refuses it in the database, and `assertMutable` runs first
 *   so the caller gets a sentence instead of a policy error.
 *
 * No PHI on any of these.
 */
import {
  activeIngredientSummary,
  compositionSummary,
  manufacturerSummary,
  productCategoryListResponse,
  productCategory,
  storageProfileSummary,
  unitConversionSummary,
  unitListResponse,
  unitSummary,
} from '@rcln/contracts';
import type { DocRegistry } from '../types.js';
import {
  CATEGORY_ID,
  COMPOSITION_ID,
  INGREDIENT_ID,
  MANUFACTURER_ID,
  STORAGE_PROFILE_ID,
  UNIT_CAPSULE_ID,
  UNIT_CONVERSION_ID,
  UNIT_STRIP_ID,
} from './fixtures.js';

const OWN_ONLY =
  'A row rcln ships cannot be edited by a clinic — the write is refused twice, in the service and again by RLS.';

const CAPSULE = {
  id: UNIT_CAPSULE_ID,
  code: 'CAPSULE',
  name: 'Capsule',
  symbol: 'cap',
  unitClass: 'COUNT',
  isBase: true,
  isActive: true,
  isOwn: false,
};

const STRIP = {
  id: UNIT_STRIP_ID,
  code: 'STRIP',
  name: 'Strip',
  symbol: 'strip',
  unitClass: 'COUNT',
  isBase: false,
  isActive: true,
  isOwn: false,
};

const CONVERSION = {
  id: UNIT_CONVERSION_ID,
  fromUnitId: UNIT_STRIP_ID,
  fromUnitCode: 'STRIP',
  toUnitId: UNIT_CAPSULE_ID,
  toUnitCode: 'CAPSULE',
  numerator: 10,
  denominator: 1,
  isOwn: false,
};

const CATEGORY = {
  id: CATEGORY_ID,
  code: 'ANTIBIOTICS',
  name: 'Antibiotics',
  parentId: null,
  description: null,
  displayOrder: 1,
  isActive: true,
  isOwn: false,
};

const MANUFACTURER = {
  id: MANUFACTURER_ID,
  code: 'CIPLA',
  name: 'Cipla Ltd',
  countryCode: 'IN',
  licenceNumber: 'KA/25/1234',
  gs1Prefix: '890123',
  isActive: true,
  isOwn: false,
};

const INGREDIENT = {
  id: INGREDIENT_ID,
  code: 'AMOXICILLIN',
  name: 'Amoxicillin',
  innName: 'amoxicillin',
  synonyms: ['Amoxycillin'],
  isActive: true,
  isOwn: false,
};

const COMPOSITION = {
  id: COMPOSITION_ID,
  code: 'AMOX_500_CAP',
  name: 'Amoxicillin 500mg capsule',
  dosageForm: 'CAPSULE',
  isActive: true,
  isOwn: false,
  ingredients: [
    {
      ingredientId: INGREDIENT_ID,
      ingredientName: 'Amoxicillin',
      strength: '500',
      strengthUnitId: UNIT_CAPSULE_ID,
      strengthUnitSymbol: 'mg',
      perQuantity: null,
      displayOrder: 0,
    },
  ],
};

const STORAGE_PROFILE = {
  id: STORAGE_PROFILE_ID,
  code: 'AMBIENT_DRY',
  name: 'Ambient, dry',
  minTemperatureC: null,
  maxTemperatureC: '25',
  minHumidityPct: null,
  maxHumidityPct: 60,
  lightSensitivity: 'NONE',
  requiresControlledAccess: false,
  hazardClass: null,
  handlingNotes: 'Store below 25°C in a dry place.',
  isActive: true,
  isOwn: false,
};

export const catalogueMasterDocs: DocRegistry = {
  'GET /api/v1/units': {
    summary: 'List units and conversions',
    description: `
Every unit of measure, **and every conversion between them**, in one response.

The two travel together deliberately: a unit list without the conversions cannot
answer "how many capsules is a strip", which is the only question a unit list
gets asked.

\`isBase\` marks the unit a product's ledger counts in. \`unitClass\` keeps
conversions honest — a mass never converts to a count.
`.trim(),
    response: unitListResponse,
    params: {
      unitClass: 'Filter to one class — `COUNT`, `VOLUME`, `MASS`, `LENGTH`, `AREA`.',
      includeInactive: 'Include retired units. Defaults to `false`.',
    },
    responseExamples: [
      {
        summary: 'Capsules and strips, with the conversion between them',
        value: {
          success: true,
          message: 'Success',
          data: { units: [CAPSULE, STRIP], conversions: [CONVERSION] },
        },
      },
    ],
  },

  'POST /api/v1/units': {
    summary: 'Create a unit',
    description:
      "Add a unit of measure of this clinic's own. `unitClass` cannot change later — it is what stops a conversion joining a mass to a count. `code` is unique within this clinic.",
    response: unitSummary,
    status: 201,
    errors: [409],
    requestExamples: [
      {
        summary: 'A vial',
        value: { code: 'VIAL', name: 'Vial', symbol: 'vial', unitClass: 'COUNT' },
      },
    ],
    responseExamples: [
      {
        summary: 'Created',
        value: {
          success: true,
          message: 'Success',
          data: {
            ...CAPSULE,
            code: 'VIAL',
            name: 'Vial',
            symbol: 'vial',
            isBase: false,
            isOwn: true,
          },
        },
      },
    ],
  },

  'PATCH /api/v1/units/{unitId}': {
    summary: 'Update a unit',
    description: `Rename a unit, change its symbol, or retire it. **\`code\` and \`unitClass\` are not editable** — conversions and stock balances depend on both. ${OWN_ONLY}`,
    response: unitSummary,
    errors: [403, 409],
    params: { unitId: 'The unit, as `GET /api/v1/units` lists it.' },
    requestExamples: [
      { summary: 'Change the symbol', value: { symbol: 'cp' } },
      { summary: 'Retire it', value: { isActive: false } },
    ],
    responseExamples: [
      {
        summary: 'Updated',
        value: { success: true, message: 'Success', data: { ...CAPSULE, isOwn: true } },
      },
    ],
  },

  'POST /api/v1/units/conversions': {
    summary: 'Create a unit conversion',
    description: `
Join two units by a ratio — a strip is 10 capsules.

**A sub-path of units rather than its own surface**: a conversion has no meaning
without the two units it joins, and every screen that edits one is already
showing both.

Expressed as \`numerator\`/\`denominator\` **integers, never a float** — a
conversion factor that rounds is a stock balance that drifts. Both units must
share a \`unitClass\`.
`.trim(),
    response: unitConversionSummary,
    status: 201,
    errors: [409],
    requestExamples: [
      {
        summary: 'A strip is 10 capsules',
        value: {
          fromUnitId: UNIT_STRIP_ID,
          toUnitId: UNIT_CAPSULE_ID,
          numerator: 10,
          denominator: 1,
        },
      },
    ],
    responseExamples: [
      { summary: 'Created', value: { success: true, message: 'Success', data: CONVERSION } },
    ],
  },

  'DELETE /api/v1/units/conversions/{conversionId}': {
    summary: 'Delete a unit conversion',
    description:
      'Remove a ratio between two units. Existing stock balances are unaffected — they are held in base units, which is exactly why they survive a conversion changing.',
    errors: [403, 409],
    params: { conversionId: 'The conversion, as `GET /api/v1/units` lists it.' },
  },

  'GET /api/v1/product-categories': {
    summary: 'List product categories',
    description:
      'The category tree, nested. The same `parentId`-only shape as the clinical taxonomy, for the same reason — a real tree, never a JSON array of ids.',
    response: productCategoryListResponse,
    params: { includeInactive: 'Include retired categories. Defaults to `false`.' },
    responseExamples: [
      {
        summary: 'One top-level category',
        value: {
          success: true,
          message: 'Success',
          data: { categories: [{ ...CATEGORY, children: [] }] },
        },
      },
    ],
  },

  'POST /api/v1/product-categories': {
    summary: 'Create a product category',
    description:
      'Add a category. `parentId` omitted or null creates a top-level one; naming a parent nests it. `code` is unique within this clinic and `displayOrder` sets the order among siblings.',
    response: productCategory,
    status: 201,
    errors: [409],
    requestExamples: [
      {
        summary: 'A top-level category',
        value: { code: 'ANTIBIOTICS', name: 'Antibiotics', displayOrder: 1 },
      },
      {
        summary: 'Nested under it',
        value: { code: 'PENICILLINS', name: 'Penicillins', parentId: CATEGORY_ID },
      },
    ],
    responseExamples: [
      {
        summary: 'Created',
        value: { success: true, message: 'Success', data: { ...CATEGORY, isOwn: true } },
      },
    ],
  },

  'PATCH /api/v1/product-categories/{categoryId}': {
    summary: 'Update a product category',
    description: `Rename a category, re-parent it, reorder it or retire it. Re-parenting moves the whole subtree; a cycle is rejected. ${OWN_ONLY}`,
    response: productCategory,
    errors: [403, 409],
    params: { categoryId: 'The category, as `GET /api/v1/product-categories` lists it.' },
    requestExamples: [
      { summary: 'Rename', value: { name: 'Antibacterials' } },
      { summary: 'Retire it', value: { isActive: false } },
    ],
    responseExamples: [
      {
        summary: 'Updated',
        value: {
          success: true,
          message: 'Success',
          data: { ...CATEGORY, name: 'Antibacterials', isOwn: true },
        },
      },
    ],
  },

  'DELETE /api/v1/product-categories/{categoryId}': {
    summary: 'Delete a product category',
    description:
      'Remove a category this clinic added. **A category with products in it is `409`** — recategorise them first, because a product filed nowhere is a product nobody finds. Children go with the parent.',
    errors: [403, 409],
    params: { categoryId: 'The category, as `GET /api/v1/product-categories` lists it.' },
  },

  'GET /api/v1/manufacturers': {
    summary: 'List manufacturers',
    description:
      'Who makes the products. `gs1Prefix` is the GS1 company prefix, which is what lets a scanned barcode be attributed to a manufacturer even when the product itself is unknown.',
    params: {
      search: 'Free-text match on name and code.',
      includeInactive: 'Include retired manufacturers. Defaults to `false`.',
    },
    responseExamples: [
      {
        summary: 'One manufacturer',
        value: { success: true, message: 'Success', data: { manufacturers: [MANUFACTURER] } },
      },
    ],
  },

  'POST /api/v1/manufacturers': {
    summary: 'Create a manufacturer',
    description:
      'Add a manufacturer. `licenceNumber` is their manufacturing licence, which appears on regulatory paperwork. `gs1Prefix` is digits only.',
    response: manufacturerSummary,
    status: 201,
    errors: [409],
    requestExamples: [
      {
        summary: 'An Indian manufacturer',
        value: {
          code: 'CIPLA',
          name: 'Cipla Ltd',
          countryCode: 'IN',
          licenceNumber: 'KA/25/1234',
          gs1Prefix: '890123',
        },
      },
    ],
    responseExamples: [
      {
        summary: 'Created',
        value: { success: true, message: 'Success', data: { ...MANUFACTURER, isOwn: true } },
      },
    ],
  },

  'PATCH /api/v1/manufacturers/{manufacturerId}': {
    summary: 'Update a manufacturer',
    description: `Correct a manufacturer's details or retire them. **\`code\` is not editable.** ${OWN_ONLY}`,
    response: manufacturerSummary,
    errors: [403, 409],
    params: { manufacturerId: 'The manufacturer, as `GET /api/v1/manufacturers` lists it.' },
    requestExamples: [
      { summary: 'Update the licence', value: { licenceNumber: 'KA/25/5678' } },
      { summary: 'Retire them', value: { isActive: false } },
    ],
    responseExamples: [
      {
        summary: 'Updated',
        value: { success: true, message: 'Success', data: { ...MANUFACTURER, isOwn: true } },
      },
    ],
  },

  'GET /api/v1/active-ingredients': {
    summary: 'List active ingredients',
    description:
      'The substances compositions are built from. `innName` is the International Nonproprietary Name, and `synonyms` is what makes a search for "Amoxycillin" find "Amoxicillin" — spelling varies by market and a picker that insists on one is a picker nobody finds anything in.',
    params: {
      search: 'Matches name, INN and synonyms.',
      includeInactive: 'Include retired ingredients. Defaults to `false`.',
    },
    responseExamples: [
      {
        summary: 'One ingredient',
        value: { success: true, message: 'Success', data: { ingredients: [INGREDIENT] } },
      },
    ],
  },

  'POST /api/v1/active-ingredients': {
    summary: 'Create an active ingredient',
    description:
      "Add a substance. Prefer recording an `innName` — it is the name that is the same in every market, and it is what makes two clinics' catalogues comparable.",
    response: activeIngredientSummary,
    status: 201,
    errors: [409],
    requestExamples: [
      {
        summary: 'With an INN and a spelling variant',
        value: {
          code: 'AMOXICILLIN',
          name: 'Amoxicillin',
          innName: 'amoxicillin',
          synonyms: ['Amoxycillin'],
        },
      },
    ],
    responseExamples: [
      {
        summary: 'Created',
        value: { success: true, message: 'Success', data: { ...INGREDIENT, isOwn: true } },
      },
    ],
  },

  'PATCH /api/v1/active-ingredients/{ingredientId}': {
    summary: 'Update an active ingredient',
    description: `Correct a substance's names or synonyms, or retire it. **\`code\` is not editable** — compositions cite it. ${OWN_ONLY}`,
    response: activeIngredientSummary,
    errors: [403, 409],
    params: { ingredientId: 'The ingredient, as `GET /api/v1/active-ingredients` lists it.' },
    requestExamples: [
      { summary: 'Add a synonym', value: { synonyms: ['Amoxycillin', 'Amoxicilline'] } },
    ],
    responseExamples: [
      {
        summary: 'Updated',
        value: { success: true, message: 'Success', data: { ...INGREDIENT, isOwn: true } },
      },
    ],
  },

  'GET /api/v1/compositions': {
    summary: 'List compositions',
    description: `
What a medicine is *made of* — the ingredients and their strengths.

⚠️ **This is what makes substitution possible at all.** Two products with the
same composition are the same medicine in different boxes, which is exactly the
question the dispensing counter asks. Brand is a property of the product;
sameness is a property of the composition.
`.trim(),
    params: {
      search: 'Free-text match on name and code.',
      includeInactive: 'Include retired compositions. Defaults to `false`.',
      page: 'Page number, from 1.',
      pageSize: 'Rows per page.',
    },
    responseExamples: [
      {
        summary: 'One composition',
        value: { success: true, message: 'Success', data: { compositions: [COMPOSITION] } },
      },
    ],
  },

  'GET /api/v1/compositions/{compositionId}': {
    summary: 'Get a composition',
    description:
      'One composition with every ingredient, its strength and the unit that strength is expressed in.',
    response: compositionSummary,
    params: { compositionId: 'The composition, as `GET /api/v1/compositions` lists it.' },
    responseExamples: [
      {
        summary: 'A 500mg capsule',
        value: { success: true, message: 'Success', data: COMPOSITION },
      },
    ],
  },

  'POST /api/v1/compositions': {
    summary: 'Create a composition',
    description: `
Define what a medicine is made of.

**At least one ingredient is required** — a composition with none is not a
composition, and it would make every product carrying it spuriously equivalent to
every other.

\`strength\` is a **string**, not a number: \`"0.5"\` must stay exactly that, and
a float would round it. \`perQuantity\` expresses a concentration — 5mg *per 5ml*
— rather than an absolute amount.
`.trim(),
    response: compositionSummary,
    status: 201,
    errors: [409],
    requestExamples: [
      {
        summary: 'A single-ingredient capsule',
        value: {
          code: 'AMOX_500_CAP',
          name: 'Amoxicillin 500mg capsule',
          dosageForm: 'CAPSULE',
          ingredients: [
            { ingredientId: INGREDIENT_ID, strength: '500', strengthUnitId: UNIT_CAPSULE_ID },
          ],
        },
      },
    ],
    responseExamples: [
      {
        summary: 'Created',
        value: { success: true, message: 'Success', data: { ...COMPOSITION, isOwn: true } },
      },
    ],
  },

  'PATCH /api/v1/compositions/{compositionId}': {
    summary: 'Update a composition',
    description: `
Rename a composition, change its dosage form, or retire it.

⚠️ **Changing the ingredient list changes what every product carrying it IS**,
and with it which products are considered equivalent at the dispensing counter.
That is why a genuinely different formulation should be a new composition rather
than an edit of this one.

${OWN_ONLY}
`.trim(),
    response: compositionSummary,
    errors: [403, 409],
    params: { compositionId: 'The composition, as `GET /api/v1/compositions` lists it.' },
    requestExamples: [
      { summary: 'Rename', value: { name: 'Amoxicillin 500mg capsule (oral)' } },
      { summary: 'Retire it', value: { isActive: false } },
    ],
    responseExamples: [
      {
        summary: 'Updated',
        value: { success: true, message: 'Success', data: { ...COMPOSITION, isOwn: true } },
      },
    ],
  },

  'GET /api/v1/storage-profiles': {
    summary: 'List storage profiles',
    description:
      'How things must be kept — temperature and humidity bands, light sensitivity, whether controlled access is required. What a cold-chain alert and a put-away decision both consult.',
    params: { includeInactive: 'Include retired profiles. Defaults to `false`.' },
    responseExamples: [
      {
        summary: 'Ambient storage',
        value: { success: true, message: 'Success', data: { storageProfiles: [STORAGE_PROFILE] } },
      },
    ],
  },

  'POST /api/v1/storage-profiles': {
    summary: 'Create a storage profile',
    description: `
Define a set of storage conditions.

Temperatures are **strings in degrees Celsius** — \`"2"\`, \`"-20.5"\` — so a
half-degree survives exactly. A minimum above its maximum is refused, in both
temperature and humidity: an impossible band would silently make every location
non-compliant.

\`requiresControlledAccess\` marks stock that must live behind a lock, which is
what a narcotics cupboard is.
`.trim(),
    response: storageProfileSummary,
    status: 201,
    errors: [409],
    requestExamples: [
      {
        summary: 'Ambient and dry',
        value: {
          code: 'AMBIENT_DRY',
          name: 'Ambient, dry',
          maxTemperatureC: '25',
          maxHumidityPct: 60,
          handlingNotes: 'Store below 25°C in a dry place.',
        },
      },
      {
        summary: 'Cold chain',
        value: {
          code: 'COLD_CHAIN',
          name: 'Refrigerated 2–8°C',
          minTemperatureC: '2',
          maxTemperatureC: '8',
          lightSensitivity: 'PROTECT_FROM_LIGHT',
        },
      },
    ],
    responseExamples: [
      {
        summary: 'Created',
        value: { success: true, message: 'Success', data: { ...STORAGE_PROFILE, isOwn: true } },
      },
    ],
  },
};
