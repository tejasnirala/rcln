-- ---------------------------------------------------------------------------
-- Make a cross-branch movement UNREPRESENTABLE rather than merely refused.
--
-- From the PI-2 code review. Every inventory child referenced its parent through
-- `(organization_id, <parent>_id)`, which proves the lot, serial or shelf belongs
-- to this TENANT and says nothing about which BRANCH holds it. So
-- `stock_ledger.branch_id` and `from_location_id` were constrained
-- independently, and a movement recorded at branch A citing a shelf at branch B
-- was a legal INSERT.
--
-- ⚠️ IT WAS NEVER REACHABLE, AND THAT IS EXACTLY WHY IT IS WORTH CLOSING NOW.
--   `recordMovementIn` checks the branch of the location, the batch and the
--   serial and refuses a mismatch with a sentence. A rule enforced in one code
--   path is a rule until somebody writes a second code path — and PI-3's
--   transfers, PI-4's goods receipts, PI-7's dispensing and PI-9's consumption
--   are all second code paths, three of them writing movements that span two
--   branches on purpose. ADR-0004 argues the three-column form everywhere else
--   in this schema; this is that argument applied where it matters most.
--
-- It also makes `verifyBalances()` airtight. The replay groups by
-- (product, batch, serial, location, status) WITHOUT `branch_id`, which is only
-- correct if a location implies exactly one branch. Until now that was true of
-- the data and not of the schema.
--
-- ⚠️ `storage_bins` GAINS `(organization_id, id)` PURELY SO A LATER PHASE CAN
--   POINT AT A BIN. Every other table here that anything might reference already
--   had one; bins did not, only because nothing references them today.
--   Bin-level movements are exactly what PI-3 might add, and adding the target
--   afterwards is a migration under live stock.
--
-- No data moves. Every new unique index contains `id`, which is the primary key,
-- so none of them can find a duplicate — the warning Prisma raises about them is
-- generic and does not apply.
-- ---------------------------------------------------------------------------

-- DropForeignKey
ALTER TABLE "serials" DROP CONSTRAINT "serials_organization_id_batch_id_fkey";
-- DropForeignKey
ALTER TABLE "serials" DROP CONSTRAINT "serials_organization_id_current_location_id_fkey";
-- DropForeignKey
ALTER TABLE "stock_balances" DROP CONSTRAINT "stock_balances_organization_id_batch_id_fkey";
-- DropForeignKey
ALTER TABLE "stock_balances" DROP CONSTRAINT "stock_balances_organization_id_location_id_fkey";
-- DropForeignKey
ALTER TABLE "stock_balances" DROP CONSTRAINT "stock_balances_organization_id_serial_id_fkey";
-- DropForeignKey
ALTER TABLE "stock_ledger" DROP CONSTRAINT "stock_ledger_organization_id_batch_id_fkey";
-- DropForeignKey
ALTER TABLE "stock_ledger" DROP CONSTRAINT "stock_ledger_organization_id_from_location_id_fkey";
-- DropForeignKey
ALTER TABLE "stock_ledger" DROP CONSTRAINT "stock_ledger_organization_id_serial_id_fkey";
-- DropForeignKey
ALTER TABLE "stock_ledger" DROP CONSTRAINT "stock_ledger_organization_id_to_location_id_fkey";
-- DropForeignKey
ALTER TABLE "storage_areas" DROP CONSTRAINT "storage_areas_organization_id_location_id_fkey";
-- CreateIndex
CREATE UNIQUE INDEX "batches_organization_id_branch_id_id_key" ON "batches"("organization_id", "branch_id", "id");
-- CreateIndex
CREATE UNIQUE INDEX "inventory_locations_organization_id_branch_id_id_key" ON "inventory_locations"("organization_id", "branch_id", "id");
-- CreateIndex
CREATE UNIQUE INDEX "serials_organization_id_branch_id_id_key" ON "serials"("organization_id", "branch_id", "id");
-- CreateIndex
CREATE UNIQUE INDEX "storage_bins_organization_id_id_key" ON "storage_bins"("organization_id", "id");
-- AddForeignKey
ALTER TABLE "storage_areas" ADD CONSTRAINT "storage_areas_organization_id_branch_id_location_id_fkey" FOREIGN KEY ("organization_id", "branch_id", "location_id") REFERENCES "inventory_locations"("organization_id", "branch_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;
-- AddForeignKey
ALTER TABLE "serials" ADD CONSTRAINT "serials_organization_id_branch_id_batch_id_fkey" FOREIGN KEY ("organization_id", "branch_id", "batch_id") REFERENCES "batches"("organization_id", "branch_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
-- AddForeignKey
ALTER TABLE "serials" ADD CONSTRAINT "serials_organization_id_branch_id_current_location_id_fkey" FOREIGN KEY ("organization_id", "branch_id", "current_location_id") REFERENCES "inventory_locations"("organization_id", "branch_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
-- AddForeignKey
ALTER TABLE "stock_ledger" ADD CONSTRAINT "stock_ledger_organization_id_branch_id_batch_id_fkey" FOREIGN KEY ("organization_id", "branch_id", "batch_id") REFERENCES "batches"("organization_id", "branch_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
-- AddForeignKey
ALTER TABLE "stock_ledger" ADD CONSTRAINT "stock_ledger_organization_id_branch_id_serial_id_fkey" FOREIGN KEY ("organization_id", "branch_id", "serial_id") REFERENCES "serials"("organization_id", "branch_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
-- AddForeignKey
ALTER TABLE "stock_ledger" ADD CONSTRAINT "stock_ledger_organization_id_branch_id_from_location_id_fkey" FOREIGN KEY ("organization_id", "branch_id", "from_location_id") REFERENCES "inventory_locations"("organization_id", "branch_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
-- AddForeignKey
ALTER TABLE "stock_ledger" ADD CONSTRAINT "stock_ledger_organization_id_branch_id_to_location_id_fkey" FOREIGN KEY ("organization_id", "branch_id", "to_location_id") REFERENCES "inventory_locations"("organization_id", "branch_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
-- AddForeignKey
ALTER TABLE "stock_balances" ADD CONSTRAINT "stock_balances_organization_id_branch_id_batch_id_fkey" FOREIGN KEY ("organization_id", "branch_id", "batch_id") REFERENCES "batches"("organization_id", "branch_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
-- AddForeignKey
ALTER TABLE "stock_balances" ADD CONSTRAINT "stock_balances_organization_id_branch_id_serial_id_fkey" FOREIGN KEY ("organization_id", "branch_id", "serial_id") REFERENCES "serials"("organization_id", "branch_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
-- AddForeignKey
ALTER TABLE "stock_balances" ADD CONSTRAINT "stock_balances_organization_id_branch_id_location_id_fkey" FOREIGN KEY ("organization_id", "branch_id", "location_id") REFERENCES "inventory_locations"("organization_id", "branch_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
