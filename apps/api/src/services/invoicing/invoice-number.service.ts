/**
 * Patient invoice serials: `INV-{PERIOD_YEAR}-{SOURCE}-{BRANCH_CODE}-{000001}`.
 *
 * The only code that builds an `INVOICE` sequence key. Everything about the
 * shape of an invoice number is decided here and nowhere else, because a number
 * built two ways is two series.
 *
 * ⚠️ THE SERIES IS PER BRANCH, AND THE BRANCH CODE IS IN THE NUMBER.
 *   GST requires a serial that is consecutive and unique per ISSUER, and the
 *   issuer is the registration — in India, one per state. A per-branch counter
 *   without a per-branch discriminator gives two branches sharing one GSTIN two
 *   different invoices both numbered `INV-2026-APP-000001`. Several series under
 *   one registration are allowed; a repeated number is not. Branch codes are
 *   org-unique, so the whole string is unique across the organization — which is
 *   stronger than the law asks and is what `invoices.invoice_number`'s unique
 *   index relies on.
 *
 * ⚠️ THE RESET CADENCE IS LOOKED UP, NEVER ASSUMED.
 *   India's GST series runs on the financial year (April–March); most of the
 *   world runs on the calendar year. Hard-coding either is the "do not assume
 *   India" failure in one direction or the other, and it is not correctable
 *   after numbers have been issued. The branch's `country_code` decides.
 *
 * ⚠️ THE PRINTED YEAR IS THE START YEAR OF THE PERIOD.
 *   An Indian invoice issued in February 2027 inside FY 2026-27 reads
 *   `INV-2026-…`. A number that flipped to `INV-2027-` on 1 January would split
 *   one financial year's series in two, and the return covers the year.
 *
 * ⚠️ CALL THIS AT FINALISATION, NOT AT CREATION.
 *   `issueNumber` holds a row lock until COMMIT. Taking a number when a draft is
 *   created would both serialise every open till at the branch and burn a serial
 *   on every draft the cashier abandons — a permanent gap in a series somebody
 *   may have to explain to an auditor years later. `invoices.invoice_number` is
 *   nullable, and the `invoices_number_matches_status` CHECK is what makes that
 *   an invariant rather than a habit.
 */
import type { TenantContext, TxClient } from '@rcln/db';

import { NotFoundError } from '../../utils/errors.js';
import {
  financialYearOf,
  issueNumber,
  type IssuedNumber,
} from '../numbering/number-sequence.service.js';

/**
 * The `{SOURCE}` segment, per source type.
 *
 * ⚠️ THESE STRINGS ARE PERMANENT. They are printed on documents a clinic files
 *   returns against, so renaming one splits a live series in two: the counter is
 *   keyed by the code, so a new code starts again at 1 while old invoices keep
 *   the old one. Four of the seven have nothing writing them yet — the lab,
 *   pharmacy and inventory modules do not exist — and they are mapped anyway so
 *   those modules land as integrations rather than as a numbering change.
 */
const SOURCE_CODES = {
  APPOINTMENT: 'APP',
  PROCEDURE: 'PRO',
  SERVICE: 'SRV',
  LAB: 'LAB',
  PHARMACY: 'PHA',
  INVENTORY: 'INV',
  OTHER: 'OTH',
} as const;

export type InvoiceSourceType = keyof typeof SOURCE_CODES;

/**
 * The document prefix, per kind (PI-8).
 *
 * ⚠️ A CREDIT NOTE IS ITS OWN SERIES AND THAT IS THE PART THE LAW REQUIRES. One
 *   table holds both documents — see `InvoiceKind` for why — but under GST a
 *   credit note is a distinct document with its own consecutive, unique number,
 *   and the same is true in every other jurisdiction on this platform's roadmap.
 *   Sharing a counter would interleave the two series and make neither
 *   contiguous, which is the one thing a statutory series may not be.
 *
 * ⚠️ THESE STRINGS ARE PERMANENT, for the reason `SOURCE_CODES` are: they are
 *   printed on documents a clinic files returns against, and renaming one splits
 *   a live series in two.
 */
const KIND_PREFIXES = {
  INVOICE: 'INV',
  CREDIT_NOTE: 'CRN',
} as const;

export type InvoiceKind = keyof typeof KIND_PREFIXES;

/**
 * Countries whose statutory reporting year is not the calendar year.
 *
 * Deliberately a narrow list rather than a general calendar library: every entry
 * is a jurisdiction whose INVOICE SERIES is required to run on that year, which
 * is a much smaller set than the countries with an offset tax year. India is the
 * one this engine has actually been reasoned about for; the rest of the world
 * gets the calendar year, which is the honest default rather than a guess.
 */
const FINANCIAL_YEAR_COUNTRIES = new Set(['IN']);

export interface InvoiceNumberSpec {
  branchId: string;
  sourceType: InvoiceSourceType;
  /**
   * A charge or a reversal. Defaults to `INVOICE`, which is what every caller
   * written before PI-8 means and is why they did not have to change.
   */
  kind?: InvoiceKind;
  /**
   * The instant the invoice is being issued at. Converted to the BRANCH's local
   * date before the period is derived — an invoice raised at 23:40 IST on 31
   * March belongs to the financial year that ends that day, and reading the
   * instant in UTC would file it under the next one.
   */
  issuedAt: Date;
}

/**
 * Take the next invoice number for a branch, source and period.
 *
 * Runs on the caller's transaction, so a finalisation that rolls back takes the
 * number with it and the series stays gapless.
 */
export async function issueInvoiceNumber(
  tx: TxClient,
  ctx: TenantContext,
  spec: InvoiceNumberSpec
): Promise<IssuedNumber> {
  const branch = await resolveBranch(tx, ctx, spec.branchId);
  const localDate = await branchLocalDateParts(tx, spec.branchId, spec.issuedAt);

  const period = periodFor(branch.countryCode, localDate);
  const sourceCode = SOURCE_CODES[spec.sourceType];
  const kind = spec.kind ?? 'INVOICE';
  const kindPrefix = KIND_PREFIXES[kind];

  return issueNumber(tx, ctx, {
    type: 'INVOICE',
    branchId: spec.branchId,
    /*
     * The source lives in the period key rather than in a column of its own,
     * because `number_sequences` is keyed by (org, branch, type, period) and
     * that is the whole counter identity. One key per (period, source) is one
     * counter per series, which is exactly what is wanted.
     *
     * ⚠️ A CREDIT NOTE ADDS A SEGMENT RATHER THAN REPLACING ONE, AND AN INVOICE
     *   ADDS NOTHING. `'2026-27:PHA'` stays exactly the string it has always
     *   been, so no existing counter is re-keyed and no live series restarts at
     *   1 — which is what would happen if this became `'2026-27:INVOICE:PHA'`
     *   for everybody. The credit note takes the new key `'2026-27:CN:PHA'`,
     *   which no row has ever held, so its series starts at 1 correctly.
     */
    periodKey:
      kind === 'INVOICE' ? `${period.key}:${sourceCode}` : `${period.key}:CN:${sourceCode}`,
    prefix: `${kindPrefix}-${period.startYear}-${sourceCode}-${branch.code}-`,
  });
}

/** The period a date falls in, and the year that goes in the printed number. */
export function periodFor(
  countryCode: string,
  localDate: Date
): { key: string; startYear: number } {
  if (FINANCIAL_YEAR_COUNTRIES.has(countryCode)) {
    const key = financialYearOf(localDate);
    // '2026-27' -> 2026. The start year, for the reason in the file header.
    return { key, startYear: Number(key.slice(0, 4)) };
  }

  const year = localDate.getUTCFullYear();
  return { key: String(year), startYear: year };
}

async function resolveBranch(
  tx: TxClient,
  ctx: TenantContext,
  branchId: string
): Promise<{ code: string; countryCode: string }> {
  const branch = await tx.branch.findFirst({
    where: { id: branchId, organizationId: ctx.organizationId },
    select: { code: true, countryCode: true },
  });

  /*
   * Under RLS another tenant's branch id is indistinguishable from one that does
   * not exist, and both answers are the same: there is no series to issue from.
   * Falling back to the organization — its country, a default code — would print
   * a plausible number on the wrong series. Same call `loadTaxContext` makes.
   */
  if (!branch) throw new NotFoundError('Branch');
  return branch;
}

/**
 * The branch-local calendar date of an instant, as a UTC-midnight `Date`.
 *
 * ⚠️ RESOLVED IN POSTGRES FROM `branches.timezone`, NOT IN NODE. The container's
 *   zone is UTC and the browser's is the user's; neither is the clinic's. Reading
 *   the instant directly would put a 23:40 IST invoice on 31 March into the next
 *   financial year — one row in the wrong return, discovered by an accountant.
 *
 * Returned at UTC midnight so `financialYearOf`, which reads UTC parts by
 * contract, sees the branch-local day rather than the instant.
 */
async function branchLocalDateParts(tx: TxClient, branchId: string, instant: Date): Promise<Date> {
  const rows = await tx.$queryRaw<{ local_date: string }[]>`
    SELECT to_char((${instant}::timestamptz AT TIME ZONE b.timezone)::date, 'YYYY-MM-DD') AS local_date
      FROM branches b
     WHERE b.id = ${branchId}::uuid
  `;
  const row = rows[0];
  if (!row) throw new NotFoundError('Branch');
  return new Date(`${row.local_date}T00:00:00.000Z`);
}
