import { Router, type IRouter, type Request, type Response } from 'express';
import { z } from 'zod';
import {
  calendarDate,
  clinicTaxParams,
  createClinicTaxRegistrationRequest,
  createClinicTaxRuleRequest,
  listClinicTaxRulesQuery,
  setClinicTaxRegistrationBranchesRequest,
  updateClinicTaxRegistrationRequest,
  updateClinicTaxRuleRequest,
  type CreateClinicTaxRegistrationRequest,
  type CreateClinicTaxRuleRequest,
  type ListClinicTaxRulesQuery,
  type SetClinicTaxRegistrationBranchesRequest,
  type UpdateClinicTaxRegistrationRequest,
  type UpdateClinicTaxRuleRequest,
} from '@rcln/contracts';
import { PERMISSIONS } from '@rcln/permissions';

import {
  authenticate,
  authorize,
  requireAuth,
  tenantContextFrom,
} from '../../middleware/auth.middleware.js';
import { requireTenant } from '../../middleware/tenant.middleware.js';
import { validate } from '../../middleware/validate.middleware.js';
import {
  createClinicTaxRegistration,
  createClinicTaxRule,
  endClinicTaxRule,
  getTaxRateCard,
  listClinicTaxRegistrations,
  listClinicTaxRules,
  setClinicTaxRegistrationBranches,
  updateClinicTaxRegistration,
  updateClinicTaxRule,
  type ClinicTaxActionOptions,
} from '../../services/tax/clinic-tax.service.js';
import { sendCreated, sendSuccess } from '../../utils/response.js';

/**
 * The clinic's own tax configuration.
 *
 * The standard chain, and the order is the security model:
 *
 *   requireTenant -> authenticate -> requireAuth -> authorize -> validate -> handler
 *
 * ⚠️ THIS IS NOT `/v1/platform/tax-registrations`, AND THE TWO MUST NEVER LEARN
 *   TO REACH EACH OTHER. That surface maintains rcln's own registrations and the
 *   catalogue of published rates every clinic inherits, behind
 *   `platform.tax.manage`. This one touches this organization's rows only, behind
 *   `billing.tax.read` / `.manage`, and every service call goes through
 *   `withTenant`. A clinic editing the catalogue would change what every clinic
 *   in the country charges.
 *
 * ⚠️ AND IT IS NOT A PHI SURFACE, WHICH IS WHY NOTHING HERE WRITES
 *   `data_access_logs`. A rate card names categories, rates and jurisdictions —
 *   no patient, no invoice, no line description. The WRITES are audited, in
 *   `audit_logs`, because who changed the rate the clinic bills at is exactly the
 *   question an auditor asks.
 *
 * ⚠️ THERE IS NO DELETE ON EITHER RESOURCE. An invoice issued last March has to
 *   stay explicable, and the row that priced it is the explanation — so a rate
 *   ending is `POST /rules/:id/end`, which sets `effectiveTo`, and a registration
 *   lapsing is the same field through the update. `deletedAt` exists on both
 *   models for a row created in error and is deliberately unreachable from here.
 */
const router: IRouter = Router();

router.use(requireTenant);
router.use(authenticate);
router.use(requireAuth);

/** Request metadata carried onto the audit row. */
const meta = (req: Request): ClinicTaxActionOptions => ({
  ...(req.ip !== undefined ? { ipAddress: req.ip } : {}),
  ...(req.get('user-agent') !== undefined ? { userAgent: req.get('user-agent') as string } : {}),
});

// ---------------------------------------------------------------------------
// The card
// ---------------------------------------------------------------------------

/**
 * What this clinic charges, inherited rows and overrides together.
 *
 * ⚠️ THE ONE ENDPOINT THAT ANSWERS "WHAT DO WE CHARGE FOR A CONSULTATION?", AND
 *   `GET /rules` CANNOT. A clinic with an empty `tax_rules` table is fully
 *   configured rather than unconfigured: rcln maintains a catalogue per country
 *   and the engine READS it at pricing time rather than copying it at signup. A
 *   screen built on the clinic's own rows alone would show nothing and imply
 *   nothing is charged.
 */
router.get(
  '/rate-card',
  authorize(PERMISSIONS.BILLING_TAX_READ),
  async (req: Request, res: Response): Promise<void> => {
    sendSuccess(res, await getTaxRateCard(tenantContextFrom(req)));
  }
);

// ---------------------------------------------------------------------------
// Registrations
// ---------------------------------------------------------------------------

router.get(
  '/registrations',
  authorize(PERMISSIONS.BILLING_TAX_READ),
  async (req: Request, res: Response): Promise<void> => {
    const registrations = await listClinicTaxRegistrations(tenantContextFrom(req));
    sendSuccess(res, { registrations });
  }
);

/**
 * Record a registration this clinic holds.
 *
 * ⚠️ FROM THE MOMENT IT TAKES EFFECT, EVERY INVOICE IT COVERS CARRIES TAX. There
 *   is no publish step: the engine reads the live registrations on every pricing
 *   pass. That is the point — a clinic that registers on the 1st should be
 *   charging on the 1st — and it is why `effectiveFrom` is required rather than
 *   defaulted to today.
 */
router.post(
  '/registrations',
  authorize(PERMISSIONS.BILLING_TAX_MANAGE),
  validate(createClinicTaxRegistrationRequest, 'body'),
  async (req: Request, res: Response): Promise<void> => {
    const registration = await createClinicTaxRegistration(
      tenantContextFrom(req),
      req.body as CreateClinicTaxRegistrationRequest,
      meta(req)
    );
    sendCreated(res, registration, 'Registration recorded');
  }
);

router.patch(
  '/registrations/:id',
  authorize(PERMISSIONS.BILLING_TAX_MANAGE),
  validate(clinicTaxParams, 'params'),
  validate(updateClinicTaxRegistrationRequest, 'body'),
  async (req: Request, res: Response): Promise<void> => {
    const { id } = req.params as z.infer<typeof clinicTaxParams>;
    const registration = await updateClinicTaxRegistration(
      tenantContextFrom(req),
      id,
      req.body as UpdateClinicTaxRegistrationRequest,
      meta(req)
    );
    sendSuccess(res, registration, 'Registration updated');
  }
);

/**
 * State which branches this registration covers.
 *
 * ⚠️ A DIFFERENT QUESTION FROM THE ONE ABOVE, WHICH IS WHY IT IS A DIFFERENT
 *   RESOURCE. `POST /registrations` answers "what registrations does this clinic
 *   hold?" — true whether it has one branch or ten. This answers "which of its
 *   places bills under this one?". Conflating them is how a product ends up
 *   creating a registration every time somebody opens a branch.
 *
 * PUT and not PATCH: the body is the whole set, and a branch left out stops being
 * covered. Same shape as opening hours, for the same reason — it is the only form
 * in which coverage can be removed.
 */
router.put(
  '/registrations/:id/branches',
  authorize(PERMISSIONS.BILLING_TAX_MANAGE),
  validate(clinicTaxParams, 'params'),
  validate(setClinicTaxRegistrationBranchesRequest, 'body'),
  async (req: Request, res: Response): Promise<void> => {
    const { id } = req.params as z.infer<typeof clinicTaxParams>;
    const registration = await setClinicTaxRegistrationBranches(
      tenantContextFrom(req),
      id,
      req.body as SetClinicTaxRegistrationBranchesRequest,
      meta(req)
    );
    sendSuccess(res, registration, 'Coverage updated');
  }
);

// ---------------------------------------------------------------------------
// Rules
// ---------------------------------------------------------------------------

router.get(
  '/rules',
  authorize(PERMISSIONS.BILLING_TAX_READ),
  validate(listClinicTaxRulesQuery, 'query'),
  async (req: Request, res: Response): Promise<void> => {
    const rules = await listClinicTaxRules(
      tenantContextFrom(req),
      req.query as unknown as ListClinicTaxRulesQuery
    );
    sendSuccess(res, { rules });
  }
);

/**
 * Override the catalogue for one category.
 *
 * ⚠️ ALL-OR-NOTHING PER CATEGORY, WHICH THE SCREEN HAS TO SAY OUT LOUD. Writing
 *   one rule for a category takes the WHOLE category out of the inherited set —
 *   rcln's rows for it stop applying entirely. A clinic that overrode British
 *   Columbia's federal GST and kept inheriting the provincial PST would be issuing
 *   invoices carrying one rate it chose and one it has never seen, and neither
 *   party could say who decided the total. `rulesFor` in `@rcln/tax` is where
 *   that decision lives.
 */
router.post(
  '/rules',
  authorize(PERMISSIONS.BILLING_TAX_MANAGE),
  validate(createClinicTaxRuleRequest, 'body'),
  async (req: Request, res: Response): Promise<void> => {
    const rule = await createClinicTaxRule(
      tenantContextFrom(req),
      req.body as CreateClinicTaxRuleRequest,
      meta(req)
    );
    sendCreated(res, rule, 'Rate added');
  }
);

/**
 * Correct a rule.
 *
 * ⚠️ NOT THE PATH FOR A RATE CHANGE, AND IT REFUSES TO BE ONE. Moving the rate on
 *   a rule that priced an ISSUED invoice returns 409: the rule is the account of
 *   what that document charged, and the document's own totals are frozen at the
 *   database. A rate change is an end date here and a new rule from the day
 *   after.
 */
router.patch(
  '/rules/:id',
  authorize(PERMISSIONS.BILLING_TAX_MANAGE),
  validate(clinicTaxParams, 'params'),
  validate(updateClinicTaxRuleRequest, 'body'),
  async (req: Request, res: Response): Promise<void> => {
    const { id } = req.params as z.infer<typeof clinicTaxParams>;
    const rule = await updateClinicTaxRule(
      tenantContextFrom(req),
      id,
      req.body as UpdateClinicTaxRuleRequest,
      meta(req)
    );
    sendSuccess(res, rule, 'Rate updated');
  }
);

/**
 * Stop charging a rule from a date.
 *
 * ⚠️ A POST AND NOT A DELETE, BECAUSE IT IS NOT ONE. The row stays; the rate
 *   stops. Where the catalogue covers the category, rcln's published default
 *   applies again from the next day; where it does not — which is every kind of
 *   goods, on purpose — the category goes UNRATED and cannot be issued. The rate
 *   card reports which, and the screen says so before this is pressed.
 */
const endRuleBody = z.object({ effectiveTo: calendarDate });

router.post(
  '/rules/:id/end',
  authorize(PERMISSIONS.BILLING_TAX_MANAGE),
  validate(clinicTaxParams, 'params'),
  validate(endRuleBody, 'body'),
  async (req: Request, res: Response): Promise<void> => {
    const { id } = req.params as z.infer<typeof clinicTaxParams>;
    const { effectiveTo } = req.body as z.infer<typeof endRuleBody>;
    const rule = await endClinicTaxRule(tenantContextFrom(req), id, effectiveTo, meta(req));
    sendSuccess(res, rule, 'Rate ended');
  }
);

export default router;
