# Migration Plan

---

## The unusually comfortable starting position

**There is nothing to migrate.** The repository contains zero product,
inventory, pharmacy, procurement or regulatory tables. Every table in this
programme is new, so there is:

- no existing data to preserve
- no legacy shape to adapt to
- no backfill
- no dual-write period
- no deprecation

This will not be true again. Take the schema seriously now, because every
decision made in PI-1 and PI-2 becomes a migration under live PHI afterwards.

---

## Backward compatibility

Three existing things this programme touches, and how each stays safe:

| Existing                | Touched how                                                                            | Risk                                                                                                                                                                                                              |
| ----------------------- | -------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `InvoiceSourceType`     | `PHARMACY` and `INVENTORY` members **already exist**; this programme starts using them | None — no enum change                                                                                                                                                                                             |
| `NumberSequenceType`    | new members added                                                                      | Additive. Prisma enum extension; existing rows unaffected                                                                                                                                                         |
| `DataAccessResource`    | new members added                                                                      | Additive                                                                                                                                                                                                          |
| `permissions` table     | new codes seeded                                                                       | Additive. Nothing is revoked, nothing renamed                                                                                                                                                                     |
| `MODULES` in `codes.ts` | new modules appended                                                                   | Additive; the UI groups by it                                                                                                                                                                                     |
| `invoice-visibility.ts` | pharmacy/inventory sources added to the mapping                                        | Small, additive                                                                                                                                                                                                   |
| `roles.ts`              | new codes granted to appropriate roles                                                 | ⚠️ ORG_OWNER/ORG_ADMIN are "everything except" — a new **authoring** code would join them silently. None of this programme's codes are clinical authoring codes, but check invariant 7 before adding one that is. |

`pharmacy.medicine.read` / `.manage` are **retained**, not renamed (PI-ADR-011).
Nothing is revoked from any role.

---

## Migration discipline

Repository rules, restated because this programme writes a lot of migrations:

1. **Use `/db-migration` for every `schema.prisma` change.** Not optional.
2. **Never edit an applied migration.** Prisma checksums it. A correction is a
   new migration.
3. **RLS SQL is appended by hand** to the generated migration, and mirrored in
   `packages/db/prisma/rls/enable-rls.sql`. `pnpm db:rls:check` fails until it
   is there.
4. **`NULLS NOT DISTINCT` indexes are appended by hand.** Prisma cannot express
   them, and every platform-extensible table needs one — `tax_rule_defaults` and
   `number_sequences` already document the pattern.
5. **Triggers, CHECK constraints and REVOKEs are hand-written SQL** appended to
   the migration. The ledger's append-only enforcement and the tracking-mode
   CHECKs are all in this category.
6. `rcln_app` runs with RLS enforced; migrations run as `rcln_owner`, which
   bypasses it. A seed that must write platform rows runs as owner.

---

## Ordering within a phase

```
1. schema.prisma           models, enums, indexes
2. prisma migrate dev      generate
3. append by hand          RLS policies · NULLS NOT DISTINCT · CHECKs ·
                           triggers · REVOKEs
4. enable-rls.sql          mirror the policies (the file is the source of truth
                           for db:rls:check)
5. tenant-isolation.test   one case per new tenant table, plus a RESTRICTIVE
                           case per join table into a platform-extensible parent
6. db:rls:check            must pass
7. seed                    platform catalogue rows, as rcln_owner
8. contracts → permissions → service → route → screen → tests
```

Steps 3–6 are where this programme's risk concentrates. Do not compress them.

---

## Seed data

| Data                                 | When       | As                                            |
| ------------------------------------ | ---------- | --------------------------------------------- |
| Base units of measure                | PI-1       | platform rows, `rcln_owner`                   |
| Unit conversions                     | PI-1       | platform rows                                 |
| Product categories (a starting tree) | PI-1       | platform rows                                 |
| Dosage forms, routes, release types  | PI-1       | enums or platform rows                        |
| Storage requirement profiles         | PI-1       | platform rows                                 |
| Jurisdictions + authorities          | PI-5       | platform rows                                 |
| Rule packs                           | PI-6+      | platform rows, one migration per pack version |
| Permission codes                     | each phase | existing seed mechanism                       |

⚠️ **A global product catalogue is not seeded** — see
[OPEN_DECISIONS.md](OPEN_DECISIONS.md) OD-4. Shipping product data means
licensing it, and inventing it means shipping wrong medicine data, which is the
worst option available.

---

## Rollback

- Every migration in PI-1..PI-4 is **additive**: new tables, new enum members,
  new columns with defaults. Rolling back is dropping tables nothing else
  references.
- From PI-7 onwards, dispensing rows reference `prescriptions` and invoices. A
  rollback there is a data question, not a schema question, and needs the same
  care any clinical rollback needs.
- No phase in this programme drops or renames an existing column. If one appears
  to need to, that is a design error — raise it in
  [OPEN_DECISIONS.md](OPEN_DECISIONS.md) first.

---

## Performance under growth

Sized for the tables that grow without bound:

| Table                  | Growth                                           | Plan                                                                                                                                                                                                                                      |
| ---------------------- | ------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `stock_ledger`         | every movement, forever                          | Indexed for the traceability queries. **Partition by `RANGE (occurred_at)` when it grows** — Prisma cannot declare a partitioned table, so this is a hand-written migration, exactly as `audit_logs` and `data_access_logs` already note. |
| `stock_balances`       | bounded by (product × batch × location × status) | Ordinary indexes                                                                                                                                                                                                                          |
| `product_identifiers`  | bounded by catalogue size                        | Index for barcode lookup — the hottest read in the programme                                                                                                                                                                              |
| `charge_requests`      | one per consumed line                            | Archive strategy at PI-24                                                                                                                                                                                                                 |
| `regulatory_decisions` | one per evaluated transaction                    | Same                                                                                                                                                                                                                                      |

Write the partition note into the model comment when the table is created, the
way the existing append-only tables do. A future session should not have to
rediscover it.
