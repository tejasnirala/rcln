# Architecture decisions

One file per decision that is expensive to reverse or easy to undo by accident.

Read the relevant one before changing the thing it describes. Several of these
exist because the decision was made _wrong_ first and corrected — the record of
why matters more than the conclusion.

| ADR                                               | Decision                                                     | Status                   |
| ------------------------------------------------- | ------------------------------------------------------------ | ------------------------ |
| [0001](0001-organization-is-the-tenant.md)        | Organization is the tenant, branch is the place              | Accepted                 |
| [0002](0002-roles-live-on-membership.md)          | Roles live on the membership, not the user                   | Accepted                 |
| [0003](0003-rls-enable-not-force.md)              | RLS is ENABLE, not FORCE, with an owner/app role split       | Accepted, corrected once |
| [0004](0004-composite-foreign-keys.md)            | Composite FKs on `(organization_id, id)`                     | Accepted                 |
| [0005](0005-tenant-scoped-prisma-client.md)       | All queries go through `withTenant()`                        | Accepted                 |
| [0006](0006-no-json-id-arrays.md)                 | No JSON arrays of foreign keys                               | Accepted                 |
| [0007](0007-patients-are-org-scoped.md)           | Patients are org-scoped, not global                          | Accepted                 |
| [0008](0008-one-billing-spine.md)                 | One invoice system, not one per module                       | Accepted                 |
| [0009](0009-docker-first-development.md)          | Docker-first development environment                         | Accepted                 |
| [0010](0010-next-standalone-build-only.md)        | Next standalone output is build-only                         | Accepted, corrected once |
| [0011](0011-own-membership-identity-bootstrap.md) | A user may read their own membership rows outside any tenant | Accepted                 |

## Format

Context → Decision → Consequences → How it can be broken. That last section is
the important one: it names the specific way a future change could silently
undo the decision.
