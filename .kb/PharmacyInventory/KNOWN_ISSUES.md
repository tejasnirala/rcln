# Known Issues

Defects, gaps and debts in **this programme**. Repository-wide issues live in
[`.kb/15_Known_Issues_and_Technical_Debt.md`](../15_Known_Issues_and_Technical_Debt.md)
and [`.kb/Architecture/PITFALLS.md`](../Architecture/PITFALLS.md).

**Last updated:** 2026-08-16

---

## Defects

| #   | Item                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | Severity                                                                               | Mitigation                                                                                                                                                                                                         |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | **`stock_transfer_lines` renders in a nondeterministic order.** `transfer.service.ts` orders its lines `{ createdAt: 'asc' }`, and `createMany` gives every line of one document the same `created_at` — so a transfer's lines can appear in a different order on each read. Found in PI-4, where the identical bug in the four new document services made a landed-cost assertion fail; fixed there with an `{ id: 'asc' }` tie-break and NOT fixed in PI-3's file, because that is outside PI-4's diff and no PI-3 suite asserts line order.            | LOW                                                                                    | One line: add `{ id: 'asc' }` to the `lines` `orderBy` in `transfer.service.ts`. Do it in the next session that touches transfers.                                                                                 |
| 2   | **`pnpm test` OOMs the api container outright.** PI-3 recorded this for `pnpm validate` when turbo ran tasks in parallel; adding PI-4's two suites tipped the api project itself over the 3 GB heap. `pnpm exec turbo run typecheck\|lint` still pass at `--concurrency=1`, and the api suite has to be run in slices by path.                                                                                                                                                                                                                            | MEDIUM — it makes "run the tests once at the end" impractical                          | Raise the container's memory limit, or set `--maxWorkers=1` plus `--workerIdleMemoryLimit` in `apps/api/jest.config.ts`. It is masking real failures behind a crash, which is the part that matters.               |
| 3   | ~~**A prescriber-endorsed repeat cannot be expressed.**~~ **CLOSED IN PI-7, IN THE FRAMEWORK, AS THIS ENTRY REQUIRED.** `PresentedPrescription` gained `repeatsAuthorised` + `repeatsAuthorisedLimit`, `RefillRuleParameters` gained `endorsedRepeatsPermitted` + `maxEndorsedRepeats`, and `IN-REPEAT-*` now carries the second key. The rule was not weakened: absent endorsement still refuses, and an endorsement stating no number resolves `UNDETERMINED` — which refuses — rather than being read as unlimited. **The successor is #8.**           | CLOSED                                                                                 | —                                                                                                                                                                                                                  |
| 4   | ~~**The Pharmacy Act s. 42 proviso is not modelled.**~~ **CLOSED IN PI-7.** `RegulatoryActor` gained `isPrescriber`, derived by the service from the encounter's prescriber and `ctx.userId` and never accepted from a client; `AuthorityParameters` gained `exemptWhenActorIsPrescriber`, and `IN-DISPENSER-REGISTERED-PHARMACIST` opts in. It exempts nobody else: an actor holding no licence under a rule that names one is still refused, and that case is pinned.                                                                                   | CLOSED                                                                                 | —                                                                                                                                                                                                                  |
| 5   | **A stock movement evaluates with an EMPTY actor.** `consultForStockMovement` passes `roleCodes: []` because neither `goods-receipt.service.ts` nor `transfer.service.ts` is given the caller's effective permissions — they take a `CatalogueActionOptions` carrying an IP and a user agent and nothing else. A `PHARMACIST_AUTHORITY` or `IMPORT_RESTRICTION` rule aimed at `STOCK` or `TRANSFER` would see an actor holding nothing and refuse.                                                                                                        | LOW — latent: no pack has such a rule, and nothing enforces below `PRODUCTION_ENABLED` | Plumb the caller's effective permission codes down to these services. Do it before any pack is signed off, not after.                                                                                              |
| 6   | **Nothing in CI proves the PDF header/footer repeat on every page.** Repetition and the "Page 1 of 5" count are properties of Chromium's printer, not of the HTML, so `packages/documents/tests/chrome.test.ts` cannot see a regression. This is not theoretical: the first implementation used `position: fixed`, which drops the footer from page one and the header from the last page, and every markup assertion passed against it. The worker's Chromium comes from the Alpine base image, so it moves on a `docker build` with no lockfile change. | MEDIUM — silent: PDFs would simply lose their chrome                                   | `apps/worker` has no test harness at all. Add jest + ts-jest there and one test that renders `renderInvoiceHtml(longInvoice(60))` through `renderPdf` and asserts the clinic name and `Page N of M` on every page. |
| 7   | **`tax-registration-coverage.test.ts` is flaky in a full run.** "and Gaya's invoices move to the new number while Patna's do not" fails on roughly half of full `jest` runs and passes every time the file is run alone, so it is cross-suite interference rather than a defect in the assertion — most likely another suite's tax registrations or organization jurisdictions leaking into the resolver's view. Seen repeatedly while working on the document templates, which cannot affect it.                                                         | LOW — noise, but it trains people to re-run rather than read a red test                | Find the suite it collides with (run pairs under `--runInBand`), then isolate the fixture — most of these suites already scope by a per-run slug and this one appears not to.                                      |

| 8 | **An endorsed repeat still refuses, because the CLINICAL record cannot carry the endorsement.** #3 closed the framework half: the engine can now be told that a prescriber endorsed a repeat and how many. Nothing tells it, because `encounter_prescriptions` (CE-4) has a quantity and a duration and no field saying "may be dispensed twice". `dispense.service.ts` therefore omits `repeatsAuthorised` — and absent is deliberately not `false`. | MEDIUM — a lawful endorsed repeat is refused, in the safe direction | A nullable `repeats_authorised` + `repeats_authorised_limit` on `encounter_prescriptions`, written by the prescriber in the consultation. The plug-in point is commented in `dispense.service.ts`. Clinical work, not pharmacy's. |
| 9 | **The actor's professional registrations are never supplied.** `RegulatoryActor.licenceTypes` is empty on every call, because nothing in the schema records that a member holds one — `doctor_profiles.registration_number` is the closest thing and it is a doctor's. A `PHARMACIST_AUTHORITY` rule naming a licence therefore resolves `UNDETERMINED`, which refuses. India's is satisfied through the s. 42 proviso only where the actor IS the prescriber. | MEDIUM — latent: nothing enforces below `PRODUCTION_ENABLED` | A professional-registration table hung off `memberships`, read into the actor. Must land before any pack is signed off, alongside #5. |
| 10 | **`priorQuantityInPeriodBase` is never supplied on a supply.** A `QUANTITY_LIMIT` with a period therefore resolves `UNDETERMINED` rather than counting what the patient has already had — which is correct behaviour (the engine refuses to guess) and an unimplemented feature. India writes no quantity limit, so nothing exercises it today. | LOW — latent | Sum `dispense_lines` for the patient and product inside the rule's window, in `consultForSupply`. One query; the index `(organization_id, patient_id, dispensed_at)` is already there. |
| 11 | **Supplying a substitute is API-only.** A dispense line carries `substitutedForProductId`, a reason and an `isSubstitution` evaluation, and the equivalents screen shows what the law says about each candidate — but the workspace supplies what was prescribed and has no control for swapping the product. | LOW — the safe half shipped | A product swap on the workspace line, carrying the reason into the existing fields. No API change needed. |
| 12 | **The pharmacy dashboard counts "today" in UTC.** `dispensedToday` and `returnsToday` straddle midnight wrongly for a clinic several hours off UTC. Invariant 6's exception list is short and this is on it: the expiry SWEEP resolves the branch's own day in SQL because a lot expiring has consequences, and a count on a dashboard does not. | LOW — cosmetic, counts only | `AT TIME ZONE b.timezone` in `dashboard.service.ts`, the way `inventory_branches_with_expired_stock` does it. |

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

| Item                                                                             | Why                                                                                                                                                                                                                                                                                                                                                                                   | Revisit                                          |
| -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| No i18n for product names                                                        | The repository has no i18n framework; a JSONB name map now would be hard to undo                                                                                                                                                                                                                                                                                                      | OD-3, before PI-19                               |
| No input-tax-credit handling                                                     | Purchase tax is recorded, not computed; ITC is an accounting subsystem                                                                                                                                                                                                                                                                                                                | Post PI-24                                       |
| No insurance/payer contract engine                                               | `CONTRACT_DEFINED` charge policy is modelled but resolves to a manual decision until a contract engine exists                                                                                                                                                                                                                                                                         | When claims land                                 |
| No consignment stock workflow                                                    | `LocationKind.CONSIGNMENT` exists; the ownership model does not                                                                                                                                                                                                                                                                                                                       | PI-22+                                           |
| No multi-currency procurement conversion                                         | A PO in USD received into an INR branch stores both; no FX policy. **PI-4 made this explicit rather than fixing it**: a price-book row in a different currency from the order is REFUSED with a sentence, a return of a lot bought in another currency records no value, and `product_cost_averages` is keyed BY currency so one product can honestly have two averages at one branch | PI-22                                            |
| `pharmacy.supplier.*` and `pharmacy.purchase_order.*` are under the wrong prefix | Under PI-ADR-001 procurement is not a pharmacy concern — a dental store manager requisitions filling material. PI-4's own two codes are `procurement.requisition.*`, and the three older ones were NOT renamed: a rename revokes a grant from every clinic that already holds it, silently. The route PATH is neutral (`/v1/procurement/*`)                                           | Whenever a permission-migration mechanism exists |
| A pharmacist can commit money with no requisition                                | They hold `pharmacy.purchase_order.manage`, which predates PI-4's approval split, so they can raise and issue a PO directly. Not widened by PI-4 and not silently narrowed either                                                                                                                                                                                                     | A clinic narrows it today by cloning the role    |
| No supplier READ permission                                                      | Reads on `/v1/procurement/suppliers` sit behind `pharmacy.supplier.manage`, because inventing `pharmacy.supplier.read` now would be a code no existing clinic holds — every supplier picker would come back empty for everybody until each clinic re-granted it. The shape to aim at is the inventory router's, where reads sit behind one read code                                  | Alongside the prefix rename above                |
| `charge_requests` / `regulatory_decisions` unarchived                            | They grow with volume                                                                                                                                                                                                                                                                                                                                                                 | PI-24                                            |

---

## How to use this file

Add an entry the moment something is discovered, not at session end. Include
severity, what it blocks, and the mitigation. Move resolved entries to a
`## Resolved` section with the date and the fix — deleting them loses the reason
the fix exists.
