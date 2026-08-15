# Next session

**Read this first.** Updated at the end of every session.

**Written:** 2026-08-15 · **By:** session CE-4 · **Branch:**
`feat/ce-4-clinical-content`

---

## Where we are

**CE-0 through CE-4 are complete and verified.** A consultation now holds
clinical content: symptoms, diagnoses, procedures, prescriptions,
investigations, advice, referrals, attachments and a follow-up plan, all as real
rows with real foreign keys. **PI-7 and PI-9 are unblocked** —
`encounter_prescriptions` and `encounter_procedures` exist.

Validation ran once, at the end, in CLAUDE.md's order. `db:rls:check` is green at
**108**. Nothing has been opened in a browser.

## The five things to know before typing

1. **`item_visible` IS THE NEW `template_visible`, AND THERE ARE SEVEN OF THEM.**
   Five content tables cite `clinical_master_items`, one cites `products`, one
   cites `specialties` — all three parents allow a NULL `organization_id`, so no
   composite FK is drawable and each needs a RESTRICTIVE `*_visible` policy.
   CE-6's `clinical_findings.finding_item_id` is the eighth, and
   `visual_region_id` will be the ninth if `visual_regions` stays
   platform-extensible.

2. **A `SetNull` FK IS IMPOSSIBLE WHEN THE COMPOSITE INCLUDES `organization_id`.**
   `encounter_procedures.diagnosis_id` wanted SetNull and cannot have it — the
   column is NOT NULL, so Postgres refuses. It is `Restrict`, and
   `removeDiagnosis` unlinks the procedures first. **CE-6's
   `clinical_findings.diagnosis_id` is the same shape.**

3. **AN AMENDMENT COPIES THE CONTENT AND REMAPS THE DIAGNOSIS LINKS.**
   `copyContentToAmendment` builds an old-id → new-id map for the diagnoses so
   the copied procedures cite the copies. A straight copy passes the composite FK
   — it only says "same tenant" — and renders as a procedure treating a diagnosis
   that is not on this consultation. **Anything CE-6 hangs off a diagnosis needs
   the same remap.**

4. **THE SEEDED TEMPLATE MARKS FOLLOW-UP REQUIRED, AND THAT IS NOW ENFORCED.**
   `requiredContentSections` (engine) says WHICH first-class sections a template
   requires; `missingRequiredContent` (service) counts the rows. The flag was
   inert before CE-4 and repairing one CE-3 test was the whole cost.
   ⚠️ **VISUAL_MAPPING falls through `countFor`'s default and returns 1** — it has
   no table until CE-6. Delete that branch when `clinical_findings` lands.

5. **`pnpm typecheck` and `pnpm test` both OOM the api container.** Run per
   package, or per batch of ~13 integration files with
   `--max-old-space-size=3072`. Tests LAST and ONCE. Jest also needs
   `--experimental-vm-modules`, which `pnpm test` sets and a bare `jest` does not.

## Next task

**CE-5 — visit history and episodes.** The read surfaces over everything CE-1…CE-4
now stores.

What CE-4 hands it:

| From CE-4                        | What CE-5 does with it                              |
| -------------------------------- | --------------------------------------------------- |
| `GET /follow-up-recommendations` | the recall list ENDPOINT exists; build its screen   |
| `fulfilsRecommendationId`        | the booking form that sends it — no form exists yet |
| `encounterContentOf`             | the previous-visit summary reads it unchanged       |
| the referral contract            | the specialty and colleague pickers (§37)           |

## Do not

- Do not add a `*_visible` policy's table to the RLS loops and stop there — the
  loop gives you `tenant_isolation` and `branch_isolation`, and the plain FK into
  a platform-extensible parent is a THIRD policy (item 1).
- Do not edit a finalized encounter, or add an endpoint that could. The two
  exceptions are fulfilment and cancellation of a RECOMMENDATION, which are facts
  about a booking's fate and not about the record.
- Do not read `definition` or `template_snapshot` without `parseStoredDefinition`.
- Do not autosave with `revalidatePath` — and the content writers do not
  revalidate either, for the same caret reason.
- Do not add a specialty check to any component in `apps/web` (§33).
- Do not put master-item ids inside `encounter_sections.data` (CD-6, ADR-0006).
  Coded content is its own table, and now all eight of them exist.
- Do not build the visual map. `mapCode` is still carried and unresolved (CE-6),
  and `PENDING_SECTIONS` in `consultation-engine.tsx` is down to that one entry.
