/**
 * Reading the law, from inside a clinic's request.
 *
 * Every table this file touches — `jurisdictions`, `regulatory_authorities`,
 * `regulatory_sources`, `regulatory_rule_packs`, `regulatory_rules` — is
 * PLATFORM data with no `organization_id` and no RLS policy, for the reason
 * written into enable-rls.sql: it is the law of a country, identical for every
 * clinic in it, and a policy would return zero rows for everybody.
 *
 * ⚠️ THE READS STILL GO THROUGH `withTenant`, AND THAT IS DELIBERATE. It is the
 *   precedent `tax_rule_defaults` already set — `tx.taxRuleDefault.findMany` in
 *   invoicing/tax.service.ts — and it costs nothing: the transaction sets a
 *   tenant context these tables ignore. What it buys is that no tenant-facing
 *   service in this domain imports `@rcln/db/unsafe`, so `grep -r
 *   "@rcln/db/unsafe"` keeps listing only the genuinely pre-tenant paths. The
 *   platform console's WRITES are in services/platform/regulatory.service.ts,
 *   which is the file that does import it.
 *
 * ⚠️ NOTHING HERE WRITES. A clinic never writes a rule pack, the route carries
 *   no manage code, and `platform_law_not_tenant_writable` refuses it at the
 *   database if both of those are ever forgotten.
 *
 * NO PHI.
 */
import { withTenant, type TenantContext } from '@rcln/db';
import type {
  JurisdictionListResponse,
  JurisdictionQuery,
  RegulatoryAuthorityListResponse,
  RegulatoryAuthorityQuery,
  RegulatoryRuleListResponse,
  RegulatoryRuleQuery,
  RegulatorySourceListResponse,
  RegulatorySourceQuery,
  RulePackListResponse,
  RulePackQuery,
} from '@rcln/contracts';
import { NotFoundError } from '../../utils/errors.js';
import { calendarToday } from '../product/values.js';
import {
  pageMeta,
  toAuthoritySummary,
  toJurisdictionSummary,
  toRuleDetail,
  toRulePackSummary,
  toSourceSummary,
} from './shared.js';

export async function listJurisdictions(
  ctx: TenantContext,
  query: JurisdictionQuery
): Promise<JurisdictionListResponse> {
  return withTenant(ctx, async (tx) => {
    const where = {
      ...(query.countryCode ? { countryCode: query.countryCode } : {}),
      ...(query.includeInactive ? {} : { isActive: true }),
    };

    const [rows, total] = await Promise.all([
      tx.jurisdiction.findMany({
        where,
        orderBy: [{ countryCode: 'asc' }, { regionCode: 'asc' }],
        skip: (query.page - 1) * query.limit,
        take: query.limit,
        include: { _count: { select: { authorities: true, rulePacks: true } } },
      }),
      tx.jurisdiction.count({ where }),
    ]);

    return {
      jurisdictions: rows.map(toJurisdictionSummary),
      meta: pageMeta(total, query.page, query.limit),
    };
  });
}

export async function listAuthorities(
  ctx: TenantContext,
  query: RegulatoryAuthorityQuery
): Promise<RegulatoryAuthorityListResponse> {
  return withTenant(ctx, async (tx) => {
    const where = {
      ...(query.jurisdictionId ? { jurisdictionId: query.jurisdictionId } : {}),
      ...(query.includeInactive ? {} : { isActive: true }),
    };

    const [rows, total] = await Promise.all([
      tx.regulatoryAuthority.findMany({
        where,
        orderBy: [{ code: 'asc' }],
        skip: (query.page - 1) * query.limit,
        take: query.limit,
        include: { jurisdiction: { select: { countryCode: true, regionCode: true } } },
      }),
      tx.regulatoryAuthority.count({ where }),
    ]);

    return {
      authorities: rows.map(toAuthoritySummary),
      meta: pageMeta(total, query.page, query.limit),
    };
  });
}

export async function listSources(
  ctx: TenantContext,
  query: RegulatorySourceQuery
): Promise<RegulatorySourceListResponse> {
  return withTenant(ctx, async (tx) => {
    const where = {
      ...(query.jurisdictionId ? { jurisdictionId: query.jurisdictionId } : {}),
      ...(query.authorityId ? { authorityId: query.authorityId } : {}),
      ...(query.reviewStatus ? { reviewStatus: query.reviewStatus } : {}),
    };

    const [rows, total] = await Promise.all([
      tx.regulatorySource.findMany({
        where,
        orderBy: [{ title: 'asc' }],
        skip: (query.page - 1) * query.limit,
        take: query.limit,
        include: {
          jurisdiction: { select: { countryCode: true, regionCode: true } },
          authority: { select: { code: true } },
          _count: { select: { rules: true } },
        },
      }),
      tx.regulatorySource.count({ where }),
    ]);

    return {
      sources: rows.map(toSourceSummary),
      meta: pageMeta(total, query.page, query.limit),
    };
  });
}

export async function listRulePacks(
  ctx: TenantContext,
  query: RulePackQuery
): Promise<RulePackListResponse> {
  return withTenant(ctx, async (tx) => {
    const where = {
      ...(query.jurisdictionId ? { jurisdictionId: query.jurisdictionId } : {}),
      ...(query.countryCode ? { jurisdiction: { countryCode: query.countryCode } } : {}),
      ...(query.maturity ? { maturity: query.maturity } : {}),
    };

    const [rows, total] = await Promise.all([
      tx.regulatoryRulePack.findMany({
        where,
        orderBy: [{ effectiveFrom: 'desc' }, { version: 'desc' }],
        skip: (query.page - 1) * query.limit,
        take: query.limit,
        include: {
          jurisdiction: { select: { countryCode: true, regionCode: true } },
          authority: { select: { code: true } },
          _count: { select: { rules: true } },
        },
      }),
      tx.regulatoryRulePack.count({ where }),
    ]);

    return {
      packs: rows.map(toRulePackSummary),
      meta: pageMeta(total, query.page, query.limit),
    };
  });
}

export async function getRulePack(
  ctx: TenantContext,
  packId: string
): Promise<RulePackListResponse['packs'][number]> {
  return withTenant(ctx, async (tx) => {
    const row = await tx.regulatoryRulePack.findUnique({
      where: { id: packId },
      include: {
        jurisdiction: { select: { countryCode: true, regionCode: true } },
        authority: { select: { code: true } },
        _count: { select: { rules: true } },
      },
    });
    if (!row) throw new NotFoundError('Rule pack');
    return toRulePackSummary(row);
  });
}

export async function listRules(
  ctx: TenantContext,
  query: RegulatoryRuleQuery
): Promise<RegulatoryRuleListResponse> {
  return withTenant(ctx, async (tx) => {
    const where = {
      ...(query.packId ? { packId: query.packId } : {}),
      ...(query.ruleType ? { ruleType: query.ruleType } : {}),
      ...(query.status ? { status: query.status } : {}),
    };

    const [rows, total] = await Promise.all([
      tx.regulatoryRule.findMany({
        where,
        orderBy: [{ ruleType: 'asc' }, { code: 'asc' }, { version: 'desc' }],
        skip: (query.page - 1) * query.limit,
        take: query.limit,
        include: {
          pack: {
            select: {
              version: true,
              maturity: true,
              jurisdiction: { select: { countryCode: true, regionCode: true } },
            },
          },
          source: { select: { title: true, sourceUrl: true } },
        },
      }),
      tx.regulatoryRule.count({ where }),
    ]);

    const today = calendarToday();
    return {
      rules: rows.map((row) => toRuleDetail(row, today)),
      meta: pageMeta(total, query.page, query.limit),
    };
  });
}
