# Product · Inventory · Pharmacy · Consumption · Procurement · Regulatory

The single source of truth for the **Product Platform** work stream. Everything
about this programme lives in this directory. Start here.

```text
CURRENT PHASE:        PI-0 — Discovery & Architecture
CURRENT STATUS:       COMPLETE (planning only; no production code written)
LAST COMPLETED PHASE: PI-0
CURRENT WORK:         none — awaiting approval of the plan
NEXT PHASE:           PI-1 — Product Platform Core
BLOCKERS:             none for PI-1..PI-6.
                      PI-7 (Pharmacy dispensing) is HARD-BLOCKED on the
                      `prescriptions` model, which does not exist yet and is
                      owned by Phase 3 (Core clinical).
                      PI-9 (Clinical consumption) is HARD-BLOCKED on
                      `encounters` / `procedures`, which do not exist yet.
LAST UPDATED:         2026-08-11
```

---

## Why this directory is here and not in `/docs`

`docs/` in this repository is a directory of **pointer stubs**; the real
KnowledgeBase is `.kb/` and `docs/README.md` says in as many words _"do not add
content to them."_ So this programme's documentation lives at
`.kb/PharmacyInventory/`, alongside `.kb/Architecture/` and `.kb/Database/`,
and `docs/pharmacy-inventory/README.md` is a stub pointing here — the same
convention every other moved document follows.

Nothing here carries the `.kb/generate.mjs` generated banner. All of it is
hand-written and safe to edit. The generator only removes files listed in its
own `manifest.json`, so this directory is untouched by `pnpm kb`.

---

## Purpose

Build a **global, extensible Product + Inventory + Pharmacy + Clinical
Consumption + Procurement + Regulatory platform** that becomes foundational
infrastructure for rcln — not a pharmacy module.

The platform must serve human healthcare, dental, veterinary, laboratory and
procedural workflows from one product and one inventory engine, and must support
India, UAE, Singapore, Australia, UK, Ireland, Nepal, Sri Lanka, Bangladesh and
the USA through **jurisdiction rule packs**, not through code branches.

The load-bearing rule of the whole design:

> **Consumption is not a charge, a charge is not tax, and tax is not an
> invoice.** Each is a separate concern with a separate seam. rcln already has
> a tax engine, an invoice engine and a payment engine. This programme adds
> nothing to any of them.

---

## Architecture in one screen

```text
CLINICAL          PHARMACY          LAB           DENTAL        VETERINARY
(encounters,      (prescription,    (orders,      (procedures)  (visits)
 procedures)       dispensing)       results)
    │                  │                │              │             │
    └──────────────────┴────────┬───────┴──────────────┴─────────────┘
                                ▼
                     PRODUCT PLATFORM  (PI-1)
        products · compositions · ingredients · manufacturers
        packaging & units · identifiers · tax classifications
                                │
                                ▼
                        INVENTORY  (PI-2, PI-3)
        locations · batches · serials · stock_ledger · stock_balances
        statuses (available/reserved/quarantined/…) · FEFO allocation
                        ▲                    │
                        │                    ▼
                PROCUREMENT (PI-4)     CONSUMPTION / DISPENSING
        suppliers · POs · GRNs         (PI-7 pharmacy, PI-9 clinical)
                                             │
                                             ▼
                              REGULATORY ENGINE  (PI-5, PI-6, PI-13+)
              jurisdictions · rule packs · product regulatory profiles
                                             │
                                             ▼
                              CHARGE REQUEST  (PI-8)
                                             │
        ┌────────────────────────────────────┴────────────────────┐
        ▼                    ▼                  ▼                 ▼
  @rcln/invoicing       @rcln/tax         invoice engine    @rcln/payments
     (EXISTS)            (EXISTS)           (EXISTS)          (EXISTS)
```

Everything below the `CHARGE REQUEST` line already exists and is not rewritten.
See [BILLING_INTEGRATION.md](BILLING_INTEGRATION.md) and
[TAX_INTEGRATION.md](TAX_INTEGRATION.md).

---

## Terminology

| Term                   | Means                                                                                                               |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------- |
| **Organization**       | The tenant. Not "clinic" — there is no clinic entity.                                                               |
| **Branch**             | A place the organization operates from. Carries `country_code`, `region_code`, `timezone`, `currency`.              |
| **Product**            | _What a thing is._ The root catalogue entity. A medicine is a product, so is a glove.                               |
| **Composition**        | A named set of active ingredients + strengths. Brands and generics hang off one composition.                        |
| **Batch / Lot**        | A manufactured run. Carries expiry, cost, supplier, status.                                                         |
| **Serial**             | An individually identified unit. Devices and implants.                                                              |
| **Inventory location** | A physical place stock sits: main pharmacy, fridge, CD cabinet, dental store. Below branch.                         |
| **Stock ledger**       | The append-only record of every movement. The only writer of quantity truth.                                        |
| **Stock balance**      | A derived, trigger-maintained cache of the ledger. Never the source of truth.                                       |
| **Charge policy**      | Whether a consumed item reaches the patient's bill at all.                                                          |
| **Charge request**     | The structured hand-off from this platform to the existing billing engine.                                          |
| **Jurisdiction**       | `(country_code, region_code)`. Same shape the tax engine already uses.                                              |
| **Rule pack**          | A versioned, effective-dated set of regulatory rules for one jurisdiction.                                          |
| **Tax category**       | The exact-match string key into `tax_rules`. Not HSN. HSN is `invoice_items.item_code`, which is presentation only. |

---

## Documentation map

**Read these four to resume work.** Everything else is reference.

| File                                                   | Read it when                                                       |
| ------------------------------------------------------ | ------------------------------------------------------------------ |
| [README.md](README.md)                                 | You are here. Orientation + status header.                         |
| [CURRENT_STATUS.md](CURRENT_STATUS.md)                 | You need the honest ledger of what is built.                       |
| [NEXT_SESSION.md](NEXT_SESSION.md)                     | **You are starting a session.** Tells you exactly where to resume. |
| [IMPLEMENTATION_TRACKER.md](IMPLEMENTATION_TRACKER.md) | The task-level tracker. The authority on task state.               |

Planning and architecture:

| File                                                 | Contents                                                                         |
| ---------------------------------------------------- | -------------------------------------------------------------------------------- |
| [MASTER_PLAN.md](MASTER_PLAN.md)                     | The phases, their order, and why that order.                                     |
| [ARCHITECTURE.md](ARCHITECTURE.md)                   | **The decision record (PI-ADR-001…).** Read before changing anything structural. |
| [DOMAIN_MODEL.md](DOMAIN_MODEL.md)                   | The conceptual entities and their boundaries.                                    |
| [DATABASE_MODEL.md](DATABASE_MODEL.md)               | Proposed tables, keys, RLS class, indexes.                                       |
| [API_ARCHITECTURE.md](API_ARCHITECTURE.md)           | Route surface, middleware chains, contract layout.                               |
| [FRONTEND_ARCHITECTURE.md](FRONTEND_ARCHITECTURE.md) | Screens, routes, data-loading strategy.                                          |

Per-domain deep dives:

| File                                                       | Contents                                              |
| ---------------------------------------------------------- | ----------------------------------------------------- |
| [INVENTORY_ARCHITECTURE.md](INVENTORY_ARCHITECTURE.md)     | Ledger, balances, locations, statuses, FEFO.          |
| [PHARMACY_ARCHITECTURE.md](PHARMACY_ARCHITECTURE.md)       | Dispensing flow, verification, substitution, returns. |
| [CONSUMABLE_ARCHITECTURE.md](CONSUMABLE_ARCHITECTURE.md)   | Why consumables are not medicines with a flag.        |
| [CLINICAL_CONSUMPTION.md](CLINICAL_CONSUMPTION.md)         | Templates, expected vs actual, the charge decision.   |
| [PROCUREMENT_ARCHITECTURE.md](PROCUREMENT_ARCHITECTURE.md) | Suppliers → PO → GRN → returns, and costing.          |
| [REGULATORY_ARCHITECTURE.md](REGULATORY_ARCHITECTURE.md)   | The rule engine, versioning, evaluation contract.     |
| [TRACEABILITY.md](TRACEABILITY.md)                         | The nine questions the data model must answer.        |

Integration and cross-cutting:

| File                                                   | Contents                                                   |
| ------------------------------------------------------ | ---------------------------------------------------------- |
| [BILLING_INTEGRATION.md](BILLING_INTEGRATION.md)       | Charge requests → the existing invoice engine.             |
| [TAX_INTEGRATION.md](TAX_INTEGRATION.md)               | Product → `tax_category` → `@rcln/tax`. No new tax code.   |
| [SECURITY_AND_AUDIT.md](SECURITY_AND_AUDIT.md)         | RLS classes, RBAC codes, audit and PHI-read logging.       |
| [COUNTRY_SUPPORT_MATRIX.md](COUNTRY_SUPPORT_MATRIX.md) | The living per-country matrix. Mostly `RESEARCH_REQUIRED`. |
| [REGULATORY_RULE_PACKS.md](REGULATORY_RULE_PACKS.md)   | Rule-pack format, source registry, maturity states.        |
| [UI_UX_PLAN.md](UI_UX_PLAN.md)                         | Screens per role, and what must stay hidden.               |
| [TESTING_STRATEGY.md](TESTING_STRATEGY.md)             | What each phase must prove before it is COMPLETE.          |
| [MIGRATION_PLAN.md](MIGRATION_PLAN.md)                 | Migration sequencing and backward compatibility.           |
| [OPEN_DECISIONS.md](OPEN_DECISIONS.md)                 | Undecided things, with recommendations.                    |
| [KNOWN_ISSUES.md](KNOWN_ISSUES.md)                     | Defects, gaps and debts as they accrue.                    |
| [CHANGELOG.md](CHANGELOG.md)                           | What each session changed.                                 |

---

## How a new Claude Code session must use this

**At session start, read in this order:**

1. `.kb/PharmacyInventory/README.md` (this file — the status header above)
2. `.kb/PharmacyInventory/NEXT_SESSION.md` — where the last session stopped
3. `.kb/PharmacyInventory/IMPLEMENTATION_TRACKER.md` — the task state
4. `.kb/PharmacyInventory/CURRENT_STATUS.md` — the honest ledger
5. `.kb/PharmacyInventory/ARCHITECTURE.md` — the decisions you may not quietly reverse

Then, and only then, read source. Use `pnpm kb:find <symbol>` before writing any
helper — that index exists specifically to stop a second `hashInviteToken`.

Then determine: current phase → current task → next incomplete task. Do not
restart completed work. Do not redesign a decided PI-ADR without a genuine
technical reason; if you must, record it in `OPEN_DECISIONS.md`, amend
`ARCHITECTURE.md`, and note it in `CHANGELOG.md`.

**At session end, update:**
`CURRENT_STATUS.md`, `NEXT_SESSION.md`, `IMPLEMENTATION_TRACKER.md`,
`CHANGELOG.md` — and `KNOWN_ISSUES.md` if anything broke.

This programme also inherits the repository's own rules. Read
[`CLAUDE.md`](../../CLAUDE.md) and [`.kb/AI/Agent_Instructions.md`](../AI/Agent_Instructions.md)
first if you have not. The seven invariants are not negotiable here.

---

## The next recommended action

Implement **PI-1 — Product Platform Core**, starting with task `PI-1.1`
(unit & packaging engine) in [IMPLEMENTATION_TRACKER.md](IMPLEMENTATION_TRACKER.md).
Use `/db-migration` for the schema work — it is not optional for a `schema.prisma`
change in this repository.
