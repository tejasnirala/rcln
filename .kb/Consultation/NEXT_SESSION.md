# Next session

**Read this first.** Updated at the end of every session.

**Written:** 2026-08-14 · **By:** session CE-3 · **Branch:**
`feat/ce-3-encounter-lifecycle`

---

## Where we are

**CE-0 through CE-3 are complete and verified.** A consultation now opens,
autosaves, signs and amends, and the screen renders from the encounter's own
frozen snapshot. What it does NOT yet hold is clinical content: diagnosis,
prescription, symptoms, investigations, advice, referrals, procedures,
attachments and follow-up all render a line saying when they arrive. That is
CE-4, and it is what unblocks PI-7 and PI-9.

Validation ran once, at the end, in CLAUDE.md's order. `db:rls:check` is green at
**100**. Nothing has been opened in a browser.

## The five things to know before typing

1. **A COMPOSITE FK IS IMPOSSIBLE WHEN THE PARENT MAY BE A PLATFORM ROW.**
   `encounters.template_id` is a plain FK with a RESTRICTIVE `template_visible`
   policy, because (organization_id, template_id) would refuse the platform's
   GENERAL template — the encounter's org is NOT NULL and the template's is not.
   **CE-4's `encounter_prescriptions.product_id` is the same shape** and needs
   `product_visible`, exactly as `batches` has it.

2. **A COMPOSITE PRISMA RELATION STILL READS EMPTY FOR A PLATFORM ROW.** The
   CE-2 trap, unchanged: load children by the parent's id and let RLS scope them.

3. **NOTHING EDITS A FINALIZED ENCOUNTER.** `assertDraft` guards every writer and
   `encounters_lifecycle_facts` guards the row. A correction is a NEW encounter
   citing the old one; CE-4's children hang off whichever encounter is live, and
   an amendment copies them rather than moving them.

4. **THE SNAPSHOT IS FROZEN AT OPEN, NOT AT FINALIZE.** `parseStoredDefinition`
   is the one door to it and `sectionConfigs` is the one way to render it. A
   service that resolves the LIVE template to display a stored consultation has
   reintroduced §29.

5. **`pnpm typecheck` and `pnpm test` both OOM the api container.** Run per
   package, or per batch of ~13 integration files with
   `--max-old-space-size=3072`. Tests LAST and ONCE. And **re-run `db:seed`
   AFTER the packages build** if you add a permission code — the seed reads
   `packages/permissions/dist`, and a stale one cost a round here.

## Next task

**CE-4 — clinical content sections.** The eight child tables, all org + branch
scoped, all carrying both ids themselves rather than inheriting through the
encounter. Plus follow-up recommendation UI and fulfilment (CD-13), server-side
search on every selector (§39), and `DocumentType.CLINICAL_ATTACHMENT`.

What CE-3 hands it:

| From CE-3                             | What CE-4 does with it                                  |
| ------------------------------------- | ------------------------------------------------------- |
| `encounters` + the composite unique   | the parent every child composite-FKs to                 |
| `PENDING_SECTIONS` in the engine      | delete an entry as each component lands                 |
| `validateEncounter`                   | descriptor sections only — children validate themselves |
| `encounter_follow_up_recommendations` | the table CE-1 shipped, now with a real writer          |
| `ClinicalDurationUnit`                | `encounter_symptoms.duration`, already there            |

## Do not

- Do not compose a foreign key onto a table that allows a NULL `organization_id`
  — write the `*_visible` policy instead (item 1).
- Do not edit a finalized encounter, or add an endpoint that could.
- Do not read `definition` or `template_snapshot` without `parseStoredDefinition`.
- Do not autosave with `revalidatePath` — it fights the cursor.
- Do not add a specialty check to any component in `apps/web` (§33).
- Do not put master-item ids inside `encounter_sections.data` — a document is
  not a place for a foreign key (CD-6, ADR-0006). Coded content is its own table.
- Do not build the visual map. `mapCode` is still carried and unresolved (CE-6).
