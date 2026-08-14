# Next session

**Read this first.** Updated at the end of every session.

**Written:** 2026-08-14 · **By:** session CE-0/CE-1 · **Branch:**
`feat/ce-1-clinical-foundation`

---

## Where we are

CE-0 complete. **CE-1: the schema is written and `prisma validate` is green.**
Nothing else in CE-1 exists yet — no migration has been generated or applied, so
the database on disk does not have these tables. Nothing is verified beyond the
schema parsing.

## The five things to know before typing

1. **Most of the foundation already exists.** `specialties` IS the clinical
   taxonomy. `clinical.encounter.*` and `clinical.prescription.*` already exist
   and are held by DOCTOR alone. `appointments.parent_appointment_id` already
   implements the follow-up chain. Read
   [EXISTING_ARCHITECTURE.md](EXISTING_ARCHITECTURE.md) before adding anything.

2. **The four CE-1 migrations are ordered, and the order is not cosmetic.** The
   enum members ship alone and first, because a CHECK cannot name a value added
   by `ALTER TYPE … ADD VALUE` in the same transaction. See SCHEMA.md.

3. **The episode backfill and its `SET NOT NULL` are ONE migration.** Splitting
   them leaves a window where `createAppointment` writes NULL and the second
   migration fails on live data.

4. **`pnpm typecheck` and `pnpm test` both OOM the api container.** Run per
   package or by path. Tests LAST and ONCE — CLAUDE.md's order of work.

5. **A configuration that says nothing checkable is an ERROR, not permissive.**
   CD-10. And test both the ABSENT descriptor and the EMPTY one — covering only
   the first is exactly the gap that let PI-5 ship a permissive typo.

## Next task

**CE-1.2 — the four migrations, in the order SCHEMA.md gives.** The enum members
ship ALONE and FIRST. Then masters, then episodes WITH the backfill and
`SET NOT NULL` in the same migration, then the recommendation CHECKs.

Hand-written SQL Prisma Migrate cannot generate, per migration:

| Migration | Hand-written SQL                                                                                                                                                                                                              |
| --------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| masters   | 3 × NULLS NOT DISTINCT rewrites · GIN trigram on `lower(name)` · partial unique on `is_primary` per (item, system) · RLS + `platform_rows_immutable` triggers · `specialty_visible` RESTRICTIVE policies on both scope tables |
| episodes  | the recursive-CTE backfill · `SET NOT NULL` · composite FK · RLS                                                                                                                                                              |
| recommend | the exactly-one-of CHECK · partial unique on `fulfilled_by_appointment_id` · partial index for the recall list · RLS                                                                                                          |

Then: `db:rls:check` (89 → 95), contracts, services, routes, seed, web, tests.

## Do not

- Do not rename `parent_appointment_id` (CD-12).
- Do not give a platform-extensible table the `files` RLS policy (CD-5).
- Do not put master-item ids inside a template `definition` document (CD-6).
- Do not let a fresh booking join the patient's most recent open episode (CD-13).
- Do not build the lab module. Investigations anticipate it; they do not connect.
- Do not add a specialty check to any component in `apps/web` (§33).
