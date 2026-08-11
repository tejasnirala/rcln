-- Who provided the care, on the document that bills it.
--
-- A consultation invoice that does not name the clinician is a receipt for an
-- unattributed service: the patient cannot claim it, an insurer will not accept
-- it, and the clinic cannot answer "who saw them?" from the document alone.
--
-- ⚠️ TWO SNAPSHOT COLUMNS, NOT A JOIN THROUGH `appointment_id`, for exactly the
--   reason the customer block is snapshotted. A doctor leaves the clinic,
--   changes their name, or renews under a new council number — and every invoice
--   they were named on must go on saying what it said the day it was issued.
--   `appointment_id` remains the link for querying; these are the document.
--
-- Nullable, and null on every source that is not a consultation. Backfilling
-- from `appointments` is deliberately NOT done: an invoice issued before this
-- column existed printed no practitioner, and writing one in now would restate
-- a document that has already gone to a patient.

-- AlterTable
ALTER TABLE "invoices" ADD COLUMN     "practitioner_name" VARCHAR(255),
ADD COLUMN     "practitioner_registration_number" VARCHAR(64);
