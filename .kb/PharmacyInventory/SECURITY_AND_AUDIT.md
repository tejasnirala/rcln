# Security and Audit

> **This is PHI in a shared database.** The realistic worst case is one clinic
> reading another clinic's patient records. Every schema change in this
> programme is a security change until proven otherwise.

---

## Tenant isolation

Three independent layers, all of which apply to every table this programme adds:

1. **RLS policies** in `packages/db/prisma/rls/enable-rls.sql`, appended to the
   generated migration
2. **Composite foreign keys** — `@@unique([organizationId, id])` on parents,
   children referencing the pair (ADR-0004)
3. **Application scoping** — every query through `withTenant(ctx, …)` (ADR-0005)

`pnpm db:rls:check` fails until a policy exists, and that gate is deliberate: a
missing policy produces no error and breaks no single-tenant test. It just
starts returning other clinics' records.

### The tenancy class of each table is a security decision

See [DATABASE_MODEL.md](DATABASE_MODEL.md) § Tenancy classes. The two traps:

⚠️ **PLATFORM_EXTENSIBLE tables need an asymmetric policy.** `USING (org IS NULL
OR org = mine)`, `WITH CHECK (org = mine)`. A permissive `WITH CHECK` lets any
clinic insert a platform-wide product row instantly visible to every other
tenant — a cross-tenant write dressed up as a catalogue entry. The existing
`enable-rls.sql` explains this at length for `specialties`; read it.

⚠️ **Every join table pointing at a possibly-platform row needs a RESTRICTIVE
`*_visible` policy.** `tenant_isolation` constrains the _child_ side and says
nothing about the _parent_ side, so without it a tenant attaches another
tenant's private product/ingredient/composition to its own row and reads the
name back out. `specialty_visible` on `doctor_specialties` is the template.
**This is the single most likely security regression in PI-1.**

### Branch-scoped tables

`inventory_locations`, `batches`, `serials`, `stock_ledger`, `stock_balances`,
POs, GRNs, dispenses, consumption records all carry `branch_id NOT NULL` and
join **both** the `org_scoped` and `branch_scoped` arrays. Children carry both
ids rather than inheriting through a parent predicate — the invoice tables
document why, and `appointment_status_history` documents what happens when you
do not.

### The two exceptions that already exist

`setting_values` is **RLS-exempt**; the explicit `(scopeType, scopeId)` pair is
the only isolation, and `db:rls:check` cannot notice a missing one. Every
setting read this programme adds must pass the pair explicitly and must have a
test proving cross-tenant reads fail (PI-ADR-015).

`number_sequences` is **org-scoped only, deliberately**. Do not add a branch
policy.

---

## RBAC

One authorization system. No second one.

### Codes that already exist

```
pharmacy.medicine.read/manage · pharmacy.dispense.read/create/return
pharmacy.supplier.manage · pharmacy.purchase_order.read/manage
pharmacy.goods_receipt.manage
inventory.stock.read/adjust/transfer · inventory.batch.manage
report.inventory.read
```

They are seeded and granted to `PHARMACIST` already, but nothing is gated by
them because nothing is built.

### Codes to add

| Phase | Codes                                                                                                                            |
| ----- | -------------------------------------------------------------------------------------------------------------------------------- |
| PI-1  | `product.definition.read` · `product.definition.manage` · `product.identifier.manage`                                            |
| PI-2  | `inventory.location.manage` · `inventory.quarantine.manage` · `inventory.stock.reserve`                                          |
| PI-4  | `procurement.requisition.create` · `procurement.requisition.approve`                                                             |
| PI-5  | `regulatory.read` · `regulatory.manage` · `product.regulatory.read` · `product.regulatory.manage` · `platform.regulatory.manage` |
| PI-7  | `pharmacy.dispense.verify`                                                                                                       |
| PI-9  | `consumption.read` · `consumption.record` · `consumption.override`                                                               |
| PI-10 | `recall.notice.read` · `recall.notice.create` · `recall.notice.execute` · `recall.trace.patients` ⚠️                             |

`MODULES` gains `product`, `procurement`, `regulatory`, `consumption`, `recall`.

⚠️ **PI-10 SHIPPED FOUR CODES, NOT THREE, AND THE NAMES CARRY A RESOURCE
SEGMENT** — the format is `<module>.<resource>.<action>`, so `recall.read` has
only two. The fourth, `recall.trace.patients`, is the one this document did not
anticipate: reading a NOTICE is not reading WHO RECEIVED IT. The forward trace
answers "37 supplies, 4 procedures, 29 people" under `recall.notice.read` and
names nobody; resolving that to names and phone numbers is a separate act, gated
separately, and it writes a `RECALL_TRACE` row in `data_access_logs`. See
TRACEABILITY.md § "Patient linkage and its limits".

### Splits that matter

Each of these mirrors a split the existing catalogue already makes, for the same
reason:

| Split                                                                           | Why                                                                                                                             |
| ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `requisition.create` / `.approve`                                               | A branch may not approve its own request. Same shape as `doctor.schedule.request` / `.approve`.                                 |
| `dispense.create` / `.verify`                                                   | Verification is a distinct professional act.                                                                                    |
| `consumption.record` / `.override`                                              | Recording what was used and overriding the expected quantity are different acts.                                                |
| `stock.read` / `.adjust`                                                        | The existing catalogue's own example: _"may dispense but may not adjust stock."_                                                |
| `quarantine.manage` separate from `stock.adjust`                                | Releasing quarantined stock is a safety decision, not a counting correction.                                                    |
| `regulatory.read` / `.manage`, and `platform.regulatory.manage` apart from both | A clinic configures its own profiles; only the platform maintains rule packs. Mirrors `billing.tax.*` vs `platform.tax.manage`. |
| `product.*` distinct from `pharmacy.medicine.*`                                 | A dental store manager must not need a pharmacy code. PI-ADR-011.                                                               |

### Tax classification is not a product permission

Editing `product_tax_classifications` requires `billing.tax.manage`. A wrong tax
category charges every patient the wrong amount and leaves the clinic owing tax
it never collected. The existing catalogue draws this line explicitly for fee
schedules and tax rules; this follows it.

### Rules

- Never put the permission list in the JWT.
- Never derive authorization from `ProductType`, `LocationKind` or a taxonomy
  node type. All three are metadata.
- Never return 403 for an unknown tenant — 404.
- A regulatory refusal is 422, not 403. "Nobody may" is not "you may not".

---

## Audit

Two existing tables, two existing helpers, no new ones.

### Mutations → `recordAudit`

Every one of these writes an audit row with `diffSnapshots`:

```
product created / updated / status changed
tax classification changed          regulatory profile changed
batch created / status changed      stock adjusted (with reason)
stock transferred                   batch quarantined / released
PO created / approved               goods receipt posted
dispensing created / modified / cancelled
controlled product dispensed        prescription verification override
consumption recorded / overridden   recall created / executed
charge policy changed               rule pack maturity changed
```

`audit_logs` is append-only, enforced by Postgres — `rcln_app` holds no UPDATE
or DELETE. There is no permission to edit history, because that would be a
permission to make the trail lie.

### PHI reads → `recordDataAccess`

Reading who was dispensed what, or what was consumed for whom, is a disclosure
about a named person (PI-ADR-016).

- `DataAccessResource` gains `DISPENSE` and `CONSUMPTION`. `PRESCRIPTION`
  already exists.
- One row per **request**, never per result row. A list writes one row with
  `resultCount` and a null patient; a detail view writes one naming the patient.
- The existing 300-second Redis dedupe applies to repeat views; **searches are
  never deduplicated**, because repeated searching for one person is itself the
  signal.
- ⚠️ **Ids, enums, counts and a hash. Nothing else.** No product name, no
  patient name, no free text. This table is read by compliance and security
  people who have no business reading patient records — a medicine name landing
  here is itself a disclosure.
- `route` is the matched pattern (`GET /v1/pharmacy/dispenses/:id`), never the
  URL, because a URL carries the search string.

### Redaction backstop

Add the new PHI-adjacent field names to `REDACTED_KEYS`. Note the existing
deliberate omission of `email` and `phone` — a blanket key-name deny-list would
gut two real trails. Follow the same judgement: add specific new names, not
categories.

---

## PHI handling rules

- Never log a patient name or a medicine dispensed to a named person.
- Never cache PHI in Redis. Ids only. Catalogue text is cacheable; a batch, a
  balance or anything patient-linked is not.
- Never store PHI in `localStorage`, cookies or URL query params. A dispensing
  search goes in a POST body or by id.
- `serials.assigned_patient_id` is PHI. A device-history screen showing it is a
  PHI read and logs one.
- Traceability reports default to ids and counts; resolving to names is a
  separate, permissioned, logged action.

---

## Injection and raw SQL

- Never interpolate user input into `$queryRaw` — parameterize.
- The trigger and CHECK SQL in PI-2 is hand-written and appended to migrations;
  it takes no user input, and it must not start.
- Barcode payloads are untrusted input. Decode with a parser, not a regex that
  builds a query.

---

## Review gates

`security-reviewer` is **mandatory**, not optional, on every phase of this
programme: each one touches the schema, tenancy and patient data.

Per-phase, before marking any task COMPLETE:

```
docker compose exec api pnpm validate       # typecheck + lint + test
docker compose exec api pnpm db:rls:check   # every new tenant table protected
/code-review                                # both reviewer subagents
```

Plus a case in `apps/api/tests/integration/tenant-isolation/` for every
new tenant table, and a RESTRICTIVE-policy case for every new join table into a
platform-extensible parent.
