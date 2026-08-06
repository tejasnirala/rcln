/**
 * Where rcln is registered to collect tax, managed by a platform admin.
 *
 * ⚠️ EVERY WRITE HERE CHANGES WHAT CUSTOMERS ARE CHARGED, IMMEDIATELY.
 *   There is no publish step and no cache. The tax engine reads this table on
 *   every invoice, so adding a row starts charging tax on the next checkout and
 *   removing one stops it. That is deliberate — registering with an authority is
 *   a real-world event with a date, and the console should reflect it the moment
 *   it happens — but it means a typo in a rate is a wrong invoice, not a
 *   staging-environment curiosity.
 *
 * ⚠️ AND IT IS A LEGAL ASSERTION, NOT A PREFERENCE.
 *   Tax collected in a jurisdiction we are not registered in cannot be remitted,
 *   because there is nobody to remit it to. Refunding it afterwards does not
 *   undo having collected it. The screen says this; it is repeated here because
 *   this file is where somebody will add a bulk import.
 *
 * `@rcln/db/unsafe` is correct here, as on the rest of the platform router:
 * `tax_registrations` describes the SUPPLIER and has no `organization_id` to
 * scope by. See the exemption reasoning in enable-rls.sql.
 */

import type {
  CreateTaxRegistrationRequest,
  TaxRegistrationListResponse,
  TaxRegistrationSummary,
  UpdateTaxRegistrationRequest,
} from '@rcln/contracts';
import { unsafeDbClient } from '@rcln/db/unsafe';
import { ConflictError, NotFoundError } from '../../utils/errors.js';

/** A `Date` at UTC midnight from `YYYY-MM-DD`, matching the `date` column. */
function toDateOnly(value: string): Date {
  return new Date(`${value}T00:00:00.000Z`);
}

/** `2026-08-06`. The inverse, for the wire. */
function fromDateOnly(value: Date): string {
  return value.toISOString().slice(0, 10);
}

interface Row {
  id: string;
  countryCode: string;
  regionCode: string | null;
  scheme: 'GST' | 'VAT' | 'SALES_TAX';
  registrationNumber: string;
  standardRateBps: number;
  effectiveFrom: Date;
  effectiveTo: Date | null;
}

function toSummary(row: Row, at: Date): TaxRegistrationSummary {
  return {
    id: row.id,
    countryCode: row.countryCode,
    regionCode: row.regionCode,
    scheme: row.scheme,
    registrationNumber: row.registrationNumber,
    standardRateBps: row.standardRateBps,
    effectiveFrom: fromDateOnly(row.effectiveFrom),
    effectiveTo: row.effectiveTo ? fromDateOnly(row.effectiveTo) : null,
    /*
     * Derived, never stored. A registration that starts next month is a real and
     * useful row — it is how you set one up in advance — and it must read as not
     * yet applying rather than as live. The engine applies exactly the same date
     * test, so this cannot disagree with what is actually charged.
     */
    isLive: row.effectiveFrom <= at && (row.effectiveTo === null || row.effectiveTo >= at),
    placeOfSupply: row.regionCode ? `${row.countryCode}-${row.regionCode}` : row.countryCode,
  };
}

/**
 * The unique index on `(country_code, region_code, scheme)` doing its job.
 *
 * Shape-checked rather than `instanceof`, matching webhook.service.ts: the error
 * class is re-exported through the generated client and an `instanceof` breaks
 * whenever two copies of the client end up in the graph.
 */
function isUniqueViolation(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'P2002';
}

function conflict(input: { countryCode?: string; regionCode?: string | null }): ConflictError {
  const place = input.regionCode ? `${input.countryCode}-${input.regionCode}` : input.countryCode;
  return new ConflictError(
    `A registration for ${place ?? 'that jurisdiction'} already exists under this scheme. ` +
      'Edit it rather than adding a second — two registrations for one place would be ' +
      'picked between arbitrarily.'
  );
}

export async function listTaxRegistrations(at = new Date()): Promise<TaxRegistrationListResponse> {
  const rows = await unsafeDbClient().taxRegistration.findMany({
    where: { deletedAt: null },
    // Country first, then country-wide before its regions: it reads as a
    // hierarchy, which is what it is.
    orderBy: [{ countryCode: 'asc' }, { regionCode: 'asc' }],
  });

  return { registrations: rows.map((row) => toSummary(row, at)) };
}

export async function createTaxRegistration(
  input: CreateTaxRegistrationRequest,
  at = new Date()
): Promise<TaxRegistrationSummary> {
  try {
    const row = await unsafeDbClient().taxRegistration.create({
      data: {
        countryCode: input.countryCode,
        regionCode: input.regionCode,
        scheme: input.scheme,
        registrationNumber: input.registrationNumber,
        standardRateBps: input.standardRateBps,
        effectiveFrom: toDateOnly(input.effectiveFrom),
        effectiveTo: input.effectiveTo ? toDateOnly(input.effectiveTo) : null,
      },
    });

    return toSummary(row, at);
  } catch (error) {
    if (isUniqueViolation(error)) throw conflict(input);
    throw error;
  }
}

export async function updateTaxRegistration(
  id: string,
  input: UpdateTaxRegistrationRequest,
  at = new Date()
): Promise<TaxRegistrationSummary> {
  const existing = await unsafeDbClient().taxRegistration.findFirst({
    where: { id, deletedAt: null },
  });
  if (!existing) throw new NotFoundError('That tax registration does not exist');

  try {
    const row = await unsafeDbClient().taxRegistration.update({
      where: { id },
      data: {
        ...(input.countryCode !== undefined ? { countryCode: input.countryCode } : {}),
        // `null` is a meaningful value here — it widens a state registration to
        // the whole country — so it is distinguished from "not mentioned".
        ...(input.regionCode !== undefined ? { regionCode: input.regionCode } : {}),
        ...(input.scheme !== undefined ? { scheme: input.scheme } : {}),
        ...(input.registrationNumber !== undefined
          ? { registrationNumber: input.registrationNumber }
          : {}),
        ...(input.standardRateBps !== undefined ? { standardRateBps: input.standardRateBps } : {}),
        ...(input.effectiveFrom !== undefined
          ? { effectiveFrom: toDateOnly(input.effectiveFrom) }
          : {}),
        ...(input.effectiveTo !== undefined
          ? { effectiveTo: input.effectiveTo ? toDateOnly(input.effectiveTo) : null }
          : {}),
      },
    });

    return toSummary(row, at);
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw conflict({
        countryCode: input.countryCode ?? existing.countryCode,
        regionCode: input.regionCode ?? existing.regionCode,
      });
    }
    throw error;
  }
}

/**
 * Retire a registration.
 *
 * SOFT, and that is not a house-style tic. Invoices already issued under this
 * registration carry its number, and somebody reconciling a return next year has
 * to be able to find out what it was. `deleted_at` also takes it out of the
 * engine's lookup immediately, which is the operational effect wanted.
 *
 * To stop collecting from a date without erasing the history, set `effectiveTo`
 * instead — that is the honest tool for "we deregistered", and the screen offers
 * it first.
 */
export async function deleteTaxRegistration(id: string): Promise<void> {
  const existing = await unsafeDbClient().taxRegistration.findFirst({
    where: { id, deletedAt: null },
    select: { id: true },
  });
  if (!existing) throw new NotFoundError('That tax registration does not exist');

  await unsafeDbClient().taxRegistration.update({
    where: { id },
    data: { deletedAt: new Date() },
  });
}
