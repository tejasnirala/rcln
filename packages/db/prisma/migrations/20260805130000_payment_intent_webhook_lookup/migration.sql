-- ===========================================================================
-- Let a verified webhook find the one intent it is about, and nothing else.
--
-- THE CIRCULARITY
--   A provider POSTs to a public endpoint: no host, no session, no user. Which
--   organization the delivery concerns is written on the `payment_intents` row,
--   which is RLS-enforced — so a read with no tenant context returns nothing,
--   and setting a tenant context requires already knowing the answer. Identical
--   in shape to the `own_membership` bootstrap on `memberships`, and solved the
--   same way: narrow the policy on BOTH axes instead of exempting the table.
--
--     id = app_payment_reference()   the single row whose uuid you already have
--     app_current_org() IS NULL      and only with no tenant claimed
--
--   PERMISSIVE policies OR together, so without the second condition this would
--   widen every ordinary request. With it, the policy switches OFF the moment a
--   tenant context exists — which is always, except inside
--   `withPaymentReference()` in packages/db/src/tenant.ts.
--
--   FOR SELECT only: it grants no ability to write an intent. The webhook
--   handler re-enters through `withTenant` once it knows the organization, and
--   every mutation happens there under the ordinary policy.
--
--   It cannot enumerate. The predicate matches one primary key, the uuid is
--   random, and the only caller supplies it from a payload whose signature has
--   already been verified over the exact bytes received.
-- ===========================================================================

CREATE OR REPLACE FUNCTION app_payment_reference() RETURNS uuid
  LANGUAGE sql STABLE PARALLEL SAFE AS
$$ SELECT NULLIF(current_setting('app.payment_reference', true), '')::uuid $$;

DROP POLICY IF EXISTS webhook_reference_lookup ON payment_intents;
CREATE POLICY webhook_reference_lookup ON payment_intents FOR SELECT
  USING (app_current_org() IS NULL AND id = app_payment_reference());

DROP POLICY IF EXISTS webhook_reference_lookup ON payment_mandates;
CREATE POLICY webhook_reference_lookup ON payment_mandates FOR SELECT
  USING (app_current_org() IS NULL AND id = app_payment_reference());
