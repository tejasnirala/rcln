import {
  Router,
  type IRouter,
  type NextFunction,
  type Request,
  type RequestHandler,
  type Response,
} from 'express';
import { auditHistoryQuery, type AuditHistoryQuery } from '@rcln/contracts';
import { PERMISSIONS, type PermissionCode } from '@rcln/permissions';
import {
  authenticate,
  callerHasPermission,
  requireAuth,
  tenantContextFrom,
} from '../../middleware/auth.middleware.js';
import { AuthorizationError } from '../../utils/errors.js';
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

/**
 * Entity types whose history is ALSO readable by whoever may write the record.
 *
 * ⚠️ THE RULE IS "YOU MAY READ THE HISTORY OF A RECORD YOU MAY WRITE", AND IT IS
 *   A MAP RATHER THAN A SECOND BLANKET CODE FOR A REASON. `audit.record.read`
 *   opens the trail for EVERY entity type — roles, memberships, branches, the
 *   clinic's own settings — so handing it to the front desk to let them see who
 *   corrected a blood pressure would also hand them every permission change and
 *   every configuration edit the clinic has ever made. That is not a trade worth
 *   making for one drawer.
 *
 *   So the widening is per entity type and per permission. A receptionist holds
 *   `clinical.vitals.read`; they took the observation, they can see that it
 *   was corrected and by whom. They still cannot open the history of a role.
 *
 * ⚠️ THE READ CODE, NOT THE WRITE ONE. It was `clinical.vitals.record` until the
 *   two were split, which would now shut a DOCTOR out of the correction trail on
 *   the very readings their consultation is based on — they hold the read and
 *   deliberately not the write. "Who corrected this, and when" is part of
 *   reading the observation, not part of taking it.
 *
 * ⚠️ IT DISCLOSES NOTHING THEY COULD NOT ALREADY READ. `appointment_vital` audit
 *   rows carry ids, the NAMES of which observations a reading holds, and the
 *   staff member who acted — never a measurement (see `snapshot()` in
 *   vitals.service.ts) and never a patient name. The same caller can already
 *   read the readings themselves through `GET /appointments/:id/vitals`, which
 *   is behind this very code.
 *
 * Adding an entry here is a permission decision. Do not add one because a screen
 * showed a 403; add one because the holder of that code is the person who wrote
 * the record.
 */
const HISTORY_ALSO_READABLE_BY: Record<string, PermissionCode> = {
  appointment_vital: PERMISSIONS.VITALS_READ,
};

/**
 * The gate: `audit.record.read`, or the code that owns this entity type.
 *
 * ⚠️ IT IS STILL MIDDLEWARE, AND IT STILL SITS WHERE `authorize()` SAT. The
 *   chain order is the security model and this does not change it — what it
 *   changes is that the acceptable code depends on WHICH record is being asked
 *   about, which `authorize(...)` cannot express because it requires all of a
 *   fixed list.
 *
 * ⚠️ IT READS `entityType` BEFORE `validate` HAS RUN, so the value is raw client
 *   input. That is safe here and only here: it is used for one lookup in a
 *   closed map, so anything unrecognised simply misses and falls through to the
 *   403. `validate` still runs immediately after and is what the handler trusts.
 */
function authorizeHistory(): RequestHandler {
  return (req: Request, _res: Response, next: NextFunction): void => {
    void (async (): Promise<void> => {
      try {
        if (await callerHasPermission(req, PERMISSIONS.AUDIT_READ)) {
          next();
          return;
        }

        const entityType = String((req.query as Record<string, unknown>)['entityType'] ?? '');
        const owning = HISTORY_ALSO_READABLE_BY[entityType];

        if (owning !== undefined && (await callerHasPermission(req, owning))) {
          next();
          return;
        }

        // "Access denied" and nothing more: naming the missing code maps out the
        // permission model for an attacker, exactly as `authorize()` reasons.
        next(new AuthorizationError('Access denied'));
      } catch (error) {
        next(error);
      }
    })();
  };
}

router.get(
  '/',
  authorizeHistory(),
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
