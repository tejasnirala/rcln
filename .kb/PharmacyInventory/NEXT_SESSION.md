# Next Session

**Read this first.** Updated at the end of every session.

**Written:** 2026-08-19 · **By:** session PI-11 (veterinary enablement + the
review gate over PI-9, PI-10 and PI-11).

✅ **ALL THREE PHASES HAVE NOW BEEN REVIEWED**, together, by both agents over the
combined 147-file diff. **1 CRITICAL, 1 HIGH, 1 MEDIUM, 6 WARNING, 5 INFO — all
fixed**, each top finding with a regression test verified to fail against the
reverted code. Full write-up in IMPLEMENTATION_TRACKER.md under **PI-11.7**.

⚠️ **THE CRITICAL AND THE HIGH WERE BOTH IN PI-10's RECALL CODE, AND BOTH LET
RECALLED STOCK REACH A SHELF.** Read those two entries before touching
`recall.service.ts` or `batch.service.ts` — between them they are the argument for
why "the balance, not the flag" is the guarantee, and why a second door into a
status change is a second door into the hazard.

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
**PI-7** Pharmacy dispensing. **PI-8** Billing & tax integration. **PI-8.11**
The review gate over the whole PI-7 + PI-8 diff. **PI-9** Clinical consumption —
`feat/pi-9-clinical-consumption`, **COMPLETE**, ⚠️ **not reviewed**. **PI-10**
Recall & traceability — `feat/pi-10-recall-traceability`, **COMPLETE**, ⚠️ **not
reviewed**. **PI-11** Veterinary enablement — `feat/pi-11-veterinary-enablement`,
**COMPLETE**, ⚠️ **not reviewed**.

---

## What was changed in this session

**PI-11 — Veterinary Enablement.** ⚠️ **It added no table.** CD-4 landed
`patients.subject_type` and `animal_profiles` in CE-1 and deliberately built
nothing on them (§4 asked the architecture to stop assuming humans; §42.7 forbade
veterinary features). The table then sat **empty and unreachable for the whole
intervening programme** — no contract field, no service, no route, no screen, and
no tenant-isolation case despite being named in that suite's own header.

| Area        | What landed                                                                                                                                 |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| Schema      | 3 columns on `animal_profiles`; the composite-FK target on `patient_contacts`; `SPECIES_RESTRICTION` on `RegulatoryRuleType`                |
| Migrations  | `..090000_species_restriction_rule_type` · `..090500_pi_11_veterinary_enablement` · `..091000_animal_weight_needs_its_date`                 |
| RLS         | `db:rls:check` green at **128** — unchanged. No new table, and the one new FK is composite, so no `*_visible` (the PI-10 call again)        |
| Permissions | **None added.** Profile = `patient.read`/`.update`; dose calculator = `patient.medical_history.read`                                        |
| Packages    | `@rcln/clinical/dosing.ts` — `weightBasedDose` on exact `bigint` rationals                                                                  |
| Services    | `services/patient/animal-profile.service.ts`                                                                                                |
| Routes      | `PUT /v1/patients/{id}/animal-profile` · `POST /v1/patients/{id}/dose-calculations`. **427 endpoints, 427 documented**                      |
| Screens     | Animal panel + dose calculator on the chart; subject-type toggle on registration; `Animal` marker in search; species on the pharmacy screen |
| Setting     | `patient.animal_weight_stale_days`, default 90 (PI-ADR-015)                                                                                 |
| Found       | ⚠️ **Its own CHECK guarded the harmless direction** — see below                                                                             |

---

## Decisions taken this session that a later phase must not undo

**1. ⚠️ INDIA GETS NO SPECIES RULE, AND THE NON-ADDITION IS WRITTEN INTO THE PACK
FILE.** Rules 65(20) and 97(3) require a veterinary medicine to be **labelled**
"Not for human use" and stored apart — `IN-LABEL-VETERINARY` is that, and it is a
`LABELLING_REQUIREMENT`. Neither rule prohibits the **sale** of one for a human,
and the step from "the box must say so" to "the sale is unlawful" is an
inference. The same call PI-6 made about quantity limits and e-pharmacy. The rule
type is proved against TESTLAND, where every rule type in this framework is
proved.

**2. ⚠️ A TRANSACTION THAT NAMES NO SUBJECT IS `UNDETERMINED`, NOT `PERMITTED`.**
A counter sale names nobody, so a species rule cannot be checked there — and
PERMITTED would make the anonymous path the way around the rule, which is the path
somebody buying a veterinary drug for themselves would take. The cost (every
anonymous counter sale of that product goes UNDETERMINED) is the pack author's to
accept by listing `COUNTER_SALE`, not the engine's to take on their behalf.

**3. `SPECIES_RESTRICTION` is its own rule type, not a parameter on
`AGE_RESTRICTION`.** That handler stands aside **entirely** for an animal, so a
veterinary prohibition written as an age parameter would sit behind a handler that
exempts every animal from itself — inert in exactly the case it was written for.

**4. The species on a DISPENSE is read off the profile, never sent by a client.**
`POST /v1/regulatory/evaluate` accepts one as a hypothesis, for the reason it
accepts `repeatsAuthorised` as one. A dispense must not, or the person at the
counter picks which rule applies to them.

**5. `subject_type` is absent from the update contract.** It governs which
care-context ROOT the consultation engine resolves; flipping it leaves a chart
written under one taxonomy being read under another and orphans the profile row.
Registered as the wrong kind is a merge, not an edit.

**6. A daily ceiling reduces the SINGLE dose; it does not trim the total.** The
obvious implementation returns "220 mg, three times a day, 500 mg daily" — two
instructions that contradict each other.

**7. ⚠️ THE DOSE ROUNDS DOWN.** The only place in the codebase that deliberately
differs from half-up. `@rcln/inventory` rounds a stock conversion half-up because
a count that is systematically low is its own kind of wrong; rounding a dose up
past a maximum is an overdose, and the two errors are not comparable.

**8. `weightKg` on the wire is `"18.4"`, not `"18.400"`** — every decimal goes
through `decimalToString`, which does not pad to the column's scale. The computed
dose fields DO pad, because they report at a declared precision rather than
echoing a column.

---

## ⚠️ The defect this phase introduced, and how it was caught

`..090500` wrote

```sql
CHECK (weight_recorded_on IS NULL OR weight_kg IS NOT NULL)
```

which refuses a **date with no weight** — a row that says nothing — and happily
accepts a **weight with no date**, which is the exact state the feature exists to
prevent: a weight a dose gets calculated from without anybody being able to see it
was taken eight months ago. The contract had refused both directions all along, so
the gap was reachable only by a fixture, a backfill or a second service — which is
precisely the set of writers a CHECK exists to catch.

The **tenant-isolation case found it**: `refuses a weight with no day it was
taken` resolved instead of rejecting. `..091000` replaced it with
`("weight_kg" IS NULL) = ("weight_recorded_on" IS NULL)`. `..090500` was not
edited — Prisma checksums an applied migration, and the correction being its own
migration is also the honest record.

---

## Where to start

**⚠️ RUN THE REVIEWS FIRST**, over PI-9, PI-10 and PI-11 together. Point a
reviewer at:

- `setAnimalProfile` and `assertAnimalPatient` — the subject-type guard, and
  `assertContactBelongsToPatient`, which is the half the composite FK cannot do:
  the FK stops another CLINIC's contact and says nothing about another ANIMAL's.
- `calculateDose` — the one PHI read in the phase, and whether logging it as
  `PATIENT` rather than as a new `DataAccessResource` member is the right call.
- `evaluateSpeciesRestriction` — the no-subject branch, and whether an allow-list
  should ever be able to refuse a human (it must not, and there is a test).
- `weightBasedDose` — the cap-before-rounding order, and the downward rounding.
- `animal_profiles`' three CHECKs and its two-way owner, in
  `tests/integration/tenant-isolation/clinical.test.ts`.

And over PI-9 and PI-10:

- `executeRecall` — the recall row is locked before its scope is read, then the
  per-lot loop writes ledger legs, the lot's own status and the notice's row.
- `resolveRecallBatch` — the "no OTHER live recall still names this lot" check is
  what decides whether a lot goes back on sale. Two notices over one production
  run is ordinary.
- `listAffectedParties` — the one PHI read in the phase, its empty-scope guard
  (`{ batchId: { in: [] } }` must never collapse to `{}`), and its in-memory
  union.
- `setBatchHold` — the PI-2 fix, and the serial-status sync beside it.
- `recalls.product_visible`, the one plain FK in the phase.

**Then PI-12 (Online Pharmacy).** PI-22 (Reporting) now has recall and quarantine reports to write, and
PI-23 (identifier resolution) is where a "hold every future receipt of this lot
number" rule would belong — see the open item in the tracker.

---

## Files worth reading before touching recall

|                                                              |                                                                              |
| ------------------------------------------------------------ | ---------------------------------------------------------------------------- |
| `apps/api/src/services/recall/recall.service.ts`             | The four states, the one transaction, and what a branch-scoped executor does |
| `apps/api/src/services/recall/trace.service.ts`              | The line between the counts and the names, and why it is two routes          |
| `packages/db/prisma/schema/recall.prisma`                    | Why a recall is a document, and the two tenancy classes                      |
| `apps/api/tests/integration/recall.test.ts`                  | The dispense, the procedure, the empty lot, and the serialised lot           |
| `apps/api/tests/integration/tenant-isolation/recall.test.ts` | Two tables, two tenancy classes, and the CHECK constraints                   |
| `.kb/PharmacyInventory/TRACEABILITY.md`                      | The nine questions. Read before changing either trace                        |

---

## Files worth reading before touching consumption

|                                                                   |                                                                              |
| ----------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| `apps/api/src/services/consumption/consumption.service.ts`        | The transaction, the derived variance, and why the law is not asked          |
| `apps/api/src/services/consumption/template.service.ts`           | Versioning, and which half of it the database holds                          |
| `apps/api/src/services/consumption/shared.ts`                     | Why the location check differs from the dispensing one                       |
| `packages/db/prisma/schema/consumption.prisma`                    | The anchor argument, and the two tenancy classes                             |
| `apps/api/tests/integration/consumption.test.ts`                  | The glove and the implant, the three pairs of gloves, the correction ceiling |
| `apps/api/tests/integration/tenant-isolation/consumption.test.ts` | Five tables, two tenancy classes, and the CHECK constraints                  |

---

## Known issues

The full list is [KNOWN_ISSUES.md](KNOWN_ISSUES.md). The ones this session
created or inherited:

**1. Nothing has been clicked in a browser.** Three more screens and a panel.

**2. `pnpm test` still OOMs the api container**, and so does `pnpm typecheck`
now — the whole-monorepo parallel typecheck was killed with exit 137 and had to
be run package by package. Same class as the test OOM, unchanged since PI-4.
⚠️ Add `--forceExit` to every jest run.

**3. ⚠️ `prisma migrate reset` IS NOT `pnpm db:reset`.** Unchanged, and still
the trap that costs an hour.

**4. `@rcln/billing`'s package test suite fails to load**, and it did so BEFORE
this phase — verified by stashing the whole diff and re-running. A module
resolution problem in the generated Prisma client. Nobody has owned it yet.

**5. ⚠️ PI-9.9 UNCOVERED TWO DEFECTS IN PI-7's DISPENSING PATH, AND BOTH ARE
FIXED HERE.** The lot/serial picker is built; writing it hit two constraints
`dispense.service.ts` had the identical code for. (a) The candidate check was
planned for the LINE's quantity, so validating a chosen lot against it refused
every lot FEFO had not picked — the override was unusable through the API in both
services. (b) Assigning a serial to a patient set `assigned_patient_id` without
`assigned_at`, violating `serials_assignment_dated`: a 500 on every supply of a
serialised product to a patient. Both fixed, both with a regression test in
`pharmacy.test.ts` verified to FAIL against the reverted code.
⚠️ A reviewer should look at the dispensing change specifically — it is the
highest-risk write in the programme and PI-9 touched it.

**6. The consultation page's panel plans against the VISIT, not a procedure.**
The endpoint takes a procedure and the service uses it; that screen reaches a
record by encounter id and has none selected. A procedure-anchored panel belongs
inside the consultation engine.

**7. `regulatory.pack.approve` is still held by nobody**, which is correct
(OD-5). Until somebody holds it, no decision anywhere enforces.

---

## Tests

|                        |                                                                                                                                                                                                                                                                                                                            |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Currently passing**  | **255 api unit across 14 files** · **429 tenant-isolation across 24 files** · **1 067 integration across 48 files** · 79 `@rcln/regulatory` · 63 `@rcln/tax` · 59 `@rcln/permissions` · 45 `@rcln/documents` · 35 `@rcln/invoicing`. Lint 0 errors / 3 pre-existing warnings; typecheck green in every package; RLS at 126 |
| **Currently failing**  | `@rcln/billing`'s suite fails to LOAD, and did so before this phase. See known issue 4.                                                                                                                                                                                                                                    |
| **Migrations pending** | None. Two applied this session                                                                                                                                                                                                                                                                                             |

⚠️ **THE SUITE CANNOT BE RUN IN ONE GO.** Run unit, then tenant-isolation, then
the integration files in groups of roughly a dozen, all with `--forceExit`. The
same is now true of `pnpm typecheck`.

⚠️ **The process traps from PI-1 onwards all still apply.** Migrations replay in
NAME order and this repository's are hand-dated ahead of the wall clock.
`prisma migrate diff` wants `--from-config-datasource --to-schema ./prisma/schema
--script`, prints a dotenv banner to STDOUT that has to be stripped — **and it
still wants to DROP the two NOT NULLs CE-4 added by hand.** Delete those two
statements from anything it generates; PI-7's, PI-8's and PI-9's migration
headers all say so.
