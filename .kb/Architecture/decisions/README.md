# Architecture decisions

One file per decision that is expensive to reverse or easy to undo by accident.

Read the relevant one before changing the thing it describes. Several of these
exist because the decision was made _wrong_ first and corrected — the record of
why matters more than the conclusion.

| ADR                                                                     | Decision                                                     | Status                                 |
| ----------------------------------------------------------------------- | ------------------------------------------------------------ | -------------------------------------- |
| [0001](0001-organization-is-the-tenant.md)                              | Organization is the tenant, branch is the place              | Accepted                               |
| [0002](0002-roles-live-on-membership.md)                                | Roles live on the membership, not the user                   | Accepted                               |
| [0003](0003-rls-enable-not-force.md)                                    | RLS is ENABLE, not FORCE, with an owner/app role split       | Accepted, corrected once               |
| [0004](0004-composite-foreign-keys.md)                                  | Composite FKs on `(organization_id, id)`                     | Accepted                               |
| [0005](0005-tenant-scoped-prisma-client.md)                             | All queries go through `withTenant()`                        | Accepted                               |
| [0006](0006-no-json-id-arrays.md)                                       | No JSON arrays of foreign keys                               | Accepted                               |
| [0007](0007-patients-are-org-scoped.md)                                 | Patients are org-scoped, not global                          | Accepted                               |
| [0008](0008-one-billing-spine.md)                                       | One invoice system, not one per module                       | Accepted                               |
| [0009](0009-docker-first-development.md)                                | Docker-first development environment                         | Accepted                               |
| [0010](0010-next-standalone-build-only.md)                              | Next standalone output is build-only                         | Accepted, corrected once               |
| [0011](0011-own-membership-identity-bootstrap.md)                       | A user may read their own membership rows outside any tenant | Accepted                               |
| [0012](0012-impersonation-is-full-access-and-audited.md)                | Impersonation is full access; the audit trail is the control | Accepted, overrules architecture.md §6 |
| [0013](0013-we-own-the-billing-clock.md)                                | We own the billing clock; the provider only moves money      | Accepted                               |
| [0014](0014-upgrades-only-no-self-serve-downgrade.md)                   | Upgrades are self-serve; downgrades are not                  | Accepted                               |
| [0015](0015-slot-duration-has-one-source.md)                            | Slot duration has one authoritative source                   | Accepted                               |
| [0016](0016-patient-identity-is-org-wide-attendance-is-branch-local.md) | Patient identity is org-wide; attendance is branch-local     | Accepted, extends 0007                 |
| [0017](0017-theme-is-a-device-preference.md)                            | The theme is a device preference, composed not enumerated    | Accepted                               |

## Format

Context → Decision → Consequences → How it can be broken. That last section is
the important one: it names the specific way a future change could silently
undo the decision.
