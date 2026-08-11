# Changelog

One entry per session. Newest first. Record what changed and why — not what was
discussed.

---

## 2026-08-11 — PI-1 code review, and the bugs it found

**Phase:** PI-1 · **Result:** both reviews complete · **Branch:**
`feat/pi-1-product-platform-core`

`code-reviewer` found two CRITICALs and six WARNINGs. All fixed, with a third
bug found by the regression tests written for the first one.

### The one mistake that produced both CRITICALs

```ts
{ ...(cond ? { OR: a } : {}), effectiveFrom, OR: b }   // ← `OR: a` is GONE
```

An object literal takes the **last** value for a repeated key, and a **spread
counts**. Neither TypeScript nor eslint objects. In both resolvers the predicate
that vanished was the jurisdiction filter — the one deciding correctness:

- `resolveTaxCategory` matched every region in the country.
- `resolveIdentifier` matched a barcode against every country's identifiers.
  National codes legitimately collide across countries; this is a live routed
  endpoint. Wrong-product-from-a-barcode is what it exists to prevent.

Both now use `AND: [...]` to carry two `OR` groups.

### The third bug, found by the test written for the first

`orderBy: [{ regionCode: 'desc' }, …]` with `take: 1`, under a comment asserting
"Postgres sorts NULLs last on DESC by default". **It sorts them first.** So the
country-wide row always won and a regional tax override could be configured, be
visible, and never be returned — precisely what that file's own header warns
about, three lines above the code doing it. Fixed with `nulls: 'last'`.

### The rest

- **`PUT /packagings {"levels": []}` destroyed the base packaging row.** The
  guard was `if (base && …)`, so no level 0 skipped the check rather than failing
  it. Refused twice now: `.min(1)` on the contract, unconditional check in the
  service.
- **`withdrawProduct` set `deletedAt`**, making withdrawn products 404 — the
  opposite of the "history keeps resolving" it promised. Status carries it alone;
  `listProducts` excludes `WITHDRAWN` by default so pickers are unaffected.
- **Unit conversions could contradict the graph transitively.** `BOX→TAB = 90`
  was accepted alongside `BOX→STRIP = 10` and `STRIP→TAB = 10`, and because the
  search is breadth-first the new one-hop edge **won** over the correct two-hop
  path. Writes now check the proposed edge against the existing graph.
- **An inclusive `effectiveTo` expired a day early**, in four places at once —
  `@db.Date` comes back at UTC midnight and was compared against an instant. The
  three copies of `toCalendarDate` and two of `decimalToString` are now one
  `values.ts`, which is why the fix was one edit instead of four.
- **`listCategories` inner-joined the depth CTE**, so a category whose parent is
  invisible under RLS vanished from the tenant's **own** list. `LEFT JOIN` now
  surfaces it at the root — this closes the LOW security finding recorded below.
- `buildUnitGraph` threw on a zero-ratio row, contradicting its own comment that
  one bad row must not break every conversion in the clinic.
- Two write paths opened a second transaction for their read-back; both now read
  inside the transaction they already had.

### Tests

`product-resolvers.test.ts` (14 cases) and `product-values.test.ts` (11) are new.
**PI-1 had no products integration test at all**, which is how three resolver
bugs shipped: the isolation suite tests the database, the unit suite tests pure
arithmetic, and nothing tested the query layer between them. Each new case plants
a decoy and asserts which row comes back — all three bugs returned a plausible
row rather than failing, so only a decoy distinguishes them.

**1016 tests across 37 suites**, `pnpm validate` 23/23, `db:rls:check` 65 tables.

---

## 2026-08-11 — PI-1 security review pass

**Phase:** PI-1 · **Result:** security review PASS, code review NOT RUN ·
**Branch:** `feat/pi-1-product-platform-core`

`security-reviewer` confirmed the tenancy story end to end and raised five
findings — nothing CRITICAL, nothing HIGH. `code-reviewer` terminated on a
session limit and produced nothing; that leg of PI-1.10 is still open.

### Fixed

- **`20260814100000_platform_rows_immutable`.** `tenant_isolation` never
  protected a platform row from `DELETE` — Postgres evaluates no WITH CHECK
  where there is no new row, so the permissive USING clause was the whole test —
  nor from `UPDATE ... SET organization_id = '<mine>'`, which satisfies USING on
  the old row and WITH CHECK on the new one and captures the row away from every
  other tenant. A `BEFORE UPDATE OR DELETE` trigger closes both on all
  **seventeen** platform-extensible tables, so `specialties`, `qualifications`,
  `designations` and `role_designations` are fixed alongside the thirteen
  product tables. Neither hole was reachable through the API — `assertMutable`
  guards every mutating path — so this restores a missing second layer.
- **Isolation cases for `medicine_details`, `composition_ingredients` and
  `product_tax_classifications`.** The first had no test at all; the other two
  appeared only in CHECK-constraint tests, which exercise the constraint and say
  nothing about the policy.
- **The slug comment in `products/actions.ts`.** It claimed server actions are
  "bound to the slug on the server before they reach the browser". They are not:
  `.bind(null, slug)` runs inside a CLIENT component, and a server action is a
  public POST either way. The real control is the API's cross-tenant 404 and RLS
  keyed on the token's org, not the slug. Corrected to describe that, with the
  consequence spelled out — `slug` selects a Host header, never an authorization
  decision.

### Accepted, not fixed

Two LOW findings, recorded in [NEXT_SESSION.md](NEXT_SESSION.md) § Known issues:
two service reads that lean on RLS with no app-level org predicate, and the
residual `parent_visible` gap, which is marginally worse than first assessed —
a category parented under an invisible one vanishes from the tenant's own list.

### Found on the way

`invoices.test.ts` "finds a draft by date" computed today in **UTC** while the
service resolves `?from=/&to=` in the branch's zone. Against an Asia/Kolkata
fixture it failed every night between 18:30 and 24:00 UTC and passed the other
18½ hours, which is how it survived. Invariant 6 broken inside a test. Unrelated
to PI-1 and fixed here because it was red.

`@rcln/web#typecheck` is red and deliberately left alone — untracked
`jest.config.ts` and `tests/`, plus jest devDeps in `package.json` with no
lockfile entry and no install. Predates the branch; regenerating the lockfile is
not PI-1's call. Everything else is green: 989 API tests across 35 suites,
`db:rls:check` at 65 protected tables.

---

## 2026-08-11 — PI-1: Product Platform Core

**Phase:** PI-1 · **Result:** COMPLETE (pending review) · **Branch:**
`feat/pi-1-product-platform-core`

The catalogue: thirteen tables answering "what is this thing?", with nothing in
them that has a quantity, a location or a price.

### What landed

Schema, migration with the hand-written half (20 `NULLS NOT DISTINCT` indexes, 4
partial uniques, 9 CHECKs, 2 triggers, the RLS block), 10 RESTRICTIVE
`*_visible` policies, a new `product` permission module, the exact-rational
conversion engine, contracts, eight services, seven route surfaces, the
structural seed, three screens, and the tests. Detail in
[NEXT_SESSION.md](NEXT_SESSION.md).

### Decisions taken

- **OD-1, OD-2, OD-4 resolved** — see [OPEN_DECISIONS.md](OPEN_DECISIONS.md)
  § Resolved. Platform catalogue with tenant extension; org-scoped; structural
  seed only, no medicine data.
- **Dosage form, route and release type are ENUMS, not lookup tables.** Same
  posture as `ProductType`: adding a member is a migration somebody reviews. A
  table would have needed its own platform/tenant policy and its own visibility
  policy to hold one string.
- **The medicine facet is gated by `pharmacy.medicine.*` while the catalogue is
  gated by `product.definition.*`** (PI-ADR-011), and a product's TAX
  classification is gated by `billing.tax.manage`. Three jobs, three decisions.
- **One form rather than the planned create wizard.** Later steps do not depend
  on earlier answers, and a storekeeper adding forty products wants one screen.

### What went wrong, and what it cost

⚠️ **A RESTRICTIVE policy that cannot exist.** `parent_visible` on
`product_categories` self-referenced its own table. Postgres evaluates policy
expressions with RLS disabled on the tables they REFERENCE — which is what makes
the other ten safe — but a self-reference has no such escape and raises
`infinite recursion detected in policy`. Worse, it did not fail in one place:
`products.category_visible` reads `product_categories`, so the recursion
propagated to **every read of `products`, for every tenant**. Caught by
`tenant-isolation.test.ts`. Removed in `drop_category_parent_visible`.
`specialties` has the identical gap for the identical reason, and the warning was
already written above the `parent_scoped` loop in `enable-rls.sql`.

⚠️ **Two migration-process traps, both hit.** (1) Migrations replay in NAME
order and this repository's recent migrations are hand-dated ahead of the wall
clock, so a Prisma-generated timestamp sorts BEFORE its own dependencies and the
shadow replay fails. (2) An applied migration is checksummed including its
comments, so editing one to add a note demands a full database reset.

⚠️ **Pre-existing schema drift, inherited and fixed.** `invoices` had an index in
the database and in a migration that the schema never declared, so every
`prisma migrate dev` emitted a `DROP INDEX` for it into whoever generated the
next migration — and it was applied once before being caught. Fixed by declaring
it, and by renaming `fee_schedule_entries_scope_key` to Prisma's own name, which
was the other half of the same bug. **The rule: keep the generated index name,
and declare hand-written indexes in the schema.**

### Not done

`/code-review` and `security-reviewer` on the diff — the one remaining leg of
PI-1.10, and mandatory before merge. The screens have not been opened in a
browser.

---

## 2026-08-11 — PI-0: Discovery & Architecture

**Phase:** PI-0 · **Result:** COMPLETE · **Production code changed:** none

### Discovery

Audited the repository directly from source rather than from documentation.
Findings in [CURRENT_STATUS.md](CURRENT_STATUS.md). The consequential ones:

- **Nothing exists.** Zero product, inventory, pharmacy, procurement or
  regulatory tables. This is greenfield.
- **`@rcln/tax` is already global** — `(country, region)` jurisdictions,
  `GST`/`VAT`/`SALES_TAX`, `TaxSplit` for India's halves, effective-dated rules
  with tenant-beats-platform precedence, and a `TaxProviderQuote` seam for US
  sales tax. It needs no change. This removed a large slice of assumed work.
- **`InvoiceSourceType` already has `PHARMACY` and `INVENTORY`.**
- **`invoice_items.item_code` and `.tax_category` are already separate columns**,
  so the brief's "HSN must not be the universal identifier" requirement is
  satisfied upstream.
- **`pharmacy.*` and `inventory.*` permission codes already exist and are
  granted to `PHARMACIST`** — 13 codes, gating nothing, because nothing is built.
- **`specialties` / `qualifications` establish the platform-catalogue-with-
  tenant-extension RLS pattern**, which is exactly the shape the global product
  master needs — including the RESTRICTIVE `*_visible` policy on join tables.
- **`prescriptions` and `encounters`/`procedures` do not exist**, hard-blocking
  the pharmacy-dispensing and clinical-consumption phases. Recorded as KI-1/KI-2.

### Decisions

Seventeen recorded in [ARCHITECTURE.md](ARCHITECTURE.md). Load-bearing:

- **PI-ADR-001** — `products` is the root; medicine is an extension row
- **PI-ADR-002** — the regulatory engine ships **before** dispensing, deviating
  from the brief's suggested order, because dispensing's shape depends on it
- **PI-ADR-003** — the catalogue is a platform master with tenant extension
- **PI-ADR-004** — `stock_ledger` is append-only and is the only quantity truth
- **PI-ADR-005** — consumption never creates an invoice line
- **PI-ADR-006** — this programme writes no tax logic
- **PI-ADR-009** — regulatory maturity is a state, and no agent may set the two
  states that imply legal sign-off

### Planning

- 25 phases (PI-0..PI-24) in [MASTER_PLAN.md](MASTER_PLAN.md), ordered so that
  PI-1..PI-6 are unblocked and can start immediately.
- Task-level tracker for PI-0..PI-5 with a completion gate that is explicitly
  not "the code compiles".
- Eight open decisions, two of which need the user (OD-4 catalogue data source,
  OD-5 who signs off a rule pack).

### Files

Created `.kb/PharmacyInventory/` — 29 documents. Created
`docs/pharmacy-inventory/README.md` as a pointer stub, matching the convention
`docs/README.md` already establishes for every moved document.

**Modified: nothing.** No schema, no package, no app, no migration, no seed.

### Why `.kb/` and not `docs/`

`docs/README.md` states that directory is pointer stubs and says "do not add
content to them". `.kb/` is the KnowledgeBase. `.kb/generate.mjs` only removes
files listed in its own `manifest.json`, so a hand-written directory there is
safe from `pnpm kb`.

### Next

**PI-1.1 — unit of measure & packaging engine.** See
[NEXT_SESSION.md](NEXT_SESSION.md) for the exact starting steps.

---

## Template for the next entry

```markdown
## YYYY-MM-DD — PI-n.m: <what>

**Phase:** · **Result:** · **Tests:** n passing / n failing

### Changed

### Decisions

### Issues found

### Next
```
