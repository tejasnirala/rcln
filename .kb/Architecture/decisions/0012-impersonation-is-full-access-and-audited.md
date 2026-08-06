# ADR-0012 — Impersonation is full access, and the audit trail is the control

**Status:** Accepted. Overrules one line of `architecture.md` §6.
**Amended 2026-07-26** — the session renews now, bounded by a ceiling. See
[Amendment: the session renews](#amendment-2026-07-26--the-session-renews).

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
3. **The session is bounded, and cannot be extended indefinitely.** Originally:
   thirty minutes, no refresh token at all. **Amended** — see below. The bound is
   now two deadlines rather than one.
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
- **Removing the ceiling clamp in `rotateRefreshToken`.** This entry used to read
  "returning a refresh token from `claimImpersonation`", and it was right about
  the hazard: `rotateRefreshToken` resets `expires_at` to thirty days on every
  rotation, so one refresh would turn a visit into a month. The session returns a
  refresh token now, and the clamp is the only thing standing between that and the
  month. It keys on `impersonated_by_user_id`; delete it, make it key on something
  else, or move expiry-extension to a second call site that does not clamp, and
  the hazard is back with no test failing except the two that measure it.
- **Letting `/impersonate` return without writing the cookies — on ANY path.** A
  stale refresh cookie from an ordinary sign-in on the clinic's host is renewed by
  `proxy.ts` _before this handler runs_, so by the time the handler decides
  anything, a live access+refresh pair for that employee is already sitting in the
  response headers. The success path overwrites both, which evicts them. Every
  failure path must delete both — `abandon()` exists for that, and a bare
  `seeOther('/login')` on a spent, expired or wrong-clinic ticket would drop the
  admin onto that clinic's login page **already signed in as the employee**, with
  no strip on screen and subsequent writes audited under their name. (This was
  latent before the amendment too: the old `cookies.delete` also sat after the
  early returns.)
- **Reaching for `withTenant` around a platform-wide read.** The other half of
  the same mistake: `organizations` is RLS-exempt but `branches` and
  `memberships` are not, so an unscoped `_count` over them returns 0 for every
  clinic, silently. See the note on `platformOrganizationSummary`.
- **Deleting `apps/api/tests/integration/impersonation.test.ts`.** Twenty cases,
  and two of them were measured by removing the guard first: without the
  cross-host check, clinic A's ticket opens a working session inside clinic B
  and files an audit row there.

## Amendment (2026-07-26) — the session renews

### What changed

The original decision gave the session **thirty minutes and no refresh token**.
The plaintext was generated to satisfy the NOT NULL column and thrown away, so
`sessions.expires_at` was the whole of its life and nothing could move it.

It now **renews like any other session**, bounded by two deadlines instead of one:

| Deadline    | Value                              | Behaviour                           |
| ----------- | ---------------------------------- | ----------------------------------- |
| Idle window | 30 minutes (`sessions.expires_at`) | **Slides** forward on every refresh |
| Ceiling     | 8 hours from `sessions.created_at` | **Fixed.** No activity moves it     |

Both bounds are enforced in `rotateRefreshToken` — the one function that extends a
session, and therefore the one place either can be applied. The ceiling is derived
from `created_at` rather than stored in its own column: it is a constant of the
session type, not a property of the row, and a stored copy could disagree with the
constant with only one of the two being enforced.

> **The first implementation of this was wrong, and the way it was wrong is worth
> keeping.** It computed `min(ceiling, expiryDate())` — but `expiryDate()` is
> unconditionally `now + 30 days`, so for an impersonation session the minimum was
> _always_ the ceiling. The thirty-minute idle window was applied once by
> `createSession` and then silently discarded by the first refresh, leaving an
> abandoned session with eight hours of full access instead of thirty minutes —
> exactly the exposure the ceiling was added to bound. The two constants lived in
> different modules, which is how they drifted; `IMPERSONATION_IDLE_TTL_SECONDS`
> now lives beside the clamp so both the create path and the refresh path read one
> number. **The sliding term is what varies by session type; the ceiling only trims
> it.**

### Why

The console now remembers the last clinic a super admin worked in
(`users.last_platform_organization_id`), which makes "spend the morning inside one
clinic" the expected shape of the work rather than an edge case. Against that, a
half-hour unrenewable session is not a security control:

- It signs someone out **mid-edit**, repeatedly, with no warning beyond an hour
  printed in the strip.
- The workaround is obvious and worse — keep a second tab open, or re-enter every
  half hour, typing a reason each time. Reasons typed as a formality are reasons
  nobody reads, which damages the one control this ADR actually rests on.
- It never bounded the thing worth bounding. Thirty minutes is ample to read a
  clinic's records; the exposure that matters is a forgotten session, and a
  ceiling addresses that directly where a short unrenewable window addressed it
  only by accident.

**What did not change is the part that matters.** The control was never the
session length. It is the stated reason, the audit row naming both actors, and the
strip that cannot be dismissed. All three are untouched.

### Consequences

- **`claimImpersonation` returns a real refresh token**, where it returned `''`.
- **`/impersonate` (the route handler) SETS the refresh cookie** where it deleted
  it. That deletion was load-bearing — see the second-to-last bullet under "How it
  can be broken". Overwriting serves the same purpose; leaving it alone does not.
- **The strip shows the ceiling, not `expires_at`.** A sliding deadline on screen
  is worse than none: it looks like a fact and it moves. `describeImpersonation`
  therefore takes the session's `created_at` and computes the deadline itself.
- **`req.auth.sessionStartedAt`** is new, for that computation.
- **The clamp must not touch ordinary sessions.** It keys on
  `impersonated_by_user_id`; a clamp that applied to everyone would sign the whole
  customer base out every eight hours. Pinned by
  `leaves an ordinary session on the full thirty days`.
- **`impersonation.test.ts` grew three cases** and inverted one. The inverted one
  asserted `refreshToken === ''`. The new ones measure that a refresh renews to
  thirty minutes **from now** rather than to the ceiling (this is the case that
  catches the bug above — verified by reverting the fix and watching it fail), that
  the ceiling trims a renewal on a session backdated to 7h50m, and that an ordinary
  session still gets thirty days.
- **A ceiling test must backdate `created_at` to have any force.** The clamp only
  bites in the last thirty minutes before the deadline, so a fresh session cannot
  demonstrate it — and it must pin the session **by id**, because earlier cases in
  the suite leave un-revoked impersonation sessions that a
  `WHERE impersonated_by_user_id` update would also backdate.
