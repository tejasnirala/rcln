# 07 · Business Rules

**Version:** 1.0 · Every rule below is **Verified** against the cited
`file:line` unless marked otherwise.

Rules are grouped by module and carry a stable id. Per-module detail lives in
[`BusinessRules/`](BusinessRules/README.md). `.kb/modules.json` links each
module to its rule ids, so the generated [Module catalog](06_Module_Catalog.md)
cross-references them automatically.

**Id format:** `BR-<MODULE>-<NNN>`. Ids are permanent. If a rule is withdrawn,
mark it withdrawn — never reuse the number.

---

## Index

| Group          | Rules             | Detail                                                               |
| -------------- | ----------------- | -------------------------------------------------------------------- |
| Tenancy        | BR-TEN-001 … 005  | [BusinessRules/Tenancy.md](BusinessRules/Tenancy.md)                 |
| Authentication | BR-AUTH-001 … 006 | [BusinessRules/Authentication.md](BusinessRules/Authentication.md)   |
| IAM            | BR-IAM-001 … 006  | [BusinessRules/IAM.md](BusinessRules/IAM.md)                         |
| Branches       | BR-BR-001 … 003   | [BusinessRules/Branches.md](BusinessRules/Branches.md)               |
| Invitations    | BR-INV-001 … 004  | [BusinessRules/Invitations.md](BusinessRules/Invitations.md)         |
| Audit          | BR-AUD-001 … 002  | [BusinessRules/Audit.md](BusinessRules/Audit.md)                     |
| Platform       | BR-PLT-001 … 002  | [BusinessRules/PlatformConsole.md](BusinessRules/PlatformConsole.md) |
| Marketing      | BR-MKT-001 … 002  | [BusinessRules/Marketing.md](BusinessRules/Marketing.md)             |
| Notifications  | BR-NOT-001        | [BusinessRules/Notifications.md](BusinessRules/Notifications.md)     |

---

## Tenancy

### BR-TEN-001 · Registration is one transaction or nothing

**Description.** Creating an organization creates, atomically: the
`organizations` row, its `organization_domains` subdomain, a first `branches`
row, the owner `users` row, a `memberships` row, an `ORG_OWNER`
`membership_roles` grant, and a trial `subscriptions` row.

**Source.** `apps/api/src/services/organization/register.service.ts`
**Impact.** A partial failure would leave an organization nobody can sign in to,
or a subdomain pointing at nothing. Both are unrecoverable without manual SQL.
**Dependencies.** Three of the tables involved are RLS-exempt and four are not,
so the transaction calls `setTenantContext()` **mid-transaction**, once the
organization row exists. Read the header comment in that file before touching it.

### BR-TEN-002 · An unknown tenant is 404, never 403

**Description.** A request whose Host header resolves to no organization is
answered 404 by `requireTenant`, before any credential is examined.

**Source.** `apps/api/src/middleware/tenant.middleware.ts`; the group-level
`router.use` in every tenant router.
**Impact.** A 403 would confirm the subdomain exists, turning the API into a
customer-list oracle.
**Dependencies.** Requires `resolveTenant` to run before `authenticate`.

### BR-TEN-003 · Reserved subdomains cannot be claimed

**Description.** A registration naming a reserved subdomain is rejected.

**Source.** `RESERVED_SLUGS` in `packages/contracts/src/common.ts:17`;
`slug` schema at `common.ts:6` (3–63 chars, lowercase alphanumeric and hyphens,
must not start or end with a hyphen).
**Impact.** A tenant claiming `api` or `admin` breaks routing for every tenant.

### BR-TEN-004 · Slug availability is an oracle and is rate-limited accordingly

**Description.** `GET /public/organizations/check-slug` returns a boolean only,
behind `slugCheckLimiter`.

**Source.** `apps/api/src/routes/v1/public.routes.ts:145`;
`slugAvailabilityResponse` in `packages/contracts/src/tenancy.ts:252`.
**Impact.** The endpoint necessarily reveals whether a clinic is a customer.
Rate limiting is the only mitigation, so it must not be relaxed.

### BR-TEN-005 · Tenant context is transaction-local

**Description.** `withTenant` sets `app.current_org`, `app.branch_scope` and
`app.current_user` with `set_config(…, true)` inside a transaction.

**Source.** `packages/db/src/tenant.ts`
**Impact.** The `true` flag is what makes the setting revert on COMMIT. Without
it, a pooled connection carries one tenant's context into the next tenant's
request — a cross-tenant read with no error and no log line.
**Dependencies.** [ADR-0005](Architecture/decisions/0005-tenant-scoped-prisma-client.md).

---

## Authentication

### BR-AUTH-001 · Login failure is uniform and constant-time

**Description.** Wrong password, no such user, suspended account and _"not a
member of this organization"_ all produce the same message in the same time. A
dummy Argon2 hash is verified for users that do not exist.

**Source.** `apps/api/src/services/auth/login.service.ts`;
`dummyHash()` and `fakeVerify()` in `password.service.ts:54,63`.
**Impact.** Distinguishing these leaks both user existence and organization
membership. Do not "improve" the error messages.

### BR-AUTH-002 · The permission list is never in the token

**Description.** The access token carries ids only —
`sub`, `sid`, `pa`, `mid`, `oid`, `bid`, `imp`. Permissions are resolved per
request from `membership_roles` and cached in Redis.

**Source.** `apps/api/src/services/auth/token.service.ts`;
`effectivePermissions` in `packages/permissions/src/resolver.ts:97`.
**Impact.** Baking permissions in means a revoked role keeps working until the
token expires, and the header grows past limits.
**Dependencies.** Requires the Redis access cache to be invalidated on every
role write — see BR-IAM-006.

### BR-AUTH-003 · Refresh tokens rotate, and replay revokes the family

**Description.** Every use of a refresh token issues a new one and invalidates
the old. Presenting an already-rotated token revokes the **entire session
family**.

**Source.** `apps/api/src/services/auth/session.service.ts`; 11 tests in
`apps/api/tests/integration/session-rotation.test.ts`.
**Impact.** Replay of a rotated token is a stolen-token signal, not an accident.
Treating it as an error rather than a revocation would leave the thief with a
working session.
**Dependencies.** The refresh token is stored only as a SHA-256 hash, so a dump
of `sessions` cannot be replayed.

### BR-AUTH-004 · Tokens are asymmetric in kind, on purpose

**Description.** The access token is a stateless 15-minute JWT; the refresh
token is an opaque 256-bit random string, stateful and revocable.

**Source.** `apps/api/src/services/auth/token.service.ts`
**Impact.** Stateless verification costs no database round-trip on a per-request
path. The price is that an access token cannot be revoked before it expires,
which is why 15 minutes and not a day.

### BR-AUTH-005 · OTP codes are treated as passwords

**Description.** OTP codes are hashed at rest, single-use, attempt-capped
(`OTP_MAX_ATTEMPTS`), and expire (`OTP_TTL_SECONDS`).

**Source.** `apps/api/src/services/auth/otp.service.ts`;
`hashOtpCode` at `token.service.ts:163`.
**Impact.** A short numeric code is guessable, so it gets password treatment
rather than token treatment. Contrast `hashInviteToken` and
`hashRefreshToken`, which are plain SHA-256 because 256 bits need no stretching.

### BR-AUTH-006 · Sessions are host-only

**Description.** The session cookie is httpOnly and carries **no `domain`
attribute**.

**Source.** `apps/web/src/lib/session-cookie.ts`
**Impact.** A session at `alpha.rcln.com` is useless at `beta.rcln.com`. Adding
a leading-dot domain would create cross-tenant SSO — which is not wanted.

---

## IAM

### BR-IAM-001 · Permission precedence is DENY > GRANT > role grant

**Description.** First match wins: an explicit DENY override, then a GRANT
override, then role grants applying to this branch, otherwise denied.

**Source.** `packages/permissions/src/resolver.ts:4-16, 69-70, 114-117`
**Impact.** DENY is applied last in the flattening path so it always wins.
25 tests pin this matrix; if a change breaks them, the change is wrong.

### BR-IAM-002 · A NULL `branch_id` means every branch

**Description.** A `membership_roles` row with `branch_id = NULL` grants its
role across every branch in the organization.

**Source.** `packages/permissions/src/resolver.ts:12-15`
**Impact.** This nullable is what lets one admin cover branches A and B while
another covers only A, without a second table.
**Dependencies.** [ADR-0002](Architecture/decisions/0002-roles-live-on-membership.md).
It is also the loophole BR-IAM-004 exists to close.

### BR-IAM-003 · You cannot grant a permission you do not hold

**Description.** `assertGrantable` refuses any role definition or override
carrying a permission code the caller does not themselves hold.

**Source.** `apps/api/src/services/iam/guards.ts:90-97`
**Impact.** Not theoretical. `ORG_ADMIN` is defined as everything **except**
`organization.billing.manage`, `branch.delete` and `patient.delete`. Without
this guard an org admin creates a custom role carrying all three, assigns it to
a colleague, and the three deliberate exclusions mean nothing.

### BR-IAM-004 · An org-wide grant requires org-wide reach

**Description.** `coversEveryBranch` refuses a grant with `branch_id = NULL`
from a caller whose own reach does not span every branch.

**Source.** `apps/api/src/services/iam/guards.ts:108`
**Impact.** Org-wide grants are exempt from the branch RESTRICTIVE policy by
design — that is what makes "every branch" expressible at all. Nothing in the
database refuses one. So a caller whose reach stops at two of five locations
could hand somebody all five by _omitting_ the branch: an escalation dressed up
as an omission. Measured: without this guard the request succeeds with 201 and
the assignment is real.

### BR-IAM-005 · Every mutation reads its row first

**Description.** IAM mutations read the target row before writing it. Nothing
uses a bare `updateMany` or `deleteMany`.

**Source.** `apps/api/src/services/iam/guards.ts:20-24` (the reasoning),
`member.service.ts`, `role.service.ts`.
**Impact.** The USING half of the branch RESTRICTIVE policy makes an
out-of-scope row _invisible_, so an `updateMany` matches nothing and **commits
successfully**. Reading first turns that silent no-op into a clean 404. This is
a rule to keep, not a coincidence of style.

### BR-IAM-006 · Access cache must be invalidated on every role write

**Description.** After any write to `membership_roles` or
`membership_permission_overrides`, call `invalidateUserAccess(userId, orgId)`,
or `invalidateOrganizationAccess(orgId)` for org-wide changes.

**Source.** `apps/api/src/services/auth/access.service.ts:181, 201`
**Impact.** Skipping it leaves a revoked role working for the cache TTL. The
failure is silent and time-delayed, which makes it very hard to attribute.

### BR-IAM-007 · Platform admins bypass all three guards

**Description.** `authorize()` lets a platform admin through, and
`grantableCodes` returns `null` (unrestricted) for them.

**Source.** `apps/api/src/services/iam/guards.ts:42-43, 64-66`
**Impact.** Deliberate: impersonation is full access, audited rather than
restricted. **Note:** the ADR this cites, `ADR-0012`, **does not exist in the
repository** — see [15_Known_Issues](15_Known_Issues_and_Technical_Debt.md).
`null` (unrestricted) and `[]` (nothing grantable) mean opposite things and must
not be confused.

---

## Branches

### BR-BR-001 · Branch codes are tenant-qualified

**Description.** Uniqueness of `branches.code` is scoped to the organization.

**Source.** `packages/db/prisma/schema.prisma`, `@@unique([organizationId, code])`
**Impact.** A bare unique would let the first tenant to claim `MAIN` block every
other tenant from using it.

### BR-BR-002 · Branch removal is a soft delete

**Description.** Retiring a branch sets `deletedAt`; the row remains.

**Source.** `apps/api/src/services/branch/branch.service.ts:341` (`deleteBranch`)
**Impact.** History — memberships, roles, and eventually appointments and
invoices — references the branch. A hard delete would orphan it.

### BR-BR-003 · Branch children are protected through their parent

**Description.** `branch_operating_hours` and `branch_closures` have no
`organization_id`. They are RLS-protected by a parent-scoped policy that does an
`EXISTS` against `branches`.

**Source.** `packages/db/prisma/rls/enable-rls.sql`, the `parent_scoped` array
**Impact.** The subquery is itself subject to the parent's RLS, which asks the
same tenant question — so the isolation composes rather than needing to be
restated.

---

## Invitations

### BR-INV-001 · Invitation tokens are hashed at rest

**Description.** Stored as a SHA-256 hash; the plaintext is returned exactly
once, at creation.

**Source.** `hashInviteToken` / `generateInviteToken` at
`apps/api/src/services/auth/token.service.ts:144,149`
**Impact.** A dump of `invitations` cannot be used to join an organization.

### BR-INV-002 · An invitation carries its role and its branches

**Description.** The `invitations` row records the role, and `invitation_branches`
records which branches it will grant on acceptance.

**Source.** `apps/api/src/services/invitation/invitation.service.ts`
**Impact.** Access is decided at invite time by someone who holds the
permissions, not at accept time by the invitee.
**Dependencies.** The same org-wide-reach guard as BR-IAM-004 applies to
`createInvitation`.

### BR-INV-003 · Accepting an invitation is idempotent-ish and pre-tenant

**Description.** The `/join` page and the accept endpoint are unauthenticated;
acceptance creates the user if new, plus the membership and role grants.

**Source.** `POST /api/v1/auth/invitations/preview` and `/accept`
(`auth.routes.ts:238,260`);
`apps/web/src/app/(tenant)/t/[slug]/join/actions.ts`
**Impact.** The invitee has no session yet, so this runs outside the normal
tenant chain and must validate the token itself.

### BR-INV-004 · Expiry is enforced at read time

**Description.** Expired invitations are filtered when listed and rejected when
presented. Nothing sweeps or deletes them.

**Source.** `invitation.service.ts`
**Impact.** Rows accumulate. Acceptable today; it becomes a cleanup job later.

---

## Audit

### BR-AUD-001 · An audit row commits with the change it records

**Description.** The `audit_logs` write happens inside the same transaction as
the mutation.

**Source.** `apps/api/src/services/audit/audit.service.ts`
**Impact.** A change without its audit row, or an audit row without its change,
is worse than either alone — it makes the log untrustworthy.

### BR-AUD-002 · Audit rows carry ids and codes, never names

**Description.** Actor, organization, branch, action, target id, and a
before/after diff of changed fields. No patient name, no free text identifying a
person.

**Source.** `audit.service.ts`; 8 unit cases in
`apps/api/tests/unit/audit-diff.test.ts`
**Impact.** The audit log is itself a PHI surface if it records names. Keeping
it to ids means it can be retained longer and read more widely.

---

## Platform

### BR-PLT-001 · Provisioning uses the same service as self-serve

**Description.** `POST /platform/organizations` calls the same
`register.service.ts` path as public registration, with the platform admin
recorded as the actor.

**Source.** `apps/api/src/routes/v1/platform.routes.ts:40`
**Impact.** One code path means the two entry points cannot drift into creating
differently-shaped organizations.

### BR-PLT-002 · Platform routes never resolve a tenant

**Description.** The platform router applies `authenticate` →
`requirePlatformAdmin` and **not** `requireTenant`.

**Source.** `apps/api/src/routes/v1/platform.routes.ts:27`
**Impact.** A platform admin acts across organizations and has no membership, so
there is no tenant to resolve. This is also precisely why impersonation is hard:
`loadUserAccess` returns null for them, and every branch-scoped write would be
refused.

---

## Marketing

### BR-MKT-001 · The demo form fails silently

**Description.** A submission failing the honeypot or the timing check is
discarded and answered as if accepted. Duplicates are deduplicated.

**Source.** `apps/api/src/routes/v1/public.routes.ts:64`;
7 cases in `apps/api/tests/integration/demo-requests.test.ts`
**Impact.** Telling a bot it was detected teaches the bot. The cost is that a
genuine fast-typing human can be discarded without knowing.

### BR-MKT-002 · `demo_requests` is deliberately outside RLS

**Description.** The table has no `organization_id` and no policy. It is gated
in the application layer: one public, rate-limited, write-only route; reads are
platform-admin only.

**Source.** `packages/db/prisma/rls/enable-rls.sql` (the exemption block);
`packages/db/scripts/check-rls.ts` `EXEMPT`
**Impact.** The submitter has no organization yet, so there is nothing to scope
by; a policy requiring `app.current_org` would make the table unwritable by the
only endpoint that writes it. Contact details only, never PHI.

---

## Notifications

### BR-NOT-001 · Every outbound message goes through one seam

**Description.** OTP codes and invitation links are dispatched via
`services/notification/sender.ts`, which currently logs rather than sends.

**Source.** `apps/api/src/services/notification/sender.ts`
**Impact.** All the surrounding logic — generation, hashing, expiry, attempt
caps — is real and tested. Only delivery is missing, so wiring a provider is a
one-file change rather than a feature.
**Dependencies.** Blocked externally on TRAI DLT registration for SMS and Meta
template approval for WhatsApp. See
[`13_Integration_Guide.md`](13_Integration_Guide.md).

---

## Rules that exist only as design

**Assumed / Inferred** — documented in
[`Architecture/architecture.md`](Architecture/architecture.md) or
[`STATUS.md`](STATUS.md), with **no implementation**. Recorded so a future
session does not "discover" them as gaps.

| Would-be rule                                                                                     | Where specified                                               |
| ------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| Dunning ladder: retry d1/d3/d7 → `PAST_DUE` → 7-day grace → `SUSPENDED` (read-only, never delete) | `architecture.md` §10, `STATUS.md`                            |
| Entitlement gate: `subscription_feature_overrides` → `plan_features` → default                    | `STATUS.md` Phase 2                                           |
| Usage counters enforcing `max_branches` / `max_users` at write time                               | `STATUS.md` Phase 2                                           |
| FEFO batch selection at dispense                                                                  | `architecture.md` §15, `schema-design.md`                     |
| Financial-year reset on invoice number sequences                                                  | `STATUS.md` Phase 4                                           |
| Lab separation of duty: assistant enters, manager verifies and releases                           | Encoded in the **role permissions today**; no workflow exists |
| DPDP erasure as irreversible anonymisation, not deletion                                          | Decided; promised in the legal pages; **not implemented**     |
| Job idempotency via deterministic `jobId`                                                         | `architecture.md` §8                                          |
