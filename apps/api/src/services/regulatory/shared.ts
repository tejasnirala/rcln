/**
 * Turning regulatory rows into wire values, in one place.
 *
 * Both sides of this domain map the same rows — the platform console writes them
 * and every tenant reads them — so the mappers live here rather than once per
 * service. `product/values.ts` already owns the date helpers and this file uses
 * them rather than growing a fourth copy; see that file's header for why the
 * calendar-day rule is not a preference.
 *
 * NO PHI. Nothing in this domain names a patient.
 */
import type {
  JurisdictionSummary,
  RegulatoryAuthoritySummary,
  RegulatoryRuleDetail,
  RegulatorySourceSummary,
  RulePackSummary,
} from '@rcln/contracts';
import type { RulePackMaturity } from '@rcln/regulatory';
import { calendarToday, isCurrentOn, toCalendarDate } from '../product/values.js';

/** `IN-KA` or `IN`. Formatted once so no screen has to decide. */
export function jurisdictionLabel(jurisdiction: {
  countryCode: string;
  regionCode: string | null;
}): string {
  return jurisdiction.regionCode
    ? `${jurisdiction.countryCode}-${jurisdiction.regionCode}`
    : jurisdiction.countryCode;
}

/**
 * The two maturities a code path may never set (PI-ADR-009).
 *
 * ⚠️ IMPORTED FROM `@rcln/regulatory` RATHER THAN RETYPED, so a ninth maturity
 *   added to the schema cannot become settable here by omission.
 */
export const HUMAN_ONLY: readonly RulePackMaturity[] = [
  'REGULATORY_REVIEWED',
  'PRODUCTION_ENABLED',
];

export interface JurisdictionRow {
  id: string;
  countryCode: string;
  regionCode: string | null;
  name: string;
  isActive: boolean;
  _count?: { authorities: number; rulePacks: number };
}

export function toJurisdictionSummary(row: JurisdictionRow): JurisdictionSummary {
  return {
    id: row.id,
    countryCode: row.countryCode,
    regionCode: row.regionCode,
    label: jurisdictionLabel(row),
    name: row.name,
    isActive: row.isActive,
    authorityCount: row._count?.authorities ?? 0,
    rulePackCount: row._count?.rulePacks ?? 0,
  };
}

export interface AuthorityRow {
  id: string;
  jurisdictionId: string;
  code: string;
  name: string;
  websiteUrl: string | null;
  remit: string | null;
  isActive: boolean;
  jurisdiction: { countryCode: string; regionCode: string | null };
}

export function toAuthoritySummary(row: AuthorityRow): RegulatoryAuthoritySummary {
  return {
    id: row.id,
    jurisdictionId: row.jurisdictionId,
    jurisdictionLabel: jurisdictionLabel(row.jurisdiction),
    code: row.code,
    name: row.name,
    websiteUrl: row.websiteUrl,
    remit: row.remit,
    isActive: row.isActive,
  };
}

export interface SourceRow {
  id: string;
  jurisdictionId: string;
  authorityId: string;
  title: string;
  documentReference: string | null;
  sourceUrl: string | null;
  version: string | null;
  publishedOn: Date | null;
  effectiveFrom: Date | null;
  retrievedAt: Date | null;
  reviewStatus: string;
  notes: string | null;
  jurisdiction: { countryCode: string; regionCode: string | null };
  authority: { code: string };
  _count?: { rules: number };
}

export function toSourceSummary(row: SourceRow): RegulatorySourceSummary {
  return {
    id: row.id,
    jurisdictionId: row.jurisdictionId,
    jurisdictionLabel: jurisdictionLabel(row.jurisdiction),
    authorityId: row.authorityId,
    authorityCode: row.authority.code,
    title: row.title,
    documentReference: row.documentReference,
    sourceUrl: row.sourceUrl,
    version: row.version,
    publishedOn: row.publishedOn ? toCalendarDate(row.publishedOn) : null,
    effectiveFrom: row.effectiveFrom ? toCalendarDate(row.effectiveFrom) : null,
    /* An instant, not a day — it records when somebody read the document. */
    retrievedAt: row.retrievedAt ? row.retrievedAt.toISOString() : null,
    reviewStatus: row.reviewStatus as RegulatorySourceSummary['reviewStatus'],
    notes: row.notes,
    ruleCount: row._count?.rules ?? 0,
  };
}

export interface RulePackRow {
  id: string;
  jurisdictionId: string;
  authorityId: string;
  version: string;
  name: string;
  description: string | null;
  maturity: string;
  effectiveFrom: Date;
  effectiveTo: Date | null;
  lastReviewedAt: Date | null;
  reviewedBy: string | null;
  reviewedAt: Date | null;
  reviewNotes: string | null;
  jurisdiction: { countryCode: string; regionCode: string | null };
  authority: { code: string };
  _count?: { rules: number };
}

export function toRulePackSummary(row: RulePackRow): RulePackSummary {
  return {
    id: row.id,
    jurisdictionId: row.jurisdictionId,
    jurisdictionLabel: jurisdictionLabel(row.jurisdiction),
    authorityId: row.authorityId,
    authorityCode: row.authority.code,
    version: row.version,
    name: row.name,
    description: row.description,
    maturity: row.maturity as RulePackSummary['maturity'],
    /*
     * Derived, never stored. ⚠️ AND IT IS THE FIELD EVERY SCREEN'S BANNER READS:
     * false means "this jurisdiction is configured, not signed off", which is
     * the honest state of every pack until a named human says otherwise.
     */
    isProductionEnabled: row.maturity === 'PRODUCTION_ENABLED',
    effectiveFrom: toCalendarDate(row.effectiveFrom),
    effectiveTo: row.effectiveTo ? toCalendarDate(row.effectiveTo) : null,
    lastReviewedAt: row.lastReviewedAt ? row.lastReviewedAt.toISOString() : null,
    reviewedBy: row.reviewedBy,
    reviewedAt: row.reviewedAt ? row.reviewedAt.toISOString() : null,
    reviewNotes: row.reviewNotes,
    ruleCount: row._count?.rules ?? 0,
  };
}

export interface RuleRow {
  id: string;
  packId: string;
  ruleType: string;
  code: string;
  statement: string;
  status: string;
  appliesToProductType: string | null;
  appliesToCategoryId: string | null;
  appliesToClassification: string | null;
  appliesToTransactions: string[];
  parameters: unknown;
  sourceId: string;
  version: number;
  effectiveFrom: Date;
  effectiveTo: Date | null;
  pack: {
    version: string;
    maturity: string;
    jurisdiction: { countryCode: string; regionCode: string | null };
  };
  source: { title: string; sourceUrl: string | null };
}

export function toRuleDetail(row: RuleRow, on: Date = calendarToday()): RegulatoryRuleDetail {
  return {
    id: row.id,
    packId: row.packId,
    packVersion: row.pack.version,
    packMaturity: row.pack.maturity as RegulatoryRuleDetail['packMaturity'],
    jurisdictionLabel: jurisdictionLabel(row.pack.jurisdiction),
    ruleType: row.ruleType as RegulatoryRuleDetail['ruleType'],
    code: row.code,
    statement: row.statement,
    status: row.status as RegulatoryRuleDetail['status'],
    appliesToProductType: row.appliesToProductType as RegulatoryRuleDetail['appliesToProductType'],
    appliesToCategoryId: row.appliesToCategoryId,
    appliesToClassification: row.appliesToClassification,
    appliesToTransactions:
      row.appliesToTransactions as RegulatoryRuleDetail['appliesToTransactions'],
    parameters: (row.parameters ?? {}) as Record<string, unknown>,
    sourceId: row.sourceId,
    sourceTitle: row.source.title,
    sourceUrl: row.source.sourceUrl,
    version: row.version,
    effectiveFrom: toCalendarDate(row.effectiveFrom),
    effectiveTo: row.effectiveTo ? toCalendarDate(row.effectiveTo) : null,
    /*
     * ⚠️ DERIVED FROM THE STATUS **AND** THE WINDOW, because either alone lies:
     * a DRAFT rule inside its dates is not live, and an ACTIVE rule whose
     * `effectiveTo` has passed is not either. The engine applies exactly this
     * pair, and a screen that disagreed with it would show a rule as live that
     * refuses nothing.
     */
    isLive:
      row.status === 'ACTIVE' &&
      row.effectiveFrom.getTime() <= on.getTime() &&
      isCurrentOn(row.effectiveTo, on),
  };
}

/** The page envelope every list in this domain returns. */
export function pageMeta(
  total: number,
  page: number,
  limit: number
): { page: number; limit: number; total: number; totalPages: number } {
  return { page, limit, total, totalPages: Math.max(1, Math.ceil(total / limit)) };
}
