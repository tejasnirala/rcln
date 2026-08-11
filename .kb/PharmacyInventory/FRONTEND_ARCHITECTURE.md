# Frontend Architecture

`apps/web` is **Next.js 16**. Read `apps/web/AGENTS.md` and
`node_modules/next/dist/docs/` before writing Next code — 16 renamed
`middleware.ts` → `proxy.ts` and removed the `eslint` config key, and guessing
here costs a build.

⚠️ **Load the `frontend-design` skill before the first line of JSX**, not as a
polish pass. It decides what you build; retrofitting a visual direction onto
finished markup means rewriting the markup. Consult
`vercel-react-best-practices` for anything with a list or a form — which is
almost everything here.

---

## Where the screens live

All of it is tenant surface:

```
apps/web/src/app/(tenant)/t/[slug]/(app)/
  products/          catalogue
  inventory/         stock, batches, serials, expiry, ledger, transfers
  procurement/       suppliers, POs, GRNs, returns
  pharmacy/          queue, dispensing, sales, returns
  consumption/       procedure consumption (or nested under the encounter)
  regulatory/        jurisdiction config, product profiles, rule status
  reports/           inventory and pharmacy reports
```

Platform-only rule-pack administration goes under
`apps/web/src/app/(platform)/platform/regulatory/`.

Shared components in `apps/web/src/components/tenant/<domain>/`. There is no
`packages/ui` and creating one is out of scope — the repository deliberately
does not have one yet.

---

## Data loading

Server Components by default. Client Components only where there is genuine
interactivity: the dispensing workspace, the scanner input, the consumption
editor, the packaging builder.

Rules that are not optional here:

- **Server-side pagination, filtering and search on every list.** A catalogue
  and a ledger are both unbounded. Never `GET /v1/products` without a limit and
  never filter client-side.
- **No waterfalls.** Fetch product + stock + regulatory profile in parallel in
  the server component, not in nested effects.
- **Host header.** `apps/web/src/lib/api.ts` sets `Host` from the slug for
  server-to-server calls. Forget it and every tenant call 404s, indistinguishably
  from a missing route. Use the existing helper; do not hand-roll a `fetch`.
- **No PHI in `localStorage`, cookies or URL query params.** A dispensing search
  by patient goes in a POST body or by id, never `?patient=Sharma`.
- **Every date through `formatClinicTime` and friends** (`apps/web/src/lib/format.ts`),
  with the zone from the row's branch or `timezoneOf(slug)` and the format from
  `timeFormatOf(slug)`. Never a fresh `Intl.DateTimeFormat`, never a bare
  `toLocaleString()`. Invariant 6.
- **Expiry dates are dates, not instants.** An expiry of `2027-03` rendered in
  a timezone can slip a month. Render the stored date, do not convert it.

---

## Screens by phase

### PI-1 — Product

| Screen                | Notes                                                                                                                                                                                                   |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Product list          | Search by name / generic / brand / SKU / GTIN / ingredient / manufacturer / category. Server-side, debounced, paginated. Platform rows visually distinguished from the clinic's own.                    |
| Product create wizard | Type → identity → classification → composition (medicines only) → packaging → identifiers → tax classification → storage → inventory config. Steps hide by type: a glove never sees a composition step. |
| Product detail        | Tabs: overview, composition, packaging, identifiers, tax, regulatory (PI-5), stock (PI-2), movement history.                                                                                            |
| Composition builder   | Multi-ingredient with strength + unit per ingredient. The one screen that must not assume a single ingredient.                                                                                          |
| Packaging builder     | Visual hierarchy `case → box → strip → tablet` with the computed base-unit total shown live.                                                                                                            |

### PI-2 / PI-3 — Inventory

| Screen                       | Notes                                                                                                                      |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| Inventory dashboard          | Low stock, near expiry, expired, quarantined, recalled, pending transfers. Counts, not lists.                              |
| Stock overview / by location | The location tree on the left, balances on the right.                                                                      |
| Batch view                   | Lot, expiry, quantity, status, cost, supplier, origin GRN.                                                                 |
| Serial view                  | Device history, including patient assignment where permitted.                                                              |
| Expiry view                  | Buckets driven by the configured thresholds, never hard-coded windows.                                                     |
| Quarantine / recall          | Read-only in PI-2; actions land in PI-10.                                                                                  |
| Ledger                       | Paginated, filterable by product, batch, location, movement type, date. Append-only, so no edit affordance anywhere on it. |
| Transfers / adjustments      | Adjustment requires a reason code before submit is enabled.                                                                |

### PI-4 — Procurement

Supplier list/detail · supplier products · requisition · PO workspace (lines,
supplier pack sizes, expected cost) · GRN capture (the scanner-heavy screen:
lot, expiry, serial, quantity) · returns.

### PI-5 — Regulatory

Jurisdiction configuration · product regulatory profile editor · rule status and
version viewer · source references. **Every screen carries the maturity banner**
(PI-ADR-009): anything below `PRODUCTION_ENABLED` says so, plainly.

### PI-7 — Pharmacy

| Screen                   | Notes                                                                          |
| ------------------------ | ------------------------------------------------------------------------------ |
| Pharmacy dashboard       | Queue depth, dispensed today, low stock, expiring, recalls.                    |
| Prescription queue       | New / verified / partially dispensed / completed.                              |
| Prescription detail      | Read-only clinical content. Pharmacy never edits a prescription.               |
| **Dispensing workspace** | The most important screen in the programme. See below.                         |
| Substitution             | Equivalent compositions in stock, with the regulatory answer attached to each. |
| Returns / sales          |                                                                                |

The dispensing workspace shows, and only shows:

```
Patient · Prescription · Medicine · Available stock · Batch · Expiry
Quantity · Warnings · [Dispense]
```

It must **not** show rule ids, pack versions, jurisdiction codes or engine
internals. A warning reads _"Schedule H — pharmacist verification required"_,
not _"rule REG-IN-0042 v3 returned DENY"_. The internals belong on the
regulatory screens, for the person whose job they are.

### PI-9 — Consumption

Procedure consumption panel (expected pre-filled, actual editable, variance
shown) · consumption history · inventory impact.

### PI-22 — Reports

One list, one detail pattern, exports through the existing export permission.

---

## Accessibility & interaction

- Every destructive or irreversible action (adjustment, quarantine, dispense,
  recall execution) confirms with what will happen, in the clinic's units.
- Scanner input is a focused text field that accepts a full GS1 payload and
  resolves product + batch + serial in one round trip (PI-23). Never assume a
  scan is only a product code.
- Quantities are entered in whatever unit the user thinks in; the base-unit
  conversion is shown, never hidden.
- Errors from the regulatory engine render its `reason` verbatim — that string
  is written for a pharmacist and is the whole point of it existing.

---

## What normal users must never see

Per the brief's UX principle, and worth restating because it is easy to violate:

| Role                   | Sees                                                   | Never sees                              |
| ---------------------- | ------------------------------------------------------ | --------------------------------------- |
| Pharmacist             | prescription, stock, batch, expiry, warnings, dispense | rule ids, pack versions, RLS anything   |
| Inventory manager      | balances, batches, transfers, expiry, reorder          | regulatory internals, prescriptions     |
| Doctor / dentist / vet | consumption panel, expected vs actual                  | procurement, cost, tax                  |
| Front desk             | nothing from this programme except a bill              | all of it                               |
| Accountant             | cost, valuation, charge requests, invoices             | clinical consumption detail beyond cost |
| Org admin              | configuration, all of the above                        | —                                       |
