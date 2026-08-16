# Changelog

One entry per phase, in the eight-point shape the brief asks for: what was
implemented · files changed · schema changes · APIs · frontend · tests ·
remaining work · architectural decisions.

---

## CE-0 — Repository analysis · 2026-08-14

**Implemented.** Nothing. Analysis only, as the brief requires.

**Files.** This directory: README, MASTER_PLAN, DECISIONS, SCHEMA,
EXISTING_ARCHITECTURE, FOLLOW_UP_ARCHITECTURE, IMPLEMENTATION_TRACKER,
CHANGELOG, NEXT_SESSION.

**Decisions.** CD-1 … CD-13. The four that change the brief:

- **CD-1** the table is `encounters` with a NULLABLE `appointment_id`, because a
  walk-in has a clinical event and no booking.
- **CD-5** one `clinical_master_items` table with a `kind` discriminator, the
  house pattern, rather than five master tables.
- **CD-12** `parent_appointment_id` keeps its name; it already implements the
  required A→B→C chain.
- **CD-13** a follow-up recommendation is not an appointment, and the split is
  what makes a recall list possible.

**Remaining.** All of CE-1…CE-8.

---

## CE-1 — clinical foundation · 2026-08-14 · COMPLETE

**Implemented.** The clinical vocabulary and the treatment journey, end to end
at the data layer. Booking now opens or joins an episode.

**Schema.** `clinical.prisma` — 6 models, 5 enums. Altered: `appointments`
(+`clinical_episode_id` NOT NULL), `patients` (+`subject_type`),
`TaxonomyNodeType` (+`CARE_CONTEXT`), `DataAccessResource` (+`ENCOUNTER`,
`+CLINICAL_EPISODE`), `NumberSequenceType` (+`CLINICAL_EPISODE`).

**Migrations.** Five, applied:

| Migration                                  | Why separate                                          |
| ------------------------------------------ | ----------------------------------------------------- |
| `…090000_clinical_enum_members`            | `ALTER TYPE … ADD VALUE` cannot be used same-txn      |
| `…091000_clinical_masters`                 | 5 tables + NULLS NOT DISTINCT ×4, trigram, RLS        |
| `…092000_clinical_episodes`                | table + column + **backfill** + SET NOT NULL, one txn |
| `…093000_follow_up_recommendations`        | 3-legged CHECK, partial uniques, recall index         |
| `…094000_clinical_episode_number_sequence` | the enum trap again; migration 1 was checksummed      |

**APIs.** No new routes yet. `POST /v1/appointments` accepts an optional
`clinicalEpisodeId`; `AppointmentDetail` returns the episode id and code.

**Tests.** No new suites yet. Two existing ones repaired — see below.

**Verified.** `prisma validate` · `db:rls:check` green at **96** (was 89) ·
typecheck green across api, web, worker, db, contracts · eslint clean on touched
files · `appointments` (51), `appointment-billing` (22) and
`tenant-isolation/appointments` (14) all green.

**Decisions.** CD-1…CD-13 (see DECISIONS.md). Two learned during the work:

⚠️ **The backfill ran against data that could not exercise it.** All five seeded
appointments are chain roots, so the recursive CTE terminated after its base
case and reported success having recursed zero times. Proven separately on a
synthetic 4-deep chain in a rolled-back transaction: every link resolved to the
ROOT's episode. **This is PI-5 decision 6 verbatim — a test that could not fail
looking exactly like one that could.** A real test still owes.

⚠️ **A NOT NULL column silently defused a tenant-isolation test.**
`rejects booking into another clinic's branch` began failing on the new not-null
constraint, which fires BEFORE any policy is evaluated. It would have been just
as easy to "fix" by loosening the matcher, and the test would then have been
green while proving nothing about the branch boundary. The fixture now supplies
a legitimate episode so the branch is the only thing wrong with the row.

**Remaining in CE-1.** Master and episode read/write services, all routes,
`clinical-data` search endpoints, the seed (care contexts, re-parent, dentistry

- hair masters), web screens, and the CE-1 test suites.

---

## CE-2 — templates and the configuration resolver · 2026-08-14 · COMPLETE

**Implemented.** The configuration layer, end to end: a pure engine package, two
versioned tables, the resolver that turns an appointment into a screen
specification, an admin surface, and the platform's default consultation.

**`packages/clinical`** (CD-10) — no Prisma, no clock, no React, no country, no
specialty; modelled on `@rcln/regulatory`.

| Module           | What it decides                                                                             |
| ---------------- | ------------------------------------------------------------------------------------------- |
| `types.ts`       | the two closed sets — 14 section types, 13 field types                                      |
| `registry.ts`    | what each section IS: descriptor-driven, repeatable, its vocabulary, whether it needs a map |
| `descriptors.ts` | a field descriptor, parsed and refused                                                      |
| `definition.ts`  | the whole document, checked against the registry                                            |
| `resolve.ts`     | the specificity walk over a taxonomy path                                                   |

**Schema.** `clinical.prisma` — `ConsultationTemplate`,
`ConsultationTemplateVersion`, `ConsultationTemplateStatus`. Back-relations on
`Organization`, `User` and `Specialty` (twice — care context and node).

**Migration.** One, applied — `20260820090000_consultation_templates`. **No enum
split needed**, and that is the one place CD-9's trap does not bite: the status
type is BRAND NEW rather than an `ALTER TYPE … ADD VALUE`, so the CHECK
constraints may name its members in the same transaction.

Hand-written SQL: 2 × NULLS NOT DISTINCT rewrites · one active template per
(org, context, node) · one DRAFT and one PUBLISHED per template · the
status/dates CHECK · platform-extensible RLS + `platform_rows_immutable` ·
`specialty_visible` over BOTH taxonomy pointers, with the NULL branch.

**APIs.** `/v1/consultation-templates` (list · create · read · update),
`/versions` (draft · save · publish · discard), all behind
`clinical.template.manage`. Plus `GET /v1/appointments/:id/consultation-config`
behind `clinical.encounter.read` — the resolver, and the only place that decides
which template applies.

**Permissions.** One new code, `clinical.template.manage`. Deliberately NOT in
`CLINICAL_AUTHORING`: configuring a consultation is administration, not
practising, and a DOCTOR neither holds it nor needs it.

**Frontend.** `/consultation-templates` — the list, with an "applies to" column
that says which level a template is attached to, and a detail screen with a
version rail and the document. The document is edited as text on purpose: the
server returns a sentence naming the failing section and key, and a form builder
would have to teach the browser the grammar a second time.

**Seed.** `GENERAL_HUMAN` and `GENERAL_VET`, published v1, parsed by the same
parser the API uses before either is written.

**Tests.** 74 unit (`packages/clinical`) · 20 integration · 13 isolation.

**Verified — validation ran once, at the end, in CLAUDE.md's order.** Lint clean
across all 29 tasks · typecheck green in clinical, contracts, permissions, db,
api, web, worker · `db:rls:check` green at **98** (was 96) · 74 + 527 + ~1000
tests green, integration run in batches because the whole suite OOMs the
container · seed applied · nothing opened in a browser.

**Decisions.** CD-6 and CD-10 as written. Three learned during the work:

⚠️ **A COMPOSITE PRISMA RELATION SILENTLY RETURNS NOTHING FOR A PLATFORM ROW.**
`ConsultationTemplateVersion.template` is (organization_id, template_id) ->
(organization_id, id). For a platform template `organization_id` is NULL, so
selecting the `versions` relation compiles to `organization_id = NULL` — which is
NULL, not true. The relation came back EMPTY for exactly the rows every clinic
depends on. Nothing errored: the template was found, appeared never to have been
published, and every unclassified doctor on the platform got "no published
template applies". **Load the children by `template_id` and let RLS scope them,
as `master.service.ts` already does for its codings.** This is a general trap for
every platform-extensible parent, and CE-3's `encounters` will meet it again.

⚠️ **A PARENTLESS PLATFORM FIXTURE BROKE AN UNRELATED SUITE ON THE NEXT RUN.**
The isolation harness deletes its organizations; a platform row does not cascade,
so a test specialty inserted with no parent persisted as a taxonomy ROOT and
failed `clinical-taxonomy`'s "serves the care contexts as roots". The fixture now
parents it. **Any platform row a test inserts outlives the test.**

⚠️ **THE PI-5 GAP, CLOSED IN BOTH HALVES.** Every descriptor test covers the key
that is ABSENT _and_ the key that EXISTS but is empty — `"options": []` looks
configured, renders a dropdown a clinician reads as a loading failure, and is the
shape PI-5's tests never took. Section `visible` and `required`, and every field's
`required`, are mandatory rather than defaulted, and an unknown key is refused by
NAME so a typo is a sentence rather than a silent omission.

**Remaining.** CE-3…CE-8. Nothing in CE-2's scope is outstanding.

---

## CE-3 — the encounter and its lifecycle

**Schema.** `encounters` and `encounter_sections`, both org + branch scoped and
both PHI in every text column. Three new enums (`EncounterStatus`,
`ClinicalDurationUnit`, `ClinicalOnset`), plus `ConsultationSectionType` as a
Postgres enum whose parity with `@rcln/clinical`'s union is asserted at compile
time in `services/clinical/sections.ts`. Two migrations: the `ENCOUNTER` counter
alone (CD-9), then the tables. `encounter_follow_up_recommendations.encounter_id`
became NOT NULL — the last deploy in which that costs no backfill, because CE-4
is what fills the table.

**RLS.** 98 → **100**. Both tables in both loops; `branch_id` is NOT NULL on
both, so the branch boundary is absolute — the opposite call from
`clinical_episodes`, because a journey follows the patient and a visit belongs to
the place it happened at.

**Permissions.** `clinical.encounter.amend`, added to `CLINICAL_AUTHORING` and so
stripped from ORG_OWNER and ORG_ADMIN by name. Its own code rather than part of
`create`, because a clinic may reasonably let a junior write a first consultation
and not restate a signed one.

**Engine.** `validate.ts` in `packages/clinical` — the answer side of the grammar,
run at finalization against the encounter's frozen snapshot and never at
autosave. 74 → **89 unit tests**.

**Backend.** `encounter.service.ts`: open-or-resume, autosave, finalize, amend,
cancel. `resolveConfiguration` and `sectionConfigs` were lifted out of CE-2's
resolver so a stored snapshot renders through exactly the code the live screen
does. Routes at `/v1/encounters/*`, plus `GET /v1/appointments/:id/encounter` —
the reader's door, because opening a draft is an act of authorship.

**Frontend.** `ConsultationEngine` over the section registry, `FieldRenderer`
across all thirteen field types, and a debounced Server Action that deliberately
does not `revalidatePath`.

**Tests.** 89 unit · 12 integration · 10 isolation, plus three repaired CE-1
fixtures.

**Verified — validation ran once, at the end, in CLAUDE.md's order.** Lint clean
(two pre-existing warnings, both `window.location.assign` on other screens) ·
typecheck green in clinical, contracts, permissions, db, api, web · 89 + 193 +
344 + 864 integration tests green, run in batches · `db:rls:check` green at
**100** · seed applied twice, the second time because the first ran against a
stale `packages/permissions/dist` · nothing opened in a browser.

**Decisions.** CD-1, CD-2 and CD-8 as written. Two learned during the work:

⚠️ **THE COMPOSITE FK IS IMPOSSIBLE ON `encounters.template_id`, AND THE POLICY
IS WHAT REPLACES IT.** ADR-0004 wants (organization_id, template_id) ->
(organization_id, id); the encounter's `organization_id` is NOT NULL, a platform
template's is NULL, so that FK would refuse the most ordinary consultation on the
platform — the GENERAL template an unclassified doctor resolves to. The pointers
are therefore plain FKs with a RESTRICTIVE `template_visible` policy, the same
shape `batches` uses for `product_id`. **A plain FK into a platform-extensible
table always needs its `*_visible` policy; the isolation suite asserts it
directly.**

⚠️ **A NOT NULL ON AN EMPTY TABLE IS FREE EXACTLY ONCE.** `encounter_id` had been
nullable since CE-1 with no writer at all, so tightening it needed no backfill —
and the only cost was three CE-1 isolation fixtures that inserted a
recommendation with no encounter. Waiting until CE-4 fills the table would have
made the same change a migration with live PHI in it.

**Remaining.** CE-4…CE-8. The nine first-class sections render a line naming what
they are and when they arrive, rather than an empty box.

---

## CE-4 — clinical content sections

**Schema.** Eight tables, eleven new enums, and one member added to an existing
one. `encounter_symptoms`, `_diagnoses`, `_procedures`, `_prescriptions`,
`_investigations`, `_advice`, `_referrals`, `_attachments` — all org + branch
scoped, all PHI, all carrying `organization_id` AND `branch_id` themselves rather
than inheriting through the encounter. Two migrations: the
`DocumentType.CLINICAL_ATTACHMENT` member alone (CD-9), then the tables with
fourteen CHECKs, the `one_primary` partial unique, and the two `item_id` NOT
NULLs Prisma cannot express.

**RLS.** 100 → **108** protected tables. All eight in both loops, plus seven
`*_visible` policies: `item_visible` on the five tables that cite a clinical
word, `product_visible` on prescriptions, `specialty_visible` on referrals.

**Contracts.** `encounter-content.ts`, and `content` on `encounterDetail`.
`fulfilsRecommendationId` joins the follow-up booking request.

**Permissions.** **None added** (CD-7). Recording a diagnosis IS writing up the
consultation, so every content writer is `clinical.encounter.create`; the recall
list is `appointment.read` and `appointment.update`, because the front desk works
it and holds no clinical code at all.

**Engine.** `requiredContentSections` in `packages/clinical`. 89 → **92 unit
tests**.

**Backend.** `encounter-content.service.ts` — three verbs over eight
collections, one `PUT` over the follow-up plan, and `copyContentToAmendment`.
`recall.service.ts` for the outstanding-recall window. Twenty-four collection
routes generated from one table, because twenty-seven hand-written near-identical
handlers is twenty-seven places to forget `validate`.

**Frontend.** Nine section editors in `consultation-content.tsx`, all over
server-backed selectors that never load their master. `PENDING_SECTIONS` in the
engine drops from ten entries to one — VISUAL_MAPPING, which is CE-6.

**Tests.** 92 unit · 31 integration · 15 isolation, plus one repaired CE-3 case.

**Verified — validation ran once, at the end, in CLAUDE.md's order.** Lint clean
(two pre-existing `window.location.assign` warnings on other screens) ·
typecheck green in clinical, contracts, db, api, web · 92 + 172 unit, 193 api
unit, 359 isolation and 895 integration tests green, run in batches ·
`db:rls:check` green at **108** · nothing opened in a browser.

**Decisions.** CD-5, CD-6 and CD-13 as written. Three learned during the work:

⚠️ **`SetNull` IS UNAVAILABLE ON ANY COMPOSITE FK THAT INCLUDES
`organization_id`.** `encounter_procedures.diagnosis_id` wanted it — removing a
diagnosis should leave the procedure standing and drop only the claim about why —
and Postgres refuses, because the column is NOT NULL and it cannot null half a
pair. So the FK is `Restrict` and the service unlinks first. The same constraint
`appointments.parent_appointment_id` has lived under since PI, restated because
it is invisible until Prisma warns about it.

⚠️ **AN AMENDMENT THAT COPIES ROWS MUST REMAP THE LINKS BETWEEN THEM.** A
straight copy leaves every procedure on the amendment citing a diagnosis on the
ORIGINAL — and the composite FK permits it, because it only ever said "same
tenant". The failure renders as a procedure treating a diagnosis that is not on
this consultation, and nothing in the database objects. `copyContentToAmendment`
builds the old-id → new-id map, and the integration suite asserts the shape.

⚠️ **A `required` FLAG NOTHING COUNTS IS A FLAG THAT IS NOT ENFORCED.** The
seeded `GENERAL` template has marked FOLLOW_UP required since CE-2, and it did
nothing, because finalization only ever validated the descriptor-driven sections.
CE-4 split the check in two — the engine answers WHICH sections a template
requires and the service counts the rows, because `@rcln/clinical` holds no
Prisma client and never will (CD-10) — and the entire cost of turning the flag on
was one CE-3 test that had never stated a follow-up plan.

**Remaining.** CE-5…CE-8. The recall list has an endpoint and no screen, and the
follow-up booking form still does not exist in `apps/web` at all.

---

## CE-6 — the visual mapping engine and `HUMAN_DENTAL`

**Branch:** `feat/consultation-engine` · **Validation ran once, at the end**, in
CLAUDE.md's order: everything written, then lint + format, then typecheck only,
then the tests. Nothing has been opened in a browser.

**Shipped.** Three tables — `visual_maps` and `visual_regions`
(platform-extensible, no PHI) and `clinical_findings` (org + branch scoped, PHI)
— plus the `encounter_procedures.visual_region_id` column CE-4 deferred until
the table it points at existed. One migration; `VisualMapRenderer` is a NEW type,
so CD-9's enum trap does not apply. `db:rls:check` green at **111** (was 108).

`regions.ts` in `@rcln/clinical` is the geometry grammar (CD-17): **117 unit
tests**, up from 92. `visual-map.service.ts` is the admin surface behind
`clinical.visual_map.manage`; findings are the ninth collection on the CE-4
route table, behind `clinical.encounter.create`, because drawing on a chart IS
writing up the consultation (CD-7). The seed ships the 32-tooth FDI odontogram
with its four quadrants. `VisualMapChart` in `apps/web` is one generic renderer
with no tooth in it, and `PENDING_SECTIONS` is now empty — every member of
`ConsultationSectionType` has a component over a real table.

**25 integration tests + 14 isolation tests.**

### What this phase actually learned

⚠️ **`VISUAL_MAPPING` WAS SILENTLY SIGNABLE, AND CLOSING IT WAS THE POINT OF THE
PHASE.** `countFor` had a `default: return 1` — "there is something there" —
because the section was required-able with no table behind it. A template that
required a chart could be finalized with nothing drawn on it, and nothing said
so. `countFor` is now exhaustive over `ConsultationSectionType` with no
permissive default, so a section type added to the engine and forgotten here is a
type error rather than a signable blank.

⚠️ **A COMPOSITE RELATION IS INVISIBLE TO PRISMA'S `_count` ON A PLATFORM ROW.**
`visual_regions.map` joins on `(organization_id, map_id)`, and on a platform row
both sides are NULL — so the count Prisma writes is `NULL = NULL`, which is never
true. The odontogram reported **0 regions** to every clinic while its detail page
listed all 36. Counted by `map_id` alone instead. This is the CE-2 trap in its
third disguise; `master.service.ts` already loads its codings the same way.

⚠️ **`prisma migrate dev` WANTED TO DROP NOT NULL FROM TWO CE-4 COLUMNS.**
`encounter_procedures.item_id` and `encounter_investigations.item_id` are NOT
NULL because CE-4's migration said so; Prisma believes them nullable only because
a required relation may not include a nullable scalar. Both generated lines were
deleted by hand. Left in, they would have quietly made a free-text procedure
representable — the exact decision SCHEMA.md records CE-4 taking.

⚠️ **THE PI-5 LESSON HAS A NEW SHAPE HERE, AND IT IS THE ABSENT/EMPTY PAIR
AGAIN.** Geometry that is ABSENT means "this region groups and is not drawn" — a
quadrant is a real region with eight children and no shape. Geometry that is
PRESENT and empty is a REJECTED row, because `{}` is what a half-written import
produces and reading it as "no geometry" drops a tooth off a chart with no
message anywhere. Both are unit-tested and both are integration-tested.

⚠️ **A NEW WORKSPACE DEPENDENCY: `apps/web` NOW USES `@rcln/clinical`.** Called
out because CLAUDE.md requires it. The alternative was a second geometry parser
in the browser, which is precisely the "two grammars that drift" failure the
package exists to prevent — and the web already imports the engine's TYPES
through `@rcln/contracts`, so this is the same boundary, honestly drawn.

**Remaining.** CE-7 and CE-8. The chart editor edits geometry as JSON; no
template ships with a chart on it; `IMAGE_MAP` has an enum member and no map.

---

## CE-7 — The reference configurations · 2026-08-16

**Implemented.** `HUMAN_SCALP` and `HUMAN_BODY`, and the dentistry and hair &
scalp templates that cite them. The phase whose definition of done was a
negative: **no `HairConsultation.tsx` exists, and none was needed.**

**Files.** Two seed data files, one seeder, two web components, one new
integration suite. That is the whole of it, and the shortness IS the result.

**Schema.** **None.** No model, no migration, no policy. `db:rls:check`
unchanged at **111**.

**Seed — the charts.** Three maps now, **70 regions**. `HUMAN_SCALP` is the
scalp from above in eight zones — hairline, frontal, both temples, mid-scalp,
vertex, occiput and the nape as the donor area — drawn as PATHs generated from
one ellipse, entirely FLAT, and every zone anchors its own label because
`labelAnchorOf` has no centre to compute for a path. `HUMAN_BODY` is two
silhouettes of twelve places each under two grouping views, mirrored so the
patient's left is their left on both, and belongs to no specialty at all.

**Seed — the templates.** `DENTAL_HUMAN` at the `DEN` domain and
`HAIR_SCALP_HUMAN` at the `TRICHOLOGY` focus area, both published, both citing
their chart by CODE (CD-6). The seeder learned `specialtyCode`, and a
named-but-missing node is FATAL — see CD-18 for why that asymmetry runs the
opposite way to the vocabulary seed's.

**APIs · contracts · permissions · engine.** **Nothing added, in any of them.**

**Frontend.** One control: a "Where" on a recorded procedure, built from the
regions of the template's own resolved maps and rendered only when the
consultation has a chart. `encounter_procedures.visual_region_id` has had a
column, a contract and a service since CE-6 and no way to fill it in; this is
that way, and the procedure row now reads "Root canal treatment — 36". The list
is derived from the CONFIGURATION rather than from a lookup of its own, because
a screen that fetched "all regions" would offer a dentist the scalp zones.

**Tests.** 12 integration, in `reference-configurations.test.ts`. The suite is
one doctor reclassified three times — `DEN`, then `TRICHOLOGY`, then nothing —
getting three genuinely different consultations out of the same engine, plus a
dental consultation end to end: a finding on tooth 36, the procedure recorded
against that tooth, signed. And a second consultation signed with the chart
untouched, because the reference charts are `required: false` on purpose.

**Verified — validation ran once, at the end, in CLAUDE.md's order.** Lint clean
(the same two pre-existing `window.location.assign` warnings on other screens) ·
`pnpm format` · typecheck green in clinical, db, api and web, run per package ·
117 clinical unit, 193 api unit, 70 regulatory unit, 378 isolation and 948
integration tests green, run in batches · `db:rls:check` green at **111** ·
nothing opened in a browser, though both new maps were rendered from the seeded
rows to check the geometry before it shipped.

**Decisions.** CD-18 — the reference configurations are platform rows attached
to a node; dentistry at the domain and hair at the focus area; both charts
optional; a missing specialty code fatal.

**Remaining.** CE-8 — hardening. Plus the standing three: the chart editor edits
geometry as JSON, `IMAGE_MAP` has an enum member and no map, and nothing has
been opened in a browser.

---

## CE-8 — Hardening · 2026-08-16

**Implemented.** The last phase, and deliberately the smallest: validation
tightened where it was permissive, a permission audit that reads the routers
instead of a list, the recall list's scan bounded, and the whole journey walked
end to end for the first time. No new endpoint, no new permission code, no new
table.

**Files.** `packages/clinical/src/validate.ts` · `encounter.service.ts` ·
`auth.middleware.ts` · `apps/web/src/lib/format.ts` and the four files that
thread a zone into the consultation · two new test files · one migration.

**Schema.** No model, no column, no policy. One hand-written **partial index**,
`encounter_follow_up_recommendations_outstanding`. `db:rls:check` unchanged at
**111**.

**Validation — three holes, closed.**

- **A DATE was any string, and a DATETIME was any string.** `banana` and
  `2026-02-31` both signed cleanly onto a clinical record, and — worse —
  `datetime-local` writes `2026-08-16T14:30` with no zone in it, so a DATETIME
  answer meant 14:30 wherever whoever read it next happened to be. A DATE is now
  a real calendar day and a DATETIME is an ISO instant with a `Z` (invariant 6),
  refused at signing with a sentence naming which.
- **The same choice twice** in a MULTI_SELECT is refused rather than
  deduplicated. Collapsing it silently would be the software editing what a
  clinician wrote, after the fact.
- **`documentProblems` — the shape of a stored document, checked at AUTOSAVE.**
  `encounter_sections.data` is an open record on the wire by necessity, which
  left an unbounded JSONB write behind a control that fires every few seconds in
  the densest PHI table in the product. Scalars and lists of scalars only, 200
  answers, 20 000 characters, 200 entries, 64 KB — bounds far above any real
  consultation, and the one rule in this package that does not wait for the
  signature, because what it refuses is not an incomplete answer but a document
  nothing could ever render.

**Lifecycle.** `openEncounter` was idempotent through a read and a partial
unique index, and the LOST race — two tabs, one visit — reached the doctor as a
**409 on the one screen they cannot proceed without**, for a consultation that
exists and is theirs. It now re-reads and answers with it, outside the aborted
transaction, re-checking branch scope and writing the disclosure row. Three
callers now share `liveEncounterFor`, so "the live consultation of this visit"
is asked once.

**Permissions — an audit, not a list.** `authorize()` stamps its codes onto the
handler it returns, and `tests/unit/route-gates.test.ts` walks the Express stack
of all four clinical routers: every route gated, every GET behind
`clinical.encounter.read`, every one of the 30 writes behind an authoring code,
the chart's marks on `encounter.create` rather than `visual_map.manage`, and
neither manage surface writing behind an encounter code. `roles.test.ts` now
enumerates every `clinical.*` code rather than restating five of them — which
immediately caught that `ENCOUNTER_AMEND` had never joined the list it belongs
to.

**Search performance.** The recall list's three outstanding windows filter and
sort on a due date computed from two different shapes, and that expression
cannot be indexed —`timezone(text, timestamptz)` is STABLE. So the SET it runs
over is what shrinks: a partial index over the four predicates every outstanding
window shares. Verified with `EXPLAIN`, not asserted: the planner uses it.

**Frontend.** `FieldRenderer` takes a required `timeZone` and converts a
DATETIME on both edges — the control speaks the branch's wall clock, the record
stores the instant. `clinicInstantOf` and `clinicInputValueOf` join
`lib/format.ts`, which is where "never format a date by hand" already lives.

**Tests.** +20 clinical unit (**137**), +14 api unit (`route-gates`), +18
integration (`consultation-journey`) — one patient walked from an open
consultation through the content, the refused signature, the signature, the
recall list, a booked and fulfilled follow-up, the previous-visit panel, the
visit history, an amendment that re-links its own diagnosis rows, and both
trails. It books the slot the availability engine offers rather than an
invented instant, which is what made it a real flow rather than a passing test.

**Verified — validation ran once, at the end, in CLAUDE.md's order.** Lint clean
(the same two pre-existing `window.location.assign` warnings on other screens) ·
`pnpm format` · typecheck green in clinical, permissions, api and web, per
package · 139 clinical unit, 59 permissions unit, 1 173 api unit and
integration, 378 isolation, all green, run in batches, and re-run after both
review rounds · `db:rls:check` green at **111** · nothing opened in a browser.

⚠️ `@rcln/billing`'s unit suite fails to start in the container —
`Cannot find module '@prisma/client-runtime-utils'` from the generated client.
**Pre-existing and unrelated**: confirmed by stashing this branch's work and
reproducing it on the untouched tree.

**Reviewed.** `security-reviewer`: no critical and no high. The tenancy, RLS,
raw-SQL, secret and middleware-chain surfaces are clean, the open retry
re-checks branch scope and audits, and stamping the codes onto a handler leaks
nothing. Five findings fixed in the same session:

- **The validator must not become the amplifier.** `documentProblems` reported
  one problem per bad key with no cap, and the caller joined the lot into one
  400 body AND one error log — a megabyte of one-character keys was a hundred
  thousand problems. Capped at twenty and a sentence saying there are more.
- **The shape check moved out of the transaction.** It needs nothing from `tx`,
  and serialising fifty sections inside one held a pooled connection open for
  the length of a check whose entire purpose is to refuse the payload.
- **The lost race no longer rethrows a raw driver error.** A bare `23505` is
  neither an `AppError` nor `P2002`, so a clash that was NOT this appointment's
  produced a 500 and a stack carrying the constraint's key values. It is a 409,
  which is what it was before CE-8.
- **The retry's preconditions are written down.** It skips the cancelled-booking
  and branch checks because `openEncounterOnce` has already made them in the
  same call — load-bearing, and previously only true by accident of reading.
- **A gate on a route nobody authenticated is not a gate**, and the audit could
  not see that. It now asserts each router mounts
  `requireTenant → authenticate → requireAuth` ahead of its first route.

`code-reviewer`: no critical. Eight findings acted on:

- **The bounds were on the wrong side of the door.** `descriptors.ts` capped a
  field key at 64 and nothing else — so a template declaring 250 fields, or a
  checkbox group with 300 choices, published cleanly and then failed at the
  autosave, in front of a doctor who did not write it and cannot fix it. The
  limits are now stated once as `DOCUMENT_LIMITS` and enforced at BOTH ends.
  ⚠️ The byte ceiling is deliberately not mirrored: the worst-case size of a
  template is the sum of every field's ceiling, and four unbounded TEXT fields
  already exceed 64 KB on paper while being an ordinary form.
- **`clinicInputValueOf` rendered a legacy zoneless value SHIFTED.** Per spec
  `new Date('2026-08-16T14:30')` is browser-local rather than `NaN`, so the
  guard never fired — and a doctor who re-saved would have written that shift
  back as fact. It renders blank now, which is the honest reading of a string
  that names no moment.
- **The two consultation screens passed zones that meant different things** —
  the booking's branch on one, the READER's on the other — so one record read as
  two wall clocks in a multi-branch org. `timezoneOfBranch` resolves the
  encounter's own branch, and both screens agree.
- **The lost race logged nothing.** The original driver error was discarded
  wholesale, so an operator lost the only evidence of which constraint fired
  while the message told them to retry something that would never succeed.
- **The retry re-implemented `getEncounterForAppointment`.** It calls it.
- **The journey suite tolerated a 409 on the follow-up booking**, which left
  `followUpAppointmentId` null and silently no-opped the previous-visit case and
  half the visit-history case — three assertions green without running. The
  suite owns its organization, branch and doctor, so the clash cannot happen;
  the escape hatch is gone.
- **`ROUTERS` was the maintained list the audit's own header disowns.** The
  suite now reads `src/routes/v1/` from disk and fails until a new route file is
  classified as audited-here or not-clinical.
- **Two `authorize` gates on one route** would have left the second unaudited.
  Now an error rather than a silent `find`.

**Known, and deliberately not changed.** A DATETIME answer written before CE-8
carries no zone, so amending a record that has one leaves the field blank and
the amendment unsignable until it is re-entered. No seeded template declares a
DATETIME field, so this reaches clinic-authored templates only — and the
alternative, resolving a zoneless value through the branch zone at finalization,
guesses at what a clinician meant and writes the guess into a signed record.
Blank and re-entered is the honest outcome.

**Decisions.** No new CD. Every change here is an existing decision enforced
where it was not.

**Remaining.** The consultation engine is complete. The standing three are
unchanged: the chart editor edits geometry as JSON, `IMAGE_MAP` has an enum
member and no map, and nothing has been opened in a browser.
