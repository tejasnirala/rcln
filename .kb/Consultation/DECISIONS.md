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

---

## CD-14 — Two disclosure classes over one journey, and two endpoints

`GET /v1/clinical-episodes/:id` stays `appointment.read` and carries no
diagnosis. `GET /v1/patients/:id/visit-history` is `clinical.encounter.read` and
carries what was concluded at every visit.

**The tempting shape was one endpoint.** The episode detail already returns the
journey's appointments in order; adding each one's encounter summary is four
lines and one nested select, and it is what FOLLOW_UP_ARCHITECTURE §5 literally
describes.

**Why it is two.** The front desk holds `appointment.read` and no clinical code
at all — that is the whole point of the split the recall list already makes. The
desk picks a journey while booking, which is why the episode endpoint is theirs.
Widening it to carry diagnoses would hand the desk the chart through the booking
screen, silently, with no role named anywhere and nothing on screen saying it had
happened.

⚠️ **Nor is it `patient.medical_history.read`.** That is a DIFFERENT record —
allergies, conditions and long-term medications, the things true of a person
BETWEEN visits. Visit history is the sequence of consultations. A doctor holds
both and they are not the same disclosure.

---

## CD-15 — A referral lookup is not the doctor directory

`GET /v1/doctors/referral-targets?search=` sits behind
`clinical.encounter.create`, requires a two-character term, and answers a name
and a primary specialty.

**The conflict.** `encounter_referrals.doctor_profile_id` is a destination the
contract offers and a CHECK accepts, so the person writing a consultation has to
be able to reach it. But a DOCTOR deliberately does not hold
`doctor.directory.read`, and `roles.ts` says why in as many words:

> ⚠️ NO DOCTOR_DIRECTORY_READ, DELIBERATELY. […] the colleague roster is a
> personnel list, and `GET /doctors` refuses it here too.

**What resolves it is that a lookup is not an enumeration.** There is no form of
this call that answers "who works here": `search` is required, so you can confirm
the colleague you already know and cannot ask for the list. The payload is a name
and a specialty — no schedule, no contact details, no registration number, no
fees, no employment status, every one of which `DoctorSummary` carries.

⚠️ **The alternative was leaving `doctorProfileId` unreachable from the screen
that writes referrals**, which would make a supported destination usable only by
a clinic that widens DOCTOR's role — a default nobody chose.

---

## CD-16 — The previous visit says HOW it was found

`GET /v1/appointments/:id/previous-visit` answers with a `source`:

```text
PARENT_APPOINTMENT  the booking this one was made from    a fact, FK-enforced
SAME_EPISODE        the last consultation in this journey  a strong inference
MOST_RECENT         the last consultation anywhere         a convenience
```

**Why the label travels.** The three are not equally true, and a panel that
worded all of them "last visit" would tell a doctor that an unrelated visit from
March is what this follow-up follows. That is a clinical claim the software has
no basis for — the same trap `resolveEpisodeForBooking` refuses when it declines
to guess an episode for a fresh booking (CD-13).

The screen renders three different sentences and opens the panel by default only
for the first two.

⚠️ **`FINALIZED` or `AMENDED` only, and never the visit being asked about.** A
draft is what somebody is in the middle of writing, and the current visit is not
its own history.

---

## CD-17 — A map's geometry is DATA on its regions, not a drawing in the code

`visual_regions.metadata` carries each region's shape in the map's own
`view_box` coordinates, parsed by `@rcln/clinical`'s `regions.ts`. `apps/web`
holds ONE generic renderer, `VisualMapChart`, and knows nothing about teeth.

**Why not one hand-drawn SVG component per chart.** That is
`HairConsultation.tsx` wearing a different name, and CE-7's definition of done
forbids it in as many words: adding the scalp map must cost a configuration row,
not a screen. With the geometry in the rows, CE-7 is a seed.

**Why this is not "JSON controls the frontend" either.** The shape grammar is a
closed set — `RECT`, `CIRCLE`, `PATH` — with one renderer branch per member. A
document naming `polygon` is a REJECTED row, not a region that silently fails to
draw. Same line the section registry draws.

⚠️ **§22 is untouched.** The picture still carries no clinical data: a region
says WHERE it is and WHAT it is called, and every mark on it is a
`clinical_findings` row. A chart that carried its own findings could not be
queried, reported on, audited or amended.

⚠️ **And ADR-0006 is untouched.** Geometry is a DOCUMENT. There is no id inside
it — `parseRegionGeometry` refuses any key it does not know, so one could not be
smuggled in.

⚠️ **ABSENT geometry is legal; PRESENT and malformed is an ERROR.** A quadrant
groups eight teeth and has no shape of its own. `{}` is what a half-written
import produces, and reading it as "no geometry" would drop a tooth off a chart
with no message anywhere — the clinician sees the gap and assumes the patient has
no tooth there. Both cases are unit-tested, which is the PI-5 lesson stated once
more.

`renderer` and `asset_key` survive on `visual_maps` for the IMAGE_MAP case — a
photograph a clinician pins findings onto. CE-6 ships no map that uses them, and
a CHECK constraint refuses a row whose renderer and asset disagree.

---

## CD-18 — The reference configurations are PLATFORM rows, attached to a node

CE-7 ships two consultation templates — `DENTAL_HUMAN` at the `DEN` domain and
`HAIR_SCALP_HUMAN` at the `TRICHOLOGY` focus area — and two more charts,
`HUMAN_SCALP` and `HUMAN_BODY`. All four are seed data.

**Why the platform and not a clinic's own.** The claim CE-7 was asked to prove
is that a specialty consultation is a DOCUMENT. A claim demonstrated only by a
fixture is a claim about the test suite; shipped in the seed it is a claim about
the product, and a dentist who registers today gets an odontogram without
configuring anything.

**Why the DOMAIN for dentistry and the FOCUS AREA for hair.** Every dental
specialty conducts a consultation shaped like the dental one, so it attaches at
`DEN` and orthodontics, endodontics and the rest inherit it. Most of dermatology
does not grade a Norwood scale, so the hair template attaches at `TRICHOLOGY`
and a dermatologist treating acne is untouched. Specificity only ever walks UP:
a template placed too high cannot be declined by the people below it.

⚠️ **A NAMED-BUT-MISSING SPECIALTY IS FATAL IN THE SEED, and it is the one place
the seed's usual asymmetry reverses.** A missing scope on a clinical term makes
it sort lower; a missing node here does not make a template apply LESS, it makes
it apply to EVERYTHING — `specialty_id` NULL is the care-context default, so the
dentistry template would land at depth 0 beside `GENERAL_HUMAN` and win the tie
on its code. Every human consultation in the product would silently acquire an
odontogram.

⚠️ **BOTH CHARTS ARE `required: false`.** A required chart refuses finalization
with nothing marked on it (CE-6), and a mouth with nothing wrong with it is a
real consultation — common, at a check-up. A clinic that wants the chart
compulsory sets it on its own template; the platform does not refuse to sign a
healthy patient's record.

**And the three charts are deliberately three different shapes of document.**
`HUMAN_DENTAL` is rectangles grouped four ways with computed label centres;
`HUMAN_SCALP` is paths, entirely flat, every label anchored by hand;
`HUMAN_BODY` is rectangles and a circle grouped two ways. `labelAnchorOf`
returns nothing for a path, so a scalp zone that omitted its anchor would draw
correctly and be captioned nowhere — shipping the flat path map is what keeps
that branch honest.
