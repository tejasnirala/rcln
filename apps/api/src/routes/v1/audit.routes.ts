import { Router, type IRouter, type Request, type Response } from 'express';
import { auditHistoryQuery, type AuditHistoryQuery } from '@rcln/contracts';
import { PERMISSIONS } from '@rcln/permissions';
import {
  authenticate,
  authorize,
  requireAuth,
  tenantContextFrom,
} from '../../middleware/auth.middleware.js';
import { requireTenant } from '../../middleware/tenant.middleware.js';
import { validate } from '../../middleware/validate.middleware.js';
import { readHistory } from '../../services/audit/history.service.js';
import { sendSuccess } from '../../utils/response.js';

/**
 * A record's history.
 *
 * ONE ENDPOINT, READ ONLY, AND THAT IS THE WHOLE ROUTER. There is no POST, PATCH
 * or DELETE here and there must never be one: `audit_logs` is append-only, written
 * exclusively by `recordAudit` inside the transaction it describes. `rcln_app`
 * holds no UPDATE or DELETE grant on the table (see the `audit_immutability`
 * migration), so a route added here would fail at the database rather than quietly
 * work — but the absence of the route is the first line, not the last.
 *
 * The standard chain from CONVENTIONS.md, in the order that IS the security model:
 *
 *   requireTenant -> authenticate -> requireAuth -> authorize -> validate -> handler
 *
 * `entityType` and `entityId` are query parameters rather than a path, because the
 * pair identifies the subject and neither half is meaningful alone. Tenant scoping
 * is RLS's, not this file's — see history.service.ts.
 */

const router: IRouter = Router();

router.use(requireTenant, authenticate, requireAuth);

router.get(
  '/',
  authorize(PERMISSIONS.AUDIT_READ),
  validate(auditHistoryQuery, 'query'),
  async (req: Request, res: Response): Promise<void> => {
    const query = req.query as unknown as AuditHistoryQuery;

    sendSuccess(
      res,
      await readHistory(tenantContextFrom(req), {
        entityType: query.entityType,
        entityId: query.entityId,
        limit: query.limit,
      })
    );
  }
);

export default router;
