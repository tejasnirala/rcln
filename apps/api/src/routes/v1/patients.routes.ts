import { Router, type IRouter, type Request, type Response } from 'express';
import { z } from 'zod';
import {
  createPatientRequest,
  patientAddressRequest,
  patientAllergyRequest,
  patientConditionRequest,
  patientContactRequest,
  patientMedicationRequest,
  registerPatientAtBranchRequest,
  searchPatientQuery,
  updatePatientRequest,
  type CreatePatientRequest,
  type PatientAddressRequest,
  type PatientAllergyRequest,
  type PatientConditionRequest,
  type PatientContactRequest,
  type PatientMedicationRequest,
  type RegisterPatientAtBranchRequest,
  type SearchPatientQuery,
  type UpdatePatientRequest,
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
  addAddress,
  addContact,
  createPatient,
  deletePatient,
  findDuplicates,
  getPatient,
  registerAtBranch,
  removeAddress,
  removeContact,
  searchPatients,
  updatePatient,
  type PatientActionOptions,
} from '../../services/patient/patient.service.js';
import {
  addAllergy,
  addCondition,
  addMedication,
  getHistory,
  removeAllergy,
  removeCondition,
  removeMedication,
  stopMedication,
  updateCondition,
} from '../../services/patient/patient-history.service.js';
import { sendSuccess } from '../../utils/response.js';

/**
 * Patients — the first PHI surface in the product.
 *
 * The standard chain, and the order is the security model:
 *
 *   requireTenant -> authenticate -> requireAuth -> authorize -> validate -> handler
 *
 * ⚠️ TWO PERMISSIONS, NOT ONE, AND THE SPLIT IS THE WHOLE DESIGN.
 *   `patient.read` is held by the receptionist, the accountant and the
 *   pharmacist — everyone who has to identify the right human being at a
 *   counter. `patient.medical_history.read` is held by the doctor and the
 *   nurse. Everything under `/:patientId/history` sits behind the second one,
 *   which is why it is a separate endpoint rather than a richer detail
 *   response: fused, either the front desk reads the problem list or nobody
 *   does.
 *
 * ⚠️ `meta()` PASSES THE ROUTE **PATTERN**, NEVER `req.originalUrl`.
 *   The URL of a search carries the search term with it, and that term is
 *   somebody's surname. `data_access_logs.route` is built to be read by
 *   compliance staff who have no business reading patient records; a name
 *   landing there is a disclosure, not a log line.
 */

const router: IRouter = Router();

router.use(requireTenant, authenticate, requireAuth);

const patientParams = z.object({ patientId: z.uuid() });
const addressParams = patientParams.extend({ addressId: z.uuid() });
const contactParams = patientParams.extend({ contactId: z.uuid() });
const allergyParams = patientParams.extend({ allergyId: z.uuid() });
const conditionParams = patientParams.extend({ conditionId: z.uuid() });
const medicationParams = patientParams.extend({ medicationId: z.uuid() });

/** The duplicate probe. A GET would put a phone number in the access log. */
const duplicateProbeRequest = z.object({
  phone: z.string().max(20).optional(),
  firstName: z.string().max(100).optional(),
  dateOfBirth: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  abhaNumber: z.string().max(32).optional(),
  nationalId: z.string().max(64).optional(),
});

const stopMedicationRequest = z.object({
  stoppedOn: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
});

/**
 * Request metadata for both trails.
 *
 * `route` is `req.route?.path` composed with the mount point — the PATTERN, so
 * `/v1/patients/:patientId`, never the resolved URL. See the header.
 */
const meta = (req: Request, pattern: string): PatientActionOptions => ({
  ...(req.ip !== undefined ? { ipAddress: req.ip } : {}),
  ...(req.get('user-agent') !== undefined ? { userAgent: req.get('user-agent') as string } : {}),
  route: `${req.method} /v1/patients${pattern}`,
});

// --- search and registration -----------------------------------------------

/**
 * The front-desk search.
 *
 * `scope=ORGANIZATION` widens past the caller's own branches, which is
 * legitimate and deliberate — it is how a duplicate is found before a second
 * record is created (ADR-0016). It stays behind plain `patient.read` rather
 * than a permission of its own, because the control on a widened search is the
 * `data_access_logs` row it writes, not a gate: a gate would push the front
 * desk into creating the duplicate instead.
 */
router.get(
  '/',
  authorize(PERMISSIONS.PATIENT_READ),
  validate(searchPatientQuery, 'query'),
  async (req: Request, res: Response): Promise<void> => {
    const result = await searchPatients(
      tenantContextFrom(req),
      req.query as unknown as SearchPatientQuery,
      meta(req, '/')
    );
    sendSuccess(res, result);
  }
);

/**
 * "Is this person already here?" — asked before a registration is committed.
 *
 * ⚠️ A POST, NOT A GET, DESPITE READING NOTHING.
 *   The probe carries a phone number, a date of birth and possibly an ABHA
 *   number. As query parameters those land in the access log of every proxy in
 *   front of this service, in the browser's history, and in the referrer header
 *   of the next request. A body carries them in none of those places.
 */
router.post(
  '/duplicate-check',
  authorize(PERMISSIONS.PATIENT_CREATE),
  validate(duplicateProbeRequest, 'body'),
  async (req: Request, res: Response): Promise<void> => {
    const matches = await findDuplicates(
      tenantContextFrom(req),
      req.body as z.infer<typeof duplicateProbeRequest>
    );
    sendSuccess(res, { matches });
  }
);

router.post(
  '/',
  authorize(PERMISSIONS.PATIENT_CREATE),
  validate(createPatientRequest, 'body'),
  async (req: Request, res: Response): Promise<void> => {
    const patient = await createPatient(
      tenantContextFrom(req),
      req.body as CreatePatientRequest,
      meta(req, '/')
    );
    sendSuccess(res, patient, 'Patient registered', 201);
  }
);

// --- one patient -----------------------------------------------------------

router.get(
  '/:patientId',
  authorize(PERMISSIONS.PATIENT_READ),
  validate(patientParams, 'params'),
  async (req: Request, res: Response): Promise<void> => {
    const { patientId } = req.params as z.infer<typeof patientParams>;
    const patient = await getPatient(tenantContextFrom(req), patientId, meta(req, '/:patientId'));
    sendSuccess(res, patient);
  }
);

router.patch(
  '/:patientId',
  authorize(PERMISSIONS.PATIENT_UPDATE),
  validate(patientParams, 'params'),
  validate(updatePatientRequest, 'body'),
  async (req: Request, res: Response): Promise<void> => {
    const { patientId } = req.params as z.infer<typeof patientParams>;
    const patient = await updatePatient(
      tenantContextFrom(req),
      patientId,
      req.body as UpdatePatientRequest,
      meta(req, '/:patientId')
    );
    sendSuccess(res, patient, 'Patient updated');
  }
);

/**
 * Erasure. `patient.delete` is withheld from ORG_ADMIN and sits with the owner,
 * alongside `doctor.archive`.
 *
 * This is NOT how a death is recorded — that is `status = DECEASED`, which
 * leaves the record readable, billable and auditable.
 */
router.delete(
  '/:patientId',
  authorize(PERMISSIONS.PATIENT_DELETE),
  validate(patientParams, 'params'),
  async (req: Request, res: Response): Promise<void> => {
    const { patientId } = req.params as z.infer<typeof patientParams>;
    await deletePatient(tenantContextFrom(req), patientId, meta(req, '/:patientId'));
    sendSuccess(res, null, 'Patient record removed');
  }
);

/** Register an existing patient at a second clinic. One record, a second MRN. */
router.post(
  '/:patientId/registrations',
  authorize(PERMISSIONS.PATIENT_CREATE),
  validate(patientParams, 'params'),
  validate(registerPatientAtBranchRequest, 'body'),
  async (req: Request, res: Response): Promise<void> => {
    const { patientId } = req.params as z.infer<typeof patientParams>;
    const patient = await registerAtBranch(
      tenantContextFrom(req),
      patientId,
      req.body as RegisterPatientAtBranchRequest,
      meta(req, '/:patientId/registrations')
    );
    sendSuccess(res, patient, 'Registered at clinic', 201);
  }
);

// --- address and next of kin -----------------------------------------------

router.post(
  '/:patientId/addresses',
  authorize(PERMISSIONS.PATIENT_UPDATE),
  validate(patientParams, 'params'),
  validate(patientAddressRequest, 'body'),
  async (req: Request, res: Response): Promise<void> => {
    const { patientId } = req.params as z.infer<typeof patientParams>;
    const patient = await addAddress(
      tenantContextFrom(req),
      patientId,
      req.body as PatientAddressRequest,
      meta(req, '/:patientId/addresses')
    );
    sendSuccess(res, patient, 'Address added', 201);
  }
);

router.delete(
  '/:patientId/addresses/:addressId',
  authorize(PERMISSIONS.PATIENT_UPDATE),
  validate(addressParams, 'params'),
  async (req: Request, res: Response): Promise<void> => {
    const { patientId, addressId } = req.params as z.infer<typeof addressParams>;
    await removeAddress(
      tenantContextFrom(req),
      patientId,
      addressId,
      meta(req, '/:patientId/addresses/:addressId')
    );
    sendSuccess(res, null, 'Address removed');
  }
);

router.post(
  '/:patientId/contacts',
  authorize(PERMISSIONS.PATIENT_UPDATE),
  validate(patientParams, 'params'),
  validate(patientContactRequest, 'body'),
  async (req: Request, res: Response): Promise<void> => {
    const { patientId } = req.params as z.infer<typeof patientParams>;
    const patient = await addContact(
      tenantContextFrom(req),
      patientId,
      req.body as PatientContactRequest,
      meta(req, '/:patientId/contacts')
    );
    sendSuccess(res, patient, 'Contact added', 201);
  }
);

router.delete(
  '/:patientId/contacts/:contactId',
  authorize(PERMISSIONS.PATIENT_UPDATE),
  validate(contactParams, 'params'),
  async (req: Request, res: Response): Promise<void> => {
    const { patientId, contactId } = req.params as z.infer<typeof contactParams>;
    await removeContact(
      tenantContextFrom(req),
      patientId,
      contactId,
      meta(req, '/:patientId/contacts/:contactId')
    );
    sendSuccess(res, null, 'Contact removed');
  }
);

// --- medical history -------------------------------------------------------
//
// Everything below is behind PATIENT_MEDICAL_HISTORY_READ / _WRITE. The
// receptionist holds neither.

router.get(
  '/:patientId/history',
  authorize(PERMISSIONS.PATIENT_MEDICAL_HISTORY_READ),
  validate(patientParams, 'params'),
  async (req: Request, res: Response): Promise<void> => {
    const { patientId } = req.params as z.infer<typeof patientParams>;
    const history = await getHistory(
      tenantContextFrom(req),
      patientId,
      meta(req, '/:patientId/history')
    );
    sendSuccess(res, history);
  }
);

router.post(
  '/:patientId/allergies',
  authorize(PERMISSIONS.PATIENT_MEDICAL_HISTORY_WRITE),
  validate(patientParams, 'params'),
  validate(patientAllergyRequest, 'body'),
  async (req: Request, res: Response): Promise<void> => {
    const { patientId } = req.params as z.infer<typeof patientParams>;
    await addAllergy(
      tenantContextFrom(req),
      patientId,
      req.body as PatientAllergyRequest,
      meta(req, '/:patientId/allergies')
    );
    sendSuccess(res, null, 'Allergy recorded', 201);
  }
);

router.delete(
  '/:patientId/allergies/:allergyId',
  authorize(PERMISSIONS.PATIENT_MEDICAL_HISTORY_WRITE),
  validate(allergyParams, 'params'),
  async (req: Request, res: Response): Promise<void> => {
    const { patientId, allergyId } = req.params as z.infer<typeof allergyParams>;
    await removeAllergy(
      tenantContextFrom(req),
      patientId,
      allergyId,
      meta(req, '/:patientId/allergies/:allergyId')
    );
    sendSuccess(res, null, 'Allergy withdrawn');
  }
);

router.post(
  '/:patientId/conditions',
  authorize(PERMISSIONS.PATIENT_MEDICAL_HISTORY_WRITE),
  validate(patientParams, 'params'),
  validate(patientConditionRequest, 'body'),
  async (req: Request, res: Response): Promise<void> => {
    const { patientId } = req.params as z.infer<typeof patientParams>;
    await addCondition(
      tenantContextFrom(req),
      patientId,
      req.body as PatientConditionRequest,
      meta(req, '/:patientId/conditions')
    );
    sendSuccess(res, null, 'Condition recorded', 201);
  }
);

router.put(
  '/:patientId/conditions/:conditionId',
  authorize(PERMISSIONS.PATIENT_MEDICAL_HISTORY_WRITE),
  validate(conditionParams, 'params'),
  validate(patientConditionRequest, 'body'),
  async (req: Request, res: Response): Promise<void> => {
    const { patientId, conditionId } = req.params as z.infer<typeof conditionParams>;
    await updateCondition(
      tenantContextFrom(req),
      patientId,
      conditionId,
      req.body as PatientConditionRequest,
      meta(req, '/:patientId/conditions/:conditionId')
    );
    sendSuccess(res, null, 'Condition updated');
  }
);

router.delete(
  '/:patientId/conditions/:conditionId',
  authorize(PERMISSIONS.PATIENT_MEDICAL_HISTORY_WRITE),
  validate(conditionParams, 'params'),
  async (req: Request, res: Response): Promise<void> => {
    const { patientId, conditionId } = req.params as z.infer<typeof conditionParams>;
    await removeCondition(
      tenantContextFrom(req),
      patientId,
      conditionId,
      meta(req, '/:patientId/conditions/:conditionId')
    );
    sendSuccess(res, null, 'Condition withdrawn');
  }
);

router.post(
  '/:patientId/medications',
  authorize(PERMISSIONS.PATIENT_MEDICAL_HISTORY_WRITE),
  validate(patientParams, 'params'),
  validate(patientMedicationRequest, 'body'),
  async (req: Request, res: Response): Promise<void> => {
    const { patientId } = req.params as z.infer<typeof patientParams>;
    await addMedication(
      tenantContextFrom(req),
      patientId,
      req.body as PatientMedicationRequest,
      meta(req, '/:patientId/medications')
    );
    sendSuccess(res, null, 'Medicine recorded', 201);
  }
);

/**
 * Stop a medicine. Its own call rather than a PATCH, because `isOngoing` and
 * `stoppedOn` must move together — the CHECK constraint refuses them apart, and
 * a partial update cannot promise that.
 */
router.post(
  '/:patientId/medications/:medicationId/stop',
  authorize(PERMISSIONS.PATIENT_MEDICAL_HISTORY_WRITE),
  validate(medicationParams, 'params'),
  validate(stopMedicationRequest, 'body'),
  async (req: Request, res: Response): Promise<void> => {
    const { patientId, medicationId } = req.params as z.infer<typeof medicationParams>;
    const { stoppedOn } = req.body as z.infer<typeof stopMedicationRequest>;
    await stopMedication(
      tenantContextFrom(req),
      patientId,
      medicationId,
      stoppedOn,
      meta(req, '/:patientId/medications/:medicationId/stop')
    );
    sendSuccess(res, null, 'Medicine stopped');
  }
);

router.delete(
  '/:patientId/medications/:medicationId',
  authorize(PERMISSIONS.PATIENT_MEDICAL_HISTORY_WRITE),
  validate(medicationParams, 'params'),
  async (req: Request, res: Response): Promise<void> => {
    const { patientId, medicationId } = req.params as z.infer<typeof medicationParams>;
    await removeMedication(
      tenantContextFrom(req),
      patientId,
      medicationId,
      meta(req, '/:patientId/medications/:medicationId')
    );
    sendSuccess(res, null, 'Medicine removed');
  }
);

export default router;
