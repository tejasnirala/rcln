# Next session

**Read this first.** Updated at the end of every session.

**Written:** 2026-08-16 · **By:** session CE-6 · **Branch:**
`feat/consultation-engine`

---

## Where we are

**CE-0 through CE-6 are complete and verified.** Every member of
`ConsultationSectionType` now has a component over a real table —
`PENDING_SECTIONS` in `consultation-engine.tsx` is an empty object. A clinician
can mark a finding on a tooth, link it to a diagnosis, sign the record, and see
the marks again on the previous-visit panel and counted on the visit history.

**CE-6 added three tables.** `db:rls:check` is green at **111** (was 108).
Validation ran once, at the end, in CLAUDE.md's order. Nothing has been opened in
a browser.

## The five things to know before typing

1. **THE ENGINE IS GENERIC AND CE-7 IS THE PHASE THAT PROVES IT.** `apps/web`
   has ONE chart renderer, `VisualMapChart`, and there is no tooth in it — the
   geometry is data on `visual_regions.metadata` (CD-17). `HUMAN_SCALP` and
   `HUMAN_BODY` should therefore be **rows in `seed/data/visual-maps.ts` and
   nothing else**. If CE-7 finds itself writing a second renderer, stop: that is
   the failure mode this design exists to prevent, and its definition of done is
   "no `HairConsultation.tsx` exists, and none was needed".

2. **NO TEMPLATE SHIPS WITH A CHART ON IT YET.** `HUMAN_DENTAL` exists and the
   seeded `GENERAL_HUMAN` does not cite it. CE-7's dentistry and hair-and-scalp
   templates are what join the two, with `mapCode` in the definition — a CODE,
   never an id (CD-6). §41 keeps the seeded data small; think before adding a
   third map.

3. **A COMPOSITE RELATION IS INVISIBLE TO PRISMA'S `_count` ON A PLATFORM ROW.**
   `NULL = NULL` is never true, so a relation count over `(organization_id, …)`
   returns 0 for every platform row. It cost CE-6 a test; `master.service.ts`
   and `visual-map.service.ts` both count by the child column alone. **Expect
   this again** the moment CE-7 wants "how many templates cite this map".

4. **`countFor` IN `encounter.service.ts` IS NOW EXHAUSTIVE AND MUST STAY THAT
   WAY.** It has no `default:` branch. A section type added to
   `ConsultationSectionType` without a case here is a TYPE ERROR — which is the
   whole point, because the permissive default it replaced made a required chart
   signable with nothing on it.

5. **`pnpm typecheck` and `pnpm test` both OOM the api container.** Run per
   package, or per batch of ~12 integration files with
   `--max-old-space-size=3072`. Tests LAST and ONCE. Jest also needs
   `--experimental-vm-modules`, which `pnpm test` sets and a bare `jest` does
   not.

   ⚠️ **And a fixture that finalizes an encounter must fill in what the seeded
   template requires** — a chief complaint AND a follow-up plan, and now a
   finding if the template requires a chart.

## Next task

**CE-7 — `HUMAN_SCALP` / `HUMAN_BODY` and the reference configurations.** The
phase that proves the engine is generic: dentistry and hair & scalp templates,
both maps, all four driven by configuration.

What CE-6 hands it:

| From CE-6                  | What CE-7 does with it                               |
| -------------------------- | ---------------------------------------------------- |
| `VisualMapChart`           | draws the scalp map for free — do not write a second |
| `seed/data/visual-maps.ts` | add two entries; the writer is already idempotent    |
| `mapCode` on a section     | the dentistry template cites `HUMAN_DENTAL`          |
| `/visual-maps` admin       | a clinic can already draw its own chart              |

## Do not

- Do not write a second chart renderer, a `DentalChart`, or any component that
  knows what a tooth is (§23, CD-17). If a map cannot be expressed as regions
  with geometry, say so before writing code around it.
- Do not put an id inside `visual_regions.metadata`. `parseRegionGeometry`
  refuses an unknown key, so one cannot be smuggled in — keep it that way.
- Do not read a stored `definition` without `parseStoredDefinition`, or a
  region's geometry without `parseRegionGeometry`.
- Do not make a broken chart refuse a consultation. A `mapCode` matching no
  active map resolves to nothing and the section says so on screen; refusing
  would make a configuration mistake somebody else made stop a doctor with a
  patient in the chair. Finalization is where a REQUIRED empty chart is refused.
- Do not add a specialty check to any component in `apps/web` (§33).
- Do not widen `GET /clinical-episodes/:id` to carry clinical content (CD-14).
- Do not add a "list every doctor" form to `/doctors/referral-targets` (CD-15).
- Do not autosave with `revalidatePath`, and the content writers do not
  revalidate either, for the same caret reason.
- Do not edit a finalized encounter, or add an endpoint that could.
- ⚠️ **Do not let `prisma migrate dev` drop NOT NULL from
  `encounter_procedures.item_id` or `encounter_investigations.item_id`.** It
  wants to on every run — Prisma believes them nullable because a required
  relation may not include a nullable scalar. Delete those lines by hand from
  any generated migration, as CE-6's did.
