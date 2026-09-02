/**
 * Inventory — where stock is and how much of it exists.
 *
 * The other half of the catalogue: `products` says what a thing IS, everything
 * here says where it is and how much.
 *
 * ⚠️ READS ARE ALL BEHIND ONE CODE, `inventory.stock.read`, deliberately — the
 *   same call the catalogue masters make. Every stock screen needs the NAME of
 *   the shelf a thing is on, and gating that behind the permission to CREATE
 *   shelves shows a storekeeper a page of uuids.
 *
 * ⚠️ `inventory.location.manage` IS NOT A NARROWER `inventory.stock.adjust`.
 *   Adjusting stock is a daily operational act; defining that a branch HAS a
 *   controlled cabinet is a configuration decision about how the site is laid
 *   out. Different people, and a very different blast radius — a bad adjustment
 *   is one compensating movement from correct, while a location change moves the
 *   meaning of every balance under it.
 *
 * ⚠️ THE BRANCH IS NEVER TRUSTED FROM THE BODY. Every service asserts the branch
 *   is one the caller may act on and answers `404` — never `403` — when it is
 *   not, because RLS has already made it invisible and a `403` would confirm the
 *   id is real to somebody probing.
 *
 * ⚠️ SERIALS ARE THE ONLY PHI ON THIS ROUTER, through `assignedPatientId` —
 *   "which patient has device 7742". Those handlers record the disclosure.
 *   Nothing else here logs a product name beside a patient id.
 */
import {
  allocationPlanResponse,
  batchDetail,
  batchListResponse,
  batchSummary,
  expiryReportResponse,
  inventoryLocationDetail,
  inventoryLocationListResponse,
  inventoryLocationSummary,
  recordMovementResponse,
  scanResolveResponse,
  serialDetail,
  serialListResponse,
  serialSummary,
  stockBalanceListResponse,
  stockLedgerListResponse,
  stockReasonCodeListResponse,
  stockReasonCodeSummary,
  stockReservationListResponse,
  stockReservationSummary,
  stockTransferDetail,
  stockTransferListResponse,
  verifyBalancesResponse,
} from '@rcln/contracts';
import type { DocRegistry } from '../types.js';
import {
  BATCH,
  BATCH_ID,
  BRANCH_ID,
  BRANCH_KOCHI_ID,
  LOCATION_ID,
  PATIENT_ID,
  PRODUCT,
  PRODUCT_GTIN,
  PRODUCT_ID,
  SCAN_PAYLOAD,
  SCAN_PAYLOAD_BRACKETED,
  REASON_CODE_ID,
  RESERVATION_ID,
  SERIAL_ID,
  STOCK_MOVEMENT_ID,
  STOCK_TRANSFER_ID,
  STORAGE_AREA_ID,
  STORAGE_BIN_ID,
  STORAGE_PROFILE_ID,
  TRANSFER_LINE_ID,
  UNIT_CAPSULE_ID,
} from './fixtures.js';

const BRANCH_404 =
  'A branch the caller may not act on is answered `404`, never `403` — RLS has already made it invisible, and a `403` would confirm the id is real.';

const LOCATION = {
  id: LOCATION_ID,
  branchId: BRANCH_ID,
  kind: 'PHARMACY_STORE',
  code: 'IND-PH-MAIN',
  name: 'Indiranagar pharmacy — main store',
  isDispensingPoint: true,
  requiresControlledAccess: false,
  storageProfileId: STORAGE_PROFILE_ID,
  isActive: true,
};

const BATCH_SUMMARY = {
  id: BATCH_ID,
  branchId: BRANCH_ID,
  productId: PRODUCT_ID,
  productName: PRODUCT.name,
  lotNumber: BATCH.batchNumber,
  manufacturedOn: BATCH.manufacturedOn,
  expiresOn: BATCH.expiresOn,
  status: 'AVAILABLE',
  quantityOnHandBase: '480',
  unitCostBase: 1600,
  currency: 'INR',
};

const SERIAL = {
  id: SERIAL_ID,
  branchId: BRANCH_ID,
  productId: PRODUCT_ID,
  productName: 'Titanium bone plate, 6-hole',
  serialNumber: 'TBP-7742',
  batchId: null,
  status: 'IN_STOCK',
  locationId: LOCATION_ID,
  assignedPatientId: null,
  assignedAt: null,
};

const TRANSFER = {
  id: STOCK_TRANSFER_ID,
  transferNumber: 'TRF-2026-000318',
  status: 'DRAFT',
  fromBranchId: BRANCH_ID,
  toBranchId: BRANCH_KOCHI_ID,
  fromLocationId: LOCATION_ID,
  toLocationId: null,
  notes: null,
  dispatchedAt: null,
  receivedAt: null,
  lineCount: 1,
};

export const inventoryDocs: DocRegistry = {
  'GET /api/v1/inventory-locations': {
    summary: 'List stock locations',
    description:
      'Every shelf, cupboard and store the clinic keeps stock in. `isDispensingPoint` marks the ones a counter can supply from; `requiresControlledAccess` marks the ones behind a lock.',
    response: inventoryLocationListResponse,
    params: {
      branchId: 'Narrow to one branch.',
      kind: 'Filter by location kind.',
      includeInactive: 'Include closed locations. Defaults to `false`.',
    },
    responseExamples: [
      {
        summary: 'One pharmacy store',
        value: { success: true, message: 'Success', data: { locations: [LOCATION] } },
      },
    ],
  },

  'GET /api/v1/inventory-locations/{locationId}': {
    summary: 'Get a stock location',
    description:
      'One location with its storage areas and bins — the physical subdivision inside a store, which is what a put-away instruction names.',
    response: inventoryLocationDetail,
    params: {
      locationId: `The location, as \`GET /api/v1/inventory-locations\` lists it. ${BRANCH_404}`,
    },
    responseExamples: [
      {
        summary: 'A store with one area',
        value: {
          success: true,
          message: 'Success',
          data: {
            ...LOCATION,
            areas: [
              {
                id: STORAGE_AREA_ID,
                code: 'A1',
                name: 'Rack A, shelf 1',
                bins: [{ id: STORAGE_BIN_ID, code: 'A1-01', name: 'Bin 1' }],
              },
            ],
          },
        },
      },
    ],
  },

  'POST /api/v1/inventory-locations': {
    summary: 'Create a stock location',
    description: `
Define a place stock can be.

⚠️ **Behind \`inventory.location.manage\`, not \`inventory.stock.adjust\`.**
Adjusting stock is a daily operational act; deciding that a branch *has* a
controlled cabinet is a configuration decision about how the site is laid out.
A bad adjustment is one compensating movement from correct; a location change
moves the meaning of every balance under it.

\`storageProfileId\` ties the location to a temperature and humidity band, which
is what makes a cold-chain compliance check possible at all.
`.trim(),
    response: inventoryLocationSummary,
    status: 201,
    errors: [409],
    requestExamples: [
      {
        summary: 'A dispensing store',
        value: {
          branchId: BRANCH_ID,
          kind: 'PHARMACY_STORE',
          code: 'IND-PH-MAIN',
          name: 'Indiranagar pharmacy — main store',
          isDispensingPoint: true,
          storageProfileId: STORAGE_PROFILE_ID,
        },
      },
      {
        summary: 'A controlled cabinet',
        value: {
          branchId: BRANCH_ID,
          kind: 'CONTROLLED_CABINET',
          code: 'IND-PH-CD',
          name: 'Controlled drugs cabinet',
          requiresControlledAccess: true,
        },
      },
    ],
    responseExamples: [
      { summary: 'Created', value: { success: true, message: 'Success', data: LOCATION } },
    ],
  },

  'PATCH /api/v1/inventory-locations/{locationId}': {
    summary: 'Update a stock location',
    description:
      'Rename a location, change its kind or storage profile, or close it. **`branchId` and `code` are not editable** — every movement ever recorded points here. Closing a location holding stock is `409`; move it out first.',
    response: inventoryLocationSummary,
    errors: [409],
    params: { locationId: `The location. ${BRANCH_404}` },
    requestExamples: [
      { summary: 'Stop dispensing from it', value: { isDispensingPoint: false } },
      { summary: 'Close it', value: { isActive: false } },
    ],
    responseExamples: [
      { summary: 'Updated', value: { success: true, message: 'Success', data: LOCATION } },
    ],
  },

  'PUT /api/v1/inventory-locations/{locationId}/areas': {
    summary: 'Replace storage areas',
    description:
      'Set the areas and bins inside a location, whole. `PUT` because a shelving layout is only meaningful complete — a bin whose area was dropped is a bin nobody can find. An area or bin holding stock cannot be removed.',
    errors: [409],
    params: { locationId: `The location. ${BRANCH_404}` },
    requestExamples: [
      {
        summary: 'One rack with two bins',
        value: {
          areas: [
            {
              code: 'A1',
              name: 'Rack A, shelf 1',
              bins: [
                { code: 'A1-01', name: 'Bin 1' },
                { code: 'A1-02', name: 'Bin 2' },
              ],
            },
          ],
        },
      },
    ],
  },

  'GET /api/v1/batches': {
    summary: 'List batches',
    description:
      'Manufacturer lots held at a branch, with what is on hand of each. `status` distinguishes stock that is available from stock quarantined, held or recalled — the quantity is the same, what may be done with it is not.',
    response: batchListResponse,
    paginated: true,
    params: {
      branchId: 'Narrow to one branch.',
      productId: 'Narrow to one product.',
      status: 'Filter by batch status.',
      expiringBefore: 'Only batches expiring before this date.',
      page: 'Page number, from 1.',
      pageSize: 'Rows per page.',
    },
    responseExamples: [
      {
        summary: 'One available lot',
        value: {
          success: true,
          message: 'Success',
          data: { batches: [BATCH_SUMMARY], total: 1, page: 1, pageSize: 25 },
        },
      },
    ],
  },

  'GET /api/v1/batches/{batchId}': {
    summary: 'Get a batch',
    description:
      'One lot in full — its dates, its cost, and where its quantity sits across locations and status buckets.',
    response: batchDetail,
    params: { batchId: `The batch, as \`GET /api/v1/batches\` lists it. ${BRANCH_404}` },
    responseExamples: [
      {
        summary: 'A lot in one location',
        value: {
          success: true,
          message: 'Success',
          data: {
            ...BATCH_SUMMARY,
            retestOn: null,
            notes: null,
            balances: [
              {
                locationId: LOCATION_ID,
                status: 'AVAILABLE',
                quantityBase: '480',
              },
            ],
          },
        },
      },
    ],
  },

  'POST /api/v1/batches': {
    summary: 'Create a batch',
    description: `
Record a manufacturer's lot.

**Creating a batch does not create stock.** It declares the lot exists; quantity
arrives through a goods receipt or a movement. That separation is what lets a
batch be registered before its delivery lands.

\`lotNumber\` is the manufacturer's, and it is what a recall notice cites — which
is why it is unique per product per branch rather than globally: two
manufacturers may legitimately use the same string.

\`expiresOn\` requires the product to be batch-tracked; the catalogue refuses
expiry control without it for exactly this reason.
`.trim(),
    response: batchSummary,
    status: 201,
    errors: [409],
    requestExamples: [
      {
        summary: 'A lot with an expiry',
        value: {
          branchId: BRANCH_ID,
          productId: PRODUCT_ID,
          lotNumber: BATCH.batchNumber,
          manufacturedOn: BATCH.manufacturedOn,
          expiresOn: BATCH.expiresOn,
          unitCostBase: 1600,
          currency: 'INR',
        },
      },
    ],
    responseExamples: [
      {
        summary: 'Created',
        value: {
          success: true,
          message: 'Success',
          data: { ...BATCH_SUMMARY, quantityOnHandBase: '0' },
        },
      },
    ],
  },

  'PATCH /api/v1/batches/{batchId}': {
    summary: 'Update a batch',
    description:
      "Correct a lot's dates, cost or notes. **`lotNumber`, `productId` and `branchId` are not editable** — a recall notice cites the lot number, and movements already point at this row. **`status` is not editable here either**: changing it is `POST /{batchId}/hold`, which moves quantity as well as the flag.",
    response: batchSummary,
    errors: [409],
    params: { batchId: `The batch. ${BRANCH_404}` },
    requestExamples: [
      { summary: 'Correct the expiry', value: { expiresOn: '2027-09-30' } },
      { summary: 'Record a retest date', value: { retestOn: '2027-02-28' } },
    ],
    responseExamples: [
      { summary: 'Updated', value: { success: true, message: 'Success', data: BATCH_SUMMARY } },
    ],
  },

  'POST /api/v1/batches/{batchId}/hold': {
    summary: 'Hold or release a batch',
    description: `
Quarantine a lot, or let it go again.

⚠️ **Its own endpoint rather than a field on \`PATCH\`, because it is not a column
edit — it MOVES QUANTITY between status buckets in the same transaction as the
flag.** A batch marked \`QUARANTINED\` whose stock is still in the \`AVAILABLE\`
bucket is **still dispensable**, because allocation reads the balance and not the
batch. The two halves have to commit together or not at all.

This is the endpoint a recall reaches for when it takes a lot off the shelf.
`.trim(),
    response: batchSummary,
    errors: [409],
    params: { batchId: `The batch. ${BRANCH_404}` },
    requestExamples: [
      {
        summary: 'Quarantine it',
        value: { status: 'QUARANTINED', reasonNote: 'Manufacturer notice pending investigation' },
      },
      {
        summary: 'Release it back',
        value: { status: 'AVAILABLE', reasonNote: 'Notice withdrawn' },
      },
    ],
    responseExamples: [
      {
        summary: 'Quarantined',
        value: {
          success: true,
          message: 'Success',
          data: { ...BATCH_SUMMARY, status: 'QUARANTINED' },
        },
      },
    ],
  },

  'GET /api/v1/serials': {
    summary: 'List serials',
    description: `
Individually tracked items — implants, devices, instruments.

⚠️ **PHI when \`assignedPatientId\` is set.** "Which patient has device 7742" is
a disclosure, and reads that could answer it are logged.
`.trim(),
    response: serialListResponse,
    phi: true,
    paginated: true,
    params: {
      branchId: 'Narrow to one branch.',
      productId: 'Narrow to one product.',
      status: 'Filter by serial status.',
      assignedPatientId: 'Narrow to items assigned to one patient.',
      page: 'Page number, from 1.',
      pageSize: 'Rows per page.',
    },
    responseExamples: [
      {
        summary: 'One device in stock',
        value: {
          success: true,
          message: 'Success',
          data: { serials: [SERIAL], total: 1, page: 1, pageSize: 25 },
        },
      },
    ],
  },

  'GET /api/v1/serials/{serialId}': {
    summary: 'Get a serial',
    description:
      'One tracked item, its history and who it was fitted to if anybody. **PHI** when assigned.',
    response: serialDetail,
    phi: true,
    params: { serialId: `The serial, as \`GET /api/v1/serials\` lists it. ${BRANCH_404}` },
    responseExamples: [
      { summary: 'A device in stock', value: { success: true, message: 'Success', data: SERIAL } },
    ],
  },

  'POST /api/v1/serials': {
    summary: 'Create a serial',
    description:
      'Register an individually tracked item. The product must have a tracking mode that includes serials. `serialNumber` is unique per product within the clinic — it is what a recall and a device registry both cite.',
    response: serialSummary,
    status: 201,
    errors: [409],
    requestExamples: [
      {
        summary: 'An implant',
        value: {
          branchId: BRANCH_ID,
          productId: PRODUCT_ID,
          serialNumber: 'TBP-7742',
          locationId: LOCATION_ID,
        },
      },
    ],
    responseExamples: [
      { summary: 'Created', value: { success: true, message: 'Success', data: SERIAL } },
    ],
  },

  'PATCH /api/v1/serials/{serialId}': {
    summary: 'Update a serial',
    description:
      "Correct a tracked item's location, batch or notes. **`serialNumber` and `productId` are not editable.** Assigning it to a patient is `POST /{serialId}/assign`, which is a different claim behind the same code.",
    response: serialSummary,
    errors: [409],
    params: { serialId: `The serial. ${BRANCH_404}` },
    requestExamples: [{ summary: 'Move it to another shelf', value: { locationId: LOCATION_ID } }],
    responseExamples: [
      { summary: 'Updated', value: { success: true, message: 'Success', data: SERIAL } },
    ],
  },

  'POST /api/v1/serials/{serialId}/assign': {
    summary: 'Assign a serial to a patient',
    description: `
Record that this device was fitted to, or issued to, a named person.

⚠️ **Gated by \`inventory.stock.adjust\`, NOT \`patient.update\`.** What changes
is the *device's* disposition, and whoever hands over an implant in theatre is
the storekeeper rather than the person who maintains the demographic record. It
is deliberately not the read code either: **seeing** that a device is fitted and
**deciding** that it is are different claims.

⚠️ **This is the row a device recall is answered from.** It is the link from a
manufacturer's serial to a named patient, so it is PHI and the disclosure is
recorded.
`.trim(),
    response: serialSummary,
    phi: true,
    errors: [409],
    params: { serialId: `The serial. ${BRANCH_404}` },
    requestExamples: [
      {
        summary: 'Fitted in theatre',
        value: { patientId: PATIENT_ID, assignedAt: '2026-03-17T04:00:00.000Z' },
      },
    ],
    responseExamples: [
      {
        summary: 'Assigned',
        value: {
          success: true,
          message: 'Success',
          data: {
            ...SERIAL,
            status: 'ASSIGNED',
            assignedPatientId: PATIENT_ID,
            assignedAt: '2026-03-17T04:00:00.000Z',
          },
        },
      },
    ],
  },

  'GET /api/v1/stock/resolve': {
    summary: 'Resolve a scan',
    description: `
**One scanned string in; the product, the lot and the device it names out.** The
endpoint behind every scanner field in the application.

A modern medicine pack carries a GS1 DataMatrix, not a retail barcode, and its
payload is an *element string* — application identifiers and their values run
together with no separator: \`01\` is a GTIN and takes fourteen digits, \`17\` an
expiry and takes six, \`10\` a lot number and runs to the next FNC1. Send it
**exactly as the reader transmitted it**, symbology prefix and all; do not strip,
split or upper-case anything first.

Both forms are accepted — the encoded payload and the bracketed form printed
underneath it, which is what somebody types when the reader dies. A bare EAN-13,
UPC-A or GTIN-14 is accepted too, as is a clinic's own SKU.

**Every length of the GTIN is searched.** A catalogue typed by hand holds the
thirteen digits printed under the bars; the DataMatrix carries fourteen with a
leading zero. Both resolve to the same product.

**A code that matches nothing is a \`200\`, not a \`404\`.** "This is GTIN X, lot Y,
expiring next August, and you have never stocked it" is the answer a storekeeper
needs — it says the *delivery* is wrong, not the scanner. \`decoded\` always comes
back, whether anything resolved or not.

**\`products\` may hold more than one row, and the caller must not pick.**
Repackagers reuse GTINs and two countries assign one national code to different
medicines. \`isAmbiguous\` says so; the screen asks.

**\`batches[].expiryMatchesScan\` is the field to act on.** The pack says one date
and the lot on file says another: either the wrong lot was picked or the wrong
date was typed at receipt, and this is the only moment anybody is holding both.
\`null\` means the scan carried no date to compare.

**Anything the decoder could not read comes back in \`decoded.unparsed\`,
verbatim, with a warning** — it is never silently skipped, because resuming in the
middle of an unknown identifier's data produces a lot number that looks entirely
plausible and is not the one on the box.

Behind \`inventory.stock.read\` **and** \`product.definition.read\`: it answers a
catalogue question and a stock question in one round trip, and half an answer is
worse than a refusal. Returns **no patient field** — which device is in which
patient is \`GET /api/v1/serials/{serialId}\`, where the disclosure is logged.
`.trim(),
    response: scanResolveResponse,
    params: {
      code: 'The payload, exactly as the reader sent it.',
      branchId: 'Narrow the stock half to one branch. Omitted, every branch in scope is searched.',
      countryCode:
        'Country-qualify the identifier lookup. A national code means different medicines in different countries.',
    },
    responseExamples: [
      {
        summary: 'A DataMatrix on a delivery: product, lot and expiry all resolve',
        value: {
          success: true,
          message: 'Success',
          data: {
            decoded: {
              format: 'GS1',
              raw: SCAN_PAYLOAD,
              gtin: PRODUCT_GTIN,
              lotNumber: BATCH.batchNumber,
              serialNumber: null,
              expiresOn: BATCH.expiresOn,
              producedOn: null,
              quantity: null,
              elements: [
                { ai: '01', label: 'GTIN', value: PRODUCT_GTIN },
                { ai: '17', label: 'Expiry date', value: '270831' },
                { ai: '10', label: 'Lot or batch number', value: BATCH.batchNumber },
              ],
              unparsed: null,
              warnings: [],
            },
            products: [
              {
                productId: PRODUCT_ID,
                productCode: PRODUCT.code,
                productName: PRODUCT.name,
                brandName: null,
                genericName: 'Amoxicillin',
                trackingMode: 'LOT_BATCH',
                isExpiryControlled: true,
                baseUnitSymbol: 'cap',
                matchedOn: { type: 'GTIN', value: PRODUCT_GTIN },
              },
            ],
            batches: [
              {
                id: BATCH_ID,
                branchId: BRANCH_ID,
                branchName: 'Indiranagar',
                productId: PRODUCT_ID,
                productName: PRODUCT.name,
                lotNumber: BATCH.batchNumber,
                expiresOn: BATCH.expiresOn,
                status: 'ACTIVE',
                isDispensable: true,
                quarantinedAt: null,
                recalledAt: null,
                availableQuantityBase: '480',
                quantityOnHandBase: '480',
                baseUnitSymbol: 'cap',
                expiryMatchesScan: true,
              },
            ],
            serials: [],
            isAmbiguous: false,
          },
        },
      },
      {
        summary: 'The bracketed form, typed by hand, for a lot this clinic has never received',
        value: {
          success: true,
          message: 'Success',
          data: {
            decoded: {
              format: 'GS1',
              raw: SCAN_PAYLOAD_BRACKETED,
              gtin: PRODUCT_GTIN,
              lotNumber: BATCH.batchNumber,
              serialNumber: null,
              expiresOn: BATCH.expiresOn,
              producedOn: null,
              quantity: null,
              elements: [
                { ai: '01', label: 'GTIN', value: PRODUCT_GTIN },
                { ai: '17', label: 'Expiry date', value: '270831' },
                { ai: '10', label: 'Lot or batch number', value: BATCH.batchNumber },
              ],
              unparsed: null,
              warnings: [],
            },
            products: [
              {
                productId: PRODUCT_ID,
                productCode: PRODUCT.code,
                productName: PRODUCT.name,
                brandName: null,
                genericName: 'Amoxicillin',
                trackingMode: 'LOT_BATCH',
                isExpiryControlled: true,
                baseUnitSymbol: 'cap',
                matchedOn: { type: 'GTIN', value: PRODUCT_GTIN },
              },
            ],
            batches: [],
            serials: [],
            isAmbiguous: false,
          },
        },
      },
    ],
  },

  'GET /api/v1/stock/balances': {
    summary: 'Get stock balances',
    description: `
What is on hand — by product, location, batch and status bucket.

**Balances are a maintained cache, kept in step by database triggers on the
ledger.** They are not summed on read, which is what makes a stock screen fast on
a clinic with a million movements. \`GET /api/v1/stock/verify\` is how you check
the cache against the ledger.

Quantities are in **base units**, always — a strip is 10 capsules and the ledger
holds capsules.
`.trim(),
    response: stockBalanceListResponse,
    paginated: true,
    params: {
      branchId: 'Narrow to one branch.',
      productId: 'Narrow to one product.',
      locationId: 'Narrow to one location.',
      batchId: 'Narrow to one batch.',
      status: 'Filter by stock status bucket.',
      page: 'Page number, from 1.',
      pageSize: 'Rows per page.',
    },
    responseExamples: [
      {
        summary: 'One product on one shelf',
        value: {
          success: true,
          message: 'Success',
          data: {
            balances: [
              {
                branchId: BRANCH_ID,
                productId: PRODUCT_ID,
                productName: PRODUCT.name,
                locationId: LOCATION_ID,
                locationName: LOCATION.name,
                batchId: BATCH_ID,
                lotNumber: BATCH.batchNumber,
                status: 'AVAILABLE',
                quantityBase: '480',
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

  'GET /api/v1/stock/ledger': {
    summary: 'Read the stock ledger',
    description: `
Every movement, in order — the append-only record the balances are derived from.

**This is the source of truth.** A balance that disagrees with the ledger is a
broken cache, not a different opinion, and the ledger is what wins.

Each row carries what happened, how much, between which status buckets, and what
it referenced — a dispense, a goods receipt, a transfer leg, a manual adjustment.
`.trim(),
    response: stockLedgerListResponse,
    paginated: true,
    params: {
      branchId: 'Narrow to one branch.',
      productId: 'Narrow to one product.',
      locationId: 'Narrow to one location.',
      batchId: 'Narrow to one batch.',
      movementType: 'Filter by movement type.',
      referenceType: 'Filter by what caused the movement.',
      referenceId: 'Narrow to one causing document.',
      from: 'Earliest movement date.',
      to: 'Latest movement date, inclusive.',
      page: 'Page number, from 1.',
      pageSize: 'Rows per page.',
    },
    responseExamples: [
      {
        summary: 'A dispense leaving the shelf',
        value: {
          success: true,
          message: 'Success',
          data: {
            movements: [
              {
                id: STOCK_MOVEMENT_ID,
                branchId: BRANCH_ID,
                productId: PRODUCT_ID,
                productName: PRODUCT.name,
                batchId: BATCH_ID,
                locationId: LOCATION_ID,
                movementType: 'DISPENSE',
                quantityBase: '-15',
                statusFrom: 'AVAILABLE',
                statusTo: null,
                reasonCode: null,
                referenceType: 'DISPENSE',
                occurredAt: '2026-03-17T04:37:00.000Z',
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

  'GET /api/v1/stock/expiring': {
    summary: 'Report expiring stock',
    description:
      'Batches approaching or past their expiry, with what is still on hand of each. What a monthly stock-check works from, and what stops expired stock reaching a patient. `withinDays` sets the horizon.',
    response: expiryReportResponse,
    params: {
      branchId: 'Narrow to one branch.',
      withinDays: 'How far ahead to look, in days.',
      includeExpired: 'Include batches already past expiry. Defaults to `true`.',
    },
    responseExamples: [
      {
        summary: 'Nothing expiring in 90 days',
        value: {
          success: true,
          message: 'Success',
          data: { branchId: BRANCH_ID, withinDays: 90, batches: [], totalValueMinor: 0 },
        },
      },
    ],
  },

  'GET /api/v1/stock/verify': {
    summary: 'Verify balances against the ledger',
    description: `
Replay the ledger and report where the cached balances disagree.

⚠️ **A READ, AND IT NEVER REPAIRS.** A cache that heals itself hides the trigger
bug that broke it — and a trigger bug is broken for *every* clinic rather than
for this one row. Finding a discrepancy here is a bug report, not a maintenance
task.

Behind \`inventory.stock.adjust\` rather than the plain read code because it is a
full-table replay: cheap on a small clinic, not free on a large one, and **not
something a dashboard should poll**.
`.trim(),
    response: verifyBalancesResponse,
    params: { branchId: 'Narrow the replay to one branch.' },
    responseExamples: [
      {
        summary: 'In agreement',
        value: {
          success: true,
          message: 'Success',
          data: { checked: 1842, discrepancies: [] },
        },
      },
    ],
  },

  'POST /api/v1/stock/movements': {
    summary: 'Record a stock movement',
    description: `
Write one movement into the ledger — a receipt, a write-off, a correction.

⚠️ **The body carries NO SIGN and NO BASE QUANTITY.** You say what happened and
how much of what you were holding; the server derives the direction from
\`movementType\`, converts through the product's packaging or unit graph, and
**refuses a conversion that does not come out exactly**. A client that sent a
signed base quantity would be deciding two things the ledger must decide itself.

⚠️ **\`movementType\` here is a SUBSET of the ledger's enum, deliberately.**
Dispensing must consult the regulatory engine first; consumption belongs to
procedures; transfers are only ever written as a **pair** in one transaction,
which a single-movement endpoint cannot guarantee. Exposing them here would let a
caller write one leg and leave stock that has left one branch and arrived at
none.

**An \`ADJUSTMENT\` must carry a \`reasonCode\`** — it is the only movement whose
meaning is not stated by its name — and must say its \`adjustmentDirection\`,
which no other movement accepts.

Give either \`unitId\` or \`packagingLevel\`, never both: a quantity that names
both has two answers.
`.trim(),
    response: recordMovementResponse,
    status: 201,
    errors: [409, 422],
    requestExamples: [
      {
        summary: 'Write off damaged stock',
        value: {
          branchId: BRANCH_ID,
          productId: PRODUCT_ID,
          batchId: BATCH_ID,
          locationId: LOCATION_ID,
          movementType: 'ADJUSTMENT',
          adjustmentDirection: 'DECREASE',
          quantity: '20',
          unitId: UNIT_CAPSULE_ID,
          reasonCode: 'DAMAGED',
          reasonNote: 'Crushed in transit',
        },
      },
      {
        summary: 'Move stock between status buckets',
        value: {
          branchId: BRANCH_ID,
          productId: PRODUCT_ID,
          batchId: BATCH_ID,
          locationId: LOCATION_ID,
          movementType: 'STATUS_CHANGE',
          quantity: '480',
          unitId: UNIT_CAPSULE_ID,
          statusFrom: 'QUARANTINE',
          statusTo: 'AVAILABLE',
        },
      },
    ],
    responseExamples: [
      {
        summary: 'Recorded',
        value: {
          success: true,
          message: 'Success',
          data: {
            movementId: STOCK_MOVEMENT_ID,
            quantityBase: '-20',
            balanceAfterBase: '460',
          },
        },
      },
    ],
  },

  'GET /api/v1/stock/reason-codes': {
    summary: 'List adjustment reason codes',
    description:
      'Why stock is adjusted — damaged, expired, found on count, lost. A closed list rather than free text, because "why did we lose 200 capsules" is a question that has to be answerable across a year of adjustments.',
    response: stockReasonCodeListResponse,
    params: {
      direction: 'Filter to codes valid for `INCREASE`, `DECREASE` or `BOTH`.',
      includeInactive: 'Include retired codes. Defaults to `false`.',
    },
    responseExamples: [
      {
        summary: 'One decrease reason',
        value: {
          success: true,
          message: 'Success',
          data: {
            reasonCodes: [
              {
                id: REASON_CODE_ID,
                code: 'DAMAGED',
                name: 'Damaged',
                direction: 'DECREASE',
                isActive: true,
                isOwn: false,
              },
            ],
          },
        },
      },
    ],
  },

  'POST /api/v1/stock/reason-codes': {
    summary: 'Create an adjustment reason code',
    description:
      'Add a reason of this clinic\'s own. `direction` constrains which adjustments may cite it — a code meaning "found on count" has no business on a decrease.',
    response: stockReasonCodeSummary,
    status: 201,
    errors: [409],
    requestExamples: [
      {
        summary: 'A decrease reason',
        value: { code: 'DAMAGED', name: 'Damaged', direction: 'DECREASE' },
      },
    ],
    responseExamples: [
      {
        summary: 'Created',
        value: {
          success: true,
          message: 'Success',
          data: {
            id: REASON_CODE_ID,
            code: 'DAMAGED',
            name: 'Damaged',
            direction: 'DECREASE',
            isActive: true,
            isOwn: true,
          },
        },
      },
    ],
  },

  'PATCH /api/v1/stock/reason-codes/{reasonCodeId}': {
    summary: 'Update an adjustment reason code',
    description:
      'Rename a reason or retire it. **`code` is not editable** — adjustments already cite it, and a report grouping by reason would silently split.',
    response: stockReasonCodeSummary,
    errors: [403, 409],
    params: { reasonCodeId: 'The reason code, as `GET /api/v1/stock/reason-codes` lists it.' },
    requestExamples: [{ summary: 'Retire it', value: { isActive: false } }],
  },

  'DELETE /api/v1/stock/reason-codes/{reasonCodeId}': {
    summary: 'Delete an adjustment reason code',
    description:
      'Remove a reason this clinic added. **A code already cited by an adjustment is `409`** — deleting it would leave historic movements explaining nothing. Retire it instead.',
    errors: [403, 409],
    params: { reasonCodeId: 'The reason code, as `GET /api/v1/stock/reason-codes` lists it.' },
  },

  'GET /api/v1/stock/reservations': {
    summary: 'List stock reservations',
    description:
      'Stock held back for something — a scheduled procedure, a pending order. A reservation reduces what allocation will offer without moving anything, which is what stops the last implant being dispensed out from under a booked theatre list.',
    response: stockReservationListResponse,
    paginated: true,
    params: {
      branchId: 'Narrow to one branch.',
      productId: 'Narrow to one product.',
      locationId: 'Narrow to one location.',
      status: 'Filter by `ACTIVE`, `RELEASED`, `EXPIRED` or `CONSUMED`.',
      referenceType: 'Filter by what the reservation is for.',
      referenceId: 'Narrow to one referencing document.',
      page: 'Page number, from 1.',
      pageSize: 'Rows per page.',
    },
    responseExamples: [
      {
        summary: 'One active reservation',
        value: {
          success: true,
          message: 'Success',
          data: {
            reservations: [
              {
                id: RESERVATION_ID,
                branchId: BRANCH_ID,
                productId: PRODUCT_ID,
                batchId: BATCH_ID,
                locationId: LOCATION_ID,
                quantityBase: '30',
                status: 'ACTIVE',
                expiresAt: '2026-03-24T00:00:00.000Z',
                referenceType: 'MANUAL',
                referenceId: null,
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

  'POST /api/v1/stock/reservations': {
    summary: 'Reserve stock',
    description: `
Hold stock back without moving it.

**\`expiresAt\` is required and there is no "forever".** A reservation nobody
released would quietly shrink available stock for good, and the commonest cause
of "the system says we have none" is a stale hold. It expires on its own.

Reserving more than is available is \`409\`.
`.trim(),
    response: stockReservationSummary,
    status: 201,
    errors: [409],
    requestExamples: [
      {
        summary: "A week's hold for a theatre list",
        value: {
          branchId: BRANCH_ID,
          productId: PRODUCT_ID,
          batchId: BATCH_ID,
          locationId: LOCATION_ID,
          quantity: '30',
          unitId: UNIT_CAPSULE_ID,
          expiresAt: '2026-03-24T00:00:00.000Z',
        },
      },
    ],
  },

  'POST /api/v1/stock/reservations/{reservationId}/release': {
    summary: 'Release a reservation',
    description:
      'Give the stock back to general availability. Releasing an already released or consumed reservation is `409`.',
    response: stockReservationSummary,
    errors: [409],
    params: { reservationId: 'The reservation, as `GET /api/v1/stock/reservations` lists it.' },
    requestExamples: [
      { summary: 'With a note', value: { notes: 'Procedure cancelled' } },
      { summary: 'Without one', value: {} },
    ],
  },

  'POST /api/v1/stock/allocations/plan': {
    summary: 'Plan an allocation',
    description: `
Ask which batches would be used to satisfy a quantity, without taking any.

⚠️ **A plan, not a hold.** Nothing is reserved and nothing moves — between this
call and the supply, somebody else may take the stock. A caller that needs the
answer to stay true wants a reservation.

\`strategy\` defaults to **FEFO** (first expiry, first out), which is what a
pharmacy wants; \`FIFO\` and \`LIFO\` are there for stock whose cost basis
matters more than its expiry.

Short stock is reported as a shortfall rather than an error — the counter needs
to know how much it *can* supply.
`.trim(),
    response: allocationPlanResponse,
    requestExamples: [
      {
        summary: 'Plan 15 capsules, first expiry first',
        value: {
          branchId: BRANCH_ID,
          productId: PRODUCT_ID,
          quantity: '15',
          unitId: UNIT_CAPSULE_ID,
          strategy: 'FEFO',
        },
      },
    ],
    responseExamples: [
      {
        summary: 'Satisfied from one batch',
        value: {
          success: true,
          message: 'Success',
          data: {
            quantityBase: '15',
            shortfallBase: '0',
            lines: [
              {
                locationId: LOCATION_ID,
                batchId: BATCH_ID,
                lotNumber: BATCH.batchNumber,
                expiresOn: BATCH.expiresOn,
                quantityBase: '15',
              },
            ],
          },
        },
      },
    ],
  },

  'GET /api/v1/stock-transfers': {
    summary: 'List stock transfers',
    description:
      'Stock moving between branches, and where each transfer has got to. `DRAFT` is still being written; `IN_TRANSIT` has left one branch and not arrived at the other.',
    response: stockTransferListResponse,
    paginated: true,
    params: {
      fromBranchId: 'Narrow to transfers leaving one branch.',
      toBranchId: 'Narrow to transfers arriving at one branch.',
      status: 'Filter by transfer status.',
      page: 'Page number, from 1.',
      pageSize: 'Rows per page.',
    },
    responseExamples: [
      {
        summary: 'One draft transfer',
        value: {
          success: true,
          message: 'Success',
          data: { transfers: [TRANSFER], total: 1, page: 1, pageSize: 25 },
        },
      },
    ],
  },

  'GET /api/v1/stock-transfers/{transferId}': {
    summary: 'Get a stock transfer',
    description:
      'One transfer with every line, what was dispatched and what was actually received — the two can differ, and the difference is the discrepancy a receipt records.',
    response: stockTransferDetail,
    params: {
      transferId: `The transfer, as \`GET /api/v1/stock-transfers\` lists it. ${BRANCH_404}`,
    },
    responseExamples: [
      {
        summary: 'A draft with one line',
        value: {
          success: true,
          message: 'Success',
          data: {
            ...TRANSFER,
            lines: [
              {
                id: TRANSFER_LINE_ID,
                productId: PRODUCT_ID,
                productName: PRODUCT.name,
                batchId: BATCH_ID,
                quantityBase: '100',
                quantityReceivedBase: null,
                notes: null,
              },
            ],
          },
        },
      },
    ],
  },

  'POST /api/v1/stock-transfers': {
    summary: 'Create a stock transfer',
    description: `
Draft a movement of stock between two branches.

**Creating a transfer moves nothing.** It is paperwork until dispatched, which is
what lets it be edited and cancelled freely.

\`toLocationId\` may be decided later — the receiving branch often knows better
than the sending one where it will go.

Both branches must be ones the caller may act on; either otherwise is \`404\`.
`.trim(),
    response: stockTransferDetail,
    status: 201,
    errors: [409],
    requestExamples: [
      {
        summary: 'Send 100 capsules to Kochi',
        value: {
          fromBranchId: BRANCH_ID,
          toBranchId: BRANCH_KOCHI_ID,
          fromLocationId: LOCATION_ID,
          lines: [
            { productId: PRODUCT_ID, batchId: BATCH_ID, quantity: '100', unitId: UNIT_CAPSULE_ID },
          ],
        },
      },
    ],
    responseExamples: [
      { summary: 'Drafted', value: { success: true, message: 'Success', data: TRANSFER } },
    ],
  },

  'PATCH /api/v1/stock-transfers/{transferId}': {
    summary: 'Update a stock transfer',
    description:
      '**Only while `DRAFT`.** Once dispatched, stock has physically left a branch and the paperwork must say what actually went. Sending `lines` replaces the whole set.',
    response: stockTransferDetail,
    errors: [409],
    params: { transferId: `The transfer. ${BRANCH_404}` },
    requestExamples: [
      { summary: 'Name the destination shelf', value: { toLocationId: LOCATION_ID } },
    ],
  },

  'POST /api/v1/stock-transfers/{transferId}/dispatch': {
    summary: 'Dispatch a transfer',
    description: `
Send the stock. It leaves the origin branch now.

⚠️ **This writes the FIRST of two ledger legs, and the pair is why transfers are
not available on \`POST /api/v1/stock/movements\`.** Between dispatch and receipt
the stock is genuinely in transit: gone from one branch, not yet at the other,
and visible as such rather than missing.

The transfer becomes \`IN_TRANSIT\` and can no longer be edited. Insufficient
stock at the origin is \`409\`.
`.trim(),
    response: stockTransferDetail,
    errors: [409],
    params: { transferId: `The transfer. ${BRANCH_404}` },
    responseExamples: [
      {
        summary: 'Dispatched',
        value: {
          success: true,
          message: 'Success',
          data: { ...TRANSFER, status: 'IN_TRANSIT', dispatchedAt: '2026-03-17T05:00:00.000Z' },
        },
      },
    ],
  },

  'POST /api/v1/stock-transfers/{transferId}/receive': {
    summary: 'Receive a transfer',
    description: `
Book the stock in at the destination — the second ledger leg.

⚠️ **Receive what actually arrived, not what was sent.** \`quantityBase\` per line
is what is physically in the box. A shortfall is recorded as a discrepancy on the
transfer rather than silently reconciled, because stock that left one branch and
did not arrive at the other is exactly the thing a stock system exists to
surface.

The transfer becomes \`RECEIVED\` (or \`PARTIALLY_RECEIVED\`), and quantities
land in \`toLocationId\`.
`.trim(),
    response: stockTransferDetail,
    errors: [409],
    params: { transferId: `The transfer. ${BRANCH_404}` },
    requestExamples: [
      {
        summary: 'Everything arrived',
        value: {
          toLocationId: LOCATION_ID,
          lines: [{ lineId: TRANSFER_LINE_ID, quantityBase: '100' }],
        },
      },
      {
        summary: 'Two short',
        description: 'The difference is recorded as a discrepancy, not quietly absorbed.',
        value: {
          toLocationId: LOCATION_ID,
          lines: [{ lineId: TRANSFER_LINE_ID, quantityBase: '98' }],
        },
      },
    ],
  },

  'POST /api/v1/stock-transfers/{transferId}/cancel': {
    summary: 'Cancel a stock transfer',
    description:
      '**Only while `DRAFT`.** Once dispatched the stock has left a branch, and the only honest ways to finish are to receive it or to record what went missing — cancelling would strand a ledger leg with no counterpart.',
    response: stockTransferDetail,
    errors: [409],
    params: { transferId: `The transfer. ${BRANCH_404}` },
    requestExamples: [{ summary: 'No longer needed', value: { reason: 'Kochi sourced locally' } }],
  },
};
