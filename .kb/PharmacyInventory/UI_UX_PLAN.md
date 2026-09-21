# UI / UX Plan

Screens and routes are in
[FRONTEND_ARCHITECTURE.md](FRONTEND_ARCHITECTURE.md). This is about the people
using them.

⚠️ Load the **`frontend-design`** skill before writing any new screen, component
or CSS — before the first line of JSX, not as a polish pass.

---

## The governing principle

> A pharmacist is not a regulatory analyst, and a dentist is not an inventory
> manager.

Every screen shows the smallest set of facts that lets one person finish one
job. Regulatory machinery, tenancy machinery and ledger machinery are load-
bearing and almost entirely invisible.

The failure mode this prevents is real and common: a dispensing screen that
surfaces rule ids, pack versions and jurisdiction codes because they were
available in the response. That screen is slower to use, trains people to ignore
warnings, and makes the one warning that matters indistinguishable from noise.

---

## Journeys

### Pharmacist — dispense a prescription

```
Queue ──▶ Prescription ──▶ Dispensing workspace ──▶ Confirm ──▶ Label + bill
```

Sees: patient, prescription, medicine, available stock, batch, expiry, quantity,
warnings, `[Dispense]`.

Never sees: rule ids, pack versions, jurisdiction codes, tax categories, cost.

A warning reads _"Schedule H — pharmacist verification required"_, not
_"REG-IN-0042 v3 → PERMITTED_WITH_CONDITIONS"_.

The batch FEFO chose is shown before commit, with an override that asks for a
reason. An allocation that commits silently is one nobody can question.

### Inventory manager — the morning check

```
Dashboard ──▶ (low stock | near expiry | quarantined | in transit) ──▶ act
```

Dashboard shows **counts, not lists**. Each count is a link. Sees cost and
valuation; does not see prescriptions or clinical content.

### Store manager — receive a delivery

```
PO ──▶ Goods receipt ──▶ scan / type lot, expiry, serial, qty ──▶ post
```

The scanner-heavy screen, and since PI-23 it has a scanner. A single scan may
carry GTIN + lot + expiry + serial; the field accepts the whole payload and fills
four inputs on the next empty line. ⚠️ **It fills and never posts** — the pack and
the paperwork disagree often enough that a scanner which submitted would be worse
than no scanner — and a code matching more than one product fills nothing and says
so. Refusals here are immediate and specific: _"This product is serialised — enter a serial for
each unit"_, not a validation summary at the bottom.

### Doctor / dentist / veterinarian — record what was used

```
Encounter ──▶ Procedure ──▶ Consumption panel (pre-filled) ──▶ adjust ──▶ save
```

Sees: the template's expected quantities, editable, in familiar units. Does not
see cost, tax, charge policy or batch numbers — the system picks the batch.

**Never blocked by a variance.** A large variance is a report, not a modal.

### Lab technician / veterinary assistant

Same consumption panel, different anchor. No separate module.

### Accountant / finance

```
Charge requests ──▶ review ──▶ bill or waive ──▶ existing invoice screens
```

Sees cost, valuation, contribution, tax categories. Does not see clinical
consumption detail beyond its cost.

### Organization admin

Configuration: locations, charge policies, regulatory profiles, thresholds. Sees
everything, and is the only role that meets the regulatory screens at all.

---

## Visibility matrix

|                    | Pharmacist | Inventory mgr | Doctor/Dentist/Vet | Lab tech | Front desk | Accountant | Org admin |
| ------------------ | ---------- | ------------- | ------------------ | -------- | ---------- | ---------- | --------- |
| Product catalogue  | read       | read          | read               | read     | ✖          | read       | manage    |
| Stock levels       | read       | manage        | read               | read     | ✖          | read       | manage    |
| Batches / expiry   | read       | manage        | ✖                  | read     | ✖          | read       | manage    |
| Cost / valuation   | ✖          | read          | ✖                  | ✖        | ✖          | manage     | manage    |
| Procurement        | ✖          | manage        | ✖                  | ✖        | ✖          | read       | manage    |
| Prescription queue | manage     | ✖             | read (own)         | ✖        | ✖          | ✖          | read      |
| Dispensing         | manage     | ✖             | ✖                  | ✖        | ✖          | ✖          | read      |
| Consumption        | ✖          | read          | record             | record   | ✖          | read       | manage    |
| Charge requests    | ✖          | ✖             | ✖                  | ✖        | ✖          | manage     | manage    |
| Regulatory config  | ✖          | ✖             | ✖                  | ✖        | ✖          | ✖          | manage    |
| Recall             | read       | manage        | read               | read     | ✖          | ✖          | manage    |

Indicative. The authority is `packages/permissions/src/roles.ts` and the
per-membership overrides on top of it — a clinic widens any of this itself.

---

## Interaction rules

- **Units are the user's.** Enter "2 boxes"; the base-unit conversion is shown
  beside it, never hidden and never assumed.
- **Confirm anything irreversible** — adjustment, quarantine, dispense, recall
  execution — stating what will happen in the clinic's units.
- **Reasons are required where they are required**, and the field is present
  before submit is enabled, not after a failed post.
- **Empty states teach.** "No products yet" with the one action that fixes it.
- **Errors are in the user's language.** The regulatory engine's `reason` string
  is written for a pharmacist and renders verbatim. A stack-shaped message on a
  dispensing screen is a bug.
- **Dates and times** through `formatClinicTime` and friends, in the branch's
  zone and format. Expiry dates render as stored dates, not converted instants —
  a timezone conversion can slip an expiry by a month.
- **No PHI in a URL.** Search by patient goes in a POST body or by id.
- **Nothing unbounded.** Every list paginates server-side. A ledger view with no
  limit is the query that takes the database down.

---

## What must never appear on a clinical screen

Rule ids · rule pack versions · jurisdiction codes · tax categories · RLS or
tenancy language · internal enum names · database ids as user-facing text ·
"UNDETERMINED" (render it as _"Not configured for this location — ask an
administrator"_).
