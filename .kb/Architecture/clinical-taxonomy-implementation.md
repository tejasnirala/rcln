# Clinical Taxonomy — Implementation Progress

Living document. Update after every completed phase. A new session should read
this first, then **verify against the code** before trusting any claim here.

- **Branch:** `feat/phase-3-clinical-core`
- **Started:** 2026-08-08
- **Status:** **All phases complete, plus a follow-up round closing every
  deferred item.** 548 tests. Four bugs found and fixed (three pre-existing or
  self-inflicted, one found by re-checking the fix for another).
  Nothing is committed.

---

## The headline finding

**A hierarchical clinical taxonomy already exists in this codebase.** It is
called `Specialty`, it is a self-referencing adjacency list with `parentId`, and
it is already joined to doctors many-to-many through `DoctorSpecialty` with an
`isPrimary` flag.

Roughly 60–70% of the requested feature is built. The correct move is therefore
to **extend `specialties` in place**, not to introduce a parallel
`clinical_taxonomy_nodes` table. Building the second one would directly violate
the request's own Definition of Done ("no unnecessary duplicate
department/specialty systems") and CLAUDE.md's standing rule that inventing a
second way to do something is worse than the first way being imperfect.

The name `Specialty` stays. Renaming the table would churn the RLS stanza, the
`specialty_visible` RESTRICTIVE policy, the seed, the contracts, the web UI and
the planned `procedures.specialty_id` — for zero behavioural gain.

---

## Phase 1 — Architecture assessment (COMPLETE)

### Repository shape

pnpm monorepo, Turbo. `apps/api` (Express 5), `apps/web` (Next.js 16),
`apps/worker` (BullMQ). Packages: `db` (Prisma 7 + Postgres 16 + RLS),
`contracts` (Zod), `permissions` (RBAC codes + role matrix), `billing`,
`payments`, `config`.

### What already exists

| Concern                     | Where                                                                                            | State                                                                         |
| --------------------------- | ------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------- |
| Taxonomy node               | `Specialty` — `packages/db/prisma/schema.prisma:1613`                                            | Adjacency list, `parentId` self-FK, arbitrary depth already possible          |
| Platform + tenant catalogue | `Specialty.organizationId` nullable                                                              | NULL = platform row visible to every tenant; tenants may add their own        |
| Stable codes                | `Specialty.code`, `@@unique([organizationId, code])`                                             | Present, `NULLS NOT DISTINCT` in migration                                    |
| Soft delete / status        | `isActive`, `deletedAt`                                                                          | Present                                                                       |
| Audit timestamps            | `createdAt`, `updatedAt`                                                                         | Present                                                                       |
| Doctor ↔ taxonomy M2M       | `DoctorSpecialty` — schema:1718                                                                  | Present                                                                       |
| Primary classification      | `DoctorSpecialty.isPrimary`                                                                      | Present                                                                       |
| RLS                         | `enable-rls.sql:162` platform-extensible stanza + `specialty_visible` RESTRICTIVE policy at :195 | Present and carefully reasoned — read permissive, write NOT                   |
| Seed                        | `packages/db/prisma/seed.ts:478`                                                                 | ~50 specialties, two-pass parent linking by code                              |
| Permission code             | `DOCTOR_MASTER_MANAGE` (`packages/permissions/src/codes.ts:109`)                                 | Exists, granted to ORG_ADMIN/CLINIC_MANAGER — **but currently gates nothing** |
| Read gate                   | `GET /v1/doctors/masters` behind `DOCTOR_READ`                                                   | Present                                                                       |
| Service                     | `apps/api/src/services/doctor/doctor.service.ts` — `listMasters`, `assertSpecialtiesUsable`      | Present; validates active + primary-in-set                                    |
| Web                         | `apps/web/src/components/tenant/doctor-list.tsx:364`                                             | Flat `<select>` of every specialty, single "Main specialty"                   |

### Confirmed gaps

1. **No `type` / `description` / `displayOrder` / `metadata` columns** on
   `Specialty`. Requested by the spec; nothing equivalent exists.
2. **The seeded tree is flat and India-first.** There are no `DOMAIN` roots.
   `Dentistry`, `Physiotherapy`, `Ayurveda` and `Cardiology` are all top-level
   siblings — a modelling flaw, not just a gap. Max observed depth is 2.
3. **No ancestor/descendant traversal anywhere.** No recursive CTE, no
   `children` / `tree` / `ancestors` / `search` endpoints.
4. **No taxonomy CRUD endpoints at all.** `createSpecialtyRequest` exists in
   `packages/contracts/src/doctors.ts:135` and is **imported by nothing** — a
   defined-but-unwired contract. `DOCTOR_MASTER_MANAGE` guards no route.
5. **No cycle prevention.** Nothing stops `parentId = self` or an A→B→A cycle.
   This is a latent bug the moment a write path exists.
6. **`parent` uses `onDelete: SetNull`** — deleting a node silently orphans its
   subtree to the root.
7. **`DoctorSpecialty` has no proficiency, effective dates, or active flag.**
8. **Doctor filtering by specialty does not exist**, let alone
   descendant-aware filtering.
9. **Web UI is a single flat dropdown** — no cascading selector, no multi-select
   beyond the hidden `specialtyIds` array, no search.

### Concept separation — already correct, leave alone

The spec's four-way separation is already respected by the schema:

- **Organizational structure** → `Branch`, plus `StaffProfile.department`
  (free-text `VarChar(128)`, staff-only, unrelated to clinical taxonomy).
- **Clinical taxonomy** → `Specialty` ← this work.
- **Services / procedures** → not yet built; `procedures.specialty_id` is
  planned and will point here.
- **Qualifications / licences** → `Qualification` + `DoctorQualification`,
  already a separate table. Registration council/number live on
  `DoctorProfile`.

No merging or migration between these is needed. Nothing to untangle.

### Backward-compatibility assessment

- `Specialty` rows are referenced by `DoctorSpecialty` with
  `onDelete: Restrict` — existing assignments cannot be silently dropped.
- The seed upserts by `(organizationId, code)`, so **codes are the stable
  identity**. Re-parenting seeded rows under new `DOMAIN` roots is safe as long
  as codes are preserved. Codes must not be renamed.
- API response shape `specialtySummary` is consumed by `doctor-list.tsx` and
  `appointment-board.tsx`. New fields are additive; no field may be removed.
- `StaffProfile.department` is **not** part of this work and stays as-is.

### Recommended approach (for Phase 2 design sign-off)

- **Adjacency list stays.** At this scale (hundreds of nodes, single-digit
  depth) a closure table is unjustified complexity. Postgres `WITH RECURSIVE`
  handles ancestors/descendants fine, and Postgres 16 is already the floor.
- Add `type`, `description`, `displayOrder`, `metadata` to `Specialty`.
- Add `DOMAIN` roots and re-parent the existing seed into a global tree.
- Enforce acyclicity in the service layer plus a DB-level guard.
- Extend `DoctorSpecialty` with proficiency / effective dates / active flag.
- Wire the unused `createSpecialtyRequest` contract to real routes behind
  `DOCTOR_MASTER_MANAGE`.
- Descendant-aware doctor filtering via recursive CTE.

---

---

## Phase 2 — Database (COMPLETE)

Two migrations, both applied and verified against a real database.

### `20260808124153_clinical_taxonomy`

- Enums `TaxonomyNodeType` (DOMAIN…EXPERTISE) and `SpecialtyProficiency`.
- `specialties` + `type` (default `SPECIALTY`), `description`, `display_order`,
  `metadata` (JSONB).
- `specialties.parent_id` FK **SetNull → Restrict**. This is a behaviour change:
  SetNull silently promoted a deleted node's whole subtree to the root.
- `doctor_specialties` + `proficiency`, `effective_from`, `effective_to`,
  `is_active`, `updated_at`.
  `updated_at` used the nullable → backfill-from-`created_at` → SET NOT NULL
  sequence, because the table had rows.
- Indexes `specialties(parent_id)` — recursive CTEs seq-scan per level without
  it — and `specialties(organization_id, type)`.
- **Trigger `specialties_no_cycle`** rejects self-parenting and any re-parent
  that would close a cycle, with a 64-hop backstop for pre-existing corruption.
  ⚠️ Deliberately **not** owner-exempt, unlike the append-only triggers: a cycle
  is never legitimate, including from a seed or migration.
- **Partial unique index `specialties_sibling_name_key`** on
  `(organization_id, parent_id, lower(name)) NULLS NOT DISTINCT WHERE deleted_at
IS NULL`. NULLS NOT DISTINCT matters twice — platform rows and root nodes.

### `20260808130500_drop_redundant_primary_specialty_index`

The taxonomy migration added a one-primary-per-doctor index that **already
existed** as `doctor_specialties_one_primary` from the doctors migration. The
older, narrower one is kept. Written as a second migration rather than an edit,
because the first was already applied and Prisma checksums it.

### No RLS changes — checked, not assumed

This phase adds **no tables**, so it adds no policies. `specialties` was already
in the `platform_extensible` array and `doctor_specialties` in `org_scoped` plus
the RESTRICTIVE `specialty_visible` policy. `db:rls:check` passes: 41 tenant
tables protected.

### Verified behaviour (executed, not assumed)

| Guard                                      | Result                                                  |
| ------------------------------------------ | ------------------------------------------------------- |
| Self-parent                                | `ERROR: specialty … cannot be its own parent`           |
| Indirect cycle (re-parent under own child) | `ERROR: … cannot be a descendant of itself`             |
| Duplicate sibling name, different case     | `ERROR: duplicate key … specialties_sibling_name_key`   |
| Delete a node that has children            | `ERROR: … violates foreign key constraint`              |
| Second primary for one doctor              | `ERROR: duplicate key … doctor_specialties_one_primary` |

### Test change

`apps/api/tests/integration/tenant-isolation.test.ts` — both raw inserts in
"the second parent of a join table" now supply `updated_at`. The negative test
was passing only because RLS happened to fire before the NOT NULL constraint;
it would have kept passing with the policy dropped.

### Gates

- `pnpm validate` — typecheck 13/13, lint 13/13, tests 502/502 in `@rcln/api`.
- `pnpm db:rls:check` — passed, 41 tables.
- All six containers running.

---

---

## Phase 3 — Seed (COMPLETE)

`packages/db/prisma/seed.ts`. **148 platform nodes**, up from 48.

### Seven domains, not six

`MED`, `DEN`, `MBH`, `ALH`, `DGN`, `REH` — plus **`TRAD`** (Traditional &
Complementary Medicine), which the brief did not name. Ayurveda and Homeopathy
already existed as top-level rows; filing them under `MED` would assert they are
allopathic specialties. `TRAD` also generalises past India — it now holds Unani,
Siddha, Naturopathy, Yoga Therapy, Acupuncture, Chiropractic, Osteopathic
Medicine and TCM.

Distribution: 7 DOMAIN · 22 DEPARTMENT · 56 SPECIALTY · 55 SUB_SPECIALTY ·
8 FOCUS_AREA. Depth varies by branch and nothing depends on it — Structural
Heart Disease is 4 deep (`MED → CARDIOLOGY → INTERVENTIONAL_CARDIOLOGY → …`),
Endodontics is 2 (`DEN → ENDODONTICS`).

### Codes stayed flat — a deliberate deviation from the brief

The brief suggested `MED-CARD-INTERVENTIONAL`. This uses `INTERVENTIONAL_CARDIOLOGY`.

1. `createSpecialtyRequest` already validates `/^[A-Z0-9_]+$/`; hyphens are
   rejected for tenant-authored codes and the platform catalogue must not be
   spelled differently from rows clinics add beside it.
2. **A path-encoded code becomes a lie the moment a node moves.** Re-parenting
   Sleep Medicine from Pulmonology to Neurology would demand a code change; the
   code is the seed's upsert key and what `doctor_specialties` was written
   against, so the rename silently forks the node in two. The path is `parent_id`.

### Backward compatibility — verified by query, not by reading

All **48 original codes preserved**, none renamed, **zero orphans**, and the
existing `doctor_specialties` row still resolves. Re-running the seed leaves the
count at 148 (idempotent).

`DENTISTRY` is **repurposed, not replaced**: it was the dental root; `DEN` is now
that root and `DENTISTRY` became the "General Dentistry" leaf under it. The code
is untouched deliberately — a doctor tagged `DENTISTRY` meant "a dentist,
unspecified", which is exactly General Dentistry. Renaming the code would have
orphaned those rows.

### The two-pass seed had to go

⚠️ The old seed inserted every node flat and re-parented in a second pass. That
is now **unsafe**: `specialties_sibling_name_key` is unique on
`(organization_id, parent_id, lower(name)) NULLS NOT DISTINCT`, so while every
row briefly had `parent_id NULL`, **every name in the file was a sibling of every
other**. It would have started failing the first time two nodes anywhere in the
tree shared a name — legal for nodes under different parents.

Replaced with a memoised `ensureNode(code)` that resolves a parent before writing
its child, so a row is never persisted parentless. List order still does not
matter. An `inFlight` set catches a typo'd parent code that closes a loop with a
legible error instead of a stack overflow.

### Judgement calls worth knowing about

- **Psychiatry is under `MBH`, not `MED`.** It is genuinely both, and a
  single-parent tree forces a choice. Someone browsing mental health would
  consider its absence a bug; someone browsing Medical is not surprised by one
  sideways step. If cross-listing is ever needed it is a second edge — a join
  table — never a duplicate node with a second code.
- **Radiology (DGN) vs Radiography (ALH)** and **Pathology (DGN) vs Medical
  Laboratory Technology (ALH)** are separate nodes: the physician specialty that
  reports, and the allied profession that acquires. Both carry a `description`
  saying so.
- **Sports Medicine** stays under Orthopaedics (its existing parent, unchanged);
  **Sports Rehabilitation** is a new FOCUS_AREA under Physiotherapy.
- **Nursing is deliberately absent.** A nurse's grade is a job title, already
  modelled as a `designations` row. Adding it here creates the second answer to
  "what is this person" that this work exists to avoid.
- **Qualifications were left alone.** `BAMS`/`BHMS`/`BUMS` are India-specific,
  but credentials and country licensing are explicitly a separate system.

### Gates

Typecheck 13/13, lint 13/13, `@rcln/api` 502/502, seed idempotent.

---

---

## Phase 4 — Taxonomy APIs (COMPLETE)

### Files

| File                                                        | Change                                                                                                     |
| ----------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `packages/contracts/src/clinical-taxonomy.ts`               | New. Node/tree/ancestor/search schemas                                                                     |
| `packages/contracts/src/doctors.ts`                         | `specialtySummary` + `type`/`description`/`displayOrder` (additive); dead `createSpecialtyRequest` removed |
| `packages/contracts/src/index.ts`                           | Export the new module                                                                                      |
| `apps/api/src/services/doctor/clinical-taxonomy.service.ts` | New. Traversal, search, curation                                                                           |
| `apps/api/src/routes/v1/clinical-taxonomy.routes.ts`        | New                                                                                                        |
| `apps/api/src/routes/v1/index.ts`                           | Mount `/clinical-taxonomy`                                                                                 |
| `apps/api/src/services/doctor/doctor.service.ts`            | `listMasters` selects and orders by the new columns                                                        |

### Endpoints — all verified with real HTTP calls

| Method | Path                                                    | Gate                   |
| ------ | ------------------------------------------------------- | ---------------------- |
| GET    | `/v1/clinical-taxonomy`                                 | `DOCTOR_READ`          |
| GET    | `/v1/clinical-taxonomy/search?q=&underId=&type=&limit=` | `DOCTOR_READ`          |
| GET    | `/v1/clinical-taxonomy/:nodeId/children`                | `DOCTOR_READ`          |
| GET    | `/v1/clinical-taxonomy/:nodeId/tree`                    | `DOCTOR_READ`          |
| GET    | `/v1/clinical-taxonomy/:nodeId/ancestors`               | `DOCTOR_READ`          |
| POST   | `/v1/clinical-taxonomy`                                 | `DOCTOR_MASTER_MANAGE` |
| PATCH  | `/v1/clinical-taxonomy/:nodeId`                         | `DOCTOR_MASTER_MANAGE` |
| DELETE | `/v1/clinical-taxonomy/:nodeId` (deactivate)            | `DOCTOR_MASTER_MANAGE` |

No new permission codes. `DOCTOR_MASTER_MANAGE` existed and, until now, gated
nothing at all.

### Platform rows are protected twice

> **Correction.** This section originally claimed RLS does _not_ stop a tenant
> updating a platform row, and that `assertMutable()` was the only control. That
> was **wrong**, and the Phase 10 tenant-isolation test is what disproved it.
> Recorded here rather than quietly edited, because the wrong version was
> reasoned from the policy and sounded right.

`tenant_isolation` on `specialties` is:

```sql
USING      (organization_id IS NULL OR organization_id = app_current_org())
WITH CHECK (organization_id = app_current_org())
```

The permissive `USING` is what lets every clinic read the platform catalogue. It
is tempting to conclude that an UPDATE against a platform id therefore goes
through — the row is visible, so the statement finds it. **It does find it, and
then fails the `WITH CHECK`**, which is evaluated against the row as it would be
_after_ the write: a platform row's `organization_id` stays NULL. Postgres
refuses it.

So there are two layers, and neither is redundant:

1. **RLS** refuses the write. Authoritative.
2. **`assertMutable()`** runs first so the caller gets a 400 explaining the
   catalogue is platform-wide, rather than an opaque row-level-security error.

⚠️ Copying the NULL-permissive `WITH CHECK` from `files` onto this table would
delete layer 1 and leave only the service check. The `Specialty` schema comment
warns about this; `tenant-isolation.test.ts` is what would catch it.

### Design notes

- **Adjacency list + `WITH RECURSIVE`**, no closure table. ~150 nodes, five
  levels; `specialties_parent_id_idx` makes each recursion level an index lookup.
  A closure table would add a second structure to keep consistent on every
  re-parent — a class of drift bug for microseconds.
- `descendantRows()` is shared by the tree endpoint and (in Phase 7) by
  descendant-aware doctor filtering, so the two cannot disagree about what
  "under Cardiology" means.
- `hasChildren` and `depth` are computed in SQL — otherwise a tree render is an
  N+1.
- Unknown or other-tenant node id → **404, never 403**. RLS has already filtered
  it out, so it is genuinely indistinguishable from a node that does not exist.
- `/search` is declared **before** `/:nodeId` — Express matches in declaration
  order and would otherwise answer "not a uuid".
- Deactivation refuses if the node has active children or assigned doctors.
  Refusal rather than cascade: neither is undoable from one click.

### Two real bugs found and fixed during verification

1. **Backticks inside SQL comments in a `$queryRaw` template literal terminated
   the template**, so the API container crash-looped. `pnpm typecheck` caught the
   syntax error, but the container had already died and stayed dead — the
   "confirm the container actually stayed up" rule earning its place.
2. **Prisma 7's pg adapter does not populate `meta.target`.** A P2002 arrives as
   `meta.driverAdapterError.cause.originalMessage`. Matching on `err.message` or
   `meta.target` (the Prisma 5/6 shape) silently never fired, so the
   sibling-name collision fell through to the generic "A record with this value
   already exists". `translateWriteError` now serialises the whole `meta`.

### Verified by HTTP, not by inspection

```
GET  /clinical-taxonomy                     → 7 domains
GET  /search?q=cardio                       → 4 hits, each with depth + type
GET  /:id/ancestors  (Structural Heart)     → Medical > Cardiology >
                                              Interventional Cardiology >
                                              Structural Heart Disease
GET  /:id/children   (Cardiology)           → 3, hasChildren flags correct
GET  /:id/tree       (Cardiology)           → nested to depth 2
POST /                                      → 201
PATCH /:id (own node)                       → 200
DELETE /:id (own node)                      → 200
PATCH /:id (PLATFORM node)                  → 400 refused
POST duplicate sibling name (diff case)     → 409
POST duplicate code                         → 409
PATCH parentId = self                       → 400
GET  unknown node id                        → 404
no auth                                     → 401
unknown tenant                              → 404 (never 403)
q too short                                 → 400
GET /doctors/masters                        → 148 specialties, new fields present
```

### Gates

Typecheck 13/13, lint 13/13, `@rcln/api` 502/502, `db:rls:check` 41 tables.

---

---

## Phase 5 — Doctor APIs (COMPLETE)

### Two request forms, never both

`specialtyIds: uuid[]` (unchanged, still what the current screens send) and the
richer `classifications: [{ specialtyId, proficiency?, effectiveFrom?,
effectiveTo? }]`. Supplying both is **rejected outright** rather than resolved by
precedence — two fields describing one set is how a client "saves" specialties
that silently do not persist.

### 🐛 Pre-existing data-loss bug found and fixed

**`PATCH /v1/doctors/:id` with only a `bio` deleted every one of that doctor's
specialties.** 200 OK, no error, classifications simply gone.

`.partial()` makes a key optional but does **not** suppress a `.default()`
nested inside it:

```ts
z.object({ specialtyIds: z.array(uuid).default([]) })
  .partial()
  .parse({ bio: 'x' }); // → { bio: 'x', specialtyIds: [] }
```

The service reads "specialtyIds supplied" as "replace the set with exactly
this", so every partial update carried an empty set. Verified by probing the
parser directly, not inferred.

Fixed by redeclaring `specialtyIds` without its default in
`updateDoctorFields`. Absent now means "leave alone"; `[]` means "clear".
**Do not tidy that redeclaration back into inheriting the create shape.**

This predates the taxonomy work — the same shape existed before Phase 1.

### Assignments are reconciled, not deleted-and-recreated

The old path dropped every `doctor_specialties` row and re-inserted the set.
Harmless while a row was two FKs and a flag; **not** harmless now that it carries
`proficiency`, `effectiveFrom`, `effectiveTo` and its own `createdAt` — wiping
and rewriting turns "specialist here since 2019" into "recorded just now" on
every unrelated edit, and reports every classification as changed in the audit
trail on every save.

`reconcileClassifications()` diffs instead. Verified: row ids and `effectiveFrom`
survive a primary change.

⚠️ It clears **all** primaries before setting the new one. The
`doctor_specialties_one_primary` partial unique index would otherwise reject a
legitimate primary move depending on row iteration order.

### The inactive-node asymmetry

`assertSpecialtiesUsable` requires **only newly added** nodes to be active.
Existing assignments to a since-retired node are kept.

Checking the whole set instead would make every affected doctor's profile
unsaveable after one node is retired: the next unrelated bio edit fails
validation on a specialty the user never touched, with no way forward but
silently dropping a true fact about their training.

### Ancestors are derived, never materialised — DECISION

Tagging a doctor with Structural Heart Disease does **not** write rows for
Interventional Cardiology and Cardiology. Materialising would copy the tree into
the join table, and re-parenting a node would then silently invalidate every row
written before the move. `GET /clinical-taxonomy/:id/ancestors` renders the
chain, and Phase 7's descendant filter finds the doctor under Cardiology anyway
— which is the actual requirement.

### Verified over HTTP

```
POST classifications w/ proficiency + effectiveFrom  → 201
both request forms supplied                          → 400
primary not in the supplied set                      → 400
effectiveTo before effectiveFrom                     → 400
same node twice                                      → 400
PATCH bio only  → classifications intact, SAME row ids
PATCH primary move → row ids persist, effectiveFrom preserved
PATCH specialtyIds: []  → clears (explicit, still works)
newly assigning a retired node                       → 400
existing assignment to a retired node                → kept, re-save succeeds
```

### Gates

Typecheck 13/13, lint 13/13, `@rcln/api` 502/502, `db:rls:check` 41 tables.

---

## Phase 7 — Descendant-aware filtering (COMPLETE)

Done **before** Phase 6 on purpose: the doctor-list screen is the same screen
that needs the filter, and building the UI first means touching it twice.

`GET /v1/doctors?specialtyId=&includeDescendants=&status=`

### It reuses `descendantRows`, and that is the point

The subtree is resolved through the **existing** helper in
`clinical-taxonomy.service.ts`, not a second recursive CTE written in
`doctor.service.ts`. Two copies of that query is exactly how the filter and
`GET /clinical-taxonomy/:id/tree` would start disagreeing about what is "under
Cardiology".

- `includeSelf: true` — a doctor tagged Cardiology **itself** must match a
  Cardiology filter. Easy to lose when thinking only about children.
- `includeInactive: true` in the subtree walk — a retired sub-specialty still has
  doctors attached (see the Phase 5 asymmetry). Excluding it would make a doctor
  vanish from the directory because of a curation decision about a _node_, not
  about them.
- An unseeable id yields an empty subtree and returns **no doctors**. Falling
  through to "no filter" there would have listed everybody — the failure mode
  worth guarding, since it looks like success.

### ⚠️ Never a string match

A doctor tagged only "Structural Heart Disease" contains the word "cardio"
nowhere in their record. `LIKE '%cardio%'` cannot answer "find me a
cardiologist"; the subtree can.

### Verified over HTTP — doctor tagged ONLY the deepest leaf

| Filter                                 | Result |
| -------------------------------------- | ------ |
| Medical (domain, 3 levels up)          | 1 ✓    |
| Cardiology (2 up)                      | 1 ✓    |
| Interventional Cardiology (parent)     | 1 ✓    |
| Structural Heart Disease (exact)       | 1 ✓    |
| Cardiology, `includeDescendants=false` | 0 ✓    |
| Dental (other domain)                  | 0 ✓    |
| no filter                              | 1 ✓    |

Directionality also checked: a doctor tagged **Cardiology itself** matches a
Cardiology filter but **not** a Structural Heart Disease filter — asking for a
structural-heart specialist must not return a general cardiologist.

Unknown `specialtyId` → 0 doctors (not all). Malformed → 400.

### Gates

Typecheck 13/13, lint 13/13, `@rcln/api` 502/502, `db:rls:check` 41 tables.

---

## Phase 10 — Testing (COMPLETE)

**544 tests across 19 suites**, up from 502 across 18. Done before Phase 6 on
purpose: three real bugs slipped past a green typecheck and 502 passing tests in
this work, and none of that verification was repeatable.

### New: `apps/api/tests/integration/clinical-taxonomy.test.ts` — 35 tests

Two tenants over real HTTP through the real middleware chain. Covers traversal
at two different depths through one code path, search and ranking, subtree
scoping, per-tenant catalogue isolation, every validation refusal, deactivation
semantics, and descendant-aware doctor filtering.

The filtering block is the one that matters most: the doctor is tagged with
exactly one node four levels down, and the string "cardio" appears nowhere in
their record. **Every assertion there fails against a `LIKE` implementation.**

### New in `tenant-isolation.test.ts` — 7 tests

The tree's structural guards at the **database**, under a tenant connection:
self-parent, cycle-through-descendant, `ON DELETE RESTRICT` refusing to orphan a
subtree, sibling-name uniqueness _and_ its scoping (same name under a different
parent must be allowed — otherwise the suite passes against a global unique),
platform-row UPDATE refusal, and platform-row INSERT refusal.

### 🐛 Third bug found — by the tests, not by inspection

`loadNode()` hardcoded `0 AS depth`. It supplies the response body for POST and
PATCH, so **creating a node three levels down answered `depth: 0`** while every
other endpoint reported it correctly. A cascading selector reading the create
response would file a new sub-specialty under the domain column. Fixed with a
recursive walk up; two regression tests pin it.

### ✅ One claim of mine disproved — see the Phase 4 correction above

The test asserting "RLS does not stop a tenant updating a platform row" **failed**,
because RLS does stop it. The `WITH CHECK` is evaluated post-write and a platform
row's `organization_id` stays NULL. Comments in the service, the routes and this
document have been corrected.

### Gates

Typecheck 13/13, lint 13/13, **`@rcln/api` 544/544**, `db:rls:check` 41 tables.

---

## Phase 6 — Frontend (COMPLETE)

### No new design direction, deliberately

`apps/web/AGENTS.md` settles this before the skill gets a say: the direction is
decided once and reused, and **dense data-entry screens stay quiet and
conventional** — boldness belongs in the shell and the empty states. So: no new
palette, no new type scale, no new tokens. Everything comes from `globals.css`.
The effort went into interaction instead.

### The signature: a classification is a path, not a label

Every selected entry renders its ancestry above its name —
`Medical › Cardiology › Interventional Cardiology` over **Structural Heart
Disease**. That is the one idea the feature exists to express, and the flat
`<select>` it replaces could not express it at all: "Sports Medicine" (under
Orthopaedics) and "Sports Rehabilitation" (under Physiotherapy) are only
distinguishable by where they hang.

### Files

| File                                                       | Change                                                          |
| ---------------------------------------------------------- | --------------------------------------------------------------- |
| `apps/web/src/lib/taxonomy.ts`                             | New. Pure tree helpers over the flat catalogue                  |
| `apps/web/src/components/tenant/classification-picker.tsx` | New. Cascading columns + search + multi-select with a primary   |
| `apps/web/src/components/tenant/doctor-list.tsx`           | Picker on both forms; subtree filter on the roster              |
| `.../doctors/actions.ts`                                   | Reads repeated `specialtyIds`; update now sends classifications |

### ⚠️ No new fetches — the tree is already on the page

`/api/v1/doctors/masters` already returns every visible node with `parentId`,
`type` and `displayOrder`, and the page already awaits it. The whole tree is in
memory before the user clicks anything, so the picker drills instantly.

The alternative the API also supports — `/clinical-taxonomy` for roots, then
`/:id/children` per drill-down — is right for a large or lazily-loaded tree.
Here it would put a spinner between "Medical" and "Cardiology" to re-fetch ~150
rows already present. `lib/taxonomy.ts` is the only module that changes if the
catalogue ever outgrows this.

### Column headings come from the data

⚠️ Never from position. Dental reaches a specialty in two hops, Cardiology in
four — a third column hardcoded to "Sub-specialty" would be wrong for half the
tree. `columnLabel()` reads the `type` of the nodes actually in the column, and
falls back to a neutral heading when a column is mixed (Cardiology is a
DEPARTMENT sitting beside Nephrology, a SPECIALTY, under Medical).

### A node with children is still selectable

The chevron opens; a separate `+` picks the node itself. Without the split,
choosing a parent would be impossible for exactly the broad categories most
doctors have — a doctor may be "a cardiologist" with no sub-specialty at all.

### ⚠️ The hidden sentinel is load-bearing

With an empty selection the picker renders no `specialtyIds` inputs, which on
the wire is **indistinguishable from a form that never contained a picker**. The
first means "remove every classification"; the second means "leave them alone".
`classificationsPresent` marks the difference. Without it, removing a doctor's
last classification would silently do nothing.

### Roster filter

A `Select` above the list, filtering by **subtree** via `subtreeIds()` — the
client mirror of `GET /doctors?specialtyId=`. Options are limited to nodes some
doctor is actually under (including their ancestors); a filter offering 148
options of which 140 return nothing is worse than no filter. Filtering happens
client-side because the roster is already rendered — a round trip would only
flash the list.

### Also fixed here

`createDoctor` sent `[primarySpecialtyId]` — one specialty at creation. It now
sends the full set: a cardiologist who is also an electrophysiologist should not
have to save and come back.

### Verified

Typecheck 13/13, lint 13/13 (zero warnings), `@rcln/api` 544/544, **`@rcln/web`
production build succeeds**, all six containers up, `/doctors` serving 200 with
no runtime errors in the web logs.

Browser/interaction testing is the user's, per standing preference.

---

## Phase status ledger

| Phase | Name                | Status                                                           |
| ----- | ------------------- | ---------------------------------------------------------------- |
| 1     | Assessment & design | **Complete**                                                     |
| 2     | Database            | **Complete** — migrated, guards verified                         |
| 3     | Seed taxonomy       | **Complete** — 148 nodes, 48 originals preserved                 |
| 4     | Taxonomy APIs       | **Complete** — 8 endpoints, verified over HTTP                   |
| 5     | Doctor APIs         | **Complete** — two forms, reconciliation, pre-existing bug fixed |
| 7     | Search & filtering  | **Complete** — done before 6 deliberately                        |
| 6     | Frontend            | **Complete** — cascading picker, subtree filter                  |
| 8     | Authorization       | **Complete** — no new codes, test-covered                        |
| 9     | Validation          | **Complete** — DB + service, test-covered                        |
| 10    | Testing             | **Complete** — 544 tests, 19 suites                              |
| 11    | Documentation       | **Complete** — this doc + `pnpm kb` regenerated                  |
| 6     | Frontend            | Not started                                                      |
| 7     | Search & filtering  | Not started                                                      |
| 8     | Authorization       | Not started (codes exist, unwired)                               |
| 9     | Validation          | Not started                                                      |
| 10    | Testing             | Not started                                                      |
| 11    | Documentation       | This document                                                    |

## Decisions already made

- **D1.** Extend `Specialty`; do **not** create `ClinicalTaxonomyNode`. The
  existing model is the taxonomy.
- **D2.** Keep the table name `specialties` and all existing codes.
- **D3.** Adjacency list + `WITH RECURSIVE`, not a closure table.
- **D4.** Reuse `DOCTOR_MASTER_MANAGE` / `DOCTOR_READ`; no new RBAC system.
- **D5.** Seed strategy: keep all ~48 existing codes and their identity, add
  DOMAIN roots, re-parent, then expand. Codes are the stable identity the seed
  upserts on — **codes must never be renamed**.
- **D6.** `type` is a descriptive label for UI and reporting only. Nothing
  derives depth from it, and authorization must never branch on it.
- **D7.** `proficiency` is advisory/display-only, never an authorization input.
- **D8.** `DoctorSpecialty.isActive` is not derived from `effectiveTo`. A lapsed
  fellowship and a mistaken entry are different facts.
- **D9.** **Ancestors stay DERIVED, never materialised.** Raised twice, and
  confirmed explicitly by the product owner after the alternatives were laid out
  (store-and-sync, or store-at-write). Assigning a node writes exactly one
  `doctor_specialties` row; the chain is computed from `parent_id` on read.
  Store-at-write was rejected because re-parenting a node leaves rows written
  before the move asserting a chain that is no longer true — two doctors with the
  same specialty showing different ancestry, with nothing to detect it.
  Store-and-sync was rejected as a denormalised cache with invalidation to
  maintain, for no gain over one recursive CTE per request.
  ⚠️ `clinical-taxonomy.test.ts` asserts the row count stays at 1 for a doctor
  with one classification. That test is the guard on this decision — if it
  starts failing, something has begun writing ancestor rows.

## Migrations performed

| Migration                                               | State   |
| ------------------------------------------------------- | ------- |
| `20260808124153_clinical_taxonomy`                      | Applied |
| `20260808130500_drop_redundant_primary_specialty_index` | Applied |

## Known issues

- **Pre-existing, not caused by this work:** `@rcln/billing` test suite fails
  with `Cannot find module '@prisma/client-runtime-utils'` from the generated
  client. Confirmed by stashing the schema change and reproducing on the
  pristine schema. A Prisma 7.9 + Jest module-resolution issue;
  `packages/db/generated/` is gitignored so it regenerates per machine.
  18 assertions in that package still pass; 1 of 2 suites cannot start.
- `createSpecialtyRequest` is still dead code until Phase 4.
- Taxonomy-specific `tenant-isolation.test.ts` cases (cycle trigger, sibling
  uniqueness under a tenant context) are Phase 10, not yet written.

## Definition of done

Every item from the original brief:

| Requirement                        | State                                               |
| ---------------------------------- | --------------------------------------------------- |
| Generic hierarchical taxonomy      | ✅ `specialties`, adjacency list                    |
| Arbitrary depth                    | ✅ 2–4 levels in the seed, nothing assumes a number |
| Initial global taxonomy seeded     | ✅ 148 nodes, 7 domains                             |
| Doctor ↔ taxonomy many-to-many     | ✅ `doctor_specialties`                             |
| Primary classification             | ✅ + partial unique index                           |
| Multiple classifications           | ✅                                                  |
| Existing data migrated safely      | ✅ 48 codes preserved, verified by query            |
| Backend APIs                       | ✅ 8 taxonomy endpoints                             |
| Taxonomy search                    | ✅ + prefix ranking, subtree scoping                |
| Ancestor/descendant traversal      | ✅ recursive CTEs                                   |
| Doctor filtering by hierarchy      | ✅ subtree, never string match                      |
| Create/edit UI                     | ✅ cascading picker                                 |
| Authorization                      | ✅ existing codes, no second system                 |
| Validation                         | ✅ database + service                               |
| Automated tests                    | ✅ 544                                              |
| Documentation                      | ✅ this doc + `pnpm kb`                             |
| Existing functionality still works | ✅ 544/544, web build green                         |
| No duplicate specialty system      | ✅ extended, not duplicated                         |

## Follow-up round (all three deferred items closed)

### 1. Proficiency and effective dates now have a UI ✅

Behind an **"Add detail" disclosure per row**, not inline — three more controls
on every row would triple the height of the one thing the screen exists to do,
and all three are optional. A row with detail recorded shows a one-line summary
(`Expert · since 2019-04-01`) so the disclosure need not be opened to see that
something is there.

⚠️ The picker now submits **one JSON field**, not repeated `specialtyIds`.
Indexed input names (`classifications[0][effectiveFrom]`) have to be reassembled
by hand and silently renumber when a middle row is removed. The JSON is
**re-validated by the same Zod schema the API enforces** — parsing only turns a
string into something the schema can inspect; nothing is trusted for being
well-formed.

### 2. Ancestors: derived chain now on the doctor payload ✅ (still not stored)

`doctorSpecialtyDetail.ancestors` returns the root-first chain, so a client
renders `Medical › Cardiology › Interventional Cardiology › Structural Heart
Disease` from one call. This is what the brief asks for — "do not require
clients to provide redundant ancestors if the backend can derive them".

⚠️ Resolved by **one recursive CTE for the whole page**, not one per doctor. A
walk per classification is 120 round trips on a roster of 40 doctors with three
specialties each.

**Not materialised as rows — confirmed by the product owner** after the two
alternatives (store-and-sync, store-at-write) were laid out with their costs.
See D9. A test asserts the row count stays at 1 for a doctor with one
classification, so a future change that starts writing ancestor rows fails
loudly.

### 3. Qualifications are now multi-jurisdiction ✅

**27 → 68 entries.** Was India-only (MBBS/MD/MS/DNB/BAMS), which quietly made
the product India-only too: a clinic in Nairobi or Dubai opening the picker
found nothing their doctors hold. Added entry degrees (MD-US, DO, MBChB,
MB BCh BAO), board certification and college fellowships (FRCP, MRCS, MRCGP,
FACS, FACP, FRACP, FRCPC, FCPS, European CCT), dental (DDS, DMD), allied health
(DPT, MOT, AuD, PharmD, DPM), mental health (PsyD, MSW) and nursing (RN, NP).

⚠️ **No code renamed** — the seed upserts on `(organization_id, code)` and
`doctor_qualifications` rows point at these ids. Verified: all 27 originals
still present.

Licensing stays separate (`doctor_profiles.registration_number` /
`registration_council`): a licence is jurisdiction-specific and expires, a
degree does neither. `QUALIFICATIONS` carries a header warning never to let this
list drift into being the taxonomy.

---

## 🐛 A fourth bug, found while re-checking the other three

**`depth` was hardcoded per endpoint, in three places, not one.** I fixed only
the `loadNode` instance the first time and reported the bug closed. Re-checking
showed `listChildren` returning a literal `1` and `getSubtree` counting from its
own root, so **one node answered a different depth depending on which endpoint
was asked**:

| Endpoint        | Interventional Cardiology |
| --------------- | ------------------------- |
| `/search`       | 2 ✅                      |
| `/:id/children` | 1 ❌                      |
| `/:id/tree`     | 1 ❌                      |

The contract defines depth as distance from the tree root. Anything relative is
a lie to a caller that indents a row or labels a column from it. All three now
compute absolute depth, and a regression test asserts **the same node reports
the same depth from all four endpoints**.

⚠️ `descendantRows` keeps a separate `rel` column for its `includeSelf` filter.
Filtering on absolute depth would drop the entire subtree whenever its root was
a domain, and nothing otherwise — a bug that only appears for one input.

### The backtick trap, third occurrence

Backticks inside a SQL comment terminate the `$queryRaw` template literal. It
cost a crash-looped container in Phase 4 and a failed suite here. **Never put a
backtick in a SQL comment in this codebase** — all of them have been stripped.

## Exact recommended next step

Nothing is committed. Review the diff, then commit — this is a large change
across schema, seed, API, web and tests, and it has never been through
`/code-review`.

Suggested: `/code-review` (both reviewer subagents), then commit on
`feat/phase-3-clinical-core`.

Worth a reviewer's attention specifically:

- `packages/db/prisma/migrations/20260808124153_clinical_taxonomy/` — the FK
  change from SetNull to Restrict is a behaviour change on an existing table.
- `apps/api/src/services/doctor/clinical-taxonomy.service.ts` — raw SQL. All of
  it is parameterised through Prisma's tagged template; no `$queryRawUnsafe`.
- `packages/contracts/src/doctors.ts` — the `specialtyIds` redeclaration on the
  update shape is the fix for a live data-loss bug. It looks like redundancy.
