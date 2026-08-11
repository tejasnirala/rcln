# Known Issues

Defects, gaps and debts in **this programme**. Repository-wide issues live in
[`.kb/15_Known_Issues_and_Technical_Debt.md`](../15_Known_Issues_and_Technical_Debt.md)
and [`.kb/Architecture/PITFALLS.md`](../Architecture/PITFALLS.md).

**Last updated:** 2026-08-11

---

## Defects

None. No code has been written.

---

## Blockers

### KI-1 — `prescriptions` does not exist · blocks PI-7

**Severity: high · Owner: Phase 3 (Core clinical) · Status: open**

Pharmacy dispensing has nothing to dispense against. Phase 3 is mid-flight —
station 1 stage 5 of 5 is pending (queue tokens and walk-in) and prescriptions
come after it.

**Mitigation:** PI-1..PI-6 and the counter-sale half of PI-8 do not depend on it
and proceed. **Do not build against a guessed prescription shape** — that
guarantees rework in the highest-risk workflow in the programme.

### KI-2 — `encounters` / `procedures` do not exist · blocks PI-9

**Severity: high · Owner: Phase 3 · Status: open**

Clinical consumption has no anchor. The consultation page is currently a route
with a deliberate placeholder where the specialty-specific diagnosis form will
go.

**Mitigation:** same. Consumption templates could technically be built against
the clinical taxonomy alone, but the consumption _record_ needs the anchor, so
splitting the phase buys little.

---

## Risks

### KI-3 — The RESTRICTIVE visibility policy is easy to omit

**Severity: high (security) · Status: mitigated by documentation only**

Every join table pointing at a platform-extensible parent needs its own
RESTRICTIVE `*_visible` policy. `tenant_isolation` constrains the child side and
says nothing about the parent side. Omit it and a tenant attaches another
tenant's private product to its own row and reads the name back out.

**`db:rls:check` cannot detect this** — the table has a policy, just not enough
of one.

**Mitigation:** an explicit test per join table (see
[TESTING_STRATEGY.md](TESTING_STRATEGY.md) PI-1), `security-reviewer` on every
phase, and this entry.

### KI-4 — `setting_values` is RLS-exempt

**Severity: medium (security) · Status: inherited, documented**

The explicit `(scopeType, scopeId)` pair every read passes is the only tenant
isolation there is, and `db:rls:check` can never notice a missing one. This
programme will add several settings (expiry thresholds, receipt tolerances, FEFO
overrides).

**Mitigation:** every new setting read passes the pair explicitly and has a test
proving cross-tenant reads fail. PI-ADR-015.

### KI-5 — The expiry sweep is the repository's first real worker processor

**Severity: medium · Status: open**

Every BullMQ queue is registered and only stubs consume them. PI-2.8 needs a
real processor, so PI-2 carries the cost of proving the worker path works at
all — retries, idempotency, failure visibility.

**Mitigation:** budget for it in PI-2, and keep the processor trivially
idempotent: moving already-`EXPIRED` stock to `EXPIRED` must be a no-op.

### KI-6 — Notification delivery is a logging stub

**Severity: low · Status: inherited**

Expiry, low-stock and recall alerts will queue but not deliver until Phase 7
cross-cutting lands. **Do not build a second notification path.**

### KI-7 — `stock_ledger` will need partitioning

**Severity: low now, high later · Status: designed for, not implemented**

It grows without bound. Prisma cannot declare a partitioned table, so this is a
hand-written migration later — the same note `audit_logs` and
`data_access_logs` already carry.

**Mitigation:** put the note in the model comment when the table is created, and
index for the traceability queries from day one.

### KI-8 — Regulatory data quality is the programme's largest non-technical risk

**Severity: high · Status: structurally mitigated**

Ten jurisdictions of pharmacy regulation is a research problem, not a coding
problem, and a wrong rule is invisible until it matters.

**Mitigation:** `regulatory_rule.source_id` is NOT NULL; maturity states; the
matrix defaults to `RESEARCH_REQUIRED`; and no agent may mark a pack reviewed.
**No agent generates regulatory or medicine data from memory.**

### KI-9 — Product catalogue data has no source

**Severity: high · Status: open, needs a decision**

See [OPEN_DECISIONS.md](OPEN_DECISIONS.md) OD-4. PI-1 currently ships an empty
catalogue.

⚠️ **Generating medicine data from a model is prohibited.** A hallucinated
strength or composition in a dispensing system is a patient-safety defect that
looks entirely plausible.

---

## Debt accepted deliberately

| Item                                                  | Why                                                                                                           | Revisit            |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- | ------------------ |
| No i18n for product names                             | The repository has no i18n framework; a JSONB name map now would be hard to undo                              | OD-3, before PI-19 |
| No input-tax-credit handling                          | Purchase tax is recorded, not computed; ITC is an accounting subsystem                                        | Post PI-24         |
| No insurance/payer contract engine                    | `CONTRACT_DEFINED` charge policy is modelled but resolves to a manual decision until a contract engine exists | When claims land   |
| No consignment stock workflow                         | `LocationKind.CONSIGNMENT` exists; the ownership model does not                                               | PI-22+             |
| No multi-currency procurement conversion              | A PO in USD received into an INR branch stores both; no FX policy                                             | PI-4 review        |
| `charge_requests` / `regulatory_decisions` unarchived | They grow with volume                                                                                         | PI-24              |

---

## How to use this file

Add an entry the moment something is discovered, not at session end. Include
severity, what it blocks, and the mitigation. Move resolved entries to a
`## Resolved` section with the date and the fix — deleting them loses the reason
the fix exists.
