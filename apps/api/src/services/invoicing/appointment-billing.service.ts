/**
 * Billing a consultation — the first integrated source on the invoice engine.
 *
 * Everything here is a shortcut through `POST /v1/invoices`, and nothing here is
 * a second engine. The draft it opens is an ordinary `sourceType: APPOINTMENT`
 * invoice with one line, priced, finalised, numbered and rendered by exactly the
 * code Phases 3–7 built. What this file adds is the three answers a cashier
 * would otherwise have to type:
 *
 *   - WHAT the visit costs, from `doctor_branch_settings` — the rate card that
 *     has existed since the doctors phase with nothing reading it.
 *   - WHEN it was supplied, which is the day of the VISIT and not today.
 *   - WHETHER it is already billed, which is a question about the LIVE invoice.
 *
 * ⚠️ "ALREADY BILLED?" IS NOT `appointment_id IS NOT NULL`, AND THE COLUMN IS
 *   DELIBERATELY NOT UNIQUE. A visit billed, voided and billed again has two
 *   invoices citing it, and the void KEEPS its reference — drop it and the
 *   correction cannot be explained. So the question is whether any invoice for
 *   the visit is still standing, and `LIVE_STATUSES` is the whole definition of
 *   standing. One definition, consulted by the preview, the create and the day
 *   board alike.
 *
 * ⚠️ THE DATE OF SUPPLY IS THE VISIT'S BRANCH-LOCAL DAY, AND THIS IS THE MOST
 *   CONSEQUENTIAL LINE IN THE FILE. A bill raised in April for a March
 *   consultation must be taxed as March was — the effective-dated rule and the
 *   registration are both selected by it. Taking `now()` instead would be
 *   invisible on the day and wrong on every bill raised late, which at a clinic
 *   is the ones raised across a rate change.
 *
 * ⚠️ NO NEW PERMISSION CODE. `billing.invoice.read` opens the preview and
 *   `billing.invoice.create` raises the draft, which are the same two codes the
 *   generic routes use, because this endpoint confers nothing they do not. The
 *   source visibility rule applies unchanged: APPOINTMENT is general billing,
 *   so anybody holding `billing.invoice.read` may see it.
 */
import type { Prisma, TenantContext, TxClient } from '@rcln/db';
import { withTenant } from '@rcln/db';
import type {
  AppointmentBilling,
  AppointmentBillingBlockedReason,
  AppointmentInvoiceLink,
  AppointmentStatusValue,
  ConsultationCharge,
  ConsultationUnpricedReason,
  CreateAppointmentInvoiceRequest,
  InvoiceDetail,
  InvoiceStatusValue,
} from '@rcln/contracts';
import { money, type Money } from '@rcln/payments';

import { ConflictError, NotFoundError } from '../../utils/errors.js';

import { hasAnyFee, resolveFee } from '../fees/fee-schedule.service.js';
import {
  createDraftInvoice,
  organizationCurrency,
  type DraftLineInput,
} from './invoice-lifecycle.service.js';
import type { InvoiceVisibility } from './invoice-visibility.js';
import {
  auditOptions,
  branchInstant,
  readInvoiceDetail,
  type InvoiceActionOptions,
} from './invoice.service.js';
import { toMoney } from './money.js';

/**
 * An invoice that still stands.
 *
 * CANCELLED and VOID are absent, and their absence is the rule: a cancelled
 * draft was seen by nobody and a voided document has been reversed. Either way
 * the visit is unbilled and may be billed again.
 */
const LIVE_STATUSES = [
  'DRAFT',
  'FINALIZING',
  'ISSUED',
  'PARTIALLY_PAID',
  'PAID',
] as const satisfies readonly InvoiceStatusValue[];

/**
 * The category the consultation line is rated under.
 *
 * ⚠️ MATCHED EXACTLY AGAINST `tax_rules.tax_category`, AND THE STRING IS THE
 *   CONTRACT. It is the same literal the platform catalogue seeds
 *   (`HEALTHCARE_SERVICE_CATEGORIES` in `seed.ts`), which is what makes an
 *   Indian clinic's consultation come out EXEMPT without the clinic configuring
 *   anything. A typo here does not fail — it resolves to `UNRATED`, charges
 *   nothing, and refuses to issue, which is the correct failure but a confusing
 *   one to debug.
 *
 * ⚠️ NO `itemCode`. The SAC for healthcare services is 9993 and printing it is a
 *   clinic's decision about its own returns, not a default rcln can make for
 *   every country on the platform. The rate card is where a clinic will say so.
 */
const CONSULTATION_TAX_CATEGORY = 'CONSULTATION';

/** Statuses in which a visit is not something to raise a bill for. */
const BLOCKED_BY_STATUS: Partial<Record<AppointmentStatusValue, AppointmentBillingBlockedReason>> =
  {
    CANCELLED: 'APPOINTMENT_CANCELLED',
    /*
     * A no-show fee is a real thing at a real clinic and it is NOT the
     * consultation fee — nobody was consulted. A clinic that charges one raises it
     * through `POST /v1/invoices` with the amount it decided on, rather than
     * having this endpoint quietly bill an absent patient for a visit.
     */
    NO_SHOW: 'APPOINTMENT_NO_SHOW',
  };

const LINK_SELECT = {
  id: true,
  appointmentId: true,
  invoiceNumber: true,
  status: true,
  currency: true,
  grandTotal: true,
  amountPaid: true,
  issuedAt: true,
} satisfies Prisma.InvoiceSelect;

type LinkRow = Prisma.InvoiceGetPayload<{ select: typeof LINK_SELECT }>;

function toLink(row: LinkRow): AppointmentInvoiceLink {
  const grandTotalMinor = toMoney(row.grandTotal, row.currency).amountMinor;
  const amountPaidMinor = toMoney(row.amountPaid, row.currency).amountMinor;

  return {
    invoiceId: row.id,
    invoiceNumber: row.invoiceNumber,
    status: row.status,
    currency: row.currency,
    grandTotalMinor,
    amountPaidMinor,
    /* Derived, never stored — a third number that can disagree with two. */
    balanceDueMinor: grandTotalMinor - amountPaidMinor,
    issuedAt: row.issuedAt?.toISOString() ?? null,
  };
}

// ---------------------------------------------------------------------------
// The live invoice, for one visit and for a board of them
// ---------------------------------------------------------------------------

/**
 * The live invoice for each of these visits, keyed by appointment id.
 *
 * ⚠️ ONE QUERY FOR THE WHOLE BOARD, NOT ONE PER ROW. A busy branch's day board
 *   is a hundred rows, and a per-row lookup inside a loop is a hundred round
 *   trips in the transaction that renders the front desk's main screen.
 *
 * At most one row per visit is expected. `orderBy createdAt desc` and first-wins
 * is the answer if two ever exist — the newest is the one the desk is working
 * on — rather than a crash on a state the database does not forbid.
 */
export async function liveInvoicesFor(
  tx: TxClient,
  appointmentIds: readonly string[]
): Promise<Map<string, AppointmentInvoiceLink>> {
  if (appointmentIds.length === 0) return new Map();

  const rows = await tx.invoice.findMany({
    where: {
      appointmentId: { in: [...appointmentIds] },
      deletedAt: null,
      status: { in: [...LIVE_STATUSES] },
    },
    select: LINK_SELECT,
    orderBy: { createdAt: 'desc' },
  });

  const byAppointment = new Map<string, AppointmentInvoiceLink>();
  for (const row of rows) {
    if (row.appointmentId && !byAppointment.has(row.appointmentId)) {
      byAppointment.set(row.appointmentId, toLink(row));
    }
  }
  return byAppointment;
}

// ---------------------------------------------------------------------------
// The rate card
// ---------------------------------------------------------------------------

const APPOINTMENT_SELECT = {
  id: true,
  branchId: true,
  patientId: true,
  doctorProfileId: true,
  visitType: true,
  status: true,
  parentAppointmentId: true,
  /*
   * The price frozen when the visit was booked. NULL on anything booked before
   * the fee schedule existed, and on a visit whose kind the clinic never priced
   * — both of which fall through to a live resolution below.
   */
  bookedFee: true,
  patient: {
    select: {
      firstName: true,
      lastName: true,
      phone: true,
      email: true,
      addresses: {
        where: { isPrimary: true },
        take: 1,
        select: {
          line1: true,
          line2: true,
          city: true,
          state: true,
          pincode: true,
        },
      },
    },
  },
  /*
   * Snapshotted onto the invoice, not joined at render time — a doctor who
   * leaves or re-registers must not restate a bill already handed over.
   */
  doctorProfile: {
    select: { registrationNumber: true, user: { select: { fullName: true } } },
  },
} satisfies Prisma.AppointmentSelect;

type BillableAppointment = Prisma.AppointmentGetPayload<{ select: typeof APPOINTMENT_SELECT }>;

/**
 * The visit's calendar dates, read in the zone of the branch each one was booked
 * at.
 *
 * ⚠️ THE PARENT'S DATE COMES FROM THE PARENT'S OWN BRANCH. A follow-up at Dubai
 *   off a visit in Bengaluru is two zones, and measuring the free-review window
 *   in one of them is a day out at the boundary — which is exactly where the
 *   window is decided.
 *
 * ⚠️ THE PARENT IS READ THROUGH RLS AND MAY COME BACK NULL. A `LEFT JOIN` that
 *   the tenant policy filters out yields no parent date, so the free window
 *   simply does not apply. That is the same treatment `getAppointment` gives the
 *   parent's number, and it fails towards charging rather than towards waiving.
 */
async function visitDates(
  tx: TxClient,
  appointmentId: string
): Promise<{ suppliedOn: string; parentOn: string | null }> {
  /* ⚠️ `::timestamp` is load-bearing — see the note in availability.service.ts. */
  const rows = await tx.$queryRaw<{ supplied_on: string; parent_on: string | null }[]>`
    SELECT (a.scheduled_start AT TIME ZONE ab.timezone)::date::text AS supplied_on,
           (p.scheduled_start AT TIME ZONE pb.timezone)::date::text AS parent_on
      FROM appointments a
      JOIN branches ab ON ab.id = a.branch_id
      LEFT JOIN appointments p ON p.id = a.parent_appointment_id AND p.deleted_at IS NULL
      LEFT JOIN branches pb ON pb.id = p.branch_id
     WHERE a.id = ${appointmentId}::uuid
  `;
  const row = rows[0];
  if (!row) throw new NotFoundError('Appointment');
  return { suppliedOn: row.supplied_on, parentOn: row.parent_on };
}

/** Whole days between two calendar dates. Both are plain days, so no zone applies. */
function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}

/**
 * What this visit costs.
 *
 * ⚠️ THE PRICE WAS DECIDED AT BOOKING, AND THIS READS IT RATHER THAN RESOLVING
 *   IT. `appointments.booked_fee` is frozen when the visit is booked, and
 *   re-frozen only when the booking moves to a different doctor or changes kind.
 *   That is §0.2 decision 9, and its consequence is deliberate: a fee rise
 *   reaches visits booked afterwards and no others, with NO pro-rata top-up —
 *   offered to the product owner and withdrawn, because a patient quoted 500 at
 *   the desk and billed 600 has been overcharged from where they are standing.
 *
 * ⚠️ A NULL `booked_fee` FALLS BACK TO RESOLVING THE GRID NOW, and that path is
 *   for visits booked BEFORE this feature existed. It uses the same single
 *   resolver — `resolveFee` in `services/fees` — that the freeze itself uses.
 *   A second copy of the precedence rule here is how a screen quotes one number
 *   and the bill states another.
 *
 * ⚠️ A FOLLOW-UP IS EITHER STRUCTURE OR INTENT, AND BOTH COUNT.
 *   `parentAppointmentId` is the chain the database enforces;
 *   `visitType = FOLLOW_UP` is what the desk typed when the patient came back
 *   without the booking being linked. Charging the new-patient fee to somebody
 *   the desk explicitly marked a follow-up would be the schedule ignoring the
 *   only thing anybody told it. Only the first can measure a free window,
 *   because only it has a previous visit to measure from.
 *
 * ⚠️ THE FREE-REVIEW WINDOW IS STILL `doctor_branch_settings.follow_up_free_days`
 *   AND STILL PER DOCTOR PER BRANCH (§0.2 decision 11). It was left exactly
 *   where it was when the fees moved out: it works, it has tests, and it is not
 *   money. Its ABSENCE is now just "no free window" rather than "no rate card" —
 *   the row exists to say a doctor practises here, and the price lives elsewhere.
 *
 * ⚠️ `is_active` IS NOT CONSULTED. It says whether the doctor still practises at
 *   the branch, and the visit being billed already happened there. A doctor who
 *   left last month has a month of unbilled consultations behind them.
 */
async function resolveCharge(
  tx: TxClient,
  appointment: BillableAppointment,
  dates: { suppliedOn: string; parentOn: string | null },
  currency: string
): Promise<{
  charge: ConsultationCharge | null;
  unpricedReason: ConsultationUnpricedReason | null;
}> {
  const scope = {
    doctorProfileId: appointment.doctorProfileId,
    branchId: appointment.branchId,
  };

  const freeFollowUpDays =
    (
      await tx.doctorBranchSetting.findFirst({
        where: scope,
        select: { followUpFreeDays: true },
      })
    )?.followUpFreeDays ?? null;

  const isFollowUp =
    appointment.parentAppointmentId !== null || appointment.visitType === 'FOLLOW_UP';
  const doctorName = appointment.doctorProfile.user.fullName;

  if (isFollowUp && freeFollowUpDays !== null && dates.parentOn !== null) {
    const elapsed = daysBetween(dates.parentOn, dates.suppliedOn);
    if (elapsed >= 0 && elapsed <= freeFollowUpDays) {
      return {
        charge: {
          basis: 'FOLLOW_UP_FREE',
          description: line(`Follow-up consultation — ${doctorName} (no charge)`),
          taxCategory: CONSULTATION_TAX_CATEGORY,
          unitPriceMinor: 0,
          freeFollowUpDays,
        },
        unpricedReason: null,
      };
    }
  }

  /*
   * The frozen price first. Only a visit that never got one — booked before the
   * schedule existed, or of a kind the clinic has never priced — asks the grid.
   *
   * ⚠️ `FOLLOW_UP` FALLS BACK TO `NEW` AND NOTHING ELSE FALLS BACK TO ANYTHING,
   *   which is `freezeFee`'s rule repeated here for the legacy path only. Most
   *   clinics price the first consultation and leave the review blank; reading
   *   that blank as free bills every review at nothing.
   */
  let fee = appointment.bookedFee;
  if (fee === null) {
    const key = isFollowUp ? 'FOLLOW_UP' : appointment.visitType;
    const resolved =
      (await resolveFee(tx, { ...scope, feeType: key })) ??
      (isFollowUp ? await resolveFee(tx, { ...scope, feeType: 'NEW' }) : null);
    fee = resolved?.amount ?? null;
  }

  if (fee === null) {
    /*
     * An unset price and an empty grid are different prompts, and the extra
     * query is what tells them apart. See `consultationUnpricedReason`.
     */
    return {
      charge: null,
      unpricedReason: (await hasAnyFee(tx, scope)) ? 'NO_FEE_SET' : 'NO_RATE_CARD',
    };
  }

  return {
    charge: {
      basis: isFollowUp ? 'FOLLOW_UP' : 'CONSULTATION',
      description: line(
        isFollowUp ? `Follow-up consultation — ${doctorName}` : `Consultation — ${doctorName}`
      ),
      taxCategory: CONSULTATION_TAX_CATEGORY,
      unitPriceMinor: toMoney(fee, currency).amountMinor,
      freeFollowUpDays: isFollowUp ? freeFollowUpDays : null,
    },
    unpricedReason: null,
  };
}

/**
 * What moving this booking has cost the patient so far.
 *
 * ⚠️ PATIENT-INITIATED MOVES ONLY, AND ONE ROW PER MOVE. A clinic-initiated move
 *   is recorded with a zero charge — the row exists so the clinic can prove it
 *   was not the patient's doing — and must never reach a bill. Three
 *   patient-requested moves are three lines, because a patient charged 600 has
 *   to be able to see it was 200 three times.
 *
 * ⚠️ CHARGED ON TOP OF A FREE FOLLOW-UP. The fee is for moving the slot, not for
 *   the consultation (§0.2 decision 11), so this is deliberately independent of
 *   everything `resolveCharge` decided.
 */
async function rescheduleCharges(
  tx: TxClient,
  appointmentId: string,
  currency: string
): Promise<{ totalMinor: number; count: number; lines: DraftLineInput[] }> {
  const rows = await tx.appointmentReschedule.findMany({
    where: { appointmentId, initiatedBy: 'PATIENT' },
    select: { chargeAmount: true, createdAt: true },
    orderBy: { createdAt: 'asc' },
  });

  const charged = rows.filter((row) => toMoney(row.chargeAmount, currency).amountMinor > 0);

  return {
    totalMinor: charged.reduce(
      (sum, row) => sum + toMoney(row.chargeAmount, currency).amountMinor,
      0
    ),
    count: charged.length,
    lines: charged.map((row, index) => ({
      description: line(
        charged.length === 1
          ? 'Appointment rescheduling fee'
          : `Appointment rescheduling fee (${index + 1} of ${charged.length})`
      ),
      /*
       * ⚠️ RATED AS A CONSULTATION, DELIBERATELY, AND IT IS A TRADE-OFF RATHER
       *   THAN AN OVERSIGHT. A separate category would resolve to `UNRATED` at
       *   every clinic on the platform — the seeded catalogue has no rule for it
       *   — and an UNRATED line refuses to issue, so a rescheduling fee would
       *   block the bill it appears on. Rating it with the visit it belongs to
       *   keeps an Indian clinic's consultation EXEMPT end to end. A clinic that
       *   must treat it differently adds the line through `POST /v1/invoices`.
       */
      taxCategory: CONSULTATION_TAX_CATEGORY,
      itemCode: null,
      quantity: '1',
      unitPrice: money(toMoney(row.chargeAmount, currency).amountMinor, currency),
    })),
  };
}

/** `invoice_items.description` is varchar(255), and a long name must not abort a bill. */
function line(text: string): string {
  return text.length <= 255 ? text : `${text.slice(0, 254)}…`;
}

// ---------------------------------------------------------------------------
// The preview
// ---------------------------------------------------------------------------

async function loadAppointment(tx: TxClient, appointmentId: string): Promise<BillableAppointment> {
  const appointment = await tx.appointment.findFirst({
    where: { id: appointmentId, deletedAt: null },
    select: APPOINTMENT_SELECT,
  });
  if (!appointment) throw new NotFoundError('Appointment');
  return appointment;
}

/**
 * What billing this visit would look like.
 *
 * ⚠️ NO DISCLOSURE ROW, AND THE REASON IS WHAT THIS RETURNS. It carries an
 *   appointment id, a fee and the state of an invoice — no name, no line
 *   description, nothing clinical. The bill itself is `GET /v1/invoices/:id`,
 *   which does log. Filing a row here would put one against every render of the
 *   day board's billing column, which is the per-poll firehose
 *   `invoice.service.ts` explains it is avoiding.
 */
export async function getAppointmentBilling(
  ctx: TenantContext,
  appointmentId: string
): Promise<AppointmentBilling> {
  return withTenant(ctx, async (tx) => {
    const appointment = await loadAppointment(tx, appointmentId);
    const dates = await visitDates(tx, appointmentId);
    const currency = await organizationCurrency(tx, ctx);
    const { charge, unpricedReason } = await resolveCharge(tx, appointment, dates, currency);
    const moves = await rescheduleCharges(tx, appointmentId, currency);

    const history = await tx.invoice.findMany({
      where: { appointmentId, deletedAt: null },
      select: LINK_SELECT,
      orderBy: { createdAt: 'desc' },
    });

    const live = history.find((row) => (LIVE_STATUSES as readonly string[]).includes(row.status));

    const blockedReason: AppointmentBillingBlockedReason | null = live
      ? 'ALREADY_BILLED'
      : (BLOCKED_BY_STATUS[appointment.status] ?? null);

    return {
      appointmentId,
      branchId: appointment.branchId,
      patientId: appointment.patientId,
      suppliedOn: dates.suppliedOn,
      currency,
      charge,
      unpricedReason,
      rescheduleChargeMinor: moves.totalMinor,
      rescheduleCount: moves.count,
      liveInvoice: live ? toLink(live) : null,
      history: history.map(toLink),
      billable: blockedReason === null,
      blockedReason,
    };
  });
}

// ---------------------------------------------------------------------------
// Raising the bill
// ---------------------------------------------------------------------------

/**
 * The patient's address as one printable block.
 *
 * The primary address only. An invoice prints one address, and picking among
 * several is a decision the cashier makes by editing the draft — which is
 * exactly what a draft is for.
 */
function addressOf(patient: BillableAppointment['patient']): string | null {
  const address = patient.addresses[0];
  if (!address) return null;

  const parts = [address.line1, address.line2, address.city, address.state, address.pincode];
  const composed = parts.filter((part): part is string => Boolean(part)).join(', ');
  return composed.length > 0 ? composed : null;
}

function customerName(patient: BillableAppointment['patient']): string {
  return patient.lastName === null ? patient.firstName : `${patient.firstName} ${patient.lastName}`;
}

/**
 * Open a draft for this visit.
 *
 * ⚠️ THE APPOINTMENT ROW IS LOCKED `FOR UPDATE` FIRST, AND THAT LOCK IS THE ONLY
 *   THING STOPPING TWO CASHIERS BILLING ONE VISIT TWICE. The obvious alternative
 *   — a partial unique index over the live statuses — is refused by the schema
 *   on purpose: `invoices.appointment_id` must stay non-unique so a voided
 *   invoice can keep its reference while the replacement cites the same visit.
 *   So uniqueness of the LIVE invoice is an application invariant, and an
 *   application invariant asserted by a read is a race. The lock is on
 *   `appointments` rather than on `invoices` because the row being contended for
 *   is the visit; it is held for the length of one pricing round trip.
 *
 * ⚠️ THE READ-BACK DOES NOT LOG. Same rule as every other write in this module:
 *   a creation is a write and belongs in `audit_logs`, and filing a disclosure
 *   row against the cashier reading their own new bill is the noise that hides
 *   the rows that matter.
 */
export async function createInvoiceForAppointment(
  ctx: TenantContext,
  appointmentId: string,
  input: CreateAppointmentInvoiceRequest,
  visibility: InvoiceVisibility,
  options: InvoiceActionOptions = {}
): Promise<InvoiceDetail> {
  const { id } = await withTenant(ctx, async (tx) => {
    await lockAppointment(tx, appointmentId);

    const appointment = await loadAppointment(tx, appointmentId);
    const dates = await visitDates(tx, appointmentId);
    const currency = await organizationCurrency(tx, ctx);

    const statusBlock = BLOCKED_BY_STATUS[appointment.status];
    if (statusBlock) {
      throw new ConflictError(
        statusBlock === 'APPOINTMENT_CANCELLED'
          ? 'A cancelled visit cannot be billed.'
          : 'A missed visit is not a consultation. Raise the bill directly if the clinic charges for it.'
      );
    }

    const live = await tx.invoice.findFirst({
      where: { appointmentId, deletedAt: null, status: { in: [...LIVE_STATUSES] } },
      select: { invoiceNumber: true },
    });
    if (live) {
      throw new ConflictError(
        live.invoiceNumber === null
          ? 'This visit already has a draft invoice open.'
          : `This visit is already billed on ${live.invoiceNumber}.`
      );
    }

    const lines = await resolveLines(tx, appointment, dates, currency, input);

    return createDraftInvoice(
      tx,
      ctx,
      {
        branchId: appointment.branchId,
        sourceType: 'APPOINTMENT',
        appointmentId,
        patientId: appointment.patientId,
        customer: {
          name: customerName(appointment.patient),
          phone: appointment.patient.phone,
          email: appointment.patient.email,
          address: addressOf(appointment.patient),
          /* A patient is not a business. A GSTIN goes on by editing the draft. */
          taxId: null,
        },
        /*
         * ⚠️ WHO THE PATIENT SAW. A consultation bill that does not name the
         *   clinician is a receipt for an unattributed service — the patient
         *   cannot claim it and an insurer will not accept it. Copied here
         *   rather than read through `appointment_id` at render time, for the
         *   same reason the customer block is copied.
         */
        practitioner: {
          name: appointment.doctorProfile.user.fullName,
          registrationNumber: appointment.doctorProfile.registrationNumber,
          /* The link the doctor's own invoice list is filtered on. */
          profileId: appointment.doctorProfileId,
        },
        /* ⚠️ The day of the VISIT, read in the branch's zone. See the header. */
        suppliedAt: await branchInstant(tx, appointment.branchId, dates.suppliedOn),
        dueDate: null,
        currency,
        lines,
        ...(input.discount
          ? {
              discount:
                input.discount.type === 'PERCENTAGE'
                  ? { type: 'PERCENTAGE', bps: input.discount.bps }
                  : { type: 'FIXED', amount: money(input.discount.amountMinor, currency) },
            }
          : {}),
        notes: input.notes ?? null,
      },
      /*
       * ⚠️ THE AUDIT ROW COMES FROM `createDraftInvoice` AND IS NOT WRITTEN
       *   AGAIN HERE. This door differs from the generic one in what it reads —
       *   the rate card, the visit's day — and not at all in what it writes: the
       *   same draft, in the same shape, with `sourceType: APPOINTMENT` and
       *   `appointmentId` on the snapshot saying which door it came through. A
       *   second row would file one creation twice.
       */
      auditOptions(options)
    );
  });

  return readInvoiceDetail(ctx, id, visibility, options, false);
}

/**
 * The lines this invoice carries: the consultation, then one per charged move.
 *
 * The override wins where it is sent, and where it is not the schedule must have
 * produced something — a clinic that has not set the doctor's fee is told so
 * rather than billed zero, because a zero the clinic never chose is a bill that
 * looks settled.
 *
 * ⚠️ `unitPriceMinor` OVERRIDES THE CONSULTATION AND NOT THE MOVES. The escape
 *   hatch exists so a cashier can charge what was actually agreed for the visit;
 *   silently folding three rescheduling fees into one typed number would make
 *   the bill unexplainable to the patient holding it.
 */
async function resolveLines(
  tx: TxClient,
  appointment: BillableAppointment,
  dates: { suppliedOn: string; parentOn: string | null },
  currency: string,
  input: CreateAppointmentInvoiceRequest
): Promise<DraftLineInput[]> {
  const { charge, unpricedReason } = await resolveCharge(tx, appointment, dates, currency);

  if (!charge && input.unitPriceMinor === undefined) {
    throw new ConflictError(
      unpricedReason === 'NO_RATE_CARD'
        ? 'This clinic has no fees set. Fill in the fee schedule, or send the amount to charge.'
        : 'There is no fee set for this kind of visit. Set it on the fee schedule, or send the amount to charge.'
    );
  }

  const unitPrice: Money = money(input.unitPriceMinor ?? charge?.unitPriceMinor ?? 0, currency);

  const consultation: DraftLineInput = {
    description:
      charge?.description ?? line(`Consultation — ${appointment.doctorProfile.user.fullName}`),
    taxCategory: CONSULTATION_TAX_CATEGORY,
    itemCode: null,
    quantity: '1',
    unitPrice,
  };

  const moves = await rescheduleCharges(tx, appointment.id, currency);
  return [consultation, ...moves.lines];
}

/**
 * Serialise two people billing the same visit.
 *
 * `FOR UPDATE` on the visit rather than an advisory lock, because the row is
 * real, the lock is released by COMMIT without anybody remembering to, and RLS
 * applies to it — a lock on another tenant's appointment id locks nothing and
 * the subsequent read 404s, which is the same answer every other path gives.
 */
async function lockAppointment(tx: TxClient, appointmentId: string): Promise<void> {
  await tx.$queryRaw`
    SELECT id FROM appointments WHERE id = ${appointmentId}::uuid AND deleted_at IS NULL FOR UPDATE
  `;
}
