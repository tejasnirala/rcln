import { Router, type IRouter, type Request, type Response } from 'express';
import { z } from 'zod';
import {
  settingValueRequest,
  updateOrganizationRequest,
  type SettingValueRequest,
  type UpdateOrganizationRequest,
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
  getOrganization,
  updateOrganization,
} from '../../services/organization/organization.service.js';
import {
  clearSetting,
  listSettings,
  setSetting,
} from '../../services/organization/setting.service.js';
import { sendSuccess } from '../../utils/response.js';

/**
 * The clinic's own record, and the settings hanging off it.
 *
 * The full chain, in the order branches.routes.ts established:
 *
 *   requireTenant -> authenticate -> requireAuth -> authorize -> validate -> handler
 *
 * SINGULAR ON PURPOSE — THERE IS NO `:organizationId`
 *   Which organization this is was decided by `resolveTenant` from the Host
 *   header, before any credential was read. Accepting an id in the path would
 *   put a second, contradictable answer on the same request, and both
 *   `organizations` and `setting_values` are RLS-exempt, so the database would
 *   not settle the argument. See the headers of the two services.
 *
 * FOUR PERMISSIONS, NOT TWO
 *   Reading the clinic's particulars and reading its configuration are separate
 *   grants, and so are the two writes: `organization.update` changes who the
 *   clinic legally is, `settings.organization.write` changes how it behaves.
 *   An office manager who may fix a GSTIN has no business changing the session
 *   timeout.
 */

const router: IRouter = Router();

router.use(requireTenant, authenticate, requireAuth);

/** `setting_definitions.key` is a VarChar(128), not a uuid. */
const settingParams = z.object({ key: z.string().min(1).max(128) });

const auditMeta = (req: Request): { ipAddress?: string; userAgent?: string } => ({
  ...(req.ip !== undefined ? { ipAddress: req.ip } : {}),
  ...(req.get('user-agent') !== undefined ? { userAgent: req.get('user-agent') as string } : {}),
});

router.get(
  '/',
  authorize(PERMISSIONS.ORG_READ),
  async (req: Request, res: Response): Promise<void> => {
    sendSuccess(res, await getOrganization(tenantContextFrom(req)));
  }
);

router.patch(
  '/',
  authorize(PERMISSIONS.ORG_UPDATE),
  validate(updateOrganizationRequest, 'body'),
  async (req: Request, res: Response): Promise<void> => {
    const organization = await updateOrganization(
      tenantContextFrom(req),
      req.body as UpdateOrganizationRequest,
      auditMeta(req)
    );
    sendSuccess(res, organization, 'Clinic details updated');
  }
);

router.get(
  '/settings',
  authorize(PERMISSIONS.SETTINGS_ORG_READ),
  async (req: Request, res: Response): Promise<void> => {
    const settings = await listSettings(tenantContextFrom(req));
    sendSuccess(res, { settings });
  }
);

/**
 * PUT, not PATCH: a setting has exactly one value and this replaces it.
 *
 * Not a create either — whether the row exists is an implementation detail of
 * the override, so this always answers 200 with the setting as it now resolves.
 */
router.put(
  '/settings/:key',
  authorize(PERMISSIONS.SETTINGS_ORG_WRITE),
  validate(settingParams, 'params'),
  validate(settingValueRequest, 'body'),
  async (req: Request, res: Response): Promise<void> => {
    const { key } = req.params as z.infer<typeof settingParams>;
    const { value } = req.body as SettingValueRequest;
    const setting = await setSetting(tenantContextFrom(req), key, value, auditMeta(req));
    sendSuccess(res, setting, 'Setting saved');
  }
);

/**
 * Clear this clinic's override and fall back to what it was overruling.
 *
 * DELETE rather than `{ value: null }`, because null is a value a JSON setting
 * may legitimately hold. Returns the setting as it now resolves, so the caller
 * does not have to re-read the list to find out what took over.
 */
router.delete(
  '/settings/:key',
  authorize(PERMISSIONS.SETTINGS_ORG_WRITE),
  validate(settingParams, 'params'),
  async (req: Request, res: Response): Promise<void> => {
    const { key } = req.params as z.infer<typeof settingParams>;
    const setting = await clearSetting(tenantContextFrom(req), key, auditMeta(req));
    sendSuccess(res, setting, 'Setting reset');
  }
);

export default router;
