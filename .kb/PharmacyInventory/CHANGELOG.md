# Changelog

One entry per session. Newest first. Record what changed and why — not what was
discussed.

---

## 2026-08-18 — PI-10: getting it back off the shelf

**Phase:** PI-10 · **Branch:** `feat/pi-10-recall-traceability` · **Result:**
complete, **not reviewed** · **Tests:** +21 unit, +23 integration, +14 isolation,
+5 route-gate cases. Lint (0 errors, 3 pre-existing warnings), typecheck and
`db:rls:check` (128 tables) green. ⚠️ `/code-review` and `security-reviewer` NOT
run.

Two tables, and the smallest phase in the programme to reach the furthest:
executing one row makes a product un-dispensable and un-consumable at every
branch at once, and its second half is a list of named people who already have
it.

### What the phase had to decide, and what it decided

**A recall is a document, not two columns on a batch.** PI-2 shipped
`batches.recalled_at` and `.recall_reference` and said the workflow was PI-10.
Those answer "is this lot recalled" and cannot answer "which of the eleven lots
have we found, which branch still has some, and how much did we pull". Both are
now written in one transaction with the movement that makes them true — the
discipline `setBatchHold` already applied to one lot.

**⚠️ A branch-scoped executor pulls only their own lots.** `recall_batches` is in
the branch RLS loop, so the rest are invisible to the statement that reads them.
That is correct — they cannot reach another site's shelf physically either — and
the consequences are written down rather than discovered: execution is idempotent
over PENDING rows, `EXECUTED` means "somebody executed it", and `closeRecall`
refuses while anything is still PENDING.

**⚠️ The counts and the names are two routes and two permissions.**
TRACEABILITY.md says the link always exists in the data and who may SEE it is an
access-control question. `/forward` answers "37 supplies, 4 procedures, 29
people" and names nobody; `/affected` answers with names under
`recall.trace.patients` ON TOP OF the read code, and files one `RECALL_TRACE`
row carrying the count. Both halves are asserted in `route-gates.test.ts`.

**`RECALL_RELEASE` is its own movement type**, for the reason `PURCHASE_RETURN`
is not a `TRANSFER_OUT`: the statuses would be right and the word would be wrong,
and every report grouping by `movement_type` would file a withdrawn notice
alongside a fridge that came back up to temperature.

**The screen is "Product recalls".** `/recall` already means the front desk's
patient follow-up list (CE-5).

### ⚠️ The PI-2 defect it found

**A serialised lot could not be held at all.** `recordMovementIn` refuses a
movement of a serial-tracked product that names no serial, and `setBatchHold`
read the balance rows without `serial_id`. So `POST /batches/:id/hold` — live
since PI-2 — raised a validation error for every implant in the clinic and pulled
nothing. Nothing in the inventory suite had ever held a serialised lot, so it
shipped. Fixed on both paths; the serials now follow the lot, `ISSUED` ones
excepted. **The regression test was verified to fail against the reverted code.**

### What landed

| Area        | What                                                                                                                               |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| Schema      | `recalls` (org-only), `recall_batches` (org + branch); `RecallStatus`, `RecallClassification`, `RecallSource`, `RecallBatchStatus` |
| Enums       | `StockMovementType.RECALL_RELEASE`, `NumberSequenceType.RECALL`, `DataAccessResource.RECALL_TRACE`                                 |
| RLS         | `db:rls:check` green at **128** (was 126). One `product_visible`; `recall_batches.batch_id` needs none — it is composite           |
| Permissions | `recall.notice.read` / `.create` / `.execute` and `recall.trace.patients`; a new `recall` module                                   |
| Contracts   | `packages/contracts/src/recall.ts`                                                                                                 |
| Services    | `services/recall/{shared,recall,trace}.service.ts`                                                                                 |
| Routes      | `/v1/recalls` · `/v1/traceability/{forward,backward,affected}`                                                                     |
| Web         | `/product-recalls` (notices, one notice, trace a lot) plus a "Product recalls" nav entry                                           |
| Fixed       | `setBatchHold` on a serialised lot, and serial status following its lot                                                            |

---

## 2026-08-17 — PI-9: what the procedure used

**Phase:** PI-9 · **Branch:** `feat/pi-9-clinical-consumption` · **Result:**
complete, **not reviewed** · **Tests:** +24 unit, +24 integration, +19 isolation,
+4 route-gate cases. Lint (0 errors), typecheck and `db:rls:check` (126 tables)
green. ⚠️ `/code-review` and `security-reviewer` NOT run.

The other writer of the seam PI-8 built. A dispense is stock going into somebody's
hand at a counter; this is stock going into somebody during a procedure, and the
charge engine cannot tell the difference — which is the whole point of
PI-ADR-005.

### What the phase had to decide, and what it decided

**The law is not asked.** This is the decision most likely to be questioned, so
it is first. Every rule type in PI-5 is about SUPPLYING a product to a person —
may this be dispensed, may it be substituted, was a prescription presented. A
clinician using an anaesthetic on their own patient during a procedure they are
performing is not a supply, no rule addresses it, and calling `evaluateWithin`
would answer `UNDETERMINED` — which refuses — for every product on the platform.
PI-6.7's enforcement gate would swallow that today, and that is precisely the
argument against relying on it: the day a named human moves a pack to
`PRODUCTION_ENABLED`, every procedure in the clinic stops. The call site is
marked in the service header for whoever writes an administration rule type.

**Two anchors are built and two are declared.** `ENCOUNTER` and
`ENCOUNTER_PROCEDURE` carry columns; `LAB_ORDER` and `IMAGING_STUDY` are enum
members with none, refused by `clinical_consumptions_anchor_is_resolvable`. A
polymorphic `(subject_type, subject_id)` pair was refused for the reason the
tracker predicted: it cannot carry a composite FK, so the database cannot
tenant-check it.

**A correction after the close is a second record; an amendment before it
restates the first — and both write DELTA ledger legs**, because `stock_ledger`
has no update path. What an amendment buys is that the record reads as one event
rather than three, which is what a clinician correcting a typo thirty seconds
later means. It is refused once the consultation is signed OR once anything on it
has reached an invoice.

**Four permission codes, not the two the plan named.** Reading needed its own
because a doctor holds no `inventory.stock.read` and would otherwise be unable to
see the panel on their own consultation. Writing templates needed one because
deciding what a procedure is EXPECTED to use sets the baseline every variance is
measured against — a configuration act, beside `inventory.reason_code.manage`.

### The PI-8.11 lessons, applied rather than repeated

- **There is no `isOverride` on the request contract at all.** Whether a line
  departs from its template is arithmetic the server does over two numbers it
  already holds. The contract suite asserts the field is DROPPED rather than
  honoured if a client sends one — which is the case that fails the day somebody
  adds it back, and the direct analogue of the dispensing CRITICAL where every
  control hung off a client-set field.
- **A line may not cite the glove's template line while consuming an implant.**
  Same class, different column: it would record an expectation of 2 against an
  implant and report a variance for something the template never listed.
- **`amendConsumption` and `correctConsumption` both lock the record first.** The
  reversal ceiling — what came off minus what has gone back — is
  `alreadyCreditedByItem` in this domain.
- **`assertNoOverlap` is a read-then-write that is NOT locked, and the reasoning
  is written down** rather than left to be discovered: the loser writes an
  overlapping window, not a corrupt one, and the resolver breaks the tie
  deterministically. The failure mode is a wrong pre-fill in front of a human,
  not a movement of stock.

### Three things this phase found in earlier work

1. **`encounter_procedures` had no `@@unique([organization_id, id])`**, so
   ADR-0004's composite FK could not be drawn to it. Every other clinical parent
   already carried one; this table was simply the first thing ever to reference
   it. Added here.
2. **`charge_requests_reference_matches_kind` permitted an `INVENTORY` request
   citing nothing at all.** PI-8 wrote that branch deliberately — "audible rather
   than silently legal" — while no caller existed. PI-9 is the caller, and the
   constraint is REPLACED (not edited: Prisma checksums an applied migration) to
   require the consumption line.
3. **`raiseChargeRequestsWithin` hard-coded `sourceType: 'PHARMACY'`.** It now
   takes it, required and undefaulted — a default would have made PI-9's first
   write a PHARMACY request citing a consumption line.

### An override is refused, never clamped

Somebody without `consumption.override` gets an error telling them to ask a
colleague who holds it. The alternative — silently recording the EXPECTED figure
— would put a quantity in the ledger nobody used, which is the one outcome
CLINICAL_CONSUMPTION.md rules out by name. The web panel keeps the field
editable either way and warns before the round trip, because a screen that
clamped the number would invite exactly that substitution.

### PI-9.9, and the two defects the picker uncovered

The panel offers the candidate lots — and, for a serialised product, the
individual numbered devices — with FEFO's proposal pre-filled. Building it found
two bugs that were ALSO live in PI-7's dispensing path, which had the identical
code and no test that exercised either:

1. **The candidate check was narrowed to what FEFO would take, so every override
   was refused.** `planAllocation` stops once the requested quantity is covered,
   and both services validated the caller's chosen lots against a plan for the
   LINE's quantity — so any lot FEFO had not picked answered "that lot cannot be
   supplied", which is precisely the act the override exists to permit. The
   happy path was unaffected, which is why it shipped.
2. **Assigning a serial to a patient violated `serials_assignment_dated`** —
   `(assigned_patient_id IS NULL) = (assigned_at IS NULL)`, and both set the
   patient without the date. Every supply of a serialised product to a patient
   was a 500. Nothing in the pharmacy suite had ever dispensed one.

Both fixed in both services, each with a regression test in `pharmacy.test.ts`
**verified to fail against the reverted code** — a regression test that passes
either way is worth nothing, and these guard the class of defect that survives
precisely because the ordinary path still works.

### What is open

`/code-review` and `security-reviewer` — and a reviewer should look at the
dispensing change specifically, because it is the highest-risk write in the
programme and this phase touched it. Nothing has been clicked in a browser.

---

## 2026-08-17 — PI-8: the counter's takings

**Phase:** PI-8 · **Branch:** `feat/pi-8-billing-tax-integration` · **Result:**
complete, **not reviewed** · **Tests:** +16 unit, +25 integration, +13 isolation,
+1 route-gate case. Lint, typecheck (45 tasks) and `db:rls:check` (121 tables)
green. ⚠️ `/code-review` and `security-reviewer` deferred to the owner.

The seam between what leaves the shelf and what a patient owes. PI-7 shipped
supplies that nobody billed; this bills them, and reverses them when they come
back.

### The three PI-7 leftovers were closed FIRST

NEXT_SESSION.md said #5, #8 and #9 all had to land before any pack reaches
`PRODUCTION_ENABLED`, because that is the day the regulatory engine starts
refusing on what it was told. All three are closed:

- **#9** — `membership_professional_registrations` hangs off `memberships`, and
  `regulatory/actor.service.ts` reads it into `RegulatoryActor.licenceTypes` AS
  AT THE MOMENT OF THE ACT. Status `ACTIVE` **and** an unexpired date, so a
  lapsed licence stops counting on the day it lapsed rather than on the day
  somebody updates the row.
- **#5** — `CatalogueActionOptions` gained `roleCodes`, and the two endpoints
  that actually consult the engine resolve them through an `actorMeta()` helper.
  The other twenty-seven stay on the synchronous `auditMeta` and pay nothing.
- **#8** — `encounter_prescriptions` gained a nullable `repeats_authorised` and
  `repeats_authorised_limit`. ⚠️ NULL is deliberately not `false`: silence is not
  a prescriber refusing a repeat, and a `true` with no limit still resolves
  `UNDETERMINED`, which refuses.

### The credit-note engine, which `voidInvoice` recorded as a deliberate gap

Phase 5 wrote: "no table, no number series, no `CREDIT_NOTE` source type… it is
also unreachable in a useful sense today". PI-8 gave it something to design
against — a dispensing return is money coming off a bill that has already been
handed over, at every pharmacy every day.

⚠️ **A credit note is an `invoices` row with `kind: CREDIT_NOTE`, not a parallel
set of tables.** The alternative duplicates the line arithmetic, the
apportionment, the per-line tax snapshot, the document join and — the part that
decides it — `invoices_lifecycle_guard`, which freezes an issued document's every
money column against an allow-list. A credit note has exactly that requirement,
so it gets exactly that trigger by being the same table. What the law actually
requires is a separate consecutive SERIES, and that is a period key:
`CRN-2026-PHA-MAIN-000001`. One table, two series.

It refuses four things: crediting what was never issued, crediting more than was
charged (summed across every LIVE note, not per note), crediting a line that is
not on the invoice, and crediting a credit note. It moves no money — there is
still no patient-payments table — which is `voidInvoice`'s honest boundary moved
one step forward rather than papered over.

### ⚠️ THE DESIGN DOCUMENT WAS WRONG ABOUT THE LINK BACK, AND THE DATABASE SAID SO

BILLING_INTEGRATION.md: "`charge_requests.invoice_item_id` is the only link
back". It cannot be. `finalizeInvoice` re-prices a draft from its stored inputs,
and `repriceLoadedDraft` does that by DELETING every `invoice_items` row and
writing them again — so an item id changes at least once between the draft being
raised and the document being issued. Any FK onto it either blocks finalisation
(`Restrict`) or silently detaches at the moment it matters.

Measured, not reasoned about: the first version had the FK, and finalisation
raised `charge_requests_organization_id_invoice_item_id_fkey`. The column is now
`invoice_id`, which is stable for the life of the document and is what every
question is actually about.

### The two requirements in tension, and how they are reconciled

A charge request must be written in the SAME transaction as its dispense — one
that could commit independently will, on the day the dispense rolls back, and the
clinic bills for medicine that never left the shelf. And it must NEVER be able to
stop that dispense — a pharmacist handing somebody their medicine cannot be
blocked because an accountant has not filled in a grid.

Resolved in one direction: every configuration gap is a NULLABLE COLUMN rather
than an error. No price → `unit_price IS NULL`. No tax classification →
`tax_category IS NULL`. Both are shown on the charge-review screen; the invoice
engine refuses to ISSUE an unrated line anyway, which is the right place for that
refusal because by then nobody is standing at a counter.

### Three gaps in earlier phases, found by this work and closed

1. **`dispense_lines` had no `product_visible` or `unit_visible` policy** — KI-3,
   on the most PHI-dense table in the programme. `encounter_prescriptions` has
   carried one since CE-4 for the identical plain FK, which makes it an oversight
   rather than a decision. A clinic could attach another clinic's private product
   to its own dispense line and read the name back through the join.
2. **`regulatory_decisions`' append-only REVOKE was undone by every reset.** The
   migration revokes; `ALTER DEFAULT PRIVILEGES` re-grants on the next
   `db:reset`, and the isolation case only fails AFTER one — which is why PI-7
   shipped green. Now restated in `grant-app.sql`, where every other append-only
   table already was.
3. **PI-2's inventory isolation fixture was not idempotent against a crash**, so
   any run that died early poisoned every later run with a `users_email_key`
   violation that said nothing about the real failure.

### The gap the phase had to be asked about twice

⚠️ **THE FIRST PASS SHIPPED A COMMENT DESCRIBING CODE NOBODY HAD WRITTEN, AND
CALLED THE PHASE COMPLETE.** `product-price-list.tsx` asserted that a price is
set from the PRODUCT screen — "that is where somebody already has the item, its
base unit and its packaging in front of them" — and no such control existed.
`saveProductPriceAction` was written and wired to nothing. The consequence was
not cosmetic: every charge request came out with a NULL `unit_price`, the charge
queue's gap rail lit up on every row, and `createInvoiceFromCharges` refused with
_"has no price. Set one on the price list"_ — pointing at a screen that could not
do it. The whole phase was unusable end to end from a browser.

The reasoning in the comment was right and is exactly what got built: a `Price`
tab on the product panel, before `Tax`, with a unit picker the API validates
against the product's own conversion graph. What was wrong was documenting an
intention in the present tense.

Three more went with it: per-line crediting reached the invoice screen (the API
had taken a line set from the start, and a partial return is the ordinary case);
KNOWN_ISSUES #1's nondeterministic transfer line order, taken because this
session touched `transfer.service.ts`, which is what the entry asked for; and
#12's UTC "today" on the pharmacy dashboard, now `date_trunc` over
`branches.timezone` in SQL.

And the linter caught the fix's own first version: `useEffect(() =>
setAdding(false), [state.status])` is a cascading render, and
`react-hooks/set-state-in-effect` is right about it. Comparing against the
previous value DURING render is React's documented pattern and commits nothing in
between.

### #10 and #11, closed in a third pass

**#10 — the quantity window travels BACKWARDS, from the rules to the caller.**
The entry's mitigation said "one query" and understated it: `periodDays` lives on
the RULE, so nobody can know the window before evaluating, and the engine is pure
(PI-ADR-007) so it cannot look the history up itself.
`EvaluationSupplements.priorQuantityInPeriod(windowDays)` inverts it —
`evaluateWithin` selects the applicable rules with the engine's own
`selectApplicableRules`, reads the window off them, and calls back into
`consultForSupply`, which is the only party that knows who the supply is for. The
engine still holds no Prisma client.

⚠️ **Two windows still refuse, and that is the design rather than a shortfall.**
`RegulatoryRequest` carries ONE scalar. The longer window over-counts for the
shorter rule and refuses lawful supplies; the shorter UNDER-counts for the longer
rule and PERMITS what the law forbids. Only one of those is survivable, so
neither is chosen and the engine says `UNDETERMINED`. A sale with no patient
refuses for the same reason: zero would let anyone take the limit again on every
visit, which is the pattern the rule exists to stop.

**#11 — the substitute swap, and the one line that makes it safe.** The workspace
gained a "Hand over" picker fed by equivalents fetched on the SERVER with the
plans, each option carrying what the engine said about substituting THAT product
HERE — in the option text, because a badge beside a dropdown is a badge nobody
reads.

⚠️ **A SUBSTITUTED LINE SENDS NO ALLOCATIONS.** The lots on that screen were
planned for the PRESCRIBED product and are meaningless for the substitute;
omitting them is the contract's own "you plan it", so the server runs
`planStockAllocationWithin` against the product actually being supplied. Sending
the prescribed product's lots would take stock off the wrong shelf while
recording the substitute's name — invisible from the screen that caused it, which
is why it has a test rather than a comment. `substitutionCandidate` gained
`baseUnitId` for the same class of reason: a quantity in the prescribed product's
unit converts against the wrong graph.

### What the reviews found, and what each turned out to be

Both reviewers ran over the whole diff. Three CRITICALs, two HIGHs, and a dozen
smaller. All fixed.

⚠️ **THE ONE WORTH REMEMBERING: PI-8's OWN SUBSTITUTION UI WIDENED A HOLE PI-8
HAD LEFT OPEN.** This phase went in specifically to close the KI-3 class on
`dispense_lines` and closed `product_id` — while `substituted_for_product_id`,
the column immediately below it, is a SECOND plain FK into `products`, is
accepted straight from the client, is written with no validation, and is joined
for its name onto the dispense detail screen. Then #11 added the picker that
makes it reachable from a browser. The model comment even says "plain FK**s**",
plural, describing a policy set that covered one of them. Closed, along with
`regulatory_decisions.product_id`, both with isolation cases.

**A credit note refunded GROSS where the patient had paid NET.**
`ORIGINAL_SELECT` never read the discount columns, so crediting a discounted
invoice in full issued a statutory document owing more than the clinic had ever
taken. And the ceiling that was supposed to catch it compared three different
bases in one subtraction — pre-tax gross against tax-inclusive `grand_total` —
which refused legitimate credits where the discount exceeded the tax and let
over-crediting through where it did not. The security review's exploit was two
API calls, no race: credit a sliver, then credit everything, ~10.7% overshoot at
12% GST. The ceiling now runs AFTER pricing, so both sides are `grand_total`.

**`createCreditNote` skipped `loadVisible`.** A holder of
`billing.credit_note.issue` could reverse any invoice in the organization,
including sources and practitioners their read visibility excludes — the write
committed and only the read-back on the way out 404'd.

**`raiseChargeRequestsWithin` could throw and block a pharmacist mid-supply** —
the one thing the file's header promises it cannot do. Deactivating a unit of
measure that a live price row is denominated in made every subsequent dispense of
that product throw inside the posting transaction. It degrades to the unpriced
case instead.

**A substituted line sent a quantity in the PRESCRIBED product's base unit
paired with the SUBSTITUTE's unit id.** Thirty tablets became thirty millilitres,
planned and posted, with nothing raising an error. Candidates are now filtered to
matching base units — converting would be worse, because silently restating a
dose is not something a dispensing screen may do.

**And `needsAttention` clobbered an explicit `status` filter** via object-literal
last-key-wins, directly underneath a comment arguing carefully for AND-ing over
OR-ing. The same trap `resolveTaxCategory` documents at length about repeated
`OR:` keys, one phase later and in the other direction.

Plus: medicine names interpolated into error messages that `errorHandler` logs
verbatim; the currency read fresh instead of frozen; a missing `canSeeSource`; a
branch-scoped member able to delete the clinic-wide default price; orphaned
REVERSAL charges; float money; `as number` casts standing in for `!`; an ungated
2N+1 fan-out.

### The two left open in the first pass, closed in a second

**Per-line crediting is now cumulative.** `invoice_items.credited_invoice_item_id`
links a note's line to the line it reverses, so the cap can sum across earlier
notes. ⚠️ It is carried through `StagedLine` and rewritten on every reprice —
finalisation always re-prices, and a column set once at creation is NULL by the
time the note is a document. That is exactly what killed
`charge_requests.invoice_item_id`, and a test asserts the link survives.

**The charge loop is five queries regardless of line count.** It was five PER
LINE, inside the transaction holding every batch and serial lock a supply takes.
Each batch resolver is the SAME function the single-product path uses, with the
singular delegating — a second copy of the tax precedence rule is how PI-1's
`NULLS LAST` CRITICAL comes back.

### The process trap worth writing down

⚠️ **`prisma migrate reset` IS NOT `pnpm db:reset`.** The package script is
`migrate reset && apply-grants && seed`; the raw command skips both. The symptom
is every tenant-isolation suite failing with `relation "audit_logs" does not
exist`, which reads as a broken migration and is actually `rcln_app` holding no
grants at all.

⚠️ **Prisma emits `@@unique` as a unique INDEX, not a table constraint**, so a
`NULLS NOT DISTINCT` rewrite needs `DROP INDEX` + `CREATE UNIQUE INDEX` and not
`ALTER TABLE … DROP CONSTRAINT`, which raises 42704.

---

## 2026-08-16 — PI-7: the counter opens

**Phase:** PI-7 · **Branch:** `feat/pi-7-pharmacy-dispensing` · **Result:**
complete · **Tests:** +12 unit (`@rcln/regulatory`), +24 integration, +13
isolation, +4 route-gate cases. Lint, typecheck and `db:rls:check` (118 tables)
green.

The highest-risk workflow in the programme, and the phase that has been blocked
since PI-0. CE-4 shipped `encounter_prescriptions`, which unblocked it.

### The two framework gaps were closed FIRST, and neither rule was weakened

KNOWN_ISSUES #3 and #4 said this had to happen before dispensing was wired, and
it did. `PresentedPrescription` gained `repeatsAuthorised` and
`repeatsAuthorisedLimit`; `RegulatoryActor` gained `isPrescriber`; the rule
parameters gained `endorsedRepeatsPermitted`, `maxEndorsedRepeats` and
`exemptWhenActorIsPrescriber`. India's pack opts into both clauses — rule
65(11)(b)'s endorsed repeat and s. 42(1)'s own proviso for a practitioner
dispensing to their own patients.

⚠️ **The India rule parameters were edited in place rather than superseded, and
that is defensible in exactly one window — this one.** PI-ADR-008 forbids
restating a rule a past decision cites, and no decision had ever cited one:
`regulatory_decisions` did not exist until this phase created it, and nothing
could dispense. The next change to those rules is a new version.

⚠️ **An endorsement stating no number resolves `UNDETERMINED`, which refuses.**
"The prescriber allowed repeats" without saying how many is a reason to ring the
prescriber, not a licence to keep dispensing.

### `regulatory_decisions` exists, and PI-ADR-008 is now literal

Branch-scoped tenant data, append-only in two layers — `rcln_app` holds no UPDATE
or DELETE and a trigger refuses both anyway — with the reasons, the conditions
and the pack versions frozen as documents. Every supplied line carries a NOT NULL
`regulatory_decision_id`, so a code path that forgot to ask the engine cannot
compile, and nothing ever re-evaluates a historical supply.

### A dispense has no draft, and that shapes everything

The medicine leaves the shelf once. So the workspace assembles a plan (which
writes nothing and holds nothing), a human confirms it, and ONE transaction
writes the record, its allocations, a `DISPENSING` leg per lot through
`recordMovementIn`, the snapshot, the audit row and the queue state. The number
is taken after every line has been consulted and planned — a refusal burns none.

`planStockAllocationWithin(tx, …)` was split out of `planStockAllocation` for the
reason `evaluateWithin` was split out of `evaluateFor`: a second transaction
cannot see the first's uncommitted work and can deadlock against its locks.

### A regulatory refusal is a 422, never a 403

New `RegulatoryRefusalError`. A 403 says "you may not do this" and sends a
pharmacist to an administrator to fix a permission that was never wrong; a 422
says "this supply is not lawful here today" and carries the rule's own sentence
to read to the patient. Enforcement is still gated at `PRODUCTION_ENABLED`, so
today every decision is recorded and reported and stops nothing.

### Invariant 7, enforced by a test rather than by good intentions

`route-gates.test.ts` now audits the pharmacy router and asserts that no route on
it carries a `clinical.*` code. Pharmacy writes `prescription_fulfilments` — its
own state beside the consultation — and the "how much is still outstanding"
arithmetic is DERIVED from `dispense_lines`, so there is no progress column on
the clinical row for anybody to write to.

### What is open

An endorsed repeat still refuses, because the CLINICAL record has nowhere to
record the endorsement (#8). `licenceTypes` is still empty (#9).
`priorQuantityInPeriodBase` is still not supplied (#10). Supplying a substitute
is API-only (#11). The dashboard's "today" is a UTC day (#12). And nothing has
been clicked in a browser.

---

## 2026-08-13 — PI-5 reviews, and the four CRITICALs they found

**Phase:** PI-5 · **Result:** every finding fixed · **Tests:** +16 unit, +2
integration, one of them watched failing three times before it was kept

Both reviewer passes run on the PI-5 diff. **The tenancy layer came back clean** —
no CRITICAL, no HIGH from `security-reviewer`, and the exemption argument for the
five policy-less platform tables survived a direct attack: it enumerated the
`@rcln/db/unsafe` call sites and confirmed there is no live path today by which a
tenant request reaches them. `code-reviewer` found four CRITICALs, and the first
three are one mistake wearing four hats.

### ⚠️ A MISSPELLED PARAMETER KEY MADE A PRESCRIPTION-ONLY MEDICINE GENERAL-SALE

`readBoolean` cannot tell ABSENT from MISSPELLED — nothing can — and
`evaluatePrescriptionRequired` read an absent `required` as "no prescription is
required here". So:

    parameters: { require: true, validityDays: 180 }   ->  PERMITTED
    parameters: {}                                     ->  PERMITTED

A prescription-only dispense, no prescription presented, outcome PERMITTED. The
same shape was live in `CONTROLLED_SCHEDULE` (`{}` permitted with no register
entry and no witness), `TRACEABILITY_REQUIREMENT` (a typo'd key permitted with no
identifiers captured) and `IMPORT_RESTRICTION`.

⚠️ **AND THE SUPERSESSION RULE AMPLIFIED IT INTO SOMETHING WORSE.** A regional
rule beats the national rule of its type — so a REGIONAL rule with the typo did
not merely permit itself, it filtered the national rule that would have REFUSED
out of the candidate set on its way past. One typo, in one state, switching off
the country's rule.

Fixed by making every rule type's essential key REQUIRED at parse time: a
document that says nothing checkable is `UNDETERMINED`, which refuses. Sixteen
cases now cover it, and three of them were watched going red with the guard
removed. **The gap that let it ship: every "nothing is configured" test in the
phase tested an absent RULE, and none tested a rule that EXISTS with an empty
document.**

`parseImportRestriction` also read `permitted === false` where its sibling read
`permitted !== true`, so one parameter meant two things across two handlers.

### The other CRITICAL: PI-4's lesson, repeated verbatim

`createRule` read the pack it decides against in one autocommit statement and
inserted into a DIFFERENT table in another. A sign-off committing in between
produced a rule inside a pack a named human had signed — exactly what that
function's own comment claims is refused, and nothing downstream catches it: the
CHECK constrains the PACK row, and `regulatory_rules` has no constraint that can
see a pack's maturity. `updateRule` had the identical shape, and `updateRulePack`
the mirror image — a sign-off landing between its read and its write let an
ordinary PATCH strip `REGULATORY_REVIEWED` while leaving the reviewer's name in
place. All three now take `SELECT … FOR UPDATE` on the pack inside a transaction.

⚠️ **THE CONCURRENCY TEST TOOK THREE ATTEMPTS, AND THE FIRST TWO WOULD HAVE
SHIPPED GREEN.** Two real calls racing under `Promise.allSettled` passed with the
lock removed — the interleaving needs the read before the commit and the write
after, and transactions started microseconds apart mostly decline. Holding the
row and asserting `approveRulePack` blocks passed with the lock removed too,
because that function's own UPDATE takes a row lock anyway; it was measuring
Postgres, not the code. Only `createRule` discriminates, because its write
targets a different table. It was watched failing before it was kept.

### The security review's MEDIUM: a signed-off pack was not actually frozen

`assertPackIsOpen` guarded the two rule writers and was never called from
`updateRulePack`, whose maturity guards fire only when a request carries a
`maturity` key. So `{ "effectiveTo": "2020-01-01" }` on a `PRODUCTION_ENABLED`
pack sailed past both — and `loadRules` filters on exactly that window, so every
rule in a reviewed pack left force platform-wide, immediately, with the
reviewer's name still on screen. Moving `effectiveFrom` instead changes WHICH law
applies under an unchanged sign-off. A reviewed pack now takes no edit at all.

### Smaller, and each one a claim that was not true

- **`isDecimal` accepted values `compareDecimals` could not compare.** Nineteen
  decimal places validated, stored, and then failed at every evaluation with "the
  quantities supplied are not decimal values" — blaming the caller for a fault in
  the rule, while the rule sat inert and apparently configured. Capped at 18, with
  negatives and the boundary now tested.
- **Two comments described protections that did not exist.** `regulatory.prisma`
  claimed the app role has SELECT only on the five platform tables (it has full
  write; the TRIGGER is the protection), and `updateRulePack` claimed the contract
  made the human-only maturities unsayable (it does not).
- **`types.ts` documented `roleCodes` as role codes** while the caller feeds
  permission codes — a pack written to the documentation would have matched nobody
  forever. Documented properly, with the rename left as PI-6's call before any
  pack exists.
- **`REFILL_RULE` had no future-date guard**, so a prescription dated 2030
  permitted a repeat. Its sibling has had that guard since the first draft.
- **The jurisdiction came from `ctx.branchIds[0]`** — arbitrary for anyone working
  at branches in two states. The request now names a branch, the route supplies
  the acting one, and a caller with several and no branch named is refused rather
  than guessed at.
- **`quantityBase` defaulted to `'0'`**, which passes every quantity limit ever
  written. Required now.
- **Three web dates were rendered by slicing a UTC instant.** The one with teeth
  seeded a new profile's `effectiveFrom`, so a clinic in IST creating one before
  05:30 dated it yesterday. `todayIn` already existed. ⚠️ The tax tab beside it had
  the same line and the same bug, one phase older, and is fixed too.

### One test-infrastructure fix worth recording

The regulatory suite's fixtures are PLATFORM rows keyed on `(country_code,
region_code)`, so unlike a tenant-scoped fixture they cannot be made unique per
run — and an interrupted run left `ZQ` behind and killed `beforeAll` on every
subsequent run, presenting as eighteen unrelated failures. It now cleans up
before it seeds as well as after.

### Verification

59 in `@rcln/regulatory` (was 43) · 18 integration (was 16) · 307 isolation · 176
unit · 781 integration across 34 files. Lint green across 27 projects, typecheck
green per package, `db:rls:check` green at 89.

---

## 2026-08-13 — PI-5 Global Regulatory Framework

**Phase:** PI-5 · **Result:** complete, all suites green · **Branch:**
`feat/pi-5-regulatory-framework`

Six tables, a new pure package, five permission codes and five screens. The
framework ships fully; **no country's rules are in it, deliberately** — that is
PI-6 onwards, and each rule will cite a source somebody has read.

**⚠️ Nothing in this repository claims legal compliance for any jurisdiction.**

### What landed

`regulatory.prisma` — `jurisdictions`, `regulatory_authorities`,
`regulatory_sources`, `regulatory_rule_packs`, `regulatory_rules` (platform) and
`product_regulatory_profiles` (tenant, platform-extensible). `@rcln/regulatory`
holds `evaluate()`: no Prisma, no clock, 43 unit tests, modelled directly on
`@rcln/tax`. `db:rls:check` green at 89.

### The decision that took the most argument: how to protect a table with no policy

The five platform tables cannot carry `tenant_isolation` — every tenant reads
them inside its own transaction, so a policy returns zero rows for everyone and
every decision comes back `UNDETERMINED`, which refuses. That is the same
argument `tax_rule_defaults` carries, and today that table is protected by nothing
but the absence of a service that writes it from a tenant path.

⚠️ **The obvious fix — grant `rcln_app` SELECT only — does not work, because
`@rcln/db/unsafe` is NOT an owner connection.** It is the same `rcln_app` role
with no session variables set, so revoking write would lock the platform console
out of its own console. What distinguishes a clinic's request from the console is
that the clinic's transaction CLAIMS A TENANT, so
`platform_law_not_tenant_writable` refuses any write when `app_current_org()` is
not null — the same discriminator `refuse_platform_row_mutation` already uses,
for the same reason. Four isolation cases pin it, including the DELETE, which no
policy would have caught anyway: Postgres applies no WITH CHECK to DELETE.

### `UNDETERMINED` refuses, and that is why nothing is wired up yet

Every caller treats `UNDETERMINED` as _refuse and say so_ — no applicable rule, an
unreadable parameters document, or a fact the rule needed that nobody supplied.
With no pack configured anywhere, **every** evaluation is `UNDETERMINED` today, so
calling the engine from the goods-receipt or transfer path would stop every clinic
on the platform from receiving stock. PI-5 therefore ships the engine and
`POST /v1/regulatory/evaluate` and enforces nothing; PI-6 wires the call sites as
it reaches `RULES_IMPLEMENTED`.

The direction of that failure is the whole design. A malformed rule —
`{"required": "yes"}` — parses to `NaN` under any cast, and `NaN > limit` is
`false`, so a permissive engine would let a broken rule PERMIT. Every parameter is
validated before it is acted on and a document nobody can read is `UNDETERMINED`.

### OD-5 resolved, by the user

`REGULATORY_REVIEWED` and `PRODUCTION_ENABLED` are reachable only through
`PATCH /v1/platform/regulatory/rule-packs/:id/approve`, gated on a new
`regulatory.pack.approve` — **a code no system role holds**, excluded from
`ORG_OWNER` and `ORG_ADMIN` BY NAME because those are "everything except" roles
and would otherwise acquire it silently. The service refuses a pack that has not
reached `REGULATORY_REVIEW_PENDING`, refuses to demote a reviewed one, and refuses
to add a rule to a pack somebody has signed off — a sign-off is a statement about
the rules that existed when it was made. `regulatory_rule_packs_review_recorded`
refuses either state ARRIVING without a reviewer's name and the instant it was
recorded, which is the layer a later migration or a psql session cannot forget.

### Two refinements to the architecture documents, recorded rather than smuggled

1. **`REGULATORY_REVIEWED` is an eighth maturity.** PI-ADR-009's chain does not
   draw it and that ADR's own prohibition names it. Reviewing the content and
   deciding the platform may act on it are two decisions, and one button for both
   is the button somebody presses twice by accident.
2. **A rule may only name a PLATFORM product category.** `regulatory_rules` has no
   policy to AND a `*_visible` one with, so the hole is closed upstream by
   `regulatory_rule_category_is_platform` rather than filtered at read time.

### The one thing deferred with its reason written down

`regulatory_decisions` — the per-transaction snapshot PI-ADR-008 requires — is NOT
built. Nothing can write one: PI-7 and PI-9 are blocked on `prescriptions` and
`encounters`. The decision object already carries `packVersionIds`, the reasons,
the conditions and the lowest contributing maturity, so the table lands with its
first writer rather than as a polymorphic guess about a subject that does not
exist.

### Tests

43 in `@rcln/regulatory` · 16 integration · 13 isolation. Unit 176, isolation 307
across 15 files, every integration slice green, lint and typecheck green across 27
projects, `db:rls:check` 89.

⚠️ **`pnpm typecheck` now OOMs the api container too**, not just `pnpm test`. Run
both per package or by path.

---

## 2026-08-13 — PI-4 reviews, and the three bugs they found

**Phase:** PI-4 · **Result:** all findings fixed · **Tests:** +1 concurrency case,
+1 migration

Both reviewer passes run on the PI-4 diff. **The tenancy layer came back clean** —
`security-reviewer` found no CRITICAL and no HIGH, enumerated every FK the migration
adds and confirmed all twelve `*_visible` policies are present and RESTRICTIVE, and
verified the `appointment_status_history` trap is genuinely avoided on all four child
tables. It also made a point the phase had not articulated: the org-wide supplier
seam is safe **because** `product_cost_averages` is branch-scoped, so the shared
price book exposes what a supplier QUOTES and never what another branch PAID.

`code-reviewer` found three CRITICALs, all real, and two of them were the same
missing lock.

⚠️ **THE PHASE CLAIMED TO HAVE CLOSED PI-3'S READ-THEN-WRITE RACE AND HAD CLOSED
ONLY HALF OF IT.** `postGoodsReceipt` locks its own `goods_receipts` header — and two
receipts against one purchase order are two DIFFERENT header rows, so nothing
serialised them. The over-receipt tolerance read the PO line unlocked:

    PO for 100, tolerance 0%. Two drafts of 100, posted concurrently.
    Both read received = 0. Both pass assertWithinTolerance. Both increment.
    200 units of real stock against a 100-unit order.

And `purchase_order_lines_quantities_valid` deliberately has NO upper bound, because
the tolerance is a SETTING a CHECK cannot read — so the database did not catch it
either. The same missing lock let a fully-received order regress: receipt B, holding
a stale read, overwrote `RECEIVED` with `PARTIALLY_RECEIVED`, leaving the order on
the "what are we waiting for" screen for ever with nothing outstanding.

Fixed with one `lockPurchaseOrder` before anything reads the order's lines. ⚠️ **The
header and not the lines**, so the acquisition order cannot vary with the order the
lines happen to be in; a receipt cites exactly one order and the sequence is always
receipt-then-order, so no cycle is reachable.

⚠️ **AND THE REGRESSION TEST WAS VERIFIED TO HAVE TEETH BY REMOVING THE LOCK AND
WATCHING IT FAIL.** `serialises two receipts racing against one order line` reports
two fulfilled posts and 200 received without it. The pre-existing
`counts what earlier deliveries already took` passes perfectly well against the
broken version — it only ever exercised the sequential path, which is exactly why the
hole survived the first round of testing.

### The line-order bug, and why the first fix was not one

⚠️ **`created_at` CANNOT ORDER THE LINES OF A DOCUMENT, AND `{ id: 'asc' }` IS NOT A
TIE-BREAK THAT HELPS.** Lines are written by one `createMany`, and
`CURRENT_TIMESTAMP` in Postgres is the TRANSACTION timestamp — so every line gets a
byte-identical `created_at` and the only remaining discriminator is a random uuid v4.

The first attempt at this fix added `{ id: 'asc' }` and the suite went green, which
was a coin flip landing: it makes the order STABLE within a read and still ARBITRARY
relative to what somebody typed. Measured afterwards, the landed-cost apportionment
case failed **two runs in six**. A purchase order printed for a supplier, and a draft
delivery reopened for editing, both listed their lines in a different order each
time.

No money was ever misallocated — `apportionLanded` and `lineData` index consistently
over one array — but the document was unstable. Properly fixed with an explicit
`line_number SmallInt`, unique per document, in
`20260817092000_document_line_numbers`, following `invoice_items.line_number`, which
is the pattern that already existed and should have been matched from the start.

⚠️ **A THIRD MIGRATION RATHER THAN AN EDIT TO THE FIRST**, because
`20260817090000_procurement` had already been applied and Prisma checksums an applied
migration including its comments. Additive is the only safe direction once a
migration has run anywhere.

⚠️ **AND ITS INDEX NAMES ARE PRISMA'S, NOT HAND-CHOSEN.** The first version used
readable names and `migrate diff` reported four permanent `ALTER INDEX` renames as
drift — the same trap `20260814090000_align_fee_schedule_index_name` exists for. The
names were corrected at source and the local checksum repaired, since the migration
had not left the machine.

### Also fixed

- **The rejection half had no CHECK.** `purchase_requisitions_approver_is_not_creator`
  guarded approval; rejection was guarded only by the service, even though its own
  comment argues that self-rejection would put "reviewed and refused" on a document
  nobody reviewed. `purchase_requisitions_rejecter_is_not_creator` added, so the layer
  a later phase cannot forget now covers both halves.
- **`pnpm test:rls` did not work as documented.** The isolation suite's own README
  gives `docker compose exec api pnpm test:rls`, and the script existed only in the
  api workspace — so the documented command failed with
  `ERR_PNPM_RECURSIVE_EXEC_FIRST_FAIL`. Pre-existing since PI-3 split the suite. Now
  proxied from the root. A gate nobody can invoke as documented is a gate that stops
  being run.

### Corrected, not fixed

⚠️ **"THE APPROVAL SPLIT IS ENFORCED THREE TIMES" GUARDS THE INTERNAL ASK ONLY, AND
THE PREVIOUS CHANGELOG ENTRY AND ROUTE HEADER BOTH OVER-STATED IT.**
`pharmacy.purchase_order.manage` predates the split, so its holder — including
`PHARMACIST` — can raise and issue a purchase order with no requisition and nobody's
second signature, then receive against it, with no second user id anywhere on the
trail. Not widened by PI-4 and deliberately not narrowed, because revoking a code
every existing clinic holds is the one thing a permission change must not do
silently. The wording is corrected in the route header and the gap is now its own
KNOWN_ISSUES row rather than a parenthetical.

### Rejected

One finding was raised by the session and correctly overruled by the reviewer:
`product_cost_averages` has no `@@unique([organizationId, id])`, which looked like a
convention deviation. It matches `StockBalance`, which has none either — both are
leaf tables nothing composite-FKs to, and adding one would have bought a migration
for nothing.

---

## 2026-08-13 — PI-4: procurement, end to end

**Phase:** PI-4 · **Result:** complete · **Tests:** +37 integration, +21 unit,
+15 isolation · **RLS:** 76 → **88** tables

How stock ENTERS the system. Twelve tables, seven screens, two migrations, and the
whole chain from a branch asking for something to the cost of it landing on a shelf:
supplier → price book → requisition → approval → purchase order → delivery →
inspection → return, with a moving average behind all of it.

### The four calls worth knowing

**A supplier is the ORGANIZATION's vendor, not a branch's.** The three supplier
tables are org-wide; all nine document tables are branch-scoped absolutely. A group
negotiates one contract, one price book, one set of tax numbers — branch-scoping
them would mean three rows and no way to answer "what do we spend with them".

⚠️ **The cost is that a branch-scoped storekeeper reads the whole price book, and a
test pins it** — `shows the whole organization's price book to a single-branch
reader`. That width is intended and it looks exactly like a leak in review, so a
later phase "fixing" it would break ordering at every multi-branch clinic. Nothing
branch-confidential may ever be added to those three tables.

**`PURCHASE_RETURN` is a new movement type, and PI-2's schema said it would not be.**
That comment said a purchase return would be a `TRANSFER_OUT` to the supplier. It
cannot be: `TRANSFER_OUT` means "went to another branch of ours" to every report
that reads the column, and the outstanding-quantity arithmetic over
`stock_transfers` reads exactly those rows — a purchase return written as one shows
up as stock in transit between two of the clinic's own sites, on a van that does not
exist. Distinguishable only by `reference_type`, which no aggregate groups by.

It is a REMOVE with **no default `statusFrom`**, the second member after `DISPOSAL`
that refuses to guess. What is going back — sound stock ordered in error, stock
refused at inspection, stock damaged in the box — IS the content of the record.

⚠️ **AND IT COST A SECOND MIGRATION FOR A REASON NOTHING WARNS ABOUT.** Postgres
refuses to USE a new enum value in the transaction that ADDED it, and Prisma runs
each migration inside one — so `ALTER TYPE … ADD VALUE 'PURCHASE_RETURN'` and the
`stock_ledger_direction` CHECK that names it cannot ship together. The SQL parses,
the schema file is consistent, and `prisma validate` is perfectly happy; it only
fails against a database. Split into
`20260817091000_purchase_return_movement_direction`, which is fail-closed in
between: a `PURCHASE_RETURN` row matches none of the old CHECK's shapes and is
refused.

**The approval split is enforced three times and only one layer cannot be forgotten.**
Two permission codes, a service check against `created_by_id`, and
`purchase_requisitions_approver_is_not_creator`. ⚠️ **It guards the internal ASK and
not the money** — see the review entry above; `pharmacy.purchase_order.manage`
predates it and needs no second signature. The first two are each one edit
from absent. A clinic may grant both codes to one person — a single-doctor clinic
has nobody else, and refusing would be a platform deciding how a business is
staffed — and they still cannot self-approve ONE document, because the CHECK
compares two user ids rather than two permissions.

⚠️ Rejection is gated by the same check as approval, which looks like over-reach and
is not: rejecting your own requisition is indistinguishable in effect from
withdrawing it, and allowing it would put "reviewed and refused" on a document
nobody reviewed — the audit trail lying in the direction that looks diligent.

**Costing is a pure module in `@rcln/inventory`, for the reason FEFO ordering is.**
A receipt that posts, writes its legs and lands stock on the right shelf at a unit
cost one paisa out looks entirely correct from every angle a route test can see, and
surfaces a year later as a valuation that does not reconcile.

⚠️ **The running TOTAL is stored and the average is DERIVED.** Storing the average
would round at every receipt and compound;
`does not drift over twenty awkwardly-priced receipts` is the case that pins it.

⚠️ `apportion()` in `@rcln/invoicing` was found by `pnpm kb:find` and deliberately
NOT reused. It refuses `total > totalWeight` because a discount larger than the bill
is a credit note — and freight larger than the goods is an ordinary receipt, a
single vial couriered overnight. It also throws on the integer overflow that a
wholesale-sized delivery reaches, where `apportionByValue` works in `bigint`.

### What the tests caught

**One real bug, and it was in the read path.** `createMany` gives every line the
same `created_at`, so `orderBy: { createdAt: 'asc' }` returned a document's lines in
a NONDETERMINISTIC order on each read — found by the landed-cost apportionment case,
which asserted the shares in line order. All four document services now tie-break on
`id`.

⚠️ **`stock_transfer_lines` in PI-3 has the same `orderBy` and the same latent
issue.** Not changed here, because it is outside this phase's diff and its own
suites do not assert line order. Recorded in KNOWN_ISSUES.

**And two process traps, both already documented and both hit anyway.** Prisma dated
the generated migration BEHIND the highest existing directory (they are hand-dated
ahead of the wall clock), and `pnpm test` now OOMs the api container outright rather
than only `pnpm validate` — the suite was run in five slices instead. Known issue 6
from PI-3, now worse.

⚠️ **The dev database also had a checksum mismatch on an applied migration**
(`20260815092000_inventory_expiry_sweep_function`), unrelated to this phase. Repaired
by re-running that migration — it is `CREATE OR REPLACE` throughout — and correcting
the recorded checksum, rather than `prisma migrate reset`, which would have dropped
the developer's data.

### Not done

**Nothing has been clicked in a browser.** The same open item PI-1, PI-2 and PI-3
each left. Both reviewer passes are also still to run on this diff — PI-3's three
CRITICALs were all read-then-write races, and every service here takes the header's
row lock first for exactly that reason, but that is a claim a reviewer should test
rather than one to take on trust.

---

## 2026-08-12 — PI-3 reviews, and the three bugs they found

**Phase:** PI-3 · **Result:** all findings fixed · **Tests:** +4 regression cases

Both reviewer passes run on the PI-3 diff. **The tenancy layer came back clean** —
the security reviewer tried to break the two-ended transfer policy and could not,
and confirmed the in-transit claim holds: dispatch writes only at
`from_branch_id`, receipt only at `to_branch_id`, cancel only at
`from_branch_id`, and no tenant context is widened anywhere. Every finding was in
the transfer and reservation SERVICES.

⚠️ **Both reviewers independently found the same top bug**, which is the strongest
signal either produced.

### 1. A duplicate `lineId` on receipt minted stock · CRITICAL

`receiveTransfer` built its line map ONCE and read `receivedQuantityBase` off
that object every iteration, and the row write was an absolute assignment rather
than an increment. Two entries naming one line both measured against the same
untouched value, both passed the over-receipt check, both wrote a `TRANSFER_IN`
leg, and the row recorded only the last. **Ten units sent became twenty
received**, the document read fully received with nothing outstanding, and
`stock_transfer_lines_quantities_sane` was satisfied throughout because the ROW
never held more than was sent.

⚠️ **Nothing else would have caught it.** `verifyBalances()` agrees with the
inflated figure — both legs are genuine ledger rows. The web form cannot produce
it, because `receive.<lineId>` FormData keys collapse; the API is the boundary.

Fixed in both layers: a uniqueness `.refine()` on the contract, and per-line
accumulation in the service so the loop no longer depends on a well-formed
request to be correct.

### 2. Every transfer state transition was a read-then-write race · CRITICAL

`withTenant` opens a plain READ COMMITTED transaction and the service read the
status with a plain `findUnique`. Two concurrent dispatches both see `DRAFT` and
both write a full set of legs. The nastiest pair is **cancel against receive**,
because they write at DIFFERENT branches — the compensating leg at the sender and
the real one at the receiver touch different buckets, so the engine's advisory
bucket locks never bring them into contact. Ten dispatched, twenty landed.

Fixed with `lockTransferOrThrow` — `SELECT … FOR UPDATE` on the header before any
leg is written. ⚠️ `FOR UPDATE` is legitimate here and refused on
`stock_balances`, and the difference is the grant: Postgres needs the UPDATE
privilege to take a row lock, `rcln_app` has it on `stock_transfers` and not on
the balance cache.

### 3. The manual release raced the sweep into a double release · CRITICAL

`releaseReservationIn` wrote the movement first and updated unconditionally —
while `reservation-sweep.ts`, one package over, claims with `updateMany({ where:
{ id, status: 'ACTIVE' } })` and **documents in a comment exactly why the other
order is wrong**. The docstring claiming the two were shared was false: the sweep
has its own copy, correct, and this was the copy that was not.

A pharmacist pressing Release as the hourly sweep reached the same reservation
got two `RELEASE` movements for one hold, draining the `RESERVED` bucket on
behalf of some other active reservation. Fixed by claiming first; the dead
`EXPIRED` parameter is gone with it.

### Also fixed

- **A serial fitted to a patient between draft and dispatch was still
  transferable.** `assignSerial` writes no ledger movement and
  `recordMovementIn`'s serial read selects neither the patient link nor the
  status, so a PHI-bearing row could be moved into the receiving branch's RLS
  scope. Re-checked at dispatch and at receipt now; the refusal names the device
  and never the patient.
- **`toLineDetail` read the batch JOIN rather than the line's own snapshot** —
  the same bug the header already had, one level down, so the receiver saw "no
  lot number, no expiry" on the delivery note they were checking against a pack.
- `updateTransfer` set `toLocationId` with no branch check, deferring the
  refusal to dispatch as an unreadable FK error.
- Receipt now sorts lines into a canonical lock order; the client's order could
  deadlock two overlapping receipts.
- `assertReasonCode`'s `findFirst` had no ordering, so a tenant code shadowing a
  later platform code resolved nondeterministically.
- Two `as string` assertions and one float comparison on a counted quantity.

### What the reviewers confirmed clean

RLS coverage on all four tables including the third-branch case for header and
lines; the platform-extensible policy and its immutability trigger; all four
`*_visible` policies; the new SECURITY DEFINER function's grant (it does **not**
repeat PI-2's `REVOKE … FROM PUBLIC` CRITICAL); no PHI in any log, error or job
payload; no raw Prisma, no `$queryRaw` interpolation, no 403-instead-of-404, no
mass assignment; exact decimal arithmetic throughout the allocation path; no
fetch waterfalls in the new screens.

---

## 2026-08-12 — PI-3: Movements

**Phase:** PI-3 COMPLETE · **Result:** shipped on `feat/pi-3-movements` ·
**Tests:** 1155 API across 41 suites passing, 0 failing

### Changed

| Area        | What                                                                                                                                   |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| Schema      | `stock_reason_codes`, `stock_transfers`, `stock_transfer_lines`, `stock_reservations`; `products.allocation_strategy`                  |
| Migrations  | 4: movements · reservation sweep function · location snapshot · lot snapshot                                                           |
| RLS         | 76 tables green. One platform-extensible table, one bespoke two-ended policy, one hand-restated child predicate                        |
| Package     | `@rcln/inventory` + `allocate.ts`, `reservation-sweep.ts`; `toBaseUnits` exported for transfer lines                                   |
| Permissions | `inventory.stock.reserve`, `inventory.reason_code.manage`                                                                              |
| Worker      | Reservation sweep at `:30`; `movementDeps` extracted so two processors share one binding                                               |
| Web         | `/stock/transfers`, `/stock/reservations`, `/stock/adjustments/new`; `TransferProgress` extends the bucket bar rather than rivaling it |

### Decisions

**In-transit stock is held by the DOCUMENT.** A refinement of
INVENTORY_ARCHITECTURE.md's sender-owned `IN_TRANSIT` bucket, forced by
`branch_isolation`: an in-transit bucket at the sender makes the RECEIVER write
against a branch they cannot see, which needs either a widened tenant context or
a second ledger writer. Both legs are single-branch writes instead. The cost —
in-transit quantity is not in `stock_balances` — is recorded for PI-22 and
pinned by a test.

**Reason codes are platform-extensible**, the only table in the inventory domain
that is. A reason code is a WORD, not a fact about a clinic; thirteen ship in the
migration so a clinic can record its first adjustment without inventing a
vocabulary. The ledger still stores the code as a STRING — a row must outlive
what explained it.

**The master governs the manual surface only.** The sweep writes `EXPIRED` and
`setBatchHold` writes `QUARANTINE`; neither goes through `recordMovement`, and
neither belongs in the picker.

### Issues found

Two, both found by tests and both invisible from reading — the query is correct,
the policy is correct, and they are correct about different things:

1. The receiving branch could not read its own delivery note (`inventory_locations`
   is branch-scoped, so the join returned NULL rather than an error). Fixed by
   snapshotting the shelf names onto the transfer.
2. The receiving branch could not create its own lot row, so receipt raised
   `Batch not found` at the moment somebody signed for a delivery. Fixed by
   snapshotting the lot's identity onto the line.

Neither was fixed by weakening a policy. A third, smaller: `planAllocation`
emitted two decimal scales in one plan — invisible on screen because
`readableQuantity` trims both — found by a unit test asserting on one.

### Next

**PI-4 — Procurement.** See [NEXT_SESSION.md](NEXT_SESSION.md).

---

## 2026-08-12 — PI-2 reviews, and the two CRITICALs they found

**Phase:** PI-2 · **Result:** both reviews run and acted on · **Branch:**
`feat/pi-2-inventory-foundation`

`security-reviewer` and `code-reviewer` both ran over the finished diff. Two
CRITICALs, one HIGH, eleven WARNINGs and a page of INFO. Everything except two
accepted items is fixed. `pnpm validate` green at **1087 API tests across 39
suites**; `db:rls:check` green at 72 tables.

### CRITICAL 1 — the REVOKE that revoked nothing

`REVOKE ALL ON FUNCTION stock_balances_apply_delta(...) FROM PUBLIC` **does not
remove the grant `rcln_app` actually holds.** `infra/postgres/init/01-roles-and-
extensions.sql` carries

```sql
ALTER DEFAULT PRIVILEGES FOR ROLE rcln_owner IN SCHEMA public
  GRANT EXECUTE ON FUNCTIONS TO rcln_app;
```

so every function a migration creates is granted to the application role at
creation, as a role-specific grant. Revoking from PUBLIC removes a different one.
Measured: `has_function_privilege('rcln_app', …) = true`, and calling it as
`rcln_app` with no tenant context reached the INSERT and failed only on a foreign
key.

That function is SECURITY DEFINER, bypasses RLS on `stock_balances`, and takes
the organization, branch, location, status and delta **as arguments**. So the
request-path role held an arbitrary cross-tenant write into the balance cache —
the one number the append-only ledger exists to make unforgeable — and the
`REVOKE INSERT, UPDATE, DELETE ON stock_balances` was nullified by the very
function it was written to make safe.

Fixed in `20260815093000_inventory_security_review_fixes`, which names
`rcln_app` explicitly for both balance functions. The isolation suite now asserts
`has_function_privilege` is false for each — the table grants were tested and the
function grants were not, which is exactly how this hid.

### CRITICAL 2 — `readable('100')` returned `'1'`

```ts
quantity.replace(/\.?0+$/, ''); // the point is OPTIONAL
```

On an integer the `0+$` ate the trailing zeros of the number itself: `100` → `1`,
`500` → `5`, `-30` → `-3`. Every quantity on every stock screen, an order of
magnitude small, on a screen a pharmacist reconciles against a shelf. A bare
integer is a legitimate wire value — Prisma's `Decimal.toString()` drops the
fractional zeros before the string leaves the server — so it was not theoretical.

It broke no test because `apps/web` **has no test suite**. So the function moved
to `@rcln/contracts` as `readableQuantity`, beside the `decimalString` it is the
display inverse of, where `apps/api`'s unit suite covers it. Six cases.

### The structural fix: branch-composite foreign keys

Every inventory child referenced its parent through `(organization_id,
<parent>_id)`, which proves the lot or shelf belongs to this TENANT and says
nothing about which BRANCH holds it — so a movement at branch A citing a shelf at
branch B was a legal INSERT, refused only by a check in `recordMovementIn`.

`20260815094000_inventory_branch_composite_keys` adds
`@@unique([organizationId, branchId, id])` to locations, batches and serials and
composes ten foreign keys on all three columns. It also makes `verifyBalances()`
airtight: the replay groups without `branch_id`, which was only correct because a
location implied one branch — true of the data, and now true of the schema.

### The expiry sweep had two defects, both silent

- **It never selected `serial_id`,** so a `SERIAL` product's expired stock hit
  "must name a serial number" — and one expired serialised device meant **nothing
  at that branch ever expired**, hourly, for ever, with only a log line.
- **It moved every bucket in ONE transaction.** An advisory lock is held to
  COMMIT, so locks accumulated in expiry order — which is not lock order — and
  could deadlock against a concurrent status transition, rolling back the whole
  branch.

Both fixed by restructuring: `findExpiredBuckets` + `expireBucket`, with the
caller opening **one transaction per bucket** and counting failures instead of
aborting. Partial completion was always safe; splitting the transaction is what
makes it useful.

### The rest

- `stock_ledger.actor_user_id` was the eighth plain FK and had no policy — a
  tenant could name any user uuid and read `users.full_name` back through the
  join `listLedger` performs. New RESTRICTIVE `actor_is_member` policy: a
  MEMBERSHIP test, not an identity test, so a countersigned entry and the sweep's
  owner-attributed movements still work.
- `updateSerial` returned `assignedPatientId` and wrote no `data_access_logs`
  row, and re-pointed `batchId`/`currentLocationId` with none of `createSerial`'s
  checks. Both fixed; the checks are now one shared helper.
- `listBalances` and `listLedger` sorted on non-unique keys, so pagination could
  skip and repeat rows. `id` appended to both.
- Deactivating a location was a read-then-write with nothing serialising it —
  a concurrent movement could commit between the balance check and the update and
  strand stock under an invisible location. `FOR UPDATE` on the location row.
- `majorToMinor` returned null for a typo, so a mistyped cost saved as "no cost
  recorded" with no field error. Returns `NaN` now, so Zod reports the field.
- `recordMovementResponse.quantityBase` was `decimalString`, which refuses the
  sign it always carries.
- Duplication: `toDateColumn` had four copies and `emptyToNull` two. Canonical
  ones in `product/values.ts` and `lib/api.ts`. The three older `toDateColumn`
  copies are in Phase 3 code and are left for a follow-up.

### Two accepted, with reasons

- **`inventory_branches_with_expired_stock` is granted to `rcln_app`** (HIGH).
  The worker connects as that role, so the grant is required; the function is
  read-only and takes no argument that widens it. It is the second of this shape
  — `billing_due_subscriptions` is the first — and the real fix is a worker-only
  database role, which is infrastructure work for PI-24.
- **`listLocations` is unpaginated** (WARNING). Locations are the physical places
  a clinic keeps things, every consumer needs the whole set, and the screen groups
  by branch. Recorded in the service with the threshold at which it stops being
  true.

---

## 2026-08-12 — PI-2, Inventory Foundation

**Phase:** PI-2 · **Result:** complete except both reviews · **Branch:**
`feat/pi-2-inventory-foundation`

Seven tables, the append-only ledger, the trigger-maintained balance cache, the
expiry sweep, and four screens. `db:rls:check` green at 72 protected tables;
`pnpm validate` green at 1078 API tests across 39 suites.

### The ledger writer had to leave `apps/api`

PI-ADR-004 says `recordMovement()` is the only thing that inserts into
`stock_ledger`. The expiry sweep is a **worker** processor, and the worker cannot
import from the API — so a sweep written there would have had to write its own
INSERT, and "only one writer" would have stopped being true in the phase that
declared it.

`@rcln/inventory` now holds the engine and the conversion algebra, with
`recordAudit` and `loadUnitGraph` injected. Same shape as `@rcln/billing`.
`apps/api/src/services/product/units.ts` is a one-line re-export, so no existing
import changed; it throws `InventoryError` now, mapped by the error middleware
onto exactly the 400 / 404 / 409 the old classes produced.

### Two things were measured rather than reasoned about

**`ON CONFLICT DO UPDATE` cannot maintain a balance under a `>= 0` CHECK.**
Postgres evaluates a table's CHECK constraints against the **proposed** row
before the unique index is consulted for a conflict, so
`INSERT ... VALUES (-30) ON CONFLICT DO UPDATE SET quantity = quantity + excluded`
is rejected before the arbiter can redirect it into the row holding 100. Every
decrement failed. Rewritten as UPDATE-then-INSERT with a unique-violation retry.

**`SELECT ... FOR UPDATE` needs the UPDATE privilege, which the whole design
revokes.** `rcln_app` holds no INSERT, UPDATE or DELETE on `stock_balances` —
that is rule 2 made literal — and Postgres requires UPDATE to take a row lock,
so the sufficiency check raised 42501 on every movement. Replaced with
`pg_advisory_xact_lock`, which needs no privilege, releases on COMMIT, and is
taken for both buckets in sorted key order in one statement so two opposite
transitions cannot deadlock.

### One deliberate deviation from the architecture doc

`EXPIRY`, `DAMAGE` and `RECALL` are **MOVES between status buckets, not `−`
removals**. Expired stock has not left the building: it is on the shelf,
undispensable, waiting to be destroyed, and it has to be counted and valued until
it is — which INVENTORY_ARCHITECTURE.md's own status model says two sections
after its sign table. `DISPOSAL` is the `−` that records a physical departure.

### The enforcement, in the database

- `stock_ledger`: no UPDATE or DELETE for `rcln_app`, plus an owner-exempt
  trigger — the same two layers `audit_logs` already has.
- `stock_balances`: **SELECT only**. The cache is maintained by a SECURITY
  DEFINER trigger and by nothing else.
- `stock_ledger_direction` pairs every movement type with its sign AND with which
  status buckets it may name. `_tracking_satisfied` is PI-ADR-014.
  `stock_balances_non_negative` is the last line against a negative shelf.
- Seven RESTRICTIVE `*_visible` policies. `batches.product_id` cannot be a
  composite FK — a clinic legitimately stocks a PLATFORM product — so the policy
  is the entire control on that side. Four isolation cases prove a clinic cannot
  create a batch, serial, movement or balance naming another clinic's product.

### Still open

Neither `code-reviewer` nor `security-reviewer` has run, and the security pass is
mandatory: the diff touches the schema, tenancy, RLS, PHI, permissions and raw
SQL. The screens read and do not write. Nothing has been clicked in a browser.

---

## 2026-08-11 — PI-1 code review, and the bugs it found

**Phase:** PI-1 · **Result:** both reviews complete · **Branch:**
`feat/pi-1-product-platform-core`

`code-reviewer` found two CRITICALs and six WARNINGs. All fixed, with a third
bug found by the regression tests written for the first one.

### The one mistake that produced both CRITICALs

```ts
{ ...(cond ? { OR: a } : {}), effectiveFrom, OR: b }   // ← `OR: a` is GONE
```

An object literal takes the **last** value for a repeated key, and a **spread
counts**. Neither TypeScript nor eslint objects. In both resolvers the predicate
that vanished was the jurisdiction filter — the one deciding correctness:

- `resolveTaxCategory` matched every region in the country.
- `resolveIdentifier` matched a barcode against every country's identifiers.
  National codes legitimately collide across countries; this is a live routed
  endpoint. Wrong-product-from-a-barcode is what it exists to prevent.

Both now use `AND: [...]` to carry two `OR` groups.

### The third bug, found by the test written for the first

`orderBy: [{ regionCode: 'desc' }, …]` with `take: 1`, under a comment asserting
"Postgres sorts NULLs last on DESC by default". **It sorts them first.** So the
country-wide row always won and a regional tax override could be configured, be
visible, and never be returned — precisely what that file's own header warns
about, three lines above the code doing it. Fixed with `nulls: 'last'`.

### The rest

- **`PUT /packagings {"levels": []}` destroyed the base packaging row.** The
  guard was `if (base && …)`, so no level 0 skipped the check rather than failing
  it. Refused twice now: `.min(1)` on the contract, unconditional check in the
  service.
- **`withdrawProduct` set `deletedAt`**, making withdrawn products 404 — the
  opposite of the "history keeps resolving" it promised. Status carries it alone;
  `listProducts` excludes `WITHDRAWN` by default so pickers are unaffected.
- **Unit conversions could contradict the graph transitively.** `BOX→TAB = 90`
  was accepted alongside `BOX→STRIP = 10` and `STRIP→TAB = 10`, and because the
  search is breadth-first the new one-hop edge **won** over the correct two-hop
  path. Writes now check the proposed edge against the existing graph.
- **An inclusive `effectiveTo` expired a day early**, in four places at once —
  `@db.Date` comes back at UTC midnight and was compared against an instant. The
  three copies of `toCalendarDate` and two of `decimalToString` are now one
  `values.ts`, which is why the fix was one edit instead of four.
- **`listCategories` inner-joined the depth CTE**, so a category whose parent is
  invisible under RLS vanished from the tenant's **own** list. `LEFT JOIN` now
  surfaces it at the root — this closes the LOW security finding recorded below.
- `buildUnitGraph` threw on a zero-ratio row, contradicting its own comment that
  one bad row must not break every conversion in the clinic.
- Two write paths opened a second transaction for their read-back; both now read
  inside the transaction they already had.

### Tests

`product-resolvers.test.ts` (14 cases) and `product-values.test.ts` (11) are new.
**PI-1 had no products integration test at all**, which is how three resolver
bugs shipped: the isolation suite tests the database, the unit suite tests pure
arithmetic, and nothing tested the query layer between them. Each new case plants
a decoy and asserts which row comes back — all three bugs returned a plausible
row rather than failing, so only a decoy distinguishes them.

**1016 tests across 37 suites**, `pnpm validate` 23/23, `db:rls:check` 65 tables.

---

## 2026-08-11 — PI-1 security review pass

**Phase:** PI-1 · **Result:** security review PASS, code review NOT RUN ·
**Branch:** `feat/pi-1-product-platform-core`

`security-reviewer` confirmed the tenancy story end to end and raised five
findings — nothing CRITICAL, nothing HIGH. `code-reviewer` terminated on a
session limit and produced nothing; that leg of PI-1.10 is still open.

### Fixed

- **`20260814100000_platform_rows_immutable`.** `tenant_isolation` never
  protected a platform row from `DELETE` — Postgres evaluates no WITH CHECK
  where there is no new row, so the permissive USING clause was the whole test —
  nor from `UPDATE ... SET organization_id = '<mine>'`, which satisfies USING on
  the old row and WITH CHECK on the new one and captures the row away from every
  other tenant. A `BEFORE UPDATE OR DELETE` trigger closes both on all
  **seventeen** platform-extensible tables, so `specialties`, `qualifications`,
  `designations` and `role_designations` are fixed alongside the thirteen
  product tables. Neither hole was reachable through the API — `assertMutable`
  guards every mutating path — so this restores a missing second layer.
- **Isolation cases for `medicine_details`, `composition_ingredients` and
  `product_tax_classifications`.** The first had no test at all; the other two
  appeared only in CHECK-constraint tests, which exercise the constraint and say
  nothing about the policy.
- **The slug comment in `products/actions.ts`.** It claimed server actions are
  "bound to the slug on the server before they reach the browser". They are not:
  `.bind(null, slug)` runs inside a CLIENT component, and a server action is a
  public POST either way. The real control is the API's cross-tenant 404 and RLS
  keyed on the token's org, not the slug. Corrected to describe that, with the
  consequence spelled out — `slug` selects a Host header, never an authorization
  decision.

### Accepted, not fixed

Two LOW findings, recorded in [NEXT_SESSION.md](NEXT_SESSION.md) § Known issues:
two service reads that lean on RLS with no app-level org predicate, and the
residual `parent_visible` gap, which is marginally worse than first assessed —
a category parented under an invisible one vanishes from the tenant's own list.

### Found on the way

`invoices.test.ts` "finds a draft by date" computed today in **UTC** while the
service resolves `?from=/&to=` in the branch's zone. Against an Asia/Kolkata
fixture it failed every night between 18:30 and 24:00 UTC and passed the other
18½ hours, which is how it survived. Invariant 6 broken inside a test. Unrelated
to PI-1 and fixed here because it was red.

`@rcln/web#typecheck` is red and deliberately left alone — untracked
`jest.config.ts` and `tests/`, plus jest devDeps in `package.json` with no
lockfile entry and no install. Predates the branch; regenerating the lockfile is
not PI-1's call. Everything else is green: 989 API tests across 35 suites,
`db:rls:check` at 65 protected tables.

---

## 2026-08-11 — PI-1: Product Platform Core

**Phase:** PI-1 · **Result:** COMPLETE (pending review) · **Branch:**
`feat/pi-1-product-platform-core`

The catalogue: thirteen tables answering "what is this thing?", with nothing in
them that has a quantity, a location or a price.

### What landed

Schema, migration with the hand-written half (20 `NULLS NOT DISTINCT` indexes, 4
partial uniques, 9 CHECKs, 2 triggers, the RLS block), 10 RESTRICTIVE
`*_visible` policies, a new `product` permission module, the exact-rational
conversion engine, contracts, eight services, seven route surfaces, the
structural seed, three screens, and the tests. Detail in
[NEXT_SESSION.md](NEXT_SESSION.md).

### Decisions taken

- **OD-1, OD-2, OD-4 resolved** — see [OPEN_DECISIONS.md](OPEN_DECISIONS.md)
  § Resolved. Platform catalogue with tenant extension; org-scoped; structural
  seed only, no medicine data.
- **Dosage form, route and release type are ENUMS, not lookup tables.** Same
  posture as `ProductType`: adding a member is a migration somebody reviews. A
  table would have needed its own platform/tenant policy and its own visibility
  policy to hold one string.
- **The medicine facet is gated by `pharmacy.medicine.*` while the catalogue is
  gated by `product.definition.*`** (PI-ADR-011), and a product's TAX
  classification is gated by `billing.tax.manage`. Three jobs, three decisions.
- **One form rather than the planned create wizard.** Later steps do not depend
  on earlier answers, and a storekeeper adding forty products wants one screen.

### What went wrong, and what it cost

⚠️ **A RESTRICTIVE policy that cannot exist.** `parent_visible` on
`product_categories` self-referenced its own table. Postgres evaluates policy
expressions with RLS disabled on the tables they REFERENCE — which is what makes
the other ten safe — but a self-reference has no such escape and raises
`infinite recursion detected in policy`. Worse, it did not fail in one place:
`products.category_visible` reads `product_categories`, so the recursion
propagated to **every read of `products`, for every tenant**. Caught by
`tenant-isolation.test.ts`. Removed in `drop_category_parent_visible`.
`specialties` has the identical gap for the identical reason, and the warning was
already written above the `parent_scoped` loop in `enable-rls.sql`.

⚠️ **Two migration-process traps, both hit.** (1) Migrations replay in NAME
order and this repository's recent migrations are hand-dated ahead of the wall
clock, so a Prisma-generated timestamp sorts BEFORE its own dependencies and the
shadow replay fails. (2) An applied migration is checksummed including its
comments, so editing one to add a note demands a full database reset.

⚠️ **Pre-existing schema drift, inherited and fixed.** `invoices` had an index in
the database and in a migration that the schema never declared, so every
`prisma migrate dev` emitted a `DROP INDEX` for it into whoever generated the
next migration — and it was applied once before being caught. Fixed by declaring
it, and by renaming `fee_schedule_entries_scope_key` to Prisma's own name, which
was the other half of the same bug. **The rule: keep the generated index name,
and declare hand-written indexes in the schema.**

### Not done

`/code-review` and `security-reviewer` on the diff — the one remaining leg of
PI-1.10, and mandatory before merge. The screens have not been opened in a
browser.

---

## 2026-08-11 — PI-0: Discovery & Architecture

**Phase:** PI-0 · **Result:** COMPLETE · **Production code changed:** none

### Discovery

Audited the repository directly from source rather than from documentation.
Findings in [CURRENT_STATUS.md](CURRENT_STATUS.md). The consequential ones:

- **Nothing exists.** Zero product, inventory, pharmacy, procurement or
  regulatory tables. This is greenfield.
- **`@rcln/tax` is already global** — `(country, region)` jurisdictions,
  `GST`/`VAT`/`SALES_TAX`, `TaxSplit` for India's halves, effective-dated rules
  with tenant-beats-platform precedence, and a `TaxProviderQuote` seam for US
  sales tax. It needs no change. This removed a large slice of assumed work.
- **`InvoiceSourceType` already has `PHARMACY` and `INVENTORY`.**
- **`invoice_items.item_code` and `.tax_category` are already separate columns**,
  so the brief's "HSN must not be the universal identifier" requirement is
  satisfied upstream.
- **`pharmacy.*` and `inventory.*` permission codes already exist and are
  granted to `PHARMACIST`** — 13 codes, gating nothing, because nothing is built.
- **`specialties` / `qualifications` establish the platform-catalogue-with-
  tenant-extension RLS pattern**, which is exactly the shape the global product
  master needs — including the RESTRICTIVE `*_visible` policy on join tables.
- **`prescriptions` and `encounters`/`procedures` do not exist**, hard-blocking
  the pharmacy-dispensing and clinical-consumption phases. Recorded as KI-1/KI-2.

### Decisions

Seventeen recorded in [ARCHITECTURE.md](ARCHITECTURE.md). Load-bearing:

- **PI-ADR-001** — `products` is the root; medicine is an extension row
- **PI-ADR-002** — the regulatory engine ships **before** dispensing, deviating
  from the brief's suggested order, because dispensing's shape depends on it
- **PI-ADR-003** — the catalogue is a platform master with tenant extension
- **PI-ADR-004** — `stock_ledger` is append-only and is the only quantity truth
- **PI-ADR-005** — consumption never creates an invoice line
- **PI-ADR-006** — this programme writes no tax logic
- **PI-ADR-009** — regulatory maturity is a state, and no agent may set the two
  states that imply legal sign-off

### Planning

- 25 phases (PI-0..PI-24) in [MASTER_PLAN.md](MASTER_PLAN.md), ordered so that
  PI-1..PI-6 are unblocked and can start immediately.
- Task-level tracker for PI-0..PI-5 with a completion gate that is explicitly
  not "the code compiles".
- Eight open decisions, two of which need the user (OD-4 catalogue data source,
  OD-5 who signs off a rule pack).

### Files

Created `.kb/PharmacyInventory/` — 29 documents. Created
`docs/pharmacy-inventory/README.md` as a pointer stub, matching the convention
`docs/README.md` already establishes for every moved document.

**Modified: nothing.** No schema, no package, no app, no migration, no seed.

### Why `.kb/` and not `docs/`

`docs/README.md` states that directory is pointer stubs and says "do not add
content to them". `.kb/` is the KnowledgeBase. `.kb/generate.mjs` only removes
files listed in its own `manifest.json`, so a hand-written directory there is
safe from `pnpm kb`.

### Next

**PI-1.1 — unit of measure & packaging engine.** See
[NEXT_SESSION.md](NEXT_SESSION.md) for the exact starting steps.

---

## Template for the next entry

```markdown
## YYYY-MM-DD — PI-n.m: <what>

**Phase:** · **Result:** · **Tests:** n passing / n failing

### Changed

### Decisions

### Issues found

### Next
```
