/**
 * The rate cards rcln maintains per country, managed by a platform admin.
 *
 * ⚠️ A WRITE HERE CHANGES WHAT EVERY CLINIC IN A COUNTRY CHARGES, IMMEDIATELY.
 *   There is no publish step and no cache. Every clinic that has not overridden
 *   the category inherits these rows at read time, so an edit reaches the next
 *   invoice raised anywhere in that jurisdiction. That is the point of
 *   inheritance — one INSERT when a rate notification lands, instead of a
 *   migration across every tenant — and it is also why a typo here is wrong
 *   invoices at scale rather than a staging curiosity.
 *
 * ⚠️ THIS IS NOT `tax_registrations`, AND THE DIFFERENCE DECIDES HOW CAREFUL TO
 *   BE ABOUT WHICH KIND OF WRONG. A registration is a legal claim that rcln
 *   collects tax somewhere; charging against one that does not exist is money
 *   nobody can remit. A rule default is a statement about a country's law and
 *   affects only clinics that hold their OWN registration. Both are dangerous;
 *   they are dangerous in different directions.
 *
 * ⚠️ REMOVING A RULE IS `effectiveTo`, NOT A DELETE — see `retire`. An invoice
 *   issued last year has to stay explicable, and the row that priced it is the
 *   explanation.
 *
 * `@rcln/db/unsafe` is correct here, as on the rest of the platform router:
 * `tax_rule_defaults` has no `organization_id` to scope by, because a country's
 * published rates are identical for every clinic in it. See the exemption
 * reasoning in enable-rls.sql.
 */

import type {
  CreateTaxRuleDefaultRequest,
  TaxRuleDefaultListResponse,
  TaxRuleDefaultSummary,
  UpdateTaxRuleDefaultRequest,
} from '@rcln/contracts';
import { unsafeDbClient } from '@rcln/db/unsafe';
import { ConflictError, NotFoundError, ValidationError } from '../../utils/errors.js';

/** A `Date` at UTC midnight from `YYYY-MM-DD`, matching the `date` column. */
function toDateOnly(value: string): Date {
  return new Date(`${value}T00:00:00.000Z`);
}

/** `2026-08-10`. The inverse, for the wire. */
function fromDateOnly(value: Date): string {
  return value.toISOString().slice(0, 10);
}

interface Row {
  id: string;
  countryCode: string;
  regionCode: string | null;
  scheme: 'GST' | 'VAT' | 'SALES_TAX';
  taxCategory: string;
  description: string | null;
  rateBps: number;
  treatment: string;
  lineName: string;
  regionalLineName: string | null;
  split: 'NONE' | 'INTRA_STATE_HALVES';
  stacks: boolean;
  sourceNote: string | null;
  effectiveFrom: Date;
  effectiveTo: Date | null;
}

function toSummary(row: Row, at: Date): TaxRuleDefaultSummary {
  return {
    id: row.id,
    countryCode: row.countryCode,
    regionCode: row.regionCode,
    scheme: row.scheme,
    taxCategory: row.taxCategory,
    description: row.description,
    rateBps: row.rateBps,
    treatment: row.treatment as TaxRuleDefaultSummary['treatment'],
    lineName: row.lineName,
    regionalLineName: row.regionalLineName,
    split: row.split,
    stacks: row.stacks,
    sourceNote: row.sourceNote,
    effectiveFrom: fromDateOnly(row.effectiveFrom),
    effectiveTo: row.effectiveTo ? fromDateOnly(row.effectiveTo) : null,
    /*
     * Derived, never stored. A stored `isLive` is a second source of truth that
     * goes stale at midnight without anything writing to the row.
     */
    isLive: row.effectiveFrom <= at && (row.effectiveTo === null || row.effectiveTo >= at),
    jurisdiction: row.regionCode ? `${row.countryCode}-${row.regionCode}` : row.countryCode,
  };
}

/**
 * The invariants the database also enforces, checked here so the caller gets a
 * field-level message instead of a constraint name.
 *
 * ⚠️ Both layers, deliberately. These are the same three CHECK constraints the
 *   table carries — the database is what holds when a row arrives from psql or a
 *   bulk import, and this is what makes the console usable. Neither is redundant
 *   and neither is sufficient.
 */
function assertCoherent(input: {
  treatment?: string | undefined;
  rateBps?: number | undefined;
  stacks?: boolean | undefined;
  regionCode?: string | null | undefined;
  split?: string | undefined;
  lineName?: string | undefined;
}): void {
  if (input.treatment && input.treatment !== 'STANDARD' && (input.rateBps ?? 0) !== 0) {
    throw new ValidationError('An exempt or zero-rated rule must carry a rate of 0.', {
      rateBps: ['Must be 0 unless the treatment is STANDARD.'],
    });
  }

  if (input.stacks === true && !input.regionCode) {
    throw new ValidationError('A stacking rule must name the region it belongs to.', {
      regionCode: [
        'Required when the rule stacks — a country-wide rule that stacked would stack on itself.',
      ],
    });
  }

  if (
    input.split === 'INTRA_STATE_HALVES' &&
    input.lineName &&
    !/^[A-Z]{2,8}$/.test(input.lineName)
  ) {
    throw new ValidationError('A split rule needs a short uppercase line name.', {
      lineName: [
        'The split derives CGST/SGST/IGST by prefixing this, so it must be 2-8 uppercase letters.',
      ],
    });
  }
}

export async function listTaxRuleDefaults(
  countryCode?: string
): Promise<TaxRuleDefaultListResponse> {
  const at = new Date();
  const rows = await unsafeDbClient().taxRuleDefault.findMany({
    where: {
      deletedAt: null,
      ...(countryCode ? { countryCode: countryCode.toUpperCase() } : {}),
    },
    orderBy: [
      { countryCode: 'asc' },
      { taxCategory: 'asc' },
      { regionCode: 'asc' },
      { effectiveFrom: 'desc' },
    ],
  });

  return { defaults: rows.map((row) => toSummary(row, at)) };
}

export async function createTaxRuleDefault(
  input: CreateTaxRuleDefaultRequest
): Promise<TaxRuleDefaultSummary> {
  assertCoherent(input);

  const existing = await unsafeDbClient().taxRuleDefault.findFirst({
    where: {
      countryCode: input.countryCode,
      regionCode: input.regionCode,
      scheme: input.scheme,
      taxCategory: input.taxCategory,
      effectiveFrom: toDateOnly(input.effectiveFrom),
      deletedAt: null,
    },
  });

  if (existing) {
    throw new ConflictError(
      'A default already covers that category and jurisdiction from that date. ' +
        'Edit it, or close it with an end date and add the new rate from the day after — ' +
        'two rules starting on the same day have no defined winner.'
    );
  }

  const created = await unsafeDbClient().taxRuleDefault.create({
    data: {
      countryCode: input.countryCode,
      regionCode: input.regionCode,
      scheme: input.scheme,
      taxCategory: input.taxCategory,
      description: input.description ?? null,
      rateBps: input.rateBps,
      treatment: input.treatment,
      lineName: input.lineName,
      regionalLineName: input.regionalLineName ?? null,
      split: input.split,
      stacks: input.stacks,
      sourceNote: input.sourceNote,
      effectiveFrom: toDateOnly(input.effectiveFrom),
      effectiveTo: input.effectiveTo ? toDateOnly(input.effectiveTo) : null,
    },
  });

  return toSummary(created, new Date());
}

export async function updateTaxRuleDefault(
  id: string,
  input: UpdateTaxRuleDefaultRequest
): Promise<TaxRuleDefaultSummary> {
  const current = await unsafeDbClient().taxRuleDefault.findFirst({
    where: { id, deletedAt: null },
  });
  if (!current) throw new NotFoundError('Tax rule default not found');

  /*
   * Coherence is checked against the MERGED row, not the patch. A request that
   * sets `treatment: 'EXEMPT'` without touching `rateBps` is only invalid in
   * combination with the rate already stored, and validating the patch alone
   * would let it through to the CHECK constraint.
   */
  assertCoherent({
    treatment: input.treatment ?? current.treatment,
    rateBps: input.rateBps ?? current.rateBps,
    stacks: input.stacks ?? current.stacks,
    regionCode: input.regionCode !== undefined ? input.regionCode : current.regionCode,
    split: input.split ?? current.split,
    lineName: input.lineName ?? current.lineName,
  });

  const updated = await unsafeDbClient().taxRuleDefault.update({
    where: { id },
    data: {
      ...(input.countryCode !== undefined ? { countryCode: input.countryCode } : {}),
      ...(input.regionCode !== undefined ? { regionCode: input.regionCode } : {}),
      ...(input.scheme !== undefined ? { scheme: input.scheme } : {}),
      ...(input.taxCategory !== undefined ? { taxCategory: input.taxCategory } : {}),
      ...(input.description !== undefined ? { description: input.description } : {}),
      ...(input.rateBps !== undefined ? { rateBps: input.rateBps } : {}),
      ...(input.treatment !== undefined ? { treatment: input.treatment } : {}),
      ...(input.lineName !== undefined ? { lineName: input.lineName } : {}),
      ...(input.regionalLineName !== undefined ? { regionalLineName: input.regionalLineName } : {}),
      ...(input.split !== undefined ? { split: input.split } : {}),
      ...(input.stacks !== undefined ? { stacks: input.stacks } : {}),
      ...(input.sourceNote !== undefined ? { sourceNote: input.sourceNote } : {}),
      ...(input.effectiveFrom !== undefined
        ? { effectiveFrom: toDateOnly(input.effectiveFrom) }
        : {}),
      ...(input.effectiveTo !== undefined
        ? { effectiveTo: input.effectiveTo ? toDateOnly(input.effectiveTo) : null }
        : {}),
    },
  });

  return toSummary(updated, new Date());
}

/**
 * Stop charging a default from a date. NOT a delete.
 *
 * ⚠️ THE ONE OPERATION THAT LOOKS LIKE A DELETE AND MUST NOT BE ONE.
 *   An invoice issued last March has to stay explicable for as long as the
 *   clinic's retention obligation runs, and the row that priced it IS the
 *   explanation. Removing it does not un-charge the tax; it only makes the
 *   charge unaccountable, and the person who needs the answer is an auditor
 *   years later rather than the admin clicking the button.
 *
 *   `deletedAt` exists on the model for a genuine mistake — a row created in
 *   error that never priced anything — and is not reachable from here on
 *   purpose. Retiring is what a rate ending looks like.
 */
export async function retireTaxRuleDefault(
  id: string,
  effectiveTo: string
): Promise<TaxRuleDefaultSummary> {
  const current = await unsafeDbClient().taxRuleDefault.findFirst({
    where: { id, deletedAt: null },
  });
  if (!current) throw new NotFoundError('Tax rule default not found');

  const end = toDateOnly(effectiveTo);
  if (end < current.effectiveFrom) {
    throw new ValidationError('A rule cannot end before it began.', {
      effectiveTo: ['Must be on or after the date the rule took effect.'],
    });
  }

  const updated = await unsafeDbClient().taxRuleDefault.update({
    where: { id },
    data: { effectiveTo: end },
  });

  return toSummary(updated, new Date());
}
