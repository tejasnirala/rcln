import { Router, type IRouter, type Request, type Response } from 'express';
import {
  careContextStepRequest,
  identityStepRequest,
  localeStepRequest,
  moduleStepRequest,
  staffStepRequest,
  taxStepRequest,
  type CareContextStepRequest,
  type IdentityStepRequest,
  type LocaleStepRequest,
  type ModuleStepRequest,
  type StaffStepRequest,
  type TaxStepRequest,
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
  completeOnboarding,
  getOnboardingState,
  saveCareContextStep,
  saveIdentityStep,
  saveLocaleStep,
  saveModuleStep,
  saveStaffStep,
  saveTaxStep,
} from '../../services/organization/onboarding.service.js';
import { sendSuccess } from '../../utils/response.js';

/**
 * The onboarding wizard (CO-1).
 *
 * The full chain, in the order branches.routes.ts established:
 *
 *   requireTenant -> authenticate -> requireAuth -> authorize -> validate -> handler
 *
 * SINGULAR, LIKE `organization.routes.ts`, AND FOR THE SAME REASON
 *   There is no `:organizationId` in any path. Which clinic this is was settled
 *   by `resolveTenant` from the Host header before a credential was read;
 *   accepting an id would put a second, contradictable answer on the request.
 *   A BRANCH id does travel — in the body of steps 2, 3 and 4 — and is checked
 *   against `ctx.branchIds` in the service, answering 404 for one the caller
 *   cannot see.
 *
 * EVERY STEP IS `PUT`, AND THE VERB IS LOAD-BEARING
 *   Re-entering a step in year two — the clinic that adds a pharmacy — must be
 *   safe to do twice and must not duplicate its rows. The services replace the
 *   scope's child rows wholesale and seed settings only where the clinic has not
 *   already answered. `POST` would advertise the opposite.
 *
 *   The one exception is `/complete`, which is a `POST`: finishing setup is an
 *   event, not a resource with a value, and it is the only call here that
 *   changes what the shell does on the next page load.
 *
 * TWO PERMISSIONS, NOT ONE
 *   Reading the wizard's state and writing it are separate grants. The write
 *   code is also what the web shell gates its redirect on — a caller who holds
 *   it is sent to the wizard until setup is finished, everyone else gets a
 *   banner. Gating on a CODE rather than on ORG_OWNER is ADR-0002.
 */

const router: IRouter = Router();

router.use(requireTenant, authenticate, requireAuth);

const auditMeta = (req: Request): { ipAddress?: string; userAgent?: string } => ({
  ...(req.ip !== undefined ? { ipAddress: req.ip } : {}),
  ...(req.get('user-agent') !== undefined ? { userAgent: req.get('user-agent') as string } : {}),
});

router.get(
  '/',
  authorize(PERMISSIONS.ORG_ONBOARDING_READ),
  async (req: Request, res: Response): Promise<void> => {
    sendSuccess(res, await getOnboardingState(tenantContextFrom(req)));
  }
);

router.put(
  '/steps/identity',
  authorize(PERMISSIONS.ORG_ONBOARDING_WRITE),
  validate(identityStepRequest, 'body'),
  async (req: Request, res: Response): Promise<void> => {
    const ctx = tenantContextFrom(req);
    await saveIdentityStep(ctx, req.body as IdentityStepRequest, auditMeta(req));
    sendSuccess(res, await getOnboardingState(ctx), 'Saved');
  }
);

router.put(
  '/steps/care-contexts',
  authorize(PERMISSIONS.ORG_ONBOARDING_WRITE),
  validate(careContextStepRequest, 'body'),
  async (req: Request, res: Response): Promise<void> => {
    const ctx = tenantContextFrom(req);
    await saveCareContextStep(ctx, req.body as CareContextStepRequest, auditMeta(req));
    sendSuccess(res, await getOnboardingState(ctx), 'Saved');
  }
);

router.put(
  '/steps/modules',
  authorize(PERMISSIONS.ORG_ONBOARDING_WRITE),
  validate(moduleStepRequest, 'body'),
  async (req: Request, res: Response): Promise<void> => {
    const ctx = tenantContextFrom(req);
    await saveModuleStep(ctx, req.body as ModuleStepRequest, auditMeta(req));
    sendSuccess(res, await getOnboardingState(ctx), 'Saved');
  }
);

router.put(
  '/steps/locale',
  authorize(PERMISSIONS.ORG_ONBOARDING_WRITE),
  validate(localeStepRequest, 'body'),
  async (req: Request, res: Response): Promise<void> => {
    const ctx = tenantContextFrom(req);
    await saveLocaleStep(ctx, req.body as LocaleStepRequest, auditMeta(req));
    sendSuccess(res, await getOnboardingState(ctx), 'Saved');
  }
);

router.put(
  '/steps/tax',
  authorize(PERMISSIONS.ORG_ONBOARDING_WRITE),
  validate(taxStepRequest, 'body'),
  async (req: Request, res: Response): Promise<void> => {
    const ctx = tenantContextFrom(req);
    await saveTaxStep(ctx, req.body as TaxStepRequest, auditMeta(req));
    sendSuccess(res, await getOnboardingState(ctx), 'Saved');
  }
);

router.put(
  '/steps/staff',
  authorize(PERMISSIONS.ORG_ONBOARDING_WRITE),
  validate(staffStepRequest, 'body'),
  async (req: Request, res: Response): Promise<void> => {
    const ctx = tenantContextFrom(req);
    await saveStaffStep(ctx, req.body as StaffStepRequest, auditMeta(req));
    sendSuccess(res, await getOnboardingState(ctx), 'Invitations sent');
  }
);

router.post(
  '/complete',
  authorize(PERMISSIONS.ORG_ONBOARDING_WRITE),
  async (req: Request, res: Response): Promise<void> => {
    const ctx = tenantContextFrom(req);
    await completeOnboarding(ctx, auditMeta(req));
    sendSuccess(res, await getOnboardingState(ctx), 'Setup complete');
  }
);

export default router;
