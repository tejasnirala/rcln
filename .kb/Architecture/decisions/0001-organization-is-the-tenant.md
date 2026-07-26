# ADR-0001 — Organization is the tenant, branch is the place

**Status:** Accepted

## Context

The product serves both a single-location clinic and a hospital chain with
several branches. The obvious modelling is a `clinics` table, with some later
bolt-on for chains. The predecessor product did exactly that and had no concept
of a branch at all.

## Decision

There is no "clinic" entity. There is:

- `organizations` — the tenant. Owns the subdomain, the subscription, the data.
- `branches` — a physical location belonging to an organization.

A solo clinic is one organization with one branch. PMCS with branches A, B and C
is one organization with three. The shapes are identical.

## Consequences

- Opening a second location is an `INSERT`, never a migration.
- Every operational table carries `organization_id`; anything that happens at a
  location also carries `branch_id`.
- Subscription limits (`max_branches`) are meaningful without special-casing.
- Registration must create an organization _and_ a first branch in one
  transaction — an org with no location cannot take a booking, so there is no
  meaningful intermediate state.

## How it can be broken

Adding a `clinics` table, or treating `branches` as optional. If a future
feature seems to want "an organization without branches", the correct answer is
almost always a branch with `status = 'INACTIVE'`.
