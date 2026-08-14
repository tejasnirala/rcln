# Consultation Engine — schema

~22 new tables across CE-1…CE-6, plus five altered enums and three altered
tables. Every table's tenancy class is stated, because in this codebase that is
a security decision and not a modelling one.

⚠️ **Every tenant table needs three things or it does not ship:** a policy in
`packages/db/prisma/rls/enable-rls.sql`, that SQL appended to its generated
migration, and a case in `apps/api/tests/integration/tenant-isolation/`.
`db:rls:check` goes from **89** protected tables to roughly **108**.

---

## Tenancy classes in use

| Class                   | Shape                                                     | Precedent      |
| ----------------------- | --------------------------------------------------------- | -------------- |
| **platform-extensible** | `organization_id` NULLABLE; read permissive, write strict | `specialties`  |
| **org-scoped**          | `organization_id` NOT NULL, no branch                     | `patients`     |
| **org + branch scoped** | both NOT NULL, in both RLS loops                          | `appointments` |

⚠️ **Never copy the `files` policy for a platform-extensible table.** It permits
a NULL `organization_id` in its `WITH CHECK`, which would let any clinic INSERT
a platform-wide row visible to every tenant. Copy `specialties`.

---

## CE-1 — Foundation

### `clinical_master_items` — platform-extensible

The single clinical vocabulary table (CD-5).

```text
id, organization_id NULL, parent_id NULL, kind, code, name, description,
display_order, metadata JSONB, is_active, created_at, updated_at, deleted_at

kind: SYMPTOM | DIAGNOSIS | PROCEDURE | INVESTIGATION | ADVICE
    | HISTORY_ITEM | FINDING_TYPE
```

- `@@unique([organizationId, kind, code])` — ⚠️ **rewritten NULLS NOT DISTINCT
  in the migration**, or the platform rows are not unique among themselves.
- `parent_id` `onDelete: Restrict` — SetNull silently promotes an entire subtree
  to the root, exactly as `specialties` documents.
- `@@index([parentId])` — descendant walks recurse on it; without the index the
  CTE seq-scans once per level.
- Trigram index on `lower(name)` for the search (§39), **hand-written** — Prisma
  cannot express an expression index.

### `clinical_master_codings` — platform-extensible

```text
id, organization_id NULL, item_id, system, code, display, is_primary
```

`system` is a **VARCHAR, not an enum** — same reasoning as
`patients.national_id_type`: the accepted list grows per market, and as an enum
that is a migration per coding system.

`@@unique([organizationId, itemId, system, code])`, NULLS NOT DISTINCT.

### `clinical_master_scopes` / `product_clinical_scopes` — platform-extensible

`(item_id | product_id) × specialty_id`, plus `relevance` (SmallInt).

⚠️ **These RANK, they never FILTER.** A `RESTRICTIVE specialty_visible` policy
is needed on both, exactly as `doctor_specialties` has, because `specialty_id`
points at a possibly-platform row and cannot be a composite FK.

### `clinical_episodes` — org-scoped, PHI

```text
id, organization_id, patient_id, code, title, status, primary_specialty_id NULL,
opened_on, closed_on NULL, opened_by, closed_by, notes, created_at, updated_at,
deleted_at

status: OPEN | CLOSED
```

**Org-scoped, NOT branch-scoped** — the same call `patients` makes. A journey
that starts at the main branch and continues at the satellite is one journey.

⚠️ `title` and `notes` are **PHI** and belong in `REDACTED_KEYS`.
`@@unique([organizationId, id])` as the composite-FK target.

### `animal_profiles` — org-scoped (CD-4)

`patient_id` unique, `species`, `breed`, `sex`, `weight_kg`, `guardian_name`,
`guardian_phone`. Thin on purpose.

### `encounter_follow_up_recommendations` — org + branch scoped, PHI

Table lands in CE-1; the UI fills it in CE-4. Full semantics in
[FOLLOW_UP_ARCHITECTURE.md](FOLLOW_UP_ARCHITECTURE.md) §3.

⚠️ **CHECK: exactly one of (`interval_value` + `interval_unit`) or
`recommended_date`.** ⚠️ **Partial unique index on
`fulfilled_by_appointment_id`** so one booking cannot fulfil two
recommendations.

### Altered

```text
appointments        + clinical_episode_id     NOT NULL after backfill
patients            + subject_type            default HUMAN
TaxonomyNodeType    + CARE_CONTEXT
DataAccessResource  + CLINICAL_EPISODE, ENCOUNTER
```

⚠️ Backfill and `SET NOT NULL` in ONE migration. ⚠️ All four enums pre-exist, so
`ALTER TYPE … ADD VALUE` applies and no CHECK may name a new member in the same
migration (CD-9).

---

## CE-2 — Templates

```text
consultation_templates          platform-extensible
  code, name, specialty_id, care_context_id, description, is_active

consultation_template_versions  platform-extensible
  template_id, version, definition JSONB, status, published_at, published_by,
  retired_at
```

⚠️ **`definition` holds section types, order, labels, field descriptors, map
codes and SCOPE codes — never master-item ids** (CD-6, ADR-0006).

⚠️ **A PUBLISHED version is immutable in every field.** `assertVersionIsDraft`
guards all writers, including the dates — the lesson from PI-5's
`assertPackIsOpen`.

---

## CE-3 — The encounter

### `encounters` — org + branch scoped, PHI

```text
id, organization_id, branch_id, patient_id,
appointment_id NULL,                    ← CD-1: a walk-in has no booking
clinical_episode_id, doctor_profile_id,
encounter_number,
template_id, template_version_id, template_snapshot JSONB,   ← §29
status, chief_complaint, chief_complaint_duration_value/_unit, onset,
clinical_notes,
started_at, finalized_at, finalized_by,
amends_encounter_id NULL, amended_at,
created_at, updated_at, deleted_at

status: DRAFT | FINALIZED | AMENDED | CANCELLED
```

⚠️ **Partial unique index: at most one non-superseded encounter per
appointment.** ⚠️ Every text column here is PHI.

### `encounter_sections` — org + branch scoped, PHI

`encounter_id`, `section_type`, `section_key`, `data` JSONB, `display_order`.

Holds the dynamic answers for `HISTORY` and `EXAMINATION`. The first-class
sections have their own tables and store nothing here.

---

## CE-4 — Clinical content

All org + branch scoped, all PHI, all children of `encounters` carrying
`organization_id` **and** `branch_id` themselves.

⚠️ **They carry both ids rather than inheriting through a parent predicate.**
This is the call the invoice children made and the one
`appointment_status_history` did not — an org-only inherited policy under a
branch-scoped parent re-opens the branch boundary.

```text
encounter_symptoms        item_id NULL + custom_text, duration, severity,
                          frequency, site, notes
encounter_diagnoses       item_id NULL + custom_text, role (PRIMARY |
                          SECONDARY | DIFFERENTIAL), certainty, notes
encounter_procedures      item_id, diagnosis_id NULL, visual_region_id NULL,
                          performed_on, status, notes
encounter_prescriptions   product_id, strength, dose, dose_unit, route,
                          frequency, frequency_unit, duration, duration_unit,
                          food_relation, timing, quantity, start/end date,
                          is_prn, instructions, notes
encounter_investigations  item_id, reason, priority, instructions, status
encounter_advice          item_id NULL + custom_text, is_edited
encounter_referrals       specialty_id NULL, doctor_profile_id NULL,
                          external_name, reason, urgency, notes
encounter_attachments     encounter_id × stored_file_id, kind, caption
```

⚠️ **`item_id NULL + custom_text` on symptoms, diagnoses and advice is
deliberate** — §6 wants a custom symptom, and forcing every free-text entry to
create a master row pollutes the vocabulary with one clinic's typos.

⚠️ **`encounter_prescriptions.product_id` is a plain FK into a possibly-platform
row**, so it needs a `RESTRICTIVE product_visible` policy, exactly as `batches`
does.

---

## CE-6 — Visual mapping

```text
visual_maps       platform-extensible
  code, name, renderer (SVG | IMAGE_MAP), asset_key, care_context_id,
  specialty_id NULL, view_box

visual_regions    platform-extensible
  map_id, code, label, parent_id NULL, display_order, metadata JSONB
  @@unique([organizationId, mapId, code])   NULLS NOT DISTINCT

clinical_findings org + branch scoped, PHI
  encounter_id, visual_region_id, finding_item_id, diagnosis_id NULL,
  severity, notes, metadata JSONB
```

⚠️ **No clinical data in the SVG** (§22). The asset carries semantic region ids
(`tooth-36`) and nothing else; every finding is a database row.

⚠️ `visual_regions.code` is FDI for the dental map — `TOOTH_11` … `TOOTH_48`
(CD-11).

---

## Migration sequencing

The highest existing migration is `20260818090000`. Migrations replay in **name
order** and this repo's are hand-dated ahead of the wall clock, so everything
Prisma generates must be re-dated past it.

| Order | Migration                     | Notes                                        |
| ----- | ----------------------------- | -------------------------------------------- |
| 1     | `…_clinical_enum_members`     | The four `ALTER TYPE … ADD VALUE`s alone     |
| 2     | `…_clinical_masters`          | Items, codings, scopes + RLS                 |
| 3     | `…_clinical_episodes`         | Table, column, **backfill, SET NOT NULL**    |
| 4     | `…_follow_up_recommendations` | CHECK constraints may name the new enums now |

⚠️ **Migration 1 exists solely because of the enum trap** (CD-9): a CHECK naming
a value added by `ALTER TYPE … ADD VALUE` cannot run in the same transaction as
the addition.
