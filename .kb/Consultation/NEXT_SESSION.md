# Next session

**Read this first.** Updated at the end of every session.

**Written:** 2026-08-15 · **By:** session CE-5 · **Branch:**
`feat/ce-5-visit-history`

---

## Where we are

**CE-0 through CE-5 are complete and verified.** Everything CE-1…CE-4 stores can
now be read back: a patient's whole visit history, one journey's timeline, a
signed consultation on its own page, and the previous visit as a panel inside
the one being written. The recall list has a screen, the follow-up booking form
exists and sends `fulfilsRecommendationId`, and referrals reach all three
destinations.

**CE-5 changed no schema.** No migration, no new RLS policy; `db:rls:check` is
green at **108**, unchanged. Validation ran once, at the end, in CLAUDE.md's
order. Nothing has been opened in a browser.

## The five things to know before typing

1. **CE-5 ADDED NO TABLE AND STILL ADDED AN ISOLATION HAZARD.** The visit
   history nests a BRANCH-scoped child (`encounters`) under an ORG-scoped parent
   (`clinical_episodes`) — the only place in the codebase where "the parent is
   visible" and "the child is visible" answer differently. A reader at B1
   legitimately sees a journey whose consultations all happened at B2 and must
   see none of them. `tenant-isolation/visit-history.test.ts` is that case.
   **CE-6's `clinical_findings` hangs off an encounter, so it inherits the
   branch half and this shape does not recur — but check it does not.**

2. **TWO DISCLOSURE CLASSES OVER ONE JOURNEY, AND TWO ENDPOINTS (CD-14).**
   `GET /clinical-episodes/:id` is `appointment.read` and carries no diagnosis;
   `GET /patients/:id/visit-history` is `clinical.encounter.read` and does.
   Widening the first is how the front desk would get the chart through the
   booking screen. **Anything CE-6 adds to a journey view has to pick a side.**

3. **THE REFERRAL LOOKUP IS A LOOKUP, NOT A ROSTER (CD-15).**
   `GET /doctors/referral-targets` sits behind `clinical.encounter.create`
   because `search` is REQUIRED with a two-character minimum — there is no form
   of it that answers "who works here". A DOCTOR still does not hold
   `doctor.directory.read`. **Do not add a list-all mode to it.**

4. **`dueOn` NOW HAS TWO IMPLEMENTATIONS AND THEY MUST CHANGE TOGETHER.** The
   TypeScript one is exported from `encounter-content.service.ts`; its twin is
   `DUE_DATE` in `recall.service.ts`, written as SQL because the recall list
   FILTERS on it and cannot load every outstanding recommendation to do so. Both
   are commented as each other's twin.

5. **`pnpm typecheck` and `pnpm test` both OOM the api container.** Run per
   package, or per batch of ~12 integration files with
   `--max-old-space-size=3072`. Tests LAST and ONCE. Jest also needs
   `--experimental-vm-modules`, which `pnpm test` sets and a bare `jest` does
   not.

   ⚠️ **And a fixture that finalizes an encounter must fill in what the seeded
   template requires** — a chief complaint AND a follow-up plan — or finalize
   400s, the encounter stays a DRAFT, and every "previous visit" assertion
   passes vacuously against a null.

## Next task

**CE-6 — the visual mapping engine and `HUMAN_DENTAL`.** The last section type
with no editor: `PENDING_SECTIONS` in `consultation-engine.tsx` is down to
`VISUAL_MAPPING` alone.

What CE-5 hands it:

| From CE-5                  | What CE-6 does with it                                |
| -------------------------- | ----------------------------------------------------- |
| `/consultations/:id`       | a finding renders on the read-only record for free    |
| `encounterVisitSummary`    | add a finding count beside the other five             |
| `PreviousVisitSummary`     | last visit's findings belong in the panel             |
| the isolation file's shape | copy it for `clinical_findings`, which needs a policy |

## Do not

- Do not widen `GET /clinical-episodes/:id` to carry clinical content (CD-14).
  The desk holds `appointment.read` and that endpoint is theirs.
- Do not add a "list every doctor" form to `/doctors/referral-targets` (CD-15).
- Do not build a time from a `datetime-local`. `FollowUpForm` books against the
  availability engine's slots because that control hands back a wall clock with
  no zone, and the GiST no-overlap constraint needs an exact instant anyway.
- Do not present the previous visit without saying how it was found (CD-16).
  `PARENT_APPOINTMENT` is a fact; `MOST_RECENT` is a convenience.
- Do not edit a finalized encounter, or add an endpoint that could. CE-5's read
  surfaces are read-only because of the storage model, not because a screen
  hides a button.
- Do not read `definition` or `template_snapshot` without `parseStoredDefinition`.
- Do not autosave with `revalidatePath`, and the content writers do not
  revalidate either, for the same caret reason.
- Do not add a specialty check to any component in `apps/web` (§33).
- Do not put master-item ids inside `encounter_sections.data` (CD-6, ADR-0006).
- ⚠️ **`VISUAL_MAPPING` still falls through `countFor`'s default in
  `missingRequiredContent` and returns 1.** Delete that branch when
  `clinical_findings` lands, or a template requiring the section will finalize
  with nothing drawn on it.
