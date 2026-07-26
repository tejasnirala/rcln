# 17 · Glossary

**Version:** 1.0 · Domain, tenancy and India-specific terms. Codebase symbols
are in the generated [`symbols.tsv`](symbols.tsv) — use `pnpm kb:find`.

---

## Tenancy and access

| Term                      | Meaning                                                                                                                                                                                                    |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Organization**          | **The tenant, and the paying customer.** The unit everything is scoped to. Not "clinic" — there is no clinic entity. → [ADR-0001](Architecture/decisions/0001-organization-is-the-tenant.md)               |
| **Branch**                | A physical place an organization operates from. A solo practice has one; a hospital group has several. Same shape either way                                                                               |
| **Membership**            | A person's relationship _to an organization_. One human can be a member of several organizations with different roles in each                                                                              |
| **Membership role**       | A row in `membership_roles (membership × role × branch_id NULLABLE)`. **A NULL `branch_id` means every branch in the organization.** → [ADR-0002](Architecture/decisions/0002-roles-live-on-membership.md) |
| **Permission override**   | A per-person GRANT or DENY on top of role defaults. DENY always wins                                                                                                                                       |
| **System role**           | One of 12 seeded roles with `organizationId = null`. Read-only; a tenant clones one into a custom org-scoped role. A trigger prevents shadowing a system role code                                         |
| **Effective permissions** | The resolved set for a (user, organization, branch), after DENY > GRANT > role grants. Cached in Redis, **never in the JWT**                                                                               |
| **Platform admin**        | The operator, not a tenant member. Holds all 83 permissions across every organization and bypasses the IAM guards                                                                                          |
| **Slug**                  | The subdomain label — `alpha` in `alpha.rcln.com`. 3–63 chars, lowercase alphanumeric and hyphens, not starting or ending with one, not on the reserved list                                               |
| **Tenant context**        | `app.current_org`, `app.branch_scope` and `app.current_user`, set **transaction-locally** so a pooled connection cannot carry one tenant's context into another's request                                  |

## Isolation

| Term                          | Meaning                                                                                                                                                                                                                                                   |
| ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **RLS**                       | Row-Level Security. Postgres policies filtering rows by `organization_id`. The second of three isolation layers                                                                                                                                           |
| **ENABLE vs FORCE**           | `ENABLE` applies policies to everyone **except** the table owner; `FORCE` includes the owner. rcln uses ENABLE, because the owner exists to run migrations that have no tenant context. → [ADR-0003](Architecture/decisions/0003-rls-enable-not-force.md) |
| **PERMISSIVE vs RESTRICTIVE** | PERMISSIVE policies OR together (widening); RESTRICTIVE ones AND (narrowing). The branch policies are RESTRICTIVE on purpose                                                                                                                              |
| **Composite foreign key**     | A child referencing `(organization_id, parent_id)` against the parent's `@@unique([organizationId, id])`. Makes a cross-tenant reference **unrepresentable**, not merely denied. → [ADR-0004](Architecture/decisions/0004-composite-foreign-keys.md)      |
| **`rcln_app` / `rcln_owner`** | The application role (RLS **enforced**, `NOBYPASSRLS`) and the migration role (RLS bypassed). If these are ever the same, isolation silently becomes a no-op                                                                                              |
| **`withTenant`**              | The only sanctioned way to query. Opens a transaction and sets the session variables. → [ADR-0005](Architecture/decisions/0005-tenant-scoped-prisma-client.md)                                                                                            |
| **`own_membership`**          | The one deliberate RLS widening: a user may read their own `memberships` rows when no tenant context is set. → [ADR-0011](Architecture/decisions/0011-own-membership-identity-bootstrap.md)                                                               |
| **`NULLS NOT DISTINCT`**      | Postgres index option making NULLs compare equal. Required, because a plain unique index does not constrain nullable columns                                                                                                                              |

## Auth

| Term                 | Meaning                                                                                                                               |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| **Access token**     | A 15-minute stateless JWT. Stateless so verification costs no database round-trip; short-lived because it cannot be revoked           |
| **Refresh token**    | An opaque 256-bit random string, stored **only** as a SHA-256 hash. Stateful precisely so it _can_ be revoked                         |
| **Rotation**         | Every use of a refresh token issues a new one and retires the old                                                                     |
| **Reuse detection**  | Presenting an already-rotated token revokes the **whole session family** — it is a stolen-token signal                                |
| **Session family**   | All tokens descended from one login. Revoked together                                                                                 |
| **Host-only cookie** | A cookie with no `domain` attribute, so it is valid only on the exact host. This is what stops a session at `alpha` working at `beta` |
| **BFF**              | Backend-for-frontend. `apps/web` holds the session and calls the API server-side; browser JS never sees a token                       |
| **OTP**              | One-time passcode. Hashed at rest, single-use, attempt-capped. Phone-first, because that is the Indian norm                           |

## India-specific

| Term                                | Meaning                                                                                                                                                                                          |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **DPDP Act 2023**                   | India's Digital Personal Data Protection Act. Health data is sensitive personal data. Requires explicit consent, purpose limitation, a named DPO, breach notification, and data-principal rights |
| **Data Fiduciary / Data Processor** | DPDP's controller/processor equivalent. **The clinic is the Fiduciary; rcln is the Processor**                                                                                                   |
| **GST**                             | Goods and Services Tax. `gstNumber` appears on both organizations and branches                                                                                                                   |
| **HSN**                             | Harmonised System of Nomenclature — the product classification code that determines the GST rate. Needed on every pharmacy item                                                                  |
| **ABHA**                            | Ayushman Bharat Health Account — India's national health id. `patients.abha_number` is the hook; no integration exists                                                                           |
| **ABDM**                            | Ayushman Bharat Digital Mission, the programme ABHA belongs to. Integration needs M1/M2/M3 certification                                                                                         |
| **TRAI DLT**                        | The Distributed Ledger Technology registration mandatory before any commercial SMS delivers in India. Entity, header, then each template. **1–2 weeks**                                          |
| **UPI Autopay / e-mandate**         | The recurring-payment rails Indian B2B actually uses. Why Razorpay over Stripe                                                                                                                   |
| **`lvh.me`**                        | A public domain resolving itself and every subdomain to `127.0.0.1`. Lets local multi-tenant routing work with no `/etc/hosts` edit                                                              |
| **`ap-south-1`**                    | AWS Mumbai. Chosen for **data residency**, which is a DPDP constraint, not a latency preference                                                                                                  |

## Clinical — designed, not built

Present in [`Database/schema-design.md`](Database/schema-design.md) and absent
from `schema.prisma`.

| Term                       | Meaning                                                                                                                                                           |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **MRN**                    | Medical Record Number. Branch-local, issued at registration                                                                                                       |
| **Encounter**              | One clinical interaction. `encounter_type = 'IPD'` is the hook for inpatient care                                                                                 |
| **Vitals**                 | Measurements recorded during an encounter                                                                                                                         |
| **FEFO**                   | First-Expiry-First-Out. The batch-selection rule at dispense — not FIFO, because expiry beats arrival order for medicines                                         |
| **Stock ledger**           | The append-only record of stock movement. `stock_balances` is derived from it by trigger                                                                          |
| **GRN**                    | Goods Receipt Note. What arrives against a purchase order                                                                                                         |
| **Batch**                  | A manufactured lot with its own expiry. Dispensing is always from a batch                                                                                         |
| **Clinical form template** | Versioned JSONB describing a per-specialty form. **JSONB as a document — never as a foreign key.** → [ADR-0006](Architecture/decisions/0006-no-json-id-arrays.md) |
| **Lab parameter**          | One measured value within a test. A CBC has 20+                                                                                                                   |
| **Separation of duty**     | A lab assistant enters results and cannot verify or release; a lab manager can. Already encoded in the seeded role permissions                                    |

## Billing

| Term                   | Meaning                                                                                                                             |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| **Billing spine**      | One invoice system serving every module, rather than one per module. → [ADR-0008](Architecture/decisions/0008-one-billing-spine.md) |
| **Entitlement**        | Whether a plan grants a feature. Resolves `subscription_feature_overrides` → `plan_features` → default                              |
| **Usage counter**      | A per-organization tally enforcing plan limits (`max_branches`, `max_users`) **at write time**                                      |
| **Dunning**            | The failed-payment ladder: retry d1/d3/d7 → `PAST_DUE` → 7-day grace → `SUSPENDED` (read-only, **never delete**)                    |
| **Number sequence**    | Gapless invoice numbering with a financial-year reset. A database concern, not an application one                                   |
| **Payment allocation** | Splitting one payment across several invoices                                                                                       |

## Repository

| Term               | Meaning                                                                                                                                               |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| **`.kb`**          | This KnowledgeBase. Partly generated by `.kb/generate.mjs`; never hand-edit a file carrying the generated banner                                      |
| **ADR**            | Architecture Decision Record. The load-bearing choices, in [`Architecture/decisions/`](Architecture/decisions/README.md)                              |
| **PITFALL**        | An entry in [`Architecture/PITFALLS.md`](Architecture/PITFALLS.md) — behaviour that surprises, usually something that typechecks and fails at runtime |
| **Vertical slice** | The unit of feature work: schema + RLS → contract → permission → service → route → web → test                                                         |
| **The chain**      | The API middleware order. `resolveTenant → authenticate → requireAuth → authorize → validate → handler`. **The order is the security model**          |
| **`proxy.ts`**     | What Next.js 16 renamed `middleware.ts` to. Behaviour unchanged                                                                                       |
| **`catalog:`**     | A pnpm workspace feature pinning a dependency version centrally. Used for `zod` so api, web and contracts cannot drift                                |
