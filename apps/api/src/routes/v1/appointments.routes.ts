import { Router, type IRouter, type Request, type Response } from 'express';
import { z } from 'zod';
import {
  appointmentListQuery,
  appointmentTransitionRequest,
  availabilityQuery,
  cancelAppointmentRequest,
  createAppointmentRequest,
  noShowAppointmentRequest,
  rescheduleAppointmentRequest,
  updateAppointmentRequest,
  type AppointmentListQuery,
  type AppointmentTransitionRequest,
  type AvailabilityQuery,
  type CancelAppointmentRequest,
  type CreateAppointmentRequest,
  type NoShowAppointmentRequest,
  type RescheduleAppointmentRequest,
  type UpdateAppointmentRequest,
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
  cancelAppointment,
  createAppointment,
  getAppointment,
  getAvailability,
  listDay,
  markNoShow,
  rescheduleAppointment,
  transitionAppointment,
  updateAppointment,
  type AppointmentActionOptions,
} from '../../services/appointment/appointment.service.js';
import { sendSuccess } from '../../utils/response.js';

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

// --- the day board ---------------------------------------------------------

router.get(
  '/',
  authorize(PERMISSIONS.APPOINTMENT_READ),
  validate(appointmentListQuery, 'query'),
  async (req: Request, res: Response): Promise<void> => {
    const result = await listDay(
      tenantContextFrom(req),
      req.query as unknown as AppointmentListQuery
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
      meta(req, '/:appointmentId')
    );
    sendSuccess(res, appointment);
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

export default router;
