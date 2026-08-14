# Consultation Engine — master plan

Eight phases. Each is a shippable vertical slice in the repo's order — schema +
RLS → contracts → permissions → service → route → web → tests — and each ends
with a report in [CHANGELOG.md](CHANGELOG.md).

⚠️ **Order of work inside every phase, from CLAUDE.md:** write everything, then
lint + format, then typecheck only, then tests last and once. Do not interleave
verification with implementation.

---

## CE-0 — Repository analysis ✅ COMPLETE

No production code. Output is this directory, chiefly
[EXISTING_ARCHITECTURE.md](EXISTING_ARCHITECTURE.md) and
[DECISIONS.md](DECISIONS.md).

Headline finding: the clinical taxonomy, the permission split, the consultation
route and the follow-up chain **already exist**. CE builds far less than the
brief assumes.

---

## CE-1 — Clinical foundation ✅ COMPLETE

The vocabulary and the journey. No consultation yet.

- `TaxonomyNodeType.CARE_CONTEXT`; seed `HUMAN` / `VETERINARY` roots and
  re-parent the existing domains (CD-3)
- `patients.subject_type` + `animal_profiles` (CD-4)
- `clinical_master_items` + `clinical_master_codings` + `clinical_master_scopes`
  - `product_clinical_scopes` (CD-5)
- `clinical_episodes` + `appointments.clinical_episode_id`, **with the backfill**
- `encounter_follow_up_recommendations` — the table only; it fills in CE-4
- `DataAccessResource.CLINICAL_EPISODE`
- Routes: `/v1/clinical-data/*` (search, server-paginated), `/v1/clinical-episodes/*`
- Web: clinical masters admin, episode picker on the booking flow
- Seed: dentistry + hair/scalp masters, deliberately small (§41)

⚠️ Episode backfill and `SET NOT NULL` must be **one migration** — see
FOLLOW_UP_ARCHITECTURE §2.

---

## CE-2 — Templates and the configuration resolver ✅ COMPLETE

- `consultation_templates` + `consultation_template_versions` (CD-6)
- **`packages/clinical`** — the pure engine module (CD-10): descriptor parsing
  and validation, section registry rules, template resolution. Unit-tested here
  and nowhere else.
- `GET /v1/appointments/:id/consultation-config` — resolves
  appointment → doctor → classification → template → version → vocabulary scopes
- `clinical.template.manage`; template admin screens

⚠️ The resolver is the **only** place that decides which template applies. No
`if (specialty === …)` anywhere in `apps/web`, ever (§33).

---

## CE-3 — Encounter core and lifecycle ← CURRENT

The engine itself.

- `encounters` (CD-1) + `encounter_sections`
- Lifecycle: `DRAFT` → `FINALIZED` → `AMENDED` / `CANCELLED`, amendment as a new
  row (CD-2); `clinical.encounter.amend`
- Debounced autosave through a Server Action (CD-8)
- Sections landing here: Chief Complaint, History, Examination, Clinical Notes
- Web: `ConsultationEngine` + the section registry + `FieldRenderer` and its
  field components

---

## CE-4 — Clinical content sections

- `encounter_symptoms`, `_diagnoses`, `_procedures`, `_prescriptions`,
  `_investigations`, `_advice`, `_referrals`, `_attachments`
- Follow-up recommendation UI, and **fulfilment** — booking against a
  recommendation (CD-13)
- `DocumentType.CLINICAL_ATTACHMENT`
- Server-side search on every clinical selector (§39). No selector loads its
  whole master.

---

## CE-5 — Visit history and episodes

- `GET /v1/clinical-episodes/:id`, `GET /v1/patients/:id/visit-history`
- The recall list: `GET /v1/follow-up-recommendations?status=DUE`
- Previous-visit summary and the follow-up landing behaviour (§37)
- Full previous consultation, read-only

---

## CE-6 — Visual mapping engine + `HUMAN_DENTAL`

- `visual_maps`, `visual_regions`, `clinical_findings`
- `VisualMappingEngine` — **not** `DentalChart` (§23)
- The 32-tooth FDI odontogram as the first real map (CD-11)
- `clinical.visual_map.manage`

⚠️ No clinical data in the SVG (§22). The SVG carries semantic region ids
(`tooth-36`) and nothing else.

---

## CE-7 — `HUMAN_SCALP` / `HUMAN_BODY` + the reference configurations

The phase that proves the engine is generic. Dentistry and Hair & Scalp
templates, both maps, both driven by configuration.

**Definition of done: no `HairConsultation.tsx` exists, and none was needed.**

---

## CE-8 — Hardening

Validation, permission audit, search performance, error handling, the full §40
integration flow, and both reviewer subagents.

---

## Dependency notes

- **PI-7 (pharmacy dispensing) unblocks at CE-4**, when
  `encounter_prescriptions` exists. That is the whole reason this programme was
  brought forward.
- **PI-9 (clinical consumption) unblocks at CE-4** on `encounter_procedures`.
- The **lab module is not built here**. CE-4's investigations are an order that
  anticipates a lab; PI/lab phases connect to it later.
