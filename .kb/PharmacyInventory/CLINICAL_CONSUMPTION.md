# Clinical Consumption

**Phase PI-9 — BUILT (2026-08-17).** This document is the design and it was
followed; where the build refined it, IMPLEMENTATION_TRACKER.md § PI-9 records
what was decided and why.

⚠️ **THE HEADER THIS REPLACES SAID THE PHASE WAS HARD-BLOCKED ON `encounters` /
`procedures`, WHICH DO NOT EXIST.** They have existed since the consultation
engine merged, and the sentence stayed here long after it stopped being true —
which is the failure mode PI-7 wrote up in reverse: a document describing an
intention as though it were the state of the world.

Three refinements the build made, recorded here so this document does not
mislead the next reader:

- **The anchor set is two columns, not six.** `ENCOUNTER` and
  `ENCOUNTER_PROCEDURE` are built. `LAB_ORDER` and `IMAGING_STUDY` are enum
  members with no column and are refused by CHECK, because neither table exists.
  The table below is still the intent.
- **The law is NOT asked at a consumption**, deliberately — no rule type in PI-5
  addresses administering a product, and asking would refuse everything. See the
  service header.
- **"Amended before the encounter closes" still writes ledger legs.** The RECORD
  is restated; the LEDGER is append-only and gets the delta. The distinction
  below is about the record, not about the movement.

---

## The flow

```text
encounter
   └── procedure                    (e.g. "Root canal, single canal")
         └── consumption_template   what this procedure normally uses
               │
               ▼  pre-filled as EXPECTED
         clinician adjusts          → ACTUAL
               │
       ┌───────┴────────┐
       ▼                ▼
 stock_ledger      charge_request
 (CLINICAL_        (only if the charge
  CONSUMPTION)      policy says so —
                    frequently it does not)
```

The right-hand branch being empty is the normal case, not a failure.

---

## Templates

A consumption template belongs to a procedure and lists expected products with
expected quantities in a chosen unit.

```
Root canal, single canal
  Gloves                    2 pairs
  Syringe                   1
  Needle                    1
  Local anaesthetic         2 mL
  Gauze                     5
  Disinfectant              5 mL
  Endodontic file set       1 kit
```

Templates are org-scoped and versioned by effective date, so a template change
never restates what a past procedure consumed.

They are a **starting point**, never a commitment. Nothing is deducted from
stock by a template; only actual consumption moves stock.

---

## Expected vs actual

Three numbers per line, all recorded:

|                     | Meaning                                        |
| ------------------- | ---------------------------------------------- |
| `expected_quantity` | from the template at the time of the procedure |
| `actual_quantity`   | what the clinician says was used               |
| `variance`          | derived, never stored                          |

The clinician may set actual to zero, to more than expected, or add a product
the template never listed. All three are normal.

**An override is audited but not obstructed.** A dentist who used three pairs of
gloves used three pairs of gloves; a system that argues about it gets an
inventory that quietly stops matching reality, which is worse than any variance
report. Large variances surface in PI-22 as a report, not as a block.

---

## Consumption is not a charge

PI-ADR-005, and the single most important rule in this document.

```
Gloves            consumed   → no charge          NEVER_BILL
Syringe           consumed   → no charge          NEVER_BILL
Anaesthetic       consumed   → no separate line   INCLUDED_IN_SERVICE
Endodontic file   consumed   → no separate line   INCLUDED_IN_SERVICE
Implant           consumed   → a charge           SEPARATELY_BILLABLE
Take-home splint  consumed   → maybe              OPTIONAL / CONTRACT_DEFINED
```

Consumption code has **no knowledge of any of this**. It emits a
`charge_request` per consumed line and moves on; the charge policy resolves the
column on the right, and only `SEPARATELY_BILLABLE` (or an accepted `OPTIONAL`)
ever reaches the invoice engine.

This is what lets the same glove be free under one payer and billable under
another with zero code change. See [BILLING_INTEGRATION.md](BILLING_INTEGRATION.md).

---

## One engine, every specialty

The same tables and the same service serve:

| Specialty        | Anchor          | Typical consumption                  |
| ---------------- | --------------- | ------------------------------------ |
| Dental           | procedure       | materials, anaesthetic, burs, files  |
| Surgery          | procedure       | sutures, implants, drapes, gases     |
| General medicine | encounter       | dressings, injectables               |
| Laboratory       | test/order      | reagents, kits, tubes                |
| Veterinary       | visit/procedure | veterinary medicines and consumables |
| Imaging          | study           | contrast media                       |

Only the **anchor** differs — what the consumption record points at. That is one
nullable-per-kind reference set, not a second subsystem. Veterinary in
particular changes nothing here (PI-ADR-017): the animal is a patient with a
different subject type.

---

## Recording rules

- Consumption is recorded **against the encounter/procedure**, at the branch and
  location where it happened, by the clinician or by whoever is delegated.
- It writes ledger rows of type `CLINICAL_CONSUMPTION` with
  `reference_type = CONSUMPTION` and the consumption line id.
- Batch selection uses the same FEFO allocation as dispensing. A consumed
  implant records its **serial**, which is what makes a device recall
  answerable at patient level.
- A consumption record may be amended before the encounter closes; after that it
  is corrected by a compensating movement, never an edit. Same discipline as the
  ledger itself.
- `consumption.record` and `consumption.override` are separate permission
  codes — recording what was used and overriding the expected quantity are
  different acts, and the second is the one a variance report cares about.

---

## What this must never do

- Auto-create an invoice line (PI-ADR-005)
- Deduct stock from a template without an actual recording
- Block a clinician from recording what really happened
- Assume a consumable is free, or that a medicine is billable
- Grow a second inventory path for "clinical" products
