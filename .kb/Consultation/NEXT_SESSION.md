# Next session

**Read this first.** Updated at the end of every session.

**Written:** 2026-08-14 · **By:** session CE-2 · **Branch:**
`feat/ce-2-templates-resolver`

---

## Where we are

**CE-0, CE-1 and CE-2 are complete and verified.** The configuration layer is
done: a template resolves from an appointment, and `@rcln/clinical` decides what
a definition means. Nothing renders a consultation yet — that is CE-3.

Validation ran once, at the end, in CLAUDE.md's order. `db:rls:check` is green at
**98**. Nothing has been opened in a browser.

## The five things to know before typing

1. **A COMPOSITE PRISMA RELATION RETURNS NOTHING FOR A PLATFORM ROW.** The
   relation is (organization_id, parent_id) -> (organization_id, id), and for a
   platform parent `organization_id` is NULL — so the join compiles to
   `organization_id = NULL`, which is NULL rather than true. The relation comes
   back EMPTY, nothing errors, and the platform row looks childless. This cost a
   real bug in CE-2: every unclassified doctor on the platform got "no published
   template applies". **CE-3's `encounters` will meet it again** — load children
   by the parent's id and let RLS scope them.

2. **Nothing reads a raw `definition`.** `parseStoredDefinition` in
   `services/clinical/definition.ts` is the only door, and it throws rather than
   returning an empty configuration. A service that reaches into the JSONB has
   deleted the guarantee `packages/clinical` exists to provide.

3. **A published version is immutable in every field, including its dates.**
   `assertVersionIsDraft` guards every writer. The one exception is the SEED,
   which refreshes the platform template's published document in place —
   documented where it happens, and safe only because a finalized encounter will
   render from its own frozen `template_snapshot`.

4. **`pnpm typecheck` and `pnpm test` both OOM the api container.** Run per
   package, or per batch of ~8 integration files with
   `--max-old-space-size=3072`. Tests LAST and ONCE.

5. **Any platform row a test inserts outlives the test.** The isolation harness
   deletes organizations; a NULL-org row does not cascade. A parentless platform
   specialty broke `clinical-taxonomy` on the following run.

## Next task

**CE-3 — the encounter and its lifecycle.** `encounters` (CD-1: nullable
`appointment_id`, because a walk-in has no booking) + `encounter_sections`,
`DRAFT` → `FINALIZED` → `AMENDED`/`CANCELLED` with amendment as a NEW ROW
(CD-2), `clinical.encounter.amend`, debounced autosave through a Server Action
(CD-8), and `ConsultationEngine` over the section registry.

What CE-2 hands it:

| From CE-2                                   | What CE-3 does with it                           |
| ------------------------------------------- | ------------------------------------------------ |
| `GET /appointments/:id/consultation-config` | the screen specification, already resolved       |
| `visibleSections` + the registry            | which component renders each section             |
| `FieldDescriptor`                           | what `FieldRenderer` draws                       |
| `consultation_template_versions.id`         | `encounters.template_version_id`, composite-FK'd |
| the parsed definition                       | `encounters.template_snapshot` — freeze it (§29) |

## Do not

- Do not read `definition` without `parseStoredDefinition`.
- Do not select a platform row's children through a composite relation (item 1).
- Do not edit a published version, or add an endpoint that could.
- Do not add a specialty check to any component in `apps/web` (§33). The resolver
  already decided; the browser renders what it was handed.
- Do not put master-item ids inside a template `definition` (CD-6).
- Do not build the visual map. `mapCode` is carried and unresolved until CE-6.
- Do not autosave with `revalidatePath` — it re-renders per keystroke and fights
  the cursor (ARCHITECTURE.md).
