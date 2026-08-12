# The tenant-isolation suite

THE most important tests in this repository. They seed two organizations and
assert that a connection scoped to one can never see or write the other's rows.

**Every new tenant table needs a case here.** RLS produces no error when a policy
is missing — nothing fails, the feature works, and one clinic quietly starts
reading another clinic's patient records. `pnpm db:rls:check` catches the missing
policy; these tests catch the policy that exists and is _wrong_.

Runs against a real Postgres with real migrations. Never mock Prisma here.

## Layout

This was one 5,396-line file until it was split by domain. The cases are
unchanged — only the fixture moved.

| File                   | Covers                                                                                          |
| ---------------------- | ----------------------------------------------------------------------------------------------- |
| `harness.ts`           | Not a test. The two organizations, three branches, two connections, `asTenant`                  |
| `core.test.ts`         | The app role itself, the bare boundary, parent-scoped children, `own_membership`, composite FKs |
| `audit-logs.test.ts`   | `audit_logs` is append-only — the revoked grant and the trigger                                 |
| `billing.test.ts`      | Subscriptions, plans, payments, the one-row-wide webhook lookup                                 |
| `spine.test.ts`        | `number_sequences`, `data_access_logs`                                                          |
| `staff.test.ts`        | Doctors, designations, role pairings — catalogue + tenant extension                             |
| `patients.test.ts`     | PHI, and the branch policy deliberately absent (ADR-0016)                                       |
| `appointments.test.ts` | PHI, and the opposite branch call from `patients`                                               |
| `clinic-tax.test.ts`   | Issuer tax registrations and rules — the opposite call from `tax_registrations`                 |
| `invoices.test.ts`     | Patient invoices                                                                                |
| `fees.test.ts`         | Fee schedule, compensation, reschedules                                                         |
| `catalogue.test.ts`    | Product catalogue (PI-1) and its eleven `*_visible` policies                                    |
| `inventory.test.ts`    | Inventory (PI-2) — locations, batches, serials, ledger, balances                                |
| `movements.test.ts`    | Movements (PI-3) — reason codes, transfers, reservations                                        |

## Running

```bash
# the whole suite — 279 cases, ~2s
docker compose exec api pnpm test:rls

# one domain — ~0.4s
docker compose exec api pnpm test tests/integration/tenant-isolation/inventory

# one case
docker compose exec api pnpm test tests/integration/tenant-isolation -t 'third branch'
```

`test:rls` takes no arguments: jest ORs positional patterns rather than
intersecting them, so `pnpm test:rls inventory` would widen the run to every
path matching _either_. Pass the full path to `pnpm test` instead, as above.

Adding a table? Put the case in the file for its domain, and add a new file only
when the domain is new. Each file calls `useIsolationHarness()` once at the top
and imports `owner`, `app`, `asTenant` and the fixture ids from `./harness.js`.

## Why the files are independent

Seeding is `ON CONFLICT DO NOTHING` and teardown deletes both organizations, so
any subset runs in any order. That holds because jest runs this project with
`maxWorkers: 1` (see `jest.config.ts`, which explains why). If that ever changes,
the fixed organization ids here become a race and each file will need its own.
