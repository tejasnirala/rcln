# Next Session

**Read this first.** Updated at the end of every session.

**Written:** 2026-08-17 · **By:** session PI-9 (clinical consumption).

⚠️ **PI-9 IS BUILT AND NOT REVIEWED.** `/code-review` and `security-reviewer`
have not been run over it. The diff touches the schema, tenancy, permissions,
patient data, billing and raw SQL, so CLAUDE.md makes the security review
mandatory before merge — and it is not a formality: PI-1's review found two
CRITICALs, PI-3's three, PI-5's four and PI-8.11's one.

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
`feat/pi-9-clinical-consumption`, **COMPLETE**, ⚠️ **not reviewed**.

---

## What was changed in this session

| Area        | What landed                                                                                                                                                                 |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Schema      | `consumption_templates` + lines, `clinical_consumptions` + lines + allocations; `charge_requests.consumption_line_id`; `encounter_procedures` gains its composite-FK target |
| Migrations  | `20260908090000_clinical_consumption` (9 CHECKs, 2 partial uniques, 13 policies) · `..090500_data_access_resource_clinical_consumption`                                     |
| RLS         | `db:rls:check` green at **126** (was 121). Five `*_visible` policies over three plain FKs                                                                                   |
| Permissions | `consumption.record.read` / `.record` / `.override` / `.template.manage`                                                                                                    |
| Engine      | **The `INVENTORY` charge-request writer** — the caller PI-8 built the path for and left unwritten. `raiseChargeRequestsWithin` now takes `sourceType`                       |
| Services    | `services/consumption/{shared,template,consumption}.service.ts`                                                                                                             |
| Screens     | `/usage` — used, templates, one template — plus the consumption panel on the consultation. The panel is the one that matters                                                |

---

## Decisions taken this session that a later phase must not undo

**1. ⚠️ THE LAW IS NOT ASKED AT A CONSUMPTION.** No rule type in PI-5 addresses
ADMINISTERING a product — every one of them is about supplying it to somebody —
so `evaluateWithin` would answer `UNDETERMINED` for every product on the
platform, which refuses. PI-6.7's enforcement gate would swallow that TODAY,
which is precisely why it must not be relied on: the day a pack reaches
`PRODUCTION_ENABLED`, every procedure in the clinic would stop. The call site is
marked in `consumption.service.ts`'s header for whoever writes an administration
rule type.

**2. The variance is DERIVED and there is no `isOverride` on the request.**
Whether a line departs from its template is arithmetic the server does over two
numbers it already holds. A client-set flag is a control only the honest client
applies — PI-8.11's CRITICAL, exactly — and the contract suite asserts the field
is dropped rather than honoured if one is sent.

**3. An override is refused, never clamped.** Somebody without
`consumption.override` gets an error telling them to ask a colleague. Recording
the EXPECTED figure instead would put a quantity in the ledger nobody used,
which is the one outcome CLINICAL_CONSUMPTION.md rules out.

**4. Two anchors are built and two are declared.** `LAB_ORDER` and
`IMAGING_STUDY` are enum members with no column, refused by CHECK. The member
saves the lab phase a migration; the CHECK stops anybody claiming an anchor with
nothing behind it.

**5. A correction after the close is a second record; an amendment before it
restates the first.** Both write DELTA ledger legs — the ledger is append-only
either way. An amendment is refused once the consultation is signed OR once
anything on it has reached an invoice.

**6. The consumption panel lives on the consultation, not in its own section.**
The anchor is what makes the record traceable; a standalone form would have to
ask which patient and which procedure, which is a question the person in the
room has already answered and can get wrong.

---

## Where to start

**⚠️ RUN THE REVIEWS FIRST.** `/code-review` and `security-reviewer` over the
whole diff. Point a reviewer at these, because they are where the phase took its
risks:

- `restateLine` — the delta arithmetic on an amendment, and the
  delete-and-re-raise of its charge request. It is the newest code in the phase
  and the least exercised by a screen.
- `recordReversal` — the ceiling ("what came off minus what has gone back") is
  computed under the caller's row lock. PI-8.11's `alreadyCreditedByItem`
  finding in this domain.
- `assertMayOverride` — enforced in the SERVICE and not at the route, because
  whether a body contains a variance is not knowable until the units are
  converted. `permissionCodes` is resolved at the router and passed down.
- `assertNoOverlap` — a read-then-write left deliberately unlocked, with the
  reasoning recorded rather than assumed.
- The five new `*_visible` policies, over three plain FKs.

**Then PI-10 (Recall & Traceability)**, which is the natural next phase: PI-9
just gave it the second half of the question. A recall that walked only
`dispense_allocations` would miss every implant ever fitted;
`consumption_allocations(organization_id, batch_id)` and `(…, serial_id)` are
indexed for exactly that walk. PI-12 (Online Pharmacy) is also open.

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
