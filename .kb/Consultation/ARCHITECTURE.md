# Engine architecture

How configuration reaches the screen without configuration becoming the screen.

---

## The line between hard-coded and data

```text
HARD-CODED (code, reviewed, tested)      CONFIGURATION (rows, editable, versioned)
─────────────────────────────────────    ─────────────────────────────────────────
the engine and its lifecycle             which sections appear, and in what order
the section registry — one component     their labels
  per ConsultationSectionType            which clinical vocabulary they draw on
the field renderer and its field types   field descriptors within a section
validation, permissions, autosave        which visual map, if any
prescription/diagnosis/investigation     the vocabulary itself — symptoms,
  behaviour                                diagnoses, procedures, advice
visual-map rendering                     the maps and their regions
```

⚠️ **This is deliberately NOT "JSON controls the frontend".** `ConsultationSectionType`
is a closed enum and each member has exactly one hard-coded component.
Configuration selects and parameterises; it cannot invent a section the engine
has no component for, and an unknown section type is an error, not a blank.

---

## Resolution: appointment → screen

All of it on the server. **`apps/web` contains no specialty logic** (§33).

```text
GET /v1/appointments/:id/consultation-config
   │
   ├─ appointment  →  doctor_profile
   │                     └─ doctor_specialties (is_primary)  →  specialties node
   ├─ patient.subject_type  ─────────────────────────────────┐
   │                                                          ▼
   │                              walk the taxonomy UP to its CARE_CONTEXT root
   │                                                          │
   ├─ consultation_templates: most specific node match, ──────┘
   │    walking up the tree until one is found
   │       └─ latest PUBLISHED consultation_template_versions
   │
   └─ the version's `definition`, parsed and validated by @rcln/clinical
         └─ scope codes in it  →  which clinical vocabulary the selectors search
```

⚠️ **Most-specific-wins, walking up.** Hair & Scalp resolves its own template if
one exists; otherwise Dermatology's; otherwise the care context's default. Same
specificity rule as `packages/regulatory`'s `selection.ts`, and for the same
reason — a clinic configures the level it cares about and inherits the rest.

⚠️ **There is always a template.** A care context ships a `GENERAL` default, so
a doctor with no classification at all still gets Chief Complaint → Symptoms →
History → Examination → Diagnosis → Prescription → Investigation → Advice →
Follow-up (Scenario 3). Resolution never returns nothing.

---

## `packages/clinical` — the tested core (CD-10)

No Prisma, no clock, no React, no country, no specialty. Modelled on
`packages/regulatory`.

```text
descriptors.ts   parse and VALIDATE a field descriptor. Refuses a document that
                 omits its type's essential key.
registry.ts      the section type → capability table. Ordering, visibility,
                 which types may repeat, which require configuration.
resolve.ts       specificity walk over a taxonomy path → template version.
validate.ts      an encounter's section data against its descriptors.
regions.ts       visual-map region resolution and grouping.
```

⚠️ **The PI-5 lesson, transplanted verbatim.** A descriptor that says nothing
checkable must be an ERROR:

```text
{ "require": true }   ONE TYPO   →   field silently not required   (wrong)
                                 →   descriptor rejected           (right)
```

`readBoolean` cannot distinguish ABSENT from MISSPELLED — nothing can — so the
parser refuses a descriptor missing its type's essential key rather than
defaulting. **And test both cases: an ABSENT descriptor and one that EXISTS but
is empty.** Covering only the first is precisely the gap that let PI-5 ship a
permissive typo.

---

## The section registry, on the web

```text
ConsultationEngine
  reads the resolved config, maps each section to its component, renders in order

  CHIEF_COMPLAINT  SYMPTOMS  HISTORY  EXAMINATION  VISUAL_MAPPING  DIAGNOSIS
  PROCEDURE  PRESCRIPTION  INVESTIGATION  ADVICE  REFERRAL  CLINICAL_NOTES
  ATTACHMENTS  FOLLOW_UP
```

Two kinds of section, and the difference matters:

- **First-class** — Diagnosis, Prescription, Investigation, Procedure, Referral,
  Follow-up. Purpose-built components over their own tables. Configuration
  decides _whether_ and _over what vocabulary_, never their shape. §11 is
  explicit that a prescription is not a generic dynamic form.
- **Descriptor-driven** — History, Examination. Rendered by `FieldRenderer` from
  the template's descriptors into `encounter_sections.data`.

`FieldRenderer` covers: Text · TextArea · Number · Select · MultiSelect ·
RadioGroup · CheckboxGroup · Boolean · Date · DateTime · Measurement ·
SearchSelect · ClinicalSelector.

⚠️ **`SearchSelect` and `ClinicalSelector` always hit the server** (§39). No
selector loads its master into the browser. Debounced, paginated, scoped.

---

## Draft, autosave and finalization

```text
open  →  DRAFT (created or resumed)  →  autosave on a debounce  →  FINALIZE
                                                                      │
                                                              immutable (CD-2)
                                                                      │
                                                            amend → NEW ROW
```

- Autosave is a **debounced Server Action** — no browser-held token, because PHI
  never sits in `localStorage`, a cookie or a URL (CD-8).
- ⚠️ **It must not `revalidatePath`.** Revalidating per keystroke re-renders the
  consultation from the server and fights the cursor. It returns the saved
  revision and nothing else.
- Finalization is the transaction that validates every section against its
  descriptors, writes the audit row, and freezes `template_snapshot`.

---

## Historical stability (§29, Scenario 5)

`encounters` stores `template_version_id` **and** `template_snapshot` JSONB.

The FK is for reporting — "how many consultations used v3". The **snapshot** is
what renders the record. A template edited in 2029 changes nothing about a
consultation finalized in 2026, because the 2026 row carries its own copy of the
configuration and never reads the template table to display itself.
