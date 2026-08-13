# Next Session

**Read this first.** Updated at the end of every session.

**Written:** 2026-08-13 · **By:** session PI-5 (Global Regulatory Framework)

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
**PI-5** Global regulatory framework — this session, on
`feat/pi-5-regulatory-framework`. Not pushed. **Both reviewers have run and every
finding is fixed** — four CRITICALs, one MEDIUM, and nine smaller. See the
CHANGELOG; the two worth carrying forward are decisions 5 and 6 below.

---

## What was changed in this session

| Area        | What landed                                                                                                                                  |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| Schema      | 6 tables, 8 enums. **Five are PLATFORM (no `organization_id`)**; only `product_regulatory_profiles` is tenant data                           |
| Migration   | 1 — `20260818090000_regulatory_framework`. NULLS NOT DISTINCT ×2, 5 CHECKs, 2 trigger functions, grants                                      |
| RLS         | `db:rls:check` green at **89** (was 88). The five platform tables are EXEMPT, with the `tax_rule_defaults` reasoning, and trigger-guarded    |
| Package     | **`@rcln/regulatory`** — `evaluate()`. No Prisma, no clock, no country. 43 unit tests                                                        |
| Permissions | `regulatory.rule.read` / `.manage`, `regulatory.pack.approve`, `product.regulatory.read` / `.manage`                                         |
| Routes      | `/v1/regulatory/*` (read + evaluate) · `/v1/platform/regulatory/*` (the console) · `/v1/products/:id/regulatory-profiles`                    |
| Web         | `/regulatory` — Places, Regulators, Rule packs (+ detail), Sources — the maturity rail, a Regulatory tab on the product, a "Rules" nav entry |
| Tests       | 43 package · 16 integration · 13 isolation. **Isolation suite at 307 across 15 files**; unit 176; every integration slice green              |

---

## The six decisions worth knowing before you touch this

### 1. THE LAW HAS NO RLS POLICY, AND A TRIGGER IS WHAT PROTECTS IT

```
jurisdictions · regulatory_authorities · regulatory_sources ·
regulatory_rule_packs · regulatory_rules          PLATFORM, no organization_id
product_regulatory_profiles                       TENANT, platform-extensible
```

A policy on the first five would return zero rows for **everyone**: every tenant
reads them inside its own transaction, so no rule would ever match and every
decision would come back `UNDETERMINED` — which refuses. Nobody could dispense
anything anywhere. Same argument as `tax_rule_defaults`.

⚠️ **`@rcln/db/unsafe` IS NOT AN OWNER CONNECTION.** It is the same `rcln_app`
role with no session variables, so a SELECT-only grant would lock the platform
console out of its own tables. What distinguishes a clinic from the console is
that the clinic's transaction CLAIMS A TENANT, so
`platform_law_not_tenant_writable` refuses a write whenever `app_current_org()`
is not null. Four isolation cases pin it, including the DELETE — which no policy
would have caught anyway, because Postgres applies no WITH CHECK to DELETE.

### 2. `UNDETERMINED` REFUSES, AND THAT IS WHY NOTHING IS WIRED UP YET

No applicable rule, an unreadable parameters document, or a fact the rule needed
that nobody supplied — all `UNDETERMINED`, and every caller treats it as _refuse
and say so_.

⚠️ **SO PI-5 ENFORCES NOTHING.** With no pack configured anywhere, EVERY
evaluation is `UNDETERMINED` today; calling `evaluateFor` from the goods-receipt
or transfer path would stop every clinic on the platform from receiving stock.
PI-6 wires the call sites as it reaches `RULES_IMPLEMENTED`, jurisdiction by
jurisdiction. Until then the engine is reachable at
`POST /v1/regulatory/evaluate`, where a clinic can SEE the answer without
anything depending on it.

⚠️ **A MALFORMED RULE MUST NOT PERMIT.** `{"required": "yes"}` casts fine and
compares as `NaN`, and `NaN > limit` is `false` — so a careless engine lets a
broken rule through. Every parameter is validated before it is acted on; see
`parameters.ts`, and do not add a handler that reads `rule.parameters` directly.

### 3. THE SIGN-OFF LADDER HAS THREE LAYERS AND ONLY ONE CANNOT BE FORGOTTEN

```
…SOURCE_VERIFIED → REGULATORY_REVIEW_PENDING │ REGULATORY_REVIEWED → PRODUCTION_ENABLED
        code may set these                   │        a named human only
```

`regulatory.pack.approve` on the route · the ladder and demotion checks in
`approveRulePack` · and `regulatory_rule_packs_review_recorded`, which refuses
either state ARRIVING without a reviewer's name and the instant it was recorded.
The CHECK is the one a later migration or a psql session cannot route around.

⚠️ **NO SYSTEM ROLE HOLDS THE CODE, AND `ORG_OWNER` IS EXCLUDED BY NAME.** It is
an "everything except" role and would otherwise acquire it silently — the same
trap `CLINICAL_AUTHORING` already guards. OD-5 is resolved: the mechanism exists,
and _which person_ holds it is a grant somebody makes out of band.

⚠️ **A RULE CANNOT BE ADDED TO A SIGNED-OFF PACK.** A sign-off is a statement
about the rules that existed when it was made; a seventeenth rule arriving
afterwards puts the reviewer's name on something they never saw.

### 4. `REGULATORY_REVIEWED` IS AN EIGHTH MATURITY THAT PI-ADR-009 DOES NOT DRAW

That ADR's chain has seven states and its own prohibition names a state the chain
omits. Reviewing the content and deciding the platform may act on it are two
decisions; one button for both is the button pressed twice by accident. Recorded
as a deliberate refinement, like PI-2's `EXPIRY`-is-a-MOVE and PI-3's
document-held in-transit.

### 5. ⚠️ A RULE THAT SAYS NOTHING CHECKABLE IS BROKEN, NOT PERMISSIVE

The review's worst finding, and the reason `parameters.ts` now refuses a document
that omits its rule type's essential key:

```
parameters: { require: true }   ONE TYPO   ->  PERMITTED  (before)
                                           ->  UNDETERMINED, which refuses (now)
```

`readBoolean` cannot tell ABSENT from MISSPELLED — nothing can — and the handler
read an absent `required` as "no prescription is required here". Worse, a
REGIONAL rule supersedes the national rule of its type, so one typo in one state
switched off the country's rule as well.

⚠️ **THE GAP THAT LET IT SHIP: every "nothing is configured" test tested an
absent RULE, and none tested a rule that EXISTS with an empty document.** If you
add a rule type, add both.

### 6. ⚠️ A CONCURRENCY TEST TOOK THREE ATTEMPTS AND THE FIRST TWO WERE GREEN

`createRule` read the pack it decides against and wrote to a different table, with
no lock — PI-4's lesson verbatim. All three writers now take `SELECT … FOR UPDATE`
on the pack. What is worth carrying forward is how nearly the test lied:

1. Two real calls racing under `Promise.allSettled` — **passed with the lock
   removed.** The interleaving needs the read before the commit and the write
   after, and transactions started microseconds apart mostly decline.
2. Holding the row and asserting `approveRulePack` blocks — **passed with the lock
   removed too**, because that function's own `UPDATE` takes a row lock anyway. It
   was measuring Postgres, not the code.
3. Only `createRule` discriminates, because its WRITE targets a different table.

⚠️ **Whatever you write in PI-6, remove the lock and watch it go red before you
keep it.** Twice here, a test that could not fail looked exactly like one that
could.

---

## Current phase / current task / next task

|                   |                                                         |
| ----------------- | ------------------------------------------------------- |
| **Current phase** | PI-5 — complete. Both reviews run and acted on          |
| **Current task**  | **Nothing.** PI-5 is done bar a browser                 |
| **Next phase**    | PI-6 — India rule pack                                  |
| **Next task**     | **PI-6.1 — research and populate `regulatory_sources`** |

### Before starting PI-6

1. ⚠️ **DO NOT INVENT LEGAL RULES. THIS IS THE ONE THAT MATTERS MORE THAN ANY
   ARCHITECTURE NOTE IN THIS FILE.** `regulatory_rules.source_id` is NOT NULL and
   a source is the **regulator's own publication** — not a summary, not a vendor
   blog, not a law-firm note, and never a model's recollection. A rule whose
   source cannot be found is NOT WRITTEN, and the country's cell in
   [COUNTRY_SUPPORT_MATRIX.md](COUNTRY_SUPPORT_MATRIX.md) stays
   `RESEARCH_REQUIRED`, which is a correct and useful outcome. A hallucinated
   schedule in a dispensing system is a patient-safety defect that will look
   completely plausible.

2. **The platform console has endpoints and no screens.** All the CRUD is at
   `/v1/platform/regulatory/*` and is tested; PI-6 builds the admin UI alongside
   the first pack somebody actually has to type in.

3. **Wiring a call site is PI-6's job, and it is a behaviour change at every
   clinic in that jurisdiction.** `RULES_IMPLEMENTED` means dispensing, counter
   sale, receipt and disposal consult `evaluateFor`. Do it per jurisdiction and
   remember what decision 2 says about what happens to clinics whose place is not
   configured.

4. **Test the DECISION, never the country.** `expect(country).toBe('IN')` is
   forbidden; `packages/regulatory/tests/engine.test.ts` shows the shape, using a
   fictional `TL` so that nothing in it can be read as a legal position.

5. ⚠️ **`pnpm typecheck` NOW OOMs THE API CONTAINER TOO**, not just `pnpm test`.
   Both must be run per package or by path. KNOWN_ISSUES defect 2, and it got
   worse this session rather than better.

---

## Files that must be inspected before continuing

| File                                                             | Why                                                                    |
| ---------------------------------------------------------------- | ---------------------------------------------------------------------- |
| `packages/regulatory/src/engine.ts`                              | The precedence rules, and why silence never permits                    |
| `packages/regulatory/src/selection.ts`                           | Effective dating and specificity — the "region beats country" ordering |
| `packages/regulatory/src/parameters.ts`                          | Why a malformed rule is `UNDETERMINED` and not a cast                  |
| `apps/api/src/services/regulatory/evaluation.service.ts`         | The seam. The only place that loads a rule row                         |
| `apps/api/src/services/platform/regulatory.service.ts`           | The console, the ladder, and the three refusals around sign-off        |
| `packages/db/prisma/migrations/20260818090000_…framework/`       | The two triggers, and why a grant could not do their job               |
| `apps/api/tests/integration/tenant-isolation/regulatory.test.ts` | The width that is deliberate, and the writes that are not              |

---

## Known issues

**1. Nothing has been clicked in a browser.** The same item PI-1 through PI-4 each
left, now across five more screens.

**2. `pnpm typecheck` and `pnpm test` both OOM the api container.** Run by
package or by path. Worse than PI-4 recorded it.

⚠️ **AND AN INTERRUPTED RUN OF A SUITE WITH PLATFORM FIXTURES POISONS THE NEXT
ONE.** `jurisdictions` is keyed on `(country_code, region_code)`, so the fixtures
cannot be made unique per run the way a tenant-scoped suite's can. The regulatory
suite now cleans up BEFORE it seeds as well as after; any later suite that writes
platform rows needs the same, or a killed run presents as a page of unrelated
failures in `beforeAll`.

**3. `regulatory.pack.approve` is held by nobody**, which is correct (OD-5) and
means PI-6 cannot reach `PRODUCTION_ENABLED` for India until a named person is
granted it.

**4. `regulatory_decisions` does not exist.** PI-ADR-008's snapshot lands with its
first writer — PI-7 or PI-9 — rather than as a polymorphic guess about a
transaction that does not exist yet. The decision object already carries
everything it needs.

**5. The platform regulatory console has no screens.** Endpoints only.

**6. `stock_transfer_lines` still renders in a nondeterministic order.**
KNOWN_ISSUES defect 1, unchanged since PI-3.

**7. Three permission codes are still under `pharmacy.*` and should not be.**
Unchanged since PI-4; renaming one silently revokes it.

**8. In-transit stock and stock on order are still not in `stock_balances`.**
Unchanged; PI-22's valuation must add both.

**9. The product pickers are still capped at 100 rows.** PI-23. The jurisdiction
picker on the regulatory profile form is capped the same way and for now that is
generous — there are ten target countries.

**10. `CONSUMED` is still a reservation state nothing can reach.** PI-7, PI-9.

---

## Tests

|                        |                                                                                                                                             |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| **Currently passing**  | 176 unit · 43 `@rcln/regulatory` · **307 isolation across 15 files** · 779 integration across 34 files. Lint and typecheck green; RLS at 89 |
| **Currently failing**  | None.                                                                                                                                       |
| **Migrations pending** | None. One applied this session                                                                                                              |

⚠️ **THE SUITE CANNOT BE RUN IN ONE GO.** Run unit, then tenant-isolation, then
the integration files in groups of roughly nine.

⚠️ **The process traps from PI-1 through PI-4 all still apply.** Migrations replay
in NAME order and this repository's are hand-dated ahead of the wall clock, so
anything Prisma generates must be re-dated past the highest existing directory. An
applied migration is checksummed including its comments. `prisma migrate diff`
wants `--from-config-datasource --to-schema ./prisma/schema --script`, and prints
a dotenv banner to STDOUT that has to be stripped from the generated file.

⚠️ **A NEW ENUM VALUE AND A CHECK THAT NAMES IT STILL CANNOT SHIP IN ONE
MIGRATION** — but PI-5 did not hit it, and the distinction is worth recording:
the rule is about `ALTER TYPE … ADD VALUE`. A type CREATED in the same
transaction may be used in a CHECK immediately, which is why
`regulatory_rule_packs_review_recorded` names two members of a type created six
statements above it.

---

## Unresolved questions

**Resolved this session:** **OD-5** — a platform admin holding
`regulatory.pack.approve`, a code no system role carries. See
[OPEN_DECISIONS.md](OPEN_DECISIONS.md).

**Still open:** OD-3 (localisation — needed before PI-19+), OD-4 (whether the
platform ships a seeded catalogue — **needs the user**), OD-6, OD-7, OD-8.

---

## Do not

- Do not restart PI-0 through PI-5.
- **Do not invent a legal rule.** No source, no rule. See point 1 above.
- Do not let anything default to permitted. `UNDETERMINED` refuses, everywhere.
- Do not read `rule.parameters` without parsing it. A `NaN` comparison permits.
- Do not add a rule type whose essential key is optional in its parser. See
  decision 5 — a document that says nothing checkable must be `UNDETERMINED`.
- Do not keep a concurrency test you have not watched fail. See decision 6.
- Do not edit a signed-off pack, in any field. `assertPackIsOpen` is called from
  all three writers now, and it is called for the DATES as much as the maturity.
- Do not add a second reader of `regulatory_rules`. `evaluateFor` is the seam, and
  a second opinion about the law diverges in the permissive direction.
- Do not put a country code in a service, a controller, a component or a test
  helper. A behaviour that cannot be expressed as a rule row is a gap in the
  framework, to be fixed there.
- Do not set `REGULATORY_REVIEWED` or `PRODUCTION_ENABLED` from a migration, a
  seed, a script or an agent. Not once, not for a demo.
- Do not add a rule to a pack that has been signed off. Publish a new version.
- Do not put a tenant category, or any tenant id, on a rule.
- Do not give the five platform tables an RLS policy. Read decision 1 first.
- Do not compare a `@db.Date` column against an instant. Use `startOfCalendarDay`.
- Do not add a second writer to `stock_ledger`, or write `stock_balances` from
  application code.
- Do not hand-name an index in a migration.
- Do not rename `pharmacy.supplier.*` or `pharmacy.purchase_order.*`.
