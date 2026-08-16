-- ---------------------------------------------------------------------------
-- CE-8 · THE RECALL LIST'S SCAN, NARROWED TO THE ROWS IT CAN ACTUALLY RETURN.
--
-- `listRecall` asks three questions — DUE, OVERDUE, UPCOMING — and every one of
-- them computes the due date from two different shapes:
--
--   COALESCE(recommended_date,
--            (created_at AT TIME ZONE 'UTC')::date + interval_value * <unit>)
--
-- ⚠️ THAT EXPRESSION CANNOT BE INDEXED, AND NOT FOR WANT OF TRYING.
--   `timezone(text, timestamptz)` is STABLE rather than IMMUTABLE — the zone
--   database can change underneath it — and Postgres refuses a STABLE
--   expression in an index. Storing a computed `due_on` column instead would put
--   a second answer to "when is this due" beside the first, and the recall list
--   exists precisely because those two answers must never disagree.
--
-- So the expression stays where it is and the SET IT RUNS OVER is what shrinks.
-- Every outstanding window carries the same four predicates, and they are the
-- ones that stay selective for ever: a clinic's recommendations accumulate
-- without limit and its OUTSTANDING recommendations do not — a follow-up is
-- either booked, cancelled or a phone call somebody is about to make. Without
-- this the desk's list re-reads every recommendation the clinic has ever made,
-- and gets slower every month it is used.
--
-- ⚠️ FULFILLED AND CANCELLED GET NO INDEX, DELIBERATELY. They are the two
--   windows nobody works from — an audit read, not a queue — and an index that
--   grows exactly as fast as the table is a write cost paid for a page opened
--   monthly.
--
-- ⚠️ `organization_id` LEADS BECAUSE RLS DOES. Every read of this table runs
--   with `app.current_org` set, so the tenant predicate is present on every plan
--   whether or not the query text mentions it.
--
-- Prisma cannot express a partial index, which is why this is here and not in
-- the model — the same reason `encounters_one_live_per_appointment` is.
-- ---------------------------------------------------------------------------
CREATE INDEX "encounter_follow_up_recommendations_outstanding"
  ON "encounter_follow_up_recommendations" ("organization_id", "branch_id", "created_at")
  WHERE "deleted_at" IS NULL
    AND "fulfilled_by_appointment_id" IS NULL
    AND "cancelled_at" IS NULL
    AND "is_required" = true;
