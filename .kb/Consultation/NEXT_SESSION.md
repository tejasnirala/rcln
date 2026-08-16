# Next session

**Read this first.** Updated at the end of every session.

**Written:** 2026-08-16 · **By:** session CE-7 · **Branch:**
`feat/consultation-engine`

---

## Where we are

**CE-0 through CE-7 are complete and verified.** The engine is proven generic:
one doctor, reclassified between `DEN`, `TRICHOLOGY` and no classification at
all, gets three genuinely different consultations — a dentistry one drawing the
odontogram, a hair & scalp one drawing the scalp map, and the general one — out
of the same components. CE-7 added **no schema, no route, no contract, no
permission and no renderer**. `db:rls:check` is unchanged at **111**.

Validation ran once, at the end, in CLAUDE.md's order. Nothing has been opened in
a browser.

## The five things to know before typing

1. **THE GENERICITY CLAIM IS NOW LOAD-BEARING, AND CE-8 IS WHERE IT WOULD BE
   QUIETLY BROKEN.** Hardening means touching validation, permissions and error
   handling across every section — and the tempting shortcut in each of those is
   a branch on a specialty or a section type. §33 has not moved: `apps/web`
   decides nothing, and `resolveTemplate` is the only thing that decides which
   template applies.

2. **THE SEEDED DATA IS AT ITS CEILING (§41).** Three charts, four templates, 34
   reference terms. A fifth specialty configuration is a CLINIC's template, not
   the platform's — a half-researched default is worse than none because a
   clinic will trust it. If CE-8 wants a fixture for a new specialty, it belongs
   in the test, not in the seed.

3. **A NAMED-BUT-MISSING SPECIALTY IN THE TEMPLATE SEED IS FATAL, AND MUST STAY
   THAT WAY (CD-18).** `specialty_id` NULL is the care-context DEFAULT, so a
   dentistry template that lost its node would sort before `GENERAL_HUMAN` at
   depth 0 and hand an odontogram to every human consultation in the product.
   The seed's usual "a missing scope only changes ranking" asymmetry runs the
   opposite way here.

4. **A COMPOSITE RELATION IS INVISIBLE TO PRISMA'S `_count` ON A PLATFORM ROW.**
   Inherited from CE-6 and still true: `NULL = NULL` is never true, so a relation
   count over `(organization_id, …)` returns 0 for every platform row.
   `master.service.ts` and `visual-map.service.ts` both count by the child column
   alone. Expect it again the moment something wants "how many templates cite
   this map".

5. **`pnpm typecheck` and `pnpm test` both OOM the api container.** Run per
   package, or per batch of ~14 integration files with
   `--max-old-space-size=3072`. Tests LAST and ONCE. Jest needs
   `--experimental-vm-modules`, which `pnpm test` sets and a bare `jest` does
   not — pass it through `NODE_OPTIONS` if you invoke `npx jest` directly.

   ⚠️ **And a fixture that finalizes an encounter must fill in what the resolved
   template requires** — a chief complaint AND a follow-up plan. The seeded
   charts are `required: false`, so a finding is NOT required under
   `DENTAL_HUMAN`; a fixture that publishes its own template with a required
   chart still needs one.

## Next task

**CE-8 — hardening.** The last phase: validation, the permission audit, search
performance, error handling, the full §40 integration flow, and both reviewer
subagents (`code-reviewer` and `security-reviewer`).

What CE-7 hands it:

| From CE-7                           | What CE-8 does with it                             |
| ----------------------------------- | -------------------------------------------------- |
| `reference-configurations.test.ts`  | the shape of the §40 end-to-end flow, half written |
| Four published platform templates   | real configurations to audit permissions against   |
| Three charts, three document shapes | the renderer's branches all have shipped data      |

## Do not

- Do not add a fifth reference configuration to the seed (§41). See point 2.
- Do not write a second chart renderer, a `DentalChart`, or any component that
  knows what a tooth is (§23, CD-17).
- Do not put an id inside `visual_regions.metadata`, and do not read a stored
  `definition` without `parseStoredDefinition` or a region's geometry without
  `parseRegionGeometry`.
- Do not make a broken chart refuse a consultation. A `mapCode` matching no
  active map resolves to nothing and the section says so on screen; finalization
  is where a REQUIRED empty chart is refused.
- Do not make the seeded charts `required: true` while hardening. A mouth with
  nothing wrong with it is a real consultation, and the platform does not refuse
  to sign a healthy patient's record (CD-18).
- Do not add a specialty check to any component in `apps/web` (§33).
- Do not widen `GET /clinical-episodes/:id` to carry clinical content (CD-14),
  and do not add a "list every doctor" form to `/doctors/referral-targets`
  (CD-15).
- Do not autosave with `revalidatePath`, and the content writers do not
  revalidate either, for the same caret reason.
- Do not edit a finalized encounter, or add an endpoint that could.
- ⚠️ **Do not let `prisma migrate dev` drop NOT NULL from
  `encounter_procedures.item_id` or `encounter_investigations.item_id`.** It
  wants to on every run — Prisma believes them nullable because a required
  relation may not include a nullable scalar. Delete those lines by hand from
  any generated migration, as CE-6's did.
