# Security Policy

rcln is multi-tenant software that stores **protected health information** in a
shared database. The realistic worst case for a bug here is one clinic reading
another clinic's patient records. Security reports are treated accordingly.

## Project maturity

rcln is **pre-1.0 and under active development**. It has not been through an
external security audit, a penetration test, or any healthcare compliance
certification. Do not run it against real patient data without your own review.
See [`.kb/STATUS.md`](.kb/STATUS.md) for what is actually built.

## Supported versions

| Version         | Supported                |
| --------------- | ------------------------ |
| `main`          | ✅ Fixes land here       |
| Anything tagged | ❌ Pre-1.0, no backports |

## Reporting a vulnerability

**Do not open a public issue for a security problem.**

Report it through GitHub's private vulnerability reporting:

👉 **[Report a vulnerability](https://github.com/tejasnirala/rcln/security/advisories/new)**

(Repository → _Security_ tab → _Report a vulnerability_. The report is visible
only to you and the maintainers.)

Please include:

- What breaks, and the impact — especially whether it crosses a tenant boundary
- Steps to reproduce, ideally against a clean `docker compose up`
- Affected commit or branch
- Any proof-of-concept, with **synthetic data only**

### What to expect

| Stage              | Target                  |
| ------------------ | ----------------------- |
| Acknowledgement    | within 5 business days  |
| Initial assessment | within 10 business days |
| Fix or mitigation  | depends on severity     |

This is a small project without a dedicated security team; these are honest
targets, not a contractual SLA.

## Scope

Especially interested in reports about:

- **Tenant isolation** — anything that reads or writes across `organization_id`,
  bypasses row-level security, or escapes the `withTenant` scoping
- **Authentication and sessions** — JWT handling, refresh-token rotation and
  reuse detection, phone-OTP flows, subdomain-to-organization resolution
- **Authorization** — permission checks, role scoping via `membership_roles`,
  branch-scoped grants, super-admin impersonation
- **PHI exposure** — patient data in logs, Redis, URLs, `localStorage`, cookies,
  error responses, or audit trails
- **Injection** — raw SQL, Prisma `$queryRaw`, template rendering
- **Secrets** — anything committed, leaked in a build artifact, or logged

## Out of scope

- Findings against a deployment you do not own or have written permission to test
- Missing hardening on the local Docker Compose stack (it ships with obviously
  weak development credentials — that is deliberate and documented)
- Automated scanner output with no demonstrated impact
- Denial of service through raw volume, social engineering, or physical access

## Please do not

- Test against anyone else's rcln deployment
- Use real patient data in a report or proof-of-concept
- Publicly disclose before a fix is available

Good-faith research reported privately will not be met with legal action, and
reporters are credited in the advisory unless they ask otherwise.
