# ADR-0006 — No JSON arrays of foreign keys

**Status:** Accepted

## Context

The predecessor schema stored relationships as JSON arrays of ids:

```
care_tooth_diagno.problem_ids    json  "no FK, JSON array of ids"
care_hair_diagno.diagnosis_ids   json  "no FK, JSON array of ids"
```

Unjoinable, unindexable, no referential integrity, and impossible to answer
"how many patients presented with this problem" without application-side
expansion.

The pressure that produced it is real: dentistry, trichology and dermatology
capture genuinely different fields, and nobody wants a table per specialty.

## Decision

Two mechanisms, kept separate:

1. **Real join tables** for anything relational —
   `prescription_symptoms`, `prescription_diagnoses`, `prescription_medicines`.
2. **Versioned form templates** for genuine per-specialty variation:
   `clinical_form_templates.schema` (JSONB) defines fields;
   `clinical_form_submissions.data` (JSONB) holds a submission.

JSONB is used as a **document**, never as a foreign key.

Dental charting additionally gets a first-class table
(`dental_chart_entries`) because tooth-level history must be queryable across
visits — FDI tooth number, surface, condition, procedure, status.

## Consequences

- Adding an ophthalmology module is an INSERT into `clinical_form_templates`.
  No DDL, no migration. That is the extension point keeping the schema stable.
- Reporting works: symptom frequency, diagnosis trends, drug-allergy checking
  are all ordinary SQL.
- Form templates are versioned, so historical submissions still render against
  the schema they were captured with.

## The one deliberate exception

`stock_ledger.reference_id` is polymorphic — it points at whichever document
caused a stock movement. It is constrained by a `CHECK` on `reference_type`,
indexed on the pair, and **never joined for correctness** (the ledger is
self-contained, carrying `balance_after`). It exists only for drill-down.

## How it can be broken

Any column named `*_ids` with type `json`/`jsonb`. If a new feature seems to
want one, it wants either a join table or a form template.
