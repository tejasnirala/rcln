/**
 * The consultation surface (CE-3).
 *
 * The standard chain, and the order is the security model:
 *
 *   requireTenant -> authenticate -> requireAuth -> authorize -> validate -> handler
 *
 * ── ONE PERMISSION PER ACT, AND THE SPLIT IS INVARIANT 7 ─────────────────────
 *
 *   GET      clinical.encounter.read     anyone who consults the chart, which
 *                                        includes the administrator who never
 *                                        writes in it
 *   POST     clinical.encounter.create   opening and writing up — DOCTOR alone
 *   PATCH    clinical.encounter.create   the autosave IS writing up
 *   finalize clinical.encounter.close    signing the record
 *   amend    clinical.encounter.amend    restating a signed one
 *
 * ⚠️ READING A PATIENT'S RECORD IS NOT WRITING IN IT. The authoring codes are
 *   held by DOCTOR alone among the system roles and are stripped from ORG_OWNER
 *   and ORG_ADMIN by name in `roles.ts` — a clinic that wants an assistant to
 *   write up a consultation grants the code deliberately, which is a decision it
 *   is allowed to take and not one this file takes for it.
 *
 * ⚠️ PHI ON EVERY RESPONSE HERE. Every read writes a `data_access_logs` row, and
 *   `route` is the matched PATTERN and never `req.originalUrl` — a URL carries
 *   its query string with it.
 */
import { Router, type IRouter, type Request, type Response } from 'express';
import { z } from 'zod';
import {
  amendEncounterRequest,
  cancelEncounterRequest,
  openEncounterRequest,
  saveEncounterDraftRequest,
  type AmendEncounterRequest,
  type CancelEncounterRequest,
  type OpenEncounterRequest,
  type SaveEncounterDraftRequest,
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
  amendEncounter,
  cancelEncounter,
  finalizeEncounter,
  getEncounter,
  openEncounter,
  saveEncounterDraft,
} from '../../services/clinical/encounter.service.js';
import { sendCreated, sendSuccess } from '../../utils/response.js';

const router: IRouter = Router();

router.use(requireTenant, authenticate, requireAuth);

const encounterParams = z.object({ encounterId: z.uuid() });

const meta = (
  req: Request,
  route: string
): { ipAddress?: string; userAgent?: string; route: string } => ({
  ...(req.ip !== undefined ? { ipAddress: req.ip } : {}),
  ...(req.get('user-agent') !== undefined ? { userAgent: req.get('user-agent') as string } : {}),
  route,
});

/**
 * Open the consultation for a visit, or resume the one already open.
 *
 * ⚠️ 201 EITHER WAY, AND IT IS IDEMPOTENT. A second call for the same
 *   appointment returns the SAME draft rather than a second record of one visit
 *   — the partial unique index is what guarantees it under a race. The screen
 *   calls this on open and does not need to know which happened.
 */
router.post(
  '/',
  authorize(PERMISSIONS.ENCOUNTER_CREATE),
  validate(openEncounterRequest, 'body'),
  async (req: Request, res: Response): Promise<void> => {
    const body = req.body as OpenEncounterRequest;
    sendCreated(
      res,
      await openEncounter(tenantContextFrom(req), body, meta(req, 'POST /v1/encounters'))
    );
  }
);

/** One consultation, whole, rendered through its own frozen snapshot (§29). */
router.get(
  '/:encounterId',
  authorize(PERMISSIONS.ENCOUNTER_READ),
  validate(encounterParams, 'params'),
  async (req: Request, res: Response): Promise<void> => {
    const { encounterId } = req.params as z.infer<typeof encounterParams>;
    sendSuccess(
      res,
      await getEncounter(
        tenantContextFrom(req),
        encounterId,
        meta(req, 'GET /v1/encounters/:encounterId')
      )
    );
  }
);

/**
 * The debounced autosave (CD-8).
 *
 * ⚠️ RETURNS THE SAVED REVISION AND NOTHING ELSE, and the Server Action that
 *   calls it must not `revalidatePath` — revalidating per keystroke re-renders
 *   the consultation from the server and fights the cursor.
 *
 * ⚠️ NOT READ-AUDITED, DELIBERATELY. A write is not a disclosure, and the doctor
 *   writing the record has already been logged reading it. One row per keystroke
 *   would make the read trail unusable for the question it exists to answer.
 */
router.patch(
  '/:encounterId',
  authorize(PERMISSIONS.ENCOUNTER_CREATE),
  validate(encounterParams, 'params'),
  validate(saveEncounterDraftRequest, 'body'),
  async (req: Request, res: Response): Promise<void> => {
    const { encounterId } = req.params as z.infer<typeof encounterParams>;
    const body = req.body as SaveEncounterDraftRequest;
    sendSuccess(res, await saveEncounterDraft(tenantContextFrom(req), encounterId, body));
  }
);

/**
 * Sign the record.
 *
 * ⚠️ A 400 WITH A SENTENCE, NOT A SILENT SAVE, WHEN A REQUIRED ANSWER IS
 *   MISSING. Every descriptor-driven section is checked against the encounter's
 *   own snapshot, and all the problems come back at once — a doctor sent back
 *   three times for three fields learns to distrust the button.
 */
router.post(
  '/:encounterId/finalize',
  authorize(PERMISSIONS.ENCOUNTER_CLOSE),
  validate(encounterParams, 'params'),
  async (req: Request, res: Response): Promise<void> => {
    const { encounterId } = req.params as z.infer<typeof encounterParams>;
    sendSuccess(
      res,
      await finalizeEncounter(
        tenantContextFrom(req),
        encounterId,
        meta(req, 'POST /v1/encounters/:encounterId/finalize')
      )
    );
  }
);

/**
 * Correct a signed record by starting a new one that cites it (CD-2).
 *
 * ⚠️ 201: THE RESPONSE IS THE NEW DRAFT, NOT THE OLD RECORD. Nothing about the
 *   original changes except its status — that is the entire difference between
 *   an amendment and an edit, and there is no endpoint anywhere that edits a
 *   finalized consultation.
 */
router.post(
  '/:encounterId/amend',
  authorize(PERMISSIONS.ENCOUNTER_AMEND),
  validate(encounterParams, 'params'),
  validate(amendEncounterRequest, 'body'),
  async (req: Request, res: Response): Promise<void> => {
    const { encounterId } = req.params as z.infer<typeof encounterParams>;
    const body = req.body as AmendEncounterRequest;
    sendCreated(
      res,
      await amendEncounter(
        tenantContextFrom(req),
        encounterId,
        body,
        meta(req, 'POST /v1/encounters/:encounterId/amend')
      )
    );
  }
);

/**
 * Abandon a draft.
 *
 * ⚠️ A DRAFT ONLY. A signed consultation is corrected by an amendment and never
 *   withdrawn; the service refuses, and this route does not need to know how.
 */
router.post(
  '/:encounterId/cancel',
  authorize(PERMISSIONS.ENCOUNTER_CREATE),
  validate(encounterParams, 'params'),
  validate(cancelEncounterRequest, 'body'),
  async (req: Request, res: Response): Promise<void> => {
    const { encounterId } = req.params as z.infer<typeof encounterParams>;
    const body = req.body as CancelEncounterRequest;
    await cancelEncounter(
      tenantContextFrom(req),
      encounterId,
      body,
      meta(req, 'POST /v1/encounters/:encounterId/cancel')
    );
    sendSuccess(res, { cancelled: true });
  }
);

export default router;
