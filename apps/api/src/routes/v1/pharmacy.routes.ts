/**
 * Pharmacy: the queue, the counter, returns and the dashboard (PI-7).
 *
 * The standard chain, and the order IS the security model:
 *
 *   requireTenant -> authenticate -> requireAuth -> authorize -> validate -> handler
 *
 * ── WHICH CODE GATES WHAT, AND WHY ──────────────────────────────────────────
 *
 *   the queue, a prescription, a dispense, substitutions  ->  `pharmacy.dispense.read`
 *   verifying a prescription, or standing it down         ->  `pharmacy.dispense.verify`
 *   supplying, and a counter sale                         ->  `pharmacy.dispense.create`
 *   taking something back                                 ->  `pharmacy.dispense.return`
 *
 * ⚠️ `.verify` IS NEW IN PI-7 AND `PHARMACIST` HOLDS IT ALONGSIDE `.create`. The
 *   split is a clinical-safety control, not a segregation-of-duty one: a
 *   dispensary with one pharmacist has nobody else, and unlike the requisition
 *   split in PI-4 the service deliberately does NOT refuse self-verification —
 *   a pharmacist checking a prescription and then dispensing it is the normal,
 *   lawful workflow. What the split buys is that a clinic which separates the
 *   two can, and that the record says which person did which act.
 *
 * ⚠️ NOTHING ON THIS ROUTER WRITES THE CLINICAL RECORD (invariant 7). There is no
 *   route here that touches `encounter_prescriptions`, and the one endpoint that
 *   looks like it might — `POST /prescriptions/:encounterId/verify` — writes
 *   `prescription_fulfilments`, pharmacy's own row beside the consultation.
 *
 * ⚠️ AND A REGULATORY REFUSAL IS A `422`, NEVER A `403`. A 403 says "you may not
 *   do this", which sends a pharmacist to an administrator to fix a permission
 *   that was never wrong; a 422 says "this supply is not lawful here today", and
 *   carries the rule's own sentence for the pharmacist to read to the patient.
 *   See `RegulatoryRefusalError`.
 *
 * ── PHI ─────────────────────────────────────────────────────────────────────
 * ⚠️ EVERY READ ON THIS ROUTER IS A DISCLOSURE, and every one of them passes the
 *   matched route PATTERN — never `req.originalUrl` — down to `recordDataAccess`.
 *   The services write one row per request. The dashboard is the deliberate
 *   exception and says so in its own header: it returns counts and singles out
 *   nobody.
 *
 * ⚠️ THE CALLER'S EFFECTIVE PERMISSION CODES ARE RESOLVED HERE AND HANDED DOWN,
 *   because the regulatory engine judges the person dispensing — a
 *   `PHARMACIST_AUTHORITY` rule reads permission codes, not role names.
 *   `authorize()` has already warmed that cache, so this is a hit rather than a
 *   query, and it keeps "what may this person do" answered in one place.
 */
import { Router, type IRouter, type Request, type Response } from 'express';
import { z } from 'zod';
import {
  cancelPrescriptionFulfilmentRequest,
  createDispenseRequest,
  createDispenseReturnRequest,
  dispenseQuery,
  pharmacyDashboardQuery,
  prescriptionQueueQuery,
  substitutionQuery,
  verifyPrescriptionRequest,
  type CancelPrescriptionFulfilmentRequest,
  type CreateDispenseRequest,
  type CreateDispenseReturnRequest,
  type DispenseQuery,
  type PharmacyDashboardQuery,
  type PrescriptionQueueQuery,
  type SubstitutionQuery,
  type VerifyPrescriptionRequest,
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
import { loadUserAccess, permissionsFor } from '../../services/auth/access.service.js';
import {
  cancelPrescriptionFulfilment,
  getPharmacyPrescription,
  listPrescriptionQueue,
  verifyPrescription,
  type PharmacyActionOptions,
} from '../../services/pharmacy/queue.service.js';
import {
  createDispense,
  getDispense,
  listDispenses,
} from '../../services/pharmacy/dispense.service.js';
import { createDispenseReturn } from '../../services/pharmacy/return.service.js';
import { listSubstitutionCandidates } from '../../services/pharmacy/substitution.service.js';
import { getPharmacyDashboard } from '../../services/pharmacy/dashboard.service.js';
import { sendSuccess } from '../../utils/response.js';

const DISPENSE_READ = PERMISSIONS.DISPENSE_READ;
const DISPENSE_VERIFY = PERMISSIONS.DISPENSE_VERIFY;
const DISPENSE_CREATE = PERMISSIONS.DISPENSE_CREATE;
const DISPENSE_RETURN = PERMISSIONS.DISPENSE_RETURN;

const router: IRouter = Router();
router.use(requireTenant, authenticate, requireAuth);

const encounterParams = z.object({ encounterId: z.uuid() });
const dispenseParams = z.object({ dispenseId: z.uuid() });
const productParams = z.object({ productId: z.uuid() });

/**
 * Everything the services need about WHO is asking and from WHERE.
 *
 * ⚠️ `roleCodes` IS THE CALLER'S EFFECTIVE PERMISSIONS FOR THE BRANCH BEING
 *   ACTED ON, and it is resolved here rather than derived inside a service,
 *   because `TenantContext` deliberately carries no permissions — it is an
 *   isolation boundary, not an authorization one.
 *
 * ⚠️ `route` IS THE MATCHED PATTERN AND NEVER `req.originalUrl`. A URL carries
 *   its query string into `data_access_logs`, which is the one table that never
 *   takes free text.
 */
async function pharmacyOptions(req: Request, route: string): Promise<PharmacyActionOptions> {
  const ctx = tenantContextFrom(req);
  const access = await loadUserAccess(ctx.userId, ctx.organizationId);
  const roleCodes = access
    ? permissionsFor(access, ctx.userId, req.auth?.branchId ?? null, false)
    : [];

  return {
    route,
    roleCodes,
    actingBranchId: req.auth?.branchId ?? null,
    ...(req.ip !== undefined ? { ipAddress: req.ip } : {}),
    ...(req.get('user-agent') !== undefined ? { userAgent: req.get('user-agent') as string } : {}),
  };
}

// ---------------------------------------------------------------------------
// The queue  ->  /v1/pharmacy/queue, /v1/pharmacy/prescriptions/:encounterId
// ---------------------------------------------------------------------------

router.get(
  '/queue',
  authorize(DISPENSE_READ),
  validate(prescriptionQueueQuery, 'query'),
  async (req: Request, res: Response): Promise<void> => {
    const query = req.query as unknown as PrescriptionQueueQuery;
    const options = await pharmacyOptions(req, 'GET /v1/pharmacy/queue');
    sendSuccess(res, await listPrescriptionQueue(tenantContextFrom(req), query, options));
  }
);

router.get(
  '/prescriptions/:encounterId',
  authorize(DISPENSE_READ),
  validate(encounterParams, 'params'),
  async (req: Request, res: Response): Promise<void> => {
    const { encounterId } = req.params as z.infer<typeof encounterParams>;
    const options = await pharmacyOptions(req, 'GET /v1/pharmacy/prescriptions/:encounterId');
    sendSuccess(res, await getPharmacyPrescription(tenantContextFrom(req), encounterId, options));
  }
);

router.post(
  '/prescriptions/:encounterId/verify',
  authorize(DISPENSE_VERIFY),
  validate(encounterParams, 'params'),
  validate(verifyPrescriptionRequest),
  async (req: Request, res: Response): Promise<void> => {
    const { encounterId } = req.params as z.infer<typeof encounterParams>;
    const body = req.body as VerifyPrescriptionRequest;
    const options = await pharmacyOptions(
      req,
      'POST /v1/pharmacy/prescriptions/:encounterId/verify'
    );
    sendSuccess(
      res,
      await verifyPrescription(tenantContextFrom(req), encounterId, body, options),
      'Prescription verified'
    );
  }
);

/**
 * ⚠️ THIS STANDS THE DISPENSARY DOWN AND DOES NOT WITHDRAW THE PRESCRIPTION.
 *   Withdrawing one is the prescriber's act, in the clinical record, and pharmacy
 *   has no route to it here or anywhere else.
 */
router.post(
  '/prescriptions/:encounterId/cancel',
  authorize(DISPENSE_VERIFY),
  validate(encounterParams, 'params'),
  validate(cancelPrescriptionFulfilmentRequest),
  async (req: Request, res: Response): Promise<void> => {
    const { encounterId } = req.params as z.infer<typeof encounterParams>;
    const body = req.body as CancelPrescriptionFulfilmentRequest;
    const options = await pharmacyOptions(
      req,
      'POST /v1/pharmacy/prescriptions/:encounterId/cancel'
    );
    sendSuccess(
      res,
      await cancelPrescriptionFulfilment(tenantContextFrom(req), encounterId, body, options),
      'Prescription stood down'
    );
  }
);

// ---------------------------------------------------------------------------
// Substitution  ->  /v1/pharmacy/substitutions/:productId
// ---------------------------------------------------------------------------

/**
 * ⚠️ GATED ON THE READ CODE, BECAUSE IT AUTHORISES NOTHING. It answers "what is
 *   equivalent and what would the rules say" — the supply asks the engine again,
 *   at the moment of supplying, and never trusts a decision a client sends back.
 */
router.get(
  '/substitutions/:productId',
  authorize(DISPENSE_READ),
  validate(productParams, 'params'),
  validate(substitutionQuery, 'query'),
  async (req: Request, res: Response): Promise<void> => {
    const { productId } = req.params as z.infer<typeof productParams>;
    const query = req.query as unknown as SubstitutionQuery;
    const options = await pharmacyOptions(req, 'GET /v1/pharmacy/substitutions/:productId');
    sendSuccess(
      res,
      await listSubstitutionCandidates(tenantContextFrom(req), productId, query, options)
    );
  }
);

// ---------------------------------------------------------------------------
// Dispensing  ->  /v1/pharmacy/dispenses
// ---------------------------------------------------------------------------

router.get(
  '/dispenses',
  authorize(DISPENSE_READ),
  validate(dispenseQuery, 'query'),
  async (req: Request, res: Response): Promise<void> => {
    const query = req.query as unknown as DispenseQuery;
    const options = await pharmacyOptions(req, 'GET /v1/pharmacy/dispenses');
    sendSuccess(res, await listDispenses(tenantContextFrom(req), query, options));
  }
);

router.get(
  '/dispenses/:dispenseId',
  authorize(DISPENSE_READ),
  validate(dispenseParams, 'params'),
  async (req: Request, res: Response): Promise<void> => {
    const { dispenseId } = req.params as z.infer<typeof dispenseParams>;
    const options = await pharmacyOptions(req, 'GET /v1/pharmacy/dispenses/:dispenseId');
    sendSuccess(res, await getDispense(tenantContextFrom(req), dispenseId, options));
  }
);

/**
 * The supply. One transaction, no draft, and a 422 if the law refuses it.
 *
 * ⚠️ A COUNTER SALE COMES THROUGH THE SAME ENDPOINT WITH `kind: COUNTER_SALE`,
 *   rather than through a `/sales` route of its own. API_ARCHITECTURE.md sketched
 *   two; they are the same act — stock leaves a counter, the law is consulted,
 *   the ledger moves — differing only in whether a prescription was presented,
 *   which is a FACT ABOUT THE SUPPLY and is exactly what `kind` records. Two
 *   endpoints would be two code paths to keep in step, and the one that got less
 *   traffic would be the one that quietly stopped asking the engine.
 */
router.post(
  '/dispenses',
  authorize(DISPENSE_CREATE),
  validate(createDispenseRequest),
  async (req: Request, res: Response): Promise<void> => {
    const body = req.body as CreateDispenseRequest;
    const options = await pharmacyOptions(req, 'POST /v1/pharmacy/dispenses');
    const created = await createDispense(tenantContextFrom(req), body, options);
    sendSuccess(res, created, 'Dispensed', 201);
  }
);

router.post(
  '/dispenses/:dispenseId/return',
  authorize(DISPENSE_RETURN),
  validate(dispenseParams, 'params'),
  validate(createDispenseReturnRequest),
  async (req: Request, res: Response): Promise<void> => {
    const { dispenseId } = req.params as z.infer<typeof dispenseParams>;
    const body = req.body as CreateDispenseReturnRequest;
    const options = await pharmacyOptions(req, 'POST /v1/pharmacy/dispenses/:dispenseId/return');
    const created = await createDispenseReturn(tenantContextFrom(req), dispenseId, body, options);
    sendSuccess(res, created, 'Return recorded', 201);
  }
);

// ---------------------------------------------------------------------------
// The dashboard  ->  /v1/pharmacy/dashboard
// ---------------------------------------------------------------------------

router.get(
  '/dashboard',
  authorize(DISPENSE_READ),
  validate(pharmacyDashboardQuery, 'query'),
  async (req: Request, res: Response): Promise<void> => {
    const query = req.query as unknown as PharmacyDashboardQuery;
    const options = await pharmacyOptions(req, 'GET /v1/pharmacy/dashboard');
    sendSuccess(res, await getPharmacyDashboard(tenantContextFrom(req), query, options));
  }
);

export default router;
