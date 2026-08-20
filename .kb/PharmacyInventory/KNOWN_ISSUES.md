# Known Issues

Defects, gaps and debts in **this programme**. Repository-wide issues live in
[`.kb/15_Known_Issues_and_Technical_Debt.md`](../15_Known_Issues_and_Technical_Debt.md)
and [`.kb/Architecture/PITFALLS.md`](../Architecture/PITFALLS.md).

**Last updated:** 2026-08-19 (PI-12)

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
