# Next Session

**Read this first.** Updated at the end of every session.

**Written:** 2026-08-16 · **By:** session PI-7 (Pharmacy Dispensing)

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
**PI-7** Pharmacy dispensing — this session, on
`feat/pi-7-pharmacy-dispensing`. Not pushed, not reviewed.

---

## What was changed in this session

| Area        | What landed                                                                                                                               |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| Framework   | KNOWN_ISSUES **#3 and #4 closed in `@rcln/regulatory`** — the endorsed repeat and the prescriber proviso. Neither India rule was weakened |
| Schema      | 8 tables: the six dispensing ones, `prescription_fulfilments`, and **`regulatory_decisions`** — PI-ADR-008's snapshot, first written here |
| Migration   | `20260825090000_pharmacy_dispensing` — 12 CHECKs, the append-only pair on the snapshot, 14 policies                                       |
| RLS         | `db:rls:check` green at **118** (was 111)                                                                                                 |
| Permissions | **`pharmacy.dispense.verify`** is new; `PHARMACIST` holds it beside `.create`                                                             |
| Services    | `pharmacy/{shared,consult,queue,dispense,return,substitution,dashboard}.service.ts`                                                       |
| Seam        | `planStockAllocationWithin(tx, …)` split out, the way `evaluateWithin` was                                                                |
| Errors      | `RegulatoryRefusalError` — 422, with the rule's own sentence                                                                              |
| Screens     | 7, under `/pharmacy`. The workspace is the one that matters                                                                               |

---

## Decisions taken this session that a later phase must not undo

**1. A dispense has no draft.** The physical act and the record are one event.
Everything — record, allocations, ledger legs, snapshot, audit, queue state — is
one transaction, and the number is taken last so a refusal burns none.

**2. Every supplied line carries a NOT NULL `regulatory_decision_id`.** A code
path that forgets to ask the engine cannot compile. Nothing re-evaluates a
historical supply, and `regulatory_decisions` is append-only in two layers.

**3. The India rule parameters were edited in place, once, in the only window
where that was defensible** — before any decision could cite a rule. The next
change to those rules is a new version with `SUPERSEDED` on the old one.

**4. A counter sale is `kind: COUNTER_SALE` on `POST /dispenses`,** not a
`/sales` route. Two endpoints would be two code paths, and the quieter one is the
one that stops asking the engine.

**5. A return quarantines unless the clinic asks AND the engine does not
object.** "No rule objected" is not "a regulator says a returned medicine may be
resold".

**6. Pharmacy writes no column on the clinical record.** Fulfilment progress is
DERIVED from `dispense_lines`. `route-gates.test.ts` asserts no route on the
pharmacy router carries a `clinical.*` code.

---

## Where to start

**PI-8 — Billing & Tax Integration.** It is unblocked in both directions now: the
counter-sale path and the prescription path both produce supplies that nobody
bills. `charge_requests` + charge-policy resolution + wiring
`InvoiceSourceType.PHARMACY`, with the tax resolved through `@rcln/tax` and
nowhere else. A consumed glove produces no invoice line; an implant does.

Before that, two smaller things that are cheap now and expensive later:

- **KNOWN_ISSUES #8** — a nullable `repeats_authorised` on
  `encounter_prescriptions`, so a lawful endorsed repeat stops being refused. The
  framework already reads it; the clinical side has nowhere to write it.
- **KNOWN_ISSUES #9 and #5 together** — plumb the caller's effective permission
  codes and professional registrations into every consult. Both must land before
  any pack reaches `PRODUCTION_ENABLED`, because that is the day the engine
  starts refusing on what it was told.

---

## Files worth reading before touching pharmacy

|                                                                |                                                                     |
| -------------------------------------------------------------- | ------------------------------------------------------------------- |
| `apps/api/src/services/pharmacy/dispense.service.ts`           | The seven steps, and why step 4 comes before step 5                 |
| `apps/api/src/services/pharmacy/consult.ts`                    | How a supply asks the law, and what it does with the answer         |
| `apps/api/src/services/pharmacy/shared.ts`                     | The snapshot, and the fulfilment arithmetic that is derived         |
| `packages/db/prisma/schema/pharmacy.prisma`                    | Why there is no draft, and where the PHI is                         |
| `packages/db/prisma/migrations/20260825090000_…dispensing/`    | The CHECKs, the append-only pair, and the two lines deleted by hand |
| `apps/api/tests/integration/pharmacy.test.ts`                  | The refusals, the FEFO split, and the burned-number case            |
| `apps/api/tests/integration/tenant-isolation/pharmacy.test.ts` | The sibling-branch case, which is the one that matters              |

---

## Known issues

The full list is [KNOWN_ISSUES.md](KNOWN_ISSUES.md). The ones this session
created or inherited:

**1. Nothing has been clicked in a browser.** Seven more screens, same as every
phase before it.

**2. `pnpm typecheck` and `pnpm test` still OOM the api container** when turbo
runs them together. Run by package, and the api integration suite by path in
groups of roughly nine. Unchanged since PI-4.

**3. An endorsed repeat still refuses** (#8) — the framework can express it and
the clinical record cannot record it.

**4. `licenceTypes` is always empty** (#9) and **`priorQuantityInPeriodBase` is
never supplied** (#10). Both latent; both must be closed before a pack is signed
off.

**5. Supplying a substitute is API-only** (#11). The equivalents screen is
read-only.

**6. The pharmacy dashboard counts "today" in UTC** (#12).

**7. `regulatory.pack.approve` is still held by nobody**, which is correct
(OD-5). Until somebody holds it, no decision anywhere enforces.

---

## Tests

|                        |                                                                                                                                                    |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Currently passing**  | 219 api unit · 79 `@rcln/regulatory` · **391 isolation across 22 files** · 1 062 integration across 43 files. Lint and typecheck green; RLS at 118 |
| **Currently failing**  | None.                                                                                                                                              |
| **Migrations pending** | None. One applied this session                                                                                                                     |

⚠️ **THE SUITE CANNOT BE RUN IN ONE GO.** Run unit, then tenant-isolation, then
the integration files in groups.

⚠️ **The process traps from PI-1 onwards all still apply.** Migrations replay in
NAME order and this repository's are hand-dated ahead of the wall clock.
`prisma migrate diff` wants `--from-config-datasource --to-schema ./prisma/schema
--script`, prints a dotenv banner to STDOUT that has to be stripped — **and in
this repository it also wants to DROP two NOT NULLs that CE-4 added by hand.**
Delete those two statements from anything it generates; the header of PI-7's
migration says so too.
