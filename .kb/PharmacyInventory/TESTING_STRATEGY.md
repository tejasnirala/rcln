# Testing Strategy

What each phase must prove before any of its tasks may be marked `COMPLETE`.

Stack: Jest + supertest, already in place. 338 API tests green at the time of
writing, `db:rls:check` green at 22 protected tables. **Every phase leaves both
green or the phase is not done.**

---

## The per-phase gate

```bash
docker compose exec api pnpm validate       # typecheck + lint + test
docker compose exec api pnpm db:rls:check   # every tenant table protected
```

Plus `/code-review`, and `security-reviewer` — which is **mandatory** for every
phase here, because every one touches the schema, tenancy and patient data.

---

## Layers

| Layer                  | Covers                                      | Example                                                         |
| ---------------------- | ------------------------------------------- | --------------------------------------------------------------- |
| **Unit**               | pure logic, no DB                           | unit conversion algebra; FEFO ordering; regulatory `evaluate()` |
| **Integration**        | service + Postgres in a transaction         | receipt writes a ledger row and updates the balance             |
| **API**                | supertest through the real middleware chain | 403 without the code; 404 for an unknown tenant                 |
| **Isolation**          | `tenant-isolation.test.ts`                  | tenant B cannot see tenant A's batch, by any route              |
| **Authorization**      | per endpoint, per code                      | every new route has one                                         |
| **Frontend component** | forms and tables with tricky state          | packaging builder, consumption editor                           |
| **E2E**                | the critical journeys below                 |                                                                 |

---

## Non-negotiable tests per phase

### PI-1 — Product

- Unit conversion round-trips exactly through a multi-level hierarchy
  (`case → box → strip → tablet`), with **no floating-point drift**
- Cross-unit-class conversion is refused (mL → mg is not a conversion)
- A composition with **three** ingredients at three strengths, read back intact
- Identifier uniqueness holds per (tenant, type, value, country); the same value
  under two types is allowed
- ⚠️ **The RESTRICTIVE visibility test.** Tenant B cannot attach tenant A's
  private product / ingredient / composition to any of its own rows, and cannot
  read the name back out. This is the highest-risk defect in PI-1.
- A tenant cannot UPDATE a platform catalogue row
- `resolveTaxCategory` picks by effective date; region beats country; missing
  returns `null` and never a guess

### PI-2 — Inventory

- **Ledger append-only, both layers, measured independently.** Remove the REVOKE
  and the trigger still refuses; restore the REVOKE and remove the trigger and
  the grant still refuses. The audit-log tests already do exactly this — copy
  them.
- **50 parallel movements leave the balance exactly right.** The numbering
  service's concurrency test is the template; it found a naive implementation
  returning 7 distinct values out of 50.
- `verifyBalances()` — a ledger replay equals `stock_balances` for a seeded
  fixture with every movement type
- A balance can never go negative, by any route
- Tracking-mode CHECKs refuse at the **database** level: a `SERIAL` product
  moving with no serial, a `LOT_BATCH` product moving with no batch
- Expiry sweep moves stock on the correct day **in the branch's timezone**, not
  UTC
- Near-expiry thresholds come from settings; the test changes the setting and
  the bucket moves
- Isolation cases for every one of the ~8 new tables

### PI-3 — Movements

- A transfer is atomic: both legs or neither
- An inter-branch transfer in transit is visible and belongs to the sender
- FEFO picks the earliest expiry; ties break by received date, deterministically
- FEFO **never** selects expired, recalled or quarantined stock
- A reservation reduces availability; an expired reservation releases it
- An adjustment without a reason code is refused

### PI-4 — Procurement

- A goods receipt writes ledger rows, creates batches and sets cost per base unit
- Over-receipt beyond tolerance is refused; the tolerance comes from settings
- A serialised product cannot be received without serials
- An expiry-controlled product cannot be received without an expiry
- Receiving an already-expired batch is refused
- Moving-average cost is right after three receipts at three prices
- A requisition cannot be approved by its creator

### PI-5 — Regulatory

- Rule resolution by date: the same request on two dates gives two answers
- Region beats country
- **No applicable rule → `UNDETERMINED`, and every caller refuses.** Not
  permitted, not "probably fine".
- A rule with no source cannot be inserted (the FK is NOT NULL)
- A pack's maturity cannot be advanced past `REGULATORY_REVIEW_PENDING` by code
- The decision snapshot is stable: advance the pack a version, re-read the
  historical transaction, nothing changed

### PI-6 and every country pack

Behaviour, never country codes. See
[REGULATORY_RULE_PACKS.md](REGULATORY_RULE_PACKS.md) § Testing a pack.

```
❌  expect(country).toBe('IN')
✅  given classification X + jurisdiction IN + DISPENSE + no prescription
    then outcome === 'REFUSED' with reason type PRESCRIPTION_REQUIRED
```

Regulatory tests are versioned **alongside** the pack. A pack version bump that
does not update its tests is not a version bump.

### PI-7 — Pharmacy

- Cannot dispense expired / recalled / quarantined stock, from any route
- Cannot dispense without the code; cannot verify without the verify code
- A regulatory refusal returns 422 with a human reason, not 403
- Dispensing writes: dispense record + ledger rows + regulatory snapshot +
  audit row + data-access row, in one transaction
- A rolled-back dispense leaves no ledger row and burns no number
- A dispense read writes exactly one `data_access_logs` row per request
- ⚠️ **No patient name or medicine name appears in `data_access_logs`**

### PI-8 — Billing

- A consumed glove under `NEVER_BILL` produces **no** invoice line
- An implant under `SEPARATELY_BILLABLE` produces exactly one
- Charge policy resolution: most specific wins, and the resolved policy is
  stored on the request
- Tax resolves through `@rcln/tax` and nowhere else; a product with no
  classification yields `UNRATED` and the invoice refuses to issue
- A return produces a credit note and does not touch the original invoice

### PI-9 — Consumption

- Consumption **never** auto-creates an invoice line
- An override is recorded and audited, and is not blocked
- Actual zero is valid; actual above expected is valid; a product not in the
  template is valid

### PI-10 — Recall

- A recalled batch is un-dispensable and un-consumable from **every** path
- Forward trace finds every dispense and consumption of the batch
- Backward trace from a patient reaches the supplier

---

## Critical E2E journeys

Each is one test, end to end, through the real chain:

1. Create product → receive batch → check stock
2. Transfer stock between branches → both balances correct
3. Dispense a prescription → ledger + charge request + invoice + tax
4. Return a dispense → credit note
5. Consume consumables during a procedure → ledger moves, **no invoice line**
6. Consume an implant → ledger moves **and** an invoice line appears
7. Recall a batch → dispensing blocked → affected patients identified
8. Expired stock is not dispensable
9. RBAC: each role can do exactly what it should, and nothing else
10. Tenant isolation: tenant B sees nothing of tenant A, on every new route

---

## Anti-patterns

| Don't                                                   | Do                                                                                        |
| ------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `expect(country).toBe('IN')`                            | test the decision                                                                         |
| Assert against `stock_balances` only                    | assert the ledger too; the balance is a cache                                             |
| Mock the tax engine                                     | it is pure and fast — call it                                                             |
| Test happy paths only                                   | a refusal that does not refuse is the defect that matters here                            |
| Skip the isolation case "because the service scopes it" | the service is one of three layers, and the other two are the ones that catch the mistake |
| Mark a task complete on a green typecheck               | the gate is at the top of the tracker                                                     |
