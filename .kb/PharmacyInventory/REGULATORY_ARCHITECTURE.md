# Regulatory Architecture

Phase PI-5 — the framework. Country rules are PI-6 and PI-13..21, and this
document deliberately contains none of them.

**Nothing in this repository claims legal compliance for any jurisdiction.**
See PI-ADR-009.

---

## Shape

`@rcln/regulatory` is a **pure package**, modelled directly on `@rcln/tax`: it
holds no Prisma client, reads no database and knows no clock. The caller loads
the rows and passes them in. That is what makes every rule testable without a
tenant, a transaction or a date.

```ts
evaluate(request: RegulatoryRequest): RegulatoryDecision
```

```ts
interface RegulatoryRequest {
  jurisdiction: { countryCode: string; regionCode: string | null };
  transaction:
    'DISPENSE' | 'COUNTER_SALE' | 'ONLINE_DISPENSE' | 'CONSUME' | 'STOCK' | 'TRANSFER' | 'DISPOSE';
  product: {
    id: string;
    type: ProductType;
    categoryPath: readonly string[];
    compositionId: string | null;
  };
  profile: ProductRegulatoryProfile | null; // for this jurisdiction, on this date
  rules: readonly RegulatoryRule[]; // the caller loaded them
  prescription?: {
    presented: boolean;
    signedByQualifiedPrescriber: boolean;
    issuedOn: Date;
    refillsUsed: number;
  };
  actor: { roleCodes: readonly string[]; licenceIds: readonly string[] };
  patient?: { ageYears?: number; subjectType: 'HUMAN' | 'ANIMAL' };
  quantityBase: string; // Decimal as string
  location?: { kind: LocationKind };
  occurredAt: Date;
}

interface RegulatoryDecision {
  outcome: 'PERMITTED' | 'PERMITTED_WITH_CONDITIONS' | 'REFUSED' | 'UNDETERMINED';
  conditions: RegulatoryCondition[]; // e.g. RECORD_IN_CD_REGISTER, LABEL_FIELDS
  reasons: RegulatoryReason[]; // rule id + pack version + human sentence
  packVersionIds: readonly string[]; // snapshotted onto the transaction
}
```

### `UNDETERMINED` is the important one

A jurisdiction with no applicable rule returns `UNDETERMINED`, and every caller
treats it as **refuse and say so**. It is never a permissive default.

This mirrors the `UNRATED` treatment in `@rcln/tax`, whose comment says it best:
guessing produces "a plausible invoice at the wrong rate, which is the failure
this whole package is shaped to avoid." Guessing a dispensing rule is worse.

The distinction between `REFUSED` and `UNDETERMINED` matters operationally:
`REFUSED` means a rule says no, `UNDETERMINED` means nobody has configured this
jurisdiction yet. The first is a clinical fact; the second is a to-do for the
platform, and the screens say which.

---

## The data

```text
jurisdiction (country_code, region_code?)
   └── regulatory_authority          e.g. a national medicines regulator
         └── regulatory_rule_pack    version · effective_from/to · maturity
               └── regulatory_rule   typed, effective-dated, source-cited
                     └── regulatory_source

product ──< product_regulatory_profiles >── jurisdiction
```

### Rule types

`PRESCRIPTION_REQUIRED` · `PRESCRIBER_AUTHORITY` · `PHARMACIST_AUTHORITY` ·
`CONTROLLED_SCHEDULE` · `QUANTITY_LIMIT` · `REFILL_RULE` · `AGE_RESTRICTION` ·
`SUBSTITUTION` · `ONLINE_DISPENSING` · `STORAGE_REQUIREMENT` ·
`RECORD_RETENTION` · `TRACEABILITY_REQUIREMENT` · `LABELLING_REQUIREMENT` ·
`REPORTING_REQUIREMENT` · `DISPOSAL_REQUIREMENT` · `IMPORT_RESTRICTION`.

Open by design. A rule's parameters are JSONB — **a document, never foreign
keys** (ADR-0006). Which product a rule applies to is expressed by typed columns
(`applies_to_product_type`, `applies_to_category_id`, `applies_to_classification`),
not by an id inside the JSON.

### Product regulatory profile

Per `(product, country, region?)`: registration number and status,
classification, controlled schedule, prescription requirement,
dispensing/storage restrictions, online-sale position, effective dates.

**A product does not have one regulatory nature.** The same molecule is
prescription-only in one country, pharmacy-only in another and general-sale in a
third, and the classification changes over time in all of them. Any design where
regulation is a column on `products` is wrong.

---

## Versioning and history

Every rule and pack carries `version`, `effective_from`, `effective_to`,
`status`, `source_id`, `authority_id`, `last_reviewed_at`. **Rules are never
edited in place** — a change is a new version.

Every dispensing and consumption transaction stores a `regulatory_decisions`
snapshot: the inputs, the outcome, the reasons, the pack versions. Re-running
the engine over a historical transaction is never necessary and must never
change what that transaction says (PI-ADR-008).

Same discipline the invoice engine already applies to tax: every tax field is a
snapshot and is never re-read.

---

## The source registry

No rule enters the system without a `regulatory_source` row:

```
authority · country · regulation or guidance title · source URL ·
document reference · published date · effective date · version ·
retrieved date · review status · notes
```

**Do not invent legal rules.** A rule with no authoritative source does not get
written. A rule whose source cannot be found stays `RESEARCH_REQUIRED` in
[COUNTRY_SUPPORT_MATRIX.md](COUNTRY_SUPPORT_MATRIX.md), which is a useful,
honest state.

The architecture ships fully before any country's rules are populated. That is
the intended order.

---

## Maturity states

```
ARCHITECTURE_SUPPORTED   the engine can express this kind of rule
RULES_CONFIGURED         rows exist
RULES_IMPLEMENTED        the engine acts on them
AUTOMATED_TESTED         behaviour tests pass
SOURCE_VERIFIED          every rule cites a checked authoritative source
REGULATORY_REVIEW_PENDING awaiting a qualified human
PRODUCTION_ENABLED       signed off and live
```

⚠️ **No code path, migration, seed, script or agent may set
`REGULATORY_REVIEW_PENDING` past itself, or set `PRODUCTION_ENABLED`.** Those
transitions belong to a named human with the authority to make them. Every
screen shows the current state, and anything below `PRODUCTION_ENABLED` says so
plainly rather than implying compliance by silence.

---

## Where rules are consulted

| Caller               | Transaction       | Asks                                                                    |
| -------------------- | ----------------- | ----------------------------------------------------------------------- |
| Pharmacy dispensing  | `DISPENSE`        | prescription required · authorities · quantity · refills · substitution |
| Counter sale         | `COUNTER_SALE`    | may this be sold without a prescription here                            |
| Online pharmacy      | `ONLINE_DISPENSE` | may this be dispensed remotely to this jurisdiction                     |
| Clinical consumption | `CONSUME`         | restricted-product handling; recording obligations                      |
| Goods receipt        | `STOCK`           | storage requirements; import restrictions                               |
| Transfer             | `TRANSFER`        | cross-jurisdiction movement restrictions                                |
| Disposal             | `DISPOSE`         | controlled-substance disposal obligations                               |

Each caller calls `evaluate()` and reads the decision. **None of them reads a
rule row, and none of them contains a country code.**

---

## The rule this whole document exists to enforce

There is no `if (country === 'IN')` anywhere in this programme. Not in a
service, not in a controller, not in a component, not in a test helper. A
country-specific behaviour that cannot be expressed as data is a gap in this
framework and gets fixed here, not worked around at the call site.
