/**
 * The clinic's tax position, loaded and handed to `@rcln/tax`.
 *
 * ⚠️ THIS IS NOT `taxFor()` IN `@rcln/billing`, AND THE TWO MUST NOT BE MERGED.
 *   That one answers "what does RCLN charge THIS CLINIC for its subscription?"
 *   and reads the platform-wide `tax_registrations`. This one answers "what does
 *   THIS CLINIC charge ITS PATIENT?" and reads the tenant's own
 *   `issuer_tax_registrations` and `tax_rules`. Different issuer, different
 *   authority, different return — see §0.1 of the invoice-engine log. They share
 *   `resolveTax` precisely so the *rules* stay in one place while the *inputs*
 *   stay apart.
 *
 * ⚠️ THE PLACE OF SUPPLY IS THE BRANCH, NOT THE PATIENT.
 *   A clinical service is performed somewhere, so that somewhere is where it is
 *   supplied. Reading the patient's address instead would make a Karnataka
 *   clinic's consultation for a Kerala patient an inter-state supply: IGST
 *   instead of CGST+SGST, the state's half never reaching the state, and two
 *   returns wrong. `resolveTax` takes `placeOfSupply` explicitly for this
 *   reason, and this file is the only thing that fills it in.
 *
 * WHY THE INPUTS ARE LOADED ONCE AND PASSED DOWN
 *   An invoice has many lines and they resolve against the same registrations
 *   and the same rules. `loadTaxContext` reads both tables once per invoice;
 *   `taxForItem` is then pure and takes no client, so Phase 4's calculation
 *   engine can price a whole invoice without touching the database again.
 */
import type { TenantContext, TxClient } from '@rcln/db';
import type { Money } from '@rcln/payments';
import {
  resolveTax,
  type IssuerRegistration,
  type Jurisdiction,
  type TaxQuote,
  type TaxRule,
} from '@rcln/tax';

/**
 * Everything the engine needs about one issuer, read once per invoice.
 *
 * Deliberately a plain value with no client on it: once this exists, pricing a
 * line is pure arithmetic, and Phase 4 can test a hundred-line invoice without a
 * tenant.
 */
export interface TaxContext {
  registrations: IssuerRegistration[];
  rules: TaxRule[];
  /** The issuing branch's jurisdiction — the place of supply for every line. */
  placeOfSupply: Jurisdiction;
}

/**
 * Load the issuer's registrations and rules as at a moment.
 *
 * ⚠️ `at` IS THE SUPPLY DATE, NOT `NOW()`. A credit note raised in April against
 *   a March invoice is taxed as March was, and re-reading today's rules would
 *   quietly price it at whatever the rate is now. Every caller passes the date
 *   of the supply it is pricing.
 *
 * Effective-dating is filtered in SQL for the registrations and in the engine
 * for the rules — not an inconsistency: `ruleFor` has to see the overlapping
 * rows to break the tie between them deterministically, and a rule set is a
 * handful of rows per organization.
 */
export async function loadTaxContext(
  tx: TxClient,
  ctx: TenantContext,
  branchId: string,
  at: Date
): Promise<TaxContext> {
  const branch = await tx.branch.findFirst({
    where: { id: branchId, organizationId: ctx.organizationId },
    select: { countryCode: true, regionCode: true },
  });

  if (!branch) {
    /*
     * RLS already scopes this read, so a miss is a branch that does not exist
     * rather than one belonging to another tenant. Either way there is no place
     * of supply, and inventing one — the organization's, say — would silently
     * bill under the wrong state's GSTIN.
     */
    throw new Error(`Cannot resolve tax: branch ${branchId} not found in this organization.`);
  }

  /*
   * ⚠️ THE DEFAULTS ARE READ, NOT COPIED, AND THAT IS THE WHOLE INHERITANCE
   *   DESIGN. `tax_rule_defaults` is the rate card rcln maintains per country;
   *   `tax_rules` is what this clinic overrode. Resolving at read time means a
   *   published rate change reaches every clinic that has not overridden it with
   *   one INSERT, instead of a migration across every tenant — and it keeps
   *   "the clinic chose this" distinguishable from "this is a stale copy of our
   *   old default", which a copy-at-signup design destroys permanently.
   *
   *   `rulesFor` does the precedence: a tenant rule wins, all-or-nothing per tax
   *   category. Both sets are passed whole so that decision stays in one place.
   *
   * ⚠️ The defaults table is RLS-EXEMPT and read here inside a tenant
   *   transaction, which is exactly why it must stay exempt: a policy on it
   *   would return zero rows for every clinic and no invoice on the platform
   *   could be priced. It holds no tenant data — it is the published law of a
   *   country, identical for everyone in it.
   */
  const [liveRegistrationRows, coverageRows, statedRows, tenantRuleRows, defaultRuleRows] =
    await Promise.all([
      tx.issuerTaxRegistration.findMany({
        where: {
          deletedAt: null,
          effectiveFrom: { lte: at },
          OR: [{ effectiveTo: null }, { effectiveTo: { gte: at } }],
        },
      }),
      /*
       * What THIS BRANCH has been stated to bill under. Read unfiltered by date —
       * the link says which registration, the registration says when it applied,
       * and asking the link to also know about dates would put the effective range
       * in two places.
       */
      tx.issuerTaxRegistrationBranch.findMany({
        where: { branchId, deletedAt: null },
        select: { taxRegistrationId: true },
      }),
      /*
       * Which registrations ANY branch has been stated to bill under — read for
       * the whole organization, not for this branch. It is what lets the fallback
       * below tell "nobody has said anything about this registration" apart from
       * "somebody said it, and did not say this branch".
       */
      tx.issuerTaxRegistrationBranch.findMany({
        where: { deletedAt: null },
        select: { taxRegistrationId: true },
      }),
      tx.taxRule.findMany({ where: { deletedAt: null } }),
      tx.taxRuleDefault.findMany({
        where: { deletedAt: null, countryCode: branch.countryCode },
      }),
    ]);

  /*
   * ⚠️ A STATEMENT BEATS THE INFERENCE, AND SILENCE KEEPS IT.
   *
   *   Coverage used to be inferred: every live registration was handed to the
   *   engine and `registrationFor` picked the one whose (country, region) matched
   *   the branch's. That answered "which branches does this GSTIN cover?" with
   *   *whichever ones sit in the same state* — so two branches in one state could
   *   not bill under two numbers, and a clinic could not say that one of them
   *   does not bill under this registration at all.
   *
   *   Now: if this branch has stated coverage, ONLY those registrations are
   *   offered, and the engine's jurisdiction rule then confirms one of them
   *   actually applies to the country being supplied in. If it has none, every
   *   live registration is offered and the old inference runs unchanged — which
   *   is what keeps this additive for every clinic that has never opened the
   *   coverage screen.
   *
   *   Narrowing to an empty set is impossible by construction: a branch with no
   *   links takes the fallback, and a branch with links has at least one. A branch
   *   whose only stated registration has lapsed correctly finds nothing live and
   *   bills NOT_REGISTERED — which is the true answer, not a bug.
   */
  const coveredIds = new Set(coverageRows.map((row) => row.taxRegistrationId));
  const statedIds = new Set(statedRows.map((row) => row.taxRegistrationId));
  const registrationRows =
    coveredIds.size > 0
      ? liveRegistrationRows.filter((row) => coveredIds.has(row.id))
      : /*
         * ⚠️ THE FALLBACK IS STRICT, AND IT DID NOT USED TO BE.
         *
         *   Every live registration was handed to the engine, and `registrationFor`
         *   ends with `?? inCountry[0]` — a last-resort guess that returns SOME
         *   registration in the right country when none matches the region. So a
         *   clinic registered only in Karnataka billed its Maharashtra branch
         *   under the Karnataka GSTIN: a plausible number on the invoice, the tax
         *   collected against the wrong registration, and the state's half filed
         *   in the wrong return. It also disagreed with the coverage screen, which
         *   has always matched strictly — the screen said "covers nothing" while
         *   the engine billed under it anyway.
         *
         *   Filtering here rather than changing `registrationFor` is deliberate:
         *   the guess is still WANTED for stated coverage, where a clinic has
         *   deliberately put an out-of-state branch under a registration and means
         *   it. What it must not do is invent that intent from an address.
         *
         *   A branch left with nothing prices NOT_REGISTERED — the honest answer,
         *   visible on the tax screen as a registration covering no branches, and
         *   fixable by stating coverage.
         */
        liveRegistrationRows.filter(
          (row) =>
            row.countryCode === branch.countryCode &&
            (row.regionCode === null || row.regionCode === branch.regionCode) &&
            /*
             * ⚠️ AND NOT ONE SOMEBODY ELSE HAS CLAIMED. A registration with any
             *   stated coverage has had its branches named by the clinic; a
             *   branch that is not among them was excluded ON PURPOSE, and
             *   handing it over anyway by geography re-infers the intent the
             *   paragraph above says a statement replaces.
             *
             *   Two Bihar branches, and India has permitted a second GSTIN per
             *   state since 2019: assign the second to Gaya alone and Patna —
             *   which stated nothing — was still offered BOTH. `registrationFor`
             *   then chose between two rows with the same `effectiveFrom` by
             *   whichever order Postgres returned them in, so Gaya's dedicated
             *   number printed on roughly half of Patna's invoices, and the tax
             *   was filed against a registration that does not cover the branch
             *   that collected it. It surfaced as a test that failed half the
             *   time (KNOWN_ISSUES #7) rather than as a wrong invoice, which is
             *   the only reason it was found.
             */
            !statedIds.has(row.id)
        );

  const ruleRows = [
    ...tenantRuleRows.map((row) => ({ ...row, source: 'TENANT' as const })),
    ...defaultRuleRows.map((row) => ({ ...row, source: 'PLATFORM' as const })),
  ];

  return {
    placeOfSupply: { countryCode: branch.countryCode, regionCode: branch.regionCode },
    registrations: registrationRows.map((row) => ({
      /*
       * Carried so the caller can fill `invoices.issuer_tax_registration_id` and
       * `.issuer_legal_name`. The engine never reads either — it prints the
       * NUMBER, which is snapshotted separately because the row can be corrected
       * and an issued invoice's printed string may not change.
       */
      id: row.id,
      legalName: row.legalName,
      countryCode: row.countryCode,
      regionCode: row.regionCode,
      scheme: row.scheme,
      registrationNumber: row.registrationNumber,
      /*
       * Only ever a tie-break, and only when several registrations reach the
       * engine at once — the most recently effective wins, so the number on the
       * invoice does not depend on the order Postgres returned the rows in.
       */
      effectiveFrom: row.effectiveFrom,
      /*
       * ⚠️ NULL, AND NOT ZERO. A clinic has no single rate — a consultation is
       *   exempt and a medicine is 5%, under the one GSTIN. Zero here would read
       *   as "0% is the answer" and quietly untax any line whose category failed
       *   to resolve; null makes that line UNRATED instead, which finalisation
       *   refuses to issue. There is deliberately no such column on the table.
       */
      standardRateBps: null,
    })),
    rules: ruleRows.map((row) => ({
      /*
       * ⚠️ CARRIED SO `invoice_taxes` CAN CITE THE ROW THAT PRICED THE LINE.
       *   `source` says which of the two tables it is in — a tenant rule lands
       *   in `tax_rule_id`, an inherited default in `tax_rule_default_id`, and
       *   a CHECK refuses both at once. Dropping the id here does not fail
       *   anything: it just leaves both columns NULL on every invoice, which
       *   reads as "no rule was involved" — the UNRATED case.
       */
      id: row.id,
      countryCode: row.countryCode,
      regionCode: row.regionCode,
      scheme: row.scheme,
      taxCategory: row.taxCategory,
      rateBps: row.rateBps,
      /*
       * The CHECK constraint `tax_rules_treatment_is_item_level` is what makes
       * this cast safe: the column is the full `TaxTreatment` enum because
       * Prisma cannot express a subset of one, and the database refuses anything
       * outside the three item-level values.
       */
      treatment: row.treatment as TaxRule['treatment'],
      lineName: row.lineName,
      regionalLineName: row.regionalLineName,
      split: row.split,
      stacks: row.stacks,
      source: row.source,
      effectiveFrom: row.effectiveFrom,
      effectiveTo: row.effectiveTo,
    })),
  };
}

/**
 * What tax is due on one invoice line.
 *
 * Pure, and takes the whole context rather than a client, so an invoice's lines
 * cost one database read between them. The patient is the customer but never the
 * place of supply — see the header.
 */
export function taxForItem(
  context: TaxContext,
  input: {
    net: Money;
    /** Matched exactly against `tax_rules.tax_category`. */
    taxCategory: string;
    /** A patient's own GSTIN, on the rare invoice raised to a business. */
    customerTaxId?: string | null;
    suppliedAt: Date;
  }
): TaxQuote {
  return resolveTax({
    net: input.net,
    /*
     * The customer's jurisdiction is the place of supply's, not the patient's
     * home address: for a service performed at the branch they are the same
     * supply either way, and carrying the patient's address here would re-open
     * the intra/inter-state decision that `placeOfSupply` exists to settle.
     * The patient's tax id still travels, because the invoice prints it.
     */
    customer: {
      ...context.placeOfSupply,
      taxId: input.customerTaxId ?? null,
      taxIdStatus: input.customerTaxId ? 'UNVALIDATED' : 'NOT_PROVIDED',
    },
    placeOfSupply: context.placeOfSupply,
    registrations: context.registrations,
    taxCategory: input.taxCategory,
    rules: context.rules,
    suppliedAt: input.suppliedAt,
  });
}
