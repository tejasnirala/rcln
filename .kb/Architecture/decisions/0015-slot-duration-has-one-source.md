# ADR-0015 — Slot duration has one authoritative source

**Status:** Accepted

## Context

How long is an appointment slot? When the doctor tables were designed, three
different places claimed to answer that:

- `doctor_branch_settings.slot_minutes` — per doctor, per branch
- `branch_operating_hours.slot_minutes` — per branch, per weekday (already built
  in Phase 1)
- the `appointment.slot_minutes` **setting**, already seeded with allowed scopes
  `ORGANIZATION | BRANCH | DOCTOR`

Three columns, no reconciliation rule. Nothing said which wins when a doctor's
branch setting says 20 and the branch's operating hours say 15.

That is not a tidiness problem. The availability engine and the patient portal
would each pick a source, and the failure presents as _"the receptionist's
calendar shows a 10:20 slot but the online booking page doesn't"_ — a bug with
no error, no failing test, and two screens that are each internally consistent.
Whichever one a patient trusts, somebody is turned away or double-booked.

## Decision

**One chain, two sources, most specific wins:**

1. `doctor_schedules.slot_minutes` — nullable. Non-null means "this specific
   block of this doctor's week runs at this cadence". It is the only per-block
   override and the only column the engine reads directly.
2. Otherwise the resolved `appointment.slot_minutes` setting, through the
   standard ladder: **DOCTOR → BRANCH → ORGANIZATION → PLATFORM → default (15)**.

Consequently:

- **`doctor_branch_settings` carries no `slot_minutes`.** It was exactly the
  DOCTOR-scope setting value with a second home. A cadence that genuinely
  differs per (doctor × branch) is already expressible, because schedule rows
  are per (doctor, branch, day_of_week).
- **`doctor_branch_settings` carries no `accepts_online_booking`** either, for
  the same reason — `appointment.allow_online_booking` resolves through the same
  ladder.
- **`branch_operating_hours.slot_minutes` stays but is never read by the
  engine.** The column exists and the branch screen writes it; removing it is a
  Phase-4 cleanup. Its model doc-comment says so, because otherwise someone will
  wire it back in.

The same reasoning applies to any future "what cadence/limit/policy applies
here" question: add a scope to the settings ladder, not a column to a table.

## Why a nullable override plus the ladder, rather than one column

A single column somewhere loses real granularity. Clinics genuinely need:

- one cadence for the whole clinic (the common case — set it once at
  ORGANIZATION and never think about it),
- a different one at a busier branch,
- a different one for a particular consultant,
- and a different one for that consultant's Thursday procedure list.

The ladder gives the first three with no schema at all, and the nullable column
on `doctor_schedules` gives the fourth. Every level is optional, and the value
in force is always derivable by one evaluation order that exists in one place.

## Consequences

- `resolveSettings()` (`apps/api/src/services/settings/resolver.service.ts`) is
  on the booking path, so it is batched and reads all keys in one query.
- The API returns **both** numbers on a schedule row: `slotMinutes` (the
  override, or null) and `effectiveSlotMinutes` (what the engine will use). The
  screen states which of the two it is — _"15 min slots, from clinic settings"_
  versus _"30 min slots, set here"_ — because inheritance the user cannot see is
  inheritance they will fight.
- `effectiveSlotMinutes()` in `doctor.service.ts` is the single implementation.
  The availability engine imports it rather than re-deriving the ladder; a
  second copy is a second answer, which is the bug this ADR exists to prevent.
- ⚠️ `setting_values` is RLS-EXEMPT, so the resolver's explicit
  `(scopeType, scopeId)` pairs are the only tenant isolation on this path.
  `db:rls:check` cannot catch a mistake there — there is no policy to be
  missing. See the file header and the `setting-resolver.test.ts` boundary cases.

## How this can be broken

Adding a `slot_minutes` column to any table, or reading
`branch_operating_hours.slot_minutes` in the engine "because it is right there".
Either restores the three-source ambiguity, and the symptom will again be two
screens that disagree about whether a slot exists.
