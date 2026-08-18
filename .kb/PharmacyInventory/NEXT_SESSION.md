# Next Session

**Read this first.** Updated at the end of every session.

**Written:** 2026-08-18 · **By:** session PI-10 (recall & traceability).

⚠️ **PI-9 AND PI-10 ARE BOTH BUILT AND NEITHER IS REVIEWED.** `/code-review` and
`security-reviewer` have not been run over either. Both diffs touch the schema,
tenancy, permissions and patient data, so CLAUDE.md makes the security review
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
`feat/pi-9-clinical-consumption`, **COMPLETE**, ⚠️ **not reviewed**. **PI-10**
Recall & traceability — `feat/pi-10-recall-traceability`, **COMPLETE**, ⚠️ **not
reviewed**.

---

## What was changed in this session

| Area        | What landed                                                                                                                    |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------ |
| Schema      | `recalls` (org-only) + `recall_batches` (org + branch); four new enums; three members added to existing enums                  |
| Migrations  | `20260909090000_recall_traceability` · `..090500_recall_enum_members` · `..091000_recall_release_movement_direction`           |
| RLS         | `db:rls:check` green at **128** (was 126). One `product_visible`; `recall_batches.batch_id` needs none — it is a composite FK  |
| Permissions | `recall.notice.read` / `.create` / `.execute`, and `recall.trace.patients` — the PHI one, implied by none of the other three   |
| Services    | `services/recall/{shared,recall,trace}.service.ts`                                                                             |
| Routes      | `/v1/recalls` and `/v1/traceability/{forward,backward,affected}`                                                               |
| Screens     | `/product-recalls` — notices, one notice, trace a lot. ⚠️ NOT `/recalls`: `/recall` is already the front desk's follow-up list |
| Fixed       | ⚠️ **`setBatchHold` could not hold a serialised lot at all** — a PI-2 defect, live since PI-2, on every implant in the clinic  |

---

## Decisions taken this session that a later phase must not undo

**1. ⚠️ THE COUNTS AND THE NAMES ARE TWO ROUTES AND TWO PERMISSIONS.**
`/v1/traceability/forward` answers "37 supplies, 4 procedures, 29 people" under
`recall.notice.read` and names nobody. `/v1/traceability/affected` answers with
names and phone numbers, requires `recall.trace.patients` ON TOP of the read
code, and files one `RECALL_TRACE` disclosure row carrying the count.
TRACEABILITY.md's "the link always exists in the data; who may see it is an
access-control question" is exactly this, and `route-gates.test.ts` asserts both
halves.

**2. ⚠️ A BRANCH-SCOPED EXECUTOR PULLS ONLY THEIR OWN LOTS, AND THAT IS
CORRECT.** `recall_batches.branch_isolation` makes the rest invisible; they
cannot reach another site's shelf physically either. So execution is IDEMPOTENT
over PENDING rows, `recalls.status = EXECUTED` means "somebody executed it"
rather than "everything is held", and `closeRecall` refuses while anything is
still PENDING.

**3. Cancelling puts no stock back.** Releasing a held lot is a decision taken
per lot by somebody looking at that lot, and it writes a movement and states a
reason. `cancelRecall` refuses while anything is HELD rather than silently
releasing everything under one sentence.

**4. A recall is a document, not two columns on a batch.** `batches.recalled_at`
answers "is this lot recalled"; it cannot answer "which of the eleven lots have
we found, and how much did we pull". Both are written in one transaction.

**5. `RECALL_RELEASE` is its own movement type**, for the reason
`PURCHASE_RETURN` is not a `TRANSFER_OUT`. Four places must agree and the enum
migration names them.

**6. The law is not asked at a recall, and the call site is marked.** No rule
type in PI-5 addresses WITHDRAWING a product; `evaluateWithin` would answer
`UNDETERMINED`, which refuses. A rule engine that could REFUSE a recall would be
a defect wearing a control's clothes. The same call PI-9 made about administering.

---

## Where to start

**⚠️ RUN THE REVIEWS FIRST**, over PI-9 and PI-10 together. Point a reviewer at:

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

**Then PI-12 (Online Pharmacy)** or **PI-11 (Veterinary Enablement)**; both are
unblocked. PI-22 (Reporting) now has recall and quarantine reports to write, and
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
