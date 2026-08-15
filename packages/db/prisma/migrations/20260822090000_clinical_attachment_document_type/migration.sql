-- ===========================================================================
-- CE-4 · 1 of 2 — the document type a clinical attachment is stored under.
--
-- ⚠️ ITS OWN MIGRATION, FOR THE REASON EVERY OTHER ENUM ADDITION IN THIS
--   PROGRAMME HAS HAD ONE (CD-9). `DocumentType` already exists, so this is
--   `ALTER TYPE … ADD VALUE` and NOTHING IN THE SAME TRANSACTION MAY NAME THE
--   NEW MEMBER. Migration 2 creates eight tables and fourteen CHECK
--   constraints; none of them names this value today, and splitting now means
--   none of them ever can by accident.
--
-- ⚠️ ITS OWN MEMBER RATHER THAN `UPLOAD`, AND THE REASON IS DISCLOSURE. A
--   clinical photograph is PHI about one named person; an UPLOAD is a clinic's
--   letterhead. They are retained differently, exported differently in a
--   subject-access request, and a sweep that cleans up orphaned uploads has to
--   be able to tell them apart. What the file IS clinically — photograph,
--   scan, consent — is `EncounterAttachmentKind` in migration 2, because that
--   is a question only the chart asks.
-- ===========================================================================

ALTER TYPE "DocumentType" ADD VALUE 'CLINICAL_ATTACHMENT';
