# Next Session

**Read this first.** Updated at the end of every session.

**Written:** 2026-08-20 · **By:** session PI-18 (the Ireland rule pack).

## PI-18 first, because it is the freshest and it is unreviewed

✅ **PI-18 SHIPPED:** `IE 1.0.0` — 50 rules, 7 sources, 3 authorities, on branch
`feat/pi-18-ie-rule-pack`. 52 behaviour cases, no migration.
⚠️ **NOT REVIEWED** — and neither are PI-17, PI-16, PI-15, PI-13a and PI-13.

⚠️ **THE FIRST JURISDICTION IN THIS PROGRAMME THAT FORBIDS REMOTE SUPPLY.**
Regulation 19(1) of S.I. No. 540 of 2003 prohibits mail order of any medicinal
product; regulation 19(5) extends it to information society services; regulation
19A(8)(b) shuts the door on a prescription medicine sent to a person in the
State. Six classifications carry `ONLINE_DISPENSING` with `permitted: false`,
which REFUSES before the destination is even looked at. **Read PI-12 decision 1
next to it** — Ireland is where the engine's gate and `confirmOnlineOrder`'s gate
finally agree about the same product, and only one of them cites the law.

⚠️ **IT NEEDED ONE FRAMEWORK KEY, AND THE REASON IS A LESSON ABOUT PI-13a.**
Regulation 19A(1) permits NON-prescription distance selling only from a supplier
on the PSI's ISS supply list — GAP 2's shape, arriving on the `ONLINE_DISPENSING`
rule type rather than on `CONTROLLED_SCHEDULE` where PI-13a put it. PI-13a
generalised the CONDITION (`VERIFY_PRIOR_AUTHORISATION`) and left the PARAMETER
tied to one rule type. `requiresDistanceSellingAuthorisation` closes it; recorded
as GAP 6 in the survey. **Great Britain's GPhC internet pharmacy list will land
here again.**

⚠️ **THE PATTERN PI-17 ASKED THE NEXT PHASE TO CARRY SHOWED UP TWICE IN ONE
PACK.** `branch.licence_type` is now the fourth jurisdiction's ask — regulation
7(6) confines a First Schedule Part C prescription to a hospital, so **no Part C
classification is defined at all** and such a product refuses as `UNDETERMINED`.
And regulation 7(5)(a)(ii), from 1 March 2024, permits a twelve-month validity on
a period written on the prescription or a pharmacist's recorded review — neither
of which `PresentedPrescription` holds — **so the pack refuses on day 183 a
dispense that may be lawful.** That is the refusing direction, written knowingly,
and a behaviour case pins it so the cheap fix (`validityMonths: 12`) fails.

⚠️ **`CountryInfo.regions` FOR `IE` IS EMPTY AND CORRECT — THE FIRST CLEAN RUN OF
THAT CHECK.** Irish medicines law is national, so no sub-national pack can exist
to be made inert. One loose end recorded rather than fixed blind: `labels.region`
says 'County' and no county can be selected. ⚠️ **`US_REGIONS` IS STILL SHORT
FIVE STATES.**

⚠️ **THE RESEARCH HAZARD TO CARRY INTO PI-19: IRELAND PUBLISHES NO CONSOLIDATION
OF A STATUTORY INSTRUMENT.** The 2003 Regulations have been amended more than
forty times and the eISB serves the 2003 text and each amendment separately, so
the principal instrument reads as though nothing has changed. Three amendments
were read in full and are their own source rows; the rest were checked for
whether they touch the regulations in play. **A substitution nobody noticed reads
exactly like a rule nobody amended** — that is this pack's largest exposure and
the thing a `SOURCE_VERIFIED` reviewer must actually walk.

⚠️ **PI-18 FOUND A LIVE DEFECT IN PI-15, AND IT IS THE MOST IMPORTANT THING IN
THIS FILE.** `AU-SCHEDULE-S8` carries `{ scheduleName: 'Schedule 8' }` and
nothing else. `parseControlledSchedule` REJECTS a document that imposes no
obligation, so the rule resolves `UNDETERMINED` — **which refuses every Schedule
8 supply, stock movement, transfer and disposal in the seven Australian
jurisdictions with no state pack.** Its own comment asserts the opposite, and its
behaviour case asserts the rule code appears and no conditions were raised, which
is exactly what an unreadable rule produces. **It never asserts the outcome.**
PI-12's lesson verbatim. Not fixed in PI-18 — the fix changes Australia's
behaviour in seven jurisdictions and belongs to whoever owns that pack. Two
options are written out in KNOWN_ISSUES. ⚠️ **Check `US-CD-*`, `SG-CD*` and both
Emirati packs for the same shape.**

⚠️ **AND A CLASS OF FAIL-OPEN NOBODY HAS LOOKED FOR: AN UNCLASSIFIED RULE.**
`coversProduct` matches a rule with no classification against ANY product, and
`needsClassificationButHasNone` does not fire when a product HAS a classification
the pack simply does not define. So in a pack whose refusing rules are all
classified, a product filed under an unrecognised string matches only obligations
— and an obligation never refuses. PI-18's own first draft shipped that bug for
an hour; `IN`, `US`, `SG` and `US-CA` have the same shape today, read off the
rule rows rather than run. KNOWN_ISSUES has the table.

### Where to start on PI-18, if you are reviewing it

- `packages/db/prisma/seed/data/regulatory-ie.ts` — the header argues the missing
  Part C classification, the missing traceability rule and the six-versus-twelve
  months. Read it before adding any of the three.
- `IE-ONLINE-*` — the six `permitted: false` rules and the one `permitted: true`.
  ⚠️ **The `PHARMACY_ONLY` permission has a known hole**: regulation 19(4) keeps
  the mail-order prohibition over Eighth Schedule products, so a
  pharmacy-administered influenza vaccine filed as `PHARMACY_ONLY` gets a
  permission it should not. KNOWN_ISSUES has it.
- `IE-DISPENSER-*` — `exemptWhenActorIsPrescriber` is set on regulation 20(3)(c),
  which names a practitioner and a dentist and **not a nurse**. `isPrescriber`
  carries no class, so the pack's exemption is wider than the regulation's.
- The two schedule lists that are not the same list — regulation 19 (register)
  reaches Schedules 1 and 2; Safe Custody article 5 reaches Schedules 1, 2 and 3.
  Widening either would be wrong in a different direction.
- `IE-DISPOSE-*` — the weakest reading in the pack. Regulation 25(5) disapplies
  the witness from a pharmacy keeping records only by virtue of regulation
  23(4)(a), and the rule raises it for all three schedules anyway.
- `apps/api/tests/integration/ie-rule-pack.test.ts` — the day-183 refusal, the
  Part C `UNDETERMINED`, the instalment with no number, and the Part 1 Schedule 4
  product that may sit on an open shelf.

⚠️ **PI-19 (Nepal) is next.** PI-14 (GB) stays blocked on legislation.gov.uk.

---

## PI-17, still unreviewed

✅ **PI-17 SHIPPED:** `AE-AZ 1.0.0` (25 rules, DoH Abu Dhabi) and `AE-DU 1.0.0`
(26 rules, DHA Dubai). 22 behaviour cases, no migration.
⚠️ **NOT REVIEWED** — and neither are PI-16, PI-15, PI-13a and PI-13.

⚠️ **THE FIRST COUNTRY IN THIS PROGRAMME CONFIGURED ONLY FROM BELOW.** There is
no `AE` pack. `uaelegislation.gov.ae` returns `403` on every path and
`mohap.gov.ae` resets the connection, so the federal Ministerial Decrees both
emirates rest on — 888/2016, 379/2019, 253/2020, 680/2017 — were readable only as
those emirates restate them. **That is a secondary source and no rule cites one.**
Every rule is cited to the emirate standard that each regulator says applies to
the facilities it licenses.

⚠️ **SO SHARJAH, AJMAN, FUJAIRAH, RAS AL-KHAIMAH AND UMM AL-QUWAIN HAVE NOTHING.**
Not a thin pack — no pack, and no national floor beneath them, so every
evaluation answers `UNDETERMINED`, which refuses. Australia's seven state-less
jurisdictions at least get the Poisons Standard. A behaviour case pins this so
nobody closes it by writing a federal pack from a restatement.

⚠️ **`CountryInfo.regions` WAS EMPTY FOR `AE` TOO. THIS IS NOW A CLASS OF DEFECT,
NOT AN ACCIDENT.** Australia in PI-15, the UAE in PI-17 — both populated from
"does tax register per subdivision", both taxing federally at one rate, both
regulating medicines sub-nationally. PI-16 recorded "check this list first"; the
check found a live defect on its first outing. ⚠️ **THIS ONE HAD A TELL IN THE
SAME OBJECT: `labels.region` for `AE` already said `'Emirate'`** — the address
form asked which emirate a branch was in while the list permitted none.
`UAE_REGIONS` lists all seven. ⚠️ **`US_REGIONS` IS STILL SHORT FIVE STATES.**

⚠️ **THE PATTERN TO CARRY INTO PI-18: A GATE CONDITIONAL ON A FACT THE PLATFORM
DOES NOT MODEL CANNOT BE A RULE — AND THREE JURISDICTIONS HAVE NOW ASKED FOR THE
SAME MISSING FACT.** Singapore's pharmacist gate turns on whether the premises are
a retail pharmacy or a clinic; Dubai confines narcotic prescribing to hospital
inpatient and emergency units; Abu Dhabi requires a facility to be licensed as a
hospital, day surgery centre, pharmacy or drug store. rcln has no
`branch.licence_type`. **That field, not a bolder reading, is the fix.**

### Where to start on PI-17, if you are reviewing it

- `packages/db/prisma/seed/data/regulatory-ae-az.ts` — the header argues the
  missing federal pack and the missing days'-supply ladder. Read it before adding
  either.
- The six `*-TRANSFER-*` rules — `IMPORT_RESTRICTION` rows narrowed to
  `TRANSFER`, because that handler is the only one that refuses a transaction
  outright. ⚠️ **The narrowing is load-bearing and has no guard**: widen
  `appliesToTransactions` on one of them and every Emirati clinic stops being
  able to receive controlled stock. Third occurrence of "the framework has no
  `permitted: false` transaction rule" after Singapore's `SG-SUPPLY-CD4`.
- `DU-RX-POM` — three months, drawn from a clause that reads "e.g." inside a
  recommendation. The weakest reading in either pack, and written because
  omitting a validity fails OPEN.
- `AZ-REFILL-CD` / `DU-REFILL-CD` — wider than their regulators wrote, because
  the lists of refillable products are in decrees nobody could retrieve.
- `apps/api/tests/integration/ae-rule-pack.test.ts` — the Sharjah case, the two
  emirates disagreeing about the unified platform, and the assertion that the
  outcome is not `UNDETERMINED` for want of a days' supply.

✅ **PI-18 (Ireland) shipped.** irishstatutebook.ie was rated "Good" and was —
it serves full text over `curl` with a browser user agent, and `403`s the default
one. PI-14 (GB) stays blocked on legislation.gov.uk.

---

## PI-12, still worth reading before touching pharmacy or online supply

✅ **`security-reviewer` HAS RUN OVER PI-12. 2 CRITICAL, 1 HIGH, 3 MEDIUM, 4 LOW
— all acted on**, both CRITICALs with a regression test verified to FAIL against
the reverted code. Full write-up in IMPLEMENTATION_TRACKER.md under **PI-12.5**.

✅ **`/code-review` HAS ALSO RUN** (on the second attempt — the first died on a
session limit). **No CRITICAL, no HIGH. 8 WARNING, 7 INFO — all acted on.** It
confirmed the five things the phase was most exposed on, and found that THREE OF
THEM WERE ARGUED FROM COMMENTS THAT SAID THE WRONG THING. Write-up under
**PI-12.6**.

⚠️ **THE LESSON WORTH CARRYING: EVERY DEFECT THIS PHASE SHIPPED WAS FIRST WRITTEN
DOWN AS A JUSTIFICATION.** The missing RLS policies came with a comment citing
two precedents that said the opposite; the `held` map's correctness was credited
to an index that has nothing to do with it; the oversell safety was credited to a
sort that only prevents deadlock; and the contract header claimed a destination
was derived when it is typed. A confident comment is the easiest thing in this
codebase to review past.

⚠️ **BOTH CRITICALS ARE WORTH READING BEFORE TOUCHING ANY OF THIS.** One is KI-3
for the fifth time, on a comment that cited two precedents which said the
opposite of what it claimed. The other is the phase opening its own second door
by widening a shared enum — `DispenseKind` gained `ONLINE` for the column's sake
and silently widened `createDispenseRequest` with it, so the entire remote-supply
gate could be walked round by posting to the counter endpoint.

⚠️ **THE ONE THING TO UNDERSTAND BEFORE TOUCHING ANY OF IT:** a remote supply now
has TWO gates, deliberately, and one of them is not the rule engine. Read
"The gate" below before you decide either is redundant.

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
**PI-7** Pharmacy dispensing. **PI-8** Billing & tax integration. **PI-8.11** the
review gate over PI-7 + PI-8. **PI-9** Clinical consumption. **PI-10** Recall &
traceability. **PI-11** Veterinary enablement, plus the review gate over PI-9,
PI-10 and PI-11 together. **PI-12** Online pharmacy. **PI-13a** rule-pack
framework extensions. **PI-13** United States (federal + California). **PI-15**
Australia (national + Victoria). **PI-16** Singapore. **PI-17** Abu Dhabi and
Dubai. **PI-18** Ireland — ⚠️ the last six are **not reviewed**.

⚠️ **PI-14 (Great Britain) is BLOCKED** on access to legislation.gov.uk, and the
UAE's FEDERAL sources are in the same state.

---

## What was changed in this session

**PI-17 — the Emirati rule packs.** Two data files, two `PACKS` entries, one
contracts fix, one test suite, no migration.

| Area      | What landed                                                                                                                                                                                                                                                                             |
| --------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Contracts | `UAE_REGIONS` — all seven emirates — and the second entry in the `CountryInfo.regions` warning, which now says this is a class of defect                                                                                                                                                |
| Seed      | `data/regulatory-ae-az.ts` (25 rules) and `data/regulatory-ae-du.ts` (26 rules); two `PACKS` entries, both sub-national                                                                                                                                                                 |
| Rules     | Three-day prescriptions across three tiers, prescriber grades for narcotics, refill ceilings, the registers, the unified platform as a prior authorisation, locked steel storage, 5/5/2-year retention, monthly and quarterly returns, witnessed disposal, and the transfer prohibition |
| Tests     | `apps/api/tests/integration/ae-rule-pack.test.ts` — 22 cases, three branches in one organization, one of them in Sharjah                                                                                                                                                                |
| DB        | none. The fifth rule-pack phase running with no migration                                                                                                                                                                                                                               |
| Docs      | COUNTRY_SUPPORT_MATRIX (AE row, column, and why the rest did not move), KNOWN_ISSUES, IMPLEMENTATION_TRACKER, CHANGELOG, survey, STATUS                                                                                                                                                 |

---

## Decisions taken in PI-12 that a later phase must not undo

**1. ⚠️ THE GATE IS IN TWO PLACES AND BOTH ARE LOAD-BEARING.**
`@rcln/regulatory` raises the remote-supply gap as a decision reason, snapshotted
onto the order line. `confirmOnlineOrder` ALSO refuses, directly, before the
engine's answer is consulted for enforcement. That is not belt-and-braces: a
`REFUSED` decision stops nothing until a named human sets a pack to
`PRODUCTION_ENABLED`, and no pack is. With the engine alone, every product in
every configured country would have been sendable by post the day this shipped.

What the service refuses is not a jurisdiction's law — it is the CLINIC's own
record of what the product is here (`product_regulatory_profiles
.online_sale_position`), which is the same class of check as `is_dispensing_point`
and `products.status`. `onlineSaleGapMessage` is shared so the two wordings can
never drift.

**2. ⚠️ THE FAIL-OPEN THIS CLOSES WAS REAL AND SURVIVED SEVEN PHASES.** A pack
that regulates supply lists `ONLINE_DISPENSE` alongside `DISPENSE` on its
prescription rules — it has to — so a pack that says NOTHING about remote supply
PERMITS it, on the strength of rules about a counter. India's pack is exactly
that shape. Anyone tempted to "simplify" the gate away should read
`packages/regulatory/tests/online-sale-gap.test.ts`, whose last case is that
exact request.

**3. THERE IS ONE FUNCTION THAT DISPENSES.** `createDispenseWithin` is called by
the counter and by packing. A parallel posting function was the alternative, and
PI-11's review already recorded what it costs: _a second door into a status
change is a second door into the hazard._ The seam is `RemoteSupply` — three
fields a client must never be able to state, each with the reason on it.

**4. ACCEPTING HOLDS; PACKING SUPPLIES. THE CLAIM COMES FIRST.** Pack marks the
reservations CONSUMED **before** any ledger leg — the discipline
`releaseReservationIn` documents at length — then dispenses with
`statusFrom: RESERVED`. Reversing the two lets the sweep release a hold between
the leg and the claim, putting quantity back on a shelf it has already left.

**5. ⚠️ A HOLD CITES THE ORDER _LINE_, NOT THE ORDER.** Reservations carry a
product and a lot and no line. `online_order_lines` is unique on
`(organization_id, online_order_id, product_id)` for the same reason, and the
service refuses a duplicate with a sentence before the index does.

**6. A FAILED DELIVERY MOVES NO STOCK.** The parcel is somewhere and the clinic
does not have it back. What returns returns as a `dispense_returns` row.

**7. PACKING IS GATED ON `pharmacy.dispense.create`.** It IS the supply. A fourth
online code would be a second door to that authority.

**8. The router is at `/v1/online-orders`, not under `/pharmacy`.** Not
cosmetic: `route-gates.test.ts` requires every route under `/pharmacy` to carry a
`pharmacy.dispense.*` code, and nesting there would have forced the
order-taking desk behind the dispensing codes.

**9. Four things were deliberately not built** — a patient portal,
click-and-collect, partial shipment, and substitution on an order. Each is argued
in the header of `online-pharmacy.prisma`; each adds a nullable path through the
phase's one irreversible write.

---

## ⚠️ The two defects PI-12 found in code it did not write

**1. `dispenses_prescription_has_patient` would have refused every parcel.** PI-7
wrote it as a two-way choice between the counter's two kinds, so an `ONLINE`
dispense satisfied neither arm. Rewritten with a third arm tying ONLINE to a
PATIENT and deliberately not to an encounter — a parcel has to go to somebody, and
it may or may not be against a prescription.

**2. A PI-11 test asserted the opposite of what PI-11's own review fixed.**
`patients.test.ts` expected a capped `dailyDose` of `500.000`, while
`weightBasedDose` had been changed — with `499.998` written into its own code
comment — so that the reported pair always multiplies. The suite has been red
since PI-11 landed and nothing surfaced it. Corrected.

---

## Where to start on the unreviewed phases

**⚠️ RUN THE REVIEWS FIRST** — PI-12 is done, PI-13a, PI-13, PI-15 and PI-16 are
not. For PI-12, point a reviewer at: Point a reviewer at:

- `confirmOnlineOrder` — the gate, the FEFO plan, the holds, and the fact that
  the number is issued last so a refusal burns none.
- `packOnlineOrder` — the claim-then-move order, and whether a partial claim can
  ever leave the order and the buckets disagreeing.
- `createDispenseWithin` and `RemoteSupply` — whether the three internal-only
  fields are genuinely unreachable from the HTTP surface, and whether the
  `held` map keyed by request-line OBJECT survives every path through the sort.
- `onlineSaleGap` — whether an unrecognised position can ever fail open, and
  whether the gate touches any transaction but `ONLINE_DISPENSE`.
- The three tables' CHECK constraints, especially
  `online_orders_status_is_consistent` — it encodes the whole state machine and
  is what stops a cancellation reaching a packed order.
- `data_access_logs` under `ONLINE_ORDER` — an order row is the broadest
  single-row disclosure in the product, and this is the first resource that
  carries a home address.

**Then PI-17 (UAE rule pack)**, or PI-22 / PI-23, both of which now have more to
do than they did — see the open items in the tracker.

---

## Open items the online-pharmacy phase leaves behind

- **No sweep moves an ABANDONED order's status.** The reservation sweep releases
  the hold by `expires_at`, but the order stays `CONFIRMED` with nothing held,
  and only `heldQuantityBase: 0` on the screen says so. A status of its own
  would be honest; it needs a decision about who moves it.
- **Recall does not reach a CONFIRMED order's held stock.** PI-10 walks
  `dispense_allocations`, so a PACKED parcel IS traced — but stock held in the
  `RESERVED` bucket for an order nobody has packed is invisible to a recall's
  execution. PI-22/PI-23 territory.
- **The product picker is capped at 100** on the order form, like every other
  picker in this programme. PI-23.

---

## Files worth reading before touching online orders

|                                                                       |                                                                            |
| --------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| `packages/db/prisma/schema/online-pharmacy.prisma`                    | The four acts, the four non-goals, and why the arrow points at `dispenses` |
| `apps/api/src/services/pharmacy/online-order.service.ts`              | The gate, and why it is checked here as well as in the engine              |
| `apps/api/src/services/pharmacy/fulfilment.service.ts`                | Claim, dispense, move on — and why that order                              |
| `apps/api/src/services/pharmacy/dispense.service.ts`                  | `RemoteSupply`, and the three fields a client may never state              |
| `packages/regulatory/src/selection.ts`                                | `onlineSaleGap`, and the fail-open it closes                               |
| `apps/api/tests/integration/online-pharmacy.test.ts`                  | The gate both ways, the double-count case, the hold that went away         |
| `apps/api/tests/integration/tenant-isolation/online-pharmacy.test.ts` | Three tables, one tenancy class, and the state machine as CHECKs           |

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
