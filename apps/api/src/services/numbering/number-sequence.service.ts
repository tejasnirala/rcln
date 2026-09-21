/**
 * Document numbering: UHID, branch-local MRN, appointment number, queue token.
 *
 * WHY A TABLE AND NOT A POSTGRES SEQUENCE
 *   `nextval` is deliberately non-transactional — that is its whole point, and
 *   it is exactly wrong here. A booking that rolls back would burn an
 *   appointment number permanently, leaving a gap in a series a clinic may one
 *   day have to explain to an auditor. It would also need one sequence OBJECT
 *   per (org, branch, type, period), which is runtime DDL: `rcln_app` cannot
 *   execute it and must never be able to.
 *
 * WHY NOT AN ADVISORY LOCK
 *   `pg_advisory_xact_lock(hashtext(key))` works, but the counter still has to
 *   live in a row — so the row lock IS the advisory lock, with one fewer moving
 *   part and no silent hash collisions between tenants.
 *
 * WHY NOT `SELECT ... FOR UPDATE` THEN `UPDATE`
 *   The first issue for a new (org, branch, type, period) has no row to lock.
 *   Two concurrent first-issues would both find nothing and both insert.
 *   `ON CONFLICT DO UPDATE` collapses create-or-increment into one atomic
 *   statement, so there is no window between the two.
 *
 * CONCURRENCY, PRECISELY
 *   The `DO UPDATE` takes a row lock implicitly. A second transaction running
 *   the same statement blocks until the first commits, then — under READ
 *   COMMITTED — re-reads the updated row and increments from the committed
 *   value. Numbers are therefore gapless within a committed series, and a
 *   rollback takes the increment with it.
 *
 * ⚠️ CALL THIS AS LATE IN THE TRANSACTION AS POSSIBLE.
 *   The row lock is held until COMMIT, and it serialises every concurrent issue
 *   for that counter. Issue the number immediately before the INSERT that needs
 *   it — and specifically AFTER any availability read — so the lock window is
 *   one statement wide rather than the width of the whole booking.
 */
import type { TenantContext, TxClient } from '@rcln/db';

/** Matches the `NumberSequenceType` enum in schema.prisma. */
export type SequenceType =
  | 'UHID'
  | 'MRN'
  | 'APPOINTMENT'
  | 'QUEUE_TOKEN'
  | 'EMPLOYEE'
  /**
   * Treatment journeys (CE-1).
   *
   * ⚠️ THE ONLY COUNTER HERE THAT IS PER ORGANIZATION RATHER THAN PER BRANCH,
   *   and it never resets. An episode follows the PATIENT, who is org-wide
   *   (ADR-0016): a journey that starts at the main branch and continues at the
   *   satellite is one journey, so a per-branch counter would either issue two
   *   codes for it or have to pick a branch arbitrarily. `openEpisode` passes no
   *   `branchId` for exactly that reason.
   */
  | 'CLINICAL_EPISODE'
  /** Patient invoice serials. Built by `invoice-number.service.ts`, never here. */
  | 'INVOICE'
  /**
   * Stock transfer documents (PI-3). One counter per SENDING branch, taken at
   * DISPATCH and never at create — the same call `INVOICE` makes, and for the
   * same reason: a draft that is abandoned must not burn a serial in a series
   * somebody may have to explain to an auditor. Never resets.
   */
  | 'STOCK_TRANSFER'
  /**
   * Procurement documents (PI-4). All four are per BRANCH and never reset, because
   * every one of them is quoted back by somebody outside the clinic — a supplier on
   * their invoice, an auditor on a purchase trail.
   *
   * ⚠️ EACH IS ISSUED AT THE MOMENT THE DOCUMENT LEAVES DRAFT, NOT AT CREATE. An
   *   abandoned requisition, a PO that is never sent and a delivery keyed in by
   *   mistake must all burn no number: a gap in any of these series is a gap somebody
   *   outside the clinic will ask about.
   */
  | 'PURCHASE_REQUISITION'
  | 'PURCHASE_ORDER'
  | 'GOODS_RECEIPT'
  | 'PURCHASE_RETURN'
  /**
   * Consultations (CE-3). Per BRANCH — the opposite shape from
   * `CLINICAL_EPISODE` above, and deliberately: a journey follows the patient
   * across a hospital group, a consultation happened at ONE site, and the number
   * is printed on the prescription that site hands over.
   *
   * ⚠️ ISSUED AT FINALIZATION, NOT AT OPEN, for the reason the four procurement
   *   counters give. A draft the doctor abandons must burn no number.
   */
  | 'ENCOUNTER'
  /**
   * Dispensing (PI-7). Per BRANCH, issued INSIDE the posting transaction, and it
   * never resets.
   *
   * ⚠️ THE ENUM MEMBER HAS EXISTED SINCE PI-4 AND WAS UNUSED UNTIL NOW — adding
   *   one to a Postgres enum is a migration, and that phase paid for it so this
   *   one would not have to under live stock. This union is the half that was
   *   missing.
   *
   * ⚠️ A DISPENSE HAS NO DRAFT, so "issued when the document leaves draft" — the
   *   rule the four procurement counters follow — collapses here into "issued as
   *   part of the one transaction that supplies". It is taken after every line
   *   has been consulted and planned, so a regulatory refusal or a shortfall
   *   burns no number: a gap in a dispensing series is a gap an inspector asks
   *   about.
   */
  | 'DISPENSE'
  /**
   * Recall notices (PI-10). ⚠️ ORG-WIDE AND NEVER RESETS, unlike every
   *   procurement counter above: a recall reaches every branch at once, so a
   *   per-branch counter would give one notice three different numbers, and the
   *   number is quoted back to a regulator years later.
   *
   * ⚠️ AND IT IS ISSUED AT CREATE, WHICH IS THE OPPOSITE OF THE PROCUREMENT
   *   RULE. A notice EXISTS from the moment it arrives; a draft abandoned after
   *   somebody decided the lot was not affected is a far smaller problem than a
   *   notice nobody can cite while they are still working out what it covers.
   */
  | 'RECALL'
  /**
   * Online orders (PI-12). Per BRANCH and never resets, the shape the four
   * procurement counters have and for the same reason: the number goes on a
   * delivery note somebody outside the clinic reads, so it has to mean one thing
   * for ever.
   *
   * ⚠️ ISSUED AT CONFIRM AND NOT AT CREATE — the procurement rule rather than the
   *   `RECALL` one. An order somebody keys over the telephone and abandons must
   *   burn none, and it is taken after every line has been consulted and held, so
   *   a refusal or a shortfall burns none either.
   */
  | 'ONLINE_ORDER';

export interface IssueNumberSpec {
  type: SequenceType;
  /** Null/undefined for an org-wide counter (UHID). */
  branchId?: string | undefined;
  /**
   * What the counter resets on. `''` never resets; `'2026-27'` is a financial
   * year; `'2026-08-06:<doctorProfileId>'` is one doctor's queue for one day.
   */
  periodKey?: string | undefined;
  /** Rendered into `formatted`. Stored so a later issue reuses it. */
  prefix?: string | undefined;
  /** Zero-padding width for `formatted`. */
  padding?: number | undefined;
}

export interface IssuedNumber {
  /** The raw counter value. Use this for ordering and for a queue token. */
  number: number;
  /** `prefix` + zero-padded number, e.g. `P000042`. */
  formatted: string;
}

interface SequenceRow {
  last_number: bigint;
  prefix: string;
  padding: number;
}

/**
 * Take the next number for a counter, creating the counter if it is the first.
 *
 * Runs on the caller's transaction so the number is rolled back with whatever
 * failed — see the header on why that matters.
 */
export async function issueNumber(
  tx: TxClient,
  ctx: TenantContext,
  spec: IssueNumberSpec
): Promise<IssuedNumber> {
  const branchId = spec.branchId ?? null;
  const periodKey = spec.periodKey ?? '';
  const prefix = spec.prefix ?? '';
  const padding = spec.padding ?? 6;

  /*
   * Raw because Prisma cannot express `DO UPDATE SET x = table.x + 1` — its
   * upsert reads then writes, which is the race this exists to close.
   *
   * `$queryRaw` with interpolated values, never `$queryRawUnsafe` with a
   * built string. `organization_id` is passed explicitly rather than left to
   * RLS: the policy's WITH CHECK would catch a wrong value, but defence in
   * depth is the rule for tenant columns (ADR-0005).
   *
   * The ON CONFLICT target must match a real unique index — it is the
   * NULLS NOT DISTINCT one written by hand in the migration, because
   * `branch_id` is NULL for every org-wide counter and a plain unique index
   * would neither constrain those rows nor serve as an arbiter here.
   *
   * `prefix` and `padding` are only applied on INSERT. A counter that already
   * exists keeps the presentation it was created with, so changing the
   * `patient.uhid_prefix` setting does not silently restyle numbers already
   * issued — and the value that comes back is the one actually stored.
   */
  const rows = await tx.$queryRaw<SequenceRow[]>`
    INSERT INTO number_sequences (
      id, organization_id, branch_id, sequence_type, period_key,
      prefix, padding, last_number, created_at, updated_at
    )
    VALUES (
      gen_random_uuid(), ${ctx.organizationId}::uuid, ${branchId}::uuid,
      ${spec.type}::"NumberSequenceType", ${periodKey},
      ${prefix}, ${padding}, 1, now(), now()
    )
    ON CONFLICT (organization_id, branch_id, sequence_type, period_key)
    DO UPDATE SET last_number = number_sequences.last_number + 1,
                  updated_at  = now()
    RETURNING last_number, prefix, padding
  `;

  const row = rows[0];
  if (!row) {
    /*
     * Unreachable via the happy path: the statement either returns a row or
     * throws. It CAN happen if a branch_isolation policy is ever added to this
     * table — ON CONFLICT DO UPDATE against a row RLS hides updates nothing.
     * That is why the table deliberately has no such policy; this guard names
     * the reason rather than failing as an undefined-property read.
     */
    throw new Error(
      `issueNumber: no row returned for ${spec.type}. Has an RLS policy been added to number_sequences?`
    );
  }

  return {
    number: Number(row.last_number),
    formatted: format(row.prefix, Number(row.last_number), row.padding),
  };
}

function format(prefix: string, value: number, padding: number): string {
  return `${prefix}${String(value).padStart(padding, '0')}`;
}

/**
 * The Indian financial year containing `at`, as `'2026-27'`.
 *
 * April to March. Lives here rather than inline because appointment numbers,
 * and later invoice numbers, must agree on where the year turns — a mismatch
 * would restart one series in the middle of the other's year.
 *
 * ⚠️ Takes the branch-local date, not a UTC instant. The caller converts:
 * a booking at 23:40 IST on 31 March is FY 2025-26, and reading `at` in UTC
 * would file it under the next one.
 */
export function financialYearOf(localDate: Date): string {
  const year = localDate.getUTCFullYear();
  const month = localDate.getUTCMonth(); // 0-based; 3 = April
  const startYear = month >= 3 ? year : year - 1;
  return `${startYear}-${String((startYear + 1) % 100).padStart(2, '0')}`;
}
