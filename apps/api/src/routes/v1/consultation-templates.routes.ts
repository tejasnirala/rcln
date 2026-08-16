/**
 * Consultation templates — the configuration admin surface (CE-2).
 *
 * The standard chain, and the order is the security model:
 *
 *   requireTenant -> authenticate -> requireAuth -> authorize -> validate -> handler
 *
 * ── ONE CODE, BOTH DIRECTIONS, AND THAT IS DELIBERATE ────────────────────────
 *
 * `clinical.template.manage` gates the reads here as well as the writes, which
 * is the opposite of what `/clinical-data` does — and the difference is who
 * needs the answer. Every screen that renders a diagnosis needs the VOCABULARY,
 * so gating the dictionary behind the permission to edit it would show a
 * receptionist uuids where the words should be. Nobody needs the TEMPLATE LIST
 * except the person configuring it: a doctor reads the RESOLVED configuration
 * from `GET /appointments/:id/consultation-config`, behind
 * `clinical.encounter.read`, which they already hold.
 *
 * ⚠️ CONFIGURING A CONSULTATION IS NOT CONDUCTING ONE. That is why this is its
 *   own code and not part of the CLINICAL_AUTHORING set — see `codes.ts`. A
 *   DOCTOR does not hold it, and changing what every colleague's consultation
 *   looks like is not an act of practising.
 *
 * NO PHI ANYWHERE ON THIS SURFACE. A template names no patient, so nothing here
 * is read-audited and every id is safe in a URL.
 */
import { Router, type IRouter, type Request, type Response } from 'express';
import { z } from 'zod';
import {
  consultationTemplateQuery,
  createConsultationTemplateRequest,
  saveTemplateVersionRequest,
  updateConsultationTemplateRequest,
  type ConsultationTemplateQuery,
  type CreateConsultationTemplateRequest,
  type SaveTemplateVersionRequest,
  type UpdateConsultationTemplateRequest,
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
import { DEFAULT_CONSULTATION_DEFINITION } from '../../services/clinical/default-definition.js';
import {
  createDraft,
  createTemplate,
  discardDraft,
  getTemplate,
  listTemplates,
  publishVersion,
  saveDraft,
  updateTemplate,
} from '../../services/clinical/template.service.js';
import { sendCreated, sendSuccess } from '../../utils/response.js';

const router: IRouter = Router();

router.use(requireTenant, authenticate, requireAuth);

const templateParams = z.object({ templateId: z.uuid() });
const versionParams = z.object({ templateId: z.uuid(), versionId: z.uuid() });
const versionQuery = z.object({ versionId: z.uuid().optional() });

const auditMeta = (req: Request): { ipAddress?: string; userAgent?: string } => ({
  ...(req.ip !== undefined ? { ipAddress: req.ip } : {}),
  ...(req.get('user-agent') !== undefined ? { userAgent: req.get('user-agent') as string } : {}),
});

router.get(
  '/',
  authorize(PERMISSIONS.CLINICAL_TEMPLATE_MANAGE),
  validate(consultationTemplateQuery, 'query'),
  async (req: Request, res: Response): Promise<void> => {
    const query = req.query as unknown as ConsultationTemplateQuery;
    sendSuccess(res, await listTemplates(tenantContextFrom(req), query));
  }
);

/**
 * ⚠️ THE NEW TEMPLATE ARRIVES WITH THE DEFAULT CONSULTATION ALREADY IN IT,
 *   rather than with an empty document. A blank starting point is how a clinic
 *   ends up publishing a template with three sections on it, having meant to add
 *   to the ordinary consultation rather than replace it.
 */
router.post(
  '/',
  authorize(PERMISSIONS.CLINICAL_TEMPLATE_MANAGE),
  validate(createConsultationTemplateRequest, 'body'),
  async (req: Request, res: Response): Promise<void> => {
    const body = req.body as CreateConsultationTemplateRequest;
    sendCreated(
      res,
      await createTemplate(
        tenantContextFrom(req),
        body,
        DEFAULT_CONSULTATION_DEFINITION,
        auditMeta(req)
      )
    );
  }
);

/** One template, its version history, and one version's parsed document. */
router.get(
  '/:templateId',
  authorize(PERMISSIONS.CLINICAL_TEMPLATE_MANAGE),
  validate(templateParams, 'params'),
  validate(versionQuery, 'query'),
  async (req: Request, res: Response): Promise<void> => {
    const { templateId } = req.params as z.infer<typeof templateParams>;
    const { versionId } = req.query as unknown as z.infer<typeof versionQuery>;
    sendSuccess(res, await getTemplate(tenantContextFrom(req), templateId, versionId));
  }
);

router.patch(
  '/:templateId',
  authorize(PERMISSIONS.CLINICAL_TEMPLATE_MANAGE),
  validate(templateParams, 'params'),
  validate(updateConsultationTemplateRequest, 'body'),
  async (req: Request, res: Response): Promise<void> => {
    const { templateId } = req.params as z.infer<typeof templateParams>;
    const body = req.body as UpdateConsultationTemplateRequest;
    sendSuccess(
      res,
      await updateTemplate(tenantContextFrom(req), templateId, body, auditMeta(req))
    );
  }
);

/**
 * Start a new draft, copied from the published version.
 *
 * ⚠️ A POST WITH NO BODY, BECAUSE EDITING A LIVE TEMPLATE IS PUBLISHING A NEW
 *   VERSION (CD-6). There is no endpoint that edits a published document, and
 *   there never will be: a finalized consultation's snapshot is a statement
 *   about the configuration that existed when it was made.
 */
router.post(
  '/:templateId/versions',
  authorize(PERMISSIONS.CLINICAL_TEMPLATE_MANAGE),
  validate(templateParams, 'params'),
  async (req: Request, res: Response): Promise<void> => {
    const { templateId } = req.params as z.infer<typeof templateParams>;
    sendCreated(res, await createDraft(tenantContextFrom(req), templateId, auditMeta(req)));
  }
);

/**
 * Save the draft's document.
 *
 * ⚠️ REFUSES A DOCUMENT THAT SAYS NOTHING CHECKABLE, with a sentence naming the
 *   section and the key (CD-10). `{ "require": true }` for `{ "required": true }`
 *   comes back as a 400 rather than as a mandatory field silently switched off.
 */
router.put(
  '/:templateId/versions/:versionId',
  authorize(PERMISSIONS.CLINICAL_TEMPLATE_MANAGE),
  validate(versionParams, 'params'),
  validate(saveTemplateVersionRequest, 'body'),
  async (req: Request, res: Response): Promise<void> => {
    const { templateId, versionId } = req.params as z.infer<typeof versionParams>;
    const body = req.body as SaveTemplateVersionRequest;
    sendSuccess(
      res,
      await saveDraft(tenantContextFrom(req), templateId, versionId, body, auditMeta(req))
    );
  }
);

/** Put the draft live, retiring the version it replaces in the same transaction. */
router.post(
  '/:templateId/versions/:versionId/publish',
  authorize(PERMISSIONS.CLINICAL_TEMPLATE_MANAGE),
  validate(versionParams, 'params'),
  async (req: Request, res: Response): Promise<void> => {
    const { templateId, versionId } = req.params as z.infer<typeof versionParams>;
    sendSuccess(
      res,
      await publishVersion(tenantContextFrom(req), templateId, versionId, auditMeta(req))
    );
  }
);

/**
 * Discard a draft.
 *
 * ⚠️ ONLY A DRAFT. A published or retired version is not deletable by any path:
 *   a five-year-old consultation renders from it. The service refuses; this
 *   route does not need to know how.
 */
router.delete(
  '/:templateId/versions/:versionId',
  authorize(PERMISSIONS.CLINICAL_TEMPLATE_MANAGE),
  validate(versionParams, 'params'),
  async (req: Request, res: Response): Promise<void> => {
    const { templateId, versionId } = req.params as z.infer<typeof versionParams>;
    await discardDraft(tenantContextFrom(req), templateId, versionId, auditMeta(req));
    sendSuccess(res, { discarded: true });
  }
);

export default router;
