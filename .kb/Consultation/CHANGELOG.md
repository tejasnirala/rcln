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
