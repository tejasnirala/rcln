import { Router, type IRouter, type Request, type Response } from 'express';
import { z } from 'zod';
import {
  createDoctorRequest,
  doctorListQuery,
  decideScheduleExceptionRequest,
  doctorBranchSettingRequest,
  doctorQualificationRequest,
  doctorScheduleExceptionRequest,
  doctorScheduleRequest,
  feeScheduleQuery,
  referralTargetQuery,
  setDoctorCompensationRequest,
  setFeeScheduleRequest,
  updateDoctorQualificationRequest,
  updateDoctorRequest,
  type CreateDoctorRequest,
  type FeeScheduleQuery,
  type SetDoctorCompensationRequest,
  type SetFeeScheduleRequest,
  type DoctorListQuery,
  type DecideScheduleExceptionRequest,
  type DoctorBranchSettingRequest,
  type DoctorQualificationRequest,
  type DoctorScheduleExceptionRequest,
  type DoctorScheduleRequest,
  type ReferralTargetQuery,
  type UpdateDoctorQualificationRequest,
  type UpdateDoctorRequest,
} from '@rcln/contracts';
import { PERMISSIONS, type PermissionCode } from '@rcln/permissions';
import {
  authenticate,
  authorize,
  callerHasPermission,
  requireAuth,
  tenantContextFrom,
} from '../../middleware/auth.middleware.js';
import { requireTenant } from '../../middleware/tenant.middleware.js';
import { validate } from '../../middleware/validate.middleware.js';
import {
  addQualification,
  archiveDoctor,
  createDoctor,
  getDoctor,
  getOwnDoctor,
  listDoctors,
  listMasters,
  removeQualification,
  searchReferralTargets,
  setBranchSetting,
  updateDoctor,
  updateQualification,
} from '../../services/doctor/doctor.service.js';
import {
  addSchedule,
  decideException,
  listExceptions,
  listSchedules,
  removeSchedule,
  requestException,
} from '../../services/doctor/doctor-schedule.service.js';
import {
  getDoctorCompensation,
  setDoctorCompensation,
} from '../../services/doctor/doctor-compensation.service.js';
import { getFeeSchedule, setFeeSchedule } from '../../services/fees/fee-schedule.service.js';
import { AuthorizationError } from '../../utils/errors.js';
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

/**
 * `?specialtyId=` filters by CLASSIFICATION SUBTREE, not by an exact node — a
 * doctor tagged only "Structural Heart Disease" is returned for a Cardiology
 * filter. `?includeDescendants=false` narrows it to the exact node.
 */
/**
 * ⚠️ `doctor.directory.read`, NOT `doctor.read`, AND THE DIFFERENCE IS THE
 *   DOCTORS TAB. Reading *a* profile and enumerating *all* of them are different
 *   acts: the front desk books against the roster and needs it; a doctor needs
 *   their own profile, which `GET /doctors/me` serves. A doctor calling this
 *   gets a 403, which is why their navigation does not offer it.
 *
 *   This is also what keeps the day board honest — the same code decides whether
 *   `GET /appointments` may read across practitioners. One rule, two places that
 *   ask it, and neither of them asks what role the caller holds (ADR-0002).
 */
router.get(
  '/',
  authorize(PERMISSIONS.DOCTOR_DIRECTORY_READ),
  validate(doctorListQuery, 'query'),
  async (req: Request, res: Response): Promise<void> => {
    const query = req.query as unknown as DoctorListQuery;
    /*
     * ⚠️ THE WEEK RIDES ON `doctor.schedule.read`, NOT ON REACHING THIS ROUTE.
     *   The roster carries each doctor's working hours so the screen does not
     *   have to fetch them one at a time — but block caps, validity windows and
     *   inherited slot lengths are configuration, and the split above exists
     *   precisely so the portal can read free slots without them. A caller
     *   without the code gets no `schedules` key at all, rather than an empty
     *   one that would assert the doctor works nowhere.
     */
    sendSuccess(res, {
      doctors: await listDoctors(
        tenantContextFrom(req),
        query,
        await callerHasPermission(req, PERMISSIONS.DOCTOR_SCHEDULE_READ)
      ),
    });
  }
);

/**
 * Colleagues this patient can be referred to (CE-5, §37).
 *
 * ⚠️ MUST STAY ABOVE `/:doctorId`, for the reason `/me` below records: Express
 *   matches in declaration order, and underneath it `referral-targets` is parsed
 *   as a doctor id and fails uuid validation.
 *
 * ⚠️ `clinical.encounter.create`, NOT `doctor.directory.read`, AND THAT IS THE
 *   WHOLE POINT OF THIS ROUTE EXISTING SEPARATELY FROM `GET /` ABOVE. A DOCTOR
 *   deliberately does not hold the directory code — the roster is a personnel
 *   list. But `encounter_referrals.doctor_profile_id` is a destination the
 *   contract offers and a CHECK accepts, so the person writing the consultation
 *   has to be able to reach it, and only the person writing one can.
 *
 *   What keeps that from re-opening the door the directory code closes is that
 *   this is a LOOKUP, NOT AN ENUMERATION: `search` is required with a two-
 *   character minimum, so there is no form of this call that answers "who works
 *   here". The payload is a name and a specialty — no schedule, no contact, no
 *   registration number, no fees, no employment status. See the service.
 *
 * ⚠️ NOT READ-AUDITED, deliberately. No patient is named or implied by either
 *   half of this exchange; the referral it results in IS audited, on the
 *   encounter, where the patient is.
 */
router.get(
  '/referral-targets',
  authorize(PERMISSIONS.ENCOUNTER_CREATE),
  validate(referralTargetQuery, 'query'),
  async (req: Request, res: Response): Promise<void> => {
    const query = req.query as unknown as ReferralTargetQuery;
    sendSuccess(res, { targets: await searchReferralTargets(tenantContextFrom(req), query) });
  }
);

/**
 * The caller's own profile.
 *
 * ⚠️ MUST STAY ABOVE `/:doctorId` — Express matches in declaration order, and
 *   below it `me` would be parsed as a doctor id and fail uuid validation.
 *
 * DOCTOR_READ, and the row is resolved from `ctx.userId` rather than from the
 * path, so this discloses nothing the caller did not already have.
 */
router.get(
  '/me',
  authorize(PERMISSIONS.DOCTOR_READ),
  async (req: Request, res: Response): Promise<void> => {
    sendSuccess(res, await getOwnDoctor(tenantContextFrom(req)));
  }
);

/**
 * One doctor, in full — the read-only profile screen.
 *
 * DOCTOR_READ reads it; editing needs DOCTOR_UPDATE, which the front desk and
 * the doctors themselves do not hold. The screen renders read-only for exactly
 * that reason rather than by a rule of its own.
 */
router.get(
  '/:doctorId',
  authorize(PERMISSIONS.DOCTOR_READ),
  validate(doctorParams, 'params'),
  async (req: Request, res: Response): Promise<void> => {
    const { doctorId } = req.params as z.infer<typeof doctorParams>;
    sendSuccess(res, await getDoctor(tenantContextFrom(req), doctorId));
  }
);

/**
 * Register a doctor, in one submission and one transaction.
 *
 * ⚠️ EVERY NESTED SECTION IS AUTHORIZED SEPARATELY, AND THIS IS THE ONLY PLACE
 *   IT HAPPENS. `doctor.create` buys the profile and nothing else. The body may
 *   also carry degrees, working hours, prices and a salary, and each of those is
 *   a different act with a different code behind it everywhere else in this
 *   router — so accepting them here on `doctor.create` alone would hand whoever
 *   may add a colleague a second, ungated route to setting that colleague's pay.
 *   That is exactly the fusion `doctor-compensation.service.ts` refuses at the
 *   front door, and a nested body is how it would sneak in through the back.
 *
 * ⚠️ 403 WITH THE SECTION NAMED, NOT A SILENT DROP. Quietly ignoring a salary the
 *   caller may not set means an admin types a figure, sees "Doctor added", and
 *   believes it was recorded. Refusing says which part was refused so the form
 *   can stop offering it.
 */
router.post(
  '/',
  authorize(PERMISSIONS.DOCTOR_CREATE),
  validate(createDoctorRequest, 'body'),
  async (req: Request, res: Response): Promise<void> => {
    const body = req.body as CreateDoctorRequest;

    const gates: { present: boolean; code: PermissionCode; what: string }[] = [
      {
        present: (body.qualifications?.length ?? 0) > 0,
        code: PERMISSIONS.DOCTOR_UPDATE,
        what: 'qualifications',
      },
      {
        present: (body.schedules?.length ?? 0) > 0,
        code: PERMISSIONS.DOCTOR_SCHEDULE_MANAGE,
        what: 'working hours',
      },
      {
        present: (body.fees?.length ?? 0) > 0,
        code: PERMISSIONS.FEE_SCHEDULE_MANAGE,
        what: 'fees',
      },
      {
        present: body.compensation !== undefined,
        code: PERMISSIONS.DOCTOR_COMPENSATION_MANAGE,
        what: 'what the clinic pays',
      },
    ];

    for (const gate of gates) {
      if (gate.present && !(await callerHasPermission(req, gate.code))) {
        throw new AuthorizationError(`You do not have access to set ${gate.what}.`);
      }
    }

    const doctor = await createDoctor(tenantContextFrom(req), body, auditMeta(req));
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

/**
 * Correct one. Same permission as adding — fixing a typo in an institute is the
 * same act as entering it, and splitting them would be a code nobody grants.
 */
router.patch(
  '/:doctorId/qualifications/:rowId',
  authorize(PERMISSIONS.DOCTOR_UPDATE),
  validate(qualificationParams, 'params'),
  validate(updateDoctorQualificationRequest, 'body'),
  async (req: Request, res: Response): Promise<void> => {
    const { doctorId, rowId } = req.params as z.infer<typeof qualificationParams>;
    await updateQualification(
      tenantContextFrom(req),
      doctorId,
      rowId,
      req.body as UpdateDoctorQualificationRequest,
      auditMeta(req)
    );
    sendSuccess(res, null, 'Qualification updated');
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

// --- compensation ----------------------------------------------------------

/**
 * What the clinic has agreed to pay this doctor.
 *
 * ⚠️ AUTHORIZED ON `doctor.read`, NARROWED IN THE SERVICE. Holding DOCTOR_READ
 *   gets you as far as the endpoint; the figure comes back only if you also hold
 *   `doctor.compensation.read` OR the profile is your own. That second half is
 *   an ownership check rather than a code, exactly like editing your own
 *   profile: the permission resolver grants across a branch scope and cannot
 *   express "this one row", so a `doctor.compensation.self.read` code would in
 *   practice be a code to read every colleague's pay.
 *
 * ⚠️ AND IT REFUSES WITH 403, NOT 404 — the one place in this router that does.
 *   The doctor's existence is not the secret; the caller is already looking at
 *   their profile. Only the number is.
 */
router.get(
  '/:doctorId/compensation',
  authorize(PERMISSIONS.DOCTOR_READ),
  validate(doctorParams, 'params'),
  async (req: Request, res: Response): Promise<void> => {
    const { doctorId } = req.params as z.infer<typeof doctorParams>;
    sendSuccess(
      res,
      await getDoctorCompensation(tenantContextFrom(req), doctorId, {
        holdsCode: await callerHasPermission(req, PERMISSIONS.DOCTOR_COMPENSATION_READ),
      })
    );
  }
);

/**
 * Agree the figure, or clear it.
 *
 * `doctor.compensation.manage`, which BRANCH_ADMIN deliberately does not hold
 * and ACCOUNTANT deliberately holds only the read half of. Agreeing a salary is
 * the employment decision; paying it is the bookkeeping.
 */
router.put(
  '/:doctorId/compensation',
  authorize(PERMISSIONS.DOCTOR_COMPENSATION_MANAGE),
  validate(doctorParams, 'params'),
  validate(setDoctorCompensationRequest, 'body'),
  async (req: Request, res: Response): Promise<void> => {
    const { doctorId } = req.params as z.infer<typeof doctorParams>;
    const detail = await setDoctorCompensation(
      tenantContextFrom(req),
      doctorId,
      req.body as SetDoctorCompensationRequest,
      auditMeta(req)
    );
    sendSuccess(res, detail, 'Compensation saved');
  }
);

// --- per-doctor fee overrides ----------------------------------------------

/**
 * This doctor's prices, with the clinic's defaults folded in.
 *
 * ⚠️ `billing.fee_schedule.read`, NOT `doctor.read`. What a doctor is charged
 *   out at is commercial rather than personnel information, and the two are read
 *   by different people: a lab assistant holds DOCTOR_READ so it can name the
 *   ordering clinician, and has no business with the price list.
 *
 * ⚠️ AND NOT `doctor.update` FOR THE WRITE. Every BRANCH_ADMIN holds that one,
 *   so pricing a consultation would become something whoever can fix a typo in a
 *   bio may do. See FEE_SCHEDULE_MANAGE.
 *
 * Every row a doctor has not overridden shows the clinic's number and the level
 * it came from — an admin who cannot tell an override from an inherited default
 * sets an override everywhere, and the default stops meaning anything.
 */
router.get(
  '/:doctorId/fees',
  authorize(PERMISSIONS.FEE_SCHEDULE_READ),
  validate(doctorParams, 'params'),
  validate(feeScheduleQuery, 'query'),
  async (req: Request, res: Response): Promise<void> => {
    const { doctorId } = req.params as z.infer<typeof doctorParams>;
    const query = req.query as unknown as FeeScheduleQuery;
    sendSuccess(
      res,
      await getFeeSchedule(tenantContextFrom(req), {
        doctorProfileId: doctorId,
        ...(query.branchId !== undefined ? { branchId: query.branchId } : {}),
      })
    );
  }
);

router.put(
  '/:doctorId/fees',
  authorize(PERMISSIONS.FEE_SCHEDULE_MANAGE),
  validate(doctorParams, 'params'),
  validate(setFeeScheduleRequest, 'body'),
  async (req: Request, res: Response): Promise<void> => {
    const { doctorId } = req.params as z.infer<typeof doctorParams>;
    const view = await setFeeSchedule(
      tenantContextFrom(req),
      { doctorProfileId: doctorId },
      req.body as SetFeeScheduleRequest,
      auditMeta(req)
    );
    sendSuccess(res, view, 'Fees saved');
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
