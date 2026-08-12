# Open Decisions

Things that are genuinely undecided, each with a recommendation. Decided items
live in [ARCHITECTURE.md](ARCHITECTURE.md); move an entry there when it is
settled, and note the move in [CHANGELOG.md](CHANGELOG.md).

**Last updated:** 2026-08-12 (PI-3: OD-9 raised and resolved in the same session)

---

## OD-1 — Should tenants be able to create products, or only extend a platform catalogue?

**Blocks:** PI-1.2 · **Recommendation: allow both.** · **Confidence: high**

PI-ADR-003 assumes the `specialties` pattern: a platform catalogue with tenant
extension. But `specialties` is a small closed-ish list, and a product catalogue
is not.

Options:

|                                                  | Effect                                                                                                                    |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------- |
| **A. Platform + tenant extension** (recommended) | A clinic can add "Dr Rao's compounded ointment" without waiting for the platform. Matches the existing precedent exactly. |
| B. Platform only                                 | Clean catalogue, but a clinic that stocks something unusual is stuck. Not viable.                                         |
| C. Tenant only                                   | No shared catalogue, so every clinic re-types Amoxicillin, and no cross-tenant regulatory profile is possible.            |

**Recommendation: A.** It is what the codebase already does and it is the only
option that supports both a maintained catalogue and real clinics.

The consequence to accept: tenant products need their own regulatory profiles,
and a clinic-created product will often have none — which resolves to
`UNDETERMINED` and refuses. That is the right failure, and the UI must explain
it well.

---

## OD-2 — Is the product catalogue org-scoped or branch-scoped?

**Blocks:** PI-1.2 · **Recommendation: org-scoped.** · **Confidence: high**

Inventory is unambiguously branch-scoped. The catalogue is the question.

**Recommendation: org-scoped.** A product is a definition, and a three-branch
hospital defining Amoxicillin three times is absurd. It also matches
`patients`, which ADR-0007 makes org-scoped for the same reason: identity is
org-wide, attendance is branch-local (ADR-0016). A product is identity.

Per-branch _availability_ is expressed by stock existing at that branch, not by
a catalogue restriction.

If a clinic later needs "this branch does not stock that", it is a per-branch
product setting, not a change of tenancy class.

---

## OD-3 — Localisation of product and regulatory names

**Blocks:** nothing yet · **Recommendation: defer, but reserve the shape.**
**Confidence: medium**

Ten countries include several with non-Latin scripts and locally-required
product names. The repository has no i18n framework today.

Options: a `product_translations` table now; JSONB name maps; or defer entirely.

**Recommendation:** defer the feature, but **do not put display names in JSONB**
in PI-1 — that is the choice that becomes hard to undo. Keep `name` as a plain
column and add `product_translations` as a normal child table when i18n arrives
platform-wide. This costs nothing now and forecloses nothing.

Needs a decision before any non-English-script country pack ships (PI-19+).

---

## OD-4 — Does the platform ship a seeded global product catalogue?

**Blocks:** whether PI-1 ships useful. **This is a business/legal decision, not
a technical one.** · **Confidence: n/a — needs the user**

A product catalogue with real medicine data is either **licensed** from a data
provider, **built** from public regulatory registers, or **absent**.

|                                         | Effect                                                                            |
| --------------------------------------- | --------------------------------------------------------------------------------- |
| A. License a commercial drug database   | Best data. Costs money, has redistribution terms, and the terms vary per country. |
| B. Build from public national registers | Free, per-country effort, quality varies, and maintenance is ongoing.             |
| C. Ship empty; clinics enter their own  | Zero cost, zero risk, and PI-1 ships a catalogue with nothing in it.              |

**⚠️ What must not happen: generating medicine data from a model.** A
hallucinated strength or composition in a dispensing system is a patient-safety
defect, and it will look completely plausible. No agent should populate this
catalogue from memory under any circumstances.

**Interim recommendation:** C for PI-1, with the import machinery designed in so
that A or B can be loaded later. Categories, units and dosage forms _are_ seeded
— those are structural, not clinical.

**Needs the user.**

---

## OD-5 — Who may set a rule pack to `REGULATORY_REVIEWED` / `PRODUCTION_ENABLED`?

**Blocks:** PI-6 completion · **Needs the user** · **Confidence: n/a**

PI-ADR-009 says no code path and no agent may set these states. That leaves the
question of who does.

It needs a named role — in-house counsel, a retained regulatory consultant, a
pharmacist with the relevant registration, or per-country. Until it is answered,
every pack stops at `AUTOMATED_TESTED` / `SOURCE_VERIFIED`, which is a safe
resting state and does block production enablement.

**Needs the user.**

---

## OD-6 — Does the platform maintain `tax_rule_defaults` for all ten countries?

**Blocks:** nothing in this programme · **Recommendation: no, not as part of
this programme.** · **Confidence: medium**

`tax_rule_defaults` is described in the schema as "the published law of a
country, shared by every clinic in it", maintained under
`platform.tax.manage`. Populating it for ten countries is a commitment to keep
ten countries' rate cards current by statute.

**Recommendation:** out of scope here. This programme resolves a `tax_category`;
whether the platform ships default rates for it is a separate business decision
with the same shape as OD-4. Clinics configure their own `tax_rules` today, and
that continues to work.

---

## OD-7 — Where does the consumption panel live in the UI?

**Blocks:** PI-9 · **Recommendation: inside the encounter.** · **Confidence: low
until the encounter UI exists**

A separate `/consumption` route, or a panel inside the encounter/procedure
screen.

**Recommendation:** inside the encounter — a clinician records consumption as
part of finishing a procedure, not as a separate errand. But the encounter UI
does not exist yet (the consultation page is a placeholder), so this cannot be
settled until Phase 3 lands. A standalone route remains useful for
retrospective correction.

**Revisit when the encounter screen exists.**

---

## OD-8 — Cost visibility to clinicians

**Blocks:** PI-9 / PI-22 · **Recommendation: hidden by default, a setting to
reveal.** · **Confidence: medium**

Should a dentist see that the implant they just recorded costs ₹18,000?

Arguments both ways are real: cost awareness genuinely reduces waste, and cost
visibility genuinely influences clinical decisions in ways some clinics
consider inappropriate.

**Recommendation:** hidden by default, exposed by an org-level setting through
the existing resolver. It is a clinic's decision, not ours — the same posture
invariant 7 takes on clinical authoring.

---

### OD-9 — Where does inter-branch stock live between dispatch and receipt? · 2026-08-12

**Raised by PI-2, blocked PI-3.3, resolved by the user in PI-3.**

**Option A, as recommended: the transfer DOCUMENT holds it.** Dispatch writes
`TRANSFER_OUT` at the sender and nothing else; receipt writes `TRANSFER_IN` at
the receiver and nothing else. Both legs cite one transfer id. Outstanding
quantity is `sent − received` over the lines of `DISPATCHED` transfers.

**Why not the architecture doc's sender-owned `IN_TRANSIT` bucket.**
`branch_isolation` is RESTRICTIVE on `stock_ledger`, so every row must carry a
`branch_id` inside the writer's scope. A bucket at the sender makes the RECEIVER
write a removal against a branch they cannot see — allowable only by widening
their tenant context, which is the first hole in the branch boundary, or by
writing the row twice, which is the second ledger writer PI-ADR-004 forbids.

**Two consequences, both recorded rather than discovered later:**

- In-transit stock is not in `stock_balances`. PI-22's valuation must add the
  outstanding lines of `DISPATCHED` transfers. An integration test pins it.
- Anything the RECEIVER needs to know about the SENDER's branch-scoped rows must
  travel on the document. Two migrations exist for this: the shelf names on the
  transfer, the lot's identity on the line. Both were written after a test
  failed, not after anybody read the code.

Written up in [INVENTORY_ARCHITECTURE.md](INVENTORY_ARCHITECTURE.md) § Transfers
and on the `StockTransfer` model.

---

## Resolved

### OD-1 — Tenants may create products AND extend a platform catalogue · 2026-08-11

**Option A, as recommended.** Every master in `products.prisma` allows
`organization_id NULL`, following the `specialties` precedent exactly.

What PI-1 added to the reasoning: the consequence is stronger than "a clinic can
add its own row". A tenant **cannot edit a platform row at all**, and cannot
attach its own packaging, identifier or tax classification to one either — the
composite FK `(organization_id, product_id)` makes it unrepresentable. So
customising a shared product is necessarily a CLONE, and that is enforced by the
database rather than by a service check somebody can forget.

The accepted cost stands: a clinic-created product has no regulatory profile and
will resolve `UNDETERMINED` in PI-5.

### OD-2 — The product catalogue is ORG-SCOPED · 2026-08-11

**As recommended.** No `branch_id` on `products` or on any catalogue master.
Per-branch availability will be expressed by stock existing at that branch, which
is PI-2's business. Nothing in PI-1 needed a branch, which is the confirmation.

### OD-4 — The platform ships NO seeded product data · 2026-08-11

**Option C, as the interim recommendation.** `seed/product-masters.ts` writes 35
units, 10 conversions, 32 categories and 9 storage profiles — all structural
facts about measurement, packaging and refrigeration. It writes **zero**
products, ingredients and compositions.

⚠️ This remains a business and legal decision, not a technical one, and it is
NOT closed for good: licensing a drug database or building from public registers
is still open, and the import path is designed for it. What IS closed is the
question of whether a model may fill the gap in the meantime. It may not, under
any circumstances — a hallucinated strength or composition in a dispensing system
is a patient-safety defect that will look completely plausible to every reviewer.
The reasoning is repeated at the top of `seed/data/product-masters.ts`, which is
where somebody would go to add the data.
