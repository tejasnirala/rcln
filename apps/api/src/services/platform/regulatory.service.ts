/**
 * The regulatory console: jurisdictions, authorities, sources, packs and rules.
 *
 * ⚠️ A WRITE HERE CHANGES WHAT EVERY CLINIC IN A JURISDICTION IS EVALUATED
 *   AGAINST, IMMEDIATELY. There is no publish step and no cache — the engine
 *   loads these rows at decision time, so an edit reaches the next dispense
 *   anywhere in that country. Same posture as `tax-rule-default.service.ts`, and
 *   one degree worse in consequence: a wrong rate is a wrong number on a
 *   document, and a wrong rule is a medicine handed over that should not have
 *   been, or withheld that should not have been.
 *
 * ⚠️ **DO NOT INVENT LEGAL RULES.** Every rule cites a `regulatory_sources` row —
 *   `source_id` is NOT NULL and the database enforces it — and a source is the
 *   REGULATOR'S OWN PUBLICATION. A summary, a vendor blog, a law-firm note or a
 *   model's recollection is not a source. A rule whose source cannot be found is
 *   not written: the country's cell in COUNTRY_SUPPORT_MATRIX.md stays
 *   `RESEARCH_REQUIRED`, which is a correct and useful state.
 *
 * ⚠️ NOTHING IN THIS FILE MAY ADVANCE A PACK TO `REGULATORY_REVIEWED` OR
 *   `PRODUCTION_ENABLED` EXCEPT `approveRulePack`, which requires a named human
 *   and a permission no system role holds (PI-ADR-009, OD-5). Everything else
 *   accepts `codeSettableMaturity` — a type in which those two states cannot be
 *   expressed — and the `regulatory_rule_packs_review_recorded` CHECK is the
 *   third layer.
 *
 * `@rcln/db/unsafe` is correct here, as on the rest of the platform router:
 * these tables have no `organization_id` to scope by, because a country's law is
 * identical for every clinic in it. The database's own second layer —
 * `platform_law_not_tenant_writable` — refuses these writes if they are ever
 * attempted from a transaction that claims a tenant.
 *
 * NO PHI.
 */
import type {
  ApproveRulePackRequest,
  CreateJurisdictionRequest,
  CreateRegulatoryAuthorityRequest,
  CreateRegulatoryRuleRequest,
  CreateRegulatorySourceRequest,
  CreateRulePackRequest,
  JurisdictionListResponse,
  JurisdictionQuery,
  JurisdictionSummary,
  RegulatoryAuthorityListResponse,
  RegulatoryAuthorityQuery,
  RegulatoryAuthoritySummary,
  RegulatoryRuleDetail,
  RegulatoryRuleListResponse,
  RegulatoryRuleQuery,
  RegulatorySourceListResponse,
  RegulatorySourceQuery,
  RegulatorySourceSummary,
  RulePackListResponse,
  RulePackQuery,
  RulePackSummary,
  UpdateJurisdictionRequest,
  UpdateRegulatoryAuthorityRequest,
  UpdateRegulatoryRuleRequest,
  UpdateRegulatorySourceRequest,
  UpdateRulePackRequest,
} from '@rcln/contracts';
import type { Prisma } from '@rcln/db';
import { unsafeDbClient } from '@rcln/db/unsafe';
import { ConflictError, NotFoundError, ValidationError } from '../../utils/errors.js';
import { calendarToday, startOfCalendarDay } from '../product/values.js';
import {
  HUMAN_ONLY,
  pageMeta,
  toAuthoritySummary,
  toJurisdictionSummary,
  toRuleDetail,
  toRulePackSummary,
  toSourceSummary,
} from '../regulatory/shared.js';

/** A `Date` at UTC midnight from `YYYY-MM-DD`, matching the `date` columns. */
function toDateOnly(value: string): Date {
  return startOfCalendarDay(new Date(`${value}T00:00:00.000Z`));
}

const jurisdictionSelect = { countryCode: true, regionCode: true } as const;

/**
 * The pack row, locked, inside a transaction.
 *
 * ⚠️ EVERY DECISION IN THIS FILE THAT TURNS ON A PACK'S MATURITY READS IT
 *   THROUGH HERE, AND THAT IS PI-4'S LESSON APPLIED RATHER THAN RESTATED.
 *   `createRule` read the pack in one autocommit statement and inserted into a
 *   DIFFERENT table in another, so a sign-off committing in between produced a
 *   rule inside a pack a named human had already signed — exactly what the
 *   comment on `createRule` claims is refused, and what the CHECK constraint
 *   cannot see, because it only constrains the pack row. `updateRulePack` had
 *   the mirror image: a sign-off landing between its read and its write let an
 *   ordinary PATCH strip `REGULATORY_REVIEWED` while leaving the reviewer's name
 *   in place.
 *
 *   Locking the pack is what serialises them, because the pack is the row every
 *   one of these decisions is made AGAINST — which is not the same as the row
 *   being edited, and that distinction is the whole of the earlier bug.
 *
 * `FOR UPDATE` rather than an advisory lock: it is the row itself, it releases
 * with the transaction, and it is what the concurrency test watches fail when
 * removed.
 */
async function lockPack(
  tx: Prisma.TransactionClient,
  packId: string
): Promise<{ id: string; maturity: string; reviewedBy: string | null }> {
  const rows = await tx.$queryRaw<{ id: string; maturity: string; reviewed_by: string | null }[]>`
    SELECT id, maturity::text AS maturity, reviewed_by
      FROM regulatory_rule_packs
     WHERE id = ${packId}::uuid
       FOR UPDATE
  `;
  const row = rows[0];
  if (!row) throw new NotFoundError('Rule pack');
  return { id: row.id, maturity: row.maturity, reviewedBy: row.reviewed_by };
}

// ===========================================================================
// Jurisdictions
// ===========================================================================

export async function listJurisdictionsForPlatform(
  query: JurisdictionQuery
): Promise<JurisdictionListResponse> {
  const where = {
    ...(query.countryCode ? { countryCode: query.countryCode } : {}),
    ...(query.includeInactive ? {} : { isActive: true }),
  };

  const [rows, total] = await Promise.all([
    unsafeDbClient().jurisdiction.findMany({
      where,
      orderBy: [{ countryCode: 'asc' }, { regionCode: 'asc' }],
      skip: (query.page - 1) * query.limit,
      take: query.limit,
      include: { _count: { select: { authorities: true, rulePacks: true } } },
    }),
    unsafeDbClient().jurisdiction.count({ where }),
  ]);

  return {
    jurisdictions: rows.map(toJurisdictionSummary),
    meta: pageMeta(total, query.page, query.limit),
  };
}

export async function createJurisdiction(
  input: CreateJurisdictionRequest
): Promise<JurisdictionSummary> {
  const existing = await unsafeDbClient().jurisdiction.findFirst({
    where: { countryCode: input.countryCode, regionCode: input.regionCode ?? null },
  });
  if (existing) {
    throw new ConflictError(
      'That jurisdiction already exists. A country and a region of it are two rows, and each may exist only once.'
    );
  }

  const created = await unsafeDbClient().jurisdiction.create({
    data: {
      countryCode: input.countryCode,
      regionCode: input.regionCode ?? null,
      name: input.name,
      isActive: input.isActive,
    },
    include: { _count: { select: { authorities: true, rulePacks: true } } },
  });

  return toJurisdictionSummary(created);
}

export async function updateJurisdiction(
  id: string,
  input: UpdateJurisdictionRequest
): Promise<JurisdictionSummary> {
  const current = await unsafeDbClient().jurisdiction.findUnique({ where: { id } });
  if (!current) throw new NotFoundError('Jurisdiction');

  const updated = await unsafeDbClient().jurisdiction.update({
    where: { id },
    data: {
      ...(input.countryCode !== undefined ? { countryCode: input.countryCode } : {}),
      ...(input.regionCode !== undefined ? { regionCode: input.regionCode ?? null } : {}),
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.isActive !== undefined ? { isActive: input.isActive } : {}),
    },
    include: { _count: { select: { authorities: true, rulePacks: true } } },
  });

  return toJurisdictionSummary(updated);
}

// ===========================================================================
// Authorities
// ===========================================================================

export async function listAuthoritiesForPlatform(
  query: RegulatoryAuthorityQuery
): Promise<RegulatoryAuthorityListResponse> {
  const where = {
    ...(query.jurisdictionId ? { jurisdictionId: query.jurisdictionId } : {}),
    ...(query.includeInactive ? {} : { isActive: true }),
  };

  const [rows, total] = await Promise.all([
    unsafeDbClient().regulatoryAuthority.findMany({
      where,
      orderBy: [{ code: 'asc' }],
      skip: (query.page - 1) * query.limit,
      take: query.limit,
      include: { jurisdiction: { select: jurisdictionSelect } },
    }),
    unsafeDbClient().regulatoryAuthority.count({ where }),
  ]);

  return {
    authorities: rows.map(toAuthoritySummary),
    meta: pageMeta(total, query.page, query.limit),
  };
}

export async function createAuthority(
  input: CreateRegulatoryAuthorityRequest
): Promise<RegulatoryAuthoritySummary> {
  const existing = await unsafeDbClient().regulatoryAuthority.findUnique({
    where: { code: input.code },
  });
  if (existing) {
    throw new ConflictError(
      `An authority with the code ${input.code} already exists. Codes are global — two countries' regulators cannot share one.`
    );
  }

  const created = await unsafeDbClient().regulatoryAuthority.create({
    data: {
      jurisdictionId: input.jurisdictionId,
      code: input.code,
      name: input.name,
      websiteUrl: input.websiteUrl ?? null,
      remit: input.remit ?? null,
      isActive: input.isActive,
    },
    include: { jurisdiction: { select: jurisdictionSelect } },
  });

  return toAuthoritySummary(created);
}

export async function updateAuthority(
  id: string,
  input: UpdateRegulatoryAuthorityRequest
): Promise<RegulatoryAuthoritySummary> {
  const current = await unsafeDbClient().regulatoryAuthority.findUnique({ where: { id } });
  if (!current) throw new NotFoundError('Regulatory authority');

  const updated = await unsafeDbClient().regulatoryAuthority.update({
    where: { id },
    data: {
      ...(input.jurisdictionId !== undefined ? { jurisdictionId: input.jurisdictionId } : {}),
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.websiteUrl !== undefined ? { websiteUrl: input.websiteUrl ?? null } : {}),
      ...(input.remit !== undefined ? { remit: input.remit ?? null } : {}),
      ...(input.isActive !== undefined ? { isActive: input.isActive } : {}),
    },
    include: { jurisdiction: { select: jurisdictionSelect } },
  });

  return toAuthoritySummary(updated);
}

// ===========================================================================
// Sources
// ===========================================================================

export async function listSourcesForPlatform(
  query: RegulatorySourceQuery
): Promise<RegulatorySourceListResponse> {
  const where = {
    ...(query.jurisdictionId ? { jurisdictionId: query.jurisdictionId } : {}),
    ...(query.authorityId ? { authorityId: query.authorityId } : {}),
    ...(query.reviewStatus ? { reviewStatus: query.reviewStatus } : {}),
  };

  const [rows, total] = await Promise.all([
    unsafeDbClient().regulatorySource.findMany({
      where,
      orderBy: [{ title: 'asc' }],
      skip: (query.page - 1) * query.limit,
      take: query.limit,
      include: {
        jurisdiction: { select: jurisdictionSelect },
        authority: { select: { code: true } },
        _count: { select: { rules: true } },
      },
    }),
    unsafeDbClient().regulatorySource.count({ where }),
  ]);

  return {
    sources: rows.map(toSourceSummary),
    meta: pageMeta(total, query.page, query.limit),
  };
}

export async function createSource(
  input: CreateRegulatorySourceRequest
): Promise<RegulatorySourceSummary> {
  const authority = await unsafeDbClient().regulatoryAuthority.findUnique({
    where: { id: input.authorityId },
    select: { jurisdictionId: true },
  });
  if (!authority) throw new NotFoundError('Regulatory authority');

  const created = await unsafeDbClient().regulatorySource.create({
    data: {
      jurisdictionId: input.jurisdictionId,
      authorityId: input.authorityId,
      title: input.title,
      documentReference: input.documentReference ?? null,
      sourceUrl: input.sourceUrl ?? null,
      version: input.version ?? null,
      publishedOn: input.publishedOn ? toDateOnly(input.publishedOn) : null,
      effectiveFrom: input.effectiveFrom ? toDateOnly(input.effectiveFrom) : null,
      retrievedAt: input.retrievedAt ? new Date(input.retrievedAt) : null,
      reviewStatus: input.reviewStatus,
      notes: input.notes ?? null,
    },
    include: {
      jurisdiction: { select: jurisdictionSelect },
      authority: { select: { code: true } },
      _count: { select: { rules: true } },
    },
  });

  return toSourceSummary(created);
}

export async function updateSource(
  id: string,
  input: UpdateRegulatorySourceRequest
): Promise<RegulatorySourceSummary> {
  const current = await unsafeDbClient().regulatorySource.findUnique({ where: { id } });
  if (!current) throw new NotFoundError('Regulatory source');

  const updated = await unsafeDbClient().regulatorySource.update({
    where: { id },
    data: {
      ...(input.jurisdictionId !== undefined ? { jurisdictionId: input.jurisdictionId } : {}),
      ...(input.authorityId !== undefined ? { authorityId: input.authorityId } : {}),
      ...(input.title !== undefined ? { title: input.title } : {}),
      ...(input.documentReference !== undefined
        ? { documentReference: input.documentReference ?? null }
        : {}),
      ...(input.sourceUrl !== undefined ? { sourceUrl: input.sourceUrl ?? null } : {}),
      ...(input.version !== undefined ? { version: input.version ?? null } : {}),
      ...(input.publishedOn !== undefined
        ? { publishedOn: input.publishedOn ? toDateOnly(input.publishedOn) : null }
        : {}),
      ...(input.effectiveFrom !== undefined
        ? { effectiveFrom: input.effectiveFrom ? toDateOnly(input.effectiveFrom) : null }
        : {}),
      ...(input.retrievedAt !== undefined
        ? { retrievedAt: input.retrievedAt ? new Date(input.retrievedAt) : null }
        : {}),
      ...(input.reviewStatus !== undefined ? { reviewStatus: input.reviewStatus } : {}),
      ...(input.notes !== undefined ? { notes: input.notes ?? null } : {}),
    },
    include: {
      jurisdiction: { select: jurisdictionSelect },
      authority: { select: { code: true } },
      _count: { select: { rules: true } },
    },
  });

  return toSourceSummary(updated);
}

// ===========================================================================
// Rule packs
// ===========================================================================

const packInclude = {
  jurisdiction: { select: jurisdictionSelect },
  authority: { select: { code: true } },
  _count: { select: { rules: true } },
} as const;

export async function listRulePacksForPlatform(
  query: RulePackQuery
): Promise<RulePackListResponse> {
  const where = {
    ...(query.jurisdictionId ? { jurisdictionId: query.jurisdictionId } : {}),
    ...(query.countryCode ? { jurisdiction: { countryCode: query.countryCode } } : {}),
    ...(query.maturity ? { maturity: query.maturity } : {}),
  };

  const [rows, total] = await Promise.all([
    unsafeDbClient().regulatoryRulePack.findMany({
      where,
      orderBy: [{ effectiveFrom: 'desc' }, { version: 'desc' }],
      skip: (query.page - 1) * query.limit,
      take: query.limit,
      include: packInclude,
    }),
    unsafeDbClient().regulatoryRulePack.count({ where }),
  ]);

  return { packs: rows.map(toRulePackSummary), meta: pageMeta(total, query.page, query.limit) };
}

export async function createRulePack(input: CreateRulePackRequest): Promise<RulePackSummary> {
  const existing = await unsafeDbClient().regulatoryRulePack.findFirst({
    where: { jurisdictionId: input.jurisdictionId, version: input.version },
  });
  if (existing) {
    throw new ConflictError(
      `Version ${input.version} already exists for that jurisdiction. A change is a NEW version — ` +
        'a pack is never edited into a different meaning, because a transaction decided last year ' +
        'cites the version that decided it.'
    );
  }

  const created = await unsafeDbClient().regulatoryRulePack.create({
    data: {
      jurisdictionId: input.jurisdictionId,
      authorityId: input.authorityId,
      version: input.version,
      name: input.name,
      description: input.description ?? null,
      maturity: input.maturity,
      effectiveFrom: toDateOnly(input.effectiveFrom),
      effectiveTo: input.effectiveTo ? toDateOnly(input.effectiveTo) : null,
    },
    include: packInclude,
  });

  return toRulePackSummary(created);
}

export async function updateRulePack(
  id: string,
  input: UpdateRulePackRequest
): Promise<RulePackSummary> {
  return unsafeDbClient().$transaction(async (tx) => {
    const current = await lockPack(tx, id);

    /*
     * ⚠️ THE CONTRACT DOES **NOT** MAKE THE TWO HUMAN-ONLY STATES UNSAYABLE HERE.
     *   An earlier version of this comment claimed it did, on the strength of
     *   `createRulePack` using `codeSettableMaturity` — but `updateRulePackRequest`
     *   is built by `.partial()` from a schema that also carries `maturity`, and
     *   the derivation is exactly the kind of thing that survives a refactor
     *   looking correct. This check is the guarantee, not a duplicate of one.
     */
    if (input.maturity !== undefined && HUMAN_ONLY.includes(input.maturity)) {
      throw new ValidationError(
        'A rule pack cannot be marked reviewed or production-enabled from here. That is a named ' +
          "person's decision, recorded with their name — use the sign-off action.",
        { maturity: ['Only a reviewer may set this state.'] }
      );
    }

    /*
     * ⚠️ A SIGNED-OFF PACK IS FROZEN ENTIRELY, NOT JUST ITS MATURITY. The guards
     *   here used to fire only when the request carried a `maturity` key, so a
     *   PATCH of `{ "effectiveTo": "2020-01-01" }` sailed past both and took
     *   every rule in a reviewed pack out of force platform-wide — immediately,
     *   with no cache to expire, and with the reviewer's name still on screen.
     *   `loadRules` filters on exactly that window. Moving `effectiveFrom`
     *   instead changes WHICH law applies under an unchanged sign-off, which is
     *   worse than switching it off.
     *
     *   So a reviewed pack takes no edit at all. A pack that needs to change
     *   gets a new VERSION, which is what a version is for.
     */
    assertPackIsOpen(current);

    const updated = await tx.regulatoryRulePack.update({
      where: { id },
      data: {
        ...(input.authorityId !== undefined ? { authorityId: input.authorityId } : {}),
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.description !== undefined ? { description: input.description ?? null } : {}),
        ...(input.maturity !== undefined ? { maturity: input.maturity } : {}),
        ...(input.effectiveFrom !== undefined
          ? { effectiveFrom: toDateOnly(input.effectiveFrom) }
          : {}),
        ...(input.effectiveTo !== undefined
          ? { effectiveTo: input.effectiveTo ? toDateOnly(input.effectiveTo) : null }
          : {}),
      },
      include: packInclude,
    });

    return toRulePackSummary(updated);
  });
}

/**
 * A named human signing a jurisdiction off (OD-5, PI-ADR-009).
 *
 * ⚠️ THE ONLY PATH TO `REGULATORY_REVIEWED` AND `PRODUCTION_ENABLED` IN THIS
 *   CODEBASE. It is gated on `regulatory.pack.approve`, which no system role
 *   holds — ORG_OWNER is excluded by name in roles.ts precisely because it is
 *   an "everything except" role. Three things must be true, and each is checked
 *   somewhere different:
 *
 *     the caller holds the code      the route's `authorize`
 *     the pack reached the handover  here
 *     a reviewer is named            here, and the CHECK constraint again
 *
 * ⚠️ THE LADDER MAY NOT BE SKIPPED. A pack that has not reached
 *   `REGULATORY_REVIEW_PENDING` has not been source-verified or tested, and
 *   signing off rules nobody has checked is exactly the failure the ladder
 *   exists to make visible. `PRODUCTION_ENABLED` additionally requires that the
 *   pack has already been REVIEWED — two events, two decisions.
 */
export async function approveRulePack(
  id: string,
  input: ApproveRulePackRequest,
  actorUserId: string
): Promise<RulePackSummary> {
  return unsafeDbClient().$transaction(async (tx) => {
    /*
     * ⚠️ LOCKED, so the ladder cannot be climbed twice from one state. Without
     *   it, two sign-offs racing from `REGULATORY_REVIEW_PENDING` both read the
     *   same maturity and both write — and the second reviewer's name is the one
     *   that survives, over a decision the first person believed they had made.
     */
    const current = await lockPack(tx, id);

    if (
      input.maturity === 'REGULATORY_REVIEWED' &&
      current.maturity !== 'REGULATORY_REVIEW_PENDING'
    ) {
      throw new ValidationError(
        `This pack is ${current.maturity}. A pack is signed off from REGULATORY_REVIEW_PENDING — ` +
          'the state that means somebody has verified every source and the behaviour tests pass.'
      );
    }

    if (input.maturity === 'PRODUCTION_ENABLED' && current.maturity !== 'REGULATORY_REVIEWED') {
      throw new ValidationError(
        `This pack is ${current.maturity}. Enabling it in production is a separate decision from ` +
          'reviewing it, and follows REGULATORY_REVIEWED.'
      );
    }

    const now = new Date();
    const updated = await tx.regulatoryRulePack.update({
      where: { id },
      data: {
        maturity: input.maturity,
        reviewedBy: input.reviewedBy,
        reviewedByUserId: actorUserId,
        reviewedAt: now,
        lastReviewedAt: now,
        reviewNotes: input.reviewNotes,
      },
      include: packInclude,
    });

    return toRulePackSummary(updated);
  });
}

// ===========================================================================
// Rules
// ===========================================================================

const ruleInclude = {
  pack: {
    select: {
      version: true,
      maturity: true,
      jurisdiction: { select: jurisdictionSelect },
    },
  },
  source: { select: { title: true, sourceUrl: true } },
} as const;

export async function listRulesForPlatform(
  query: RegulatoryRuleQuery
): Promise<RegulatoryRuleListResponse> {
  const where = {
    ...(query.packId ? { packId: query.packId } : {}),
    ...(query.ruleType ? { ruleType: query.ruleType } : {}),
    ...(query.status ? { status: query.status } : {}),
  };

  const [rows, total] = await Promise.all([
    unsafeDbClient().regulatoryRule.findMany({
      where,
      orderBy: [{ ruleType: 'asc' }, { code: 'asc' }, { version: 'desc' }],
      skip: (query.page - 1) * query.limit,
      take: query.limit,
      include: ruleInclude,
    }),
    unsafeDbClient().regulatoryRule.count({ where }),
  ]);

  const today = calendarToday();
  return {
    rules: rows.map((row) => toRuleDetail(row, today)),
    meta: pageMeta(total, query.page, query.limit),
  };
}

/**
 * Add a rule to a pack.
 *
 * ⚠️ ADDING A RULE TO A PACK SOMEBODY HAS ALREADY SIGNED OFF IS REFUSED. The
 *   sign-off is a statement about a SET of rules; letting a seventeenth arrive
 *   afterwards makes the reviewer's name cover something they never saw. That is
 *   the whole failure mode PI-ADR-009 is written against, and it would be
 *   invisible — the screen would show a reviewed pack, with a new rule in it.
 */
export async function createRule(
  packId: string,
  input: CreateRegulatoryRuleRequest
): Promise<RegulatoryRuleDetail> {
  return unsafeDbClient().$transaction(async (tx) => {
    /*
     * ⚠️ THE PACK IS LOCKED BEFORE ITS MATURITY IS READ, AND THE INSERT HAPPENS
     *   IN THE SAME TRANSACTION. Previously the read and the write were two
     *   autocommit statements against two DIFFERENT tables, so a sign-off
     *   committing between them produced a rule inside a pack a named human had
     *   already signed — the exact thing the paragraph above says is refused.
     *   Nothing downstream catches it: the CHECK constrains the PACK row, and
     *   `regulatory_rules` has no constraint that can see a pack's maturity.
     *
     *   This is PI-4's lesson, verbatim: the row being locked has to be the row
     *   the decision is made AGAINST, not the row being written.
     */
    const pack = await lockPack(tx, packId);
    assertPackIsOpen(pack);

    const source = await tx.regulatorySource.findUnique({
      where: { id: input.sourceId },
      select: { id: true },
    });
    /*
     * ⚠️ CHECKED HERE FOR THE SENTENCE, ENFORCED BY `source_id NOT NULL` AND THE FK
     *   REGARDLESS. No source, no rule — the single most important constraint in
     *   this domain, and the one an agent under time pressure is most tempted to
     *   route around.
     */
    if (!source) {
      throw new ValidationError(
        "That source does not exist. Every rule cites the regulator's own publication — record the " +
          'source first, and if it cannot be found, do not write the rule.'
      );
    }

    const existing = await tx.regulatoryRule.findFirst({
      where: { packId, code: input.code },
      orderBy: { version: 'desc' },
    });

    const created = await tx.regulatoryRule.create({
      data: {
        packId,
        ruleType: input.ruleType,
        code: input.code,
        statement: input.statement,
        status: input.status,
        appliesToProductType: input.appliesToProductType ?? null,
        appliesToCategoryId: input.appliesToCategoryId ?? null,
        appliesToClassification: input.appliesToClassification ?? null,
        appliesToTransactions: input.appliesToTransactions,
        /*
         * ⚠️ CAST, NOT COERCED. Prisma types a JSONB column as `InputJsonValue`,
         *   which a `Record<string, unknown>` is not assignable to; the contract
         *   has already validated the shape it cares about, and the rest of the
         *   document is deliberately open — a jurisdiction's parameters vary.
         */
        parameters: input.parameters as Prisma.InputJsonValue,
        sourceId: input.sourceId,
        /*
         * ⚠️ A REPEATED CODE IS A NEW VERSION, NOT A CONFLICT. That is how a rule
         *   changes: the old row keeps its `effectiveTo` and stays readable
         *   forever, because a decision made under it cites it (PI-ADR-008).
         *   Superseding the previous row is the CALLER's act — it is a statement
         *   about dates — so this does not touch it.
         */
        version: (existing?.version ?? 0) + 1,
        effectiveFrom: toDateOnly(input.effectiveFrom),
        effectiveTo: input.effectiveTo ? toDateOnly(input.effectiveTo) : null,
      },
      include: ruleInclude,
    });

    return toRuleDetail(created, calendarToday());
  });
}

export async function updateRule(
  id: string,
  input: UpdateRegulatoryRuleRequest
): Promise<RegulatoryRuleDetail> {
  return unsafeDbClient().$transaction(async (tx) => {
    const existing = await tx.regulatoryRule.findUnique({
      where: { id },
      select: { id: true, packId: true },
    });
    if (!existing) throw new NotFoundError('Regulatory rule');

    // Same lock, same reason as `createRule`: the pack is the row this decision
    // is made against, and it is not the row being written.
    const pack = await lockPack(tx, existing.packId);
    assertPackIsOpen(pack);

    const updated = await tx.regulatoryRule.update({
      where: { id },
      data: {
        ...(input.statement !== undefined ? { statement: input.statement } : {}),
        ...(input.status !== undefined ? { status: input.status } : {}),
        ...(input.appliesToProductType !== undefined
          ? { appliesToProductType: input.appliesToProductType ?? null }
          : {}),
        ...(input.appliesToCategoryId !== undefined
          ? { appliesToCategoryId: input.appliesToCategoryId ?? null }
          : {}),
        ...(input.appliesToClassification !== undefined
          ? { appliesToClassification: input.appliesToClassification ?? null }
          : {}),
        ...(input.appliesToTransactions !== undefined
          ? { appliesToTransactions: input.appliesToTransactions }
          : {}),
        ...(input.parameters !== undefined
          ? { parameters: input.parameters as Prisma.InputJsonValue }
          : {}),
        ...(input.sourceId !== undefined ? { sourceId: input.sourceId } : {}),
        ...(input.effectiveFrom !== undefined
          ? { effectiveFrom: toDateOnly(input.effectiveFrom) }
          : {}),
        ...(input.effectiveTo !== undefined
          ? { effectiveTo: input.effectiveTo ? toDateOnly(input.effectiveTo) : null }
          : {}),
      },
      include: ruleInclude,
    });

    return toRuleDetail(updated, calendarToday());
  });
}

/**
 * A pack a named human has signed off takes no edit at all — not to its rules,
 * and not to its own dates.
 *
 * ⚠️ CALLED FROM `updateRulePack` AS WELL AS THE TWO RULE WRITERS, and it was
 *   not. A `{ "effectiveTo": "2020-01-01" }` PATCH on a `PRODUCTION_ENABLED`
 *   pack skipped both maturity guards there — they only fire when the request
 *   carries a `maturity` key — and `loadRules` filters on exactly that window,
 *   so every rule in a reviewed pack left force platform-wide, immediately,
 *   with the reviewer's name still on the screen.
 */
function assertPackIsOpen(pack: { maturity: string; reviewedBy: string | null }): void {
  if (HUMAN_ONLY.includes(pack.maturity as (typeof HUMAN_ONLY)[number])) {
    throw new ValidationError(
      `That pack was signed off by ${pack.reviewedBy ?? 'a reviewer'} and its rules are frozen. ` +
        'Publish a new version of the pack and change the rule there — a sign-off is a statement ' +
        'about the rules that existed when it was made.'
    );
  }
}
