/**
 * Visual maps — the charts a consultation draws on (CE-6).
 *
 * The standard chain, and the order is the security model:
 *
 *   requireTenant -> authenticate -> requireAuth -> authorize -> validate -> handler
 *
 * ── ONE CODE, BOTH DIRECTIONS, LIKE THE TEMPLATES AND UNLIKE THE VOCABULARY ──
 *
 * `clinical.visual_map.manage` gates the reads here as well as the writes.
 * `/clinical-data` makes the opposite call, and the difference is who needs the
 * answer: every screen that renders a diagnosis needs the VOCABULARY, so gating
 * the dictionary behind the permission to edit it would show a receptionist
 * uuids where the words should be. Nobody needs the MAP LIST except the person
 * configuring one — a doctor gets the chart already resolved onto their
 * consultation, from `GET /appointments/:id/consultation-config` and from the
 * encounter itself, both behind `clinical.encounter.read`, which they hold.
 *
 * ⚠️ DRAWING ON A CHART IS NOT CONFIGURING ONE. Findings are written through
 *   `/encounters/:id/findings` behind `clinical.encounter.create` (CD-7), which
 *   DOCTOR holds alone among the system roles and this code's holders do not.
 *
 * NO PHI ANYWHERE ON THIS SURFACE. A map names no patient — the 32 teeth of the
 * FDI notation are the same 32 teeth everywhere — so nothing here is
 * read-audited and every id is safe in a URL.
 */
import { Router, type IRouter, type Request, type Response } from 'express';
import { z } from 'zod';
import {
  createVisualMapRequest,
  createVisualRegionRequest,
  updateVisualMapRequest,
  updateVisualRegionRequest,
  visualMapQuery,
  type CreateVisualMapRequest,
  type CreateVisualRegionRequest,
  type UpdateVisualMapRequest,
  type UpdateVisualRegionRequest,
  type VisualMapQuery,
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
  addVisualRegion,
  createVisualMap,
  getVisualMap,
  listVisualMaps,
  removeVisualRegion,
  updateVisualMap,
  updateVisualRegion,
} from '../../services/clinical/visual-map.service.js';
import { sendCreated, sendSuccess } from '../../utils/response.js';

const router: IRouter = Router();

router.use(requireTenant, authenticate, requireAuth);

const mapParams = z.object({ mapId: z.uuid() });
const regionParams = mapParams.extend({ regionId: z.uuid() });

const auditMeta = (req: Request): { ipAddress?: string; userAgent?: string } => ({
  ...(req.ip !== undefined ? { ipAddress: req.ip } : {}),
  ...(req.get('user-agent') !== undefined ? { userAgent: req.get('user-agent') as string } : {}),
});

router.get(
  '/',
  authorize(PERMISSIONS.CLINICAL_VISUAL_MAP_MANAGE),
  validate(visualMapQuery, 'query'),
  async (req: Request, res: Response): Promise<void> => {
    const query = req.query as unknown as VisualMapQuery;
    sendSuccess(res, await listVisualMaps(tenantContextFrom(req), query));
  }
);

/** One chart and every place on it — what the editor and the preview draw. */
router.get(
  '/:mapId',
  authorize(PERMISSIONS.CLINICAL_VISUAL_MAP_MANAGE),
  validate(mapParams, 'params'),
  async (req: Request, res: Response): Promise<void> => {
    const { mapId } = req.params as z.infer<typeof mapParams>;
    sendSuccess(res, await getVisualMap(tenantContextFrom(req), mapId));
  }
);

/**
 * ⚠️ A NEW CHART ARRIVES EMPTY, unlike a new consultation template, which
 *   arrives with the default consultation in it. A template with three sections
 *   is a clinic that meant to add to the ordinary consultation; a chart with
 *   somebody else's regions in it is a chart that means something different from
 *   what it draws. There is no sensible default picture of a body.
 */
router.post(
  '/',
  authorize(PERMISSIONS.CLINICAL_VISUAL_MAP_MANAGE),
  validate(createVisualMapRequest, 'body'),
  async (req: Request, res: Response): Promise<void> => {
    const body = req.body as CreateVisualMapRequest;
    sendCreated(res, await createVisualMap(tenantContextFrom(req), body, auditMeta(req)));
  }
);

router.patch(
  '/:mapId',
  authorize(PERMISSIONS.CLINICAL_VISUAL_MAP_MANAGE),
  validate(mapParams, 'params'),
  validate(updateVisualMapRequest, 'body'),
  async (req: Request, res: Response): Promise<void> => {
    const { mapId } = req.params as z.infer<typeof mapParams>;
    const body = req.body as UpdateVisualMapRequest;
    sendSuccess(res, await updateVisualMap(tenantContextFrom(req), mapId, body, auditMeta(req)));
  }
);

/**
 * The regions. Each write answers with the WHOLE chart rather than the region
 * that changed — the editor renders a picture, and a picture reassembled from
 * per-row responses is one that can disagree with itself.
 */
router.post(
  '/:mapId/regions',
  authorize(PERMISSIONS.CLINICAL_VISUAL_MAP_MANAGE),
  validate(mapParams, 'params'),
  validate(createVisualRegionRequest, 'body'),
  async (req: Request, res: Response): Promise<void> => {
    const { mapId } = req.params as z.infer<typeof mapParams>;
    const body = req.body as CreateVisualRegionRequest;
    sendCreated(res, await addVisualRegion(tenantContextFrom(req), mapId, body, auditMeta(req)));
  }
);

router.patch(
  '/:mapId/regions/:regionId',
  authorize(PERMISSIONS.CLINICAL_VISUAL_MAP_MANAGE),
  validate(regionParams, 'params'),
  validate(updateVisualRegionRequest, 'body'),
  async (req: Request, res: Response): Promise<void> => {
    const { mapId, regionId } = req.params as z.infer<typeof regionParams>;
    const body = req.body as UpdateVisualRegionRequest;
    sendSuccess(
      res,
      await updateVisualRegion(tenantContextFrom(req), mapId, regionId, body, auditMeta(req))
    );
  }
);

/**
 * ⚠️ A HARD DELETE, AND THE SERVICE REFUSES ONE THAT A RECORD CITES. A region a
 *   finalized consultation drew on cannot go — the record would stop being able
 *   to say where — and it comes back as a sentence rather than a foreign-key
 *   violation.
 */
router.delete(
  '/:mapId/regions/:regionId',
  authorize(PERMISSIONS.CLINICAL_VISUAL_MAP_MANAGE),
  validate(regionParams, 'params'),
  async (req: Request, res: Response): Promise<void> => {
    const { mapId, regionId } = req.params as z.infer<typeof regionParams>;
    sendSuccess(
      res,
      await removeVisualRegion(tenantContextFrom(req), mapId, regionId, auditMeta(req))
    );
  }
);

export default router;
