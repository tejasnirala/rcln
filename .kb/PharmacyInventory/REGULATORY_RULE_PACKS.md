# Regulatory Rule Packs

How a country's rules are packaged, versioned, sourced and matured. The engine
that runs them is in [REGULATORY_ARCHITECTURE.md](REGULATORY_ARCHITECTURE.md);
the per-country state is in
[COUNTRY_SUPPORT_MATRIX.md](COUNTRY_SUPPORT_MATRIX.md).

---

## What a pack is

One jurisdiction, one version, a set of typed rules, and a source behind every
rule.

```
regulatory_rule_pack
  jurisdiction_id       (country, region?)
  authority_id
  version               semantic, monotonic per jurisdiction
  effective_from / effective_to
  maturity              see below
  last_reviewed_at
  reviewed_by           a human, when set
    └── regulatory_rule[]
          rule_type
          applies_to_product_type? / _category_id? / _classification?
          parameters      JSONB — a document, never foreign keys
          effective_from / effective_to
          source_id       NOT NULL. No source, no rule.
          └── regulatory_source
```

Packs are **platform data**, seeded by `rcln_owner`. A tenant never writes one.
A tenant configures its own `product_regulatory_profiles` and reads the packs.

---

## Maturity — a state, not a boolean

```
ARCHITECTURE_SUPPORTED      the engine can express this kind of rule
        ▼
RULES_CONFIGURED            rows exist for this jurisdiction
        ▼
RULES_IMPLEMENTED           the engine acts on them at the call sites
        ▼
AUTOMATED_TESTED            behaviour tests pass, versioned with the pack
        ▼
SOURCE_VERIFIED             every rule cites a checked authoritative source
        ▼
REGULATORY_REVIEW_PENDING   handed to a qualified human
        ▼
PRODUCTION_ENABLED          signed off, live
```

⚠️ **No code, migration, seed, script or agent may advance a pack to
`REGULATORY_REVIEW_PENDING`'s successor states.** `REGULATORY_REVIEWED` and
`PRODUCTION_ENABLED` are set by a named human with the authority to set them.
Who that is, is [OPEN_DECISIONS.md](OPEN_DECISIONS.md) OD-5.

Anything below `PRODUCTION_ENABLED` shows a visible banner on every regulatory
screen. Silence must never imply compliance.

**Nothing in this repository claims legal compliance for any jurisdiction.**

---

## Rule types

| Type                       | Parameters, indicatively                                                              |
| -------------------------- | ------------------------------------------------------------------------------------- |
| `PRESCRIPTION_REQUIRED`    | required · prescriber classes · validity period                                       |
| `PRESCRIBER_AUTHORITY`     | which qualifications may prescribe what                                               |
| `PHARMACIST_AUTHORITY`     | which qualifications may dispense / verify                                            |
| `CONTROLLED_SCHEDULE`      | schedule name · register required · storage kind · witness required                   |
| `QUANTITY_LIMIT`           | max per dispense · max per period · period length                                     |
| `REFILL_RULE`              | refills allowed · validity window                                                     |
| `AGE_RESTRICTION`          | minimum age · verification required                                                   |
| `SUBSTITUTION`             | permitted · requires prescriber consent · requires patient consent · excluded classes |
| `ONLINE_DISPENSING`        | permitted · excluded classes · destination restrictions                               |
| `STORAGE_REQUIREMENT`      | temperature range · location kind · access control                                    |
| `RECORD_RETENTION`         | period · what must be retained                                                        |
| `TRACEABILITY_REQUIREMENT` | identifiers required at each step (GTIN/lot/expiry/serial)                            |
| `LABELLING_REQUIREMENT`    | required fields on a dispensing label                                                 |
| `REPORTING_REQUIREMENT`    | what · to whom · cadence                                                              |
| `DISPOSAL_REQUIREMENT`     | method · witness · record                                                             |
| `IMPORT_RESTRICTION`       | permitted · licence required                                                          |

Open by design. A new type is an enum member plus handling in
`@rcln/regulatory`, never a special case at a call site.

Parameters are JSONB because their shape genuinely varies by jurisdiction — the
one case ADR-0006 permits. **Which product a rule applies to is expressed in
typed columns**, never as an id inside the JSON.

---

## The source registry

`regulatory_sources`, one row per authoritative document:

```
authority · country · title · regulation / guidance reference
source_url · document_reference
published_on · effective_from · version
retrieved_at · review_status · notes
```

Rules:

- **`regulatory_rule.source_id` is NOT NULL.** A rule with no source cannot be
  inserted.
- **Do not invent legal rules.** If a source cannot be found, the matrix cell
  stays `RESEARCH_REQUIRED` and no rule is written. That is a correct outcome.
- A secondary source (a summary, a vendor blog, a model's recollection) is not a
  source. The regulator's own publication is.
- `retrieved_at` matters: regulations move, and a rule sourced three years ago
  needs re-checking. `last_reviewed_at` on the pack drives a staleness report.

---

## Versioning

- A rule is **never edited in place**. A change is a new rule version with a new
  `effective_from`, and the old row gets an `effective_to`.
- A pack version is monotonic per jurisdiction.
- Every dispensing and consumption transaction snapshots the decision **and the
  pack version ids** that produced it (PI-ADR-008).
- Re-running the engine over a historical transaction is never required and must
  never change what that transaction says.

This is the same discipline the invoice engine already applies to tax, for the
same reason: a document somebody has already filed a return on must not silently
restate itself.

---

## Building a pack

1. **Research.** Identify the authority and its publications. Record sources
   first, rules second.
2. **Configure.** Write the rules, each citing a source. → `RULES_CONFIGURED`
3. **Implement.** Ensure `@rcln/regulatory` handles every type used, and that
   every call site consults it. → `RULES_IMPLEMENTED`
4. **Test.** Behaviour tests, versioned alongside the pack. → `AUTOMATED_TESTED`
5. **Verify sources.** A second pass confirming each URL still resolves and each
   rule matches the document. → `SOURCE_VERIFIED`
6. **Hand over.** → `REGULATORY_REVIEW_PENDING`
7. **A human signs off.** → `PRODUCTION_ENABLED`

Steps 1–5 are agent work. Steps 6–7 are not.

---

## Testing a pack

Never `expect(country).toBe('IN')`. Test the **decision**:

```
given  product classification + jurisdiction + transaction type
       + prescription state + actor + quantity + date
then   outcome, conditions and reasons are exactly these
```

Required cases per pack:

- a permitted dispense
- a refusal for each rule type the pack uses
- a rule that changed: the same request on two dates gives two answers
- an unconfigured product: `UNDETERMINED`, never permitted
- a sub-national override where the jurisdiction has one
- a historical transaction re-read: the snapshot is unchanged after the pack
  advances a version

---

## Pack order

PI-6 India (pilot) → PI-13 US → PI-14 UK → PI-15 Australia → PI-16 Singapore →
PI-17 UAE → PI-18 Ireland → PI-19 Nepal → PI-20 Sri Lanka → PI-21 Bangladesh.

India first because the existing domain model, tax engine and invoice numbering
are already exercised there. The US second because it is the hardest — federal
plus state, and a tax regime that needs the external-provider seam — and if the
framework survives it, the rest are variations.
