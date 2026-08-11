# Next Session

**Read this first.** Updated at the end of every session.

**Written:** 2026-08-11 · **By:** session PI-0 (discovery & planning)

---

## What we are building

A global, extensible **Product + Inventory + Pharmacy + Clinical Consumption +
Procurement + Regulatory platform** for rcln. Not a pharmacy module — shared
infrastructure that clinical, pharmacy, dental, lab, procedural and veterinary
workflows all sit on. Ten target countries via jurisdiction rule packs.

Full orientation: [README.md](README.md).

---

## What has already been completed

**PI-0 — Discovery & Architecture.** That is all. **No production code exists
for this programme.**

- The repository was audited: tenancy, RLS, RBAC, tax, invoicing, payments,
  audit, PHI logging, settings, documents, numbering, web shell.
- The reusable infrastructure was identified and is listed in
  [CURRENT_STATUS.md](CURRENT_STATUS.md).
- Seventeen decisions were recorded in [ARCHITECTURE.md](ARCHITECTURE.md).
- A 25-phase plan and a task tracker were written.

---

## What was changed in this session

Only documentation. Twenty-nine files under `.kb/PharmacyInventory/`, plus one
pointer stub at `docs/pharmacy-inventory/README.md`.

**Zero changes to `schema.prisma`, any package, any app, or any migration.**

---

## What remains

Everything. See [MASTER_PLAN.md](MASTER_PLAN.md).

---

## Current phase / current task / next task

|                   |                                                 |
| ----------------- | ----------------------------------------------- |
| **Current phase** | PI-0 — complete                                 |
| **Current task**  | none                                            |
| **Next phase**    | PI-1 — Product Platform Core                    |
| **Next task**     | **PI-1.1 — unit of measure & packaging engine** |

### Exactly how to start PI-1.1

1. `pnpm kb:find unit` and `pnpm kb:find convert` — confirm nothing already
   does this. The index exists to prevent a second implementation.
2. Invoke `/db-migration units of measure and product packaging`. This is not
   optional for a `schema.prisma` change in this repository.
3. Follow PI-ADR-003: `units_of_measure` is a **platform catalogue with tenant
   extension**, so it joins the `platform_extensible` array in
   `packages/db/prisma/rls/enable-rls.sql`, not the `org_scoped` one.
4. Add the RESTRICTIVE `*_visible` policy on any join table that points at a
   possibly-platform row. This is the highest-risk item in PI-1.
5. Add a case to `apps/api/tests/integration/tenant-isolation.test.ts`.
6. `docker compose exec api pnpm validate` and `pnpm db:rls:check`.

---

## Files that must be inspected before continuing

Read these before writing any code. They are where the patterns you must match
already live.

| File                                                             | Why                                                                                                                                    |
| ---------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/db/prisma/rls/enable-rls.sql`                          | The `org_scoped` / `branch_scoped` / `platform_extensible` arrays, and the `specialty_visible` RESTRICTIVE policy you will be copying. |
| `packages/db/prisma/schema.prisma` — `Specialty`, `TaxonomyNode` | The platform-catalogue and `parent_id`-tree shapes to reuse.                                                                           |
| `packages/db/prisma/schema.prisma` — `Invoice`, `InvoiceItem`    | The `tax_category` vs `item_code` separation, and the money/quantity column conventions.                                               |
| `packages/tax/src/types.ts`                                      | The jurisdiction vocabulary this programme must speak. Do not invent a second one.                                                     |
| `packages/permissions/src/codes.ts` + `roles.ts`                 | The `pharmacy.*` / `inventory.*` codes that already exist, and the PHARMACIST role.                                                    |
| `apps/api/src/services/numbering/`                               | `issueNumber()` — the gapless counter you will reuse for PO/GRN numbers.                                                               |
| `apps/api/src/services/invoicing/appointment-billing.service.ts` | The template for a domain handing work to the invoice engine. Charge requests follow its shape.                                        |
| `apps/api/src/services/audit/`                                   | `recordAudit` and `recordDataAccess`.                                                                                                  |
| `apps/api/src/routes/v1/patients.routes.ts`                      | The canonical middleware chain. Never reorder it.                                                                                      |
| `apps/web/src/lib/format.ts`                                     | Invariant 6. Every date on every new screen goes through it.                                                                           |

---

## Known issues

None yet — no code. See [KNOWN_ISSUES.md](KNOWN_ISSUES.md).

---

## Important architectural decisions

Read [ARCHITECTURE.md](ARCHITECTURE.md) in full. The five that will bite you
fastest:

1. **PI-ADR-001** — `products` is the root. There is no `medicines` table.
2. **PI-ADR-003** — the catalogue is a platform master with tenant extension,
   and **every join table into it needs a RESTRICTIVE visibility policy**.
3. **PI-ADR-004** — `stock_ledger` is append-only and is the only quantity
   truth. `stock_balances` is a cache.
4. **PI-ADR-005** — consumption never creates an invoice line.
5. **PI-ADR-006** — this programme writes no tax logic. It resolves a
   `tax_category` string and stops.

---

## Tests

|                        |                                                                                                                                                     |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Currently passing**  | The repository baseline — 338 API tests, `db:rls:check` green at 22 protected tables. Nothing in this programme has tests because nothing has code. |
| **Currently failing**  | None known. Re-run `pnpm validate` at session start to confirm the baseline before attributing a failure to your work.                              |
| **Migrations pending** | None.                                                                                                                                               |

---

## Unresolved questions

Five open decisions, all with a recommendation, in
[OPEN_DECISIONS.md](OPEN_DECISIONS.md). **OD-1 and OD-2 should be settled before
PI-1.2 is written** — both change table shapes.

Two are for the user rather than an agent:

- **OD-4** — should the platform ship a seeded global product catalogue, and if
  so from which licensed data source? Affects whether PI-1 ships with real data
  or an empty catalogue.
- **OD-5** — who is the human authorised to set a rule pack's
  `REGULATORY_REVIEWED` state? No agent may set it (PI-ADR-009).

---

## Do not

- Do not restart PI-0. The audit is done and its findings are in
  [CURRENT_STATUS.md](CURRENT_STATUS.md).
- Do not build a `medicines` root table. See PI-ADR-001.
- Do not build tax logic. See PI-ADR-006.
- Do not start PI-7 or PI-9. They are hard-blocked on Phase 3 entities that do
  not exist, and building against an imagined `prescriptions` shape guarantees
  rework.
- Do not mark a tracker row `COMPLETE` because code compiles. The gate is at the
  top of [IMPLEMENTATION_TRACKER.md](IMPLEMENTATION_TRACKER.md).
