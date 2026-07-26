# ADR-0012 — Impersonation is full access, and the audit trail is the control

**Status:** Accepted. Overrules one line of `architecture.md` §6.

## Context

A super admin needs to get inside a clinic. Someone reports that their revenue
report is empty, or that an invitation never arrived, or that a branch they
created is invisible — and every one of those is a question about state that only
exists inside one tenant, behind RLS, on data nobody at rcln can see from the
outside.

`architecture.md` §6 specified this as: separate short-lived token,
`sessions.impersonated_by_user_id` set, a persistent banner, every request
audited, **and a hard block on write operations unless explicitly elevated.**

That last clause is the one this ADR removes.

## The write block was never real

Three things were true before a line of slice 6 was written:

1. **`authorize()` bypasses every permission check for a platform admin**, and
   has since the middleware was written. So has `can()` in
   `@rcln/permissions`. A write block would not be _keeping_ a restriction; it
   would be a new, separate mechanism layered on top of a model that already
   says yes.
2. **A read is not free.** The diagnostic pass — opening the clinic, reading its
   members, its branches, its settings, its patients' appointment counts — is
   the part that touches PHI. Blocking writes protects nothing about that, and
   the read went unrecorded anyway before slice 0 added `recordAudit`.
3. **"Unless explicitly elevated" is a button.** In practice it is a button that
   gets pressed, because the alternative is reading the fix down the phone to a
   receptionist who is holding a queue. An elevation step that is always taken is
   a click, not a control — and it makes the audit trail worse, not better,
   because it invites the reading of "not elevated" as "harmless".

## Decision

**A platform admin inside a clinic can read, write and delete exactly as an
owner can. There is no elevation step and no write block.**

In exchange, four things are non-negotiable:

1. **A reason is required to enter**, minimum ten characters, and it lands in
   the CLINIC's own `audit_logs` — not rcln's. The clinic can read why somebody
   was in their records.
2. **Every mutation, by every actor, writes an audit row** with field-level
   before/after values. This is what `recordAudit` (slice 0) exists for, and why
   `impersonatedByUserId` is taken off the `TenantContext` rather than passed by
   each call site: a service cannot forget to record something it does not know
   about.
3. **The session hard-expires in thirty minutes** and carries no refresh token.
   The plaintext is generated to satisfy the NOT NULL column and discarded
   immediately, so nothing — not the browser, not `proxy.ts`, not a captured
   token — can rotate it. `sessions.expires_at` is the whole of its life.
4. **A non-dismissible banner** on every screen in the clinic shell, naming the
   organization, the admin, and the hour the session closes.

### Who the session acts as

`Session.userId` is the admin and `Session.impersonatedByUserId` is the admin as
well. The second is what MARKS the session as an impersonation — the banner, the
branch-scope resolution in `authenticate`, and `recordAudit` all key on it.

Deliberately **not** "act as the clinic's owner". Attributing a write to a real
employee who did not make it puts their name on a change in a system of record
for patient care. `audit_logs.impersonated_by_user_id` would disambiguate it, but
only for somebody who thought to look, and only for as long as anyone remembers
that the column means that.

### Getting in: two steps, because cookies are host-only

Session cookies carry no `domain`, on purpose — that is the isolation boundary
that makes a session at `alpha.rcln.com` useless at `beta.rcln.com`
(`apps/web/src/lib/session.ts`). So `admin.<root>` **cannot** write a cookie for
a clinic's subdomain, and no arrangement of redirects changes that.

- `POST /platform/organizations/:id/impersonate` answers with a **handoff
  ticket**: 256 random bits, held in Redis under its own SHA-256 digest for two
  minutes, and bound to one organization.
- The browser posts it to `/impersonate` on the clinic's own host — a Next Route
  Handler, not a Server Action, because the request is cross-origin and Next
  blocks cross-origin Server Actions. A POST body, not a URL: the ticket is a
  credential, and a URL is written to every access log on the way.
- `POST /auth/impersonation/claim`, on the clinic's host, redeems it. The
  organization comes from the Host header via `resolveTenant`, before any
  credential is read, and is compared with the one fixed when the ticket was
  issued. Redemption is a Redis `GETDEL`, so it is atomic and single-use — a
  ticket presented at the wrong clinic is burnt in the attempt.

`POST /auth/impersonation/stop` revokes the session and files the closing row.

## Consequences

- **`effectivePermissions` now bypasses for a platform admin**, matching `can`,
  which always did. It previously returned `[]` for a caller every endpoint was
  about to say yes to — a shell with no navigation. The two disagreeing is a UI
  that hides controls the API allows.
- **`authenticate` resolves a branch scope for an impersonating admin** from the
  organization's own branches. They hold no membership, so `loadUserAccess`
  returns null — and `branch_isolation` is RESTRICTIVE, so an empty scope is not
  "unrestricted". Every branch-scoped read would return nothing and every
  branch-scoped write would silently match nothing: full access would present as
  an empty clinic.
- **The branch switcher is absent under impersonation.** `authSession.memberships`
  is the admin's own, and they have none here; the banner names the clinic
  instead. The session lands on the primary branch.
- **`platform.impersonate` is a real permission code** on the route, even though
  `requirePlatformAdmin` has already run and `authorize` bypasses for the flag.
  It is written out so the gate appears where a reader looks for it.

## How it can be broken

- **Adding an elevation step "for safety".** It re-introduces the button that
  always gets pressed, and it makes an unelevated session read as harmless.
- **Making `impersonatedByUserId` optional at creation**, or setting it only
  when the target differs from the admin. Everything downstream keys on it: the
  banner disappears, the branch scope collapses to empty, and `recordAudit`
  stops stamping the second id — leaving writes that look like an ordinary
  member's.
- **Returning a refresh token from `claimImpersonation`.** `rotateRefreshToken`
  resets `expires_at` to thirty days on every rotation, so a single refresh
  would turn a half-hour visit into a month-long one.
- **Reaching for `withTenant` around a platform-wide read.** The other half of
  the same mistake: `organizations` is RLS-exempt but `branches` and
  `memberships` are not, so an unscoped `_count` over them returns 0 for every
  clinic, silently. See the note on `platformOrganizationSummary`.
- **Deleting `apps/api/tests/integration/impersonation.test.ts`.** Twenty cases,
  and two of them were measured by removing the guard first: without the
  cross-host check, clinic A's ticket opens a working session inside clinic B
  and files an audit row there.
