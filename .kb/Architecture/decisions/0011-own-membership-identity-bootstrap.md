# ADR-0011 — A user may read their own membership rows outside any tenant

**Status:** Accepted.

## Context

One login spans organizations (ADR-0001, ADR-0002). A doctor can work at two
clinics; a locum can work at five. So after authenticating we have to answer:

> Which organizations does this user belong to?

That answer is what the account switcher renders, what tells the client which
subdomain to navigate to, and what populates `authSession.memberships` in
`@rcln/contracts`.

The question is inherently cross-tenant. It is the question whose answer
_establishes_ which tenants exist for you — and `memberships` is org-scoped and
RLS-enforced under `tenant_isolation`:

```sql
USING (organization_id = app_current_org())
```

Which leaves no way to ask it:

- **Unscoped** (`@rcln/db/unsafe`) returns nothing. `unsafeDbClient()` is not a
  privileged client — it is the same `rcln_app` connection with the session
  variables skipped, and `rcln_app` has `NOBYPASSRLS`. With `app.current_org`
  unset the policy fails closed.
- **Inside `withTenant`** requires the organization id you are trying to find.

This is the same circularity that made `organization_domains` an exemption
(ADR-0003, and the "Scoping the tenant-resolution table is circular" entry in
PITFALLS). It failed the same way, too: silently. `authSession.memberships` was
always `[]`, with no error anywhere — login worked, the switcher was just empty.

## The option not taken

Adding `memberships` to the exemption list, as `organization_domains` and
`sessions` are.

Rejected. Those tables leak little: a domain is public DNS, a session row is
found only by the hash of a 256-bit secret. `memberships` is different — it is
the map of who works where, across every clinic on the platform. Exempting it
would make a bug anywhere in the application layer sufficient to enumerate that.

## Decision

A second policy on `memberships`, narrowed on **both** axes:

```sql
CREATE POLICY own_membership ON memberships FOR SELECT
  USING (user_id = app_current_user() AND app_current_org() IS NULL);
```

Reached only through `withUserIdentity(userId, fn)` in
`packages/db/src/tenant.ts`, which sets `app.current_user` and deliberately no
tenant.

Three properties make this safe:

1. **`user_id = app_current_user()`** — your own rows, never anyone else's. The
   policy cannot answer "who else works at this clinic".
2. **`app_current_org() IS NULL`** — and only in a transaction that has claimed
   no tenant. This is the load-bearing half. Permissive policies OR together, so
   without it this would widen _every_ ordinary request: a user inside clinic A
   would start seeing their own membership rows from clinic B appear in
   `tenant_isolation`-scoped queries. With it, the policy switches off entirely
   the moment `app.current_org` is set — which is always, except in the identity
   bootstrap.
3. **`FOR SELECT`, no `WITH CHECK`** — it grants no ability to create, alter or
   delete a membership. You cannot write yourself into an organization.

`check-rls.ts` still passes: `memberships` keeps `tenant_isolation`, so it is
not an exempt table.

## Consequences

- `withUserIdentity()` is a third way to reach the database, alongside
  `withTenant()` and `@rcln/db/unsafe`. It is deliberately single-purpose: the
  only caller is `listMemberships()` in `access.service.ts`. It is **not** a
  general escape hatch — every other org-scoped table still sees a NULL
  `app.current_org` inside it and returns nothing.
- Permission resolution has a related bootstrap, solved without a policy change:
  `membership_roles` carries a RESTRICTIVE branch policy, so reading a user's
  own role assignments needs a branch scope that is itself derived from those
  assignments. `access.service.ts` resolves it in two reads — `branches` first
  (org-scoped only, no branch policy), then `membership_roles` with the scope
  set to all of them, filtered to one membership id.
- Registration has its own variant of the same problem and its own answer: see
  `register.service.ts`, which sets the tenant variables mid-transaction once
  the organization row exists.

## How it can be broken

- **Dropping the `app_current_org() IS NULL` condition** "to simplify it". That
  single change turns a zero-blast-radius policy into one that leaks a user's
  cross-tenant membership list into every scoped query.
- **Adding `WITH CHECK`**, which would let a user insert their own membership
  into any organization.
- **Reaching for `withUserIdentity()` because `withTenant()` is inconvenient.**
  Nothing in the type system stops this. The eslint rule guards
  `@rcln/db/unsafe`, not this.

Boundaries are pinned by the `own_membership: the identity bootstrap` block in
`apps/api/tests/integration/tenant-isolation/` — six cases covering both
conditions and both write paths. If that block is deleted, this ADR is unenforced.
