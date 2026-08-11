-- Which template drew an invoice document, and which revision of it.
--
-- ⚠️ NOT NULL WITH NO DEFAULT, ON PURPOSE, AND IT IS SAFE ONLY BECAUSE THE TABLE
--   IS EMPTY. `invoice_documents` was created by 20260810150000_patient_invoices
--   and has never had a writer: Phase 5 finalises invoices and Phase 6 is the
--   first code that renders one. So there is no row to backfill.
--
--   A DEFAULT would be the reflexive way to make this statement safe, and it
--   would be a lie in the one place that matters. This column exists to answer
--   "what did the document this patient is holding look like?", and defaulting
--   it stamps `('invoice', 1)` onto any row that predates templates entirely —
--   an answer that is confident, wrong, and indistinguishable from a real one.
--   If this statement ever fails because rows exist, that is the correct
--   outcome: somebody has to decide what those rows should say.
--
-- No new table, so no RLS policy and no change to `db:rls:check`'s count. The
-- `tenant_isolation` and `branch_isolation` policies on this table already cover
-- every column it will ever have.
ALTER TABLE "invoice_documents"
  ADD COLUMN "template_key" VARCHAR(64) NOT NULL,
  ADD COLUMN "template_version" SMALLINT NOT NULL;

-- A version is a count of revisions. Zero means nothing and a negative one is a
-- data-entry accident; the type system carries neither claim, and this document
-- has to stay explicable for as long as the retention obligation runs.
ALTER TABLE "invoice_documents"
  ADD CONSTRAINT "invoice_documents_template_version_positive"
  CHECK ("template_version" > 0);
