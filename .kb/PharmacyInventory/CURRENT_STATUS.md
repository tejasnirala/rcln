# Current Status

The honest ledger for the Product Platform programme. Nothing is marked built
until it is built, migrated, tested and wired to a screen.

**Last updated:** 2026-08-20 · **Phase:** PI-0 through PI-13 and PI-15 complete

⚠️ **THE REST OF THIS FILE DESCRIBES THE PRE-CODE STATE AND IS KEPT FOR THE AUDIT
IT RECORDS, NOT AS A STATUS.** Its table of reusable infrastructure is still
accurate and still worth reading before starting a phase. Its summary is not.
**[IMPLEMENTATION_TRACKER.md](IMPLEMENTATION_TRACKER.md) is the authority on task
state**, and [NEXT_SESSION.md](NEXT_SESSION.md) is where to start.

---

## Summary

PI-1 shipped the catalogue — thirteen tables, no quantity anywhere in them — and
is merged. PI-2 shipped everything with a quantity: seven tables, the append-only
`stock_ledger`, a balance cache the application cannot write, the expiry sweep,
and four `/stock` screens; both reviewer passes ran and were acted on.

PI-3 shipped the three documents a store actually needs — adjustments with a
controlled vocabulary, transfers between shelves and between sites, and
reservations — plus the FEFO allocation engine and a second worker sweep. Four
tables, four migrations, three screens. `db:rls:check` is green at **76**
protected tables and 1159 API tests pass across 41 suites.

**Both reviewer passes have run and been acted on.** The tenancy layer came back
clean — the two-ended transfer policy holds and the in-transit claim was verified
in the code. Every finding was in the SERVICES: three CRITICALs, all of them
read-then-write or validate-once-act-later mistakes, plus seven smaller ones. All
fixed, with four regression tests. See [CHANGELOG.md](CHANGELOG.md).

⚠️ **In-transit stock is deliberately not in `stock_balances`.** PI-3 decided the
transfer DOCUMENT holds it, because a sender-owned `IN_TRANSIT` bucket would
force the receiver to write against a branch RLS hides from them. PI-22's
valuation must add the outstanding lines of `DISPATCHED` transfers. See
[NEXT_SESSION.md](NEXT_SESSION.md) decision 1.

PI-4 shipped procurement — twelve tables, the supplier/document tenancy seam, and
seven screens. PI-5 shipped the regulatory FRAMEWORK: six tables, the pure
`@rcln/regulatory` engine, the sign-off ladder, and five screens. `db:rls:check`
is green at **89** protected tables.

⚠️ **PI-5 CONTAINS NO COUNTRY'S RULES AND IS WIRED INTO NO CALL SITE.** That is
the design, not an omission: `UNDETERMINED` refuses, and with no pack configured
anywhere, enforcing the engine today would stop every clinic on the platform from
receiving stock. PI-6 configures the first jurisdiction and wires the callers as
it reaches `RULES_IMPLEMENTED`. **Nothing in this repository claims legal
compliance for any jurisdiction.**

Below is the PI-0 audit as it was written, before any of that existed.

---

## What already exists and will be reused

Verified by reading source on 2026-08-11, not inferred from documentation.

| Capability                                            | Where                                                          | State                     | How this programme uses it                                                                                                                                       |
| ----------------------------------------------------- | -------------------------------------------------------------- | ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Tenancy — org is tenant, branch is place              | `schema.prisma`, ADR-0001                                      | Complete                  | Every table carries `organization_id`; branch-local ones carry `branch_id` too.                                                                                  |
| RLS — `tenant_isolation` + `branch_isolation` loops   | `packages/db/prisma/rls/enable-rls.sql`                        | Complete, 22 tables       | Every new tenant table joins the right array. `pnpm db:rls:check` gates it.                                                                                      |
| **Platform catalogue + tenant extension** RLS pattern | same file, `platform_extensible` array                         | Complete                  | ⭐ Exactly the shape the global product master needs. `organization_id NULL` = platform row; `USING (NULL OR mine)`, `WITH CHECK (mine)`.                        |
| RESTRICTIVE cross-parent policy                       | `specialty_visible`, `qualification_visible`                   | Complete                  | Must be replicated for every join table pointing at a platform product row.                                                                                      |
| Composite FKs                                         | ADR-0004                                                       | Complete                  | `@@unique([organizationId, id])` on every parent; children FK the pair.                                                                                          |
| `withTenant(ctx, …)`                                  | `@rcln/db`, ADR-0005                                           | Complete                  | The only DB access path. eslint-enforced.                                                                                                                        |
| RBAC — 137 codes, 12 system roles, resolver           | `packages/permissions/src`                                     | Complete                  | **`pharmacy.*` and `inventory.*` codes already exist** — see below.                                                                                              |
| `PHARMACIST` system role                              | `packages/permissions/src/roles.ts`                            | Complete                  | Already defined with pharmacy codes.                                                                                                                             |
| **Tax engine** `@rcln/tax`                            | `packages/tax/src`                                             | Complete, country-generic | Pure, synchronous, `(country, region)` jurisdictions, `GST`/`VAT`/`SALES_TAX`, `TaxSplit`, and a `TaxProviderQuote` seam for US sales tax. **No change needed.** |
| `tax_rules` / `tax_rule_defaults`                     | schema                                                         | Complete                  | Effective-dated, tenant-override-beats-platform. Products resolve to a `tax_category` string that keys these.                                                    |
| **Invoice engine**                                    | `invoices`/`invoice_items`/`invoice_taxes`/`invoice_documents` | Complete                  | `InvoiceSourceType` **already has `PHARMACY` and `INVENTORY`**. DRAFT-only money mutation enforced by `invoices_lifecycle_guard`.                                |
| `invoice_items.tax_category` vs `.item_code`          | schema                                                         | Complete                  | ⭐ HSN is already _presentation only_. The requirement "do not make HSN the universal identifier" is satisfied upstream.                                         |
| Invoice numbering, per branch per source per period   | `invoice-number.service.ts`                                    | Complete                  | Pharmacy invoices reuse it. `NumberSequenceType` gains members for GRN/PO/dispense.                                                                              |
| `issueNumber()` gapless counters                      | `services/numbering`                                           | Complete                  | Reused for PO / GRN / dispense / transfer numbers.                                                                                                               |
| `@rcln/invoicing` — pricing, discount, quantity       | package                                                        | Complete                  | Line arithmetic. Not reimplemented.                                                                                                                              |
| `@rcln/payments` — `Money`, integer minor units       | package                                                        | Complete                  | The money type for costs and prices. Never a float.                                                                                                              |
| Audit — `recordAudit`, `diffSnapshots`                | `services/audit`                                               | Complete                  | Every sensitive mutation in this programme calls it.                                                                                                             |
| PHI read log — `recordDataAccess`, `data_access_logs` | `services/audit`                                               | Complete                  | `DataAccessResource` already has `PRESCRIPTION`. Dispensing adds a member.                                                                                       |
| Settings resolver — USER→DOCTOR→BRANCH→ORG→PLATFORM   | `services/settings`                                            | Complete                  | The home for expiry thresholds, FEFO toggles, reorder defaults. ⚠️ `setting_values` is RLS-exempt.                                                               |
| Documents + storage                                   | `@rcln/documents`, `@rcln/storage`, `files`, `DocumentType`    | Complete                  | Dispensing labels and GRN PDFs.                                                                                                                                  |
| Clinical taxonomy tree (`parent_id`, no depth column) | `TaxonomyNode`                                                 | Complete                  | The precedent for product categories. Same shape, do not invent a second.                                                                                        |
| Web shell, `(tenant)/t/[slug]/(app)/…`                | `apps/web`                                                     | Complete                  | All new screens go here.                                                                                                                                         |
| `formatClinicTime` and friends                        | `apps/web/src/lib/format.ts`                                   | Complete                  | Invariant 6. Never a bare `toLocaleString()`.                                                                                                                    |

### Permission codes that already exist

Defined in `packages/permissions/src/codes.ts` and seeded. **They exist but
nothing is gated by them, because nothing is built.**

```
pharmacy.medicine.read          pharmacy.medicine.manage
pharmacy.dispense.read          pharmacy.dispense.create
pharmacy.dispense.return
pharmacy.supplier.manage
pharmacy.purchase_order.read    pharmacy.purchase_order.manage
pharmacy.goods_receipt.manage
inventory.stock.read            inventory.stock.adjust
inventory.stock.transfer        inventory.batch.manage
report.inventory.read
```

Gaps against what this architecture needs: no product/regulatory/consumption/
recall/quarantine codes. See [SECURITY_AND_AUDIT.md](SECURITY_AND_AUDIT.md) for
the proposed additions and PI-ADR-011 for the `pharmacy.medicine.*` question.

---

## What does not exist

| Missing                                                                                                  | Consequence for this programme                                                                                                                                                                                             |
| -------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Every table in this programme** — products, inventory, batches, suppliers, POs, dispensing, regulatory | This is greenfield. Nothing to migrate, nothing to break.                                                                                                                                                                  |
| **`prescriptions`**                                                                                      | ✅ **Resolved (CE-4).** It arrived as `encounter_prescriptions` — a consultation's medication lines rather than a document of its own — and PI-7 dispenses against those.                                                  |
| **`encounters` / `procedures`**                                                                          | ⛔ **Hard-blocks PI-9 (clinical consumption).** Same owner. The consultation page is a route with a placeholder.                                                                                                           |
| Veterinary patient support                                                                               | ✅ **Resolved (PI-11).** `patients.subject_type` + `animal_profiles` existed from CE-1 and were unreachable; PI-11 wired them end to end, added the `SPECIES_RESTRICTION` rule type and weight-based dosing. No new table. |
| Worker processors                                                                                        | Every BullMQ queue is registered; only stubs consume them. Expiry sweeps and reorder alerts need a real processor (PI-2 / PI-22).                                                                                          |
| Notification delivery                                                                                    | Logging stub only. Expiry and recall alerts will queue but not deliver until Phase 7 cross-cutting lands.                                                                                                                  |
| Any regulatory concept anywhere                                                                          | `country_code` / `region_code` exist **only for tax**. There is no jurisdiction, authority or rule concept in the codebase.                                                                                                |

---

## Where this programme sits against the repository roadmap

`.kb/STATUS.md` calls this **Phase 5 — Pharmacy and inventory**, currently
unstarted, with a five-line plan. This programme supersedes those five lines and
is far larger in scope (global, multi-domain, regulatory). `.kb/STATUS.md`
should be updated to point at this directory when PI-1 starts.

The repository is at: Phase 0 ✅, Phase 1 ✅ (bar legal sign-off), Phase 2 ✅
(bar usage enforcement/notifications/tax), Phase 3 in progress, Phase 4 (patient
billing) partly landed — the invoice engine, tax registrations and appointment
invoicing all work end to end.

**PI-1 through PI-6 can start today** and do not touch anything Phase 3 owns.

---

## Test and validation state

Nothing to report — no code. Baseline at time of writing, from `.kb/STATUS.md`:
338 API tests green, `db:rls:check` green at 22 protected tables. Every phase of
this programme must leave both green.
