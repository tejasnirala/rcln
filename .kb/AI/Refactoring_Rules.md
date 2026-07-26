# Refactoring Rules

When you may restructure existing code, how far, and what must not move.

---

## The default posture

**Smallest correct change.** Leave the code cleaner than you found it, but do
not rewrite unrelated things. One bug, one fix.

This repository is unusually well-commented and internally consistent. Most
"improvements" an agent is tempted to make — renaming for clarity, extracting a
helper, reordering for symmetry — are net negative here, because they enlarge
the diff a human must review on a codebase where the reviewer's attention is the
scarce resource protecting patient data.

---

## Refactor freely

No approval needed. These are local, reversible, and cannot change behaviour.

- Extracting a repeated expression into a local within the same function.
- Renaming a **local** variable for clarity.
- Replacing a duplicated literal with a named constant in the same file.
- Deleting genuinely dead code you can prove is unreferenced —
  `pnpm kb:find <name>` plus a `grep` across `apps` and `packages`.
- Adding a comment that records a _why_ you had to work out.
- Tightening a type that was looser than the value it holds.

---

## Refactor with care, and say so

Do these when they are on the path of the task, and call them out in your
summary.

| Change                                     | Care required                                                                                                                        |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------ |
| Extracting a shared helper into a module   | Run `pnpm kb:find` first — it may already exist. Place it beside its siblings, not in a new `utils` grab bag                         |
| Lifting a local helper to an export        | It is now API. Give it a doc comment and expect it to be reused wrongly                                                              |
| Consolidating two near-duplicate functions | Only if they are the _same_ rule. Two functions that merely look alike often encode different business rules that will diverge again |
| Changing a Zod contract                    | Both api and web consume it. Grep both                                                                                               |
| Changing an error message                  | Auth messages are deliberately uniform to resist enumeration. Do not "improve" them                                                  |
| Reordering imports or reformatting         | Prettier owns formatting. Do not fight it manually                                                                                   |

---

## Do not refactor without explicit approval

These are load-bearing. Changing them is a decision, not a cleanup.

### The security chain

- **The API middleware order.** It is the security model, not a style choice.
  See [Development_Guidelines](Development_Guidelines.md#api) for why each step
  sits where it does.
- **`withTenant` / `forTenant` / `setTenantContext` / `withUserIdentity` in
  `packages/db/src/tenant.ts`.** The transaction-local `set_config` is the only
  thing standing between a pooled connection and a cross-tenant leak.
- **`assertRlsActive()`.** It refuses to boot the app on an RLS-bypassing
  connection. It looks like a startup nuisance. It is the guard against the most
  common way teams ship RLS that does nothing.
- **The permission resolver** (`packages/permissions/src/resolver.ts`) and its
  DENY > GRANT > role-grant precedence. 25 tests pin this matrix; if a change
  makes them fail, the change is wrong.
- **The four escalation guards** in `apps/api/src/services/iam/guards.ts`. The
  database does not enforce these. They are the only thing preventing privilege
  escalation through the IAM screens.
- **Constant-time comparisons, dummy hashes and uniform failure messages** in
  the auth services. They look like redundant work. They are timing- and
  enumeration-resistance.

### The data layer

- **Any applied migration.** Prisma checksums them; editing one in place breaks
  every environment. Write a new migration.
- **RLS policy SQL** in `packages/db/prisma/rls/enable-rls.sql`, and the
  `EXEMPT` list in `packages/db/scripts/check-rls.ts`. Each exemption carries a
  written reason; removing or adding one is a security decision.
- **Composite foreign keys.** They look redundant next to a plain FK. They are
  what makes a cross-tenant reference unrepresentable rather than merely denied.

### The contracts

- **The response envelope** `{ success, message?, data?, errors? }`. Every route
  and every web consumer depends on its shape.
- **Permission codes** in `packages/permissions/src/codes.ts`. They are seeded
  into the database. Renaming one orphans every `role_permissions` row that
  references it.

---

## Refactors this codebase actively wants

Recorded so an agent with spare capacity spends it well. Full list with severity
in [`15_Known_Issues_and_Technical_Debt.md`](../15_Known_Issues_and_Technical_Debt.md).

1. **Move the four IAM escalation guards into the database** as RESTRICTIVE
   policies or triggers, so a direct SQL write cannot bypass them.
2. **Add `data_access_logs`** — PHI reads are not audited, and "who looked at
   this patient's file" is the question asked after an incident.
3. **Give the audit log a viewer.** Rows exist and are unreadable outside psql.
4. **Replace the notification stub with a real provider abstraction**, once DLT
   registration unblocks it. The seam already exists; the shape does not.
5. **Worker processors.** Every queue is registered and nothing consumes them,
   which means a job enqueued today is silently lost.

Each of these is a _feature_ with a security or operability rationale, not a
tidy-up. Treat them as such: they need a plan, tests, and probably an ADR.

---

## How to verify a refactor did nothing

A refactor that changes behaviour is a bug with good intentions.

```bash
docker compose exec api pnpm validate       # typecheck + lint + 200 tests
docker compose exec api pnpm db:rls:check   # if anything near the schema moved
pnpm kb                                     # the index must reflect the new shape
```

Then read the diff yourself as a reviewer would. If you cannot state in one
sentence why each hunk is necessary for the task, that hunk should not be there.
