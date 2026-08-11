# 15 · Known Issues and Technical Debt

**Version:** 1.0

Derived from reading the source, `STATUS.md`, `PHASE-1-PLAN.md` and
[`Architecture/PITFALLS.md`](Architecture/PITFALLS.md). **No penetration test,
dependency audit, load test or profiling run has been performed** — nothing here
comes from measurement unless it says so.

`PITFALLS.md` is the companion: it records behaviour that _surprises_. This file
records work that is _owed_.

---

## Summary

| Severity     | Count | Theme                                                                                                |
| ------------ | ----- | ---------------------------------------------------------------------------------------------------- |
| **Critical** | 3     | Enforcement that exists only in application code, and a promise made to users with no implementation |
| **High**     | 7     | Unaudited PHI reads, no MFA, no delivery, nothing deployed                                           |
| **Medium**   | 9     | Missing gates, missing operability, known scaling limits                                             |
| **Low**      | 6     | Polish, consistency, small gaps                                                                      |

---

## Critical

### C1 · Privilege-escalation guards are application-only

**Where.** `apps/api/src/services/iam/guards.ts`
**What.** Three guards stand between `iam.role.manage` and privilege escalation.
None is enforced by the database, and two _cannot_ be — the database has no idea
what its caller is allowed to do. A direct SQL write, a future service that
forgets to call them, or a bug in `authorize()` bypasses all three.
**Evidence it matters.** Measured, in `iam.test.ts`: with `coversEveryBranch`
removed, the escalation request returns **201 and the grant is real**.
**Fix.** Move what can be moved into RESTRICTIVE policies or triggers. Accept
and document the residue.

### C2 · The legal pages promise a capability that does not exist

**Where.** `apps/web/src/app/(marketing)/legal/` — privacy clause 7, DPA
clause 5.
**What.** DPDP erasure was resolved as **irreversible anonymisation** rather
than deletion, and both documents now say so. **No anonymisation routine exists
in code.**
**Why critical.** This is a commitment made to data principals that the system
cannot honour. It is a compliance exposure, not an engineering nicety.
**Fix.** Either implement it, or remove the claim until it exists.

### C3 · Legal pages are unreviewed drafts in a shipped surface

**Where.** Same, plus the signup consent checkbox that links to them.
**What.** ~30 unfilled placeholders — entity name, CIN, registered address, DPO,
grievance contact, notice periods, subprocessor list, uptime target — behind a
visible "not yet in force" banner.
**Fix.** `grep -rn "Placeholder>" "apps/web/src/app/(marketing)/legal"`, fill,
get counsel sign-off, remove the banner.

---

## High

### H1 · PHI reads are not audited

`data_access_logs` does not exist. Mutations are audited; reads are not. "Who
looked at this patient's file" is the question asked after an incident, and
today there is no answer. Best built **before** patient data exists.

### H2 · No MFA for platform admins

A super admin holds all 83 permissions across every organization and bypasses
all three IAM guards. There is no second factor. `otplib` is already installed
and unused. One credential compromise is every tenant's data.

### H3 · Nothing is deployed, and nothing has been pushed

No staging, no production, git remote configured but never pushed. Every
statement about production behaviour in this KnowledgeBase is structural
reasoning, not observation. Staging in particular is load-bearing: **RLS bugs do
not appear in single-tenant local testing.**

### H4 · No notification delivery

OTP codes and invitation links reach the application log and nowhere else. All
the surrounding logic is real; only dispatch is missing. Hard-blocked on **TRAI
DLT registration (1–2 weeks, external)** — which is why it should have been
started already.

### H5 · Worker queues consume nothing

Every queue is registered in `apps/worker/src/queues.ts`; no processor exists. A
job enqueued today is accepted and silently lost. The failure is invisible,
which is the worst property a background system can have.

### H6 · No E2E or frontend tests

All tests sit at the API and unit layers. No Playwright, no component tests, no
Server Action tests. The signup → login flow has never been exercised in a real
browser, and Server Actions carry real logic. A working API and a broken screen
are indistinguishable from the current suite.

⚠️ **`apps/web` was briefly given a test suite, and it was removed rather than
kept.** Two files asserted the theme — every appearance × accent pair's contrast,
parsed out of `theme.css`, and that every id in `ACCENTS` had a matching
`[data-accent]` block. They were correct and worth having. They arrived with a
jest toolchain declared in `apps/web/package.json` but absent from
`pnpm-lock.yaml` and never installed, so `@rcln/web#typecheck` failed on the test
files themselves and took `pnpm validate` red for the whole workspace. Deleting
them was the smaller of two wrongs; standing `apps/web` up for tests properly is
a task nobody has done.

What that costs today, concretely: the ten theme combinations were
contrast-measured by hand and nothing re-measures them, and the TypeScript ↔ CSS
accent pairing is a string match that neither typechecks nor lints. Changing a
hex in `theme.css` is unguarded. →
[ADR-0017](Architecture/decisions/0017-theme-is-a-device-preference.md)

### H7 · Impersonation is unbuilt, non-trivial, and its ADR is missing

A platform admin has no membership, so `loadUserAccess` returns null and every
branch-scoped write would be refused. The session it mints must carry a real
branch scope. Separately: **`ADR-0012` is cited in `guards.ts:42` and in
`PHASE-1-PLAN.md` and does not exist in `Architecture/decisions/`.** Code
currently justifies a security behaviour by pointing at a document nobody wrote.

---

## Medium

### M1 · No PgBouncer

Every tenant query is a transaction, and Node with Prisma opens connections
greedily. The target design specifies transaction-mode pooling. This is the
first thing that breaks under real concurrency, and no load test exists to find
out when.

### M2 · No dependency or image scanning

No Dependabot, no `pnpm audit` in CI, no Trivy. The repository has good instincts
about _adding_ dependencies and no process for the ones already present.

### M3 · Audit log is not tamper-evident

Append-only is a convention. Nothing at the database level prevents an `UPDATE`
or `DELETE` on `audit_logs`, and there is no hash chain.

### M4 · No audit viewer

Rows exist and are readable only through psql. An audit trail nobody can read
during an incident is doing half its job.

### M5 · No secret rotation, and seeded credentials are weak by default

`SUPERADMIN_PASSWORD` ships as `ChangeMe!SuperAdmin1`. Nothing forces a change.
No managed secret store, no rotation.

### M6 · No response validation on the web side

`@rcln/contracts` types the response; nothing parses it at runtime. A backend
shape change reaches the browser as an undefined-property crash rather than a
clear error.

### M7 · No load testing and no performance baseline

No k6, no p95, no query-plan review. And multi-tenant failure modes differ:
50 concurrent _tenants_ is the interesting test, not 50 users on one tenant.

### M8 · Accessibility claims are unverified by tooling

The pass was measured for contrast and target size and code-reviewed. Real
screen-reader behaviour and the OS reduced-motion toggle have never been
exercised. A published accessibility claim with no evidence behind it.

### M9 · No settings service despite the mechanism existing

`SettingDefinition` / `SettingValue` are modelled and 12 definitions are seeded.
Nothing reads them, and there is no UI. Seeded data that nothing consumes tends
to drift out of shape before its first use.

---

## Low

### L1 · Documentation cites a target as if it were current

`Architecture/architecture.md` describes ECS, PgBouncer, CloudFront, Sentry and
more, none of which exist. It is a good document being read as the wrong kind of
document. Partly mitigated by the labelling in this KnowledgeBase.

### L2 · Branch closures are modelled with no screen

`BranchClosure` exists; nothing manages it.

### L3 · No invitation expiry sweep

Expired invitations are filtered at read time and never deleted. Rows
accumulate.

### L4 · Custom domains are modelled with no verification flow

`organization_domains.isPlatformSub` anticipates them; there is no
issuance or verification mechanism.

### L5 · Marketing placeholders remain

No real OG image; footer brand facts are placeholders;
`apps/web/src/lib/analytics.ts` is a deliberate no-op seam pending a DPDP
consent decision.

### L6 · `STATUS.md` and `guards.ts` disagree on a count

`STATUS.md` says "four escalation guards"; the header of `guards.ts` says
"the three guards". Trivial, but it is the kind of drift that erodes trust in
the rest of the document.

---

## Deliberately deferred — not debt

Recorded in `STATUS.md` so a future session does not "discover" these as gaps.
They are decisions.

| Not built                | Why                                                                                               |
| ------------------------ | ------------------------------------------------------------------------------------------------- |
| IPD, beds, OT scheduling | `encounters.encounter_type = 'IPD'` is the hook; the module is additive                           |
| Insurance claims / TPA   | `patient_insurances` holds the policy; adjudication is its own subsystem                          |
| ABDM / ABHA integration  | Schema hooks only. Session state belongs in Redis, not Postgres                                   |
| Schema-per-tenant        | Shared schema + RLS scales without migration fan-out; `organization_id` keeps extraction possible |
| `packages/ui`            | An empty shadcn package is noise until there are components                                       |
| tRPC / ts-rest           | Zod contracts cover it; revisit if a mobile app appears                                           |

---

## Suggested order of work

Ranked by risk reduced per unit of effort, not by severity alone.

1. **H2 — MFA for platform admins.** The library is installed. Highest risk
   reduction available for the effort.
2. **C2/C3 — legal pages.** Mostly a human task, and it is a live compliance
   exposure.
3. **H1 — `data_access_logs`.** Cheap now, expensive to retrofit after patient
   data exists.
4. **C1 — move the guards into the database**, for the one of three that can be,
   and document the residue.
5. **M2 — dependency and image scanning.** A day of CI work.
6. **H4 — start TRAI DLT registration.** It is a 1–2 week external wait; the
   engineering is one file.
7. **H6 — one E2E test** covering register → login → invite → accept. Not a
   suite; one test that would catch a broken screen.
8. **H3 — staging with two real tenants**, and re-run the isolation suite there.
9. **M1 — PgBouncer**, before any load test would mean anything.
10. **H5 — one real worker processor**, so the queue path is proven end to end.
