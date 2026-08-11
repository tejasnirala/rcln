# `.kb` — the rcln KnowledgeBase

Two things in one directory:

1. **A generated index** of every symbol, route, table and permission in the
   repository, so "does this already exist?" costs one command.
2. **A written KnowledgeBase** — architecture, business rules, security model,
   deployment, roadmap — absorbed from the former `docs/`, which is now a set of
   pointer stubs.

**New here?** Read [`AI/Project_Context.md`](AI/Project_Context.md), then
[`AI/Agent_Instructions.md`](AI/Agent_Instructions.md). Everything else is
reference.

---

## Answering a question, cheapest first

| Question                                                      | Do this                                                       |
| ------------------------------------------------------------- | ------------------------------------------------------------- |
| Does a function/const/component/hook for X exist?             | `pnpm kb:find <pattern>`                                      |
| …exported only, or one kind only?                             | `pnpm kb:find <pattern> --export --kind fn`                   |
| What lives in this area, with signatures?                     | `Symbols/<area>.md` — find it in [`INDEX.md`](INDEX.md)       |
| What endpoints exist, behind which middleware and permission? | [`APIs/_index.md`](APIs/_index.md)                            |
| What tables exist, and is one RLS-covered?                    | [`Database/_index.md`](Database/_index.md)                    |
| Who can do what?                                              | [`09_Roles_and_Permissions.md`](09_Roles_and_Permissions.md)  |
| What does this module do, and what are its limits?            | [`06_Module_Catalog.md`](06_Module_Catalog.md)                |
| Why is it built this way?                                     | [`Architecture/decisions/`](Architecture/decisions/README.md) |
| Why is it behaving oddly?                                     | [`Architecture/PITFALLS.md`](Architecture/PITFALLS.md)        |
| What is built vs planned?                                     | [`STATUS.md`](STATUS.md)                                      |

---

## The written KnowledgeBase

| #   | Document                                                               |                                                          |
| --- | ---------------------------------------------------------------------- | -------------------------------------------------------- |
| 00  | [Project Overview](00_Project_Overview.md)                             | Executive summary, status, limitations                   |
| 01  | [Business Context](01_Business_Context.md)                             | Objectives, workflows, personas, compliance              |
| 02  | [System Architecture](02_System_Architecture.md)                       | Pattern, layers, request lifecycle, isolation            |
| 03  | [Technology Stack](03_Technology_Stack.md)                             | Every dependency and version                             |
| 04  | [Database Schema](04_Database_Schema.md)                               | Conventions, isolation, how to change it                 |
| 05  | [API Documentation](05_API_Documentation.md)                           | Auth postures, envelope, errors, endpoints               |
| 06  | [Module Catalog](06_Module_Catalog.md)                                 | _Generated_ from [`modules.json`](modules.json) + source |
| 07  | [Business Rules](07_Business_Rules.md)                                 | Every rule, with `file:line`                             |
| 08  | [Security Model](08_Security_Model.md)                                 | Authn, authz, isolation, findings                        |
| 09  | [Roles and Permissions](09_Roles_and_Permissions.md)                   | _Generated_ 12 × 83 matrix                               |
| 10  | [Deployment Guide](10_Deployment_Guide.md)                             | What exists vs what is designed                          |
| 11  | [Development Workflow](11_Development_Workflow.md)                     | Branches, hooks, review, done                            |
| 12  | [Testing Strategy](12_Testing_Strategy.md)                             | 200 tests, and the gaps                                  |
| 13  | [Integration Guide](13_Integration_Guide.md)                           | Every integration, all stubs                             |
| 14  | [Configuration Reference](14_Configuration_Reference.md)               | Every environment variable                               |
| 15  | [Known Issues & Technical Debt](15_Known_Issues_and_Technical_Debt.md) | Ranked, with severity                                    |
| 16  | [Product Roadmap](16_Product_Roadmap.md)                               | Phases 2–7, blockers                                     |
| 17  | [Glossary](17_Glossary.md)                                             | Domain, tenancy and India-specific terms                 |

| Directory                                           | Holds                                                                                                               |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| [`AI/`](AI/Agent_Instructions.md)                   | **Highest priority.** How an agent should think, build, refactor and verify here                                    |
| [`Architecture/`](Architecture/how-it-works.md)     | The tour, the target design, conventions, pitfalls, 17 ADRs                                                         |
| [`Database/`](Database/_index.md)                   | Per-model pages _(generated)_ + the full schema design document                                                     |
| [`APIs/`](APIs/_index.md)                           | Per-route-group pages _(generated)_                                                                                 |
| [`Modules/`](06_Module_Catalog.md)                  | Per-module pages _(generated)_                                                                                      |
| [`BusinessRules/`](BusinessRules/README.md)         | Per-module rule indexes                                                                                             |
| [`Security/`](Security/README.md)                   | Tenant isolation, threat model                                                                                      |
| [`Integrations/`](Integrations/README.md)           | External services — all stubs today                                                                                 |
| [`Infrastructure/`](Infrastructure/README.md)       | What is provisioned (little) and what is designed                                                                   |
| [`Symbols/`](INDEX.md)                              | Per-directory symbol tables _(generated)_                                                                           |
| [`notes/`](notes/README.md)                         | Hand-written per-module reuse notes                                                                                 |
| [`PharmacyInventory/`](PharmacyInventory/README.md) | The Product · Inventory · Pharmacy · Consumption · Procurement · Regulatory programme — plan, decisions and tracker |

---

## The search rule

**Search before you write.** Before adding any function, constant, component,
hook, Zod schema or type, run `pnpm kb:find` on what it would be called and on
what it would do. If a match exists, use it or extend it. Writing a second
`hashInviteToken` is the failure this index exists to prevent, and no diff review
reliably catches it.

`symbols.tsv` is the raw index: one line per symbol, columns
`name · kind · visibility · file:line · module · signature · summary`. Grep it
directly only with an anchored pattern — several paths contain `[slug]` and
`(marketing)`, so a bare `grep foo` matches route segments as well as names.
`kb:find` searches only the columns you name.

Kinds: `fn` `component` `hook` `action` (Next server action) `zod` `const`
`var` `class` `interface` `type` `enum`, suffixed `/async`. Non-exported
top-level symbols are indexed too, marked `local` — a local helper is still
evidence the logic exists and may want lifting rather than re-implementing.

---

## Confidence labelling

Statements in the written documents are labelled:

- **Verified** — read in source, with the file cited
- **Inferred** — derived, with the reasoning stated
- **Assumed** — plausible, unchecked

Keep the discipline when you edit. The single biggest trap in this repository is
[`Architecture/architecture.md`](Architecture/architecture.md), which is a
**target design** describing infrastructure that does not exist. Cite it as "the
target design specifies", never as "the system does".

---

## Generated vs hand-written

**Never edit a file carrying `<!-- generated by .kb/generate.mjs -->`.** It is
overwritten on the next run.

| Path                                                               | Generated |
| ------------------------------------------------------------------ | --------- |
| `INDEX.md`, `symbols.tsv`, `manifest.json`                         | yes       |
| `Symbols/*.md`, `Database/<Model>.md`, `APIs/*.md`, `Modules/*.md` | yes       |
| `06_Module_Catalog.md`, `09_Roles_and_Permissions.md`              | yes       |
| `Database/_index.md`, `APIs/_index.md`                             | yes       |
| Everything else, including `Database/schema-design.md`             | **no**    |

To change a generated file, change its source: the code, `.kb/modules.json`
(module narrative), `packages/permissions` (the matrix), or `generate.mjs`.

`Database/schema-design.md` lives inside a generated directory and is
hand-written. The generator only removes files it previously generated, tracked
in `manifest.json`, so it is safe there.

---

## Keeping it current

`pnpm kb` regenerates in about a fifth of a second. It runs automatically:

- **Claude Code** — a `Stop` hook regenerates whenever the session touched a
  `.ts`/`.tsx`/`.prisma` file
- **`git push`** — the pre-push hook regenerates and **rejects the push** if
  `.kb` was stale
- **By hand or in CI** — `pnpm kb:check` exits non-zero if anything would change

Generated output is committed on purpose: the index must be readable without
running anything, including by a reviewer on GitHub.

| You changed                               | Update                                                                                       |
| ----------------------------------------- | -------------------------------------------------------------------------------------------- |
| Code under `apps/` or `packages/`         | Nothing by hand                                                                              |
| A module's purpose, features, limitations | [`modules.json`](modules.json), then `pnpm kb`                                               |
| A business rule                           | [`07_Business_Rules.md`](07_Business_Rules.md) + [`BusinessRules/`](BusinessRules/README.md) |
| Something structural                      | A new [ADR](Architecture/decisions/README.md)                                                |
| Surprising behaviour                      | [`Architecture/PITFALLS.md`](Architecture/PITFALLS.md)                                       |
| A finished phase                          | [`STATUS.md`](STATUS.md)                                                                     |

---

## Tooling

| Path            | What                                                                     |
| --------------- | ------------------------------------------------------------------------ |
| `generate.mjs`  | The generator. Uses the TypeScript compiler API — no new dependency      |
| `find.mjs`      | The lookup CLI behind `pnpm kb:find`                                     |
| `modules.json`  | Hand-edited module narrative, merged with live source data at generation |
| `manifest.json` | Content hashes; drives `kb:check` and the stale-file sweep               |
