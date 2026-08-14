# Clinical Consultation Engine

The single source of truth for the **Consultation Engine** work stream —
the generic, configuration-driven clinical consultation platform. Everything
about this programme lives in this directory. Start here.

```text
CURRENT PHASE:        CE-1 — Clinical foundation
CURRENT STATUS:       IN PROGRESS
LAST COMPLETED PHASE: CE-0 — Repository analysis (complete, no code)
CURRENT WORK:         schema + RLS for the clinical masters, episodes and
                      follow-up recommendations
NEXT PHASE:           CE-2 — Templates and the configuration resolver
BLOCKERS:             none. Everything CE needs already exists in the repo.
BRANCH:               feat/ce-1-clinical-foundation
LAST UPDATED:         2026-08-14
```

---

## Why this directory is here and not in `/docs`

Same reason as `.kb/PharmacyInventory/`: `docs/` is a directory of pointer stubs
and says so. Nothing here carries the `.kb/generate.mjs` generated banner — all
of it is hand-written and safe to edit, and `pnpm kb` does not touch it.

---

## Purpose

One consultation engine that serves human and veterinary care, dentistry,
dermatology, hair & scalp, cardiology, ophthalmology, orthopaedics, ENT, general
medicine and whatever comes next — **without one screen per specialty**.

```text
Hard-coded          the engine, the component registry, business logic,
                    validation, permissions, prescription behaviour, autosave,
                    finalization, the visual-map renderer

Configuration       domains, specialties, templates, sections, fields,
                    symptoms, diagnoses, procedures, investigations, advice,
                    visual maps, anatomical regions, section order and visibility
```

Adding a specialty should cost a configuration row, a handful of master items
and optionally a map — never a new page, a new component or a new service.

⚠️ **It is deliberately NOT "JSON controls the frontend".** The section types are
a closed enum with a hard-coded component per member. Configuration decides
whether a section appears, where, labelled how, over which vocabulary. It cannot
invent a section the engine has no component for.

---

## The documents

| Document                                               | Read it when                                                              |
| ------------------------------------------------------ | ------------------------------------------------------------------------- |
| [MASTER_PLAN.md](MASTER_PLAN.md)                       | You want the phases, their order, and what each one ships                 |
| [DECISIONS.md](DECISIONS.md)                           | **Before arguing with anything.** CD-1…CD-13, with the reasoning          |
| [ARCHITECTURE.md](ARCHITECTURE.md)                     | You are building the engine — registry, templates, versioning, resolution |
| [SCHEMA.md](SCHEMA.md)                                 | You are touching the database. Table by table, with tenancy class and RLS |
| [FOLLOW_UP_ARCHITECTURE.md](FOLLOW_UP_ARCHITECTURE.md) | Anything about chains, episodes, recommendations or recall                |
| [EXISTING_ARCHITECTURE.md](EXISTING_ARCHITECTURE.md)   | **Before adding anything.** What the repo already has, and what to reuse  |
| [IMPLEMENTATION_TRACKER.md](IMPLEMENTATION_TRACKER.md) | You want to know what is done                                             |
| [CHANGELOG.md](CHANGELOG.md)                           | The per-phase report: what landed, files, schema, APIs, tests             |
| [NEXT_SESSION.md](NEXT_SESSION.md)                     | **Start of every session.** Where we are and what bites                   |

---

## The three things that will bite you

**1. The repo already has most of the foundation, and re-inventing it is the
main risk.** `specialties` is already an arbitrary-depth clinical taxonomy with
platform-plus-tenant extension. `clinical.encounter.*` and
`clinical.prescription.*` already exist and are already held by DOCTOR alone.
`appointments.parent_appointment_id` already implements the follow-up chain.
Read [EXISTING_ARCHITECTURE.md](EXISTING_ARCHITECTURE.md) before you type
`model`.

**2. A configuration that says nothing checkable must be an ERROR, not a
permissive default.** This is PI-5's worst review finding, transplanted:
`{ "require": true }` for `{ "required": true }` is one typo, and a validator
that reads an absent key as "not required" silently switches off a mandatory
field on a clinical form. Every field descriptor is parsed and validated in
`packages/clinical` before it is acted on. Nothing reads a raw `definition`
document directly.

**3. This is the densest PHI in the product.** A diagnosis is more sensitive
than a name. Every read that discloses one patient's clinical content writes a
`data_access_logs` row; nothing clinical reaches `audit_logs` as free text; no
diagnosis, complaint or prescription goes in a URL, a cookie, a log line or
Redis. Ids only, everywhere.
