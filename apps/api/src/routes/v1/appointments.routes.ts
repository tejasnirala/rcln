import { Router, type IRouter, type Request, type Response } from 'express';
import { z } from 'zod';
import {
  appointmentListQuery,
  appointmentTransitionRequest,
  availabilityQuery,
  cancelAppointmentRequest,
  createAppointmentInvoiceRequest,
  createAppointmentRequest,
  followUpAppointmentRequest,
  noShowAppointmentRequest,
  recordVitalsRequest,
  rescheduleAppointmentRequest,
  updateAppointmentRequest,
  updateVitalsRequest,
  workingDaysQuery,
  type AppointmentListQuery,
  type AppointmentTransitionRequest,
  type AvailabilityQuery,
  type CancelAppointmentRequest,
  type CreateAppointmentInvoiceRequest,
  type CreateAppointmentRequest,
  type FollowUpAppointmentRequest,
  type NoShowAppointmentRequest,
  type RecordVitalsRequest,
  type RescheduleAppointmentRequest,
  type UpdateAppointmentRequest,
  type UpdateVitalsRequest,
  type WorkingDaysQuery,
} from '@rcln/contracts';
import { PERMISSIONS } from '@rcln/permissions';
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
  cancelAppointment,
  createAppointment,
  createFollowUp,
  deleteAppointment,
  getAppointment,
  getAvailability,
  getWorkingDays,
  listDay,
  markNoShow,
  openConsultation,
  rescheduleAppointment,
  transitionAppointment,
  updateAppointment,
  type AppointmentActionOptions,
} from '../../services/appointment/appointment.service.js';
import {
  amendVitals,
  deleteVitals,
  listVitals,
  listVitalsRevisions,
  recordVitals,
} from '../../services/appointment/vitals.service.js';
import {
  createInvoiceForAppointment,
  getAppointmentBilling,
} from '../../services/invoicing/appointment-billing.service.js';
import { resolveInvoiceVisibility } from '../../services/invoicing/invoice-visibility.js';
import { sendCreated, sendSuccess } from '../../utils/response.js';

/**
 * Appointments — PHI, by a route nobody expects it on.
 *
 * The standard chain, and the order is the security model:
 *
 *   requireTenant -> authenticate -> requireAuth -> authorize -> validate -> handler
 *
 * ⚠️ AVAILABILITY IS A SEPARATE PERMISSION FROM READING THE DIARY.
 *   `appointment.availability.read` says which slots are free. `appointment.read`
 *   says who is in them. They are split because a patient on the portal must be
 *   able to find a free 10:20 without being able to read the day board, and
 *   because the availability response deliberately never names who holds a
 *   taken slot. Fusing them puts a clinic's whole diary behind the booking page.
 *
 * ⚠️ CANCEL AND NO-SHOW ARE THEIR OWN ENDPOINTS, not values on the transition
 *   call. Both are terminal, both free the slot, and only one of them is a fact
 *   about the patient — a receptionist with `appointment.checkin` can move a
 *   booking forward without being able to record that someone did not turn up.
 *
 * ⚠️ `meta()` PASSES THE ROUTE **PATTERN**, NEVER `req.originalUrl`.
 *   The same rule as patients.routes.ts: `data_access_logs` is read by
 *   compliance staff who have no business reading patient records.
 */

const router: IRouter = Router();

router.use(requireTenant, authenticate, requireAuth);

const appointmentParams = z.object({ appointmentId: z.uuid() });

const meta = (req: Request, pattern: string): AppointmentActionOptions => ({
  ...(req.ip !== undefined ? { ipAddress: req.ip } : {}),
  ...(req.get('user-agent') !== undefined ? { userAgent: req.get('user-agent') as string } : {}),
  route: `${req.method} /v1/appointments${pattern}`,
});

// --- availability ----------------------------------------------------------

/**
 * What is free. A GET, unlike the patient search: a branch, a doctor and a date
 * are nobody's surname, so none of them is a disclosure in a proxy log.
 */
router.get(
  '/availability',
  authorize(PERMISSIONS.APPOINTMENT_AVAILABILITY_READ),
  validate(availabilityQuery, 'query'),
  async (req: Request, res: Response): Promise<void> => {
    const availability = await getAvailability(
      tenantContextFrom(req),
      req.query as unknown as AvailabilityQuery
    );
    sendSuccess(res, availability);
  }
);

/**
 * Which days the doctor consults on at all, across a span.
 *
 * ⚠️ THE SAME PERMISSION AS `/availability`, AND IT HAS TO BE. It answers a
 *   strictly weaker version of the same question — "is there a clinic that day"
 *   rather than "which slots are free" — about the same doctor at the same
 *   branch, and it names nobody. A second, laxer code here would be a way to map
 *   a doctor's working week without holding the permission that says you may
 *   read their diary.
 *
 * `/availability/days` and `/availability` are both exact paths, so Express 5
 * matches them independently and the order they are declared in does not matter.
 */
router.get(
  '/availability/days',
  authorize(PERMISSIONS.APPOINTMENT_AVAILABILITY_READ),
  validate(workingDaysQuery, 'query'),
  async (req: Request, res: Response): Promise<void> => {
    const days = await getWorkingDays(
      tenantContextFrom(req),
      req.query as unknown as WorkingDaysQuery
    );
    sendSuccess(res, days);
  }
);

// --- the day board ---------------------------------------------------------

/**
 * The day board — and how much of it you get depends on a SECOND permission.
 *
 * ⚠️ `appointment.read` OPENS THIS SCREEN; `doctor.directory.read` DECIDES WHOSE
 *   BOOKINGS ARE ON IT. A caller who may not enumerate the clinic's
 *   practitioners may not read across them either, so a doctor gets their own
 *   diary and the front desk gets the branch's. That is one rule expressed once,
 *   rather than a role check here and a different one in the navigation.
 *
 *   A 403 would be the wrong answer for the doctor — the screen is theirs, the
 *   scope is narrower — and returning the whole branch's day would disclose
 *   every colleague's list. So the permission narrows the query instead of
 *   ending the request, which is what `callerHasPermission` exists for.
 *
 *   The service treats `ownDoctorOnly` as an override, not a default, so
 *   `?doctorProfileId=<a colleague>` cannot widen it back out.
 */
router.get(
  '/',
  authorize(PERMISSIONS.APPOINTMENT_READ),
  validate(appointmentListQuery, 'query'),
  async (req: Request, res: Response): Promise<void> => {
    const acrossDoctors = await callerHasPermission(req, PERMISSIONS.DOCTOR_DIRECTORY_READ);
    /*
     * ⚠️ A THIRD PERMISSION, AND IT ADDS A COLUMN RATHER THAN ROWS. Whether a
     *   visit is already billed is billing information, so the board answers it
     *   only for a caller who may read invoices — and OMITS the field entirely
     *   otherwise, because a doctor shown `null` on every row would read the
     *   board as "nothing has been billed today".
     */
    const withBilling = await callerHasPermission(req, PERMISSIONS.INVOICE_READ);

    const result = await listDay(
      tenantContextFrom(req),
      req.query as unknown as AppointmentListQuery,
      { ownDoctorOnly: !acrossDoctors, withBilling }
    );
    sendSuccess(res, result);
  }
);

router.post(
  '/',
  authorize(PERMISSIONS.APPOINTMENT_CREATE),
  validate(createAppointmentRequest, 'body'),
  async (req: Request, res: Response): Promise<void> => {
    const appointment = await createAppointment(
      tenantContextFrom(req),
      req.body as CreateAppointmentRequest,
      meta(req, '/')
    );
    sendSuccess(res, appointment, 'Appointment booked', 201);
  }
);

// --- one booking -----------------------------------------------------------

router.get(
  '/:appointmentId',
  authorize(PERMISSIONS.APPOINTMENT_READ),
  validate(appointmentParams, 'params'),
  async (req: Request, res: Response): Promise<void> => {
    const { appointmentId } = req.params as z.infer<typeof appointmentParams>;
    const appointment = await getAppointment(
      tenantContextFrom(req),
      appointmentId,
      meta(req, '/:appointmentId'),
      { withBilling: await callerHasPermission(req, PERMISSIONS.INVOICE_READ) }
    );
    sendSuccess(res, appointment);
  }
);

// --- billing the visit -----------------------------------------------------

/**
 * What billing this visit would look like — the preview behind Raise invoice.
 *
 * ⚠️ `billing.invoice.read`, NOT `appointment.read`, AND IT IS MOUNTED HERE ONLY
 *   BECAUSE THE PATH READS BETTER. Everything it answers is billing: the fee off
 *   the doctor's rate card, and which invoice the visit is already on. A doctor
 *   who may open the chart does not thereby learn what the clinic charged for
 *   it.
 *
 * ⚠️ NO DISCLOSURE ROW. It carries ids, a fee and an invoice state — no name, no
 *   line description, nothing clinical. The bill itself is
 *   `GET /v1/invoices/:id`, which does log. See the service's note.
 */
router.get(
  '/:appointmentId/billing',
  authorize(PERMISSIONS.INVOICE_READ),
  validate(appointmentParams, 'params'),
  async (req: Request, res: Response): Promise<void> => {
    const { appointmentId } = req.params as z.infer<typeof appointmentParams>;
    const billing = await getAppointmentBilling(tenantContextFrom(req), appointmentId);
    sendSuccess(res, billing);
  }
);

/**
 * Raise the bill for this visit.
 *
 * ⚠️ `billing.invoice.create`, THE SAME CODE AS `POST /v1/invoices`, AND THERE
 *   IS NO `appointment.invoice.create`. This endpoint is a shortcut through that
 *   one — same table, same lifecycle, same series — so a second code would
 *   record a distinction the permission matrix carries and nobody uses.
 *
 * Answers with the priced draft, exactly as the generic create does: the whole
 * point is the engine's numbers, and echoing the request back would show the
 * cashier their own figures and hide the tax.
 */
router.post(
  '/:appointmentId/invoice',
  authorize(PERMISSIONS.INVOICE_CREATE),
  validate(appointmentParams, 'params'),
  validate(createAppointmentInvoiceRequest, 'body'),
  async (req: Request, res: Response): Promise<void> => {
    const { appointmentId } = req.params as z.infer<typeof appointmentParams>;

    const invoice = await createInvoiceForAppointment(
      tenantContextFrom(req),
      appointmentId,
      req.body as CreateAppointmentInvoiceRequest,
      await resolveInvoiceVisibility((permission) => callerHasPermission(req, permission)),
      {
        ...(req.ip !== undefined ? { ipAddress: req.ip } : {}),
        ...(req.get('user-agent') !== undefined
          ? { userAgent: req.get('user-agent') as string }
          : {}),
        route: 'POST /v1/appointments/:appointmentId/invoice',
      }
    );

    sendCreated(res, invoice);
  }
);

router.patch(
  '/:appointmentId',
  authorize(PERMISSIONS.APPOINTMENT_UPDATE),
  validate(appointmentParams, 'params'),
  validate(updateAppointmentRequest, 'body'),
  async (req: Request, res: Response): Promise<void> => {
    const { appointmentId } = req.params as z.infer<typeof appointmentParams>;
    const appointment = await updateAppointment(
      tenantContextFrom(req),
      appointmentId,
      req.body as UpdateAppointmentRequest,
      meta(req, '/:appointmentId')
    );
    sendSuccess(res, appointment, 'Appointment updated');
  }
);

/** Moving a booking is `appointment.update`, not a fresh `appointment.create`. */
router.post(
  '/:appointmentId/reschedule',
  authorize(PERMISSIONS.APPOINTMENT_UPDATE),
  validate(appointmentParams, 'params'),
  validate(rescheduleAppointmentRequest, 'body'),
  async (req: Request, res: Response): Promise<void> => {
    const { appointmentId } = req.params as z.infer<typeof appointmentParams>;
    const appointment = await rescheduleAppointment(
      tenantContextFrom(req),
      appointmentId,
      req.body as RescheduleAppointmentRequest,
      meta(req, '/:appointmentId/reschedule')
    );
    sendSuccess(res, appointment, 'Appointment moved');
  }
);

/**
 * Confirm, check in, start, complete.
 *
 * Behind `appointment.checkin` — the permission the front desk and the nurse
 * hold and which does NOT carry the ability to book, move or cancel.
 */
router.post(
  '/:appointmentId/status',
  authorize(PERMISSIONS.APPOINTMENT_CHECKIN),
  validate(appointmentParams, 'params'),
  validate(appointmentTransitionRequest, 'body'),
  async (req: Request, res: Response): Promise<void> => {
    const { appointmentId } = req.params as z.infer<typeof appointmentParams>;
    const appointment = await transitionAppointment(
      tenantContextFrom(req),
      appointmentId,
      req.body as AppointmentTransitionRequest,
      meta(req, '/:appointmentId/status')
    );
    sendSuccess(res, appointment, 'Appointment updated');
  }
);

router.post(
  '/:appointmentId/cancel',
  authorize(PERMISSIONS.APPOINTMENT_CANCEL),
  validate(appointmentParams, 'params'),
  validate(cancelAppointmentRequest, 'body'),
  async (req: Request, res: Response): Promise<void> => {
    const { appointmentId } = req.params as z.infer<typeof appointmentParams>;
    const appointment = await cancelAppointment(
      tenantContextFrom(req),
      appointmentId,
      req.body as CancelAppointmentRequest,
      meta(req, '/:appointmentId/cancel')
    );
    sendSuccess(res, appointment, 'Appointment cancelled');
  }
);

/**
 * Deliberately behind `appointment.cancel` rather than `appointment.checkin`.
 *
 * A no-show is a claim about a patient that a billing rule may later act on. The
 * person who can end a booking is the person who can record that it ended
 * because nobody came.
 */
router.post(
  '/:appointmentId/no-show',
  authorize(PERMISSIONS.APPOINTMENT_CANCEL),
  validate(appointmentParams, 'params'),
  validate(noShowAppointmentRequest, 'body'),
  async (req: Request, res: Response): Promise<void> => {
    const { appointmentId } = req.params as z.infer<typeof appointmentParams>;
    const appointment = await markNoShow(
      tenantContextFrom(req),
      appointmentId,
      req.body as NoShowAppointmentRequest,
      meta(req, '/:appointmentId/no-show')
    );
    sendSuccess(res, appointment, 'Marked as not attended');
  }
);

/**
 * Withdraw a booking that should never have been made.
 *
 * ⚠️ `appointment.delete`, WHICH IS NOT `appointment.cancel`. A cancellation is a
 *   fact about a patient who called off; this erases a mis-click before it
 *   pollutes the utilisation and no-show reports. Anyone who can do the second
 *   should not automatically be able to do the first, or the reports stop
 *   distinguishing the two.
 *
 * The service narrows it much further than the permission can: future only,
 * BOOKED only, no follow-ups hanging off it, and a soft delete when it does go
 * through. See `deleteAppointment`.
 *
 * 204: there is nothing meaningful to return, and echoing the deleted booking
 * back would be handing out PHI on the way out of the door.
 */
router.delete(
  '/:appointmentId',
  authorize(PERMISSIONS.APPOINTMENT_DELETE),
  validate(appointmentParams, 'params'),
  async (req: Request, res: Response): Promise<void> => {
    const { appointmentId } = req.params as z.infer<typeof appointmentParams>;
    await deleteAppointment(tenantContextFrom(req), appointmentId, meta(req, '/:appointmentId'));
    res.status(204).end();
  }
);

/**
 * Book the next visit in the chain.
 *
 * `appointment.create` — it is a booking, and it consumes a slot like any other.
 * The patient and the branch come off the parent rather than the body, so this
 * cannot be used to book for somebody else while looking like a continuation.
 */
router.post(
  '/:appointmentId/follow-up',
  authorize(PERMISSIONS.APPOINTMENT_CREATE),
  validate(appointmentParams, 'params'),
  validate(followUpAppointmentRequest, 'body'),
  async (req: Request, res: Response): Promise<void> => {
    const { appointmentId } = req.params as z.infer<typeof appointmentParams>;
    const appointment = await createFollowUp(
      tenantContextFrom(req),
      appointmentId,
      req.body as FollowUpAppointmentRequest,
      meta(req, '/:appointmentId/follow-up')
    );
    sendSuccess(res, appointment, 'Follow-up booked', 201);
  }
);

// --- the consultation ------------------------------------------------------

/**
 * Open the consultation: the appointment detail, plus starting the visit.
 *
 * ⚠️ A POST, BECAUSE IT MUTATES. It moves a CHECKED_IN booking to IN_PROGRESS —
 *   see "Automatic status" in the service — so the board reflects a doctor who
 *   has taken the patient in without anybody pressing a button. A GET that
 *   silently transitions state is a trap for every cache and prefetch between
 *   here and the browser.
 *
 * ⚠️ BEHIND `clinical.encounter.create`, NOT `clinical.encounter.read`. It used
 *   to be the read code, and that was wrong the moment anybody other than a
 *   clinician could hold it: an administrator opening a booking to look at it
 *   would MOVE THE PATIENT TO "with the doctor" on the day board, from a page
 *   they only came to read. Starting a visit is the first act of authoring the
 *   consultation, so it asks for the authoring code — which among the system
 *   roles is DOCTOR alone. Everyone else reads the same visit through
 *   `GET /appointments/:id`, which mutates nothing.
 */
router.post(
  '/:appointmentId/consultation',
  authorize(PERMISSIONS.ENCOUNTER_CREATE),
  validate(appointmentParams, 'params'),
  async (req: Request, res: Response): Promise<void> => {
    const { appointmentId } = req.params as z.infer<typeof appointmentParams>;
    const appointment = await openConsultation(
      tenantContextFrom(req),
      appointmentId,
      meta(req, '/:appointmentId/consultation')
    );
    sendSuccess(res, appointment);
  }
);

// --- vitals ----------------------------------------------------------------

/**
 * ⚠️ READ AND WRITE ARE TWO CODES HERE, AND THE DOCTOR ONLY HOLDS ONE OF THEM.
 *   `clinical.vitals.read` opens the readings; `clinical.vitals.record` takes,
 *   corrects and withdraws one. The front desk and the nurse hold both — they
 *   are the ones standing there with the cuff, and whoever typed a number needs
 *   to see it back to check it. A DOCTOR holds only the read: a consultation
 *   must not be able to quietly amend an observation somebody else is
 *   accountable for. See `VITALS_READ` in @rcln/permissions.
 *
 *   Neither is `clinical.encounter.read` — that would hand the front desk the
 *   doctor's conclusions along with the blood pressure.
 *
 * Both directions write a `data_access_logs` row. This is clinical content about
 * one named patient, which is exactly the line the day board sits on the other
 * side of.
 */
router.get(
  '/:appointmentId/vitals',
  authorize(PERMISSIONS.VITALS_READ),
  validate(appointmentParams, 'params'),
  async (req: Request, res: Response): Promise<void> => {
    const { appointmentId } = req.params as z.infer<typeof appointmentParams>;
    const vitals = await listVitals(
      tenantContextFrom(req),
      appointmentId,
      meta(req, '/:appointmentId/vitals')
    );
    sendSuccess(res, vitals);
  }
);

/**
 * Record a set of observations.
 *
 * POST and never PUT: readings accumulate. A repeat blood pressure twenty
 * minutes later is a second observation, not a correction of the first, and
 * there is deliberately no update endpoint.
 *
 * Side effect: this may check the patient in. See `recordVitals`.
 */
router.post(
  '/:appointmentId/vitals',
  authorize(PERMISSIONS.VITALS_RECORD),
  validate(appointmentParams, 'params'),
  validate(recordVitalsRequest, 'body'),
  async (req: Request, res: Response): Promise<void> => {
    const { appointmentId } = req.params as z.infer<typeof appointmentParams>;
    const reading = await recordVitals(
      tenantContextFrom(req),
      appointmentId,
      req.body as RecordVitalsRequest,
      meta(req, '/:appointmentId/vitals')
    );
    sendSuccess(res, reading, 'Vitals recorded', 201);
  }
);

/**
 * Every correction ever made to one reading, with both values.
 *
 * ⚠️ THIS IS THE CLINICAL TRAIL, NOT THE COMPLIANCE ONE, AND THAT IS WHY IT IS
 *   HERE RATHER THAN UNDER `/audit`. `GET /audit` answers "who touched this
 *   record" for every entity type and is deliberately free of measurements — it
 *   is read through `audit.record.read`, which people with no clinical access
 *   hold. What a blood pressure WAS before it was corrected is clinical content
 *   about one named patient, so it sits behind `clinical.vitals.read` with the
 *   readings themselves, and it writes a `data_access_logs` row like every other
 *   read of them.
 */
router.get(
  '/:appointmentId/vitals/:vitalsId/revisions',
  authorize(PERMISSIONS.VITALS_READ),
  validate(appointmentParams.extend({ vitalsId: z.uuid() }), 'params'),
  async (req: Request, res: Response): Promise<void> => {
    const { appointmentId, vitalsId } = req.params as unknown as {
      appointmentId: string;
      vitalsId: string;
    };
    const revisions = await listVitalsRevisions(
      tenantContextFrom(req),
      appointmentId,
      vitalsId,
      meta(req, '/:appointmentId/vitals/:vitalsId/revisions')
    );
    sendSuccess(res, revisions);
  }
);

/**
 * Correct a mistyped reading.
 *
 * ⚠️ PUT, NOT PATCH, BECAUSE IT REPLACES. The form arrives populated with what
 *   is already recorded, so an empty box means "not measured" — the same thing
 *   it means when the reading is first taken. PATCH would promise a merge, and a
 *   merge leaves a wrongly-entered measurement with no way to clear it.
 *
 * ⚠️ THE SAME PERMISSION AS RECORDING ONE, AND DELIBERATELY. `clinical.vitals.record`
 *   is held by whoever takes the observation, and the mistake this fixes is
 *   theirs, noticed seconds later. Putting the correction behind a code they do
 *   not hold means the typo stands until an administrator is found — and the
 *   control here is the audit row, not the gate: every amendment records who
 *   changed which measurements, and when.
 *
 *   Which also means a DOCTOR cannot reach this: they hold `clinical.vitals.read`
 *   and not the write code, so a consultation reads the chart and never rewrites
 *   an observation the front desk signed for. That is the split, not an
 *   oversight — see `VITALS_READ` in @rcln/permissions.
 *
 * This does NOT replace `POST`. Readings still accumulate: a repeat blood
 * pressure is a second observation, not an edit of the first.
 */
router.put(
  '/:appointmentId/vitals/:vitalsId',
  authorize(PERMISSIONS.VITALS_RECORD),
  validate(appointmentParams.extend({ vitalsId: z.uuid() }), 'params'),
  validate(updateVitalsRequest, 'body'),
  async (req: Request, res: Response): Promise<void> => {
    const { appointmentId, vitalsId } = req.params as unknown as {
      appointmentId: string;
      vitalsId: string;
    };
    const reading = await amendVitals(
      tenantContextFrom(req),
      appointmentId,
      vitalsId,
      req.body as UpdateVitalsRequest,
      meta(req, '/:appointmentId/vitals/:vitalsId')
    );
    sendSuccess(res, reading, 'Reading corrected');
  }
);

/** Withdraw a mistyped reading. Soft, so the chart loses it and the table does not. */
router.delete(
  '/:appointmentId/vitals/:vitalsId',
  authorize(PERMISSIONS.VITALS_RECORD),
  validate(appointmentParams.extend({ vitalsId: z.uuid() }), 'params'),
  async (req: Request, res: Response): Promise<void> => {
    const { appointmentId, vitalsId } = req.params as unknown as {
      appointmentId: string;
      vitalsId: string;
    };
    await deleteVitals(
      tenantContextFrom(req),
      appointmentId,
      vitalsId,
      meta(req, '/:appointmentId/vitals/:vitalsId')
    );
    res.status(204).end();
  }
);

export default router;
