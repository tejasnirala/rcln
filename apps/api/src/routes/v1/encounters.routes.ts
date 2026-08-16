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
  createClinicalFindingRequest,
  createEncounterAdviceRequest,
  createEncounterAttachmentRequest,
  createEncounterDiagnosisRequest,
  createEncounterInvestigationRequest,
  createEncounterPrescriptionRequest,
  createEncounterProcedureRequest,
  createEncounterReferralRequest,
  createEncounterSymptomRequest,
  openEncounterRequest,
  saveEncounterDraftRequest,
  setFollowUpRecommendationRequest,
  updateEncounterAdviceRequest,
  updateEncounterAttachmentRequest,
  updateEncounterDiagnosisRequest,
  updateEncounterInvestigationRequest,
  updateEncounterPrescriptionRequest,
  updateEncounterProcedureRequest,
  updateEncounterReferralRequest,
  updateClinicalFindingRequest,
  updateEncounterSymptomRequest,
  type AmendEncounterRequest,
  type CancelEncounterRequest,
  type OpenEncounterRequest,
  type SaveEncounterDraftRequest,
  type SetFollowUpRecommendationRequest,
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
import {
  addAdvice,
  addAttachment,
  addDiagnosis,
  addFinding,
  addInvestigation,
  addPrescription,
  addProcedure,
  addReferral,
  addSymptom,
  removeAdvice,
  removeAttachment,
  removeDiagnosis,
  removeFinding,
  removeInvestigation,
  removePrescription,
  removeProcedure,
  removeReferral,
  removeSymptom,
  setFollowUpRecommendation,
  updateAdvice,
  updateAttachment,
  updateDiagnosis,
  updateFinding,
  updateInvestigation,
  updatePrescription,
  updateProcedure,
  updateReferral,
  updateSymptom,
} from '../../services/clinical/encounter-content.service.js';
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

// ---------------------------------------------------------------------------
// The clinical content (CE-4)
// ---------------------------------------------------------------------------

/**
 * Nine collections and one singleton, all under the consultation they belong
 * to.
 *
 * ⚠️ NO NEW PERMISSION CODES, AND THAT IS CD-7. Recording a diagnosis IS
 *   writing up the consultation — the same act `PATCH /:encounterId` is. A
 *   `clinical.diagnosis.create` beside `clinical.encounter.create` would be a
 *   second answer to "who may author the clinical record", and a role matrix
 *   that has to be kept in step with itself. Every writer here is
 *   `ENCOUNTER_CREATE`, held by DOCTOR alone among the system roles.
 *
 * ⚠️ EVERY WRITE ANSWERS WITH THE WHOLE CONTENT, not the row that changed. One
 *   of them legitimately changes a row in a DIFFERENT list — removing a
 *   diagnosis unlinks the procedures citing it — so a per-row response would
 *   leave the screen reconciling nine lists by hand and getting that one case
 *   wrong. This is not the autosave, which fires per keystroke and stays small.
 *
 * ⚠️ AND NONE OF THEM IS READ-AUDITED. A write is not a disclosure, and whoever
 *   is writing has already been logged reading the consultation.
 */

const rowParams = encounterParams.extend({ rowId: z.uuid() });

/**
 * The nine collections, each with its create and update schema and the three
 * service functions behind it.
 *
 * ⚠️ A TABLE AND NOT NINE COPIES OF THE SAME THREE HANDLERS. Twenty-seven
 *   near-identical route bodies is twenty-seven places to forget `validate`, to
 *   pass the wrong permission or to drop the `meta` route pattern — and the one
 *   that got it wrong would look exactly like the twenty-six that did not. The
 *   shapes still differ where they genuinely differ: the schemas are per
 *   collection, and the services are per table.
 */
const COLLECTIONS = [
  {
    path: 'symptoms',
    create: createEncounterSymptomRequest,
    update: updateEncounterSymptomRequest,
    add: addSymptom,
    edit: updateSymptom,
    remove: removeSymptom,
  },
  {
    path: 'diagnoses',
    create: createEncounterDiagnosisRequest,
    update: updateEncounterDiagnosisRequest,
    add: addDiagnosis,
    edit: updateDiagnosis,
    remove: removeDiagnosis,
  },
  {
    path: 'procedures',
    create: createEncounterProcedureRequest,
    update: updateEncounterProcedureRequest,
    add: addProcedure,
    edit: updateProcedure,
    remove: removeProcedure,
  },
  {
    path: 'prescriptions',
    create: createEncounterPrescriptionRequest,
    update: updateEncounterPrescriptionRequest,
    add: addPrescription,
    edit: updatePrescription,
    remove: removePrescription,
  },
  {
    path: 'investigations',
    create: createEncounterInvestigationRequest,
    update: updateEncounterInvestigationRequest,
    add: addInvestigation,
    edit: updateInvestigation,
    remove: removeInvestigation,
  },
  {
    path: 'advice',
    create: createEncounterAdviceRequest,
    update: updateEncounterAdviceRequest,
    add: addAdvice,
    edit: updateAdvice,
    remove: removeAdvice,
  },
  {
    path: 'referrals',
    create: createEncounterReferralRequest,
    update: updateEncounterReferralRequest,
    add: addReferral,
    edit: updateReferral,
    remove: removeReferral,
  },
  {
    path: 'attachments',
    create: createEncounterAttachmentRequest,
    update: updateEncounterAttachmentRequest,
    add: addAttachment,
    edit: updateAttachment,
    remove: removeAttachment,
  },
  /*
   * The chart's marks (CE-6), and the ninth member of a table written for
   * eight. It joins here rather than getting three handlers of its own for the
   * reason the table exists: `clinical.encounter.create` gates it, the whole
   * content comes back, and nothing about it is special enough to restate.
   *
   * ⚠️ AND IT IS `ENCOUNTER_CREATE`, NOT `CLINICAL_VISUAL_MAP_MANAGE`. Drawing
   *   ON a chart is writing up the consultation (CD-7); the manage code says
   *   what the chart IS, and a DOCTOR holds neither it nor a need for it.
   */
  {
    path: 'findings',
    create: createClinicalFindingRequest,
    update: updateClinicalFindingRequest,
    add: addFinding,
    edit: updateFinding,
    remove: removeFinding,
  },
] as const;

for (const collection of COLLECTIONS) {
  const base = `/:encounterId/${collection.path}`;

  router.post(
    base,
    authorize(PERMISSIONS.ENCOUNTER_CREATE),
    validate(encounterParams, 'params'),
    validate(collection.create, 'body'),
    async (req: Request, res: Response): Promise<void> => {
      const { encounterId } = req.params as z.infer<typeof encounterParams>;
      sendCreated(
        res,
        await collection.add(
          tenantContextFrom(req),
          encounterId,
          req.body as never,
          meta(req, `POST /v1/encounters/:encounterId/${collection.path}`)
        )
      );
    }
  );

  router.patch(
    `${base}/:rowId`,
    authorize(PERMISSIONS.ENCOUNTER_CREATE),
    validate(rowParams, 'params'),
    validate(collection.update, 'body'),
    async (req: Request, res: Response): Promise<void> => {
      const { encounterId, rowId } = req.params as z.infer<typeof rowParams>;
      sendSuccess(
        res,
        await collection.edit(
          tenantContextFrom(req),
          encounterId,
          rowId,
          req.body as never,
          meta(req, `PATCH /v1/encounters/:encounterId/${collection.path}/:rowId`)
        )
      );
    }
  );

  /**
   * ⚠️ A HARD DELETE, AND THE MIGRATION EXPLAINS WHY NONE OF THESE TABLES HAS A
   *   `deleted_at`. A diagnosis typed and then removed before signing is a
   *   correction to something that was never a record; a tombstone of it makes
   *   the chart's history noisier without making it truer. Immutability begins
   *   at FINALIZED, and the service refuses every write past it.
   */
  router.delete(
    `${base}/:rowId`,
    authorize(PERMISSIONS.ENCOUNTER_CREATE),
    validate(rowParams, 'params'),
    async (req: Request, res: Response): Promise<void> => {
      const { encounterId, rowId } = req.params as z.infer<typeof rowParams>;
      sendSuccess(
        res,
        await collection.remove(
          tenantContextFrom(req),
          encounterId,
          rowId,
          meta(req, `DELETE /v1/encounters/:encounterId/${collection.path}/:rowId`)
        )
      );
    }
  );
}

/**
 * The follow-up plan (CD-13).
 *
 * ⚠️ A `PUT` AND NOT A `POST`, BECAUSE THERE IS EXACTLY ONE PER CONSULTATION. A
 *   doctor states a follow-up plan once; a second statement replaces the first
 *   rather than adding to it, and a screen that could produce two would leave
 *   the recall list with no way to say which the clinic meant. The superseded
 *   row is soft-deleted rather than overwritten — "the doctor said 15 days and
 *   then changed it to 30" is part of the record.
 */
router.put(
  '/:encounterId/follow-up',
  authorize(PERMISSIONS.ENCOUNTER_CREATE),
  validate(encounterParams, 'params'),
  validate(setFollowUpRecommendationRequest, 'body'),
  async (req: Request, res: Response): Promise<void> => {
    const { encounterId } = req.params as z.infer<typeof encounterParams>;
    const body = req.body as SetFollowUpRecommendationRequest;
    sendSuccess(
      res,
      await setFollowUpRecommendation(
        tenantContextFrom(req),
        encounterId,
        body,
        meta(req, 'PUT /v1/encounters/:encounterId/follow-up')
      )
    );
  }
);

export default router;
