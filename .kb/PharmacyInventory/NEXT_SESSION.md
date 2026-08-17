# Next Session

**Read this first.** Updated at the end of every session.

**Written:** 2026-08-17 · **By:** session PI-8 (Billing & Tax Integration)

---

## What we are building

A global, extensible **Product + Inventory + Pharmacy + Clinical Consumption +
Procurement + Regulatory platform** for rcln. Not a pharmacy module — shared
infrastructure that clinical, pharmacy, dental, lab, procedural and veterinary
workflows all sit on. Ten target countries via jurisdiction rule packs.

Full orientation: [README.md](README.md).

---

## What has already been completed

**PI-0** Discovery. **PI-1** Product platform core (PR #30). **PI-2** Inventory
foundation (PR #31). **PI-3** Movements (PR #32). **PI-4** Procurement (PR #33).
**PI-5** Regulatory framework (PR #34). **PI-6** India rule pack (PR #35).
**PI-7** Pharmacy dispensing. **PI-8** Billing & tax integration —
`feat/pi-8-billing-tax-integration`, **COMPLETE**. ⚠️ Not committed and **not
reviewed**: the owner is running `/code-review` and `security-reviewer` manually.
Nothing else should start until that lands.

---

## What was changed in this session

| Area        | What landed                                                                                                                                                                                             |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Leftovers   | **KNOWN_ISSUES #5, #8 and #9 all closed**, as the last session said they had to be before any pack is signed off                                                                                        |
| Schema      | `charge_policy_rules`, `product_prices`, `charge_requests`, `membership_professional_registrations`; `invoices.kind` + `.credited_invoice_id`; the endorsed-repeat columns on `encounter_prescriptions` |
| Migration   | `20260901090000_billing_tax_integration` — 10 CHECKs, 2 partial uniques, 13 policies                                                                                                                    |
| RLS         | `db:rls:check` green at **121** (was 118)                                                                                                                                                               |
| Permissions | `billing.charge_request.read` / `.manage` and `billing.charge_policy.manage` are new. Pricing reuses `billing.fee_schedule.manage`                                                                      |
| Engine      | **The credit-note engine** — an `invoices` row with `kind: CREDIT_NOTE` and its own `CRN-` series. `billing.credit_note.issue` is finally reachable                                                     |
| Services    | `services/charging/*` · `services/invoicing/{charge-billing,credit-note}.service.ts` · `regulatory/actor.service.ts`                                                                                    |
| Screens     | 3, under `/charges`, plus the credit-note action on the invoice detail. The charge queue is the one that matters                                                                                        |

---

## Decisions taken this session that a later phase must not undo

**1. A credit note is an `invoices` row, not a parallel set of tables.** It has
exactly the invoice's immutability requirement, so it gets exactly the invoice's
`invoices_lifecycle_guard` by being the same table. What the law requires is a
separate SERIES, and that is a period key.

**2. ⚠️ THE LINK BACK IS `charge_requests.invoice_id`, NOT `invoice_item_id`,
AND BILLING_INTEGRATION.md IS WRONG ABOUT THIS.** `finalizeInvoice` re-prices by
DELETING every `invoice_items` row and rewriting it, so an item id changes
between the draft and the document. The first version had the FK and finalisation
raised on it.

**3. A charge request is written in the supply's transaction and can never stop
it.** Every configuration gap is a NULLABLE COLUMN, never an exception. A
pharmacist is not blocked because an accountant has not filled in a grid.

**4. The policy and the price are SNAPSHOTTED on the charge request.** Nothing
re-resolves at invoice time. A clinic that raised its prices on Monday must not
restate Friday's supplies, and `does not restate an existing charge when the
policy changes` is the test that pins it.

**5. `CONTRACT_DEFINED` and `JURISDICTION_CONFIGURED` stop at a human**, because
neither engine exists. They are distinct enum members rather than aliases of
`OPTIONAL` because it is their call sites that change when one lands.

**6. A suppressed charge still gets a row, with a reason.** "We decided not to
charge for this" and "we forgot" are identical in a revenue figure and are
entirely different problems.

---

## Where to start

**⚠️ RUN THE REVIEWS FIRST. PI-8 IS BUILT AND NOT REVIEWED.** `/code-review` and
`security-reviewer` over the whole diff. This one touches the schema, tenancy,
auth, permissions, patient data, billing and raw SQL, so CLAUDE.md makes the
security review mandatory before merge — and it is not a formality: PI-1's review
found two CRITICALs, PI-3's three and PI-5's four, each time one class of mistake
repeated.

Point a reviewer at these first, because they are where the phase took its risks:

- `lockCharges` — an ordered `FOR UPDATE` over a set, guarding an application
  invariant no unique index can express. The PI-3 read-then-write class.
- `assertWithinRemaining` — the credit ceiling is checked BEFORE the note is
  priced, so it is deliberately generous by whatever discount the invoice
  carried. The per-line quantity check is what actually stops over-crediting.
- `raiseChargeRequestsWithin` — runs inside the dispense's transaction and must
  never be able to throw. Every configuration gap is a nullable column.
- The two new `*_visible` policy pairs, and the two closed on `dispense_lines`.

**Then** PI-10 (Recall) or PI-12 (Online Pharmacy), which PI-8 unblocks. PI-9 is
still blocked on `encounters`/`procedures`.

Two things this session deliberately did not take:

- **`INVENTORY` charge requests have no writer.** The engine handles them and the
  isolation suite covers them; the caller is PI-9's clinical consumption.
- **A credit note moves no money.** There is still no `patient_payments` table,
  so `amount_paid` is always zero and `billing.refund.process` remains
  unreachable. That is the next real gap in the billing story.

---

## Files worth reading before touching charging

|                                                                |                                                                        |
| -------------------------------------------------------------- | ---------------------------------------------------------------------- |
| `apps/api/src/services/charging/charge-request.service.ts`     | The two requirements in tension, and how they are reconciled           |
| `apps/api/src/services/charging/policy.service.ts`             | The precedence chain — the only place it is written down               |
| `apps/api/src/services/invoicing/credit-note.service.ts`       | Why a credit note is an invoice row, and the four things it refuses    |
| `apps/api/src/services/invoicing/charge-billing.service.ts`    | Why it composes nothing, and the `invoice_item_id` correction          |
| `packages/db/prisma/schema/charging.prisma`                    | The two tenancy classes, and why the item id is not the link           |
| `apps/api/tests/integration/charging.test.ts`                  | The glove and the implant, the snapshot case, the credit-note refusals |
| `apps/api/tests/integration/tenant-isolation/charging.test.ts` | The nullable branch predicate, in BOTH directions                      |

---

## Known issues

The full list is [KNOWN_ISSUES.md](KNOWN_ISSUES.md). The ones this session
created or inherited:

**1. Nothing has been clicked in a browser.** Three more screens, same as every
phase before it.

**2. `pnpm test` still OOMs the api container** when turbo runs everything
together. Run unit, then tenant-isolation, then the integration files in groups
of roughly a dozen. ⚠️ **Add `--forceExit`** — jest holds open handles and a
piped run otherwise hangs after the results are printed. Unchanged since PI-4.

**3. ⚠️ `prisma migrate reset` IS NOT `pnpm db:reset`, AND USING THE RAW COMMAND
COST THIS SESSION AN HOUR.** The package script is
`migrate reset && apply-grants && seed`. The raw command skips both, and the
symptom is every tenant-isolation suite failing with `relation "audit_logs" does
not exist` — because `rcln_app` has no grants, not because anything is missing.

**4. `CONTRACT_DEFINED` and `JURISDICTION_CONFIGURED` resolve to a human.**
Accepted debt, recorded.

**5. The charge-policy category tier walks no ancestry.** Stated in the resolver,
because the opposite is the natural assumption.

**5a. A `QUANTITY_LIMIT` still resolves `UNDETERMINED` in two cases**, and both
are deliberate: two applicable rules with DIFFERENT windows (one scalar cannot
serve two periods, and guessing either way is wrong in one direction), and a
counter sale with no patient (no history to sum; zero would let anyone take the
limit again every visit). Everything else is now counted — see
`tests/integration/quantity-limit.test.ts`.

**5b. The prior-quantity sum is bounded by the caller's BRANCH SCOPE.** RLS makes
it so: `dispenses.branch_isolation` is RESTRICTIVE, so a pharmacist scoped to one
site sums only that site and under-counts a patient collecting from two branches
of one clinic. Fixing it means widening a tenant context, which is not a trade
worth making for this; recorded in `priorQuantitySupplied`.

**6. `regulatory.pack.approve` is still held by nobody**, which is correct
(OD-5). Until somebody holds it, no decision anywhere enforces.

---

## Tests

|                        |                                                                                                                                                                                               |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Currently passing**  | **631 api unit + isolation across 35 files** · **1 026 integration across 47 files** · 79 `@rcln/regulatory` · 35 `@rcln/invoicing`. Lint and typecheck green across all 45 tasks; RLS at 121 |
| **Currently failing**  | None.                                                                                                                                                                                         |
| **Migrations pending** | None. One applied this session                                                                                                                                                                |

⚠️ **THE SUITE CANNOT BE RUN IN ONE GO.** Run unit, then tenant-isolation, then
the integration files in groups, all with `--forceExit`.

⚠️ **The process traps from PI-1 onwards all still apply.** Migrations replay in
NAME order and this repository's are hand-dated ahead of the wall clock.
`prisma migrate diff` wants `--from-config-datasource --to-schema ./prisma/schema
--script`, prints a dotenv banner to STDOUT that has to be stripped — **and it
still wants to DROP the two NOT NULLs CE-4 added by hand.** Delete those two
statements from anything it generates; PI-7's and PI-8's migration headers both
say so.

⚠️ **Prisma emits `@@unique` as a unique INDEX, not a table constraint.** A
`NULLS NOT DISTINCT` rewrite therefore needs `DROP INDEX` + `CREATE UNIQUE INDEX`,
not `ALTER TABLE ... DROP CONSTRAINT`, which raises 42704. Keep the index NAME
identical or every future `migrate diff` proposes renaming it back.
