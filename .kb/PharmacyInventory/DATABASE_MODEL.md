# Database Model

Proposed tables, their tenancy class, and the constraints that carry weight.
**This is a design, not a migration.** Column lists are indicative; the exact
schema is written phase by phase with `/db-migration`.

Read [`.kb/Database/schema-design.md`](../Database/schema-design.md) and
`packages/db/prisma/rls/enable-rls.sql` before writing any of it.

---

## Tenancy classes

Every table in this programme is exactly one of these. Getting the class wrong
is the security regression, not the column list.

| Class                   | `organization_id`                   | RLS array                             | Policy                                                     |
| ----------------------- | ----------------------------------- | ------------------------------------- | ---------------------------------------------------------- |
| **PLATFORM_EXTENSIBLE** | nullable — NULL = platform row      | `platform_extensible`                 | `USING (NULL OR mine)` / `WITH CHECK (mine)`               |
| **ORG_SCOPED**          | NOT NULL                            | `org_scoped`                          | `USING/CHECK (mine)`                                       |
| **BRANCH_SCOPED**       | NOT NULL, plus `branch_id` NOT NULL | both `org_scoped` and `branch_scoped` | org policy + branch policy                                 |
| **CHILD**               | NOT NULL, inherits via composite FK | same arrays as its parent             | carries both ids so it is an ordinary member of both loops |

⚠️ The invoice tables document why children carry both ids rather than relying
on a parent predicate: an org-only inherited policy under a branch-scoped parent
re-opens the branch boundary. Copy that, not `appointment_status_history`.

⚠️ Every join table pointing at a PLATFORM_EXTENSIBLE parent **also** needs a
RESTRICTIVE `*_visible` policy, exactly like `specialty_visible`. Without it a
tenant attaches another tenant's private row and reads the name back out.

---

## PI-1 — Product

| Table                          | Class                 | Notes                                                                                                                                                                                                                    |
| ------------------------------ | --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `units_of_measure`             | PLATFORM_EXTENSIBLE   | `code`, `name`, `unit_class` (COUNT/VOLUME/MASS/LENGTH), `is_base`                                                                                                                                                       |
| `unit_conversions`             | PLATFORM_EXTENSIBLE   | `(from_unit, to_unit, numerator, denominator)`. Integer ratio, never a float. Same `unit_class` on both sides — a CHECK.                                                                                                 |
| `product_categories`           | PLATFORM_EXTENSIBLE   | `parent_id` only. No depth column, no fixed level columns. Reuses the `TaxonomyNode` shape.                                                                                                                              |
| `manufacturers`                | PLATFORM_EXTENSIBLE   | `name`, `country_code`, licence identifiers                                                                                                                                                                              |
| `active_ingredients`           | PLATFORM_EXTENSIBLE   | `name`, `inn_name`, synonyms                                                                                                                                                                                             |
| `compositions`                 | PLATFORM_EXTENSIBLE   | `name`, `dosage_form`                                                                                                                                                                                                    |
| `composition_ingredients`      | CHILD of composition  | `(composition_id, ingredient_id, strength Decimal(12,4), strength_unit_id)` · needs `ingredient_visible` RESTRICTIVE policy                                                                                              |
| `products`                     | PLATFORM_EXTENSIBLE   | `type`, `status`, `name`, `brand_name`, `generic_name`, `category_id`, `manufacturer_id?`, `composition_id?`, `base_unit_id`, `tracking_mode`, `is_expiry_controlled`, `default_shelf_life_days?`, `storage_profile_id?` |
| `product_packagings`           | CHILD of product      | `level`, `unit_id`, `quantity_of_child`, `is_default_purchase`, `is_default_sale`                                                                                                                                        |
| `product_identifiers`          | CHILD of product      | `type`, `value`, `country_code?`, `effective_from`, `effective_to?`                                                                                                                                                      |
| `product_tax_classifications`  | CHILD of product      | `country_code`, `region_code?`, `tax_category`, `item_code?`, `effective_from`, `effective_to?`                                                                                                                          |
| `medicine_details`             | CHILD of product, 1:1 | `dosage_form`, `route`, `release_type`, `is_narrow_therapeutic_index`                                                                                                                                                    |
| `storage_requirement_profiles` | PLATFORM_EXTENSIBLE   | temp min/max, humidity, light, controlled access, hazard class                                                                                                                                                           |

### Uniqueness — the ones that matter

```prisma
// NEVER a bare @@unique([code]) on a tenant table.
@@unique([organizationId, code])          // tenant rows
// Platform rows have organization_id NULL, so the index must be
// NULLS NOT DISTINCT, appended by hand to the migration — the same
// treatment tax_rule_defaults and number_sequences already needed.

// Identifiers: qualified by tenant AND type. A GTIN is unique in principle
// and routinely is not in practice.
@@unique([organizationId, type, value, countryCode])

// Composite-FK targets on every parent:
@@unique([organizationId, id])
```

---

## PI-2 / PI-3 — Inventory

| Table                 | Class             | Notes                                                                                                                                                                                          |
| --------------------- | ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `inventory_locations` | BRANCH_SCOPED     | `kind`, `name`, `code`, `is_dispensing_point`, `requires_controlled_access`, `storage_profile_id?`                                                                                             |
| `storage_areas`       | CHILD of location |                                                                                                                                                                                                |
| `storage_bins`        | CHILD of area     |                                                                                                                                                                                                |
| `batches`             | BRANCH_SCOPED     | `product_id`, `lot_number`, `manufactured_on?`, `expires_on?`, `retest_on?`, `manufacturer_id?`, `supplier_id?`, `unit_cost_base` (minor units), `currency`, `status`, `received_grn_line_id?` |
| `serials`             | BRANCH_SCOPED     | `product_id`, `batch_id?`, `serial_number`, `status`, `current_location_id?`, `assigned_patient_id?` ⚠️ PHI                                                                                    |
| **`stock_ledger`**    | BRANCH_SCOPED     | append-only. See below.                                                                                                                                                                        |
| `stock_balances`      | BRANCH_SCOPED     | `(product_id, batch_id?, serial_id?, location_id, status) → quantity`. Trigger-maintained cache.                                                                                               |
| `stock_reservations`  | BRANCH_SCOPED     | `reference_type`, `reference_id`, `expires_at`, release job                                                                                                                                    |

### `stock_ledger` — the load-bearing table

```
id, organization_id, branch_id
product_id, batch_id?, serial_id?
movement_type      PURCHASE_RECEIPT | TRANSFER_OUT | TRANSFER_IN | DISPENSING
                 | CLINICAL_CONSUMPTION | ADJUSTMENT | DAMAGE | EXPIRY
                 | RECALL | RETURN | DISPOSAL | RESERVATION | RELEASE
quantity_base      Decimal(18,6)   signed; sign is derived from movement_type
                                   and CHECKed, never chosen by the caller
unit_id                            what the user entered, for display
quantity_entered   Decimal(18,6)   what the user entered, before conversion
from_location_id?  to_location_id?
status_from?       status_to?      inventory status transition, if any
reason_code?       reason_note?
reference_type     reference_id    GRN | DISPENSE | CONSUMPTION | TRANSFER | …
unit_cost_base?    currency?
actor_user_id      occurred_at (Timestamptz)  recorded_at
regulatory_decision_id?            the snapshot that permitted this (PI-ADR-008)
```

**Append-only, enforced twice**, exactly as `audit_logs` and
`data_access_logs` already are in this repository:

1. `rcln_app` holds no `UPDATE` or `DELETE` on the table (a `REVOKE` in the
   migration);
2. a trigger refuses both anyway.

Both layers get a test that removes one and proves the other still refuses. That
test already exists in this repo for audit logs — copy it.

### Constraints worth writing in SQL

```sql
-- PI-ADR-014: the tracking mode is enforced by the database, not the service.
CHECK (
  (tracking_mode = 'NONE')
  OR (tracking_mode = 'LOT_BATCH'      AND batch_id IS NOT NULL)
  OR (tracking_mode = 'SERIAL'         AND serial_id IS NOT NULL)
  OR (tracking_mode = 'LOT_AND_SERIAL' AND batch_id IS NOT NULL AND serial_id IS NOT NULL)
)
-- denormalised tracking_mode onto the ledger row so the CHECK needs no join.

-- Expiry-controlled products must carry an expiry on the batch.
CHECK (NOT is_expiry_controlled OR expires_on IS NOT NULL)

-- A balance may never go negative.
CHECK (quantity >= 0)
```

### Indexes

```
stock_ledger    (organization_id, branch_id, product_id, occurred_at DESC)
                (organization_id, batch_id, occurred_at)
                (organization_id, reference_type, reference_id)   -- traceability
                (organization_id, serial_id)                       -- device history
stock_balances  (organization_id, branch_id, location_id, product_id, status)
                (organization_id, product_id, status)              -- "where is it"
batches         (organization_id, product_id, expires_on)          -- FEFO + expiry sweep
                (organization_id, status) WHERE status <> 'ACTIVE' -- partial: recall/quarantine
product_identifiers (organization_id, type, value)                 -- barcode lookup
```

---

## PI-4 — Procurement

| Table                              | Class                                   |
| ---------------------------------- | --------------------------------------- |
| `suppliers`                        | ORG_SCOPED                              |
| `supplier_tax_identifiers`         | CHILD of supplier                       |
| `supplier_products`                | ORG_SCOPED, child of supplier + product |
| `purchase_requisitions` / `_lines` | BRANCH_SCOPED / CHILD                   |
| `purchase_orders` / `_lines`       | BRANCH_SCOPED / CHILD                   |
| `goods_receipts` / `_lines`        | BRANCH_SCOPED / CHILD                   |
| `purchase_returns` / `_lines`      | BRANCH_SCOPED / CHILD                   |

`NumberSequenceType` gains `PURCHASE_ORDER`, `GOODS_RECEIPT`, `STOCK_TRANSFER`,
`DISPENSE`. ⚠️ `number_sequences` is deliberately **org-scoped RLS only** — do
not add a branch policy; `ON CONFLICT DO UPDATE` against an RLS-hidden row
raises 23505 instead of incrementing. That warning is already in the schema.

---

## PI-5 — Regulatory

| Table                         | Class                          | Notes                                                                                                                                                                |
| ----------------------------- | ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `jurisdictions`               | PLATFORM only (no tenant rows) | `country_code`, `region_code?`, `name`                                                                                                                               |
| `regulatory_authorities`      | PLATFORM only                  |                                                                                                                                                                      |
| `regulatory_rule_packs`       | PLATFORM only                  | `jurisdiction_id`, `version`, `maturity`, `effective_from`, `effective_to?`, `last_reviewed_at`                                                                      |
| `regulatory_rules`            | PLATFORM only                  | `pack_id`, `rule_type`, `applies_to` (product type / category / classification), `parameters` JSONB **as a document, never as foreign keys** (ADR-0006), `source_id` |
| `regulatory_sources`          | PLATFORM only                  | authority, title, URL, published, effective, retrieved, review status, notes                                                                                         |
| `product_regulatory_profiles` | PLATFORM_EXTENSIBLE            | `(product_id, country_code, region_code?)` → registration number, classification, schedule, restrictions, effective dates                                            |
| `regulatory_decisions`        | BRANCH_SCOPED                  | the **snapshot** of one evaluation: inputs, outcome, rule pack version, reasons. Cited by ledger and dispensing rows. Append-only.                                   |

Rule packs are platform data seeded by `rcln_owner`. A tenant never writes one.
`regulatory_decisions` is tenant data because it records what happened in a
clinic.

---

## PI-8 — Charge requests

| Table             | Class               | Notes                                                                                                                                                       |
| ----------------- | ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `charge_policies` | PLATFORM_EXTENSIBLE | keyed by any of product / product type / procedure / payer / country; most specific wins                                                                    |
| `charge_requests` | BRANCH_SCOPED       | `source_type`, `source_id`, `patient_id?`, `product_id`, `quantity`, `unit_id`, `resolved_policy`, `status` (PENDING/BILLED/SUPPRESSED), `invoice_item_id?` |

`charge_requests.invoice_item_id` is the only link, and it points **at** the
invoice engine's row rather than being written by this programme.

---

## PI-9 / PI-11 — later

| Table                              | Class                 | Phase |
| ---------------------------------- | --------------------- | ----- |
| `consumption_templates` / `_lines` | ORG_SCOPED / CHILD    | PI-9  |
| `consumption_records` / `_lines`   | BRANCH_SCOPED / CHILD | PI-9  |
| `recalls` / `recall_batches`       | ORG_SCOPED            | PI-10 |
| `animal_profiles`                  | CHILD of patient      | PI-11 |

---

## Non-negotiable schema rules for this programme

- `Timestamptz(6)` for every instant. UTC in, ISO with `Z` on the wire.
- No float for money, ever. Integer minor units, or `Decimal(14,2)` beside an
  invoice column.
- No `isDeleted Boolean`. Status enums and effective dates.
- No JSON array of foreign keys (ADR-0006). JSONB is allowed for rule
  _parameters_ and setting _values_ — documents, not references.
- Every new tenant table: RLS policy in `enable-rls.sql`, the policy SQL
  appended to the generated migration, and a case in
  `apps/api/tests/integration/tenant-isolation/`. `pnpm db:rls:check`
  fails until the policy exists, and that is deliberate.
- Never edit an applied migration. Prisma checksums it.
