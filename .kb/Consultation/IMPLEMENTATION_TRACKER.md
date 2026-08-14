# Implementation tracker

Short by design. The reasoning lives in [DECISIONS.md](DECISIONS.md); the
per-phase report lives in [CHANGELOG.md](CHANGELOG.md).

| Phase | Scope                                | Status         |
| ----- | ------------------------------------ | -------------- |
| CE-0  | Repository analysis                  | ✅ complete    |
| CE-1  | Clinical foundation                  | ✅ complete    |
| CE-2  | Templates + config resolver          | ✅ complete    |
| CE-3  | Encounter core + lifecycle           | ✅ complete    |
| CE-4  | Clinical content sections            | ⬜ not started |
| CE-5  | Visit history + episodes             | ⬜ not started |
| CE-6  | Visual mapping engine + HUMAN_DENTAL | ⬜ not started |
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

## Not done in CE-3, and deliberately

- **Nine sections render a line, not an editor.** Diagnosis, prescription,
  symptoms and the rest are FIRST-CLASS: their tables are CE-4, so the engine
  names them and says when they arrive rather than drawing an empty box.
- **The walk-in has an API and no screen.** `POST /encounters` takes a patient
  and an episode (CD-1), and nothing in `apps/web` calls it that way yet —
  there is no walk-in flow outside the booking path.
- **Nothing has been opened in a browser.** Same item CE-3 inherits from CE-2.

## Not done in CE-2, and deliberately

- **Nothing renders a consultation yet.** The resolver answers what the screen
  should be; `ConsultationEngine` and the section components are CE-3.
- **`mapCode` is carried and not resolved.** `visual_maps` lands in CE-6; until
  then a VISUAL_MAPPING section validates and has nothing to draw.
- **Nothing has been opened in a browser.** Same item CE-2 inherits from CE-1.

## Not done in CE-1, and deliberately

- **The recall list has no endpoint yet.** `encounter_follow_up_recommendations`
  is a table with no writer until CE-4 — nothing can recommend a follow-up until
  there is a consultation to recommend it from.
- **`animal_profiles` has no surface at all.** CD-4: the architecture stops
  assuming humans; veterinary features are not built (§42.7).
- **Nothing has been opened in a browser.** Same item CE-1 inherits from every
  PI phase.
