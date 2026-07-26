# ADR-0003 — RLS is ENABLE, not FORCE, with an owner/app role split

**Status:** Accepted. Decided wrong first, then corrected.

## Context

Tenant isolation cannot depend on every query remembering `WHERE
organization_id = ?`. One forgotten clause in a healthcare product is a
company-ending event. Postgres row-level security moves the guarantee into the
database.

Postgres has two modes:

- `ENABLE ROW LEVEL SECURITY` — policies apply to everyone **except the table's
  owner**.
- `FORCE ROW LEVEL SECURITY` — policies apply to the owner too.

## The wrong decision, first

`FORCE` was chosen because it sounds stricter. The result: migrations and seeds
run as the table owner, so every insert was silently rejected. The failure was
invisible — a heredoc swallowed the error and the seed appeared to succeed while
inserting nothing.

## Decision

Use `ENABLE` (explicitly `NO FORCE`), and guarantee isolation through a **role
split** instead:

| Role         | Used by                            | RLS      | Notes                                                                  |
| ------------ | ---------------------------------- | -------- | ---------------------------------------------------------------------- |
| `rcln_owner` | migrations, seeds, support tooling | bypassed | Owns the tables. Needs `CREATEDB` locally for Prisma's shadow database |
| `rcln_app`   | api and worker at runtime          | enforced | Owns nothing. `NOSUPERUSER NOBYPASSRLS`                                |

The risk this creates — someone pointing `DATABASE_URL` at the owner, silently
disabling every policy — is covered by `assertRlsActive()` in
`packages/db/src/client.ts`, which refuses to start the process if the
connection is a superuser, has `BYPASSRLS`, or owns any RLS-protected table.

Policies read transaction-local session variables:

```
app.current_org    uuid     the tenant
app.branch_scope   uuid[]   branches this request may touch
app.current_user   uuid     the acting user
```

All read with `current_setting(..., true)`, so an unset variable yields NULL and
matches **no rows**. The policies fail closed.

## Consequences

- Failing loudly at startup beats failing silently at query time.
- `db:rls:check` runs in CI: every table with an `organization_id` must have RLS
  enabled and at least one policy, unless it is on an explicit exemption list
  with a written reason.
- Some tables are deliberately unprotected — `organizations`,
  `organization_domains`, `users`, `sessions`, `auth_tokens`, `roles`,
  `permissions`, `plans`, `setting_*`. Each is resolved _before_ a tenant context
  exists, so scoping them would be circular.

## The circular-dependency trap

`organization_domains` was initially given a policy. Resolving host → tenant is
_how_ `app.current_org` gets set, so that query could never satisfy its own
policy. Tenant resolution silently returned null for every request. It is now
exempt, with the reason recorded in both the SQL and `check-rls.ts`.

## How it can be broken

- Pointing the app at `rcln_owner` (guard: `assertRlsActive`).
- Granting `BYPASSRLS` to `rcln_app` (guard: `db:rls:check`).
- Adding a tenant table without a policy (guard: `db:rls:check`).
- Adding `FORCE` back "for safety" — it will break migrations, and the failure
  will be silent.
