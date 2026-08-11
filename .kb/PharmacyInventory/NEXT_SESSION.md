# Next Session

**Read this first.** Updated at the end of every session.

**Written:** 2026-08-11 · **By:** session PI-1 (Product Platform Core)

---

## What we are building

A global, extensible **Product + Inventory + Pharmacy + Clinical Consumption +
Procurement + Regulatory platform** for rcln. Not a pharmacy module — shared
infrastructure that clinical, pharmacy, dental, lab, procedural and veterinary
workflows all sit on. Ten target countries via jurisdiction rule packs.

Full orientation: [README.md](README.md).

---

## What has already been completed

**PI-0 — Discovery & Architecture.** Repository audit, seventeen decisions, the
25-phase plan.

**PI-1 — Product Platform Core.** ✅ Complete, on branch
`feat/pi-1-product-platform-core`. Thirteen tables, the HTTP surface, the
screens, and the tests.

---

## What was changed in this session

**Branch:** `feat/pi-1-product-platform-core`, off `main`. Not pushed.

| Area        | What landed                                                                                                                                                                        |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Schema      | `packages/db/prisma/schema/products.prisma` — 13 models, 9 enums                                                                                                                   |
| Migration   | `20260811143036_product_platform_core` — Prisma DDL plus 20 hand-written `NULLS NOT DISTINCT` indexes, 4 partial uniques, 9 CHECKs, 2 triggers, and the RLS block                  |
| RLS         | 13 tables in `platform_extensible`; **10 RESTRICTIVE `*_visible` policies**                                                                                                        |
| Permissions | New `product` module: `product.definition.read` / `.manage`, `product.identifier.manage`. Granted to PHARMACIST, BRANCH_ADMIN, LAB_MANAGER; read-only to DOCTOR, NURSE, ACCOUNTANT |
| Engine      | `apps/api/src/services/product/units.ts` — exact rational conversion over `bigint`, pure, no Prisma                                                                                |
| Contracts   | `packages/contracts/src/products.ts`                                                                                                                                               |
| Services    | `services/product/` — unit, category, catalogue, product, packaging, identifier, tax-classification, medicine                                                                      |
| Routes      | `/v1/products` + `/v1/{units,product-categories,manufacturers,active-ingredients,compositions,storage-profiles}`                                                                   |
| Seed        | `seed/product-masters.ts` — 35 units, 10 conversions, 32 categories, 9 storage profiles. **Zero products** (OD-4)                                                                  |
| Web         | `/products` list, `/products/new`, `/products/[id]` with six tabs; "Catalogue" nav entry                                                                                           |
| Tests       | `tests/unit/product-units.test.ts` (conversion algebra); ~40 new cases in `tenant-isolation.test.ts`                                                                               |

**Three fixes outside PI-1's scope, all forced by bugs this work surfaced:**

1. `invoices` now DECLARES `@@index([organizationId, practitionerProfileId])`.
   The index existed in the database and in a migration but not in the schema, so
   every `prisma migrate dev` silently emitted a `DROP INDEX` for it into whoever
   generated the next migration. It got as far as being applied once.
2. `20260814090000_align_fee_schedule_index_name` — the hand-named
   `fee_schedule_entries_scope_key` differed from what the schema implies, which
   is the other half of the same drift. Renamed to Prisma's name; the definition,
   including `NULLS NOT DISTINCT`, is unchanged.
3. `20260814093000_drop_category_parent_visible` — see "Known issues" below.

**Three more from the security review, after the table above was written:**

4. `20260814100000_platform_rows_immutable` — `tenant_isolation` protected
   platform rows from INSERT and from content edits, but not from `DELETE` (no
   WITH CHECK is evaluated when there is no new row) nor from
   `UPDATE ... SET organization_id = '<mine>'`, which passes USING on the old
   row and WITH CHECK on the new one and captures the row away from every other
   tenant. A `BEFORE UPDATE OR DELETE` trigger closes both on all **seventeen**
   platform-extensible tables, so the four clinical masters are fixed too.
   ⚠️ A RESTRICTIVE policy would have been four lines and the wrong answer — an
   excluded row is not refused, it is unseen, so Save on a platform product
   would report success. The trigger raises. Read the migration header.
5. `medicine_details`, `composition_ingredients` and `product_tax_classifications`
   now have cross-tenant isolation cases. They had none — the latter two
   appeared only in CHECK-constraint tests, which exercise the constraint and
   not the policy.
6. `invoices.test.ts` "finds a draft by date" computed today's date in **UTC**
   while the service resolves `?from=/&to=` in the branch's zone. With an
   Asia/Kolkata fixture it failed every night between 18:30 and 24:00 UTC and
   passed the other 18½ hours. Invariant 6, in a test. Unrelated to PI-1.

---

## Current phase / current task / next task

|                   |                                                     |
| ----------------- | --------------------------------------------------- |
| **Current phase** | PI-1 — complete; both reviews done and acted on     |
| **Current task**  | Click the screens in a browser — the last open item |
| **Next phase**    | PI-2 — Inventory Foundation                         |
| **Next task**     | **PI-2.1 — `inventory_locations`**                  |

### Before starting PI-2

1. **`security-reviewer` has run. `code-reviewer` has NOT** — it died on a
   session limit partway through and produced nothing. That is the one leg of
   PI-1.10 still open. The security pass confirmed the asymmetric policy, the
   thirteen-table list in both files, the ten `*_visible` policies, that the two
   files have not drifted, that all raw SQL is parameterised, that nothing
   queries outside `withTenant`, and that no PHI is logged. It raised five
   findings; three are fixed (below) and two are accepted and recorded.
2. Read `services/product/units.ts` before writing any ledger code. Every
   quantity PI-2 stores goes through `convertToBase`, and **every ledger write
   must call `assertExactConversion`** — the rounding flag exists for that call
   site and for no other.
3. `products.base_unit_id` is the denomination the ledger is written in and is
   deliberately unchangeable. PI-2 is what makes that refusal load-bearing.

---

## Files that must be inspected before continuing

| File                                                  | Why                                                                                                                 |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `packages/db/prisma/rls/enable-rls.sql`               | The `platform_extensible` array and the `*_visible` loop. **Inventory is NOT platform-extensible** — see PI-ADR-003 |
| `packages/db/prisma/schema/products.prisma`           | The composite-FK-to-a-nullable-parent pattern, and why the relation fields are optional                             |
| `apps/api/src/services/product/units.ts`              | The conversion algebra. Do not write a second one                                                                   |
| `apps/api/src/services/product/packaging.service.ts`  | `quantityInBaseUnits` — the crossing every movement makes                                                           |
| `apps/api/src/services/numbering/`                    | `issueNumber()` for PO/GRN numbers in PI-4                                                                          |
| `apps/api/tests/integration/tenant-isolation.test.ts` | The product block at the end is the template for PI-2's cases                                                       |

---

## Known issues

**1. `product_categories` has no `parent_visible` policy, and cannot have one.**
A tenant may parent its own category under another tenant's private category.
Nothing leaks — the ancestor walk runs under RLS and drops the invisible row —
but it confirms a guessed uuid exists. A policy was written and had to be
removed: `parent_id` is a self-reference, and a policy on a table may not read
that same table. It raised `infinite recursion detected in policy`, and because
`products.category_visible` reads `product_categories` the recursion propagated
to **every read of `products` for every tenant**. Caught by the isolation suite.
`specialties` has the identical gap for the identical reason. See
`20260814093000_drop_category_parent_visible`.

**2. ~~`code-reviewer` has not run~~ — DONE.** Two CRITICALs, six WARNINGs, and a
third bug the regression tests found that the review missed. All fixed; see
[CHANGELOG.md](CHANGELOG.md). ⚠️ **The lesson worth carrying into PI-2:** all
three of the worst bugs were in the QUERY layer, and PI-1 shipped with no
integration test for it — the isolation suite tests the database and the unit
suite tests pure arithmetic, and nothing sat between them. Write
`product-resolvers.test.ts`-shaped tests for PI-2's reads as you build them, and
plant a decoy in every one: all three bugs returned a plausible row rather than
failing, so an assertion that "a row came back" would have passed on every one.

**3. The web screens have not been exercised in a browser.** They typecheck and
lint; nobody has clicked them.

**4. ~~`@rcln/web#typecheck` is RED~~ — RESOLVED, and not by PI-1.** It was red
because `apps/web/jest.config.ts` and `apps/web/tests/` needed a jest toolchain
that `apps/web/package.json` declared but `pnpm-lock.yaml` never carried, so it
was never installed. Those files and the three devDependencies have been removed
and `package.json` is back to matching `main`. `apps/web` has no test suite
again, which is the state `12_Testing_Strategy.md` and `15_Known_Issues` H6
already describe. `pnpm validate` is green end to end.

**5. One accepted security finding, LOW.** Two service reads carry no app-level
org predicate and lean on RLS alone. The second LOW — a tenant category parented
under an invisible one disappearing from the tenant's own list — **is now
fixed**: `listCategories` left-joins the depth CTE, so such a category surfaces
at the root instead of vanishing. The id-existence oracle remains and is still
the accepted part.

<details><summary>Original wording of the second finding, for context</summary>

`product.service.ts:343` and `identifier.service.ts:214` carry no app-level org
predicate and lean on RLS alone. And the residual `parent_visible` gap is
slightly worse than issue 1 above states: a tenant category parented under an
invisible category is dropped by the ancestor walk and so disappears from the
tenant's OWN list — silent omission from the UI, not merely an id-existence
oracle. Closing it needs the SECURITY DEFINER helper that migration
`20260814093000` argues against, for both taxonomy trees at once.

The last sentence turned out to be wrong, which is why this is kept. The SILENT
OMISSION half needed no policy at all — it was an inner join in
`listCategories`, fixed in SQL. Only the id-existence oracle needs the
SECURITY DEFINER helper, and that part is still accepted.

</details>

---

## Important architectural decisions

Unchanged from PI-0 — read [ARCHITECTURE.md](ARCHITECTURE.md). What PI-1 proved
in practice:

1. **PI-ADR-003 is the whole security story of this phase.** Read-permissive,
   write-strict, plus a RESTRICTIVE policy on every plain FK into a
   possibly-platform row.
2. **The composite FK does the design work.** `(organization_id, product_id)`
   into a nullable-org parent means a tenant physically cannot attach a child to
   a platform product — so "clone, don't edit" is enforced rather than merely
   documented.
3. **PI-ADR-010, in code.** Conversions are integer ratios over `bigint`.
   `convert()` returns `{ quantity, exact }`, and `exact` is the thing PI-2 must
   not ignore.
4. **PI-ADR-006 held.** This phase resolves a `tax_category` string and computes
   no rate anywhere.

---

## Tests

|                        |                                                                                                                    |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------ |
| **Currently passing**  | 983 API tests across 35 suites; `db:rls:check` green at **65** protected tables. `pnpm validate` green end to end. |
| **Currently failing**  | None.                                                                                                              |
| **Migrations pending** | None. Four applied this session; `prisma migrate dev` reports the schema in sync with an empty diff.               |

⚠️ **Two process traps, both hit this session.** Migrations replay in NAME
order, and this repository's recent migrations are hand-dated ahead of the wall
clock — so anything Prisma generates must be re-dated past the highest existing
directory or the shadow replay fails. And an applied migration is checksummed
**including its comments**: corrections go in a new migration, never as an edit.

---

## Unresolved questions

**Resolved in this session:** OD-1 (both — platform catalogue with tenant
extension), OD-2 (org-scoped), OD-4 (structural seed only, no medicine data).
Moved to [OPEN_DECISIONS.md](OPEN_DECISIONS.md) § Resolved.

**Still open:** OD-3 (localisation — nothing was put in JSONB, so nothing is
foreclosed), OD-5 (who may set `REGULATORY_REVIEWED` — **needs the user**, blocks
PI-6), OD-6, OD-7, OD-8.

---

## Do not

- Do not restart PI-0 or PI-1.
- Do not add a `parent_visible` policy to `product_categories` or `specialties`
  without reading known issue 1 first. It does not work.
- Do not make inventory platform-extensible. `batches`, `serials`, `stock_ledger`
  and `stock_balances` are strictly tenant rows with `NOT NULL organization_id`.
- Do not write a second conversion engine, and do not round a ledger quantity
  without `assertExactConversion`.
- Do not populate `products`, `active_ingredients` or `compositions` from a
  model's own knowledge. See the header of `seed/data/product-masters.ts`.
- Do not build tax logic. See PI-ADR-006.
