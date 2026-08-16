# Next session

**Read this first.** Updated at the end of every session.

**Written:** 2026-08-16 · **By:** session CE-8 · **Branch:**
`feat/ce-8-hardening`

---

## Where we are

**CE-0 through CE-8 are complete. The Consultation Engine programme is
finished.** A consultation resolves from a doctor's classification, opens,
autosaves, refuses to be signed while a required answer is missing, signs,
recalls, is booked against, is read back at the next visit and is corrected by
an amendment that carries its content forward and re-links it — all of it walked
end to end in one suite, `consultation-journey.test.ts`.

CE-8 added **no endpoint, no permission code and no table.** One partial index,
and `db:rls:check` unchanged at **111**.

Validation ran once, at the end, in CLAUDE.md's order. Nothing has been opened
in a browser.

## The six things to know before typing

1. **`documentProblems` IS THE ONE ENGINE RULE THAT RUNS AT AUTOSAVE.**
   Everything else in `validate.ts` waits for the signature on purpose — a
   doctor half way through an examination must not be interrupted. That function
   does not, because what it refuses is not an incomplete answer but a document
   nothing could render: scalars and lists of scalars, 200 answers, 20 000
   characters, 200 entries, 64 KB. ⚠️ Do not "relax it a bit" for a caller; a
   caller that needs more than 64 KB in one section is not the consultation
   screen.

2. **A DATETIME ANSWER WRITTEN BEFORE CE-8 HAS NO ZONE, AND RENDERS BLANK.**
   Nothing resolves it — guessing at the zone would write the guess into a
   signed record — so amending a record carrying one leaves the field empty and
   the amendment unsignable until somebody re-enters it. No seeded template
   declares a DATETIME field, so this is clinic-authored templates only.

3. **A DATETIME ANSWER IS AN INSTANT, AND THE WEB CONTROL CONVERTS.**
   `datetime-local` speaks the branch's wall clock and the record stores UTC with
   a `Z` (invariant 6). `FieldRenderer` takes a required `timeZone` for exactly
   this. ⚠️ A new screen that renders `FieldRenderer` passes the BOOKING's zone
   where it has one, otherwise `timezoneOfBranch(slug, encounter.branchId)` —
   NOT `timezoneOf(slug)`, which is the READER's branch and makes one record
   read as two wall clocks across two screens. The prop is required so the
   question cannot be skipped, only answered wrongly.

4. **THE PERMISSION AUDIT READS THE ROUTERS, NOT A LIST.**
   `authorize()` stamps `requiredPermissions` on the handler it returns and
   `tests/unit/route-gates.test.ts` walks the Express stack. A new clinical route
   is in that audit the day it is added — which is the day it needs auditing.
   ⚠️ That suite is the only unit suite that imports from `src/`, so it closes
   Redis and Prisma in `afterAll`; without that the RUN never ends. It also
   reads `src/routes/v1/` from disk and fails until a NEW route file is
   classified — audited there, or deliberately not.

5. **THE RECALL LIST'S DUE DATE STILL CANNOT BE INDEXED, AND MUST NOT BE
   DENORMALISED INTO A COLUMN.** `timezone(text, timestamptz)` is STABLE, so the
   expression is not indexable; a stored `due_on` would be a second answer to
   "when is this due" beside the first. The partial index narrows the SET
   instead. If the list ever gets slow again, narrow the set further — do not
   add the column.

6. **`pnpm typecheck` and `pnpm test` both OOM the api container.** Run per
   package, or per batch of ~14 integration files with
   `--max-old-space-size=3072`. Tests LAST and ONCE. Jest needs
   `--experimental-vm-modules`, which `pnpm test` sets and a bare `jest` does
   not.

   ⚠️ **A fixture that books a follow-up needs the doctor to have a schedule.**
   `POST /appointments/:id/follow-up` refuses a time the availability engine does
   not offer, so a fixture with no `doctor_schedules` row can record a
   recommendation it can never fulfil — and the test that tolerates the failure
   passes for the wrong reason. Seed the hours, then book a slot the engine
   offers.

   ⚠️ **`@rcln/billing`'s unit suite fails to start in the container** —
   `Cannot find module '@prisma/client-runtime-utils'` from the generated
   client. Pre-existing, unrelated to CE, and reproduced on an untouched tree.

## Next task

**None in this programme.** CE is done. The open work is elsewhere — see
[`.kb/STATUS.md`](../STATUS.md).

What is deliberately still open here, and has been since CE-5:

- **The chart editor edits geometry as JSON.** A drag-and-drop designer is a
  real product and was never this programme's job.
- **`IMAGE_MAP` has a renderer enum member and no map.** The columns and the
  CHECK are there; nothing ships a raster chart.
- **The walk-in has an API and no screen.** `POST /encounters` takes a patient
  and an episode (CD-1); nothing in `apps/web` opens one.
- **Nothing has been opened in a browser.** Inherited from every phase.

## Do not

- Do not add a fifth reference configuration to the seed (§41). A specialty
  configuration is a CLINIC's template, written by somebody who practises it.
- Do not write a second chart renderer, a `DentalChart`, or any component that
  knows what a tooth is (§23, CD-17).
- Do not add a specialty check to any component in `apps/web` (§33).
- Do not edit a finalized encounter, or add an endpoint that could.
- Do not make the seeded charts `required: true` (CD-18).
- Do not autosave with `revalidatePath`.
- ⚠️ **Do not let `prisma migrate dev` drop NOT NULL from
  `encounter_procedures.item_id` or `encounter_investigations.item_id`.** It
  wants to on every run. Delete those lines by hand from any generated
  migration.
