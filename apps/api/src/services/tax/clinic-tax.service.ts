/**
 * A clinic's own tax configuration: the registrations it holds and the rates it
 * charges.
 *
 * ⚠️ THIS IS THE FIRST WRITE PATH `issuer_tax_registrations` AND `tax_rules` HAVE
 *   EVER HAD. Phase 2 created both tables and the engine has been reading them
 *   since; nothing in the product wrote to either, so every clinic on the
 *   platform has been running entirely on rcln's published catalogue. That is a
 *   defensible default and it is not a configuration: a clinic below the
 *   registration threshold issues invoices with no tax and no registration, and
 *   until now a clinic ABOVE it had no way to say so.
 *
 * ⚠️ EVERYTHING HERE IS ORGANIZATION-SCOPED THROUGH `withTenant`, INCLUDING THE
 *   READS OF THE PLATFORM CATALOGUE. `tax_rule_defaults` is RLS-EXEMPT — it holds
 *   a country's published law, identical for everybody in it — and is read inside
 *   the same transaction, exactly as `loadTaxContext` does. A policy on it would
 *   return zero rows for every clinic and no invoice on the platform could be
 *   priced.
 *
 * ⚠️ THE PRECEDENCE RULE IS NOT RESTATED HERE. `rulesFor` in `@rcln/tax` decides
 *   which rows price an item, all-or-nothing per tax category, and this file asks
 *   it rather than reimplementing it. A second copy of that decision is how a
 *   screen starts telling a clinic it charges something the engine does not.
 *
 * ⚠️ AND A RATE CHANGE IS A NEW ROW, NOT AN EDIT. Both ends of the effective
 *   dates are inclusive, so a rate ending is `effectiveTo` on the old row and a
 *   new row from the day after. `assertNoPricingChange` refuses an edit that
 *   would move the RATE on a rule an issued invoice was priced under — the
 *   invoice's own totals are frozen at the database, so the document stays
 *   correct while the explanation of it silently stops matching, which is the
 *   worst of the available failures.
 */
import type {
  ClinicTaxRegistrationSummary,
  ClinicTaxRuleSummary,
  CreateClinicTaxRegistrationRequest,
  CreateClinicTaxRuleRequest,
  ListClinicTaxRulesQuery,
  SetClinicTaxRegistrationBranchesRequest,
  TaxCategoryCard,
  TaxRateCardResponse,
  TaxRegistrationStatus,
  UpdateClinicTaxRegistrationRequest,
  UpdateClinicTaxRuleRequest,
} from '@rcln/contracts';
import { withTenant, type TenantContext, type TxClient } from '@rcln/db';
import { rulesFor, type TaxRule as EngineTaxRule } from '@rcln/tax';

import { recordAudit } from '../audit/audit.service.js';
import { ConflictError, NotFoundError, ValidationError } from '../../utils/errors.js';

/** Request metadata carried onto the audit row. Same shape as every service. */
export interface ClinicTaxActionOptions {
  ipAddress?: string | undefined;
  userAgent?: string | undefined;
}

/** A `Date` at UTC midnight from `YYYY-MM-DD`, matching the `date` column. */
function toDateOnly(value: string): Date {
  return new Date(`${value}T00:00:00.000Z`);
}

/** `2026-08-10`. The inverse, for the wire. */
function fromDateOnly(value: Date): string {
  return value.toISOString().slice(0, 10);
}

const REGISTRATION_SELECT = {
  id: true,
  countryCode: true,
  regionCode: true,
  scheme: true,
  registrationNumber: true,
  legalName: true,
  effectiveFrom: true,
  effectiveTo: true,
} as const;

const RULE_SELECT = {
  id: true,
  countryCode: true,
  regionCode: true,
  scheme: true,
  taxCategory: true,
  description: true,
  rateBps: true,
  treatment: true,
  lineName: true,
  regionalLineName: true,
  split: true,
  stacks: true,
  effectiveFrom: true,
  effectiveTo: true,
} as const;

type RegistrationRow = {
  id: string;
  countryCode: string;
  regionCode: string | null;
  scheme: string;
  registrationNumber: string;
  legalName: string | null;
  effectiveFrom: Date;
  effectiveTo: Date | null;
};

type RuleRow = {
  id: string;
  countryCode: string;
  regionCode: string | null;
  scheme: string;
  taxCategory: string;
  description: string | null;
  rateBps: number;
  treatment: string;
  lineName: string;
  regionalLineName: string | null;
  split: string;
  stacks: boolean;
  effectiveFrom: Date;
  effectiveTo: Date | null;
};

const jurisdictionOf = (countryCode: string, regionCode: string | null): string =>
  regionCode ? `${countryCode}-${regionCode}` : countryCode;

/** Live means today falls inside the range, both ends inclusive. */
const isLiveAt = (row: { effectiveFrom: Date; effectiveTo: Date | null }, at: Date): boolean =>
  row.effectiveFrom <= at && (row.effectiveTo === null || row.effectiveTo >= at);

/**
 * SCHEDULED before it starts, ACTIVE while it runs, LAPSED once it has ended.
 *
 * Derived from the same two dates as `isLive` rather than stored, for the same
 * reason: a stored status is wrong from the midnight after somebody set it.
 */
function statusAt(
  row: { effectiveFrom: Date; effectiveTo: Date | null },
  at: Date
): TaxRegistrationStatus {
  if (row.effectiveFrom > at) return 'SCHEDULED';
  if (row.effectiveTo !== null && row.effectiveTo < at) return 'LAPSED';
  return 'ACTIVE';
}

/** A branch as the coverage calculation needs it. */
type BranchRow = { id: string; name: string; countryCode: string; regionCode: string | null };

/**
 * The branches a registration would cover if nobody said otherwise.
 *
 * ⚠️ THE ENGINE'S RULE, RESTATED IN ONE PLACE AND CALLED FROM BOTH SIDES. It has
 *   to agree exactly with `registrationFor` in `@rcln/tax`, or the coverage
 *   screen describes a selection the invoice does not make.
 */
const matchesJurisdiction = (branch: BranchRow, row: RegistrationRow): boolean =>
  branch.countryCode === row.countryCode &&
  (row.regionCode === null || branch.regionCode === row.regionCode);

function toRegistrationSummary(
  row: RegistrationRow,
  at: Date,
  branches: BranchRow[],
  /** Branch ids explicitly assigned to THIS registration. Empty means none were. */
  assignedBranchIds: ReadonlySet<string>,
  /**
   * Every branch that has stated coverage for SOME registration. A branch in here
   * but not in `assignedBranchIds` is one that has chosen a different
   * registration, so this one must not claim it back by geography.
   */
  branchesWithCoverage: ReadonlySet<string>
): ClinicTaxRegistrationSummary {
  /*
   * ⚠️ A STATEMENT IS EXHAUSTIVE; GEOGRAPHY APPLIES ONLY WHERE NOBODY HAS SPOKEN.
   *
   *   Two rules, and they have to be exactly the two `loadTaxContext` uses when
   *   it decides what the engine may price against, or this screen describes a
   *   selection the invoice does not make:
   *
   *     - A registration that HAS assignments covers those branches and no
   *       others. Not "those plus any in the same state": once a clinic has said
   *       which places bill under this number, adding the neighbours back by
   *       geography contradicts it.
   *     - A registration with NO assignments covers the branches that have made
   *       no statement of their own and whose place of supply matches. The second
   *       half of that is what keeps the mixed shape coherent — a branch already
   *       assigned to another registration has an answer, and this one must not
   *       claim it back merely for being in the same state.
   *
   *   The consequence worth noticing: opening a new branch in a state that
   *   already has a registration still picks it up automatically, because the new
   *   branch has stated nothing. Adding a branch to a configured clinic does not
   *   silently stop it charging tax.
   */
  const covered =
    assignedBranchIds.size > 0
      ? branches.filter((branch) => assignedBranchIds.has(branch.id))
      : branches.filter(
          (branch) => !branchesWithCoverage.has(branch.id) && matchesJurisdiction(branch, row)
        );

  return {
    id: row.id,
    countryCode: row.countryCode,
    regionCode: row.regionCode,
    scheme: row.scheme as ClinicTaxRegistrationSummary['scheme'],
    registrationNumber: row.registrationNumber,
    legalName: row.legalName,
    effectiveFrom: fromDateOnly(row.effectiveFrom),
    effectiveTo: row.effectiveTo ? fromDateOnly(row.effectiveTo) : null,
    // Derived, never stored: a stored flag goes stale at midnight with nothing
    // writing to the row.
    isLive: isLiveAt(row, at),
    status: statusAt(row, at),
    placeOfSupply: jurisdictionOf(row.countryCode, row.regionCode),
    /*
     * ⚠️ AN EMPTY LIST UNDER `JURISDICTION` IS THE COMMONEST CONFIGURATION
     *   MISTAKE, MADE VISIBLE. A Karnataka GSTIN nobody has assigned covers
     *   nothing at all if every branch is recorded in Maharashtra, and the failure
     *   is silent: invoices issue with no tax and no error, because "this clinic
     *   holds no registration here" is a legitimate answer the engine cannot tell
     *   apart from a typo in a region code. Naming the branches — or naming none —
     *   puts that on the screen where it is fixed.
     */
    coveredBranches: covered.map((branch) => ({ id: branch.id, name: branch.name })),
    coverageMode: assignedBranchIds.size > 0 ? 'EXPLICIT' : 'JURISDICTION',
  };
}

function toRuleSummary(row: RuleRow, at: Date, usedIds: Set<string>): ClinicTaxRuleSummary {
  return {
    id: row.id,
    countryCode: row.countryCode,
    regionCode: row.regionCode,
    scheme: row.scheme as ClinicTaxRuleSummary['scheme'],
    taxCategory: row.taxCategory,
    description: row.description,
    rateBps: row.rateBps,
    /*
     * The CHECK constraint `tax_rules_treatment_is_item_level` is what makes this
     * cast safe: the column is the full enum because Prisma cannot express a
     * subset of one, and the database refuses anything outside the three
     * item-level values.
     */
    treatment: row.treatment as ClinicTaxRuleSummary['treatment'],
    lineName: row.lineName,
    regionalLineName: row.regionalLineName,
    split: row.split as ClinicTaxRuleSummary['split'],
    stacks: row.stacks,
    effectiveFrom: fromDateOnly(row.effectiveFrom),
    effectiveTo: row.effectiveTo ? fromDateOnly(row.effectiveTo) : null,
    isLive: isLiveAt(row, at),
    jurisdiction: jurisdictionOf(row.countryCode, row.regionCode),
    usedOnIssuedInvoices: usedIds.has(row.id),
  };
}

/**
 * The invariants the database also enforces, checked here so a caller gets a
 * field-level message instead of a constraint name.
 *
 * ⚠️ BOTH LAYERS, DELIBERATELY, AND NEITHER IS REDUNDANT. These are the same
 *   three CHECK constraints the table carries: the database is what holds when a
 *   row arrives from psql or a bulk import, and this is what makes the screen
 *   usable. The same arrangement the platform's own rule service uses.
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

/**
 * Which of this organization's rules have priced an invoice that was issued.
 *
 * ⚠️ ISSUED, NOT ANY. A draft that cites a rule is being worked on and its
 *   numbers are re-derived on every save, so a rate correction reaches it
 *   correctly. An ISSUED invoice's totals are frozen at the database and the
 *   patient may be holding a copy — the rule is the account of what that document
 *   charged, and changing the rate under it makes the document unexplainable
 *   rather than wrong.
 */
async function rulesBehindIssuedInvoices(tx: TxClient, ctx: TenantContext): Promise<Set<string>> {
  const rows = await tx.invoiceTax.findMany({
    where: {
      organizationId: ctx.organizationId,
      taxRuleId: { not: null },
      // A cancelled draft never had a number; a VOID invoice did and still
      // counts, because the reversal has to stay as explicable as the original.
      invoice: { status: { in: ['ISSUED', 'PARTIALLY_PAID', 'PAID', 'VOID'] } },
    },
    select: { taxRuleId: true },
    distinct: ['taxRuleId'],
  });

  return new Set(rows.flatMap((row) => (row.taxRuleId === null ? [] : [row.taxRuleId])));
}

// ---------------------------------------------------------------------------
// The organization's own number, kept in step
// ---------------------------------------------------------------------------

/**
 * Recompute `organizations.tax_id` from the registrations, and write it if it
 * moved.
 *
 * ⚠️ WHY THE COLUMN STILL EXISTS AT ALL, GIVEN THE REGISTRATION IS AUTHORITATIVE.
 *   It answers a genuinely different question: not "what does this clinic print
 *   on ITS invoices?" but "what number does RCLN put on the subscription invoice
 *   it raises AGAINST this clinic, and is that clinic reverse-charged?". The
 *   subscription side has one customer and needs one number, and it must not
 *   start reasoning about coverage and effective dates to find it.
 *
 * ⚠️ WHAT CHANGED IS THAT NOBODY TYPES IT ANY MORE. Two independently maintained
 *   copies of one GSTIN is how a clinic ends up displaying one number on its
 *   settings screen and printing another on every invoice, permanently, with
 *   nothing anywhere to reconcile them. So this is a cache with exactly one
 *   writer, and the organization API no longer accepts the field.
 *
 * WHICH REGISTRATION IS "THE ORGANIZATION'S"
 *   The one that covers the primary branch, if the clinic has stated or implied
 *   one — that is the place the business is actually run from. Failing that, one
 *   matching the organization's own jurisdiction. Failing that, the only live one
 *   there is. And if several live registrations remain and none of them is
 *   distinguished, the answer is genuinely ambiguous: the column is left as it
 *   was rather than picking, because a wrong number here is charged VAT the
 *   clinic cannot reclaim.
 */
async function syncOrganizationTaxIdentity(tx: TxClient, ctx: TenantContext): Promise<void> {
  const at = new Date();

  const [organization, live, primaryBranch] = await Promise.all([
    tx.organization.findFirst({
      where: { id: ctx.organizationId },
      select: { taxId: true, countryCode: true, regionCode: true },
    }),
    tx.issuerTaxRegistration.findMany({
      where: {
        deletedAt: null,
        effectiveFrom: { lte: at },
        OR: [{ effectiveTo: null }, { effectiveTo: { gte: at } }],
      },
      select: { id: true, countryCode: true, regionCode: true, registrationNumber: true },
      orderBy: { effectiveFrom: 'desc' },
    }),
    tx.branch.findFirst({
      where: { isPrimary: true, deletedAt: null },
      select: { id: true, countryCode: true, regionCode: true },
    }),
  ]);

  if (!organization) return;

  const resolved = await (async (): Promise<string | null> => {
    if (live.length === 0) return null;

    if (primaryBranch) {
      const stated = await tx.issuerTaxRegistrationBranch.findMany({
        where: { branchId: primaryBranch.id, deletedAt: null },
        select: { taxRegistrationId: true },
      });
      const statedIds = new Set(stated.map((row) => row.taxRegistrationId));

      // Stated coverage first, then the same jurisdiction rule the engine would
      // fall back to for that branch. Both are "what the head office bills under".
      const forPrimary =
        live.find((row) => statedIds.has(row.id)) ??
        (statedIds.size > 0
          ? undefined
          : live.find(
              (row) =>
                row.countryCode === primaryBranch.countryCode &&
                (row.regionCode === null || row.regionCode === primaryBranch.regionCode)
            ));
      if (forPrimary) return forPrimary.registrationNumber;
    }

    const forOrganization = live.find(
      (row) =>
        row.countryCode === organization.countryCode &&
        (row.regionCode === null || row.regionCode === organization.regionCode)
    );
    if (forOrganization) return forOrganization.registrationNumber;

    return live.length === 1 ? (live[0]?.registrationNumber ?? null) : organization.taxId;
  })();

  if (resolved === organization.taxId) return;

  await tx.organization.update({
    where: { id: ctx.organizationId },
    data: {
      taxId: resolved,
      /*
       * ⚠️ THE STATUS IS ABOUT A NUMBER, SO A NEW NUMBER INVALIDATES IT. Carrying
       *   `VALID` across a change would claim we checked this registration with
       *   the authority when what we checked was the one before it — and that
       *   claim decides whether the clinic is reverse-charged or billed VAT.
       */
      taxIdStatus: resolved === null ? 'NOT_PROVIDED' : 'UNVALIDATED',
    },
  });
}

// ---------------------------------------------------------------------------
// Registrations
// ---------------------------------------------------------------------------

/**
 * Everything the summaries need that is not on the registration row: the
 * branches, and who has stated coverage for what.
 *
 * One read for the whole set rather than one per registration — the coverage of
 * any single registration is only interpretable against every OTHER
 * registration's coverage, because a branch that has chosen elsewhere must not be
 * claimed back by geography.
 */
async function loadCoverageState(tx: TxClient): Promise<{
  branches: BranchRow[];
  byRegistration: Map<string, Set<string>>;
  branchesWithCoverage: Set<string>;
}> {
  const [branches, links] = await Promise.all([
    tx.branch.findMany({
      where: { deletedAt: null },
      select: { id: true, name: true, countryCode: true, regionCode: true },
      orderBy: { name: 'asc' },
    }),
    tx.issuerTaxRegistrationBranch.findMany({
      where: { deletedAt: null },
      select: { taxRegistrationId: true, branchId: true },
    }),
  ]);

  const byRegistration = new Map<string, Set<string>>();
  const branchesWithCoverage = new Set<string>();

  for (const link of links) {
    const set = byRegistration.get(link.taxRegistrationId) ?? new Set<string>();
    set.add(link.branchId);
    byRegistration.set(link.taxRegistrationId, set);
    branchesWithCoverage.add(link.branchId);
  }

  return { branches, byRegistration, branchesWithCoverage };
}

const EMPTY_COVERAGE: ReadonlySet<string> = new Set<string>();

/**
 * Every registration this clinic holds — current, scheduled and lapsed.
 *
 * ⚠️ THE LAPSED ONES ARE RETURNED ON PURPOSE. A registration that ended is not a
 *   row to hide: an invoice raised today for a consultation given under it must
 *   still cite it, and a clinic that has changed its number needs to see the one
 *   it replaced. `status` is what a screen filters on.
 *
 * Ordered newest-first within a jurisdiction, so the registration in force reads
 * above the ones it succeeded.
 */
export async function listClinicTaxRegistrations(
  ctx: TenantContext
): Promise<ClinicTaxRegistrationSummary[]> {
  return withTenant(ctx, async (tx) => {
    const at = new Date();
    const [rows, coverage] = await Promise.all([
      tx.issuerTaxRegistration.findMany({
        where: { deletedAt: null },
        select: REGISTRATION_SELECT,
        orderBy: [{ countryCode: 'asc' }, { regionCode: 'asc' }, { effectiveFrom: 'desc' }],
      }),
      loadCoverageState(tx),
    ]);

    return rows.map((row) =>
      toRegistrationSummary(
        row,
        at,
        coverage.branches,
        coverage.byRegistration.get(row.id) ?? EMPTY_COVERAGE,
        coverage.branchesWithCoverage
      )
    );
  });
}

export async function createClinicTaxRegistration(
  ctx: TenantContext,
  input: CreateClinicTaxRegistrationRequest,
  options: ClinicTaxActionOptions = {}
): Promise<ClinicTaxRegistrationSummary> {
  return withTenant(ctx, async (tx) => {
    /*
     * ⚠️ THE SAME NUMBER TWICE IS THE ONLY THING REFUSED HERE, AND THAT IS A
     *   DELIBERATE NARROWING OF WHAT THIS CHECK USED TO DO.
     *
     *   It used to refuse a second registration for the same (country, region,
     *   scheme) — one registration per PLACE — and told the caller to "end the
     *   existing one with a lapse date" instead. That advice did not work: the
     *   check ignored `effectiveTo`, so the lapsed row went on blocking its own
     *   successor, and a clinic whose GSTIN changed had to overwrite the old one
     *   and lose the record of what its earlier invoices were issued under.
     *
     *   It also forbade a shape that is simply legal: India has allowed a second
     *   GSTIN in one state for a separate business vertical since 2019, and
     *   nothing about "one per place" is true internationally either.
     *
     *   So the rule is now the honest one — you cannot record the SAME
     *   registration twice — and which of several a branch bills under is settled
     *   by coverage rather than by forbidding the second one to exist.
     */
    const duplicate = await tx.issuerTaxRegistration.findFirst({
      where: {
        countryCode: input.countryCode,
        scheme: input.scheme,
        registrationNumber: input.registrationNumber,
        deletedAt: null,
      },
      select: { id: true },
    });

    if (duplicate) {
      throw new ConflictError(
        `This clinic has already recorded ${input.scheme} registration ` +
          `${input.registrationNumber}. Correct that one, or end it with a lapse date if it is ` +
          'no longer in force.'
      );
    }

    const created = await tx.issuerTaxRegistration.create({
      data: {
        organizationId: ctx.organizationId,
        countryCode: input.countryCode,
        regionCode: input.regionCode,
        scheme: input.scheme,
        registrationNumber: input.registrationNumber,
        legalName: input.legalName ?? null,
        effectiveFrom: toDateOnly(input.effectiveFrom),
        effectiveTo: input.effectiveTo ? toDateOnly(input.effectiveTo) : null,
      },
      select: REGISTRATION_SELECT,
    });

    await recordAudit(tx, ctx, {
      action: 'CREATE',
      entityType: 'issuer_tax_registration',
      entityId: created.id,
      /*
       * ⚠️ THE REGISTRATION NUMBER IS ON THE AUDIT ROW ON PURPOSE, AND IT IS NOT
       *   PHI. It is the clinic's own number, printed on every invoice it issues —
       *   a public-facing identifier, not a patient's. Who changed the GSTIN the
       *   clinic bills under is exactly the question an auditor asks.
       */
      after: {
        registrationNumber: created.registrationNumber,
        placeOfSupply: jurisdictionOf(created.countryCode, created.regionCode),
        scheme: created.scheme,
        effectiveFrom: fromDateOnly(created.effectiveFrom),
      },
      ...options,
    });

    /*
     * A new registration covers nothing explicitly, so it falls back to
     * jurisdiction matching — the same coverage it would have had before this
     * table existed. Assigning branches is the deliberate second act.
     */
    await syncOrganizationTaxIdentity(tx, ctx);

    const coverage = await loadCoverageState(tx);
    return toRegistrationSummary(
      created,
      new Date(),
      coverage.branches,
      coverage.byRegistration.get(created.id) ?? EMPTY_COVERAGE,
      coverage.branchesWithCoverage
    );
  });
}

/**
 * Correct a registration.
 *
 * ⚠️ AN EDIT IN PLACE IS SAFE HERE AND WOULD NOT BE ON A RULE, AND THE REASON IS
 *   THE SNAPSHOT. `invoices.issuer_tax_id` and `.issuer_legal_name` are copied
 *   onto the invoice at issue and never re-read, so correcting a typo in a GSTIN
 *   cannot rewrite a document that has already gone out. A rule has no such
 *   snapshot — `invoice_taxes` cites the row — which is why that path refuses a
 *   rate change on a rule with issued invoices behind it.
 */
export async function updateClinicTaxRegistration(
  ctx: TenantContext,
  id: string,
  input: UpdateClinicTaxRegistrationRequest,
  options: ClinicTaxActionOptions = {}
): Promise<ClinicTaxRegistrationSummary> {
  return withTenant(ctx, async (tx) => {
    const before = await tx.issuerTaxRegistration.findFirst({
      where: { id, deletedAt: null },
      select: REGISTRATION_SELECT,
    });
    if (!before) throw new NotFoundError('Tax registration');

    /*
     * ⚠️ A RANGE THAT RUNS BACKWARDS MATCHES NOTHING, SILENTLY AND FOREVER — the
     *   registration simply stops being found and every invoice comes out
     *   NOT_REGISTERED with nothing to say why. The database refuses it too
     *   (`issuer_tax_registrations_effective_range`), but a CHECK surfaces as a
     *   500 with a constraint name in it; this is the same guard the rule path
     *   has, answering 400 with the field at fault.
     *
     *   Judged against what the row will END UP as, since a PATCH may move both
     *   dates in one request or either one on its own.
     */
    const nextFrom =
      input.effectiveFrom !== undefined ? toDateOnly(input.effectiveFrom) : before.effectiveFrom;
    const nextTo =
      input.effectiveTo !== undefined
        ? input.effectiveTo
          ? toDateOnly(input.effectiveTo)
          : null
        : before.effectiveTo;

    if (nextTo !== null && nextTo < nextFrom) {
      throw new ValidationError('A registration cannot end before it began.', {
        effectiveTo: ['Must be on or after the date the registration took effect.'],
      });
    }

    const after = await tx.issuerTaxRegistration.update({
      where: { organizationId_id: { organizationId: ctx.organizationId, id } },
      data: {
        ...(input.countryCode !== undefined ? { countryCode: input.countryCode } : {}),
        ...(input.regionCode !== undefined ? { regionCode: input.regionCode } : {}),
        ...(input.scheme !== undefined ? { scheme: input.scheme } : {}),
        ...(input.registrationNumber !== undefined
          ? { registrationNumber: input.registrationNumber }
          : {}),
        ...(input.legalName !== undefined ? { legalName: input.legalName } : {}),
        ...(input.effectiveFrom !== undefined
          ? { effectiveFrom: toDateOnly(input.effectiveFrom) }
          : {}),
        ...(input.effectiveTo !== undefined
          ? { effectiveTo: input.effectiveTo ? toDateOnly(input.effectiveTo) : null }
          : {}),
      },
      select: REGISTRATION_SELECT,
    });

    await recordAudit(tx, ctx, {
      action: 'UPDATE',
      entityType: 'issuer_tax_registration',
      entityId: id,
      before: {
        registrationNumber: before.registrationNumber,
        placeOfSupply: jurisdictionOf(before.countryCode, before.regionCode),
        effectiveFrom: fromDateOnly(before.effectiveFrom),
        effectiveTo: before.effectiveTo ? fromDateOnly(before.effectiveTo) : null,
      },
      after: {
        registrationNumber: after.registrationNumber,
        placeOfSupply: jurisdictionOf(after.countryCode, after.regionCode),
        effectiveFrom: fromDateOnly(after.effectiveFrom),
        effectiveTo: after.effectiveTo ? fromDateOnly(after.effectiveTo) : null,
      },
      ...options,
    });

    await syncOrganizationTaxIdentity(tx, ctx);

    const coverage = await loadCoverageState(tx);
    return toRegistrationSummary(
      after,
      new Date(),
      coverage.branches,
      coverage.byRegistration.get(after.id) ?? EMPTY_COVERAGE,
      coverage.branchesWithCoverage
    );
  });
}

/**
 * State which branches a registration covers. The whole set, replacing whatever
 * was there.
 *
 * ⚠️ THIS IS THE ANSWER TO A DIFFERENT QUESTION FROM "WHAT REGISTRATIONS DOES
 *   THIS CLINIC HOLD?", and keeping the two apart is the point of the table. An
 *   organization's registrations exist whether it has one branch or ten; coverage
 *   says which of its places bills under which of them. One registration may
 *   cover every branch, each branch may have its own, or two may share one while a
 *   third uses another — none of which is derivable from an address.
 *
 * ⚠️ AT MOST ONE LIVE REGISTRATION PER (BRANCH, SCHEME), CHECKED HERE BECAUSE
 *   POSTGRES CANNOT. "Live" is an overlap between two date ranges across a join,
 *   which needs an exclusion constraint this schema does not have. Two
 *   overlapping GSTINs on one branch is not a richer configuration — it is an
 *   invoice whose number depends on planner order — so the second assignment is
 *   refused with the name of the one already there.
 *
 * An empty list is legitimate and means "stop stating coverage for this
 * registration": it returns to jurisdiction matching rather than covering nothing.
 */
export async function setClinicTaxRegistrationBranches(
  ctx: TenantContext,
  id: string,
  input: SetClinicTaxRegistrationBranchesRequest,
  options: ClinicTaxActionOptions = {}
): Promise<ClinicTaxRegistrationSummary> {
  return withTenant(ctx, async (tx) => {
    const registration = await tx.issuerTaxRegistration.findFirst({
      where: { id, deletedAt: null },
      select: REGISTRATION_SELECT,
    });
    if (!registration) throw new NotFoundError('Tax registration');

    const branchIds = [...new Set(input.branchIds)];

    /*
     * Every id must be a live branch of THIS organization. RLS already scopes the
     * read, so a miss is a branch that does not exist rather than one belonging to
     * another tenant — and either way it must not become a coverage row.
     */
    const branches = await tx.branch.findMany({
      where: { id: { in: branchIds }, deletedAt: null },
      select: { id: true, name: true },
    });
    if (branches.length !== branchIds.length) {
      throw new ValidationError('Unknown branch', {
        branchIds: ['one or more of these branches does not exist at this clinic'],
      });
    }

    // Overlapping in the date sense, not merely both un-lapsed: two registrations
    // that never run at the same time are a succession, which is the whole point
    // of keeping the old one.
    const overlaps = (other: { effectiveFrom: Date; effectiveTo: Date | null }): boolean =>
      (other.effectiveTo === null || other.effectiveTo >= registration.effectiveFrom) &&
      (registration.effectiveTo === null || registration.effectiveTo >= other.effectiveFrom);

    if (branchIds.length > 0) {
      const rival = await tx.issuerTaxRegistrationBranch.findMany({
        where: {
          branchId: { in: branchIds },
          taxRegistrationId: { not: id },
          deletedAt: null,
          registration: { deletedAt: null, scheme: registration.scheme },
        },
        select: {
          branchId: true,
          registration: {
            select: {
              registrationNumber: true,
              effectiveFrom: true,
              effectiveTo: true,
            },
          },
        },
      });

      const clash = rival.find((row) => overlaps(row.registration));
      if (clash) {
        const name = branches.find((branch) => branch.id === clash.branchId)?.name ?? 'That branch';
        throw new ConflictError(
          `${name} is already covered by ${registration.scheme} registration ` +
            `${clash.registration.registrationNumber} for an overlapping period. End that ` +
            'coverage first, or lapse the registration it belongs to.'
        );
      }
    }

    const before = await tx.issuerTaxRegistrationBranch.findMany({
      where: { taxRegistrationId: id, deletedAt: null },
      select: { branchId: true },
    });

    /*
     * Replaced as a set: delete the links that are gone, create the ones that are
     * new, leave the rest alone. A delete-all-then-insert would churn the ids and
     * the timestamps of coverage nobody changed.
     *
     * A hard delete, unlike almost everything else here, and deliberately: a
     * coverage row is a current statement, not a historical document. What an
     * invoice was issued under is snapshotted on the invoice itself, so nothing
     * downstream needs the link to survive its own removal — and a soft-deleted
     * link would have to be excluded from the unique key to let coverage be
     * re-stated later.
     */
    const previous = new Set(before.map((row) => row.branchId));
    const next = new Set(branchIds);
    const removed = [...previous].filter((branchId) => !next.has(branchId));
    const added = branchIds.filter((branchId) => !previous.has(branchId));

    if (removed.length > 0) {
      await tx.issuerTaxRegistrationBranch.deleteMany({
        where: { taxRegistrationId: id, branchId: { in: removed } },
      });
    }
    if (added.length > 0) {
      await tx.issuerTaxRegistrationBranch.createMany({
        data: added.map((branchId) => ({
          organizationId: ctx.organizationId,
          taxRegistrationId: id,
          branchId,
        })),
      });
    }

    if (removed.length > 0 || added.length > 0) {
      await recordAudit(tx, ctx, {
        action: 'UPDATE',
        entityType: 'issuer_tax_registration',
        entityId: id,
        /*
         * Branch ids and a registration number, no patient anywhere near it. Who
         * changed which locations bill under which number is exactly the question
         * an auditor asks after a return does not reconcile.
         */
        before: { coveredBranchIds: [...previous].sort() },
        after: {
          registrationNumber: registration.registrationNumber,
          coveredBranchIds: [...next].sort(),
        },
        ...options,
      });
    }

    await syncOrganizationTaxIdentity(tx, ctx);

    const coverage = await loadCoverageState(tx);
    return toRegistrationSummary(
      registration,
      new Date(),
      coverage.branches,
      coverage.byRegistration.get(id) ?? EMPTY_COVERAGE,
      coverage.branchesWithCoverage
    );
  });
}

// ---------------------------------------------------------------------------
// Rules
// ---------------------------------------------------------------------------

export async function listClinicTaxRules(
  ctx: TenantContext,
  query: ListClinicTaxRulesQuery
): Promise<ClinicTaxRuleSummary[]> {
  return withTenant(ctx, async (tx) => {
    const at = new Date();
    const [rows, used] = await Promise.all([
      tx.taxRule.findMany({
        where: {
          deletedAt: null,
          ...(query.taxCategory ? { taxCategory: query.taxCategory } : {}),
          /*
           * A lapsed rule is history rather than clutter, so it is available and
           * not the default: the screen's job is "what do we charge", and a
           * three-year-old rate answers a different question.
           */
          ...(query.includeExpired
            ? {}
            : { OR: [{ effectiveTo: null }, { effectiveTo: { gte: at } }] }),
        },
        select: RULE_SELECT,
        orderBy: [{ taxCategory: 'asc' }, { regionCode: 'asc' }, { effectiveFrom: 'desc' }],
      }),
      rulesBehindIssuedInvoices(tx, ctx),
    ]);

    return rows.map((row) => toRuleSummary(row, at, used));
  });
}

export async function createClinicTaxRule(
  ctx: TenantContext,
  input: CreateClinicTaxRuleRequest,
  options: ClinicTaxActionOptions = {}
): Promise<ClinicTaxRuleSummary> {
  assertCoherent(input);

  return withTenant(ctx, async (tx) => {
    const clash = await tx.taxRule.findFirst({
      where: {
        countryCode: input.countryCode,
        regionCode: input.regionCode,
        scheme: input.scheme,
        taxCategory: input.taxCategory,
        effectiveFrom: toDateOnly(input.effectiveFrom),
        deletedAt: null,
      },
      select: { id: true },
    });

    if (clash) {
      throw new ConflictError(
        'A rule already covers that category and jurisdiction from that date. End it with a ' +
          'lapse date and start the new rate from the day after — two rules starting on the ' +
          'same day have no defined winner.'
      );
    }

    const created = await tx.taxRule.create({
      data: {
        organizationId: ctx.organizationId,
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
        effectiveFrom: toDateOnly(input.effectiveFrom),
        effectiveTo: input.effectiveTo ? toDateOnly(input.effectiveTo) : null,
      },
      select: RULE_SELECT,
    });

    await recordAudit(tx, ctx, {
      action: 'CREATE',
      entityType: 'tax_rule',
      entityId: created.id,
      after: ruleSnapshot(created),
      ...options,
    });

    return toRuleSummary(created, new Date(), new Set());
  });
}

/**
 * Correct a rule.
 *
 * ⚠️ A CORRECTION, NOT A RATE CHANGE, AND THE DIFFERENCE IS ENFORCED. Moving the
 *   rate, the treatment or the jurisdiction on a rule that priced an ISSUED
 *   invoice is refused: `invoice_taxes` cites this row as the account of what
 *   that document charged, the invoice's own totals are frozen at the database,
 *   and rewriting the rule leaves a correct document with an explanation that no
 *   longer matches it. A rate genuinely changing is `effectiveTo` here and a new
 *   row from the day after.
 *
 *   The description, the line names and an END DATE stay editable on a rule with
 *   invoices behind it, because none of the three changes what was charged.
 */
export async function updateClinicTaxRule(
  ctx: TenantContext,
  id: string,
  input: UpdateClinicTaxRuleRequest,
  options: ClinicTaxActionOptions = {}
): Promise<ClinicTaxRuleSummary> {
  return withTenant(ctx, async (tx) => {
    const before = await tx.taxRule.findFirst({
      where: { id, deletedAt: null },
      select: RULE_SELECT,
    });
    if (!before) throw new NotFoundError('Tax rule');

    /*
     * Coherence is checked against the MERGED row and not the patch. A request
     * setting `treatment: 'EXEMPT'` without touching `rateBps` is only invalid in
     * combination with the rate already stored.
     */
    assertCoherent({
      treatment: input.treatment ?? before.treatment,
      rateBps: input.rateBps ?? before.rateBps,
      stacks: input.stacks ?? before.stacks,
      regionCode: input.regionCode !== undefined ? input.regionCode : before.regionCode,
      split: input.split ?? before.split,
      lineName: input.lineName ?? before.lineName,
    });

    const used = await rulesBehindIssuedInvoices(tx, ctx);
    if (used.has(id)) assertNoPricingChange(before, input);

    const after = await tx.taxRule.update({
      where: { organizationId_id: { organizationId: ctx.organizationId, id } },
      data: {
        ...(input.countryCode !== undefined ? { countryCode: input.countryCode } : {}),
        ...(input.regionCode !== undefined ? { regionCode: input.regionCode } : {}),
        ...(input.scheme !== undefined ? { scheme: input.scheme } : {}),
        ...(input.taxCategory !== undefined ? { taxCategory: input.taxCategory } : {}),
        ...(input.description !== undefined ? { description: input.description } : {}),
        ...(input.rateBps !== undefined ? { rateBps: input.rateBps } : {}),
        ...(input.treatment !== undefined ? { treatment: input.treatment } : {}),
        ...(input.lineName !== undefined ? { lineName: input.lineName } : {}),
        ...(input.regionalLineName !== undefined
          ? { regionalLineName: input.regionalLineName }
          : {}),
        ...(input.split !== undefined ? { split: input.split } : {}),
        ...(input.stacks !== undefined ? { stacks: input.stacks } : {}),
        ...(input.effectiveFrom !== undefined
          ? { effectiveFrom: toDateOnly(input.effectiveFrom) }
          : {}),
        ...(input.effectiveTo !== undefined
          ? { effectiveTo: input.effectiveTo ? toDateOnly(input.effectiveTo) : null }
          : {}),
      },
      select: RULE_SELECT,
    });

    await recordAudit(tx, ctx, {
      action: 'UPDATE',
      entityType: 'tax_rule',
      entityId: id,
      before: ruleSnapshot(before),
      after: ruleSnapshot(after),
      ...options,
    });

    return toRuleSummary(after, new Date(), used);
  });
}

/**
 * Stop charging a rule from a date. NOT a delete.
 *
 * ⚠️ THE ONE OPERATION THAT LOOKS LIKE A DELETE AND MUST NOT BE ONE. An invoice
 *   issued last March has to stay explicable for as long as the clinic's
 *   retention obligation runs, and the row that priced it IS the explanation.
 *   Removing it does not un-charge the tax; it makes the charge unaccountable,
 *   and the person who needs the answer is an auditor years later rather than the
 *   administrator clicking the button.
 *
 * ⚠️ AND WHAT IT FALLS BACK TO DEPENDS ON THE CATEGORY, WHICH IS THE PART A CLINIC
 *   GETS WRONG. The precedence is all-or-nothing per category, so once a clinic's
 *   last live rule for a category lapses, rcln's published default applies again
 *   from the next day — WHERE THERE IS ONE. The catalogue covers healthcare
 *   SERVICES and deliberately covers no goods, because a medicine's rate depends
 *   on the medicine and a plausible wrong default is worse than none. So ending a
 *   consultation override restores the exemption, and ending a medicine rate
 *   leaves the category UNRATED and unissuable. `unratedCategories` on the rate
 *   card is what tells the clinic which of the two just happened.
 */
export async function endClinicTaxRule(
  ctx: TenantContext,
  id: string,
  effectiveTo: string,
  options: ClinicTaxActionOptions = {}
): Promise<ClinicTaxRuleSummary> {
  return withTenant(ctx, async (tx) => {
    const before = await tx.taxRule.findFirst({
      where: { id, deletedAt: null },
      select: RULE_SELECT,
    });
    if (!before) throw new NotFoundError('Tax rule');

    const end = toDateOnly(effectiveTo);
    if (end < before.effectiveFrom) {
      throw new ValidationError('A rule cannot end before it began.', {
        effectiveTo: ['Must be on or after the date the rule took effect.'],
      });
    }

    const after = await tx.taxRule.update({
      where: { organizationId_id: { organizationId: ctx.organizationId, id } },
      data: { effectiveTo: end },
      select: RULE_SELECT,
    });

    await recordAudit(tx, ctx, {
      action: 'UPDATE',
      entityType: 'tax_rule',
      entityId: id,
      before: ruleSnapshot(before),
      after: ruleSnapshot(after),
      ...options,
    });

    return toRuleSummary(after, new Date(), await rulesBehindIssuedInvoices(tx, ctx));
  });
}

/**
 * What a change to an issued rule may not touch.
 *
 * Everything that decided a number, and nothing that decided a word. The line
 * names ARE printed on the invoice — but they are printed from `invoice_taxes`,
 * which snapshotted them at issue, so renaming the rule cannot change a document
 * either.
 */
function assertNoPricingChange(before: RuleRow, input: UpdateClinicTaxRuleRequest): void {
  const moved: string[] = [];
  if (input.rateBps !== undefined && input.rateBps !== before.rateBps) moved.push('rate');
  if (input.treatment !== undefined && input.treatment !== before.treatment) {
    moved.push('treatment');
  }
  if (input.split !== undefined && input.split !== before.split) moved.push('split');
  if (input.stacks !== undefined && input.stacks !== before.stacks) moved.push('stacking');
  if (input.countryCode !== undefined && input.countryCode !== before.countryCode) {
    moved.push('country');
  }
  if (input.regionCode !== undefined && input.regionCode !== before.regionCode) {
    moved.push('region');
  }
  if (input.scheme !== undefined && input.scheme !== before.scheme) moved.push('scheme');
  if (input.taxCategory !== undefined && input.taxCategory !== before.taxCategory) {
    moved.push('category');
  }
  if (
    input.effectiveFrom !== undefined &&
    fromDateOnly(before.effectiveFrom) !== input.effectiveFrom
  ) {
    moved.push('start date');
  }

  if (moved.length === 0) return;

  throw new ConflictError(
    `Invoices have already been issued under this rule, so its ${moved.join(', ')} cannot ` +
      'change — the rule is the account of what those documents charged. Give this rule an end ' +
      'date and add a new one from the day after.'
  );
}

/** The audit snapshot. No PHI here — a rate card names no patient. */
function ruleSnapshot(row: RuleRow): Record<string, unknown> {
  return {
    taxCategory: row.taxCategory,
    jurisdiction: jurisdictionOf(row.countryCode, row.regionCode),
    scheme: row.scheme,
    rateBps: row.rateBps,
    treatment: row.treatment,
    lineName: row.lineName,
    regionalLineName: row.regionalLineName,
    split: row.split,
    stacks: row.stacks,
    description: row.description,
    effectiveFrom: fromDateOnly(row.effectiveFrom),
    effectiveTo: row.effectiveTo ? fromDateOnly(row.effectiveTo) : null,
  };
}

// ---------------------------------------------------------------------------
// The card
// ---------------------------------------------------------------------------

/**
 * The whole rate card, inherited rows and overrides side by side.
 *
 * ⚠️ IT ASKS `rulesFor` RATHER THAN DECIDING PRECEDENCE ITSELF, WHICH IS THE
 *   WHOLE POINT OF THE FUNCTION. The engine's rule is all-or-nothing per category
 *   — if the clinic wrote ANY applicable rule for a category, its whole set wins
 *   and the catalogue is ignored for that category — and it also resolves
 *   region-versus-country, stacking, and overlapping date ranges. A screen that
 *   reimplemented any of that would eventually tell a clinic it charges something
 *   the invoice does not.
 *
 * ⚠️ AND IT RESOLVES AGAINST A REAL REGISTRATION, BECAUSE THAT IS WHAT DECIDES
 *   WHETHER ANY RATE APPLIES AT ALL. A clinic holding none charges no tax
 *   whatever its rules say — the rate card is then an answer to a question nobody
 *   is asking — so the card reports the registrations first and the categories
 *   second. Where there is no live registration the card resolves against the
 *   branches' own jurisdiction so the clinic can still see what it WOULD charge.
 */
export async function getTaxRateCard(ctx: TenantContext): Promise<TaxRateCardResponse> {
  return withTenant(ctx, async (tx) => {
    const at = new Date();

    const coverage = await loadCoverageState(tx);
    const branches = coverage.branches;

    /*
     * ⚠️ THE COUNTRY COMES FROM THE BRANCHES AND NEVER FROM A PARAMETER. A caller
     *   asking about a country the clinic does not operate in would get a
     *   plausible card for a jurisdiction none of its invoices can be issued in.
     *   The primary branch decides where several disagree, which is the same rule
     *   the rest of the product uses for "the clinic's country".
     */
    const countryCode = branches[0]?.countryCode ?? 'IN';
    const regionCode = branches[0]?.regionCode ?? null;

    const [registrationRows, tenantRules, defaultRules, used, draftCategories] = await Promise.all([
      tx.issuerTaxRegistration.findMany({
        where: { deletedAt: null },
        select: REGISTRATION_SELECT,
        orderBy: [{ countryCode: 'asc' }, { regionCode: 'asc' }, { effectiveFrom: 'desc' }],
      }),
      tx.taxRule.findMany({ where: { deletedAt: null }, select: RULE_SELECT }),
      /*
       * RLS-EXEMPT and read inside the tenant transaction, exactly as
       * `loadTaxContext` does it — see the file header.
       */
      tx.taxRuleDefault.findMany({
        where: { deletedAt: null, countryCode },
        select: RULE_SELECT,
      }),
      rulesBehindIssuedInvoices(tx, ctx),
      /*
       * The categories this clinic's OPEN drafts actually use. Specific rather
       * than a warning about everything that could go wrong: a category here with
       * no rule anywhere is a bill somebody is about to fail to issue.
       */
      tx.invoiceItem.findMany({
        where: { organizationId: ctx.organizationId, invoice: { status: 'DRAFT' } },
        select: { taxCategory: true },
        distinct: ['taxCategory'],
      }),
    ]);

    const registrations = registrationRows.map((row) =>
      toRegistrationSummary(
        row,
        at,
        branches,
        coverage.byRegistration.get(row.id) ?? EMPTY_COVERAGE,
        coverage.branchesWithCoverage
      )
    );

    /*
     * The registration the engine would price against, or the branches' own
     * jurisdiction when the clinic holds none. `scheme` follows the live
     * registration where there is one — a clinic with no registration has no
     * scheme of its own, and GST is the only one the defaults catalogue is
     * seeded for.
     */
    const live = registrations.find((row) => row.isLive);
    const asIssuer = {
      countryCode: live?.countryCode ?? countryCode,
      regionCode: live?.regionCode ?? regionCode,
      scheme: live?.scheme ?? ('GST' as const),
      registrationNumber: live?.registrationNumber ?? '',
      standardRateBps: null,
    };

    const engineRules: EngineTaxRule[] = [
      ...tenantRules.map((row) => toEngineRule(row, 'TENANT')),
      ...defaultRules.map((row) => toEngineRule(row, 'PLATFORM')),
    ];

    const byId = new Map<string, RuleRow>();
    for (const row of [...tenantRules, ...defaultRules]) byId.set(row.id, row);

    const allCategories = [
      ...new Set([...tenantRules, ...defaultRules].map((row) => row.taxCategory)),
    ].sort();

    const categories: TaxCategoryCard[] = allCategories.map((taxCategory) => {
      const applied = rulesFor(engineRules, asIssuer, taxCategory, at);
      const source = applied.some((rule) => rule.source === 'TENANT') ? 'TENANT' : 'PLATFORM';

      return {
        taxCategory,
        source,
        applied: applied.flatMap((rule) => {
          const row = byId.get(rule.id ?? '');
          return row ? [toRuleSummary(row, at, used)] : [];
        }),
        /*
         * What the clinic is overriding, when it is. "We charge 5% where rcln
         * says 12%" is the most useful sentence this screen produces: either the
         * clinic is right and the catalogue is stale, or somebody typed a rate
         * they should not have.
         */
        overriding:
          source === 'TENANT'
            ? defaultRules
                .filter((row) => row.taxCategory === taxCategory)
                .map((row) => toRuleSummary(row, at, used))
            : [],
      };
    });

    const rated = new Set(
      categories.filter((card) => card.applied.length > 0).map((card) => card.taxCategory)
    );

    return {
      countryCode,
      registrations,
      // For the coverage editor. Deliberately three fields — see the contract.
      branches: branches.map((branch) => ({
        id: branch.id,
        name: branch.name,
        placeOfSupply: jurisdictionOf(branch.countryCode, branch.regionCode),
      })),
      categories,
      unratedCategories: draftCategories
        .map((row) => row.taxCategory)
        .filter((category) => !rated.has(category))
        .sort(),
    };
  });
}

/** A row from either table, in the shape the engine's selection understands. */
function toEngineRule(row: RuleRow, source: 'TENANT' | 'PLATFORM'): EngineTaxRule {
  return {
    id: row.id,
    countryCode: row.countryCode,
    regionCode: row.regionCode,
    scheme: row.scheme as EngineTaxRule['scheme'],
    taxCategory: row.taxCategory,
    rateBps: row.rateBps,
    treatment: row.treatment as EngineTaxRule['treatment'],
    lineName: row.lineName,
    regionalLineName: row.regionalLineName,
    split: row.split as EngineTaxRule['split'],
    stacks: row.stacks,
    source,
    effectiveFrom: row.effectiveFrom,
    effectiveTo: row.effectiveTo,
  };
}
