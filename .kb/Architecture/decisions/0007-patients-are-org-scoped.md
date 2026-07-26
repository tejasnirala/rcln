# ADR-0007 — Patients are org-scoped, not global

**Status:** Accepted

## Context

The requirement was "a patient can be treated at multiple clinics". Read
literally that suggests a global patient directory shared across tenants.

Cross-organization patient sharing is a **consent** problem, not a schema
convenience. Two unrelated clinics on the platform must not read each other's
patient lists, and a shared row would make that a query away.

## Decision

`patients.organization_id` — the record belongs to one organization. Within it,
`patient_registrations` links a patient to each branch they visit, carrying the
branch-local MRN.

- Choosing a clinic in the UI filters on `patient_registrations`.
- A person treated by two different organizations has two `patients` rows.
- If they use the portal, both rows point at one `users` row via
  `patients.user_id`, so one login sees both — with a clinic picker built from
  `patients ⋈ patient_registrations`.

## The nullable `user_id`

A patient **record** and a patient **login** are different things.

Front desk registers a walk-in: a `patients` row with `user_id = NULL`, no
credentials, no membership. That person can be treated, prescribed for and
billed forever without an account. If they later sign up, a `users` row is
created and linked.

Forcing a `users` row at registration produces a million credential-less
accounts and a unique-email constraint that fights you every time two family
members share a phone number.

## Consequences

- No global patient search across tenants. This is intentional.
- Cross-org linkage, if ever needed, requires a consent-gated linking table
  designed explicitly — not a schema shortcut.
- `uhid` is unique per organization; `mrn` is per branch.

## How it can be broken

Dropping `organization_id` from `patients` to "simplify" cross-clinic lookup.
