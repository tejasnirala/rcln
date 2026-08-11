# API Architecture

The HTTP surface, and how it must be built. This programme follows the existing
conventions exactly — it introduces no new routing style, no new envelope and no
new error shape.

Read `.kb/APIs/_index.md` (generated) for the live surface, and
`apps/api/src/routes/v1/patients.routes.ts` for the canonical chain.

---

## The chain, which is never reordered

```
helmet → cors → body → request-id → pino
  → generalLimiter
  → resolveTenant      host → organization (Redis-cached, negatively cached)
  → authenticate       verify JWT, no DB round trip
  → authorize(CODE)    resolved access from Redis: roles, branches, permissions
  → validate(schema)   Zod, from @rcln/contracts
  → handler            withTenant(ctx, …)
```

Unknown tenant → **404, never 403**. Existing rule; do not "improve" it.

---

## Route surface

Versioned under `/v1`, one file per domain in `apps/api/src/routes/v1/`,
registered in `index.ts`.

### Product (PI-1)

```
GET    /v1/products                      product.definition.read
POST   /v1/products                      product.definition.manage
GET    /v1/products/:id                  product.definition.read
PATCH  /v1/products/:id                  product.definition.manage
POST   /v1/products/:id/clone            product.definition.manage   (platform → tenant)

GET    /v1/products/:id/identifiers       product.definition.read
POST   /v1/products/:id/identifiers       product.identifier.manage
GET    /v1/products/:id/packagings         product.definition.read
PUT    /v1/products/:id/packagings          product.definition.manage
GET    /v1/products/:id/tax-classifications product.definition.read
PUT    /v1/products/:id/tax-classifications billing.tax.manage        ⚠ not a product code
GET    /v1/products/:id/medicine           pharmacy.medicine.read
PUT    /v1/products/:id/medicine            pharmacy.medicine.manage

GET    /v1/product-categories             product.definition.read
GET    /v1/compositions                   product.definition.read
GET    /v1/active-ingredients             product.definition.read
GET    /v1/manufacturers                  product.definition.read
GET    /v1/units                          product.definition.read
GET    /v1/storage-profiles               product.definition.read
```

⚠️ `tax-classifications` is gated by `billing.tax.manage`, not a product code.
Setting a product's tax category decides what every future patient is charged;
that is the accountant's decision, and the existing catalogue already draws this
line for fee schedules and tax rules. Do not move it.

### Inventory (PI-2, PI-3)

```
GET    /v1/inventory/locations            inventory.stock.read
POST   /v1/inventory/locations            inventory.location.manage
GET    /v1/inventory/stock                inventory.stock.read
GET    /v1/inventory/stock/:productId     inventory.stock.read
GET    /v1/inventory/batches              inventory.stock.read
POST   /v1/inventory/batches              inventory.batch.manage
GET    /v1/inventory/serials              inventory.stock.read
GET    /v1/inventory/ledger               inventory.stock.read
GET    /v1/inventory/expiry               inventory.stock.read
POST   /v1/inventory/adjustments          inventory.stock.adjust
POST   /v1/inventory/transfers            inventory.stock.transfer
POST   /v1/inventory/transfers/:id/receive inventory.stock.transfer
POST   /v1/inventory/quarantine           inventory.quarantine.manage
POST   /v1/inventory/release              inventory.quarantine.manage
POST   /v1/inventory/reservations         inventory.stock.reserve
```

### Procurement (PI-4)

```
GET|POST  /v1/procurement/suppliers            pharmacy.supplier.manage / read
GET|POST  /v1/procurement/supplier-products    pharmacy.supplier.manage
GET|POST  /v1/procurement/requisitions         procurement.requisition.*
POST      /v1/procurement/requisitions/:id/approve procurement.requisition.approve
GET|POST  /v1/procurement/purchase-orders      pharmacy.purchase_order.read / manage
GET|POST  /v1/procurement/goods-receipts       pharmacy.goods_receipt.manage
POST      /v1/procurement/returns              pharmacy.goods_receipt.manage
```

### Regulatory (PI-5)

```
GET    /v1/regulatory/jurisdictions          regulatory.read
GET    /v1/regulatory/authorities            regulatory.read
GET    /v1/regulatory/rule-packs             regulatory.read
GET    /v1/regulatory/rules                  regulatory.read
GET    /v1/regulatory/sources                regulatory.read
GET    /v1/products/:id/regulatory-profiles  product.regulatory.read
PUT    /v1/products/:id/regulatory-profiles  product.regulatory.manage
POST   /v1/regulatory/evaluate               regulatory.read   (dry-run, for the UI)
```

Rule packs are **platform-managed**. Writing one is
`platform.regulatory.manage` under the `(platform)` surface, not a tenant route.

### Pharmacy (PI-7)

```
GET    /v1/pharmacy/queue                    pharmacy.dispense.read
GET    /v1/pharmacy/prescriptions/:id        pharmacy.dispense.read   ⚠ PHI read
POST   /v1/pharmacy/prescriptions/:id/verify pharmacy.dispense.verify
GET    /v1/pharmacy/dispenses                pharmacy.dispense.read
POST   /v1/pharmacy/dispenses                pharmacy.dispense.create
POST   /v1/pharmacy/dispenses/:id/return     pharmacy.dispense.return
POST   /v1/pharmacy/sales                    pharmacy.dispense.create  (counter sale)
GET    /v1/pharmacy/substitutions/:productId pharmacy.dispense.read
```

### Consumption (PI-9)

```
GET|PUT /v1/clinical/consumption-templates    consumption.template.manage
GET     /v1/clinical/consumption              consumption.read
POST    /v1/clinical/consumption              consumption.record
POST    /v1/clinical/consumption/:id/override consumption.override
```

### Charges (PI-8)

```
GET  /v1/charges/requests            billing.invoice.read
POST /v1/charges/requests/:id/bill   billing.invoice.create
POST /v1/charges/requests/:id/waive  billing.invoice.update
```

These produce a **draft invoice** through the existing
`services/invoicing`. There is no new invoice route.

---

## Contracts

One file per domain in `packages/contracts/src/`, exported from `index.ts`,
matching `patients.ts` / `invoices.ts` in style:

```
products.ts  inventory.ts  procurement.ts  pharmacy.ts
regulatory.ts  consumption.ts  charges.ts
```

Zod schemas plus inferred types, shared by api and web. **The web never
redeclares a request or response type.**

Conventions inherited, not re-litigated:

- envelope `{ success, data }` / `{ success, error }`
- cursor or page/limit pagination exactly as the existing list routes do it
- ISO-8601 with a `Z` for every instant, in and out
- money as integer minor units + currency, never a formatted string
- quantities as strings on the wire where precision matters (`Decimal(18,6)`
  does not survive a JSON number)

---

## Services

`apps/api/src/services/<domain>/` — `product/`, `inventory/`, `procurement/`,
`pharmacy/`, `regulatory/`, `consumption/`, `charges/`.

Rules:

- every DB access through `withTenant(ctx, …)`; never the raw client
- the ledger has exactly one writer function, `recordMovement()`. Nothing else
  inserts into `stock_ledger`, and nothing at all writes `stock_balances`
- the regulatory engine has exactly one entry point, `evaluate()`. No service
  reads a rule row directly
- `recordAudit` on every mutation, `recordDataAccess` on every PHI read
- `pnpm kb:find` before writing any helper

---

## Errors

Reuse the existing error classes and mapping. Two domain-specific shapes are
worth defining once in PI-2/PI-5 rather than per call site:

| Case               | Shape                                                                                                                                         |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------- |
| Insufficient stock | `409` with `{ productId, requested, available, locationId }`                                                                                  |
| Regulatory refusal | `422` with `{ ruleType, ruleId, packVersion, reason }` — the reason is written for a pharmacist, not a developer, because it reaches a screen |

A regulatory refusal is never a `403`. `403` means "you may not"; this means
"nobody may, here, today".

---

## Rate limiting & performance

- Catalogue reads are cacheable per organization; platform rows are cacheable
  globally. Cache **ids and catalogue text only — never a batch, never a
  balance, never anything patient-linked.**
- Barcode resolution (`/v1/inventory/resolve?code=…`, PI-23) is the hottest
  endpoint in the programme. Index-only lookup, its own limiter.
- Ledger reads always paginate. There is no unbounded ledger response.
