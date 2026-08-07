import { Router, type IRouter, type Request, type Response } from 'express';
import { z } from 'zod';
import {
  createDoctorRequest,
  decideScheduleExceptionRequest,
  doctorBranchSettingRequest,
  doctorQualificationRequest,
  doctorScheduleExceptionRequest,
  doctorScheduleRequest,
  updateDoctorRequest,
  type CreateDoctorRequest,
  type DecideScheduleExceptionRequest,
  type DoctorBranchSettingRequest,
  type DoctorQualificationRequest,
  type DoctorScheduleExceptionRequest,
  type DoctorScheduleRequest,
  type UpdateDoctorRequest,
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
  addQualification,
  archiveDoctor,
  createDoctor,
  listDoctors,
  listMasters,
  removeQualification,
  setBranchSetting,
  updateDoctor,
} from '../../services/doctor/doctor.service.js';
import {
  addSchedule,
  decideException,
  listExceptions,
  listSchedules,
  removeSchedule,
  requestException,
} from '../../services/doctor/doctor-schedule.service.js';
import { sendSuccess } from '../../utils/response.js';

/**
 * Doctors: profiles, specialties, qualifications, per-branch fees, and the
 * working hours the availability engine reads.
 *
 * The standard chain, and the order is the security model:
 *
 *   requireTenant -> authenticate -> requireAuth -> authorize -> validate -> handler
 *
 * TWO PERMISSION SPLITS ARE LOAD-BEARING HERE, and both look like duplication
 * until you see what fusing them would allow:
 *
 *   `doctor.schedule.request` vs `doctor.schedule.approve` — a doctor asks for
 *   leave, someone else grants it. Fused, a doctor approves their own leave and
 *   the availability engine silently loses those days.
 *
 *   `appointment.availability.read` vs `doctor.schedule.read` — a patient on the
 *   portal must see which slots are free without reading the configuration
 *   behind them: per-block caps, validity windows, and the reason recorded
 *   against a day of leave.
 *
 * Editing your OWN profile is deliberately not a permission code — see the note
 * on the PATCH handler.
 */

const router: IRouter = Router();

router.use(requireTenant, authenticate, requireAuth);

const doctorParams = z.object({ doctorId: z.uuid() });
const scheduleParams = doctorParams.extend({ scheduleId: z.uuid() });
const exceptionParams = doctorParams.extend({ exceptionId: z.uuid() });
const qualificationParams = doctorParams.extend({ rowId: z.uuid() });

const auditMeta = (req: Request): { ipAddress?: string; userAgent?: string } => ({
  ...(req.ip !== undefined ? { ipAddress: req.ip } : {}),
  ...(req.get('user-agent') !== undefined ? { userAgent: req.get('user-agent') as string } : {}),
});

// --- masters ---------------------------------------------------------------

/**
 * The specialty and qualification catalogues.
 *
 * Behind DOCTOR_READ rather than DOCTOR_MASTER_MANAGE: every screen that shows
 * a doctor needs to render their specialty name, and gating that behind the
 * permission to EDIT the catalogue would mean a receptionist sees a blank.
 */
router.get(
  '/masters',
  authorize(PERMISSIONS.DOCTOR_READ),
  async (req: Request, res: Response): Promise<void> => {
    sendSuccess(res, await listMasters(tenantContextFrom(req)));
  }
);

// --- profiles --------------------------------------------------------------

router.get(
  '/',
  authorize(PERMISSIONS.DOCTOR_READ),
  async (req: Request, res: Response): Promise<void> => {
    sendSuccess(res, { doctors: await listDoctors(tenantContextFrom(req)) });
  }
);

router.post(
  '/',
  authorize(PERMISSIONS.DOCTOR_CREATE),
  validate(createDoctorRequest, 'body'),
  async (req: Request, res: Response): Promise<void> => {
    const doctor = await createDoctor(
      tenantContextFrom(req),
      req.body as CreateDoctorRequest,
      auditMeta(req)
    );
    sendSuccess(res, doctor, 'Doctor added', 201);
  }
);

/**
 * ⚠️ A doctor editing their OWN profile is scoping, not a permission.
 *
 * The service compares `profile.userId` against `ctx.userId`. There is no
 * `doctor.self.update` code because the permission resolver grants a code
 * across a branch scope — it cannot express "this one row" — so a self-edit
 * code would in practice be a code to edit every colleague's profile.
 */
router.patch(
  '/:doctorId',
  authorize(PERMISSIONS.DOCTOR_UPDATE),
  validate(doctorParams, 'params'),
  validate(updateDoctorRequest, 'body'),
  async (req: Request, res: Response): Promise<void> => {
    const { doctorId } = req.params as z.infer<typeof doctorParams>;
    const doctor = await updateDoctor(
      tenantContextFrom(req),
      doctorId,
      req.body as UpdateDoctorRequest,
      auditMeta(req)
    );
    sendSuccess(res, doctor, 'Doctor updated');
  }
);

/**
 * Retire a doctor. Soft delete — prescriptions and appointments point at this
 * row and must keep resolving after the person has left.
 *
 * DOCTOR_ARCHIVE is withheld from ORG_ADMIN, alongside PATIENT_DELETE.
 */
router.delete(
  '/:doctorId',
  authorize(PERMISSIONS.DOCTOR_ARCHIVE),
  validate(doctorParams, 'params'),
  async (req: Request, res: Response): Promise<void> => {
    const { doctorId } = req.params as z.infer<typeof doctorParams>;
    await archiveDoctor(tenantContextFrom(req), doctorId, auditMeta(req));
    sendSuccess(res, null, 'Doctor retired');
  }
);

// --- qualifications --------------------------------------------------------

router.post(
  '/:doctorId/qualifications',
  authorize(PERMISSIONS.DOCTOR_UPDATE),
  validate(doctorParams, 'params'),
  validate(doctorQualificationRequest, 'body'),
  async (req: Request, res: Response): Promise<void> => {
    const { doctorId } = req.params as z.infer<typeof doctorParams>;
    await addQualification(
      tenantContextFrom(req),
      doctorId,
      req.body as DoctorQualificationRequest,
      auditMeta(req)
    );
    sendSuccess(res, null, 'Qualification added', 201);
  }
);

router.delete(
  '/:doctorId/qualifications/:rowId',
  authorize(PERMISSIONS.DOCTOR_UPDATE),
  validate(qualificationParams, 'params'),
  async (req: Request, res: Response): Promise<void> => {
    const { doctorId, rowId } = req.params as z.infer<typeof qualificationParams>;
    await removeQualification(tenantContextFrom(req), doctorId, rowId, auditMeta(req));
    sendSuccess(res, null, 'Qualification removed');
  }
);

// --- per-branch fees -------------------------------------------------------

router.put(
  '/:doctorId/branch-settings',
  authorize(PERMISSIONS.DOCTOR_UPDATE),
  validate(doctorParams, 'params'),
  validate(doctorBranchSettingRequest, 'body'),
  async (req: Request, res: Response): Promise<void> => {
    const { doctorId } = req.params as z.infer<typeof doctorParams>;
    await setBranchSetting(
      tenantContextFrom(req),
      doctorId,
      req.body as DoctorBranchSettingRequest,
      auditMeta(req)
    );
    sendSuccess(res, null, 'Branch settings saved');
  }
);

// --- working hours ---------------------------------------------------------

router.get(
  '/:doctorId/schedules',
  authorize(PERMISSIONS.DOCTOR_SCHEDULE_READ),
  validate(doctorParams, 'params'),
  async (req: Request, res: Response): Promise<void> => {
    const { doctorId } = req.params as z.infer<typeof doctorParams>;
    sendSuccess(res, { schedules: await listSchedules(tenantContextFrom(req), doctorId) });
  }
);

router.post(
  '/:doctorId/schedules',
  authorize(PERMISSIONS.DOCTOR_SCHEDULE_MANAGE),
  validate(doctorParams, 'params'),
  validate(doctorScheduleRequest, 'body'),
  async (req: Request, res: Response): Promise<void> => {
    const { doctorId } = req.params as z.infer<typeof doctorParams>;
    await addSchedule(
      tenantContextFrom(req),
      doctorId,
      req.body as DoctorScheduleRequest,
      auditMeta(req)
    );
    sendSuccess(res, null, 'Working hours added', 201);
  }
);

router.delete(
  '/:doctorId/schedules/:scheduleId',
  authorize(PERMISSIONS.DOCTOR_SCHEDULE_MANAGE),
  validate(scheduleParams, 'params'),
  async (req: Request, res: Response): Promise<void> => {
    const { doctorId, scheduleId } = req.params as z.infer<typeof scheduleParams>;
    await removeSchedule(tenantContextFrom(req), doctorId, scheduleId, auditMeta(req));
    sendSuccess(res, null, 'Working hours removed');
  }
);

// --- leave and one-off changes ---------------------------------------------

router.get(
  '/:doctorId/exceptions',
  authorize(PERMISSIONS.DOCTOR_SCHEDULE_READ),
  validate(doctorParams, 'params'),
  async (req: Request, res: Response): Promise<void> => {
    const { doctorId } = req.params as z.infer<typeof doctorParams>;
    sendSuccess(res, { exceptions: await listExceptions(tenantContextFrom(req), doctorId) });
  }
);

/**
 * Raise a request. DOCTOR_SCHEDULE_REQUEST is the doctor's own claim — it lands
 * as REQUESTED and changes no availability until someone with APPROVE acts.
 */
router.post(
  '/:doctorId/exceptions',
  authorize(PERMISSIONS.DOCTOR_SCHEDULE_REQUEST),
  validate(doctorParams, 'params'),
  validate(doctorScheduleExceptionRequest, 'body'),
  async (req: Request, res: Response): Promise<void> => {
    const { doctorId } = req.params as z.infer<typeof doctorParams>;
    const exception = await requestException(
      tenantContextFrom(req),
      doctorId,
      req.body as DoctorScheduleExceptionRequest,
      auditMeta(req)
    );
    sendSuccess(res, exception, 'Request submitted', 201);
  }
);

/** The decision. Only an APPROVED row changes what the clinic can book. */
router.post(
  '/:doctorId/exceptions/:exceptionId/decision',
  authorize(PERMISSIONS.DOCTOR_SCHEDULE_APPROVE),
  validate(exceptionParams, 'params'),
  validate(decideScheduleExceptionRequest, 'body'),
  async (req: Request, res: Response): Promise<void> => {
    const { doctorId, exceptionId } = req.params as z.infer<typeof exceptionParams>;
    const exception = await decideException(
      tenantContextFrom(req),
      doctorId,
      exceptionId,
      req.body as DecideScheduleExceptionRequest,
      auditMeta(req)
    );
    sendSuccess(res, exception, 'Decision recorded');
  }
);

export default router;
