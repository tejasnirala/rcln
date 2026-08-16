# What the repository already has

Read this before adding anything. CE-0's finding was that the repository is much
further along than the brief assumes, and **re-inventing what is here is the
main risk to this programme.**

Everything below was read from the schema, routes and components — not from the
documentation.

---

## Reuse as-is — no new table, no new code

| Need (brief §)              | What exists                                                                                   | Where                                                      |
| --------------------------- | --------------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| Clinical hierarchy (§3)     | **`specialties`** — arbitrary-depth `parent_id` tree, platform rows + tenant extension        | `doctors.prisma`                                           |
| Doctor classification (§3)  | `doctor_specialties` — many-to-many, `is_primary` via partial unique index, proficiency label | `doctors.prisma`                                           |
| Taxonomy CRUD + search      | `GET/POST/PATCH/DELETE /v1/clinical-taxonomy/*`, descendant walks, deactivation guards        | `clinical-taxonomy.routes.ts`                              |
| Patient + chart (§6A)       | `patients`, `patient_registrations`, `_allergies`, `_conditions`, `_medications`              | `patients.prisma`                                          |
| Appointment (§5)            | `appointments` — status machine, GiST no-overlap, `booked_fee` frozen at booking              | `scheduling.prisma`                                        |
| Follow-up chain (§19)       | **`appointments.parent_appointment_id`** + `createFollowUp`                                   | see [FOLLOW_UP_ARCHITECTURE.md](FOLLOW_UP_ARCHITECTURE.md) |
| Vitals (§5)                 | `appointment_vitals` — append-only, many per appointment, PHI-logged                          | `scheduling.prisma`                                        |
| Medicines (§11)             | `products` + `medicine_details` — dosage form, route, release type, `default_course_days`     | `products.prisma` (PI-1)                                   |
| Stock behind a prescription | `stock_balances`, `stock_reservations`, FEFO allocation                                       | `packages/inventory` (PI-2/PI-3)                           |
| Files (§17)                 | `stored_files` + `DocumentService`, provider-abstracted storage, no URL column                | `settings-files-audit.prisma`                              |
| Audit (§38)                 | `audit_logs` (immutable) + `data_access_logs` (PHI reads, dedupe window)                      | `settings-files-audit.prisma`                              |
| Numbering                   | `number_sequences` — per branch, per period, `ON CONFLICT DO UPDATE`                          | `numbering.prisma`                                         |
| Settings resolver           | `setting_definitions` / `setting_values`, org → branch cascade                                | `services/settings`                                        |
| RBAC (§31)                  | see below — **already stricter than the brief asks for**                                      | `packages/permissions`                                     |
| The consultation route      | live, with a documented placeholder where the form goes                                       | `appointments/[appointmentId]/page.tsx`                    |

---

## ⚠️ `specialties` IS the clinical hierarchy the brief asks for

The brief (§3) asks for `Care Context → Clinical Domain → Specialty →
Sub-specialty`, arbitrary depth, doctors classified against it.

That is `specialties`, shipped. From its own enum comment:

> ⚠️ THIS IS A LABEL, NOT A DEPTH. Nothing in the database or the services
> asserts that a SUB_SPECIALTY sits exactly three levels down, and nothing
> should start. The tree's shape is `parent_id` and only `parent_id`. […] A
> branch that needs four levels and one that needs two are the same shape to
> every query here, which is the whole point.

`TaxonomyNodeType` = `DOMAIN | DEPARTMENT | SPECIALTY | SUB_SPECIALTY |
FOCUS_AREA | EXPERTISE`. It is presentation and grouping metadata; **never
branch authorization on it.**

**What CE-1 adds:** one enum member, `CARE_CONTEXT`, and a re-parent of the
seeded roots under `HUMAN`. Nothing else. See CD-3.

---

## ⚠️ The permission split already exists, and is stricter than the brief

`packages/permissions/src/codes.ts` already declares:

```text
clinical.encounter.read     clinical.encounter.create    clinical.encounter.close
clinical.prescription.read  clinical.prescription.create clinical.prescription.sign
clinical.vitals.read        clinical.vitals.record
clinical.master.manage
lab.order.read              lab.order.create             lab.result.*
```

**None of them gates anything yet. They were declared for this work.**

Invariant 7, from `roles.ts` — and it goes beyond §31:

> `ENCOUNTER_CREATE`, `ENCOUNTER_CLOSE`, `PRESCRIPTION_CREATE` and
> `PRESCRIPTION_SIGN` are held by DOCTOR alone among the system roles, and are
> stripped from ORG_OWNER and ORG_ADMIN **by name**

They are "everything except" roles, so a new authoring code would join them
silently. Any new authoring code CE adds must be stripped the same way.

Vitals already split the way the brief wants: the doctor holds `vitals.read` and
deliberately **not** `vitals.record`, because the cuff is on the arm at the front
desk and whoever put it there owns the number.

---

## ⚠️ The consultation page is already live

`apps/web/src/app/(tenant)/t/[slug]/(app)/appointments/[appointmentId]/page.tsx`

Three audiences, one page, every difference a permission — never a role check:

- `clinical.encounter.create` → the author. **This path POSTs during render** to
  move `CHECKED_IN` → `IN_PROGRESS`, which is safe only because the transition is
  idempotent in the service.
- `clinical.encounter.read` → the administrator, who changes nothing by arriving.
- `clinical.vitals.read` → sees the observations.

Opening it already writes `data_access_logs` rows. The engine goes inside the
`canReadEncounter` branch that is already there, gated on `canConsult`, with the
written-up consultation read-only for everyone else.

---

## Frontend conventions to follow

- **Server Components + `actions.ts` Server Actions.** `lib/api.ts` is server-only
  by construction (`API_INTERNAL_URL` has no `NEXT_PUBLIC_` prefix), so there is
  no browser-held token — and there must not be one (CD-8).
- Client components use `useActionState` / `useTransition`. No data-fetching
  library, no form library. Do not add one.
- Components are flat kebab-case files in `apps/web/src/components/tenant/`.
- UI primitives are deliberately few: `alert`, `button`, `field`,
  `password-control`, `phone-input`. The design system is
  `app/globals.css` + `app/theme.css` — **read `apps/web/AGENTS.md` and load the
  `frontend-design` skill before writing any new screen.**
- Times render through `formatClinicTime` and friends with the zone from the
  branch row. Never `toLocaleString()`, never a fresh `Intl.DateTimeFormat`.

---

## Does not exist — CE builds it

- `encounters`, and every clinical child of it.
- Any clinical master: symptoms, diagnoses, procedures, investigations, advice.
- `clinical_episodes`.
- Consultation templates of any kind.
- Visual maps, regions, findings.
- **The whole lab module.** `lab.*` codes exist; there are no tables. So §12's
  investigations are an ORDER that anticipates a lab, not one that connects to
  it. Do not build the lab module here.
- Any test toolchain in `apps/web` — see CD-10.

---

## Process traps carried over from PI-1…PI-6

⚠️ **`pnpm typecheck` and `pnpm test` both OOM the api container.** Run per
package or by path. Never `pnpm build` as a verification step.

⚠️ **Migrations replay in NAME order and this repo's are hand-dated ahead of the
wall clock.** The highest is `20260818090000`. Anything Prisma generates must be
re-dated past it. `prisma migrate diff` wants
`--from-config-datasource --to-schema ./prisma/schema --script` and prints a
dotenv banner to STDOUT that must be stripped.

⚠️ **An applied migration is checksummed including its comments.** Never edit one
in place.

⚠️ **`ALTER TYPE … ADD VALUE` and a CHECK naming the new value cannot ship in one
migration.** A type CREATED in the same transaction may be used immediately; an
existing one may not. CE adds members to `TaxonomyNodeType`,
`DataAccessResource`, `DocumentType` and `NumberSequenceType` — all pre-existing.

⚠️ **The schema is a folder.** `packages/db/prisma/schema/*.prisma`, one file per
domain, enums beside their models.

⚠️ **Every new tenant table needs** a policy in `rls/enable-rls.sql`, that SQL
appended to the generated migration, and a case in
`tests/integration/tenant-isolation/`. `db:rls:check` fails until it does.
