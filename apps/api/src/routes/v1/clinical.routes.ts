/**
 * The clinical vocabulary and the treatment journey.
 *
 * The standard chain, and the order is the security model:
 *
 *   requireTenant -> authenticate -> requireAuth -> authorize -> validate -> handler
 *
 * ── TWO SURFACES, TWO DISCLOSURE CLASSES, TWO SETS OF CODES ──────────────────
 *
 *   /clinical-data/*     the VOCABULARY. "Dental caries" discloses nothing about
 *                        anybody. Read behind the codes that already let you see
 *                        a chart; written behind `clinical.master.manage`.
 *
 *   /clinical-episodes/* a named patient's TREATMENT JOURNEY. PHI. Every read
 *                        writes a `data_access_logs` row under CLINICAL_EPISODE.
 *
 * ── WHY THE VOCABULARY IS READ BEHIND `APPOINTMENT_READ` ─────────────────────
 *
 * Every screen that renders a diagnosis needs its NAME. Gating the dictionary
 * behind the permission to EDIT it means a receptionist sees uuids where the
 * words should be, and a doctor cannot pick a symptom without also being allowed
 * to invent one. Same reasoning `clinical-taxonomy.routes.ts` records for
 * `DOCTOR_READ`, and the same reason `product.definition.read` gates the
 * catalogue masters rather than the manage code.
 *
 * ── NO NEW PERMISSION CODES ──────────────────────────────────────────────────
 *
 * `clinical.master.manage` already existed and gated nothing. Inventing
 * `vocabulary.*` codes would mean a second answer to "who curates the clinical
 * masters" and a role matrix that has to be kept in step with itself (CD-7).
 *
 * Episodes are read behind `APPOINTMENT_READ` and opened behind
 * `APPOINTMENT_CREATE` because an episode is a BOOKING-TIME concept: the front
 * desk picks one while making an appointment, and the front desk holds neither
 * `clinical.encounter.read` nor anything else clinical. Closing one is
 * `APPOINTMENT_UPDATE` for the same reason.
 */
import { Router, type IRouter, type Request, type Response } from 'express';
import { z } from 'zod';
import {
  clinicalEpisodeQuery,
  clinicalMasterQuery,
  createClinicalEpisodeRequest,
  createClinicalMasterRequest,
  updateClinicalEpisodeRequest,
  updateClinicalMasterRequest,
  type ClinicalEpisodeQuery,
  type ClinicalMasterQuery,
  type CreateClinicalEpisodeRequest,
  type CreateClinicalMasterRequest,
  type UpdateClinicalEpisodeRequest,
  type UpdateClinicalMasterRequest,
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
  createEpisode,
  getEpisode,
  listEpisodes,
  updateEpisode,
} from '../../services/clinical/episode.service.js';
import {
  createMaster,
  deactivateMaster,
  searchMasters,
  updateMaster,
} from '../../services/clinical/master.service.js';
import { sendCreated, sendSuccess } from '../../utils/response.js';

const router: IRouter = Router();

router.use(requireTenant, authenticate, requireAuth);

const itemParams = z.object({ itemId: z.uuid() });
const episodeParams = z.object({ episodeId: z.uuid() });

/**
 * ⚠️ `route` IS THE MATCHED PATTERN, NEVER `req.originalUrl`. A URL carries its
 *   query string, and a search term is a disclosure.
 */
const readMeta = (
  req: Request,
  route: string
): { ipAddress?: string; userAgent?: string; route: string } => ({
  ...(req.ip !== undefined ? { ipAddress: req.ip } : {}),
  ...(req.get('user-agent') !== undefined ? { userAgent: req.get('user-agent') as string } : {}),
  route,
});

const auditMeta = (req: Request): { ipAddress?: string; userAgent?: string } => ({
  ...(req.ip !== undefined ? { ipAddress: req.ip } : {}),
  ...(req.get('user-agent') !== undefined ? { userAgent: req.get('user-agent') as string } : {}),
});

// ---------------------------------------------------------------------------
// The vocabulary
// ---------------------------------------------------------------------------

/**
 * Search one kind of clinical word.
 *
 * ⚠️ ALWAYS PAGINATED, AND THERE IS DELIBERATELY NO "GIVE ME EVERYTHING" FORM
 *   (§39). A clinical selector is typed into constantly, and the platform
 *   catalogue is shared — so an unpaginated read gets slower as OTHER clinics'
 *   vocabularies grow, which is the worst kind of performance bug to diagnose.
 *
 * ⚠️ NOT READ-AUDITED, and that is correct rather than an omission. A dictionary
 *   entry names nobody. Writing a `data_access_logs` row per keystroke would
 *   bury the reads that DO disclose a patient under millions that disclose
 *   nothing — the exact failure the day board avoids by not logging either.
 */
router.get(
  '/clinical-data',
  authorize(PERMISSIONS.APPOINTMENT_READ),
  validate(clinicalMasterQuery, 'query'),
  async (req: Request, res: Response): Promise<void> => {
    const query = req.query as unknown as ClinicalMasterQuery;
    sendSuccess(res, await searchMasters(tenantContextFrom(req), query));
  }
);

router.post(
  '/clinical-data',
  authorize(PERMISSIONS.CLINICAL_MASTER_MANAGE),
  validate(createClinicalMasterRequest, 'body'),
  async (req: Request, res: Response): Promise<void> => {
    const body = req.body as CreateClinicalMasterRequest;
    sendCreated(res, await createMaster(tenantContextFrom(req), body, auditMeta(req)));
  }
);

router.patch(
  '/clinical-data/:itemId',
  authorize(PERMISSIONS.CLINICAL_MASTER_MANAGE),
  validate(itemParams, 'params'),
  validate(updateClinicalMasterRequest, 'body'),
  async (req: Request, res: Response): Promise<void> => {
    const { itemId } = req.params as z.infer<typeof itemParams>;
    const body = req.body as UpdateClinicalMasterRequest;
    sendSuccess(res, await updateMaster(tenantContextFrom(req), itemId, body, auditMeta(req)));
  }
);

/**
 * Deactivate, not delete.
 *
 * From CE-4 the encounter children reference these rows, and hard-deleting would
 * destroy the record of what a clinician actually concluded. `is_active = false`
 * removes the word from every picker while every consultation that already used
 * it keeps rendering.
 */
router.delete(
  '/clinical-data/:itemId',
  authorize(PERMISSIONS.CLINICAL_MASTER_MANAGE),
  validate(itemParams, 'params'),
  async (req: Request, res: Response): Promise<void> => {
    const { itemId } = req.params as z.infer<typeof itemParams>;
    await deactivateMaster(tenantContextFrom(req), itemId, auditMeta(req));
    sendSuccess(res, { deactivated: true });
  }
);

// ---------------------------------------------------------------------------
// Treatment journeys
// ---------------------------------------------------------------------------

/**
 * Every journey a patient has been on — the visit history (§18).
 *
 * ⚠️ `patientId` IS REQUIRED AND THERE IS NO "ALL EPISODES" FORM. An unfiltered
 *   list of treatment journeys is a list of who in the clinic is under ongoing
 *   treatment for what, which is a disclosure nobody has a reason to request.
 */
router.get(
  '/clinical-episodes',
  authorize(PERMISSIONS.APPOINTMENT_READ),
  validate(clinicalEpisodeQuery, 'query'),
  async (req: Request, res: Response): Promise<void> => {
    const query = req.query as unknown as ClinicalEpisodeQuery;
    sendSuccess(
      res,
      await listEpisodes(tenantContextFrom(req), query, readMeta(req, 'GET /v1/clinical-episodes'))
    );
  }
);

router.post(
  '/clinical-episodes',
  authorize(PERMISSIONS.APPOINTMENT_CREATE),
  validate(createClinicalEpisodeRequest, 'body'),
  async (req: Request, res: Response): Promise<void> => {
    const body = req.body as CreateClinicalEpisodeRequest;
    sendCreated(res, await createEpisode(tenantContextFrom(req), body));
  }
);

/** The journey and its visits, in order. ⚠️ Writes a `data_access_logs` row. */
router.get(
  '/clinical-episodes/:episodeId',
  authorize(PERMISSIONS.APPOINTMENT_READ),
  validate(episodeParams, 'params'),
  async (req: Request, res: Response): Promise<void> => {
    const { episodeId } = req.params as z.infer<typeof episodeParams>;
    sendSuccess(
      res,
      await getEpisode(
        tenantContextFrom(req),
        episodeId,
        readMeta(req, 'GET /v1/clinical-episodes/:episodeId')
      )
    );
  }
);

router.patch(
  '/clinical-episodes/:episodeId',
  authorize(PERMISSIONS.APPOINTMENT_UPDATE),
  validate(episodeParams, 'params'),
  validate(updateClinicalEpisodeRequest, 'body'),
  async (req: Request, res: Response): Promise<void> => {
    const { episodeId } = req.params as z.infer<typeof episodeParams>;
    const body = req.body as UpdateClinicalEpisodeRequest;
    await updateEpisode(tenantContextFrom(req), episodeId, body, auditMeta(req));
    sendSuccess(res, { updated: true });
  }
);

export default router;
