# Known Issues

Defects, gaps and debts in **this programme**. Repository-wide issues live in
[`.kb/15_Known_Issues_and_Technical_Debt.md`](../15_Known_Issues_and_Technical_Debt.md)
and [`.kb/Architecture/PITFALLS.md`](../Architecture/PITFALLS.md).

**Last updated:** 2026-08-24 (PI-21)

---

## Defects

⚠️ **PI-8's reviews found three CRITICALs and two HIGHs. All are fixed**,
including #13 and #14 below, which were left open in the first pass and closed in
a second. What each turned out to be is in [CHANGELOG.md](CHANGELOG.md).

⚠️ **NEITHER PI-9 NOR PI-10 HAS BEEN REVIEWED AT ALL.** Nothing below reflects a
review of either, because none has been run. The entries they add (#15–#18 and
#19–#22) are gaps they know about and recorded themselves, which is a different
and weaker thing than a review finding.

| #   | Item                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | Severity | Mitigation |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | ---------- |
| 13  | ~~**A credit note can name the wrong DISTRIBUTION across lines.**~~ **CLOSED.** `invoice_items.credited_invoice_item_id` links a note's line back to the line it reverses, and `creditedPerLine` sums it across every LIVE note in one `groupBy`, so the per-line cap is cumulative. ⚠️ The column is carried through `StagedLine` and rewritten on every reprice — finalisation always re-prices, and a column set once at creation is NULL by the time the note becomes a document. That is precisely what made `charge_requests.invoice_item_id` unusable, and a test asserts the link survives finalisation. ⚠️ It is deliberately NOT covered by a CHECK: the rule it wants is "non-null only when the parent's kind is CREDIT_NOTE", which is a fact about another row. | CLOSED   | —          |
| 14  | ~~**`raiseChargeRequestsWithin` is a 5-query N+1 inside the posting transaction.**~~ **CLOSED.** Five queries regardless of line count: one `findMany` for the products, then `resolveChargePoliciesWithin` / `resolveProductPricesWithin` / `resolveTaxCategories` in parallel, then one `createMany`. ⚠️ Every batch resolver is the SAME function the single-product path uses, with the singular delegating to it — a second copy of the tax precedence rule is exactly how PI-1's `NULLS LAST` CRITICAL comes back.                                                                                                                                                                                                                                                      | CLOSED   | —          |

| #   | Item                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | Severity                                                                               | Mitigation                                                                                                                                                                                                         |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | ~~**`stock_transfer_lines` renders in a nondeterministic order.**~~ **CLOSED IN PI-8**, which is the session the entry's own mitigation asked for — `transfer.service.ts` now orders `[{ createdAt: 'asc' }, { id: 'asc' }]`. Original text: **`stock_transfer_lines` renders in a nondeterministic order.** `transfer.service.ts` orders its lines `{ createdAt: 'asc' }`, and `createMany` gives every line of one document the same `created_at` — so a transfer's lines can appear in a different order on each read. Found in PI-4, where the identical bug in the four new document services made a landed-cost assertion fail; fixed there with an `{ id: 'asc' }` tie-break and NOT fixed in PI-3's file, because that is outside PI-4's diff and no PI-3 suite asserts line order.                                                              | LOW                                                                                    | One line: add `{ id: 'asc' }` to the `lines` `orderBy` in `transfer.service.ts`. Do it in the next session that touches transfers.                                                                                 |
| 2   | **`pnpm test` OOMs the api container outright.** PI-3 recorded this for `pnpm validate` when turbo ran tasks in parallel; adding PI-4's two suites tipped the api project itself over the 3 GB heap. `pnpm exec turbo run typecheck\|lint` still pass at `--concurrency=1`, and the api suite has to be run in slices by path.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | MEDIUM — it makes "run the tests once at the end" impractical                          | Raise the container's memory limit, or set `--maxWorkers=1` plus `--workerIdleMemoryLimit` in `apps/api/jest.config.ts`. It is masking real failures behind a crash, which is the part that matters.               |
| 3   | ~~**A prescriber-endorsed repeat cannot be expressed.**~~ **CLOSED IN PI-7, IN THE FRAMEWORK, AS THIS ENTRY REQUIRED.** `PresentedPrescription` gained `repeatsAuthorised` + `repeatsAuthorisedLimit`, `RefillRuleParameters` gained `endorsedRepeatsPermitted` + `maxEndorsedRepeats`, and `IN-REPEAT-*` now carries the second key. The rule was not weakened: absent endorsement still refuses, and an endorsement stating no number resolves `UNDETERMINED` — which refuses — rather than being read as unlimited. **The successor is #8.**                                                                                                                                                                                                                                                                                                          | CLOSED                                                                                 | —                                                                                                                                                                                                                  |
| 4   | ~~**The Pharmacy Act s. 42 proviso is not modelled.**~~ **CLOSED IN PI-7.** `RegulatoryActor` gained `isPrescriber`, derived by the service from the encounter's prescriber and `ctx.userId` and never accepted from a client; `AuthorityParameters` gained `exemptWhenActorIsPrescriber`, and `IN-DISPENSER-REGISTERED-PHARMACIST` opts in. It exempts nobody else: an actor holding no licence under a rule that names one is still refused, and that case is pinned.                                                                                                                                                                                                                                                                                                                                                                                  | CLOSED                                                                                 | —                                                                                                                                                                                                                  |
| 5   | ~~**A stock movement evaluates with an EMPTY actor.**~~ **CLOSED IN PI-8.** `CatalogueActionOptions` gained `roleCodes`; `procurement.routes.ts` and `inventory.routes.ts` resolve the caller's effective permissions in an `actorMeta()` helper used by exactly the two endpoints that consult the engine, and `consultForStockMovement` passes them through `regulatoryActorWithin`. Original text: **A stock movement evaluates with an EMPTY actor.** `consultForStockMovement` passes `roleCodes: []` because neither `goods-receipt.service.ts` nor `transfer.service.ts` is given the caller's effective permissions — they take a `CatalogueActionOptions` carrying an IP and a user agent and nothing else. A `PHARMACIST_AUTHORITY` or `IMPORT_RESTRICTION` rule aimed at `STOCK` or `TRANSFER` would see an actor holding nothing and refuse. | LOW — latent: no pack has such a rule, and nothing enforces below `PRODUCTION_ENABLED` | Plumb the caller's effective permission codes down to these services. Do it before any pack is signed off, not after.                                                                                              |
| 6   | **Nothing in CI proves the PDF header/footer repeat on every page.** Repetition and the "Page 1 of 5" count are properties of Chromium's printer, not of the HTML, so `packages/documents/tests/chrome.test.ts` cannot see a regression. This is not theoretical: the first implementation used `position: fixed`, which drops the footer from page one and the header from the last page, and every markup assertion passed against it. The worker's Chromium comes from the Alpine base image, so it moves on a `docker build` with no lockfile change.                                                                                                                                                                                                                                                                                                | MEDIUM — silent: PDFs would simply lose their chrome                                   | `apps/worker` has no test harness at all. Add jest + ts-jest there and one test that renders `renderInvoiceHtml(longInvoice(60))` through `renderPdf` and asserts the clinic name and `Page N of M` on every page. |
| 7   | **`tax-registration-coverage.test.ts` is flaky in a full run.** "and Gaya's invoices move to the new number while Patna's do not" fails on roughly half of full `jest` runs and passes every time the file is run alone, so it is cross-suite interference rather than a defect in the assertion — most likely another suite's tax registrations or organization jurisdictions leaking into the resolver's view. Seen repeatedly while working on the document templates, which cannot affect it.                                                                                                                                                                                                                                                                                                                                                        | LOW — noise, but it trains people to re-run rather than read a red test                | Find the suite it collides with (run pairs under `--runInBand`), then isolate the fixture — most of these suites already scope by a per-run slug and this one appears not to.                                      |

| 8 | ~~**An endorsed repeat still refuses.**~~ **CLOSED IN PI-8**, as this entry required: `encounter_prescriptions` gained a nullable `repeats_authorised` + `repeats_authorised_limit`, written by the prescriber through `encounter-content.service.ts` and read in `dispense.service.ts` at the plug-in point PI-7 marked. ⚠️ NULL is still not `false` — silence is not a refusal — and a `true` with no limit still resolves `UNDETERMINED`. Original text: **An endorsed repeat still refuses, because the CLINICAL record cannot carry the endorsement.** #3 closed the framework half: the engine can now be told that a prescriber endorsed a repeat and how many. Nothing tells it, because `encounter_prescriptions` (CE-4) has a quantity and a duration and no field saying "may be dispensed twice". `dispense.service.ts` therefore omits `repeatsAuthorised` — and absent is deliberately not `false`. | MEDIUM — a lawful endorsed repeat is refused, in the safe direction | A nullable `repeats_authorised` + `repeats_authorised_limit` on `encounter_prescriptions`, written by the prescriber in the consultation. The plug-in point is commented in `dispense.service.ts`. Clinical work, not pharmacy's. |
| 9 | ~~**The actor's professional registrations are never supplied.**~~ **CLOSED IN PI-8.** `membership_professional_registrations` hangs off `memberships` in the `parent_scoped` RLS loop, and `regulatory/actor.service.ts` reads it into `RegulatoryActor.licenceTypes` AS AT THE MOMENT OF THE ACT — status `ACTIVE` **and** an unexpired date, so a lapsed licence stops counting on the day it lapsed rather than the day somebody notices. Original text: **The actor's professional registrations are never supplied.** `RegulatoryActor.licenceTypes` is empty on every call, because nothing in the schema records that a member holds one — `doctor_profiles.registration_number` is the closest thing and it is a doctor's. A `PHARMACIST_AUTHORITY` rule naming a licence therefore resolves `UNDETERMINED`, which refuses. India's is satisfied through the s. 42 proviso only where the actor IS the prescriber. | MEDIUM — latent: nothing enforces below `PRODUCTION_ENABLED` | A professional-registration table hung off `memberships`, read into the actor. Must land before any pack is signed off, alongside #5. |
| 10 | ~~**`priorQuantityInPeriodBase` is never supplied on a supply.**~~ **CLOSED IN PI-8, AND NOT THE WAY THIS ENTRY EXPECTED.** The mitigation said "one query" and understated it: the window is `periodDays` on the RULE, so a caller cannot know it until after evaluation, and `@rcln/regulatory` is pure by design (PI-ADR-007) so it cannot look the history up itself. The fix turns the VALUE into a LOOKUP — `EvaluationSupplements.priorQuantityInPeriod(windowDays)`. `evaluateWithin` selects the applicable rules with the engine's own `selectApplicableRules`, reads the window off them and calls back into `consultForSupply`, which is the only party that knows who the supply is for. ⚠️ TWO RULES WITH DIFFERENT WINDOWS STILL RESOLVE `UNDETERMINED`: one scalar cannot serve two periods, the longer over-counts and refuses lawfully, the shorter UNDER-counts and PERMITS what the law forbids — so it refuses. ⚠️ A sale with NO PATIENT also stays `UNDETERMINED`; zero would let anyone take the limit again every visit. Pinned by `tests/integration/quantity-limit.test.ts` (8 cases). Original entry: **`priorQuantityInPeriodBase` is never supplied on a supply.** A `QUANTITY_LIMIT` with a period therefore resolves `UNDETERMINED` rather than counting what the patient has already had — which is correct behaviour (the engine refuses to guess) and an unimplemented feature. India writes no quantity limit, so nothing exercises it today. | LOW — latent | Sum `dispense_lines` for the patient and product inside the rule's window, in `consultForSupply`. One query; the index `(organization_id, patient_id, dispensed_at)` is already there. |
| 11 | ~~**Supplying a substitute is API-only.**~~ **CLOSED IN PI-8.** The dispensing workspace gained a "Hand over" picker per line, fed by equivalents fetched ON THE SERVER with the plans — each option labelled with what the engine said about substituting THAT product HERE, in the option text rather than beside it, and a required reason. ⚠️ THE LOAD-BEARING PART: a substituted line sends **no allocations**. The lots on screen were planned for the PRESCRIBED product and are meaningless for the substitute, so the server runs `planStockAllocationWithin` against the product actually being supplied. `substitutionCandidate` gained `baseUnitId` for the same reason — sending the prescribed product's unit for a different product converts against the wrong graph. Original entry: **Supplying a substitute is API-only.** A dispense line carries `substitutedForProductId`, a reason and an `isSubstitution` evaluation, and the equivalents screen shows what the law says about each candidate — but the workspace supplies what was prescribed and has no control for swapping the product. | LOW — the safe half shipped | A product swap on the workspace line, carrying the reason into the existing fields. No API change needed. |
| 12 | ~~**The pharmacy dashboard counts "today" in UTC.**~~ **CLOSED IN PI-8.** `dashboard.service.ts` now resolves the branch-local midnight as an instant in SQL — `date_trunc('day', now() AT TIME ZONE b.timezone) AT TIME ZONE b.timezone` — the way `inventory_branches_with_expired_stock` does. Original text: **The pharmacy dashboard counts "today" in UTC.** `dispensedToday` and `returnsToday` straddle midnight wrongly for a clinic several hours off UTC. Invariant 6's exception list is short and this is on it: the expiry SWEEP resolves the branch's own day in SQL because a lot expiring has consequences, and a count on a dashboard does not. | LOW — cosmetic, counts only | `AT TIME ZONE b.timezone` in `dashboard.service.ts`, the way `inventory_branches_with_expired_stock` does it. |

**Fixed in PI-8:** Seven gaps in earlier phases, plus one of its own. The first
was PI-8's and is the one worth remembering:

0. **PI-8 shipped a comment describing code nobody had written.**
   `product-price-list.tsx` asserted that a price is set from the product screen;
   no such control existed, `saveProductPriceAction` was wired to nothing, and the
   entire charging flow was unusable from a browser because every charge came out
   unpriced with nowhere to fix it. The reasoning in the comment was right and is
   what got built — a `Price` tab on the product panel. The failure mode to
   recognise again is a comment that documents an intention as though it were an
   implementation.

Then, in earlier phases:

1. **`dispense_lines` carried no `product_visible` or `unit_visible` policy** —
   the KI-3 class, on the most PHI-dense table in the programme. A clinic could
   attach another clinic's PRIVATE product to its own dispense line and read the
   name back through the join the detail screen makes. `encounter_prescriptions`
   has had the policy since CE-4 for the identical plain FK, which is what makes
   PI-7's omission an oversight rather than a decision.
2. **`regulatory_decisions`' append-only REVOKE was undone by every `db:reset`.**
   The migration revokes UPDATE and DELETE; `ALTER DEFAULT PRIVILEGES` re-grants
   them on the next reset, and the isolation case only fails AFTER one — which is
   why PI-7 shipped green. Now restated in `grant-app.sql` beside every other
   append-only table, which is exactly what that file's header says it is for.
3. **`tests/integration/tenant-isolation/inventory.test.ts` was not idempotent
   against a crashed run**, leaving a `users` row that made every later run fail
   on `users_email_key`.
4. **#1** — `stock_transfer_lines`' nondeterministic order, taken because PI-8
   touched `transfer.service.ts`, which is exactly what the entry asked for.
5. **#12** — the pharmacy dashboard's UTC "today".
6. **#10** — the unanswerable quantity window, turned into a lookup.
7. **#11** — supplying a substitute, which had no screen.

**Fixed in PI-6:** `evaluateFor` derived a location's controlled access from its
storage profile alone, ignoring `inventory_locations.requires_controlled_access`.
A cabinet a clinic marked controlled but hung no profile on read as an open
shelf, so a `controlledAccessRequired` rule refused a receipt into the very place
the clinic set up for it. It failed SAFE, which is why it was invisible — it
presented as the rule being too strict rather than as a column being ignored.

---

## Blockers

### KI-1 — `prescriptions` does not exist · blocks PI-7

**Severity: high · Owner: Phase 3 (Core clinical) · Status: open**

Pharmacy dispensing has nothing to dispense against. Phase 3 is mid-flight —
station 1 stage 5 of 5 is pending (queue tokens and walk-in) and prescriptions
come after it.

**Mitigation:** PI-1..PI-6 and the counter-sale half of PI-8 do not depend on it
and proceed. **Do not build against a guessed prescription shape** — that
guarantees rework in the highest-risk workflow in the programme.

### KI-2 — `encounters` / `procedures` do not exist · blocks PI-9

**Severity: high · Owner: Phase 3 · Status: open**

Clinical consumption has no anchor. The consultation page is currently a route
with a deliberate placeholder where the specialty-specific diagnosis form will
go.

**Mitigation:** same. Consumption templates could technically be built against
the clinical taxonomy alone, but the consumption _record_ needs the anchor, so
splitting the phase buys little.

---

## Risks

### KI-3 — The RESTRICTIVE visibility policy is easy to omit

**Severity: high (security) · Status: mitigated by documentation only**

Every join table pointing at a platform-extensible parent needs its own
RESTRICTIVE `*_visible` policy. `tenant_isolation` constrains the child side and
says nothing about the parent side. Omit it and a tenant attaches another
tenant's private product to its own row and reads the name back out.

**`db:rls:check` cannot detect this** — the table has a policy, just not enough
of one.

**Mitigation:** an explicit test per join table (see
[TESTING_STRATEGY.md](TESTING_STRATEGY.md) PI-1), `security-reviewer` on every
phase, and this entry.

### KI-4 — `setting_values` is RLS-exempt

**Severity: medium (security) · Status: inherited, documented**

The explicit `(scopeType, scopeId)` pair every read passes is the only tenant
isolation there is, and `db:rls:check` can never notice a missing one. This
programme will add several settings (expiry thresholds, receipt tolerances, FEFO
overrides).

**Mitigation:** every new setting read passes the pair explicitly and has a test
proving cross-tenant reads fail. PI-ADR-015.

### KI-5 — The expiry sweep is the repository's first real worker processor

**Severity: medium · Status: open**

Every BullMQ queue is registered and only stubs consume them. PI-2.8 needs a
real processor, so PI-2 carries the cost of proving the worker path works at
all — retries, idempotency, failure visibility.

**Mitigation:** budget for it in PI-2, and keep the processor trivially
idempotent: moving already-`EXPIRED` stock to `EXPIRED` must be a no-op.

### KI-6 — Notification delivery is a logging stub

**Severity: low · Status: inherited**

Expiry, low-stock and recall alerts will queue but not deliver until Phase 7
cross-cutting lands. **Do not build a second notification path.**

### KI-7 — `stock_ledger` will need partitioning

**Severity: low now, high later · Status: designed for, not implemented**

It grows without bound. Prisma cannot declare a partitioned table, so this is a
hand-written migration later — the same note `audit_logs` and
`data_access_logs` already carry.

**Mitigation:** put the note in the model comment when the table is created, and
index for the traceability queries from day one.

### KI-8 — Regulatory data quality is the programme's largest non-technical risk

**Severity: high · Status: structurally mitigated**

Ten jurisdictions of pharmacy regulation is a research problem, not a coding
problem, and a wrong rule is invisible until it matters.

**Mitigation:** `regulatory_rule.source_id` is NOT NULL; maturity states; the
matrix defaults to `RESEARCH_REQUIRED`; and no agent may mark a pack reviewed.
**No agent generates regulatory or medicine data from memory.**

### KI-9 — Product catalogue data has no source

**Severity: high · Status: open, needs a decision**

See [OPEN_DECISIONS.md](OPEN_DECISIONS.md) OD-4. PI-1 currently ships an empty
catalogue.

⚠️ **Generating medicine data from a model is prohibited.** A hallucinated
strength or composition in a dispensing system is a patient-safety defect that
looks entirely plausible.

---

## Debt accepted deliberately

| Item                                                                             | Why                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | Revisit                                                                                                                      |
| -------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| No i18n for product names                                                        | The repository has no i18n framework; a JSONB name map now would be hard to undo                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | OD-3, before PI-19                                                                                                           |
| No input-tax-credit handling                                                     | Purchase tax is recorded, not computed; ITC is an accounting subsystem                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | Post PI-24                                                                                                                   |
| No insurance/payer contract engine                                               | `CONTRACT_DEFINED` charge policy is modelled and, as of PI-8, RESOLVES TO A HUMAN DECISION exactly as `OPTIONAL` does. `JURISDICTION_CONFIGURED` is the same shape for the same reason. Kept as distinct enum members because the REASON the desk is being asked differs, and because it is their call sites that change when an engine lands — not `OPTIONAL`'s                                                                                                                                                                                                                                                                                                                  | When claims land                                                                                                             |
| No patient payments, so a credit note moves no money                             | PI-8 built the credit-note DOCUMENT — its own `CRN-` series, its own number, the original invoice untouched — and there is still no `patient_payments` table, so `invoices.amount_paid` is always zero and the refund itself is unimplemented. `billing.refund.process` is the code already seeded for it. This is `voidInvoice`'s honest boundary moved one step forward                                                                                                                                                                                                                                                                                                         | When payments land                                                                                                           |
| The charge-policy category tier walks no ancestry                                | A rule on "Antibiotics" does not reach a product filed under its child "Penicillins". `product_categories` is a recursive tree with no depth limit, an ancestry walk is a recursive CTE per line inside the posting transaction, and "which ancestor won?" is unanswerable from the screen. A clinic covers a subtree with a type rule or one rule per category                                                                                                                                                                                                                                                                                                                   | If a clinic asks for it                                                                                                      |
| No consignment stock workflow                                                    | `LocationKind.CONSIGNMENT` exists; the ownership model does not                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | PI-22+                                                                                                                       |
| No multi-currency procurement conversion                                         | A PO in USD received into an INR branch stores both; no FX policy. **PI-4 made this explicit rather than fixing it**: a price-book row in a different currency from the order is REFUSED with a sentence, a return of a lot bought in another currency records no value, and `product_cost_averages` is keyed BY currency so one product can honestly have two averages at one branch                                                                                                                                                                                                                                                                                             | PI-22                                                                                                                        |
| `pharmacy.supplier.*` and `pharmacy.purchase_order.*` are under the wrong prefix | Under PI-ADR-001 procurement is not a pharmacy concern — a dental store manager requisitions filling material. PI-4's own two codes are `procurement.requisition.*`, and the three older ones were NOT renamed: a rename revokes a grant from every clinic that already holds it, silently. The route PATH is neutral (`/v1/procurement/*`)                                                                                                                                                                                                                                                                                                                                       | Whenever a permission-migration mechanism exists                                                                             |
| A pharmacist can commit money with no requisition                                | They hold `pharmacy.purchase_order.manage`, which predates PI-4's approval split, so they can raise and issue a PO directly. Not widened by PI-4 and not silently narrowed either                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | A clinic narrows it today by cloning the role                                                                                |
| No supplier READ permission                                                      | Reads on `/v1/procurement/suppliers` sit behind `pharmacy.supplier.manage`, because inventing `pharmacy.supplier.read` now would be a code no existing clinic holds — every supplier picker would come back empty for everybody until each clinic re-granted it. The shape to aim at is the inventory router's, where reads sit behind one read code                                                                                                                                                                                                                                                                                                                              | Alongside the prefix rename above                                                                                            |
| `charge_requests` / `regulatory_decisions` unarchived                            | They grow with volume                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | PI-24                                                                                                                        |
| 15                                                                               | ~~**PI-9.9 is half done: nothing lets a clinician CHOOSE which serial.**~~ **CLOSED.** The consumption panel offers the candidate lots — and, for a serialised product, the individual numbered devices — with FEFO's proposal pre-filled and a reason required for anything else. ⚠️ Building it uncovered TWO defects that were also live in PI-7's dispensing path: the candidate check was narrowed to what FEFO would take (so every override was refused), and assigning a serial to a patient violated `serials_assignment_dated` (a 500 on every serialised supply). Both fixed in both services, each with a regression test verified to fail against the reverted code. | CLOSED                                                                                                                       | —                                                                                                                                                             |
| 16                                                                               | **The consultation page's consumption panel plans against the VISIT, not a procedure.** `GET /v1/consumption/plan` takes an `encounterProcedureId` and the service uses it to find the template in force; that screen reaches a record by encounter id and has no procedure selected, so it anchors to the encounter and pre-fills nothing. A dental workflow wants the procedure.                                                                                                                                                                                                                                                                                                | MEDIUM — the template pre-fill, which is the point of the feature, is unreachable from the one screen that renders the panel | A procedure-anchored panel belongs inside the consultation engine, beside the procedure it is about. PI-9 deliberately did not reshape that component.        |
| 17                                                                               | **An amendment re-raises a line's charge request by DELETING the old one.** `charge_requests_one_per_consumption_line_key` allows exactly one row per line, so a restated quantity cannot simply add a second — and the billed quantity is derived by the charge engine from the unit graph, so recomputing it here would duplicate that arithmetic. The row is deleted and re-raised instead, which loses the original row's `created_at`. Only reachable while the consultation is open and nothing has been invoiced, both asserted.                                                                                                                                           | LOW — a charge request that never reached a bill and never will                                                              | If it matters, add a `SUPERSEDED` status rather than deleting. Flagged for the review because "delete a charge request" reads alarming even where it is safe. |
| 18                                                                               | **`pnpm typecheck` now OOMs the container too**, exit 137, the same way `pnpm test` has since PI-4. It has to be run package by package. Issue #2 covers the test half; this is the same cause and the same fix.                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | MEDIUM — it makes the documented "typecheck only" verification step impractical                                              | Raise the container's memory limit, or `--concurrency=1` on the turbo run.                                                                                    |

| 19 | ~~**A serialised lot could not be held or recalled at all.**~~ **CLOSED IN PI-10, AND IT HAD BEEN LIVE SINCE PI-2.** `recordMovementIn` refuses a movement of a `SERIAL` / `LOT_AND_SERIAL` product that names no serial, and `setBatchHold` selected the lot's balance rows without `serial_id` and passed none — so `POST /batches/:id/hold` raised "this product is serial-tracked, so every movement of it must name a serial number" for every implant in the clinic, and pulled nothing. Nothing in the inventory suite had ever held a serialised lot, so it shipped. ⚠️ The serials now follow the lot's status too: without that a recalled implant read `IN_STOCK` on the serial screen while its quantity sat in the RECALLED bucket, and the screen a theatre nurse looks at is the one that said yes. `ISSUED` serials are untouched — that device is in a patient. **The regression test was verified to fail against the reverted code.** | CLOSED | — |
| 20 | **The affected-party list is unioned and paginated IN MEMORY.** It is the union of `dispense_allocations` and `consumption_allocations`, two tables with different shapes; a database-side union needs raw SQL over both. The set is bounded by what one lot can reach — a lot of a thousand strips dispensed thirty at a time is a few dozen rows. | LOW — latent, and bounded | A raw `UNION ALL` with a keyset cursor, if a clinic ever produces a lot with tens of thousands of supplies. Written down in `trace.service.ts` rather than left to be discovered. |
| 21 | **The head count on the notice screen sums per-lot traces, so it double-counts a person who received two recalled lots.** It is an upper bound; the screen says "received one of these lots" rather than claiming a distinct headcount, and the exact figure is the affected list's own total — available only to somebody holding `recall.trace.patients`. | LOW — the figure a storekeeper sees is conservative in the safe direction | One trace call per notice rather than per lot, if PI-22 gives the trace a multi-lot subject. |
| 22 | **A recall blocks today's stock, not tomorrow's delivery.** A lot of the same manufacturer's number received AFTER the notice is a new `batches` row and is not automatically held: lot uniqueness is tenant- and branch-qualified, so the same printed number legitimately arrives twice. | MEDIUM — a clinic that keeps ordering during a recall re-stocks the recalled run | A lot-number rule at receipt belongs in PI-23 (identifier resolution), which is where a scanned GTIN + lot is turned into a product and a batch. A clinic mitigates today by adding the new lot to the open notice, which the scope screen supports. |

---

## How to use this file

Add an entry the moment something is discovered, not at session end. Include
severity, what it blocks, and the mitigation. Move resolved entries to a
`## Resolved` section with the date and the fix — deleting them loses the reason
the fix exists.

---

## PI-12 (Online Pharmacy)

⚠️ **PI-12 HAS NOT BEEN REVIEWED.** Everything below is a gap the phase knows
about and recorded itself, which is a weaker thing than a review finding.

| #   | Item                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | Severity                                                          | Mitigation                                                                                                                                                                          |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 23  | **An abandoned order keeps its `CONFIRMED` status after the sweep releases its hold.** The reservation sweep works on `expires_at` and knows nothing about `online_orders`, so the order reads as accepted with `heldQuantityBase: 0`. Nothing is unsafe — packing refuses with a 409 naming the hold — but the list is misleading and a clinic cannot filter for it.                                                                                                                                                                                        | LOW — visible, not dangerous                                      | A status the sweep can set, or a derived "hold lapsed" flag on the summary computed from the reservations the detail already reads. The latter is a screen change and no migration. |
| 24  | **A recall cannot reach stock held for an order nobody has packed.** PI-10 walks `dispense_allocations`, so a PACKED parcel IS traced and un-dispensable stock is un-dispensable. An order that is merely `CONFIRMED` holds its lots in the `RESERVED` bucket, which `executeRecall` does not move — so the parcel could still be made up from a recalled lot after the notice was executed. ⚠️ **The most consequential gap this phase leaves.**                                                                                                            | MEDIUM — a recalled lot can reach a patient through an open order | Extend `executeRecall` to release or quarantine `ACTIVE` reservations over the recalled lots, and refuse the pack when a lot is no longer dispensable. PI-22/PI-23 territory.       |
| 25  | **The order form asks a receptionist to type raw UUIDs.** "Patient" and "Consultation" are free-text `Input`s while every other id on the screen is a `Select`, and the hint copy ("The patient's id") names the database's concern rather than the user's, which `apps/web/AGENTS.md` asks against. Same family as the 100-row product picker below it: both are the identifier-resolution debt. ⚠️ It makes the screen effectively unusable by the person it is designed for — worse in practice than the cap, which at least works for a small catalogue. | LOW                                                               | PI-23.                                                                                                                                                                              |
| 25b | **The product picker on the order form is capped at 100.** The same cap every picker in this programme has, and the same answer: PI-23's resolver replaces it.                                                                                                                                                                                                                                                                                                                                                                                               | LOW                                                               | PI-23.                                                                                                                                                                              |
| 26  | **No worker, no notification.** An accepted order tells the patient nothing, and neither does a shipment. The programme has a notification service; this phase wired none of it, because who is told what about a medicine going to a house is a decision nobody has taken.                                                                                                                                                                                                                                                                                  | LOW — a product gap, not a defect                                 | A decision first, then a processor.                                                                                                                                                 |

### ⚠️ The web container OOM-kills at boot, and it is not PI-12's doing

`rcln-web` starts, prints `✓ Ready`, and is killed by the OOM killer within
seconds — `docker inspect` reports `OOMKilled: true` against its `mem_limit: 3g`.
It does this **alone**, with `api` and `worker` stopped, and it does it on a
`git stash`ed tree with none of PI-12 present, so it is an environment or
`next dev` problem rather than anything in this diff.

⚠️ **THE CONSEQUENCE FOR PI-12: THE THREE NEW SCREENS HAVE NOT BEEN RENDERED.**
They typecheck and lint clean and the API behind them is fully exercised, but
nobody has seen them in a browser. Same class as #2 — the compose file asks for
3 g + 3 g + 2 g on a Docker VM with 7.7 GiB — and worth fixing before anyone
believes a screen works because it compiled.

Mitigation: raise Docker Desktop's memory, or drop `web`'s `mem_limit`, or run
`pnpm --filter @rcln/web dev` natively against the containerised API.

### On #2 and #7, both hit again this session

**#2 (`pnpm test` OOMs) reproduced, and there is a working invocation.**
`NODE_OPTIONS="--experimental-vm-modules --max-old-space-size=2560" pnpm exec jest
--workerIdleMemoryLimit=1G` runs the whole api suite in the 3 GB container. The
entry's own mitigation — put those flags in `jest.config.ts` — is still the fix;
this session used them on the command line rather than changing config outside
its diff.

**#7 (`tax-registration-coverage` flake) reproduced exactly as described:** failed
in one full run, passed in the next and passed alone twice. Nothing in PI-12
touches tax registrations. Recorded again because the entry predicts this and the
prediction held.

---

## PI-13a / PI-13 — the rule-pack framework and the US packs

### ⚠️ The framework models "consent required" but not "objection blocks"

`SubstitutionParameters.requiresPrescriberConsent` REFUSES unless the prescriber
has affirmatively agreed. California B&P § 4073(b) has the opposite default:
substitution is permitted, and the prescriber's personally-initialled "Do not
substitute" is what blocks it. `requiresPatientConsent` has the same shape
problem against § 4073(e), which requires the substitution to be **communicated
to** the patient, not agreed by them.

**Consequence:** `CA-SUBST-GENERIC` carries `{ permitted: true }` and puts all
three provisos — the prescriber's objection, the cost test, the communication
duty — in the rule STATEMENT, which is printed to the pharmacist verbatim.
Nothing is machine-checked. Setting either consent key would refuse every lawful
generic substitution in California.

**Fix when somebody needs it:** a `prohibitedByPrescriberEndorsement` key, read
off the prescription the way `repeatsAuthorised` already is. Not built, because
no pack yet needs it checked rather than stated.

### ⚠️ California's labelling rule displaces the federal veterinary caution, silently

`CA-LABEL-DISPENSED` is a `LABELLING_REQUIREMENT` with no product-type narrowing,
so in California it supersedes **every** federal rule of that type — including
`US-LABEL-VETERINARY`, which carries "Caution: Federal law restricts this drug to
use by or on the order of a licensed veterinarian." Federal law plainly still
requires that statement; the engine simply stops mentioning it, because
supersession is per rule type and California carries the type.

⚠️ **The failure is silent and looks like a complete answer.** The decision comes
back `PERMITTED_WITH_CONDITIONS` with a full label field list that is missing one
legally required element, and nothing says so. § 4076(a)(11)(A)(i) exempts
veterinary prescriptions from the physical-description element, which shows
California contemplated veterinary dispensing here and did not purport to
displace the federal caution.

**Fix:** a California veterinary labelling rule carrying both sets of fields.
Needs the state's veterinary labelling provisions read; not done in this pass.

### ⚠️ `PRESCRIBER_AUTHORITY` refuses until callers supply the prescriber's class

The US pack is the first to carry rules of this type. `evaluatePrescriberAuthority`
answers `UNDETERMINED` — which refuses — when `prescription.prescriberClasses` is
absent, so **every US controlled-substance dispense refuses** unless the caller
passes the prescriber's registration class.

This is correct and is pinned by a test rather than treated as a bug: dispensing
a Schedule II drug without establishing DEA registration is the failure US
enforcement cares most about, and permitting because nobody passed a field is
not a check. **The remedy is for the dispensing service to derive and supply the
class from the prescription record, not for the rule to be softened.** Until it
does, the US pack refuses more than US law does.

### ⚠️ `maxDaysSupply` has no caller that can populate it

PI-13a added days'-supply quantity limits because New York PHL § 3332 and
21 CFR 1306.12(b) both state limits that way. Nothing in this programme parses a
dosage instruction, so `request.daysSupply` is never populated and any rule using
`maxDaysSupply` resolves `UNDETERMINED` for every caller.

No rule in the US or India packs uses it today, so nothing refuses because of it
— the key exists so that PI-14..21 can express such a rule honestly rather than
approximating it in base units. **A pack that adds one before a caller can supply
the figure will refuse every transaction it touches.**

### ⚠️ Two condition kinds cannot be discharged by the person dispensing

`VERIFY_PRIOR_IN_PERSON_EVALUATION` and `VERIFY_PRIOR_AUTHORISATION` name facts
established before the transaction — a consultation that happened in somebody
else's room, a permit in a state registry. Every other condition kind names
something the dispenser does.

⚠️ **A screen that renders these as "I confirm" tick-boxes manufactures evidence
of a check nobody performed**, which is worse than not raising the condition at
all. No screen consumes them yet. The UI treatment is an open decision — see
OPEN_DECISIONS.md — and must be settled before the online-pharmacy screens are
pointed at a US branch.

---

## PI-15 — the Australian packs

### ⚠️ `regions` in `locale.ts` gates the regulatory engine, and nobody knew

**Found and fixed in PI-15, and it would have shipped the phase dead.**
`CountryInfo.regions` was documented and populated as "does tax register per
subdivision" — so Australia, whose GST is national, had `regions: []`.
`assertJurisdiction` in `branch.service.ts` calls `isValidRegion` before writing
`branches.region_code`, **and that column is what `@rcln/regulatory` reads to
choose between a national and a sub-national pack.** No Victorian branch could
save `VIC`; `AU-VIC` would have seeded, printed its rule count in the console and
matched nothing, forever.

`AUSTRALIA_REGIONS` now exists and the field is documented as the subdivisions a
branch may be IN. The cost is that the platform's tax-registration screen reads
the same list and will offer Australian states — a visible mistake available to a
platform administrator, traded against a silent one made by the product.

⚠️ **THE UNITED STATES HAS THE SAME HOLE AND IT IS NOT FIXED.** `US_REGIONS`
lists only the states that levy a sales tax; a branch in Oregon, Montana, New
Hampshire, Delaware or Alaska can hold no region and could never be given a state
pack. No pack exists for any of the five, so nothing is inert today. **Any phase
that writes one must add the state to `US_REGIONS` first**, and will get no
warning that it needed to.

### ⚠️ The Victorian pack is stricter than Victorian law on emergency supply

Regulations 25, 25A, 53, 56, 57 and 57A each permit a supply that departs from
the ordinary requirements — a verbal instruction, a digital image, a three-day
emergency supply, continuity of treatment. They are **exceptions to rules**, and
the framework expresses rules rather than exceptions to them: a
`PRESCRIPTION_REQUIRED` rule has no way to say "unless the pharmacist judges an
emergency".

So a Victorian pharmacist acting lawfully under reg 56 is refused by `VIC-RX-S4`
and must override. That is the safe direction and it is still wrong. **Do not
close this by softening the rule** — the honest fix is an exception vocabulary in
the framework, sized across every pack, not a weakened Australian one.

### ⚠️ No national dispensing label, because Appendix L could not be retrieved

Paragraph 40 of the Poisons Standard disapplies its own labelling requirements
from a medicine labelled per clause 1 of Appendix L — so **Appendix L is the
Australian dispensing label**, and the Federal Register's HTML truncates before
the appendices while its PDF is thousands of pages of substance listings.

Victoria's reg 72 is configured and is expressly _supplementary_: it adds the
date of the record of supply and the directions for use. A screen driven by
`LABEL_FIELDS` today prints a container **missing the patient's name**. The
matrix cell stays `RESEARCH_REQUIRED` for exactly this reason.

### ⚠️ SafeScript is configured for Schedule 8 only

Schedule 6 to the Victorian Regulations makes all Schedule 8 poisons monitored —
which `VIC-REPORT-S8` carries, because that limb is coextensive with a
classification. It also names benzodiazepines that are Schedule 4 poisons,
codeine, gabapentin, pregabalin, quetiapine, tramadol, zolpidem and zopiclone:
individual **substances inside** a schedule, which `appliesToClassification`
matches one string at a time and cannot express. Those supplies are not reported
by this pack. Same shape as the pseudoephedrine gap (survey GAP 4) and it needs
the same composition-level work.

### ⚠️ Victoria's animal labelling particulars are unenforceable text

Reg 72(a) requires an animal's species, age, breed and sex and its owner's name
on the container. Those are conditional on the patient being an animal and
`ObligationParameters.fields` is an unconditional list, so demanding them there
would demand them on every human dispense. They sit in `detail` instead — text a
pharmacist reads and a screen cannot check. **This is the third pack to hit a
conditional-field problem** after California's veterinary caution; the framework
gap is real and unsized.

### ⚠️ The framework's inverted defaults were hit twice more

Both are the same defect already recorded under PI-13a — the framework models
"consent required" and several jurisdictions write "objection blocks":

- **Brand substitution.** Reg 50(4)(c) forbids supplying a different brand only
  where the prescription names one. `requiresPrescriberConsent` would refuse
  every lawful substitution in the state, so `VIC-SUBST-*` carries
  `permitted: true` with the proviso in the statement.
- **Schedule 8 two-day quantity.** Reg 51(2) bars a supply of more than two days'
  treatment **unless** the pharmacist verifies the prescriber. `maxDaysSupply: 2`
  would refuse every ordinary verified Schedule 8 supply in Victoria. Carried in
  the `VIC-RX-S8` statement.

Two packs have now paid this cost in four places. It is the strongest candidate
for the next framework phase.

---

## PI-16 — the Singapore pack

### ⚠️ One classification column, two national vocabularies

`product_regulatory_profiles.classification` is a single string, and Singapore
classifies the same medicine twice: HSA registers it as a prescription-only,
pharmacy-only or general sale list medicine, and the Misuse of Drugs Regulations
put it in a Schedule. **Morphine is both.** A clinic that files it as
`MDA_SECOND_SCHEDULE` does not match `SG-RX-POM`; one that files it as
`PRESCRIPTION_ONLY_MEDICINE` does not match the controlled-drug rules.

Mitigated rather than solved: every controlled-drug rule in the pack stands
alone — its own prescription requirement, prescriber list, retention period and
storage rule — so neither spelling is silently thinner than the other. The cost
is a duplicated rule per axis, which `SG-RX-CODEINE-LIQUID` makes visible: it
exists only because a codeine linctus filed under the quantity-limit spelling
would otherwise carry a 240 ml cap and no prescription rule at all.

**The honest fix is a second classification axis on the profile**, sized across
every pack. It is not Singapore's to make.

### ⚠️ A rule type that means "nobody here may supply this" does not exist

`SG-SUPPLY-CD4` is a `PHARMACIST_AUTHORITY` rule whose permitted-licence list
nobody at a dispensing point can satisfy — an approved researcher, a laboratory
custodian, an HSA or DSO analyst, an inspector. Reg 8A of the Misuse of Drugs
Regulations names no pharmacist, unlike regs 7(2) and 8(2), so a Fourth Schedule
drug is not a medicine a counter may supply at all.

The **outcome is correct** — a refusal, with a statement saying why. What is
wrong is the shape: the reason text tells a pharmacist to hand the drug to
somebody their clinic does not employ. A `permitted: false` supply rule would say
it plainly. Recorded rather than invented: adding a rule type is a framework
change and belongs in a framework phase.

### ⚠️ The pharmacist gate is premises-conditional and rcln does not model premises

No `PHARMACIST_AUTHORITY` rule exists for a prescription-only or pharmacy-only
medicine, because reg 3(3) of the Licensing of Retail Pharmacies Regulations
disapplies the in-store-pharmacist requirement to a healthcare service licensee
or a practitioner supplying their own patient. Which limb a branch is on is a
fact about its LICENCE, and rcln holds no licence.

⚠️ **THIS IS A GAP IN COVERAGE, NOT A DECISION THAT SINGAPORE HAS NO PHARMACIST
RULE.** A branch that IS a licensed retail pharmacy is under-regulated by this
pack: reg 3(1)(b) requires its supply to be carried out by an in-store
pharmaceutical officer and reg 3(1)(g) confines access to controlled drugs to a
qualified pharmacist, and neither is enforced. The alternative was to
over-regulate every clinic, which refuses lawful supply. **The fix is a fact on
the branch** — what it is licensed as — and it is the same missing fact several
other jurisdictions will need.

### ⚠️ A codeine linctus is capped in the product's base unit, whoever set it

`SG-QTY-CODEINE-LIQUID` sets `maxPerPeriodBase: '240.000000'` against reg
14(1)(a)'s 240 ml. `quantityBase` is denominated in the PRODUCT's base unit, so a
clinic that files a linctus in bottles gets a limit of 240 bottles. The rule
statement names millilitres so a refusal reads honestly, and nothing in the pack
can enforce it. This is the programme's standing unit-and-identifier debt (#25,
PI-23), reached from a new direction.

### ⚠️ A veterinary surgeon may not prescribe a prescription-only medicine here

`SG-PRESCRIBER-POM` names a medical practitioner, a dentist and a collaborative
prescribing practitioner, because reg 2(1) of the Therapeutic Products
Regulations defines "qualified practitioner" as exactly those and no vet appears
anywhere in the instrument. `SG-PRESCRIBER-CD2` and its siblings DO name a
veterinary surgeon, because reg 2(1) of the Misuse of Drugs Regulations does.

**That asymmetry is a reading, not a finding.** Whether veterinary supply in
Singapore runs through the Animals and Birds Act was not researched, and a
veterinary clinic on this pack will be refused for a prescription-only medicine.
Recorded so a reviewer with the Animals and Birds Act in hand knows where to
look.

### ⚠️ `RECORD_IN_CONTROLLED_REGISTER` names a register rcln cannot be

Reg 2(1) of the Misuse of Drugs Regulations defines "register" as **a bound
book**, and says it "does not include any form of loose leaf register or card
index". The condition `SG-SCHEDULE-CD2` raises is therefore discharged on paper,
at the premises, in ink, by hand — and a screen rendering it as a tick-box has
recorded that somebody ticked a box. This is the same class as the two conditions
PI-13a flagged as undischargeable by the dispenser, arrived at from a different
direction: the obligation is real, the platform cannot hold the artefact, and the
UI treatment is an open decision.

---

## PI-17 — the Emirati packs

### ⚠️ `CountryInfo.regions` was empty for a second country, and this is now a class

Australia in PI-15, the United Arab Emirates in PI-17. Both had `regions: []`
because the field was populated from "does tax register per subdivision" and both
countries tax federally at one rate; both regulate medicines sub-nationally, and
`isValidRegion` gates `branches.region_code`, which is what selects a pack.

⚠️ **THE UAE HAD A TELL NOBODY READ: `labels.region` for `AE` already said
`'Emirate'`.** The address form asked which emirate a branch was in and the list
permitted none — a contradiction a country either has or does not have, visible
in the same object, and worth grepping for elsewhere.

`UAE_REGIONS` lists all seven emirates rather than only the two with a pack.
⚠️ **`US_REGIONS` IS STILL SHORT FIVE STATES** — Oregon, Montana, New Hampshire,
Delaware and Alaska — and nothing is inert today only because no pack exists for
any of them.

### ⚠️ There is still no rule type that means "this transaction is prohibited"

Second and third occurrences, after Singapore's `SG-SUPPLY-CD4`. Both emirate
packs prohibit moving controlled stock between facilities — Abu Dhabi § 11.1,
Dubai clause 18.12.1 — and the only handler in `engine.ts` that refuses a
transaction outright is `evaluateImportRestriction`. So `AZ-TRANSFER-*` and
`DU-TRANSFER-*` are `IMPORT_RESTRICTION` rows narrowed to
`appliesToTransactions: ['TRANSFER']`, which produces exactly the right OUTCOME
under a rule type whose NAME is about imports.

⚠️ **THE NARROWING IS LOAD-BEARING AND HAS NO GUARD.** `evaluateImportRestriction`
fires on `STOCK` as well as `TRANSFER`; widening `appliesToTransactions` on one of
those six rows would stop every Emirati clinic from receiving controlled stock at
all. A behaviour case pins it. The fix is a `permitted: false` transaction rule
type, sized across every pack, in a framework phase.

### ⚠️ Both emirates' days'-supply ladders are inexpressible, twice over

`AE-AZ` §§ 5.3.1, 5.4.1–5.4.3 and `AE-DU` clauses 18.7.4, 18.7.5 set the same
ladder: a General Practitioner may prescribe 3 days' supply, a specialist 15, a
consultant 30. Neither pack carries it, for two independent reasons:

1. **It is conditioned on the prescriber's GRADE**, and `maxDaysSupply` is a
   property of the rule. Three rules of one type against one classification tie;
   `mostSpecific` keeps ties; a refusal beats a permission — so the three-day GP
   limit would govern every consultant's prescription in the country.
2. **Nothing populates `daysSupply`** (the standing gap PI-13a recorded), so any
   rule using the key answers `UNDETERMINED` — which refuses — for every caller.

Either alone is disqualifying. The ladder is in the rule statements, where a
pharmacist reads it and the engine does not act on it. ⚠️ **A future phase that
"completes" these packs by adding the key would refuse every controlled supply in
the UAE**; a behaviour case asserts the current outcome is not `UNDETERMINED`.

### ⚠️ Two refill rules are wider than their regulators wrote

`AZ-REFILL-CD` and `DU-REFILL-CD` permit an endorsed refill of any product in the
tier. Both regulators permit refills only for products on a named list —
Ministerial Decree 253 of 2020 in Abu Dhabi, 680 of 2017 in Dubai — and neither
decree could be retrieved. The rules are therefore permissive where the
standards are selective. The alternative was to carry no refill rule at all,
which would have refused the lawful specialist and consultant refills the same
sections create.

### ⚠️ Dubai's three-month POM validity is drawn from an illustrative clause

`DU-RX-POM` sets `validityMonths: 3` from clause 12.1.3(b), which sits inside a
list of what pharmacy staff "should consider" and reads "Prescription validity
e.g. POM Prescriptions are valid for Three (3) month." The number is the
regulator's own and is the only statement of POM validity in the document, but it
arrives as an example inside a recommendation.

It is written because the alternative fails OPEN: with no validity, a prescription
of any age is acceptable. Recorded so a reviewer with the DHA prescription rules
can confirm or replace it.

### ⚠️ Both packs are silent about premises, and both regulators are not

Dubai confines narcotic prescribing to hospital inpatient and emergency units
(18.7.3.b) with an outpatient exception for cancer, severe pain and post-major
surgery; Abu Dhabi requires facilities to be licensed as a hospital, day surgery
centre, pharmacy or drug store (§ 4.1). What kind of facility a branch is, and why
a patient is being treated, are facts rcln does not hold — the same wall
Singapore's premises-conditional pharmacist gate ran into in PI-16. **This is now
three jurisdictions asking for a fact about the branch's licence.** The fix is a
field on the branch, not a bolder reading of a regulation.

### ⚠️ A UAE tenant needs a national `AE` jurisdiction row that no pack creates

`profileFor` accepts a profile whose jurisdiction is the branch's region OR the
country, preferring the region. A medicine's dispensing mode is federal, so the
natural filing is one national profile per product serving both emirates — but
the seed only ever creates a jurisdiction row for a pack, and there is no
national AE pack. **A clinic that files its profiles against Abu Dhabi will find
its Dubai branch has no classification at all**, which resolves `UNDETERMINED` and
refuses. The behaviour suite creates the national row explicitly and says why.

---

## PI-18 — Ireland

### ⚠️ Ireland's twelve-month prescription extension is not configured, and the pack refuses on day 183

Regulation 7(5)(a) of the Medicinal Products (Prescription and Control of Supply)
Regulations 2003, as substituted by S.I. No. 73 of 2024 from 1 March 2024, is two
limbs: six months from the date on the prescription, **or** — save for a
controlled drug in Schedule 2, 3 or 4 — up to twelve months where that period is
written on the prescription, or where a registered pharmacist decides it is
appropriate under regulation 9A(1) of the Regulation of Retail Pharmacy
Businesses Regulations 2008 and records the decision.

`PresentedPrescription` carries neither fact: there is no prescriber-stated
validity period and no record of a pharmacist's regulation 9A review. So every
prescription rule in `IE 1.0.0` states limb (i), and an Irish clinic dispensing
on day 183 against a prescription lawfully endorsed for twelve months is
**refused**.

⚠️ **THAT IS A WRONG ANSWER IN THE REFUSING DIRECTION, WHICH IS THE DIRECTION
NOBODY AUDITS** — the same failure mode `validityMonths` itself was added to
prevent. It is written this way anyway because `validityMonths: 12` would permit,
silently, the far larger set of prescriptions on which nobody specified anything
and no pharmacist reviewed anything. **The fix is two fields on
`PresentedPrescription`, not a bolder reading**, and a behaviour case pins the
current outcome so nobody closes it the cheap way.

### ⚠️ `branch.licence_type` — the FOURTH jurisdiction to ask for it

Regulation 7(6) says a prescription for a First Schedule Part C substance "shall
not be dispensed except in a hospital". That is a restriction on the **premises**,
after Singapore's retail-pharmacy-versus-clinic pharmacist gate (PI-16) and
Dubai's and Abu Dhabi's facility categories (PI-17).

`IE 1.0.0` therefore defines **no** `PRESCRIPTION_ONLY_PART_C` classification. A
Part C product matches no rule, resolves `UNDETERMINED`, and refuses — which is
the honest direction. ⚠️ **DEFINING THE CLASSIFICATION AND GIVING IT THE ORDINARY
PRESCRIPTION RULES WOULD BE WORSE THAN DEFINING NOTHING**: a community pharmacy
would get a clean `PERMITTED` for a supply the regulation forbids. A behaviour
case pins the `UNDETERMINED`.

### ⚠️ No Falsified Medicines traceability rule, and no pack uses `TRACEABILITY_REQUIREMENT` yet

Commission Delegated Regulation (EU) 2016/161 is directly applicable in Ireland
and obliges a pharmacy to verify and decommission the unique identifier on a
prescription medicine. Its text could not be retrieved: `eur-lex.europa.eu`
answers `202` with a client-side challenge on every path attempted, by `curl`
with a browser user agent and by the fetch tool alike. No source, no rule.

⚠️ **AND THERE IS A SECOND REASON THIS SHOULD NOT BE CLOSED FROM MEMORY.**
`evaluateTraceability` **REFUSES** on a missing identifier, and
`createDispenseWithin` passes `lotNumber`, `expiresOn` and `serial` but **no
GTIN**. A rule written as `requiredIdentifiers: ['GTIN', 'SERIAL', 'LOT',
'EXPIRY']` would refuse every Irish dispense on the platform, for a field the
caller simply never sends. Whoever closes this closes the caller first.

### ⚠️ The practitioner's own-patient exemption is wider in the pack than in the regulation

`IE-DISPENSER-*` sets `exemptWhenActorIsPrescriber: true` on the strength of
regulation 20(3)(c) of the 2003 Regulations, which disapplies regulations 5 and 6
from "the supply of a medicinal product to a patient of his by a **registered
medical practitioner or registered dentist** in the course of his professional
practice".

`RegulatoryActor.isPrescriber` is a boolean and carries no class. A **registered
nurse** prescriber dispensing their own prescription is therefore exempted by
this pack and is **not** exempted by the regulation. The fix is a class on the
exemption — `exemptPrescriberClasses` rather than a boolean — not a narrower
rule, because narrowing it would refuse the doctor-run clinic that regulation
20(3)(c) exists for.

### ⚠️ The Eighth Schedule hole in the distance-selling permission

Regulation 19(4), as substituted by S.I. No. 525 of 2011, lifts the mail-order
prohibition from a non-prescription medicine **except one specified in the Eighth
Schedule** — the products a trained pharmacist may administer under regulation
4B, an influenza vaccine among them. `IE-ONLINE-PHARMACY-ONLY` permits distance
supply of anything classified `PHARMACY_ONLY`, so a pharmacy-administered vaccine
filed under it gets a permission regulation 19 does not give.

Closing it needs a classification of its own and somebody to read the Eighth
Schedule **as it now stands** — it has been substituted repeatedly, most recently
by S.I. No. 284 of 2023.

### ⚠️ `CountryInfo.regions` for `IE` is empty and correct — but `labels.region` says 'County'

The third outing of PI-16's "check this list first", and the first that came back
clean. Irish medicines law is national, so no sub-national pack can exist to be
made inert. **Nothing in this pack is affected.**

What remains is the tell PI-17 found for the UAE, without the consequence:
`labels.region` for `IE` is `'County'`, so the address form asks which county a
branch is in while `regions` permits none. Twenty-six counties were **not** added
blind, because listing a subdivision also offers it on the platform's
tax-registration screen and Ireland's VAT is national. Whoever needs a county on
an address decides this, not a rule-pack phase.

### ⚠️ Ireland's emergency supply is not modelled

Regulation 8 permits supply without a prescription at a practitioner's request
who undertakes to furnish one within 72 hours, or on the pharmacist's own
judgement with a five-day ceiling and an "Emergency Supply" label. Both are
exceptions to a prohibition rather than rules of their own, and this framework
has no way to say "the prescription requirement stands down because an emergency
was recorded". A `QUANTITY_LIMIT` of five days' supply would need `maxDaysSupply`,
which no caller can answer — the standing gap PI-13a recorded — and would then
apply to every supply rather than to the emergency ones.

### ⚠️ The Safe Custody Regulations point at schedules revoked twice over

S.I. No. 321 of 1982 binds a pharmacy in respect of "any controlled drug
specified in Schedule 1, 2 or 3 of the Principal Regulations", where the
Principal Regulations are the **Misuse of Drugs Regulations 1979**. Those were
revoked by the 1988 Regulations and those by the 2017 Regulations; regulation
29(1) of the 2017 Regulations carries the 1988 references forward, and the step
from 1979 to 1988 was **not read in this pass**.

`IE-STORE-CD2` and `IE-STORE-CD3` are written against the 2017 numbering, because
that is what a clinic classifies a product under. A reviewer closing
`SOURCE_VERIFIED` on that source has to walk the chain.

### ⚠️ Ireland publishes no consolidation of a statutory instrument

The 2003 Regulations have been amended more than forty times and the eISB serves
each amendment separately; the text under `/made/` is the text of 2003 and says
nothing about what has since been substituted out of it. Three amendments bearing
on rules in this pack were read in full and are their own source rows; the rest
were checked for whether they touch regulations 5, 6, 7, 9, 10, 17, 18, 19 or 20.

⚠️ **THAT IS A CHECK, NOT A GUARANTEE, AND IT IS THIS PACK'S LARGEST EXPOSURE.**
A substitution nobody noticed reads exactly like a rule nobody amended.

### ⚠️ `AU-SCHEDULE-S8` REFUSES EVERY SCHEDULE 8 TRANSACTION OUTSIDE VICTORIA — a PI-15 defect, found in PI-18

**Not an Ireland issue. Found while writing `IE-SCHEDULE-*` on the Australian
pack's precedent, and the precedent is broken.**

`AU-SCHEDULE-S8` carries `parameters: { scheduleName: 'Schedule 8' }` and nothing
else. `parseControlledSchedule` **rejects** a document that sets none of
`registerRequired`, `witnessRequired`, `storageLocationKinds` or
`priorAuthorisationRequired` — "it is a controlled-schedule rule that imposes no
obligation" — so the rule resolves `UNDETERMINED`, **which refuses**. Every
Schedule 8 supply, stock movement, transfer and disposal in the seven Australian
jurisdictions with no state pack is refused by it.

⚠️ **THE FILE COMMENT ASSERTS THE OPPOSITE, IN SO MANY WORDS:**

> `evaluateControlledSchedule` permits with an empty condition list and one
> reason line naming the schedule. The reason is the value: without it a
> Schedule 8 supply in Sydney would come back indistinguishable from an ordinary
> one.

⚠️ **AND ITS BEHAVIOUR CASE PASSES.** `au-rule-pack.test.ts`, "names the schedule
on a Schedule 8 supply, and imposes nothing else", asserts that the rule CODE
appears in `reasons` and that no conditions were raised — which is **exactly**
what an unreadable rule produces. It never asserts the outcome. This is PI-12's
lesson verbatim: _every defect that phase shipped was first written down as a
justification._

**Not fixed here**, because the fix is a decision about Australia rather than
about Ireland, and it changes behaviour in seven jurisdictions:

- **Delete the rule.** The pack's own header argues at length that the Poisons
  Standard imposes no national register, safe or retention, so there is nothing
  for a `CONTROLLED_SCHEDULE` rule to carry. A Schedule 8 supply in Sydney would
  then rest on `AU-RX-S8`, and the decision would not name the schedule.
- **Or let the parser accept a `scheduleName`-only rule as informational** — a
  framework change, which would also give Ireland back `IE-SCHEDULE-CD3` and
  `IE-SCHEDULE-CD4A`. That is the option that makes the comment true.

⚠️ **Check `US-CD-*`, `SG-CD*` and the two Emirati packs for the same shape
before closing this.**

### ⚠️ A Schedule 3 decision in Ireland does not name the schedule

The consequence of the above, taken honestly. Regulation 19(1) of the Misuse of
Drugs Regulations 2017 requires a register for Schedules 1 and 2 and stops, and
Ireland's safe requirement is its own `STORAGE_REQUIREMENT` rule — so there is no
obligation a `CONTROLLED_SCHEDULE` rule could carry for Schedule 3 or Part 1 of
Schedule 4, and the parser refuses a rule that carries none.

`IE 1.0.0` therefore has **one** `CONTROLLED_SCHEDULE` rule, for Schedule 2. A
Schedule 3 supply is correctly permitted and correctly labelled and correctly
retained — and the decision does not say "this is a controlled drug". A behaviour
case pins the absence.

### ⚠️ An unclassified rule in a pack is a fail-open for every classification the pack does not recognise

**Found in this pack's own first draft, and fixed before it shipped — recorded
because the mistake is easy to repeat and impossible to see in review.**

`IE-LABEL-DISPENSE` was written unclassified, faithfully: regulation 9(1) defines
a "dispensed medicinal product" by how it was supplied, not by what it is, so an
over-the-counter recommendation is inside the definition and a classification
would have narrowed the regulation.

But `coversProduct` matches a rule with no classification against **any** product.
A product filed under a string the pack never heard of — a First Schedule Part C
substance, a typo, a classification borrowed from another country's vocabulary —
matched that one rule, raised a label obligation, and came back
`PERMITTED_WITH_CONDITIONS`. Nothing refused, because nothing that refuses had
anything to say. `needsClassificationButHasNone` does not fire: the product HAS a
classification, just not one this pack recognises.

The labelling rule is now written once per classification the pack defines, so an
unrecognised string matches nothing and resolves `UNDETERMINED`.

⚠️ **AND FOUR EARLIER PACKS HAVE THE SAME SHAPE. THIS IS A CLASS OF DEFECT, NOT
AN IRELAND ONE.** Every rule in `AU`, `AU-VIC`, `AE-AZ` and `AE-DU` names a
classification; these do not:

| Pack    | Unclassified rules                                                         | Does an unrecognised classification fail open?  |
| ------- | -------------------------------------------------------------------------- | ----------------------------------------------- |
| `IN`    | `IN-RETAIN-RECORDS`, `IN-DISPENSER-REGISTERED-PHARMACIST`, `IN-LABEL-*` ×2 | **Yes** — a registered pharmacist gets a permit |
| `US`    | `US-DISPENSER-PHARMACIST`, `US-STORE-CONTROLLED`, `US-LABEL-VETERINARY`    | **Yes** — same shape                            |
| `SG`    | `SG-LABEL-DISPENSE`                                                        | **Yes** — nothing in the set can refuse         |
| `US-CA` | `CA-RETAIN-RECORDS`, `CA-LABEL-DISPENSED`, `CA-SUBST-GENERIC`              | Regional; supersedes `US` per type, so both     |

In each, a product whose `classification` is a string the pack does not define —
a typo, a vocabulary borrowed from another country, a classification a later
amendment introduced — matches only rules that permit, and the decision comes
back `PERMITTED` or `PERMITTED_WITH_CONDITIONS`. **Not verified by running
them**; read off the rule rows, and worth a behaviour case in each pack before it
is treated as settled.

⚠️ **THE GENERAL RULE THIS ESTABLISHES: an unclassified rule is safe only where
some rule that can REFUSE also applies to the same product.** In a pack whose
refusing rules are all classified, an unclassified obligation is the whole
applicable set for anything unrecognised — and an obligation never refuses.

---

## PI-21 — Bangladesh

⚠️ **THREE PERMISSIVE GAPS IN ONE PACK, WHICH IS MORE THAN ANY OTHER PACK IN THIS
PROGRAMME HAS, AND ALL THREE ARE THE LAW.** Every other pack's recorded gaps
refuse something lawful. Bangladesh's permit something that in most other
jurisdictions would be refused, because Bangladeshi law simply does not legislate
it. Each is pinned by a behaviour case so that closing one with a plausible
number fails the suite.

### ⚠️ A Bangladeshi prescription never expires

Section 40(ঘ) of the ঔষধ ও কসমেটিকস্ আইন, ২০২৩ requires a prescription and says
nothing about how old one may be. Rule 24(10) of the Bengal Drugs Rules, 1946
lists what one must contain — in writing, signed, dated, the patient's name and
address, the total amount and the dose — and imposes no expiry. Neither does the
মাদকদ্রব্য নিয়ন্ত্রণ আইন, ২০১৮, including for a narcotic, where every other
jurisdiction in this programme sets days: Ireland fourteen, Abu Dhabi and Dubai
three, Singapore thirty.

So `BD-RX-*` carries no `validityDays` and no `validityMonths`, and a
twenty-year-old prescription is `PERMITTED`. ⚠️ **AND THE ENGINE'S FUTURE-DATE
GUARD DOES NOT RUN EITHER** — `evaluatePrescriptionRequired` only checks for a
prescription dated after the day of supply where a validity is configured, so a
mistyped year passes as well. Both are pinned.

**Mitigation:** find a Gazette notification that sets a period, or accept it.
`validityDays: 180` would be this pack inventing a rule for a sovereign state.
⚠️ **DO NOT CLOSE THIS BY COPYING INDIA'S**: India's Drugs Rules do not set one
either, and `IN` has the same gap for the same reason.

### ⚠️ An ordinary Bangladeshi prescription may be dispensed any number of times

Rule 24(11) — "must not be dispensed more than once unless the prescriber has
stated thereon that it may be" — opens with "the person dispensing a prescription
containing a drug specified in **Schedule G**", and that limitation is the rule.
Schedule G is a 1952 list of five substances. So `PRESCRIPTION_ONLY`,
`SCHEDULE_D_POISON` and `SCHEDULE_C_BIOLOGICAL` carry no `REFILL_RULE` at all and
a fortieth supply on one prescription is `PERMITTED`.

⚠️ **TAKEN WITH THE ENTRY ABOVE, ONE BANGLADESHI PRESCRIPTION IS GOOD FOREVER AND
FOR ANY NUMBER OF SUPPLIES.** That is the honest consequence of two silences, and
it is the single most important thing for a qualified reviewer to attack.

**Mitigation:** a source. Copying `BD-REPEAT-SCH-G` onto `PRESCRIPTION_ONLY`
would be a refusal nobody legislated.

### ⚠️ Nothing is required on a dispensed container except for a Schedule D poison

Rule 53(2) reads backwards from what a reader expects. It **disapplies** rules 55
to 60 — the whole labelling Part — from a medicine made up ready for treatment
and supplied on a practitioner's prescription, and then re-imposes four
conditions **only** "if the medicine contains a substance specified in Schedule
D". So `BD-LABEL-SCH-D` is not a general dispensing label narrowed to poisons; it
is the residue of a general exemption, and there is no general dispensing label
in Bangladeshi law to narrow.

**Mitigation:** none available from the sources read. Recorded so that nobody
"restores" a label rule for `PRESCRIPTION_ONLY` on the assumption that one was
dropped.

### ⚠️ A veterinary prescription is refused for an ordinary medicine and accepted for a narcotic

**The refusing gap in this pack, and the one that will cost a real clinic time.**

Section 2(12) of the 2018 Act defines চিকিৎসক for narcotics purposes to include a
Registered Veterinary Practitioner under the Bangladesh Veterinary Practitioner
Ordinance, 1982 — and a recognised homeopath. The 2023 Act defines চিকিৎসক
**nowhere**; section 40(ঘ) says only "রেজিস্টার্ড চিকিৎসক", and rule 24(9) of the
1946 Rules says "registered medical practitioner".

Importing one statute's definition into the other is a step no source authorises,
so `BD-PRESCRIBER-RX`, `-SCH-G`, `-SCH-D` and `-SCH-C` name a medical and a
dental practitioner and stop. A veterinary clinic in Bangladesh dispensing an
antibiotic on its own vet's prescription is **REFUSED**, which is very probably
wrong, and the same vet's prescription for a narcotic is accepted.

**Mitigation:** a source that says who "রেজিস্টার্ড চিকিৎসক" is in the 2023 Act —
a Gazette definition, a DGDA order under section 2(18), or the authentic English
text section 83(1) contemplates. Both directions are pinned by behaviour cases so
that adding `REGISTERED_VETERINARY_PRACTITIONER` to `PRESCRIBER_CLASSES` fails
the suite rather than passing silently.

### ⚠️ The only text of the operative Rules that the regulator publishes stops in December 1952

`The Bengal Drugs Rules, 1946` supply twelve of this pack's fifty-six rules —
six of its fifteen rule templates. DGDA publishes them today, section 82(2)(ক) of the 2023 Act saves
them, and DGDA's own Online Pharmacy checklist cites Form 7 of them — so they are
live. But the PDF says on its face "as amended by the Government of East Bengal
up to December 1952", still exempts drugs "sold for export to a place outside
India", and still speaks of the Provincial Government.

⚠️ **THIS IS A WORSE VERSION OF PI-18's IRISH EXPOSURE, NOT A BETTER ONE.**
Ireland publishes each amendment separately, so a diligent reader can walk the
chain. Here there is nothing to walk: seventy-four years of Bangladeshi Gazette
are not indexed anywhere this session could reach. Bangladesh's own **statutes**
are consolidated on bdlaws with every amendment footnoted in place, which is
better than Ireland manages — the gap is entirely in the subordinate legislation.

**Mitigation:** a Gazette search for amendments to the Bengal Drugs Rules between
1953 and today. Nobody here can do it. Until then, `BD_BENGAL_RULES_1946` stays
`UNVERIFIED` and every rule citing it inherits the doubt.

### ⚠️ Two rule types rest on an undated, unnumbered PDF

`BD-DISPENSER-ONLINE-*` (eight rules) and `BD-ONLINE-*` (eight rules) cite DGDA's
**Online Pharmacy Criteria**, which carries no notification number, no date and
no signature. It is treated as binding because the licence application checklist
requires a written commitment to "the guidance documents for online pharmacy",
clause 11(c) binds the licensee to conditions imposed by office order, and
section 2(18) of the 2023 Act makes what the Directorate prescribes by written
order "নির্ধারিত" until rules are made.

⚠️ **THE SHARPEST ROW IS `BD-ONLINE-CD-*`.** An undated PDF forbids something
neither statute forbids — remote supply of a controlled drug — for every online
pharmacy in Bangladesh. It is configured because a licence condition binds the
licensee and because the refusing direction is the safe one. **It is the first
row a reviewer should attack.**

⚠️ **AND CLAUSE 5(h) IS INTERNALLY CONTRADICTORY: "at least 02 (Three) years".**
The numeral is two and the word is three. Nothing in this pack depends on it —
the retention rules are the 1946 Rules' — but it is a measure of the document's
care.

### ⚠️ Bangladesh has no narcotics register, safe, disposal or reporting rule

Section 48(1)(অ) of the 2018 Act empowers an officer to examine "হিসাববহি অথবা
নিবন্ধনবহি" — account books or register books — which presupposes an obligation
to keep them. That obligation lives in the মাদকদ্রব্য নিয়ন্ত্রণ বিধিমালা made
under section 68, and **dnc.gov.bd did not respond on any path** while this pack
was written.

So `BD-CD-*` carries `priorAuthorisationRequired` and nothing else: no
`registerRequired`, no `storageLocationKinds`, no `witnessRequired`. A class ‘ক’
narcotic may be stocked on an open shelf as far as this pack is concerned, and a
behaviour case pins that.

⚠️ **THE ROWS ARE STILL READABLE, WHICH IS THE DIFFERENCE FROM `AU-SCHEDULE-S8`.**
That rule carries only `scheduleName`, `parseControlledSchedule` rejects a
document that imposes no obligation, and it therefore refuses every Schedule 8
transaction in seven Australian jurisdictions. The Bangladeshi rows carry a real
obligation, and the behaviour case asserts the **outcome** rather than only the
rule code — which is precisely what the Australian case fails to do.

**Mitigation:** retrieve the বিধিমালা. Until then this is a permissive gap
recorded rather than guessed at.

### ⚠️ `labels.region` for `BD` says 'District' and no district can be selected

The same loose end Ireland left with 'County'. `CountryInfo.regions` for `BD` is
`[]`, which is **correct** — DGDA and the Department of Narcotics Control are
national, both statutes are national, and no sub-national pack can exist to be
made inert, so this is the second clean run of the check that cost PI-15 a
working pack and PI-17 two. But the address form asks which District a branch is
in while `isValidRegion` permits none.

**Mitigation:** either populate `BD_REGIONS` with the eight divisions or
sixty-four districts, or change the label. ⚠️ Populating it would also offer
those subdivisions on the tax-registration screen, and Bangladeshi VAT is
national at one rate — the same trade-off Ireland recorded and did not resolve.

### ⚠️ `SOURCE_VERIFIED` for `BD` is not the same job it is for `IE` or `US`

Both Bangladeshi statutes provide that the **Bangla** text prevails over any
English translation — section 83(2) of the 2023 Act, section 70(2) of the 2018
Act. Every rule in this pack was read off the Bangla. A reviewer closing
`SOURCE_VERIFIED` must therefore re-read the citations in Bangla, and **nothing
in `regulatory_sources` records which language a reviewer read a source in**.

That is a gap in the maturity ladder rather than in the engine, and it will
recur: Nepal (PI-19) is very likely the same shape. Recorded in
COUNTRY_RULE_PACK_SURVEY as GAP 7 and beside OD-3 in OPEN_DECISIONS.

### ⚠️ A Bangladeshi clinic cannot register, because no plan is priced in BDT

Found by writing this pack's behaviour suite, and it is a platform gap rather
than a regulatory one. `seed/plans.ts` publishes monthly prices in INR, USD, EUR,
GBP, AED, SGD and AUD. `registerOrganization` looks a plan price up by the
organization's currency and, finding none, logs and throws `PLAN_UNAVAILABLE` —
a **503**, deliberately, because "the caller sent a plan code from our own
pricing page" and a miss is our fault rather than the clinic's.

So a registration naming `currency: 'BDT'` fails outright, and one that omits the
currency falls through `currencyForCountry` to USD — a Bangladeshi clinic billed
in dollars. **The same is true for Nepal (NPR) and Sri Lanka (LKR)**, whose packs
are deferred, so this will recur the moment either ships.

**Mitigation:** decide whether to publish a BDT price or to bill these markets in
USD, and say which in `seed/plans.ts`. ⚠️ **NOT a conversion of the rupee
figure** — the seed's own comment says prices are set per currency and never
converted, and that is a pricing decision rather than an arithmetic one. The
behaviour suite omits the currency and says why.

### ⚠️ Re-seeding a rule NEVER updates its transactions, classification or type

**Cost PI-21 a confusing half-hour and will cost the next rule-pack phase the
same.** `seedRegulatoryPacks` upserts a rule on `(pack, code, version)`, and its
`update` branch writes exactly three columns:

```ts
update: { statement: rule.statement, parameters: rule.parameters, sourceId },
```

`appliesToTransactions`, `appliesToClassification`, `appliesToProductType` and
`ruleType` are written on **create only**. Change one in a data file, re-run the
seed, and the console prints the new rule count while the row keeps its old
value — so the pack behaves as it did before the edit, in an environment that
looks freshly seeded.

PI-21 hit it changing `BD-RETAIN-*` from `appliesToTransactions: []` to the three
supply transactions. The fix in the dev database was to delete the pack's rules
and re-seed.

⚠️ **THIS IS THE SIBLING OF THE NOTE PI-18 LEFT** — "the seed upserts and never
deletes", so a renamed rule code leaves an orphan row still matching. Together
they mean **a rule-pack data file and an already-seeded database can disagree in
two directions at once**, and neither disagreement is visible in the seed output.

**Mitigation:** either widen the `update` branch to the narrowing columns and the
rule type, or make a rule-pack change a `prisma migrate reset`. ⚠️ Widening it is
not obviously right: PI-ADR-008 says a real rule change is a NEW row at
`version + 1`, and an `update` that rewrites what a rule APPLIES TO is exactly
the silent-rewrite the pack-maturity comment in `regulatory-packs.ts` warns
about. The honest fix may be to make the seed **refuse** when a stored rule's
narrowing columns differ from the file's, and say so.
