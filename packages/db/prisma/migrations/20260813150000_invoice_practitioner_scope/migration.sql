-- Whose invoice this is, as a link the query layer can filter on.
--
-- `practitioner_name` and `practitioner_registration_number` are the DOCUMENT —
-- snapshotted, never restated. This is the LIVE LINK, exactly the split already
-- drawn between `patient_id` and `customer_name`.
--
-- ⚠️ IT IS A VISIBILITY BOUNDARY, WHICH IS WHY IT IS A COLUMN AND NOT A JOIN.
--   A doctor holds `billing.invoice.read` and not `.read_all`, and must see the
--   invoices for the care THEY gave rather than every consultation in the
--   clinic. Reading it off `appointments.doctor_profile_id` through a join would
--   answer that today and stop answering it the moment a lab or pharmacy invoice
--   has an ordering clinician and no appointment.
--
-- Composite FK, per ADR-0004: the tenant travels in the key, so an invoice can
-- never be attributed to another clinic's clinician.

-- AlterTable
ALTER TABLE "invoices" ADD COLUMN     "practitioner_profile_id" UUID;

-- AddForeignKey
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_organization_id_practitioner_profile_id_fkey" FOREIGN KEY ("organization_id", "practitioner_profile_id") REFERENCES "doctor_profiles"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- ===========================================================================
-- HAND-WRITTEN
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- The filter this column exists for.
--
-- Every list a doctor opens is `organization_id = … AND practitioner_profile_id
-- = …`, and it is also the shape of "what did Dr Rao bill this month". Ordered
-- organization-first like every other index here, because RLS narrows on that
-- column before anything else does.
-- ---------------------------------------------------------------------------
CREATE INDEX "invoices_organization_id_practitioner_profile_id_idx"
  ON "invoices" ("organization_id", "practitioner_profile_id");

-- ---------------------------------------------------------------------------
-- Backfill from the appointment each invoice already cites.
--
-- ⚠️ THIS ONE BACKFILLS WHERE `practitioner_name` DELIBERATELY DID NOT, AND THE
--   DIFFERENCE IS WHAT THE TWO COLUMNS ARE FOR. Writing a name onto an invoice
--   issued before the column existed would restate a document that has already
--   gone to a patient. This is not on the document — it decides which rows a
--   clinician's list returns, and leaving it null would hide every invoice
--   raised before today from the very doctor who earned it.
--
-- Only APPOINTMENT invoices have an attending clinician to recover. A counter
-- sale has none and correctly stays null.
-- ---------------------------------------------------------------------------
UPDATE "invoices" i
   SET "practitioner_profile_id" = a."doctor_profile_id"
  FROM "appointments" a
 WHERE a."id" = i."appointment_id"
   AND a."organization_id" = i."organization_id"
   AND i."practitioner_profile_id" IS NULL;
