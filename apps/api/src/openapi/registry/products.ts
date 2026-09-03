/**
 * The product catalogue — what a thing IS, and the masters it points at.
 *
 * ⚠️ ONE CATALOGUE FOR EVERYTHING. Medicines, gloves, implants, reagents and
 *   dental materials are all `products`; what makes one a medicine is a
 *   `medicine_details` facet, not a separate table. **Nothing here carries a
 *   quantity** — where stock is and how much of it exists is Inventory.
 *
 * ⚠️ FOUR PERMISSIONS GATE ONE RESOURCE, AND TWO OF THEM ARE NOT THE
 *   STOREKEEPER'S:
 *
 *   - the product, its packaging, its clone → `product.definition.*`
 *   - its identifiers                       → `product.identifier.manage`
 *   - its TAX CLASSIFICATION                → `billing.tax.manage`
 *   - its MEDICINE DETAIL                   → `pharmacy.medicine.*`
 *
 *   Setting a product's tax category decides what every future patient is
 *   charged for it on a legal document — the accountant's decision, not the
 *   storekeeper's. And a lab manager maintaining reagents holds
 *   `product.definition.manage` while having no business recording a
 *   prescription classification. Neither is a copy-paste mistake; do not "tidy"
 *   them into a product code.
 *
 * ⚠️ A PLATFORM ROW CANNOT BE WRITTEN, enforced twice — an RLS `WITH CHECK` a
 *   platform row can never satisfy, and `assertMutable` running first so the
 *   caller gets a sentence rather than a policy error. A clinic customises a
 *   platform product by **cloning** it.
 *
 * NO PHI here. A product is not a patient.
 */
import {
  equivalentProductsResponse,
  medicineDetail,
  productDetail,
  productIdentifierDetail,
  productImportResponse,
  productListResponse,
  resolveIdentifierResponse,
} from '@rcln/contracts';
import type { DocRegistry } from '../types.js';
import {
  CATEGORY_CODE,
  CATEGORY_ID,
  COMPOSITION_ID,
  IDENTIFIER_ID,
  MANUFACTURER_CODE,
  MANUFACTURER_ID,
  PACKAGING_ID,
  PRODUCT,
  PRODUCT_GTIN,
  PRODUCT_ID,
  SECOND_PRODUCT_CODE,
  STORAGE_PROFILE_ID,
  SUBSTITUTE_PRODUCT_ID,
  UNIT_CAPSULE_CODE,
  UNIT_CAPSULE_ID,
  UNIT_STRIP_ID,
} from './fixtures.js';

const PRODUCT_NOTE =
  'The product, as `GET /api/v1/products` lists it. A platform product is readable by every clinic but writable by none.';

const PRODUCT_SUMMARY = {
  id: PRODUCT_ID,
  type: 'MEDICINE',
  code: PRODUCT.code,
  name: PRODUCT.name,
  brandName: 'Amoxil',
  genericName: 'Amoxicillin',
  status: 'ACTIVE',
  categoryId: CATEGORY_ID,
  categoryName: 'Antibiotics',
  manufacturerId: MANUFACTURER_ID,
  manufacturerName: 'Cipla Ltd',
  baseUnitId: UNIT_CAPSULE_ID,
  baseUnitName: 'Capsule',
  trackingMode: 'LOT_BATCH',
  isExpiryControlled: true,
  isStockItem: true,
  isOwn: true,
};

export const productDocs: DocRegistry = {
  'GET /api/v1/products/resolve': {
    summary: 'Resolve a barcode',
    description: `
Find a product by a scanned barcode, GTIN or any other identifier.

⚠️ **Declared before \`/{productId}\`, and that ordering is load-bearing.**
Express matches in declaration order, so a \`/resolve\` declared after the
parameter route is swallowed by it and answers "not a uuid" instead of resolving
a barcode.

Answers the product plus **which identifier matched**, because the same physical
box can carry several and knowing which one scanned matters when they disagree.
`.trim(),
    response: resolveIdentifierResponse,
    params: {
      value: 'The scanned value. Required.',
      type: 'Narrow to one identifier type, e.g. `GTIN`.',
    },
    responseExamples: [
      {
        summary: 'A GTIN scanned at the counter',
        value: {
          success: true,
          message: 'Success',
          data: {
            product: PRODUCT_SUMMARY,
            identifier: {
              id: IDENTIFIER_ID,
              type: 'GTIN',
              value: '08901234567890',
              packagingId: PACKAGING_ID,
            },
          },
        },
      },
    ],
  },

  'GET /api/v1/products': {
    summary: 'List products',
    description:
      "The catalogue, filterable by type, category, manufacturer and status. `isOwn` separates this clinic's products from the shared platform catalogue. Carries no quantity — stock is `GET /api/v1/stock`.",
    response: productListResponse,
    paginated: true,
    params: {
      search: 'Free-text match on name, brand and code.',
      type: 'Filter by product type, e.g. `MEDICINE`, `CONSUMABLE`.',
      categoryId: 'Filter to one category.',
      manufacturerId: 'Filter to one manufacturer.',
      status: 'Filter by `DRAFT`, `ACTIVE`, `DISCONTINUED` or `WITHDRAWN`.',
      page: 'Page number, from 1.',
      pageSize: 'Rows per page.',
    },
    responseExamples: [
      {
        summary: 'One medicine',
        value: {
          success: true,
          message: 'Success',
          data: { products: [PRODUCT_SUMMARY], total: 1, page: 1, pageSize: 25 },
        },
      },
    ],
  },

  'GET /api/v1/products/{productId}': {
    summary: 'Get a product',
    description:
      'One product with its category, manufacturer, composition, storage profile and inventory configuration. Facets that sit behind other permissions — tax classification, medicine detail, regulatory profile — have their own endpoints and are not folded in here.',
    response: productDetail,
    params: { productId: PRODUCT_NOTE },
    responseExamples: [
      {
        summary: 'An antibiotic',
        value: {
          success: true,
          message: 'Success',
          data: {
            ...PRODUCT_SUMMARY,
            description: null,
            compositionId: COMPOSITION_ID,
            storageProfileId: STORAGE_PROFILE_ID,
            defaultShelfLifeDays: 730,
            reorderLevelBase: '200',
            reorderQuantityBase: '500',
          },
        },
      },
    ],
  },

  'GET /api/v1/products/{productId}/equivalents': {
    summary: 'List equivalent products',
    description:
      'Products sharing this one\'s composition — the catalogue half of what substitution at the counter needs. It answers "what is the same medicine"; whether any of it may lawfully be supplied is `GET /api/v1/pharmacy/substitutions/{productId}`, which asks the regulatory engine.',
    response: equivalentProductsResponse,
    params: { productId: PRODUCT_NOTE },
    responseExamples: [
      {
        summary: 'One other brand',
        value: {
          success: true,
          message: 'Success',
          data: {
            products: [
              {
                ...PRODUCT_SUMMARY,
                id: SUBSTITUTE_PRODUCT_ID,
                name: 'Amoxil 500mg Capsule',
                code: 'MED-AMOXIL-500',
              },
            ],
          },
        },
      },
    ],
  },

  'GET /api/v1/products/{productId}/packagings': {
    summary: 'Get the packaging ladder',
    description:
      'How the product is packed — capsule, strip of 10, box of 10 strips — each level with its factor down to the base unit. This is what turns "2 boxes" into a base quantity the ledger can hold.',
    params: { productId: PRODUCT_NOTE },
    responseExamples: [
      {
        summary: 'Capsule → strip → box',
        value: {
          success: true,
          message: 'Success',
          data: {
            packagings: [
              {
                id: PACKAGING_ID,
                level: 1,
                unitId: UNIT_STRIP_ID,
                unitName: 'Strip',
                quantityInBase: '10',
              },
            ],
          },
        },
      },
    ],
  },

  'GET /api/v1/products/{productId}/identifiers': {
    summary: 'List identifiers',
    description:
      'Every barcode, GTIN and catalogue number on this product. An identifier may be tied to a **packaging level**, because the strip and the box carry different barcodes.',
    params: { productId: PRODUCT_NOTE },
    responseExamples: [
      {
        summary: 'One GTIN on the strip',
        value: {
          success: true,
          message: 'Success',
          data: {
            identifiers: [
              {
                id: IDENTIFIER_ID,
                type: 'GTIN',
                value: '08901234567890',
                packagingId: PACKAGING_ID,
              },
            ],
          },
        },
      },
    ],
  },

  'GET /api/v1/products/{productId}/tax-classifications': {
    summary: 'Get tax classifications',
    description:
      'Which tax category this product falls in, per jurisdiction and effective period. Read behind `product.definition.read`; **writing is `billing.tax.manage`** because it decides what every future patient is charged on a legal document.',
    params: { productId: PRODUCT_NOTE },
    responseExamples: [
      {
        summary: '12% GST in India',
        value: {
          success: true,
          message: 'Success',
          data: {
            classifications: [
              {
                countryCode: 'IN',
                regionCode: null,
                taxCategoryCode: 'GST_12',
                hsnCode: PRODUCT.hsnCode,
                effectiveFrom: '2026-01-01',
                effectiveTo: null,
              },
            ],
          },
        },
      },
    ],
  },

  'GET /api/v1/products/{productId}/regulatory-profiles': {
    summary: 'Get regulatory profiles',
    description:
      'What this product IS in the eyes of the law, per jurisdiction — its schedule class, whether a prescription is required, its online-sale position. **This is the one regulatory thing a clinic writes**; the rule packs themselves are platform law and read-only.',
    params: { productId: PRODUCT_NOTE },
    responseExamples: [
      {
        summary: 'Schedule H in India',
        value: {
          success: true,
          message: 'Success',
          data: {
            profiles: [
              {
                countryCode: 'IN',
                regionCode: null,
                scheduleClass: 'H',
                prescriptionRequirement: 'REQUIRED',
                onlineSalePosition: 'RESTRICTED',
                registrationStatus: 'REGISTERED',
                effectiveFrom: '2026-01-01',
                effectiveTo: null,
              },
            ],
          },
        },
      },
    ],
  },

  'GET /api/v1/products/{productId}/medicine': {
    summary: 'Get the medicine detail',
    description:
      'The pharmacy facet — dosage form, administration route, release type, light sensitivity. Behind `pharmacy.medicine.read`, not the product code: a dental store manager maintains materials without needing to read prescription classifications.',
    response: medicineDetail,
    params: { productId: PRODUCT_NOTE },
    responseExamples: [
      {
        summary: 'An oral capsule',
        value: {
          success: true,
          message: 'Success',
          data: {
            productId: PRODUCT_ID,
            dosageForm: 'CAPSULE',
            administrationRoute: 'ORAL',
            releaseType: 'IMMEDIATE',
            strength: '500mg',
            lightSensitivity: 'NONE',
            isNarcotic: false,
          },
        },
      },
    ],
  },

  'POST /api/v1/products': {
    summary: 'Create a product',
    description: `
Add a product to this clinic's catalogue.

⚠️ **Expiry control requires batch tracking.** An expiry date is recorded against
a batch, so \`isExpiryControlled: true\` with \`trackingMode: NONE\` is refused
with a sentence saying so — it would otherwise create stock whose expiry nothing
can ever record.

\`baseUnitId\` is the unit the ledger counts in and cannot be changed later.
\`code\` is unique within this clinic.

Created \`ACTIVE\` unless \`status\` says otherwise; facets — tax, medicine
detail, regulatory profile — are set through their own endpoints, behind their
own permissions.
`.trim(),
    response: productDetail,
    status: 201,
    errors: [409],
    requestExamples: [
      {
        summary: 'A batch-tracked medicine',
        value: {
          type: 'MEDICINE',
          code: PRODUCT.code,
          name: PRODUCT.name,
          brandName: 'Amoxil',
          genericName: 'Amoxicillin',
          categoryId: CATEGORY_ID,
          manufacturerId: MANUFACTURER_ID,
          compositionId: COMPOSITION_ID,
          storageProfileId: STORAGE_PROFILE_ID,
          baseUnitId: UNIT_CAPSULE_ID,
          trackingMode: 'LOT_BATCH',
          isExpiryControlled: true,
          defaultShelfLifeDays: 730,
          reorderLevelBase: '200',
          reorderQuantityBase: '500',
        },
      },
      {
        summary: 'A consumable with no tracking',
        value: {
          type: 'CONSUMABLE',
          code: 'CON-GLOVE-M',
          name: 'Nitrile examination glove, medium',
          baseUnitId: UNIT_CAPSULE_ID,
          trackingMode: 'NONE',
        },
      },
    ],
    responseExamples: [
      { summary: 'Created', value: { success: true, message: 'Success', data: PRODUCT_SUMMARY } },
    ],
  },

  'PATCH /api/v1/products/{productId}': {
    summary: 'Update a product',
    description:
      "A partial update of the product's own fields. **`baseUnitId` is not editable** — the ledger already holds quantities in it, and changing it would silently reinterpret every existing balance. A platform product is refused; clone it instead.",
    response: productDetail,
    errors: [403, 409],
    params: { productId: PRODUCT_NOTE },
    requestExamples: [
      { summary: 'Set a reorder level', value: { reorderLevelBase: '300' } },
      { summary: 'Discontinue it', value: { status: 'DISCONTINUED' } },
    ],
    responseExamples: [
      { summary: 'Updated', value: { success: true, message: 'Success', data: PRODUCT_SUMMARY } },
    ],
  },

  'POST /api/v1/products/import': {
    summary: 'Import a catalogue from a spreadsheet',
    description: `
Create many products at once, naming units, categories and manufacturers by
their **codes** rather than by id — a spreadsheet has no uuids in it.

⚠️ **Run it with \`dryRun: true\` first.** The response is identical either way:
every row gets an outcome and, where it failed, a sentence saying why. A file
assembled by hand is wrong the first time, and the useful answer is the whole
list rather than the first row that broke.

⚠️ **It is all or nothing.** If any row fails, nothing is written — a partly
imported catalogue is a state nobody can reason about, and re-running it buries
the genuine failures under a page of "already exists".

A code that already exists is **skipped, not updated**: a stale spreadsheet must
not silently undo a correction somebody made on screen.

Where a code matches both one of this clinic's masters and a platform one, the
clinic's own wins.

Prices and tax classifications are **not** part of this: a price is per branch
and per currency, a tax classification is per country and per jurisdiction, and
one spreadsheet column cannot honestly mean both.
`.trim(),
    response: productImportResponse,
    requestExamples: [
      {
        summary: 'Two medicines, checked but not written',
        value: {
          dryRun: true,
          rows: [
            {
              type: 'MEDICINE',
              code: PRODUCT.code,
              name: PRODUCT.name,
              brandName: 'Amoxil',
              genericName: 'Amoxicillin',
              baseUnitCode: UNIT_CAPSULE_CODE,
              categoryCode: CATEGORY_CODE,
              manufacturerCode: MANUFACTURER_CODE,
              barcode: PRODUCT_GTIN,
              trackingMode: 'BATCH',
              isExpiryControlled: true,
              isStockItem: true,
            },
            {
              type: 'MEDICINE',
              code: SECOND_PRODUCT_CODE,
              name: 'Paracetamol 650mg Tablet',
              baseUnitCode: UNIT_CAPSULE_CODE,
              trackingMode: 'BATCH',
              isExpiryControlled: true,
              isStockItem: true,
            },
          ],
        },
      },
    ],
    responseExamples: [
      {
        summary: 'One row would land, one names a unit that does not exist',
        value: {
          dryRun: true,
          created: 0,
          skipped: 0,
          failed: 1,
          results: [
            {
              row: 1,
              code: PRODUCT.code,
              outcome: 'CREATED',
              productId: PRODUCT_ID,
              message: null,
            },
            {
              row: 2,
              code: SECOND_PRODUCT_CODE,
              outcome: 'FAILED',
              productId: null,
              message: 'No unit has the code "TABLET".',
            },
          ],
        },
      },
    ],
  },

  'POST /api/v1/products/{productId}/clone': {
    summary: 'Clone a product',
    description: `
Copy a product into this clinic's own catalogue.

⚠️ **This is how a clinic customises a platform product**, and the only way. A
platform row cannot be written — enforced by RLS and by the service — so
adjusting a shared product means taking a copy that belongs to you.

The copy arrives as \`DRAFT\`, so it is not orderable or dispensable until
reviewed. Identifiers are **not** copied: a barcode identifies a specific
manufacturer's packaging, and duplicating it onto a clinic-local product would
make a scan ambiguous.
`.trim(),
    response: productDetail,
    status: 201,
    errors: [409],
    params: { productId: PRODUCT_NOTE },
    requestExamples: [
      {
        summary: 'With a new code',
        value: { code: 'MED-AMOX-500-LOCAL', name: 'Amoxicillin 500mg (house)' },
      },
    ],
    responseExamples: [
      {
        summary: 'Cloned as a draft',
        value: {
          success: true,
          message: 'Success',
          data: { ...PRODUCT_SUMMARY, status: 'DRAFT', code: 'MED-AMOX-500-LOCAL', isOwn: true },
        },
      },
    ],
  },

  'PUT /api/v1/products/{productId}/packagings': {
    summary: 'Replace the packaging ladder',
    description: `
Set how the product is packed, whole.

⚠️ **\`PUT\`, and the whole ladder arrives at once — a packaging hierarchy is
only meaningful complete.** Level 3 with no level 2 is a box containing nothing,
and a partial update is how that state gets created.

Each level's \`quantityInBase\` is its factor down to the product's base unit, so
a strip of 10 capsules is \`"10"\`.
`.trim(),
    errors: [409],
    params: { productId: PRODUCT_NOTE },
    requestExamples: [
      {
        summary: 'Strip of 10, box of 10 strips',
        value: {
          packagings: [
            { level: 1, unitId: UNIT_STRIP_ID, quantityInBase: '10' },
            { level: 2, unitId: UNIT_STRIP_ID, quantityInBase: '100' },
          ],
        },
      },
    ],
  },

  'POST /api/v1/products/{productId}/identifiers': {
    summary: 'Add an identifier',
    description:
      'Attach a barcode, GTIN or catalogue number. `packagingId` ties it to a packaging level, because the strip and the box carry different barcodes. Behind `product.identifier.manage`, separate from the product code — scanning accuracy is its own responsibility. A value already in use is `409`.',
    response: productIdentifierDetail,
    status: 201,
    errors: [409],
    params: { productId: PRODUCT_NOTE },
    requestExamples: [
      {
        summary: 'A GTIN on the strip',
        value: { type: 'GTIN', value: '08901234567890', packagingId: PACKAGING_ID },
      },
    ],
    responseExamples: [
      {
        summary: 'Added',
        value: {
          success: true,
          message: 'Success',
          data: {
            id: IDENTIFIER_ID,
            type: 'GTIN',
            value: '08901234567890',
            packagingId: PACKAGING_ID,
          },
        },
      },
    ],
  },

  'DELETE /api/v1/products/{productId}/identifiers/{identifierId}': {
    summary: 'Remove an identifier',
    description:
      'Detach a barcode. Historical stock movements are unaffected — they recorded the product, not the barcode that found it.',
    params: {
      productId: PRODUCT_NOTE,
      identifierId: 'The identifier, as `GET /api/v1/products/{productId}/identifiers` lists it.',
    },
  },

  'PUT /api/v1/products/{productId}/tax-classifications': {
    summary: 'Set tax classifications',
    description: `
Decide which tax category this product falls in, per jurisdiction.

⚠️ **Behind \`billing.tax.manage\`, NOT a product code, and that is not a
copy-paste mistake.** This decides what every future patient is charged for the
product on a legal document. It is the accountant's decision, not the
storekeeper's — the same line this codebase draws for fee schedules and tax
rules.

\`PUT\` replaces the set. Classifications are effective-dated, so a rate change
is a new row rather than an edit — invoices already raised recorded the category
that applied on the day.
`.trim(),
    errors: [409],
    params: { productId: PRODUCT_NOTE },
    requestExamples: [
      {
        summary: '12% GST from January',
        value: {
          classifications: [
            {
              countryCode: 'IN',
              taxCategoryCode: 'GST_12',
              hsnCode: PRODUCT.hsnCode,
              effectiveFrom: '2026-01-01',
            },
          ],
        },
      },
    ],
  },

  'PUT /api/v1/products/{productId}/regulatory-profiles': {
    summary: 'Set regulatory profiles',
    description: `
Record what this product is in the eyes of the law, per jurisdiction — its
schedule class, whether a prescription is required, its online-sale position.

⚠️ **The one regulatory thing a clinic writes.** The rule packs themselves are
platform law and read-only from a tenant. This says what the *product* is; the
packs say what follows from that.

**Getting it wrong is how a Schedule H medicine gets sold over the counter** —
the dispensing engine consults this profile, so an absent or wrong one is the
difference between a lawful refusal and an unlawful supply.

\`PUT\` replaces the set; profiles are effective-dated.
`.trim(),
    errors: [409],
    params: { productId: PRODUCT_NOTE },
    requestExamples: [
      {
        summary: 'Schedule H in India',
        value: {
          profiles: [
            {
              countryCode: 'IN',
              scheduleClass: 'H',
              prescriptionRequirement: 'REQUIRED',
              onlineSalePosition: 'RESTRICTED',
              registrationStatus: 'REGISTERED',
              effectiveFrom: '2026-01-01',
            },
          ],
        },
      },
    ],
  },

  'PUT /api/v1/products/{productId}/medicine': {
    summary: 'Set the medicine detail',
    description:
      'Record the pharmacy facet — dosage form, route, release type, light sensitivity, narcotic status. Behind `pharmacy.medicine.manage`: a lab manager maintaining reagents and a dental store manager maintaining materials both hold the product code, and neither should be recording a prescription classification.',
    response: medicineDetail,
    errors: [409],
    params: { productId: PRODUCT_NOTE },
    requestExamples: [
      {
        summary: 'An oral capsule',
        value: {
          dosageForm: 'CAPSULE',
          administrationRoute: 'ORAL',
          releaseType: 'IMMEDIATE',
          strength: '500mg',
          lightSensitivity: 'NONE',
          isNarcotic: false,
        },
      },
    ],
  },

  'DELETE /api/v1/products/{productId}': {
    summary: 'Withdraw a product',
    description: `
Take a product out of use.

⚠️ **A status change, not a delete.** Batches, movements, dispenses and invoice
lines all point at this row — a product that vanished would take the history of
everything ever done with it. It moves to \`WITHDRAWN\`, stops being orderable
and dispensable, and stays attached to everything that cites it.

A product with stock on hand is \`409\`: write it off or transfer it first.
`.trim(),
    errors: [403, 409],
    params: { productId: PRODUCT_NOTE },
  },
};
