# Consultation Engine — decisions

Numbered `CD-n` so later sessions and code comments can cite them. Each records
what was decided, and the reasoning that would otherwise be re-litigated.

---

## CD-1 — The table is `encounters`, and `appointment_id` is NULLABLE

**Brief said:** "a consultation belongs to an appointment."

**Decided:** the table is `encounters`; `appointment_id` is nullable;
"consultation" stays the word on screen and in the API path.

**Why.** The existing design disagrees with the brief and is right:

> A BOOKING IS NOT A VISIT. `appointments` is the intention; `encounters` is the
> clinical event. A walk-in has an encounter with no appointment and a no-show
> has an appointment with no encounter, so folding them into one table loses
> both facts. — `scheduling.prisma` header

Naming it `consultations` would also create a second answer to "what is a
clinical visit" against permission codes already named `clinical.encounter.*`,
and `appointments` already declares `@@unique([organizationId, id])` as the
composite-FK target an encounter attaches to.

Nothing in the brief's behaviour is lost. `GET /appointments/:id/consultation-config`
keeps its name because that is what a doctor calls it.

---

## CD-2 — Finalized encounters are immutable; an amendment is a NEW ROW

Not a mutation, and not a revision side-table.

```text
FINALIZED  ──amend──▶  new encounters row, amends_encounter_id = the original
                       original moves to AMENDED
```

**Why.** Append-only is how `audit_logs` and `stock_ledger` already work here,
and it is the strongest available reading of §38's "finalized consultations
cannot be silently overwritten": the superseded record is untouched at the
storage level, not merely by policy. A revision table leaves the live row
mutable and relies on every writer remembering to snapshot first.

A partial unique index enforces at most one non-superseded encounter per
appointment. `clinical.encounter.amend` is a separate code (CD-7).

---

## CD-3 — Care context is a taxonomy ROOT, not a new column

`HUMAN` and `VETERINARY` become `TaxonomyNodeType.CARE_CONTEXT` roots; the
seeded `DOMAIN` roots (Medical, Dental, …) re-parent under `HUMAN`.

**Why it is safe.** Taxonomy codes are flat by design —
`INTERVENTIONAL_CARDIOLOGY`, never a path — and the seed says why:

> A path-encoded code becomes A LIE THE MOMENT A NODE MOVES. […] The path
> already has a home: it is `parent_id`.

Re-parenting is therefore a `parent_id` update. Existing `doctor_specialties`
rows point at leaves and are unaffected.

⚠️ **The cost:** `specialties_sibling_name_key` is
`UNIQUE (organization_id, parent_id, lower(name)) NULLS NOT DISTINCT`. During
the re-parent every moved root must not transiently collide with a sibling. The
seed already learned this the hard way — its two-pass insert was removed for
exactly this reason.

---

## CD-4 — Care subject: one column, and one thin table

`patients.subject_type` (`HUMAN` | `ANIMAL`, default `HUMAN`) plus a nullable
`animal_profiles` row for species/breed/sex/weight/guardian.

The consultation engine reads `subject_type` **only** to resolve the care
context. No other code branches on it.

**Why so little.** §4 asks that the architecture not make human-only
assumptions; §42.7 forbids building veterinary functionality now. A column and
an empty extension table satisfy the first without doing the second.

---

## CD-5 — ONE `clinical_master_items` table with a `kind` discriminator

Not five tables. Kinds: `SYMPTOM`, `DIAGNOSIS`, `PROCEDURE`, `INVESTIGATION`,
`ADVICE`, `HISTORY_ITEM`, `FINDING_TYPE`.

**Why.** It is the house pattern. `products` is one table with a `ProductType`
discriminator over 12+ types (PI-ADR-001), and `specialties` deliberately
collapsed a specialties / sub-specialties / specialization-map triple into one
self-referencing master.

Platform rows (`organization_id NULL`) plus tenant extension, `parent_id` for
grouping.

⚠️ **The RLS policy is `specialties`', NOT `files`'.** `files` permits a NULL
`organization_id` in its `WITH CHECK`, which here would let any clinic INSERT a
platform-wide diagnosis visible to every tenant on the platform. Read
permissive, write strict.

Two satellites:

- **`clinical_master_codings`** — `(item, system, code)`. ICD-10, SNOMED CT,
  LOINC and a clinic's own codes coexist. §9's "not dependent on a single coding
  system" holds because there is **no coding column on the item at all**.
- **`clinical_master_scopes`** — `(item × specialty node)`. Plus
  **`product_clinical_scopes`** for medicines.

⚠️ **Scope RANKS, it never FILTERS.** §11 and §34 both say so: a medicine
relevant to several specialties must not be hidden from a doctor because nobody
tagged it. Scoped items sort first; unscoped items still appear.

---

## CD-6 — Templates are versioned JSONB documents

Blessed explicitly by invariant 5:

> Per-specialty variation goes through versioned form templates — JSONB as a
> document, never as a foreign key.

- `consultation_templates` — code, name, scope, the specialty node it applies to
- `consultation_template_versions` — `version`, `definition` JSONB, `DRAFT` /
  `PUBLISHED` / `RETIRED`

⚠️ **The `definition` holds section types, ordering, labels, field descriptors,
map codes and SCOPE codes — never master-item ids.** Clinical vocabulary is
resolved by scope at render time. Ids in JSONB is ADR-0006 exactly.

`encounters` stores **both** `template_version_id` and a frozen
`template_snapshot` JSONB. The FK is for reporting; the snapshot is what renders
a five-year-old record after the template has moved on (§29, Scenario 5).

⚠️ **A published version is immutable.** Editing a live template is publishing a
new version. Same argument as a signed-off rule pack in PI-5: a finalized
consultation's snapshot is a statement about the configuration that existed when
it was made.

---

## CD-7 — Reuse `lab.order.*`; three new codes for what nothing covers

**Reused.** `lab.order.read` / `lab.order.create` exist and gate nothing. An
investigation ordered from a consultation _is_ a lab order intent. This follows
the precedent set by `clinical-taxonomy.routes.ts`, which deliberately reused
`DOCTOR_MASTER_MANAGE` rather than invent `taxonomy.*` codes and

> a second answer to "who may curate the clinical masters" and a role matrix
> that has to be kept in step with itself.

`clinical.master.manage` already exists and covers the masters.

**New:**

| Code                         | Why nothing existing covers it               |
| ---------------------------- | -------------------------------------------- |
| `clinical.encounter.amend`   | Amending a signed record is not creating one |
| `clinical.template.manage`   | Configuring consultation templates           |
| `clinical.visual_map.manage` | Configuring maps and regions                 |

⚠️ **`clinical.encounter.amend` must be stripped from `ORG_OWNER` and
`ORG_ADMIN` by name**, exactly as the other authoring codes are. They are
"everything except" roles; a new authoring code joins them silently otherwise
(invariant 7).

---

## CD-8 — Autosave goes through a Server Action, never a browser-held token

`apps/web/src/lib/api.ts` is server-only by construction. PHI must never sit in
`localStorage`, a cookie or a URL. So the draft autosave is a **debounced Server
Action call** from the client component — a `useRef` timer plus `useTransition`,
matching the `useActionState` pattern used across `components/tenant/`.

**No new dependency.** Debounce is ~15 lines; a form library or a data-fetching
library for this would be a dependency added for one screen.

⚠️ **The autosave must not `revalidatePath`.** Revalidating on every keystroke
re-renders the whole consultation from the server and fights the user's cursor.
It returns the saved revision and nothing else.

---

## CD-9 — PHI additions and the enum trap

- `DataAccessResource` gains `ENCOUNTER` and `CLINICAL_EPISODE`.
  (`PRESCRIPTION`, `MEDICAL_HISTORY` and `VITALS` already exist.)
- `DocumentType` gains `CLINICAL_ATTACHMENT`.
- `NumberSequenceType` gains `ENCOUNTER`.

⚠️ **All four types already exist**, so `ALTER TYPE … ADD VALUE` applies: a
CHECK constraint naming any new member needs a **second** migration.

---

## CD-10 — The engine's logic lives in `packages/clinical`; React is not unit-tested

`apps/web` has no test toolchain, and standing one up is its own task — the jest
setup added once was the only test in the workspace and it broke `typecheck` for
everything.

So the testable logic does not live in components. **`packages/clinical`** — no
Prisma, no clock, no React, modelled on `packages/regulatory`:

- template resolution (specialty node → template → version)
- the section registry, its ordering and visibility rules
- field-descriptor parsing and validation
- visual-map region resolution

Components become thin renderers over unit-tested functions. Anything in a
component worth a test is in the wrong place.

⚠️ **PI-5's `parameters.ts` lesson applies verbatim.** A descriptor that says
nothing checkable must be an ERROR, not a permissive default:
`{ "require": true }` for `{ "required": true }` is one typo, and a validator
reading an absent key as "not required" silently switches off a mandatory field
on a clinical form. **And the gap that let PI-5 ship that bug: every test
covered an ABSENT descriptor and none covered one that EXISTS but is empty. Add
both.**

---

## CD-11 — FDI two-digit dental notation

`11`–`18`, `21`–`28`, `31`–`38`, `41`–`48`. Region codes are `TOOTH_11` …
`TOOTH_48`. No display-notation setting ships in CE-6; Universal or Palmer later
is a rendering concern over the same stored codes, which is why the codes are
FDI rather than an index.

---

## CD-12 — `parent_appointment_id` keeps its name

The brief offered `follow_up_of_appointment_id` "or the equivalent naming
convention already used in the project". The project's is `parentAppointmentId`
and it is load-bearing in billing, contracts, the web detail page and the tests.
Renaming changes no behaviour and touches everything.

Full reasoning in [FOLLOW_UP_ARCHITECTURE.md](FOLLOW_UP_ARCHITECTURE.md).

---

## CD-13 — A follow-up RECOMMENDATION is not an APPOINTMENT

`encounter_follow_up_recommendations` holds what the doctor advised;
`appointments` holds what was booked; `fulfilled_by_appointment_id` links them
when and if the patient books.

**Why it earns a table.** The clinic's real question is _"who was told to come
back and hasn't?"_ — unanswerable if a recommendation and a booking are the same
row, because an unbooked recommendation would not exist. And what the doctor
advised stays clinically true whether or not the patient complies; deriving it
from a booking means a patient who never returns has no record of being told to.

⚠️ **A fresh booking opens a NEW episode — never "the patient's most recent open
one".** Guessing that a sore throat in March belongs to January's diabetes
journey is a clinical claim the software has no basis for.
