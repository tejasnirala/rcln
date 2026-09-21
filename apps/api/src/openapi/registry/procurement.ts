/**
 * Procurement — how stock enters the system, and where cost comes from.
 *
 * The flow is requisition → purchase order → goods receipt → (return), and
 * **only the goods receipt moves stock**. Everything before it is paperwork.
 *
 * ⚠️ THE APPROVAL SPLIT IS A SEGREGATION-OF-DUTY CONTROL, AND THE PERMISSION
 *   CODE IS ONLY ITS FIRST LAYER. Holding `procurement.requisition.approve` does
 *   not let anybody approve their OWN requisition: the service refuses it and a
 *   `purchase_requisitions_approver_is_not_creator` CHECK refuses it again. A
 *   clinic may grant both codes to one person — a single-doctor clinic has
 *   nobody else — and that person still cannot self-approve a document.
 *
 * ⚠️ THAT GUARDS THE INTERNAL **ASK** ONLY, NOT THE MONEY. `pharmacy.purchase_order
 *   .manage` predates the split, so whoever holds it can raise AND issue a
 *   purchase order with no requisition and nobody's second signature, then
 *   receive against it. `PHARMACIST` holds it. "Enforced three times" describes
 *   the requisition and must not be read as covering the order.
 *
 * ⚠️ READING THE SUPPLIER LIST SITS BEHIND `pharmacy.supplier.manage`, which is
 *   the opposite call from the inventory router's. There is no
 *   `pharmacy.supplier.read` in the catalogue, and inventing one now would be a
 *   code no existing clinic holds — every supplier picker would come back empty
 *   for everybody until each clinic re-granted it. The shape to aim at is the
 *   inventory one; this is recorded as a known issue rather than defended.
 *
 * ⚠️ NO PHI, AND IT IS WORTH STATING BECAUSE ONE PATH COMES CLOSE. A goods
 *   receipt creates serials and a purchase return refuses one already issued to a
 *   patient — neither ever returns the assigned patient, and the refusal message
 *   deliberately does not name them.
 */
import {
  goodsReceiptDetail,
  goodsReceiptListResponse,
  purchaseOrderDetail,
  purchaseOrderListResponse,
  purchaseRequisitionDetail,
  purchaseRequisitionListResponse,
  purchaseReturnDetail,
  purchaseReturnListResponse,
  supplierDetail,
  supplierListResponse,
  supplierProductListResponse,
  supplierProductSummary,
} from '@rcln/contracts';
import type { DocRegistry } from '../types.js';
import {
  BATCH,
  BATCH_ID,
  BRANCH_ID,
  GOODS_RECEIPT_ID,
  GRN_LINE_ID,
  LOCATION_ID,
  PO_LINE_ID,
  PRODUCT,
  PRODUCT_ID,
  PURCHASE_ORDER_ID,
  PURCHASE_ORDER_NUMBER,
  PURCHASE_RETURN_ID,
  PURCHASE_RETURN_LINE_ID,
  REQUISITION_ID,
  SUPPLIER,
  SUPPLIER_ID,
  SUPPLIER_PRODUCT_ID,
  SUPPLIER_TAX_ID,
  UNIT_STRIP_ID,
} from './fixtures.js';

const BRANCH_404 = 'A branch the caller may not act on is answered `404`, never `403`.';
const DRAFT_ONLY =
  'Only while `DRAFT`. Once the document has moved on, editing it would rewrite what was agreed.';
const QUANTITY_BASIS =
  'Each line gives its quantity **one way only** — a base quantity, a unit, or a packaging level. A line that names two has two answers.';

const SUPPLIER_SUMMARY = {
  id: SUPPLIER_ID,
  code: SUPPLIER.code,
  name: SUPPLIER.name,
  legalName: 'MedSource Distributors Pvt Ltd',
  status: 'ACTIVE',
  contactPerson: 'Rajesh Iyer',
  email: SUPPLIER.email,
  phone: SUPPLIER.phone,
  city: 'Bengaluru',
  countryCode: 'IN',
  regionCode: 'KA',
  defaultCurrency: 'INR',
  paymentTermsDays: 30,
  leadTimeDays: 3,
  isActive: true,
};

const SUPPLIER_PRODUCT = {
  id: SUPPLIER_PRODUCT_ID,
  supplierId: SUPPLIER_ID,
  supplierName: SUPPLIER.name,
  productId: PRODUCT_ID,
  productName: PRODUCT.name,
  supplierSku: 'MS-AMOX500-10',
  supplierProductName: 'Amoxicillin 500mg (10s)',
  packUnitId: UNIT_STRIP_ID,
  quantityPerPack: '10',
  pricePerPackMinor: 14000,
  currency: 'INR',
  priceEffectiveFrom: '2026-01-01',
  priceEffectiveTo: null,
  leadTimeDays: 3,
  minimumOrderPacks: '10',
  isPreferred: true,
  isActive: true,
};

const REQUISITION = {
  id: REQUISITION_ID,
  requisitionNumber: 'REQ-2026-000315',
  branchId: BRANCH_ID,
  status: 'DRAFT',
  requiredBy: '2026-03-24',
  notes: null,
  createdBy: null,
  approvedBy: null,
  approvedAt: null,
  rejectedReason: null,
  lineCount: 1,
};

const PURCHASE_ORDER = {
  id: PURCHASE_ORDER_ID,
  purchaseOrderNumber: PURCHASE_ORDER_NUMBER,
  branchId: BRANCH_ID,
  supplierId: SUPPLIER_ID,
  supplierName: SUPPLIER.name,
  requisitionId: REQUISITION_ID,
  status: 'DRAFT',
  currency: 'INR',
  expectedDate: '2026-03-20',
  deliverToLocationId: LOCATION_ID,
  subtotalMinor: 140000,
  taxMinor: 16800,
  totalMinor: 156800,
  issuedAt: null,
  lineCount: 1,
};

const GOODS_RECEIPT = {
  id: GOODS_RECEIPT_ID,
  goodsReceiptNumber: 'GRN-2026-000589',
  branchId: BRANCH_ID,
  supplierId: SUPPLIER_ID,
  supplierName: SUPPLIER.name,
  purchaseOrderId: PURCHASE_ORDER_ID,
  locationId: LOCATION_ID,
  status: 'DRAFT',
  qualityStatus: 'PENDING',
  receivedAt: '2026-03-20T05:00:00.000Z',
  currency: 'INR',
  supplierInvoiceNumber: 'MS/26/4471',
  supplierInvoiceDate: '2026-03-19',
  freightMinor: 5000,
  dutyMinor: 0,
  handlingMinor: 0,
  totalMinor: 161800,
  lineCount: 1,
};

const PURCHASE_RETURN = {
  id: PURCHASE_RETURN_ID,
  purchaseReturnNumber: 'PRT-2026-000041',
  branchId: BRANCH_ID,
  supplierId: SUPPLIER_ID,
  supplierName: SUPPLIER.name,
  goodsReceiptId: GOODS_RECEIPT_ID,
  locationId: LOCATION_ID,
  status: 'DRAFT',
  currency: 'INR',
  reason: 'Short-dated stock, rejected on inspection',
  supplierCreditNoteNumber: null,
  totalMinor: 14000,
  sentAt: null,
  lineCount: 1,
};

export const procurementDocs: DocRegistry = {
  'GET /api/v1/procurement/suppliers': {
    summary: 'List suppliers',
    description:
      'Who the clinic buys from. Behind `pharmacy.supplier.manage` rather than a read code — there is no `pharmacy.supplier.read`, and inventing one would empty every supplier picker until each clinic re-granted it.',
    response: supplierListResponse,
    paginated: true,
    params: {
      search: 'Free-text match on name and code.',
      status: 'Filter by `ACTIVE`, `ON_HOLD` or `BLACKLISTED`.',
      page: 'Page number, from 1.',
      pageSize: 'Rows per page.',
    },
    responseExamples: [
      {
        summary: 'One supplier',
        value: {
          success: true,
          message: 'Success',
          data: { suppliers: [SUPPLIER_SUMMARY], total: 1, page: 1, pageSize: 25 },
        },
      },
    ],
  },

  'GET /api/v1/procurement/suppliers/{supplierId}': {
    summary: 'Get a supplier',
    description:
      'One supplier with their addresses, terms and tax registrations. `status: BLACKLISTED` does not delete anything — it stops new orders while leaving every historic document intact.',
    response: supplierDetail,
    params: { supplierId: 'The supplier, as `GET /api/v1/procurement/suppliers` lists it.' },
    responseExamples: [
      {
        summary: 'With a GSTIN',
        value: {
          success: true,
          message: 'Success',
          data: {
            ...SUPPLIER_SUMMARY,
            addressLine1: '14, Industrial Layout',
            taxIdentifiers: [
              {
                id: SUPPLIER_TAX_ID,
                countryCode: 'IN',
                regionCode: 'KA',
                scheme: 'GSTIN',
                registrationNumber: SUPPLIER.gstin,
                legalName: 'MedSource Distributors Pvt Ltd',
                effectiveFrom: '2020-04-01',
                effectiveTo: null,
              },
            ],
          },
        },
      },
    ],
  },

  'POST /api/v1/procurement/suppliers': {
    summary: 'Create a supplier',
    description:
      'Add a supplier. `code` is unique within this clinic. `paymentTermsDays` and `leadTimeDays` are defaults that a purchase order inherits and may override. Tax registrations are added separately.',
    response: supplierDetail,
    status: 201,
    errors: [409],
    requestExamples: [
      {
        summary: 'A distributor on 30-day terms',
        value: {
          code: SUPPLIER.code,
          name: SUPPLIER.name,
          legalName: 'MedSource Distributors Pvt Ltd',
          contactPerson: 'Rajesh Iyer',
          email: SUPPLIER.email,
          phone: SUPPLIER.phone,
          city: 'Bengaluru',
          countryCode: 'IN',
          regionCode: 'KA',
          defaultCurrency: 'INR',
          paymentTermsDays: 30,
          leadTimeDays: 3,
        },
      },
    ],
    responseExamples: [
      { summary: 'Created', value: { success: true, message: 'Success', data: SUPPLIER_SUMMARY } },
    ],
  },

  'PATCH /api/v1/procurement/suppliers/{supplierId}': {
    summary: 'Update a supplier',
    description:
      "Correct a supplier's details or change their status. **`code` is not editable.** Setting `BLACKLISTED` blocks new orders and leaves history untouched.",
    response: supplierDetail,
    errors: [409],
    params: { supplierId: 'The supplier.' },
    requestExamples: [
      { summary: 'Put them on hold', value: { status: 'ON_HOLD' } },
      {
        summary: 'New contact',
        value: { contactPerson: 'Sunita Rao', email: 'sunita@medsource.in' },
      },
    ],
  },

  'DELETE /api/v1/procurement/suppliers/{supplierId}': {
    summary: 'Delete a supplier',
    description:
      '**A supplier with any purchase order, receipt or return against them cannot be deleted** — `409`. Those documents are the cost history of stock the clinic still holds. Blacklist them instead; that is what the status is for.',
    errors: [409],
    params: { supplierId: 'The supplier.' },
  },

  'POST /api/v1/procurement/suppliers/{supplierId}/tax-identifiers': {
    summary: 'Add a supplier tax registration',
    description: `
Record a supplier's GSTIN, VAT number or equivalent, per jurisdiction and
effective period.

⚠️ **Never read on their own, and nothing prices anything from them.** A
supplier's GSTIN is only ever wanted beside the supplier, which is why these have
no top-level router. \`@rcln/tax\` prices **sales** and never sees these.

Each write returns the whole supplier, so a screen showing the list already has
the list.
`.trim(),
    response: supplierDetail,
    status: 201,
    errors: [409],
    params: { supplierId: 'The supplier.' },
    requestExamples: [
      {
        summary: 'An Indian GSTIN',
        value: {
          countryCode: 'IN',
          regionCode: 'KA',
          scheme: 'GSTIN',
          registrationNumber: SUPPLIER.gstin,
          effectiveFrom: '2020-04-01',
        },
      },
    ],
  },

  'PATCH /api/v1/procurement/suppliers/{supplierId}/tax-identifiers/{identifierId}': {
    summary: 'Update a supplier tax registration',
    description:
      'Correct the legal name or the effective dates. **`registrationNumber` and `scheme` are not editable** — a different number is a different registration, and documents already cite this one. Returns the whole supplier.',
    response: supplierDetail,
    errors: [409],
    params: {
      supplierId: 'The supplier.',
      identifierId: "The registration, from the supplier's `taxIdentifiers[]`.",
    },
    requestExamples: [{ summary: 'Close it off', value: { effectiveTo: '2026-03-31' } }],
  },

  'DELETE /api/v1/procurement/suppliers/{supplierId}/tax-identifiers/{identifierId}': {
    summary: 'Remove a supplier tax registration',
    description:
      'Delete a registration entered in error. One that was in force when a document was raised should be **closed off with `effectiveTo`** instead — deleting it makes the paperwork of the day unexplainable.',
    response: supplierDetail,
    errors: [409],
    params: {
      supplierId: 'The supplier.',
      identifierId: "The registration, from the supplier's `taxIdentifiers[]`.",
    },
  },

  'POST /api/v1/procurement/suppliers/{supplierId}/products': {
    summary: 'Add a product to a supplier price book',
    description: `
Record that this supplier sells this product, at this price, in this pack.

**The translation layer between two catalogues.** \`supplierSku\` is *their*
code and \`quantityPerPack\` is how their pack maps onto your base unit — a box
of 10 strips of 10 capsules is \`quantityPerPack: "100"\` against a capsule base.
Without it, "order 5 boxes" cannot become a stock quantity.

\`pricePerPackMinor\` is in **minor units** and effective-dated, so a price rise
is a new row rather than an edit: orders already raised recorded the price that
applied on the day.

\`isPreferred\` marks the default source when several suppliers carry the same
product.
`.trim(),
    response: supplierProductSummary,
    status: 201,
    errors: [409],
    params: { supplierId: 'The supplier.' },
    requestExamples: [
      {
        summary: 'A strip of 10 at ₹140',
        value: {
          productId: PRODUCT_ID,
          supplierSku: 'MS-AMOX500-10',
          supplierProductName: 'Amoxicillin 500mg (10s)',
          packUnitId: UNIT_STRIP_ID,
          quantityPerPack: '10',
          pricePerPackMinor: 14000,
          currency: 'INR',
          priceEffectiveFrom: '2026-01-01',
          minimumOrderPacks: '10',
          isPreferred: true,
        },
      },
    ],
    responseExamples: [
      { summary: 'Added', value: { success: true, message: 'Success', data: SUPPLIER_PRODUCT } },
    ],
  },

  'GET /api/v1/procurement/supplier-products': {
    summary: 'Search the price book across suppliers',
    description: `
Who sells a product, and for how much.

⚠️ **Two shapes because there are two questions.** "What does MedSource sell us"
is a supplier's page; "who sells amoxicillin, and for how much" is the question a
buyer asks starting from a **product** — and answering it otherwise means fanning
out one request per supplier. This endpoint takes \`productId\` for exactly that.
`.trim(),
    response: supplierProductListResponse,
    paginated: true,
    params: {
      productId: 'Find every supplier carrying this product.',
      supplierId: 'Narrow to one supplier.',
      isPreferred: 'Only preferred sources.',
      includeInactive: 'Include withdrawn price-book entries.',
      page: 'Page number, from 1.',
      pageSize: 'Rows per page.',
    },
    responseExamples: [
      {
        summary: 'One supplier for this product',
        value: {
          success: true,
          message: 'Success',
          data: { supplierProducts: [SUPPLIER_PRODUCT], total: 1, page: 1, pageSize: 25 },
        },
      },
    ],
  },

  'PATCH /api/v1/procurement/supplier-products/{supplierProductId}': {
    summary: 'Update a price book entry',
    description:
      'Change a pack size, price, lead time or preference. **`productId` and `supplierSku` are not editable** — a different SKU is a different entry. A price change should normally close the old row with `priceEffectiveTo` and add a new one, so historic orders stay explainable.',
    response: supplierProductSummary,
    errors: [409],
    params: {
      supplierProductId:
        'The price-book entry, as `GET /api/v1/procurement/supplier-products` lists it.',
    },
    requestExamples: [
      { summary: 'Make it the preferred source', value: { isPreferred: true } },
      { summary: 'Close the price off', value: { priceEffectiveTo: '2026-03-31' } },
    ],
  },

  'DELETE /api/v1/procurement/supplier-products/{supplierProductId}': {
    summary: 'Delete a price book entry',
    description:
      'Remove an entry added in error. One cited by an existing order is `409` — deactivate it instead.',
    errors: [409],
    params: { supplierProductId: 'The price-book entry.' },
  },

  'GET /api/v1/procurement/requisitions': {
    summary: 'List requisitions',
    description: `
Internal requests to buy — what a branch has asked for, and where each ask has
got to.

⚠️ **Reading is behind \`procurement.requisition.create\` and NOT \`.approve\`,
and either alone would be wrong.** A storekeeper has to see what they asked for;
an approver has to see what they are approving. \`authorize()\` has no "any of
these" form, so reads sit behind the **wider** of the two — the one every
participant in the flow holds — and the approval *actions* are gated separately.
`.trim(),
    response: purchaseRequisitionListResponse,
    paginated: true,
    params: {
      branchId: 'Narrow to one branch.',
      status: 'Filter by requisition status.',
      page: 'Page number, from 1.',
      pageSize: 'Rows per page.',
    },
    responseExamples: [
      {
        summary: 'One draft',
        value: {
          success: true,
          message: 'Success',
          data: { requisitions: [REQUISITION], total: 1, page: 1, pageSize: 25 },
        },
      },
    ],
  },

  'GET /api/v1/procurement/requisitions/{requisitionId}': {
    summary: 'Get a requisition',
    description: 'One internal request with every line and the approval trail behind it.',
    response: purchaseRequisitionDetail,
    params: { requisitionId: `The requisition. ${BRANCH_404}` },
    responseExamples: [
      {
        summary: 'A draft with one line',
        value: {
          success: true,
          message: 'Success',
          data: {
            ...REQUISITION,
            lines: [
              {
                id: PO_LINE_ID,
                productId: PRODUCT_ID,
                productName: PRODUCT.name,
                quantityBase: '1000',
                suggestedSupplierId: SUPPLIER_ID,
                notes: null,
              },
            ],
          },
        },
      },
    ],
  },

  'POST /api/v1/procurement/requisitions': {
    summary: 'Create a requisition',
    description: `
Raise an internal request to buy.

**Paperwork only** — nothing is ordered and no stock moves. It becomes an order
when somebody raises one against it.

${QUANTITY_BASIS}

\`suggestedSupplierId\` is a hint from whoever is asking, not a commitment; the
buyer decides.
`.trim(),
    response: purchaseRequisitionDetail,
    status: 201,
    errors: [409],
    requestExamples: [
      {
        summary: 'Ask for 1000 capsules',
        value: {
          branchId: BRANCH_ID,
          requiredBy: '2026-03-24',
          lines: [
            { productId: PRODUCT_ID, quantityBase: '1000', suggestedSupplierId: SUPPLIER_ID },
          ],
        },
      },
    ],
  },

  'PATCH /api/v1/procurement/requisitions/{requisitionId}': {
    summary: 'Update a requisition',
    description: `${DRAFT_ONLY} Sending \`lines\` replaces the whole set.`,
    response: purchaseRequisitionDetail,
    errors: [409],
    params: { requisitionId: `The requisition. ${BRANCH_404}` },
    requestExamples: [
      { summary: 'Move the required-by date', value: { requiredBy: '2026-03-27' } },
    ],
  },

  'POST /api/v1/procurement/requisitions/{requisitionId}/submit': {
    summary: 'Submit a requisition',
    description:
      'Send the request for approval. It becomes `SUBMITTED` and can no longer be edited — an approver must be looking at what they will approve.',
    response: purchaseRequisitionDetail,
    errors: [409],
    params: { requisitionId: `The requisition. ${BRANCH_404}` },
  },

  'POST /api/v1/procurement/requisitions/{requisitionId}/approve': {
    summary: 'Approve a requisition',
    description: `
Approve an internal request so an order can be raised against it.

⚠️ **YOU CANNOT APPROVE YOUR OWN REQUISITION, AND THE PERMISSION CODE IS ONLY THE
FIRST OF THREE LAYERS.** The service refuses self-approval, and a
\`purchase_requisitions_approver_is_not_creator\` CHECK refuses it again at the
database. A clinic may grant \`.create\` and \`.approve\` to the same person — a
single-doctor clinic has nobody else — and that person still cannot self-approve
a document.

⚠️ **This guards the internal ASK, not the money.** Whoever holds
\`pharmacy.purchase_order.manage\` can raise and issue a purchase order with no
requisition and nobody's second signature. Do not read the three-layer guarantee
as covering the order.
`.trim(),
    response: purchaseRequisitionDetail,
    errors: [403, 409],
    params: { requisitionId: `The requisition. ${BRANCH_404}` },
    responseExamples: [
      {
        summary: 'Approved',
        value: {
          success: true,
          message: 'Success',
          data: { ...REQUISITION, status: 'APPROVED', approvedAt: '2026-03-18T04:00:00.000Z' },
        },
      },
    ],
  },

  'POST /api/v1/procurement/requisitions/{requisitionId}/reject': {
    summary: 'Reject a requisition',
    description:
      'Turn a request down. `reason` is required and is what the requester sees. Same self-approval prohibition as approving — you cannot reject your own either.',
    response: purchaseRequisitionDetail,
    errors: [403, 409],
    params: { requisitionId: `The requisition. ${BRANCH_404}` },
    requestExamples: [
      {
        summary: 'Too much',
        value: { reason: 'Six months of stock; reduce to 300 and resubmit.' },
      },
    ],
  },

  'POST /api/v1/procurement/requisitions/{requisitionId}/cancel': {
    summary: 'Cancel a requisition',
    description:
      'Withdraw a request. Available to whoever raised it, before it is turned into an order.',
    response: purchaseRequisitionDetail,
    errors: [409],
    params: { requisitionId: `The requisition. ${BRANCH_404}` },
  },

  'GET /api/v1/procurement/purchase-orders': {
    summary: 'List purchase orders',
    description:
      'What has been ordered from whom, and where each order stands. `DRAFT` has not been sent; `ISSUED` is with the supplier.',
    response: purchaseOrderListResponse,
    paginated: true,
    params: {
      branchId: 'Narrow to one branch.',
      supplierId: 'Narrow to one supplier.',
      status: 'Filter by order status.',
      page: 'Page number, from 1.',
      pageSize: 'Rows per page.',
    },
    responseExamples: [
      {
        summary: 'One draft order',
        value: {
          success: true,
          message: 'Success',
          data: { purchaseOrders: [PURCHASE_ORDER], total: 1, page: 1, pageSize: 25 },
        },
      },
    ],
  },

  'GET /api/v1/procurement/purchase-orders/{purchaseOrderId}': {
    summary: 'Get a purchase order',
    description:
      'One order with every line, its pricing and how much of it has been received. Amounts are in minor units.',
    response: purchaseOrderDetail,
    params: { purchaseOrderId: `The order. ${BRANCH_404}` },
    responseExamples: [
      {
        summary: 'A draft with one line',
        value: {
          success: true,
          message: 'Success',
          data: {
            ...PURCHASE_ORDER,
            terms: null,
            lines: [
              {
                id: PO_LINE_ID,
                productId: PRODUCT_ID,
                productName: PRODUCT.name,
                supplierProductId: SUPPLIER_PRODUCT_ID,
                quantityBase: '1000',
                pricePerPackMinor: 14000,
                packQuantityBase: '10',
                unitCostBase: 1400,
                taxRateBps: 1200,
                taxAmountMinor: 16800,
                quantityReceivedBase: '0',
              },
            ],
          },
        },
      },
    ],
  },

  'POST /api/v1/procurement/purchase-orders': {
    summary: 'Create a purchase order',
    description: `
Raise an order against a supplier.

**Still paperwork** — nothing is committed until it is issued, and no stock moves
until a receipt is posted.

\`requisitionId\` links it to the internal request it satisfies. It is
**optional**, and that is the gap worth knowing about: whoever holds
\`pharmacy.purchase_order.manage\` can raise an order with no requisition behind
it at all.

${QUANTITY_BASIS}

**A price per pack needs the pack size beside it** — half of it is a price per
nothing, and the contract refuses one without the other.
`.trim(),
    response: purchaseOrderDetail,
    status: 201,
    errors: [409],
    requestExamples: [
      {
        summary: 'Against an approved requisition',
        value: {
          branchId: BRANCH_ID,
          supplierId: SUPPLIER_ID,
          requisitionId: REQUISITION_ID,
          currency: 'INR',
          expectedDate: '2026-03-20',
          deliverToLocationId: LOCATION_ID,
          lines: [
            {
              productId: PRODUCT_ID,
              supplierProductId: SUPPLIER_PRODUCT_ID,
              quantityBase: '1000',
              pricePerPackMinor: 14000,
              packQuantityBase: '10',
              taxRateBps: 1200,
            },
          ],
        },
      },
    ],
    responseExamples: [
      { summary: 'Drafted', value: { success: true, message: 'Success', data: PURCHASE_ORDER } },
    ],
  },

  'PATCH /api/v1/procurement/purchase-orders/{purchaseOrderId}': {
    summary: 'Update a purchase order',
    description: `${DRAFT_ONLY} Sending \`lines\` replaces the whole set.`,
    response: purchaseOrderDetail,
    errors: [409],
    params: { purchaseOrderId: `The order. ${BRANCH_404}` },
    requestExamples: [
      { summary: 'Change the delivery date', value: { expectedDate: '2026-03-23' } },
    ],
  },

  'POST /api/v1/procurement/purchase-orders/{purchaseOrderId}/issue': {
    summary: 'Issue a purchase order',
    description:
      'Send the order to the supplier. It becomes `ISSUED` and its lines and pricing are frozen — what was agreed is what a receipt is matched against. Still moves no stock.',
    response: purchaseOrderDetail,
    errors: [409],
    params: { purchaseOrderId: `The order. ${BRANCH_404}` },
    responseExamples: [
      {
        summary: 'Issued',
        value: {
          success: true,
          message: 'Success',
          data: { ...PURCHASE_ORDER, status: 'ISSUED', issuedAt: '2026-03-18T05:30:00.000Z' },
        },
      },
    ],
  },

  'POST /api/v1/procurement/purchase-orders/{purchaseOrderId}/close': {
    summary: 'Close a purchase order',
    description:
      'Finish an order that will not be fully received — the supplier short-shipped and will not send the rest. `reason` is required, and the shortfall stays visible rather than being written off silently.',
    response: purchaseOrderDetail,
    errors: [409],
    params: { purchaseOrderId: `The order. ${BRANCH_404}` },
    requestExamples: [
      {
        summary: 'Short-shipped',
        value: { reason: 'Supplier discontinued the line; balance will not ship.' },
      },
    ],
  },

  'POST /api/v1/procurement/purchase-orders/{purchaseOrderId}/cancel': {
    summary: 'Cancel a purchase order',
    description:
      '**An order with any receipt against it cannot be cancelled** — stock has arrived, and the paperwork has to keep explaining it. Close it instead.',
    response: purchaseOrderDetail,
    errors: [409],
    params: { purchaseOrderId: `The order. ${BRANCH_404}` },
    requestExamples: [{ summary: 'No longer needed', value: { reason: 'Ordered in error' } }],
  },

  'GET /api/v1/procurement/goods-receipts': {
    summary: 'List goods receipts',
    description:
      'What has arrived. `DRAFT` has been keyed but not posted — **only posting moves stock**.',
    response: goodsReceiptListResponse,
    paginated: true,
    params: {
      branchId: 'Narrow to one branch.',
      supplierId: 'Narrow to one supplier.',
      purchaseOrderId: 'Narrow to receipts against one order.',
      status: 'Filter by receipt status.',
      page: 'Page number, from 1.',
      pageSize: 'Rows per page.',
    },
    responseExamples: [
      {
        summary: 'One draft receipt',
        value: {
          success: true,
          message: 'Success',
          data: { goodsReceipts: [GOODS_RECEIPT], total: 1, page: 1, pageSize: 25 },
        },
      },
    ],
  },

  'GET /api/v1/procurement/goods-receipts/{goodsReceiptId}': {
    summary: 'Get a goods receipt',
    description:
      'One delivery with every line, its lot and serial details, its landed cost and the inspection outcome.',
    response: goodsReceiptDetail,
    params: { goodsReceiptId: `The receipt. ${BRANCH_404}` },
    responseExamples: [
      {
        summary: 'A draft with one lot',
        value: {
          success: true,
          message: 'Success',
          data: {
            ...GOODS_RECEIPT,
            notes: null,
            lines: [
              {
                id: GRN_LINE_ID,
                productId: PRODUCT_ID,
                productName: PRODUCT.name,
                purchaseOrderLineId: PO_LINE_ID,
                quantityBase: '1000',
                lotNumber: BATCH.batchNumber,
                manufacturedOn: BATCH.manufacturedOn,
                expiresOn: BATCH.expiresOn,
                serialNumber: null,
                pricePerPackMinor: 14000,
                packQuantityBase: '10',
                unitCostBase: 1400,
                taxRateBps: 1200,
                qualityOutcome: null,
                rejectedQuantityBase: null,
              },
            ],
          },
        },
      },
    ],
  },

  'POST /api/v1/procurement/goods-receipts': {
    summary: 'Create a goods receipt',
    description: `
Key in a delivery.

**Creating one moves nothing** — it is a draft until posted, which is what lets
it be corrected against the physical boxes before anything hits the ledger.

\`lotNumber\` and \`expiresOn\` per line are what create the batches;
\`serialNumber\` creates a serial. A product that is batch-tracked must arrive
with a lot number.

\`freightMinor\`, \`dutyMinor\` and \`handlingMinor\` are **landed costs**,
apportioned across the lines when the receipt is posted — which is why the cost
of a batch is not simply its invoice price.

\`purchaseOrderId\` is optional: stock does arrive without an order.
`.trim(),
    response: goodsReceiptDetail,
    status: 201,
    errors: [409],
    requestExamples: [
      {
        summary: 'A delivery against an order',
        value: {
          branchId: BRANCH_ID,
          supplierId: SUPPLIER_ID,
          purchaseOrderId: PURCHASE_ORDER_ID,
          locationId: LOCATION_ID,
          supplierInvoiceNumber: 'MS/26/4471',
          supplierInvoiceDate: '2026-03-19',
          freightMinor: 5000,
          lines: [
            {
              productId: PRODUCT_ID,
              purchaseOrderLineId: PO_LINE_ID,
              quantityBase: '1000',
              lotNumber: BATCH.batchNumber,
              manufacturedOn: BATCH.manufacturedOn,
              expiresOn: BATCH.expiresOn,
              pricePerPackMinor: 14000,
              packQuantityBase: '10',
              taxRateBps: 1200,
            },
          ],
        },
      },
    ],
    responseExamples: [
      { summary: 'Drafted', value: { success: true, message: 'Success', data: GOODS_RECEIPT } },
    ],
  },

  'PATCH /api/v1/procurement/goods-receipts/{goodsReceiptId}': {
    summary: 'Update a goods receipt',
    description: `${DRAFT_ONLY} Once posted, stock exists and the ledger cannot be edited — correct it with a movement or a purchase return.`,
    response: goodsReceiptDetail,
    errors: [409],
    params: { goodsReceiptId: `The receipt. ${BRANCH_404}` },
    requestExamples: [{ summary: 'Add freight', value: { freightMinor: 7500 } }],
  },

  'POST /api/v1/procurement/goods-receipts/{goodsReceiptId}/post': {
    summary: 'Post a goods receipt',
    description: `
Book the delivery in. **This is the moment stock exists.**

⚠️ **THE ONE ENDPOINT ON THIS ROUTER THAT WRITES THE STOCK LEDGER, and it writes
every leg, every lot row, every serial and the cost roll-up in ONE
TRANSACTION.** Everything before it is paperwork. Either the whole delivery lands
or none of it does — a receipt that half-posted would leave batches with no
quantity and a cost average built on a lie.

Landed costs are apportioned across the lines here, which is what sets each
batch's true unit cost.

Posting is irreversible: correcting a posted receipt is a stock movement or a
purchase return, never an edit.
`.trim(),
    response: goodsReceiptDetail,
    errors: [409, 422],
    params: { goodsReceiptId: `The receipt. ${BRANCH_404}` },
    responseExamples: [
      {
        summary: 'Posted',
        value: {
          success: true,
          message: 'Success',
          data: { ...GOODS_RECEIPT, status: 'POSTED' },
        },
      },
    ],
  },

  'POST /api/v1/procurement/goods-receipts/{goodsReceiptId}/quality': {
    summary: 'Record an inspection outcome',
    description: `
Accept or reject what arrived, line by line.

**Each line may appear only once** — two decisions on one line have two readings
and neither should be guessed.

A rejection with a \`rejectedQuantityBase\` is a partial: some of the line was
good. Rejected quantity is what a purchase return is then raised against.

This records a judgement; it does not move stock on its own.
`.trim(),
    response: goodsReceiptDetail,
    errors: [409],
    params: { goodsReceiptId: `The receipt. ${BRANCH_404}` },
    requestExamples: [
      {
        summary: 'All good',
        value: { lines: [{ lineId: GRN_LINE_ID, outcome: 'ACCEPTED' }] },
      },
      {
        summary: 'Part of a line rejected',
        value: {
          lines: [
            {
              lineId: GRN_LINE_ID,
              outcome: 'REJECTED',
              rejectedQuantityBase: '100',
              notes: 'Short-dated — under six months remaining',
            },
          ],
        },
      },
    ],
  },

  'POST /api/v1/procurement/goods-receipts/{goodsReceiptId}/cancel': {
    summary: 'Cancel a goods receipt',
    description:
      '**Only while `DRAFT`.** A posted receipt has moved stock; undoing it means a movement or a purchase return, so that the ledger keeps saying what actually happened.',
    response: goodsReceiptDetail,
    errors: [409],
    params: { goodsReceiptId: `The receipt. ${BRANCH_404}` },
    requestExamples: [
      { summary: 'Keyed twice', value: { reason: 'Duplicate of GRN-2026-000588' } },
    ],
  },

  'GET /api/v1/procurement/returns': {
    summary: 'List purchase returns',
    description: 'Stock going back to suppliers, and where each return stands.',
    response: purchaseReturnListResponse,
    paginated: true,
    params: {
      branchId: 'Narrow to one branch.',
      supplierId: 'Narrow to one supplier.',
      status: 'Filter by `DRAFT`, `SENT` or `CANCELLED`.',
      page: 'Page number, from 1.',
      pageSize: 'Rows per page.',
    },
    responseExamples: [
      {
        summary: 'One draft return',
        value: {
          success: true,
          message: 'Success',
          data: { purchaseReturns: [PURCHASE_RETURN], total: 1, page: 1, pageSize: 25 },
        },
      },
    ],
  },

  'GET /api/v1/procurement/returns/{purchaseReturnId}': {
    summary: 'Get a purchase return',
    description: 'One return with every line and the supplier credit note against it.',
    response: purchaseReturnDetail,
    params: { purchaseReturnId: `The return. ${BRANCH_404}` },
    responseExamples: [
      {
        summary: 'A draft return',
        value: {
          success: true,
          message: 'Success',
          data: {
            ...PURCHASE_RETURN,
            notes: null,
            lines: [
              {
                id: PURCHASE_RETURN_LINE_ID,
                productId: PRODUCT_ID,
                productName: PRODUCT.name,
                goodsReceiptLineId: GRN_LINE_ID,
                batchId: BATCH_ID,
                serialId: null,
                quantityBase: '100',
                statusFrom: 'QUARANTINE',
                unitCostBase: 1400,
              },
            ],
          },
        },
      },
    ],
  },

  'POST /api/v1/procurement/returns': {
    summary: 'Create a purchase return',
    description: `
Draft a return to a supplier.

\`statusFrom\` per line says **which status bucket the stock is coming out of** —
usually \`QUARANTINE\` for goods rejected on inspection, and it matters because
returning available stock and returning quarantined stock have different effects
on what the shelf reports.

⚠️ **A serial already issued to a patient cannot be returned**, and the refusal
deliberately does not name the patient — this router discloses nobody.

\`reason\` is required. Creating a return moves nothing; sending it does.
`.trim(),
    response: purchaseReturnDetail,
    status: 201,
    errors: [409],
    requestExamples: [
      {
        summary: 'Return rejected stock',
        value: {
          branchId: BRANCH_ID,
          supplierId: SUPPLIER_ID,
          goodsReceiptId: GOODS_RECEIPT_ID,
          locationId: LOCATION_ID,
          reason: 'Short-dated stock, rejected on inspection',
          lines: [
            {
              productId: PRODUCT_ID,
              goodsReceiptLineId: GRN_LINE_ID,
              batchId: BATCH_ID,
              quantityBase: '100',
              statusFrom: 'QUARANTINE',
            },
          ],
        },
      },
    ],
  },

  'PATCH /api/v1/procurement/returns/{purchaseReturnId}': {
    summary: 'Update a purchase return',
    description: `${DRAFT_ONLY} Sending \`lines\` replaces the whole set.`,
    response: purchaseReturnDetail,
    errors: [409],
    params: { purchaseReturnId: `The return. ${BRANCH_404}` },
    requestExamples: [
      { summary: 'Record the credit note', value: { supplierCreditNoteNumber: 'MS/CN/26/112' } },
    ],
  },

  'POST /api/v1/procurement/returns/{purchaseReturnId}/send': {
    summary: 'Send a purchase return',
    description:
      '**This is when the stock leaves.** The ledger is written and the return becomes `SENT`. Irreversible — stock that has physically gone back cannot be un-sent, only received again as a fresh delivery.',
    response: purchaseReturnDetail,
    errors: [409],
    params: { purchaseReturnId: `The return. ${BRANCH_404}` },
    responseExamples: [
      {
        summary: 'Sent',
        value: {
          success: true,
          message: 'Success',
          data: { ...PURCHASE_RETURN, status: 'SENT', sentAt: '2026-03-21T06:00:00.000Z' },
        },
      },
    ],
  },

  'POST /api/v1/procurement/returns/{purchaseReturnId}/cancel': {
    summary: 'Cancel a purchase return',
    description: '**Only while `DRAFT`.** Once sent, the stock has gone and the ledger says so.',
    response: purchaseReturnDetail,
    errors: [409],
    params: { purchaseReturnId: `The return. ${BRANCH_404}` },
    requestExamples: [
      {
        summary: 'Supplier agreed to replace instead',
        value: { reason: 'Supplier sending replacement' },
      },
    ],
  },

  'GET /api/v1/procurement/cost-averages': {
    summary: 'Get product cost averages',
    description: `
What stock is worth — the weighted average unit cost per product per branch,
rolled up as receipts post.

⚠️ **Behind \`inventory.stock.read\` rather than a purchasing code**, and
deliberately. What stock is worth is a **stock** question: it is read on
valuation and stock screens by people who never raise an order, and gating it
behind \`purchase_order.read\` would mean a storekeeper counting a shelf cannot
see what is on it is worth.

The average includes apportioned landed costs, so it is what the stock actually
cost to have — not what the invoice said.
`.trim(),
    params: {
      branchId: 'Narrow to one branch.',
      productId: 'Narrow to one product.',
      page: 'Page number, from 1.',
      pageSize: 'Rows per page.',
    },
    responseExamples: [
      {
        summary: 'One product',
        value: {
          success: true,
          message: 'Success',
          data: {
            costAverages: [
              {
                branchId: BRANCH_ID,
                productId: PRODUCT_ID,
                productName: PRODUCT.name,
                averageUnitCostBase: 1435,
                currency: 'INR',
                quantityOnHandBase: '480',
                totalValueMinor: 688800,
              },
            ],
            total: 1,
            page: 1,
            pageSize: 25,
          },
        },
      },
    ],
  },
};
