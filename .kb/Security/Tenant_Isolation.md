# Tenant Isolation

**Verified** from `packages/db/prisma/rls/enable-rls.sql`,
`packages/db/src/tenant.ts`, `packages/db/scripts/check-rls.ts` and
`apps/api/tests/integration/tenant-isolation/`.

This is the single most important security property in the system. Read
[ADR-0003](../Architecture/decisions/0003-rls-enable-not-force.md),
[ADR-0004](../Architecture/decisions/0004-composite-foreign-keys.md) and
[ADR-0005](../Architecture/decisions/0005-tenant-scoped-prisma-client.md) before
changing anything here.

---

## Why three layers and not one

Each layer fails differently, so each catches what the others miss.

| Layer                                                | Fails when                              | Caught by                               |
| ---------------------------------------------------- | --------------------------------------- | --------------------------------------- |
| Application scoping — services pass `organizationId` | A developer forgets the filter          | RLS                                     |
| RLS — `organization_id = app_current_org()`          | Nobody wrote the policy for a new table | `db:rls:check`, and the explicit filter |
| Composite FK — `(organization_id, id)`               | Both of the above are wrong             | Postgres refuses the insert outright    |

The third layer is qualitatively different: it makes a cross-tenant reference
**unrepresentable** rather than merely denied. That is worth the extra column
in every child table.

---

## How the context is set

```ts
// packages/db/src/tenant.ts — the shape, not the literal source
BEGIN;
  SELECT set_config('app.current_org',   $1, true),
         set_config('app.branch_scope',  $2, true),
         set_config('app.current_user',  $3, true);
  -- queries
COMMIT;
```

**The `true` is the whole thing.** It makes the setting transaction-local, so it
reverts on COMMIT or ROLLBACK. Postgres session settings otherwise persist on a
connection, and Prisma pools connections — a connection still carrying org A's
context handed to a request for org B is a silent cross-tenant read.

Three consequences the team accepted:

1. **Every tenant query is a transaction** — roughly two extra round-trips.
   Mitigate by grouping related reads into one `withTenant` call rather than one
   per query.
2. **The app must not be the table owner.** Postgres silently bypasses RLS for
   owners and superusers.
3. **Prisma Migrate does not manage policies.** They live in hand-edited SQL
   blocks inside migrations.

---

## The four entry points

**Verified** exports of `@rcln/db`.

| Function                       | Use                                                                                 | Danger                                                                                                                                                             |
| ------------------------------ | ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `withTenant(ctx, fn)`          | Everything normal                                                                   | —                                                                                                                                                                  |
| `forTenant(ctx)`               | A scoped client for a longer unit of work                                           | Same guarantees                                                                                                                                                    |
| `setTenantContext(tx, …)`      | **Registration only.** Adopts the organization mid-transaction, once the row exists | Nothing in the type system stops you calling it anywhere. Three of registration's tables are RLS-exempt and four are not — that is why it must run mid-transaction |
| `withUserIdentity(userId, fn)` | Reads **only** the caller's own `memberships` rows, before any tenant is known      | Relies on the `own_membership` policy's second condition to stay narrow. [ADR-0011](../Architecture/decisions/0011-own-membership-identity-bootstrap.md)           |

`@rcln/db/unsafe` is the audited escape hatch. An eslint rule blocks the raw
client everywhere else.

---

## Policy flavours

| Flavour                                | Tables                                                                                                                                                                    | Predicate                                                                                                     |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `org`                                  | `branches`, `memberships`, `membership_roles`, `membership_permission_overrides`, `invitations`, `subscriptions`, `subscription_invoices`, `usage_counters`, `audit_logs` | `organization_id = app_current_org()`, both `USING` and `WITH CHECK`                                          |
| explicit                               | `files`                                                                                                                                                                   | Same, written out rather than generated by the loop                                                           |
| `branch` — **RESTRICTIVE**             | `membership_roles`, `membership_permission_overrides`                                                                                                                     | ANDs with the org policy. RESTRICTIVE is essential: a PERMISSIVE policy would OR and _widen_ access           |
| `parent`                               | `branch_operating_hours`, `branch_closures`, `invitation_branches`, `staff_profiles`                                                                                      | `EXISTS` against the scoped parent. The subquery is itself subject to the parent's RLS, so isolation composes |
| `own_membership` — deliberate widening | `memberships`                                                                                                                                                             | `SELECT` only, `user_id = app_current_user() AND app_current_org() IS NULL`                                   |

### The `own_membership` subtlety

PERMISSIVE policies OR together, so `own_membership` would widen every ordinary
request — **except** for its second condition, which switches it off the moment
a tenant context exists. A context always exists, other than inside
`withUserIdentity()`. It is `SELECT`-only, so it grants no ability to write a
membership.

Without this policy, `authSession.memberships` is silently always empty. Six of
the 17 tenant-isolation cases exist to pin its boundaries.

---

## The role split

| Role         | RLS                                        | Connection string     | Used by                           |
| ------------ | ------------------------------------------ | --------------------- | --------------------------------- |
| `rcln_app`   | **Enforced** — owns nothing, `NOBYPASSRLS` | `DATABASE_URL`        | api, worker at runtime            |
| `rcln_owner` | Bypassed — table owner                     | `DIRECT_DATABASE_URL` | migrations, seeds, `db:rls:check` |

Provisioned by `infra/postgres/init/01-roles-and-extensions.sql`, and replayed
in CI so the split is reproduced there too.

**`ENABLE`, not `FORCE`.** `FORCE` applies policies to the owner as well, and
the owner exists precisely to run migrations and seeds that have no tenant
context — under `FORCE`, every one of them fails. The risk `FORCE` would have
covered (someone pointing `DATABASE_URL` at the owner) is handled by
`assertRlsActive()`, which refuses to boot the app on an owner connection. That
fails loudly at startup instead of silently at query time.

---

## Exemptions

A table with `organization_id` and no policy fails `db:rls:check` unless it is
in the `EXEMPT` map in `packages/db/scripts/check-rls.ts` **with a written
reason**. The check also warns about exemptions for tables that no longer exist.

The full list with reasons is reproduced in
[`../04_Database_Schema.md`](../04_Database_Schema.md#rls-exemptions) and
generated live into [`../Database/_index.md`](../Database/_index.md).

The pattern behind almost all of them: **the lookup that establishes tenant
context cannot itself require tenant context.** That is why `organizations`,
`organization_domains`, `users`, `sessions`, `auth_tokens` and `user_identities`
are all outside RLS. `demo_requests` is the different case — the submitter has
no organization at all.

---

## How to verify isolation still holds

```bash
docker compose exec api pnpm db:rls:check                       # policy coverage
docker compose exec api pnpm --filter @rcln/api test tenant-isolation
docker compose exec api pnpm validate                           # everything
```

`db:rls:check` also asserts that the application role **cannot** bypass RLS,
which catches the case where someone points `DATABASE_URL` at the owner.

### What a new tenant table needs

Non-negotiable, in this order:

1. `organizationId` **and** `@@unique([organizationId, id])`
2. The table added to the `org_scoped` array in `enable-rls.sql`
3. That SQL appended to the generated `migration.sql` before committing
4. `pnpm db:rls:check` green
5. A case in `apps/api/tests/integration/tenant-isolation/`

The check failing at step 4 is the design working. A missing policy produces no
error, breaks no single-tenant test, and starts returning other clinics' patient
records.

---

## Residual risk

| Risk                                                             | Note                                                                                                                                                                                                    |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Privilege-escalation guards are application-only                 | Isolation between _tenants_ is enforced by Postgres. Isolation between _privilege levels within a tenant_ is not — see [`../08_Security_Model.md`](../08_Security_Model.md#privilege-escalation-guards) |
| `setTenantContext` and `withUserIdentity` are unguarded by types | Both are correct where used and would be dangerous elsewhere. Review is the only control                                                                                                                |
| No production traffic has ever exercised any of this             | Every claim here is from tests and reading, not from operating the system                                                                                                                               |
