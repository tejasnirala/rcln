# Implementation tracker

Short by design. The reasoning lives in [DECISIONS.md](DECISIONS.md); the
per-phase report lives in [CHANGELOG.md](CHANGELOG.md).

| Phase | Scope                                | Status         |
| ----- | ------------------------------------ | -------------- |
| CE-0  | Repository analysis                  | ✅ complete    |
| CE-1  | Clinical foundation                  | ✅ complete    |
| CE-2  | Templates + config resolver          | ✅ complete    |
| CE-3  | Encounter core + lifecycle           | ✅ complete    |
| CE-4  | Clinical content sections            | ✅ complete    |
| CE-5  | Visit history + episodes             | ✅ complete    |
| CE-6  | Visual mapping engine + HUMAN_DENTAL | ✅ complete    |
| CE-7  | HUMAN_SCALP/BODY + reference configs | ⬜ not started |
| CE-8  | Hardening                            | ⬜ not started |

## CE-1 — done

- [x] Schema — 6 models, 5 enums, back-relations across 7 files
- [x] 5 migrations, applied. Episode backfill + `SET NOT NULL` in one txn
- [x] RLS — `db:rls:check` green at **96** (was 89)
- [x] Contracts — `clinical.ts`, plus `clinicalEpisodeId` on booking
- [x] Services — `episode.service.ts`, `master.service.ts`; both booking paths wired
- [x] Routes — `/clinical-data/*`, `/clinical-episodes/*`. No new permission codes
- [x] Seed — care-context roots, 7 domains re-parented, 34 reference terms
- [x] Web — `/clinical-terms`, nav entry
- [x] Tests — 14 isolation + 21 integration, plus 3 repaired fixtures and 8
      updated taxonomy assertions

## CE-2 — done

- [x] `packages/clinical` — the pure engine (CD-10). Descriptors, section
      registry, definition grammar, specificity resolver. **74 unit tests**
- [x] Schema — 2 models, 1 enum; one migration, no enum split needed
- [x] RLS — `db:rls:check` green at **98** (was 96)
- [x] Contracts — `consultation.ts`. `definition` stays `unknown` on the wire;
      the grammar has one home
- [x] Permissions — `clinical.template.manage`, held by owner and admin, not by
      DOCTOR: configuring a consultation is not conducting one
- [x] Services — `template.service.ts`, `consultation-config.service.ts`,
      `definition.ts` (the one door to a stored document)
- [x] Routes — `/consultation-templates/*`, plus
      `GET /appointments/:id/consultation-config` behind `clinical.encounter.read`
- [x] Seed — `GENERAL_HUMAN` and `GENERAL_VET`, published, parsed before writing
- [x] Web — `/consultation-templates` list and version editor, nav entry
- [x] Tests — 20 integration + 13 isolation

## CE-3 — done

- [x] Schema — `encounters` + `encounter_sections`, 3 enums, 2 partial uniques,
      4 CHECKs. `encounter_follow_up_recommendations.encounter_id` NOT NULL
- [x] 2 migrations (the `ENCOUNTER` counter alone, then the tables)
- [x] RLS — `db:rls:check` green at **100** (was 98). Both tables in BOTH loops,
      plus `template_visible` — the composite FK is impossible here (a platform
      template has a NULL org and the encounter's is NOT NULL)
- [x] Contracts — `encounters.ts`. Section `data` stays `unknown` on the wire
- [x] Permissions — `clinical.encounter.amend`, in `CLINICAL_AUTHORING`
- [x] Engine — `validate.ts` in `packages/clinical`. **89 unit tests** (was 74)
- [x] Services — `encounter.service.ts`; `resolveConfiguration` and
      `sectionConfigs` extracted from CE-2 so a snapshot renders the same way
- [x] Routes — `/encounters/*`, plus `GET /appointments/:id/encounter` (the
      reader's door: opening a draft is authorship)
- [x] Web — `ConsultationEngine`, `FieldRenderer` (13 field types), debounced
      autosave through a Server Action with **no `revalidatePath`**
- [x] Tests — 12 integration + 10 isolation, plus 3 repaired CE-1 fixtures

## CE-4 — done

- [x] Schema — 8 models, 11 enums, `DocumentType.CLINICAL_ATTACHMENT`
- [x] 2 migrations (the enum member alone, then the tables). 14 CHECKs, 1
      partial unique (`one_primary`), 2 `SET NOT NULL` Prisma cannot infer
- [x] RLS — `db:rls:check` green at **108** (was 100). All eight in BOTH loops,
      plus `item_visible` × 5, `product_visible`, `specialty_visible`
- [x] Contracts — `encounter-content.ts`; `content` on `encounterDetail`;
      `fulfilsRecommendationId` on the follow-up booking
- [x] Permissions — **none added** (CD-7). Recording a diagnosis IS writing up
      the consultation; the recall list is `appointment.*`, because the desk
      works it
- [x] Engine — `requiredContentSections` in `packages/clinical`. **92 unit
      tests** (was 89)
- [x] Services — `encounter-content.service.ts`, `recall.service.ts`; amendment
      copies content and **remaps the diagnosis links**
- [x] Routes — 24 collection routes from one table, `PUT …/follow-up`,
      `GET /follow-up-recommendations`, `POST …/cancel`
- [x] Web — nine section editors in `consultation-content.tsx`;
      `PENDING_SECTIONS` down from ten entries to one
- [x] Tests — 31 integration + 15 isolation, plus one repaired CE-3 case

## CE-5 — done

- [x] Schema — **none.** CE-5 is read surfaces over CE-1…CE-4's tables; no
      migration, no new RLS policy, `db:rls:check` unchanged at **108**
- [x] Contracts — `visit-history.ts` (a new file: it imports `clinical.ts` AND
      `encounter-content.ts`, and a Zod cycle fails at runtime). Named
      `followUpRecallStatus`; `doctorProfileId`/`doctorName` on the recall entry
- [x] Permissions — **none added.** Two disclosure classes over one journey
      (CD-14); the referral lookup reuses `clinical.encounter.create` (CD-15)
- [x] Services — `visit-history.service.ts`; `searchReferralTargets` in
      `doctor.service.ts`; `dueOn` exported from the content service so the
      timeline and the recall list answer alike
- [x] Routes — `GET /patients/:id/visit-history`,
      `GET /appointments/:id/previous-visit`, `GET /doctors/referral-targets`
- [x] Web — `/recall` + nav, `/patients/:id/visit-history`, `/episodes/:id`,
      `/consultations/:id` (read-only), the previous-visit panel, the follow-up
      booking form, and the referral specialty + colleague pickers
- [x] Tests — 17 integration + 5 isolation

## CE-6 — done

- [x] Schema — 3 models, 1 enum, plus `encounter_procedures.visual_region_id`.
      One migration: the enum is NEW, so CD-9's trap does not apply
- [x] RLS — `db:rls:check` green at **111** (was 108). Both map tables in the
      platform-extensible loop with `platform_rows_immutable`; `clinical_findings`
      in BOTH scoped loops; `region_visible` × 2, `item_visible`,
      `specialty_visible`. Plus a CHECK on `view_box`, a CHECK pairing
      `renderer` with `asset_key`, and a trigger refusing a cross-map parent
- [x] Contracts — `visual-mapping.ts` (a new file: `consultation.ts` and
      `encounter-content.ts` both import it, and a Zod cycle fails at runtime).
      `metadata` stays `unknown` on the wire; the geometry grammar has one home
- [x] Permissions — `clinical.visual_map.manage`. Configuring a chart is not
      drawing on one: findings are `clinical.encounter.create` (CD-7)
- [x] Engine — `regions.ts` in `packages/clinical` (CD-17). **117 unit tests**
      (was 92)
- [x] Services — `visual-map.service.ts`; findings as the ninth collection in
      `encounter-content.service.ts`; `mapsForCodes` resolves a template's
      `mapCode` in `sectionConfigs`; `findingCount` on the visit summary
- [x] Routes — `/visual-maps/*`, plus `…/encounters/:id/findings` on the CE-4
      collection table
- [x] Seed — `HUMAN_DENTAL`: 32 FDI teeth and 4 quadrants, parsed before writing
- [x] Web — `VisualMappingSection` + `VisualMapChart` (one generic renderer, no
      tooth in it), `/visual-maps` admin + nav, findings on the previous-visit
      panel and the visit history. **`PENDING_SECTIONS` is now empty**
- [x] Tests — 25 integration + 14 isolation + 25 unit

## Not done in CE-6, and deliberately

- **The chart editor edits geometry as JSON.** A drag-and-drop designer is a
  real product and is not this phase; what CE-6 owes is that a clinic CAN
  configure a chart without a deploy, and that the engine refuses a document
  that says nothing checkable. The preview is what makes the JSON legible.
- **No template ships with a chart on it.** `HUMAN_DENTAL` exists and the
  seeded GENERAL templates do not cite it — the dentistry template is CE-7's,
  and §41 keeps the seeded data small. A clinic wires the two together today by
  putting `mapCode` in its own template.
- **`IMAGE_MAP` has a renderer enum member and no map.** The columns and the
  CHECK are there; nothing ships a raster chart, and the web renderer draws
  `SVG` only.
- **`encounter_procedures.visual_region_id` has an API and no picker.** The
  column, the contract and the service accept it; the procedure editor does not
  offer a region yet. The chart is where a region is chosen, and wiring the two
  lists together is a screen decision CE-7 is better placed to make.
- **Nothing has been opened in a browser.** Same item CE-6 inherits from CE-5.

## Not done in CE-5, and deliberately

- **The walk-in still has an API and no screen.** `POST /encounters` takes a
  patient and an episode (CD-1) and the visit history now RENDERS walk-ins, but
  nothing in `apps/web` opens one. Inherited from CE-3, still open.
- **The episode screen renders one timezone for a journey that may span two.**
  `clinicalEpisodeDetail` carries no per-visit zone, so a journey across two
  branches renders both halves in the organization's. The page says which zone
  it is in rather than being silent about it, and the visit history — which does
  carry the zone per row — gets it exactly right. Widening the episode contract
  is the fix, and it is additive.
- **Amending is not offered from the read-only record screen.** An amendment
  starts a draft that belongs to a VISIT, and that route reaches a record by its
  own id — a walk-in among them, with no visit to return to. The visit's own
  page is one link away and is where the button lives.
- **A booking made from the consultation does not fulfil a recommendation.** The
  form there sends no `fulfilsRecommendationId`, because the recommendation it
  would tick off is the one being written at that moment. Fulfilment happens
  from the recall list, where a recommendation exists to fulfil.
- **Nothing has been opened in a browser.** Same item CE-5 inherits from CE-4.

## Not done in CE-4, and deliberately

- ~~**The recall list has an API and no screen.**~~ Closed by CE-5.
- ~~**`bookFollowUp` accepts a recommendation and no form sends one.**~~ Closed
  by CE-5's `FollowUpForm`, on the recall list.
- **Attachments link a file and do not upload one.** §27: the bytes are the
  documents surface's. The chart claims an existing `files` row and re-types it
  `CLINICAL_ATTACHMENT`; the upload control is the patient record's.
- **A walk-in cannot recommend a follow-up.** `appointment_id` is NOT NULL on the
  recommendation, denormalised so the recall list needs no join. The service says
  so in a sentence rather than working around it.
- ~~**Referrals are by name only on screen.**~~ Closed by CE-5 — and the
  colleague picker needed a new endpoint rather than the roster (CD-15).
- **Nothing has been opened in a browser.** Same item CE-4 inherits from CE-3.

## Not done in CE-3, and deliberately

- ~~**Nine sections render a line, not an editor.**~~ Closed by CE-4.
- **The walk-in has an API and no screen.** `POST /encounters` takes a patient
  and an episode (CD-1), and nothing in `apps/web` calls it that way yet —
  there is no walk-in flow outside the booking path. Still open.
- **Nothing has been opened in a browser.** Same item CE-3 inherits from CE-2.

## Not done in CE-2, and deliberately

- **Nothing renders a consultation yet.** The resolver answers what the screen
  should be; `ConsultationEngine` and the section components are CE-3.
- ~~**`mapCode` is carried and not resolved.**~~ Closed by CE-6.
- **Nothing has been opened in a browser.** Same item CE-2 inherits from CE-1.

## Not done in CE-1, and deliberately

- **The recall list has no endpoint yet.** `encounter_follow_up_recommendations`
  is a table with no writer until CE-4 — nothing can recommend a follow-up until
  there is a consultation to recommend it from.
- **`animal_profiles` has no surface at all.** CD-4: the architecture stops
  assuming humans; veterinary features are not built (§42.7).
- **Nothing has been opened in a browser.** Same item CE-1 inherits from every
  PI phase.
