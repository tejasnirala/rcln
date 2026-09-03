-- ---------------------------------------------------------------------------
-- `EXPIRED` on `OnlineOrderStatus` (PI-24).
--
-- ⚠️ ALONE IN ITS OWN MIGRATION, AND THAT IS NOT TIDINESS. Postgres refuses to
--   USE a new enum value in the same transaction that added it, and the next
--   migration rewrites `online_orders_status_is_consistent` to NAME 'EXPIRED'.
--   PI-12 split its three additions out for exactly this reason; the header of
--   `..._pi_12_online_pharmacy/migration.sql` records it.
-- ---------------------------------------------------------------------------
ALTER TYPE "OnlineOrderStatus" ADD VALUE 'EXPIRED';
