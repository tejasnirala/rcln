# Next Session

**Read this first.** Updated at the end of every session.

**Written:** 2026-08-19 · **By:** session PI-12 (online pharmacy).

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
PI-10 and PI-11 together. **PI-12** Online pharmacy —
`feat/pi-12-online-pharmacy`, **COMPLETE**, ⚠️ **not reviewed**.

---

## What was changed in this session

**PI-12 — Online Pharmacy.** Order → hold → pack → ship → deliver.

| Area        | What landed                                                                                                                                                    |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Engine      | `onlineSaleGap` + `onlineSaleGapMessage` in `@rcln/regulatory`                                                                                                 |
| Schema      | `online_orders` · `online_order_lines` · `online_order_shipments`; `DispenseKind.ONLINE`, `NumberSequenceType.ONLINE_ORDER`, `DataAccessResource.ONLINE_ORDER` |
| Migrations  | `..090000_online_pharmacy_enum_members` · `..090500_pi_12_online_pharmacy`                                                                                     |
| RLS         | `db:rls:check` green at **131**. Three tables, ONE tenancy class — all branch-scoped, the first uniform phase since PI-7                                       |
| Permissions | `pharmacy.online_order.read` / `.manage` / `.dispatch`. ⚠️ **Packing is `pharmacy.dispense.create`**                                                           |
| Services    | `online-order.service.ts`, `fulfilment.service.ts`; `createDispenseWithin` and `reserveStockIn` extracted from existing files                                  |
| Routes      | `/v1/online-orders`, 10 endpoints. **437 endpoints, 437 documented**                                                                                           |
| Screens     | `/pharmacy/orders`, `/pharmacy/orders/new`, `/pharmacy/orders/[orderId]`                                                                                       |
| Found       | ⚠️ **Two defects in code this phase did not write** — see below                                                                                                |

`1897 API tests pass across 92 suites`, plus the package suites.

---

## Decisions taken this session that a later phase must not undo

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

## ⚠️ The two defects this phase found in code it did not write

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

## Where to start

**⚠️ RUN THE REVIEWS FIRST**, over PI-12. Point a reviewer at:

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

**Then PI-13 (US rule pack)**, or PI-22 / PI-23, both of which now have more to
do than they did — see the open items in the tracker.

---

## Open items PI-12 leaves behind

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
