-- ---------------------------------------------------------------------------
-- PI-10 — Recall & traceability
--
-- Two new tenant tables and four new enums. Nothing else in the programme has
-- been this small and reached this far: executing one row here makes a product
-- un-dispensable and un-consumable at every branch at once.
--
-- ⚠️ WHAT THIS MIGRATION IS FOR: the DOCUMENT. PI-2 gave `batches` its
--   `recalled_at` and `recall_reference` columns and said in the same breath
--   that the WORKFLOW is PI-10. Those two columns answer "is this lot
--   recalled"; they cannot answer "what is the manufacturer's notice, which of
--   the eleven lots it names have we found, which branch still has some, and how
--   much did we actually pull". A recall is a piece of work with a beginning and
--   an end, and its state is not expressible as two nullable columns on the
--   thing being recalled.
--
-- ⚠️ IT MOVES NO QUANTITY. Every hold is a `stock_ledger` leg written by
--   `recordMovement()` and by nothing else (PI-ADR-004); `recall_batches`
--   RECORDS what moved.
--
-- ⚠️ TWO STATEMENTS WERE DELETED FROM WHAT `migrate dev --create-only`
--   GENERATED, and they must be deleted from anything it generates in future:
--   it wants to `ALTER COLUMN "item_id" DROP NOT NULL` on `encounter_procedures`
--   and `encounter_investigations`, because CE-4 tightened both by hand and the
--   Prisma model cannot say "required relation, nullable scalar". PI-7's, PI-8's
--   and PI-9's migration headers say exactly the same thing.
--
-- ⚠️ AND THREE `ALTER TYPE ... ADD VALUE` STATEMENTS WERE MOVED OUT, into
--   `..090500_recall_enum_members`. Postgres refuses to USE a new enum value in
--   the transaction that added it, and `..091000` immediately needs
--   `RECALL_RELEASE` inside a CHECK constraint. Keeping enum additions separable
--   is PI-2's and PI-4's habit and it is what stops that being discovered during
--   a deploy rather than here.
-- ---------------------------------------------------------------------------

-- CreateEnum
CREATE TYPE "RecallStatus" AS ENUM ('DRAFT', 'EXECUTED', 'CLOSED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "RecallClassification" AS ENUM ('CLASS_I', 'CLASS_II', 'CLASS_III', 'UNCLASSIFIED');

-- CreateEnum
CREATE TYPE "RecallSource" AS ENUM ('MANUFACTURER', 'REGULATOR', 'SUPPLIER', 'INTERNAL');

-- CreateEnum
CREATE TYPE "RecallBatchStatus" AS ENUM ('PENDING', 'HELD', 'RELEASED', 'DISPOSED', 'NO_STOCK');

-- CreateTable
CREATE TABLE "recalls" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "reference" VARCHAR(64) NOT NULL,
    "product_id" UUID NOT NULL,
    "title" VARCHAR(255) NOT NULL,
    "classification" "RecallClassification" NOT NULL DEFAULT 'UNCLASSIFIED',
    "source" "RecallSource" NOT NULL,
    "notice_reference" VARCHAR(128),
    "notice_on" DATE,
    "reason" TEXT NOT NULL,
    "status" "RecallStatus" NOT NULL DEFAULT 'DRAFT',
    "raised_by_id" UUID NOT NULL,
    "executed_at" TIMESTAMPTZ(6),
    "executed_by_id" UUID,
    "closed_at" TIMESTAMPTZ(6),
    "closed_by_id" UUID,
    "outcome_note" TEXT,
    "notes" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "recalls_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "recall_batches" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "recall_id" UUID NOT NULL,
    "batch_id" UUID NOT NULL,
    "lot_number" VARCHAR(128) NOT NULL,
    "status" "RecallBatchStatus" NOT NULL DEFAULT 'PENDING',
    "quantity_held_base" DECIMAL(18,6),
    "held_at" TIMESTAMPTZ(6),
    "released_at" TIMESTAMPTZ(6),
    "outcome_note" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "recall_batches_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "recalls_organization_id_status_created_at_idx" ON "recalls"("organization_id", "status", "created_at" DESC);

-- CreateIndex
CREATE INDEX "recalls_organization_id_product_id_idx" ON "recalls"("organization_id", "product_id");

-- CreateIndex
CREATE UNIQUE INDEX "recalls_organization_id_reference_key" ON "recalls"("organization_id", "reference");

-- CreateIndex
CREATE UNIQUE INDEX "recalls_organization_id_id_key" ON "recalls"("organization_id", "id");

-- CreateIndex
CREATE INDEX "recall_batches_organization_id_recall_id_idx" ON "recall_batches"("organization_id", "recall_id");

-- CreateIndex
CREATE INDEX "recall_batches_organization_id_batch_id_idx" ON "recall_batches"("organization_id", "batch_id");

-- CreateIndex
CREATE INDEX "recall_batches_organization_id_branch_id_status_idx" ON "recall_batches"("organization_id", "branch_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "recall_batches_organization_id_recall_id_batch_id_key" ON "recall_batches"("organization_id", "recall_id", "batch_id");

-- CreateIndex
CREATE UNIQUE INDEX "recall_batches_organization_id_id_key" ON "recall_batches"("organization_id", "id");

-- AddForeignKey
ALTER TABLE "recalls" ADD CONSTRAINT "recalls_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recalls" ADD CONSTRAINT "recalls_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recalls" ADD CONSTRAINT "recalls_raised_by_id_fkey" FOREIGN KEY ("raised_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recalls" ADD CONSTRAINT "recalls_executed_by_id_fkey" FOREIGN KEY ("executed_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recalls" ADD CONSTRAINT "recalls_closed_by_id_fkey" FOREIGN KEY ("closed_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recall_batches" ADD CONSTRAINT "recall_batches_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recall_batches" ADD CONSTRAINT "recall_batches_organization_id_branch_id_fkey" FOREIGN KEY ("organization_id", "branch_id") REFERENCES "branches"("organization_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recall_batches" ADD CONSTRAINT "recall_batches_organization_id_recall_id_fkey" FOREIGN KEY ("organization_id", "recall_id") REFERENCES "recalls"("organization_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recall_batches" ADD CONSTRAINT "recall_batches_organization_id_branch_id_batch_id_fkey" FOREIGN KEY ("organization_id", "branch_id", "batch_id") REFERENCES "batches"("organization_id", "branch_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ===========================================================================
-- Everything below is HAND-WRITTEN. Prisma Migrate expresses none of it, and
-- every one of them is load-bearing.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- CHECK constraints. Added with the tables, while they are empty — a CHECK
-- added later needs a validation pass over live rows.
-- ---------------------------------------------------------------------------

-- ⚠️ NOT MERELY `NOT NULL`. `reason` is the column a regulator reads and the one
--   that ends up on every movement's `reason_note`; a single space satisfies NOT
--   NULL and satisfies nobody else.
ALTER TABLE "recalls"
  ADD CONSTRAINT "recalls_reason_stated" CHECK (btrim("reason") <> '');

-- ---------------------------------------------------------------------------
-- Execution is attributed, and so is closing. Same shape as
-- `clinical_consumptions_amendment_is_attributed`.
--
-- ⚠️ "WHO AUTHORISED THE HOLD" IS THE QUESTION ASKED AFTER AN ADVERSE EVENT, and
--   a timestamp with no name against it is indistinguishable from the system
--   having done it by itself.
-- ---------------------------------------------------------------------------
ALTER TABLE "recalls"
  ADD CONSTRAINT "recalls_execution_is_attributed" CHECK (
    ("executed_by_id" IS NULL AND "executed_at" IS NULL)
    OR ("executed_by_id" IS NOT NULL AND "executed_at" IS NOT NULL)
  );

ALTER TABLE "recalls"
  ADD CONSTRAINT "recalls_closure_is_attributed" CHECK (
    ("closed_by_id" IS NULL AND "closed_at" IS NULL)
    OR ("closed_by_id" IS NOT NULL AND "closed_at" IS NOT NULL)
  );

-- ---------------------------------------------------------------------------
-- An ENDED recall says how it ended.
--
-- ⚠️ THE ONE FIELD A CLINIC WILL WANT TO SKIP, AND THE ONE A REGULATOR ASKS FOR.
--   "We closed it" is not an outcome; "the manufacturer confirmed the lot was
--   not affected" and "seventeen patients were contacted, three could not be
--   reached" are.
-- ---------------------------------------------------------------------------
ALTER TABLE "recalls"
  ADD CONSTRAINT "recalls_ending_is_explained" CHECK (
    "status" NOT IN ('CLOSED', 'CANCELLED')
    OR ("outcome_note" IS NOT NULL AND btrim("outcome_note") <> '')
  );

-- ---------------------------------------------------------------------------
-- A held lot knows how much was held and when; a resolved lot says why.
--
-- ⚠️ `quantity_held_base >= 0` AND NOT `> 0`. ZERO IS THE CASE THE WHOLE PHASE
--   EXISTS FOR: a lot fully dispensed before the notice arrived has nothing left
--   to pull, and the patient-contact work is then ALL of the work. Requiring a
--   positive quantity would make the most urgent recall unrecordable — the exact
--   mistake `setBatchHold` avoided in PI-2 by not refusing an empty lot.
--
--   `NO_STOCK` carries the zero rather than a NULL, so "we looked and there was
--   none" stays distinguishable from "we have not looked yet".
-- ---------------------------------------------------------------------------
ALTER TABLE "recall_batches"
  ADD CONSTRAINT "recall_batches_hold_is_dated" CHECK (
    ("status" = 'PENDING' AND "held_at" IS NULL AND "quantity_held_base" IS NULL)
    OR ("status" <> 'PENDING'
        AND "held_at" IS NOT NULL
        AND "quantity_held_base" IS NOT NULL
        AND "quantity_held_base" >= 0)
  );

ALTER TABLE "recall_batches"
  ADD CONSTRAINT "recall_batches_resolution_is_explained" CHECK (
    "status" NOT IN ('RELEASED', 'DISPOSED')
    OR ("outcome_note" IS NOT NULL AND btrim("outcome_note") <> '')
  );

ALTER TABLE "recall_batches"
  ADD CONSTRAINT "recall_batches_release_is_dated" CHECK (
    ("status" = 'RELEASED') = ("released_at" IS NOT NULL)
  );

-- ===========================================================================
-- RLS. ⚠️ APPENDED HERE AND RESTATED IN `prisma/rls/enable-rls.sql`, and the two
--   must not drift — `db:rls:check` reads the database, so a policy that exists
--   only in one file is a policy that disappears on the next `db:reset`.
--
-- The wording is kept identical to `enable-rls.sql` so the two can be diffed by
-- eye.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- The org predicate, on both.
--
-- ⚠️ `recalls` IS ORG-SCOPED ONLY AND IS NOT IN THE BRANCH LOOP BELOW. It has no
--   `branch_id` column: a manufacturer's notice arrives once for the whole
--   clinic group and does not become a different notice at each site — the call
--   `charge_policy_rules` and `consumption_templates` both make. The branch
--   predicate would name a column that does not exist and raise at migration
--   time.
--
--   THE COST, STATED: a branch-scoped member reads every recall the organization
--   has raised. Intended — the header carries a product, a lot count and a
--   reason, no patient and no quantity — and it is why nothing branch-
--   confidential may be added to that table.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  t text;
  recall_tables text[] := ARRAY['recalls', 'recall_batches'];
BEGIN
  FOREACH t IN ARRAY recall_tables LOOP
    EXECUTE format('ALTER TABLE %I ENABLE   ROW LEVEL SECURITY', t);
    -- ENABLE, not FORCE: the owner must keep bypassing so migrations and seeds
    -- work (ADR-0003).
    EXECUTE format('ALTER TABLE %I NO FORCE ROW LEVEL SECURITY', t);

    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t);
    EXECUTE format($f$
      CREATE POLICY tenant_isolation ON %I
        USING       (organization_id = app_current_org())
        WITH CHECK  (organization_id = app_current_org())
    $f$, t);
  END LOOP;
END
$$;

-- ---------------------------------------------------------------------------
-- The branch predicate, on the one that names a lot.
--
-- ⚠️ THIS IS NOT DECORATION AND IT CHANGES WHAT THE FEATURE DOES. A lot is held
--   at ONE site, so a branch-scoped storekeeper executing a recall pulls the
--   lots at THEIR OWN site and no others — the rest are invisible to the
--   statement that reads them. That is the correct answer: they cannot reach
--   another site's shelf physically either. `recall.service.ts` says so in its
--   header, because the alternative reading — "the recall silently did half its
--   job" — is the one somebody will reach for.
--
-- ⚠️ AND THE CHILD CARRIES ITS OWN `branch_id` RATHER THAN INHERITING ONE
--   THROUGH THE PARENT. An org-only inherited policy under a branch-scoped
--   reference re-opens the branch boundary: permissive policies OR together and
--   a policy expression does not pick up another table's policy to close it.
-- ---------------------------------------------------------------------------
DROP POLICY IF EXISTS branch_isolation ON recall_batches;
CREATE POLICY branch_isolation ON recall_batches AS RESTRICTIVE
  USING      (branch_id IS NULL OR branch_id = ANY (app_branch_scope()))
  WITH CHECK (branch_id IS NULL OR branch_id = ANY (app_branch_scope()));

-- ---------------------------------------------------------------------------
-- The RESTRICTIVE `*_visible` policy — KI-3, the risk `db:rls:check`
-- structurally cannot see.
--
-- ONE plain FK in this migration: `recalls.product_id`.
--
-- ⚠️ `recall_batches.batch_id` NEEDS NO POLICY OF ITS OWN, and the difference is
--   worth stating rather than leaving to inference. `batches` is a strictly
--   tenant table — nothing in `inventory.prisma` allows a NULL `organization_id`
--   — so the reference is a COMPOSITE `(organization_id, branch_id, batch_id)`
--   FK and the database tenant-checks it. `products` is platform-extensible, a
--   NOT NULL `organization_id` cannot compose with a platform row's NULL, and
--   the policy below is therefore the ENTIRE control on that side.
--
-- ⚠️ THIS EXACT CLASS HAS PRODUCED A CRITICAL IN FOUR SEPARATE PHASES.
-- ---------------------------------------------------------------------------
DROP POLICY IF EXISTS product_visible ON recalls;
CREATE POLICY product_visible ON recalls AS RESTRICTIVE
  USING (EXISTS (
    SELECT 1 FROM products p
    WHERE p.id = recalls.product_id
      AND (p.organization_id IS NULL OR p.organization_id = app_current_org())
  ))
  WITH CHECK (EXISTS (
    SELECT 1 FROM products p
    WHERE p.id = recalls.product_id
      AND (p.organization_id IS NULL OR p.organization_id = app_current_org())
  ));

-- ---------------------------------------------------------------------------
-- Grants. The application connects as rcln_app, which owns nothing.
--
-- ⚠️ NOTHING IS REVOKED HERE, AND THAT IS DELIBERATE RATHER THAN AN OMISSION.
--   Neither table is append-only: a recall's status advances and a lot's outcome
--   is recorded, and both are ordinary updates. The append-only trail belongs to
--   `stock_ledger` and `audit_logs`, which hold the movements this table only
--   describes — so `rcln_app` keeps UPDATE here and holds none there.
-- ---------------------------------------------------------------------------
GRANT SELECT, INSERT, UPDATE, DELETE ON
  "recalls",
  "recall_batches"
TO rcln_app;
