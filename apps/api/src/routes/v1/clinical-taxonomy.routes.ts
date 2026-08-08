/**
 * The clinical taxonomy: browsing the classification tree and curating it.
 *
 * The standard chain, and the order is the security model:
 *
 *   requireTenant -> authenticate -> requireAuth -> authorize -> validate -> handler
 *
 * ── WHY READS ARE BEHIND `DOCTOR_READ` AND NOT THE MANAGE CODE ────────────────
 * Every screen that renders a doctor needs their specialty NAME. Gating the
 * catalogue behind the permission to EDIT it means a receptionist sees blanks
 * where the specialties should be. Same reasoning as `GET /doctors/masters`,
 * which this surface complements rather than replaces.
 *
 * ── NO NEW PERMISSION CODES ──────────────────────────────────────────────────
 * `DOCTOR_READ` and `DOCTOR_MASTER_MANAGE` both already existed;
 * `DOCTOR_MASTER_MANAGE` was granted to ORG_ADMIN and CLINIC_MANAGER and, until
 * now, gated nothing at all. Inventing `taxonomy.*` codes would have meant a
 * second answer to "who may curate the clinical masters" and a role matrix that
 * has to be kept in step with itself.
 *
 * ⚠️ THE WRITE ROUTES CANNOT TOUCH A PLATFORM ROW, and that is enforced twice.
 *   `tenant_isolation` on `specialties` reads permissively but its WITH CHECK
 *   requires `organization_id = app_current_org()`, which a platform row can
 *   never satisfy — so Postgres refuses the write outright. `assertMutable` in
 *   the service runs first only so the caller sees a 400 that explains itself.
 *   See the service header for why the permissive USING clause does NOT let the
 *   update through, which is the intuitive-but-wrong reading.
 *
 * NO PHI on this surface — a classification is not a patient.
 */
import { Router, type IRouter, type Request, type Response } from 'express';
import { z } from 'zod';
import {
  createTaxonomyNodeRequest,
  taxonomySearchQuery,
  taxonomyTreeQuery,
  updateTaxonomyNodeRequest,
  type CreateTaxonomyNodeRequest,
  type TaxonomySearchQuery,
  type TaxonomyTreeQuery,
  type UpdateTaxonomyNodeRequest,
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
  createNode,
  deactivateNode,
  getAncestors,
  getSubtree,
  listChildren,
  listRoots,
  searchNodes,
  updateNode,
} from '../../services/doctor/clinical-taxonomy.service.js';
import { sendSuccess } from '../../utils/response.js';

const router: IRouter = Router();

router.use(requireTenant, authenticate, requireAuth);

const nodeParams = z.object({ nodeId: z.uuid() });

const auditMeta = (req: Request): { ipAddress?: string; userAgent?: string } => ({
  ...(req.ip !== undefined ? { ipAddress: req.ip } : {}),
  ...(req.get('user-agent') !== undefined ? { userAgent: req.get('user-agent') as string } : {}),
});

// --- reads -----------------------------------------------------------------

/**
 * ⚠️ MOUNTED BEFORE `/:nodeId`, AND THAT ORDERING IS LOAD-BEARING. Express
 *   matches in declaration order, so a `/search` declared after the parameter
 *   route is swallowed by it and answers "not a uuid" instead of searching.
 */
router.get(
  '/search',
  authorize(PERMISSIONS.DOCTOR_READ),
  validate(taxonomySearchQuery, 'query'),
  async (req: Request, res: Response): Promise<void> => {
    const query = req.query as unknown as TaxonomySearchQuery;
    sendSuccess(res, { nodes: await searchNodes(tenantContextFrom(req), query) });
  }
);

/** The clinical domains. The entry point for a cascading selector. */
router.get(
  '/',
  authorize(PERMISSIONS.DOCTOR_READ),
  validate(taxonomyTreeQuery, 'query'),
  async (req: Request, res: Response): Promise<void> => {
    const { includeInactive } = req.query as unknown as TaxonomyTreeQuery;
    sendSuccess(res, { nodes: await listRoots(tenantContextFrom(req), includeInactive) });
  }
);

router.get(
  '/:nodeId/children',
  authorize(PERMISSIONS.DOCTOR_READ),
  validate(nodeParams, 'params'),
  validate(taxonomyTreeQuery, 'query'),
  async (req: Request, res: Response): Promise<void> => {
    const { nodeId } = req.params as z.infer<typeof nodeParams>;
    const { includeInactive } = req.query as unknown as TaxonomyTreeQuery;
    sendSuccess(res, {
      nodes: await listChildren(tenantContextFrom(req), nodeId, includeInactive),
    });
  }
);

/** The whole subtree, nested. One round trip for a tree selector. */
router.get(
  '/:nodeId/tree',
  authorize(PERMISSIONS.DOCTOR_READ),
  validate(nodeParams, 'params'),
  validate(taxonomyTreeQuery, 'query'),
  async (req: Request, res: Response): Promise<void> => {
    const { nodeId } = req.params as z.infer<typeof nodeParams>;
    const { includeInactive } = req.query as unknown as TaxonomyTreeQuery;
    sendSuccess(res, await getSubtree(tenantContextFrom(req), nodeId, includeInactive));
  }
);

/** The chain from the domain down to this node's parent. Breadcrumbs. */
router.get(
  '/:nodeId/ancestors',
  authorize(PERMISSIONS.DOCTOR_READ),
  validate(nodeParams, 'params'),
  async (req: Request, res: Response): Promise<void> => {
    const { nodeId } = req.params as z.infer<typeof nodeParams>;
    sendSuccess(res, await getAncestors(tenantContextFrom(req), nodeId));
  }
);

// --- writes ----------------------------------------------------------------

router.post(
  '/',
  authorize(PERMISSIONS.DOCTOR_MASTER_MANAGE),
  validate(createTaxonomyNodeRequest, 'body'),
  async (req: Request, res: Response): Promise<void> => {
    const node = await createNode(
      tenantContextFrom(req),
      req.body as CreateTaxonomyNodeRequest,
      auditMeta(req)
    );
    sendSuccess(res, node, 'Classification added', 201);
  }
);

router.patch(
  '/:nodeId',
  authorize(PERMISSIONS.DOCTOR_MASTER_MANAGE),
  validate(nodeParams, 'params'),
  validate(updateTaxonomyNodeRequest, 'body'),
  async (req: Request, res: Response): Promise<void> => {
    const { nodeId } = req.params as z.infer<typeof nodeParams>;
    const node = await updateNode(
      tenantContextFrom(req),
      nodeId,
      req.body as UpdateTaxonomyNodeRequest,
      auditMeta(req)
    );
    sendSuccess(res, node, 'Classification updated');
  }
);

/**
 * Deactivate, not delete.
 *
 * `doctor_specialties` references this row with ON DELETE RESTRICT and
 * procedures will too. Hard-deleting would destroy the record of what a doctor
 * was classified as; `is_active = false` removes it from every picker while
 * existing assignments keep resolving. The service refuses outright if the node
 * still has active children or assigned doctors.
 */
router.delete(
  '/:nodeId',
  authorize(PERMISSIONS.DOCTOR_MASTER_MANAGE),
  validate(nodeParams, 'params'),
  async (req: Request, res: Response): Promise<void> => {
    const { nodeId } = req.params as z.infer<typeof nodeParams>;
    await deactivateNode(tenantContextFrom(req), nodeId, auditMeta(req));
    sendSuccess(res, null, 'Classification deactivated');
  }
);

export default router;
