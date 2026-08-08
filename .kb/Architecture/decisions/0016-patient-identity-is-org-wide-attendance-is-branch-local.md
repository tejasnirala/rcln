# ADR-0016 — Patient identity is org-wide; attendance is branch-local

**Status:** Accepted

Extends [ADR-0007](0007-patients-are-org-scoped.md), which settled that a
patient record belongs to one organization rather than to the platform. This one
settles the question underneath it: **where inside an organization does the
branch boundary fall?**

## Context

Every other branch-aware table in this system carries a RESTRICTIVE
`branch_isolation` policy — `membership_roles`, `membership_permission_overrides`,
`doctor_schedules`. The pattern is established and applying it to `patients`
looks like the obvious, more-secure default: a receptionist at the Indiranagar
branch should not read the Whitefield branch's patient list.

It is the wrong default here, and the reason is not a performance one.

**A branch-scoped duplicate check is impossible.** Registration begins with the
front desk searching for the person in front of them. If `patients` were branch
isolated, that search returns nothing for someone head office registered last
week — so the desk registers them again. The clinic now holds two `patients`
rows and two UHIDs for one human being, and **the second one has no allergies on
it**. The next prescriber reads the record they were handed, which is the empty
one. That is a clinical safety failure with a clean audit trail and no error
anywhere.

**Clinical facts follow the person, not the building.** A penicillin allergy
recorded at branch A is true at branch B. Hiding it produces the same failure by
a shorter route.

The counter-argument — a receptionist browsing another branch's patient list is
a privacy problem — is real, but it is a _disclosure_ problem, and this codebase
already has the instrument for disclosure: `data_access_logs` records who read
whose chart, and a cross-branch read is exactly the pattern that table exists to
surface. Preventing the read costs a duplicate record; logging it costs a row.

## Decision

The boundary falls on **attendance**, not identity.

| Table                                                            | `tenant_isolation` | `branch_isolation` |
| ---------------------------------------------------------------- | ------------------ | ------------------ |
| `patients`                                                       | yes                | **no**             |
| `patient_addresses`, `patient_contacts`                          | yes                | **no**             |
| `patient_allergies`, `patient_conditions`, `patient_medications` | yes                | **no**             |
| `patient_registrations`                                          | yes                | **yes**            |

`patient_registrations` is the row that answers _"does this person attend our
clinic?"_. Its `branch_id` is NOT NULL, so its policy is absolute — a
branch-scoped user cannot read another branch's registration list or its MRN
series, and cannot register a patient into a branch they have no scope for.

Consequently:

- **The patient list a receptionist sees is driven off the registration join**,
  not off `patients`. The default list is "registered at one of my branches",
  and RLS makes that filter enforced rather than remembered — the join simply
  returns nothing for branches out of scope.
- **Search is deliberately org-wide**, and every search writes a
  `data_access_logs` row with `accessType = SEARCH` and a SHA-256 of the term.
  Searches are never deduplicated, so repeatedly searching for the same person
  stays visible as the pattern it is.
- **Reading a patient not registered at any of your branches is permitted and
  logged.** The service marks that read `crossBranch` on the response so the
  screen can say so, rather than presenting another branch's patient as one of
  its own.

## Consequences

- A user with an empty `branchIds` scope sees no registrations at all, and
  therefore an empty patient list — correct, and it fails closed.
- Registering an existing patient at a second branch is an INSERT into
  `patient_registrations`, never a second `patients` row. The MRN is issued from
  that branch's own `MRN` counter, so branch A and branch B both start at 1.
- A future "merge two patient records" flow is still required — this decision
  reduces duplicates, it does not make them impossible, since the same person
  can be registered twice at one branch under two spellings. `patients.status =
MERGED` and `merged_into_id` exist for it, with a CHECK constraint tying the
  two together.
- Anything Phase 4/5 hangs off a patient (encounters, invoices, dispenses) is
  branch-local and must carry its own `branch_id` and its own
  `branch_isolation`. It must not rely on reaching a branch through `patients`,
  which has none.

## How it can be broken

Adding `branch_isolation` to `patients` "for consistency" with the other
branch-aware tables. It will pass every single-tenant test, and the damage —
duplicate records with empty allergy lists — appears weeks later in a table
nobody is watching.

The subtler version: writing the patient list query against `patients` directly
instead of through `patient_registrations`, because it is one fewer join. That
silently turns the branch boundary off, since `patients` has no policy to
enforce it.
