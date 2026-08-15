/**
 * The recall list (CD-13): who was told to come back and hasn't.
 *
 * ⚠️ THIS IS THE QUESTION THE RECOMMENDATION TABLE EXISTS TO ANSWER, and it is
 *   unanswerable if a recommendation and a booking are the same row — because
 *   an unbooked recommendation would simply not exist. See
 *   FOLLOW_UP_ARCHITECTURE §3.
 *
 * ⚠️ IT IS A PHI LIST AND IS AUDITED AS ONE. Every read writes a
 *   `data_access_logs` row under `PATIENT_LIST`, because the response carries
 *   names and telephone numbers of people under ongoing treatment — the desk is
 *   about to ring them, and a list of uuids is a list nobody can act on.
 *
 * ── WHY THE DUE DATE IS COMPUTED IN SQL ──────────────────────────────────────
 *
 * ⚠️ A RECOMMENDATION STORES EITHER AN INTERVAL OR A DATE, NEVER BOTH (the
 *   CHECK constraint), so "when is this due" is an expression over two
 *   different shapes. Computing it in TypeScript would mean loading every
 *   outstanding recommendation the clinic has ever made and filtering in
 *   memory — which is the unpaginated read §39 refuses, wearing a filter.
 *
 *   So the window is a `$queryRaw` with the expression inline and every value
 *   parameterised. ⚠️ NOTHING FROM THE CALLER IS INTERPOLATED — the status is a
 *   closed enum the contract already narrowed, and the branch, the patient and
 *   the day count are bind parameters.
 */
import { withTenant, Prisma, type TenantContext } from '@rcln/db';
import type { FollowUpRecallResponse, FollowUpRecommendationQuery } from '@rcln/contracts';
import { recordDataAccess } from '../audit/data-access.service.js';

export interface RecallRequestOptions {
  ipAddress?: string | undefined;
  userAgent?: string | undefined;
  /** The matched route PATTERN. Never `req.originalUrl`. */
  route?: string | undefined;
}

/**
 * How overdue is overdue.
 *
 * ⚠️ SEVEN DAYS, AND IT IS A PRODUCT DECISION RATHER THAN A CLINICAL ONE. The
 *   list exists so a receptionist can work through it; splitting "due" from
 *   "chase this one" at a week is what makes both halves a manageable length.
 *   A clinic that wants a different line filters by date instead.
 */
const OVERDUE_AFTER_DAYS = 7;

/**
 * The due date, as SQL.
 *
 * ⚠️ COMPUTED FROM `created_at` FOR AN INTERVAL, NOT FROM TODAY. "Come back in
 *   15 days" said on the 1st is due on the 16th whenever anybody asks;
 *   anchoring to the read would make every recall permanently fifteen days
 *   away and the list permanently empty.
 */
const DUE_DATE = Prisma.sql`
  COALESCE(
    r.recommended_date,
    (r.created_at AT TIME ZONE 'UTC')::date + (
      r.interval_value * CASE r.interval_unit
        WHEN 'DAYS'   THEN 1
        WHEN 'WEEKS'  THEN 7
        WHEN 'MONTHS' THEN 30
      END
    )
  )
`;

interface RecallRow {
  id: string;
  encounter_id: string;
  appointment_id: string;
  patient_id: string;
  branch_id: string;
  is_required: boolean;
  interval_value: number | null;
  interval_unit: string | null;
  recommended_date: Date | null;
  due_on: Date | null;
  follow_up_type: string;
  reason: string | null;
  notes: string | null;
  fulfilled_by_appointment_id: string | null;
  fulfilled_at: Date | null;
  cancelled_at: Date | null;
  cancelled_reason: string | null;
  first_name: string;
  last_name: string;
  phone: string | null;
  total: bigint;
}

function isoDate(value: Date | null): string | null {
  return value === null ? null : (value.toISOString().slice(0, 10) as string);
}

/**
 * The recall list.
 *
 * ⚠️ `is_required = false` NEVER APPEARS IN ANY OUTSTANDING WINDOW. "No
 *   follow-up needed" is a decision that was recorded, not a task that is
 *   waiting — putting it on the desk's list would be asking somebody to chase a
 *   patient the doctor deliberately did not recall.
 */
export async function listRecall(
  ctx: TenantContext,
  query: FollowUpRecommendationQuery,
  options: RecallRequestOptions = {}
): Promise<FollowUpRecallResponse> {
  return withTenant(ctx, async (tx) => {
    const offset = (query.page - 1) * query.pageSize;

    /*
     * ⚠️ THE STATUS BRANCHES ARE WRITTEN OUT RATHER THAN ASSEMBLED FROM THE
     *   CALLER'S STRING. `query.status` is a closed enum the contract already
     *   narrowed, and this switch is what keeps it that way — no path exists
     *   where a value from the wire reaches the SQL text.
     */
    const outstanding = Prisma.sql`
      r.deleted_at IS NULL
      AND r.fulfilled_by_appointment_id IS NULL
      AND r.cancelled_at IS NULL
      AND r.is_required = true
    `;

    let window: Prisma.Sql;
    switch (query.status) {
      case 'DUE':
        window = Prisma.sql`${outstanding} AND ${DUE_DATE} <= CURRENT_DATE`;
        break;
      case 'OVERDUE':
        window = Prisma.sql`
          ${outstanding}
          AND ${DUE_DATE} < CURRENT_DATE - ${OVERDUE_AFTER_DAYS}::int
        `;
        break;
      case 'UPCOMING':
        window = Prisma.sql`
          ${outstanding}
          AND ${DUE_DATE} > CURRENT_DATE
          AND ${DUE_DATE} <= CURRENT_DATE + ${query.withinDays}::int
        `;
        break;
      case 'FULFILLED':
        window = Prisma.sql`r.deleted_at IS NULL AND r.fulfilled_by_appointment_id IS NOT NULL`;
        break;
      case 'CANCELLED':
        window = Prisma.sql`r.deleted_at IS NULL AND r.cancelled_at IS NOT NULL`;
        break;
    }

    const branchFilter =
      query.branchId === undefined
        ? Prisma.empty
        : Prisma.sql`AND r.branch_id = ${query.branchId}::uuid`;
    const patientFilter =
      query.patientId === undefined
        ? Prisma.empty
        : Prisma.sql`AND r.patient_id = ${query.patientId}::uuid`;

    /*
     * ⚠️ NO `organization_id` OR `branch_id = ANY(...)` PREDICATE HERE, AND
     *   THAT IS NOT AN OVERSIGHT. `withTenant` runs this inside a transaction
     *   with `app.current_org` and `app.branch_scope` set, and RLS applies to
     *   raw SQL exactly as it does to the query builder. Adding the predicate
     *   by hand would suggest it is what protects the read, and the day
     *   somebody copies this query without it, it would be.
     */
    const rows = await tx.$queryRaw<RecallRow[]>`
      SELECT
        r.id,
        r.encounter_id,
        r.appointment_id,
        r.patient_id,
        r.branch_id,
        r.is_required,
        r.interval_value,
        r.interval_unit::text AS interval_unit,
        r.recommended_date,
        ${DUE_DATE} AS due_on,
        r.follow_up_type::text AS follow_up_type,
        r.reason,
        r.notes,
        r.fulfilled_by_appointment_id,
        r.fulfilled_at,
        r.cancelled_at,
        r.cancelled_reason,
        p.first_name,
        p.last_name,
        p.phone,
        COUNT(*) OVER () AS total
      FROM encounter_follow_up_recommendations r
      JOIN patients p ON p.id = r.patient_id
      WHERE ${window}
        ${branchFilter}
        ${patientFilter}
      ORDER BY ${DUE_DATE} ASC NULLS LAST, r.created_at ASC
      LIMIT ${query.pageSize}::int OFFSET ${offset}::int
    `;

    /*
     * ⚠️ AUDITED AS A LIST, AND ONLY WHEN IT RETURNED SOMETHING. An empty page
     *   disclosed nothing; logging it would bury the reads that did.
     */
    if (rows.length > 0) {
      await recordDataAccess(tx, ctx, {
        accessType: 'SEARCH',
        resource: 'PATIENT_LIST',
        ...options,
      });
    }

    return {
      items: rows.map((row) => ({
        id: row.id,
        encounterId: row.encounter_id,
        appointmentId: row.appointment_id,
        sourceAppointmentId: row.appointment_id,
        patientId: row.patient_id,
        branchId: row.branch_id,
        patientName: `${row.first_name} ${row.last_name}`,
        patientPhone: row.phone,
        isRequired: row.is_required,
        intervalValue: row.interval_value,
        intervalUnit: row.interval_unit as 'DAYS' | 'WEEKS' | 'MONTHS' | null,
        recommendedDate: isoDate(row.recommended_date),
        dueOn: isoDate(row.due_on),
        followUpType: row.follow_up_type as 'ROUTINE',
        reason: row.reason,
        notes: row.notes,
        fulfilledByAppointmentId: row.fulfilled_by_appointment_id,
        fulfilledAt: row.fulfilled_at?.toISOString() ?? null,
        cancelledAt: row.cancelled_at?.toISOString() ?? null,
        cancelledReason: row.cancelled_reason,
      })),
      page: query.page,
      pageSize: query.pageSize,
      /* `COUNT(*) OVER ()` is a bigint; an empty page has no row to read it from. */
      total: rows.length === 0 ? 0 : Number(rows[0]?.total ?? 0n),
    };
  });
}
