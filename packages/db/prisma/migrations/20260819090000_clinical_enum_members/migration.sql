-- ===========================================================================
-- CE-1 · 1 of 4 — new members on EXISTING enums, and nothing else.
--
-- ⚠️ THIS MIGRATION EXISTS ONLY BECAUSE OF `ALTER TYPE … ADD VALUE`, AND
--   SPLITTING IT OUT IS NOT TIDINESS.
--
--   Postgres refuses to USE a value added to an existing enum inside the same
--   transaction that added it. A type CREATED in the transaction may be used
--   immediately — which is why the four brand-new types in migration 2 are
--   declared and used side by side there — but these three are additions to
--   types that already exist, so anything referencing them (a CHECK, a DEFAULT,
--   a data statement) has to be in a LATER migration.
--
--   PI-5 recorded the distinction after nearly tripping on it; CE-1 is the first
--   migration in the repository that actually needs the split.
--
-- Nothing here touches a row or a table. It is safe to replay and it holds no
-- locks worth naming.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- `CARE_CONTEXT` — the true root of the clinical taxonomy (CD-3).
--
-- Human and Veterinary sit ABOVE the existing DOMAIN roots. The consultation
-- engine resolves a template by walking a doctor's classification up to its care
-- context: veterinary dermatology and human dermatology want different forms,
-- different vocabulary and different anatomical maps, and are otherwise
-- indistinguishable.
--
-- ⚠️ ADDING A LEVEL ABOVE THE OLD ROOTS CHANGES NO EXISTING QUERY, and that is
--   precisely because `TaxonomyNodeType` was built as a LABEL rather than as a
--   depth. Re-parenting is a `parent_id` UPDATE on the current roots, done by
--   the seed and not by this migration — `doctor_specialties` points at leaves
--   and never notices.
-- ---------------------------------------------------------------------------
ALTER TYPE "TaxonomyNodeType" ADD VALUE 'CARE_CONTEXT';

-- ---------------------------------------------------------------------------
-- Two new PHI read-log resources.
--
-- `ENCOUNTER` is kept apart from `MEDICAL_HISTORY` for the reason `VITALS` is:
-- history is what the patient brought with them; an encounter is what THIS
-- clinician concluded. A disclosure review asking "who read Mrs Rao's
-- diagnosis" wants an answer that is not buried among chart-summary reads.
--
-- `CLINICAL_EPISODE` is not folded into `APPOINTMENT` because an episode's title
-- is usually a diagnosis by another name.
-- ---------------------------------------------------------------------------
ALTER TYPE "DataAccessResource" ADD VALUE 'ENCOUNTER';
ALTER TYPE "DataAccessResource" ADD VALUE 'CLINICAL_EPISODE';
