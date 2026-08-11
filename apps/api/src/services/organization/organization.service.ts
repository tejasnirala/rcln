/**
 * The clinic's own particulars — the row every other row hangs off.
 *
 * ⚠️ `organizations` IS RLS-EXEMPT, AND THAT IS NOT AN OVERSIGHT
 *   It is on the EXEMPT list in `packages/db/scripts/check-rls.ts` with the
 *   reason "resolved by hostname before a tenant context exists": the table the
 *   tenant is derived FROM cannot be filtered by the tenant. There is no
 *   `tenant_isolation` policy here to catch a mistake.
 *
 *   The consequence is blunt. `tx.organization.update({ where: { id } })` inside
 *   `withTenant` will happily rewrite another clinic's legal name, and nothing
 *   in Postgres, the type system or a single-tenant test will say a word. So
 *   every statement in this file addresses `ctx.organizationId` and nothing
 *   else, and the id never comes from a request body or a path parameter — the
 *   route is `/organization`, singular, and the only organization it can mean is
 *   the one the Host header resolved to.
 *
 * THE CACHE IS PART OF THE WRITE
 *   `resolveTenant` caches `{ organizationId, slug, status, currency, timezone }`
 *   against the host for 300 seconds. Two of those five are editable here, so an
 *   update that does not drop the cache leaves the API serving a stale currency
 *   for five minutes — long enough to be noticed and short enough to be blamed
 *   on something else. Every domain the organization owns is invalidated, not
 *   just the platform subdomain, because a clinic on a custom domain reaches the
 *   same row through a different key.
 *
 *   Dropped AFTER the commit, never inside it: a rolled-back update that had
 *   already cleared the cache makes every clinic pay for a rebuild of something
 *   that did not change.
 */
import { withTenant, type TenantContext } from '@rcln/db';
import { realignUnbilledCurrency } from '@rcln/billing';
import type { OrganizationProfile, UpdateOrganizationRequest } from '@rcln/contracts';
import { NotFoundError } from '../../utils/errors.js';
import { invalidateTenantCache } from '../../middleware/tenant.middleware.js';
import { recordAudit } from '../audit/audit.service.js';

/** Request metadata carried onto the audit row. Same shape as the branch service. */
export interface OrganizationActionOptions {
  ipAddress?: string | undefined;
  userAgent?: string | undefined;
}

/** What Prisma is asked for, so the read and the write paths cannot drift. */
const ORGANIZATION_SELECT = {
  id: true,
  slug: true,
  legalName: true,
  displayName: true,
  orgType: true,
  status: true,
  taxId: true,
  timezone: true,
  currency: true,
  countryCode: true,
  regionCode: true,
  onboardedAt: true,
} as const;

interface OrganizationRow {
  id: string;
  slug: string;
  legalName: string;
  displayName: string;
  orgType: OrganizationProfile['orgType'];
  status: OrganizationProfile['status'];
  taxId: string | null;
  timezone: string;
  currency: string;
  countryCode: string;
  regionCode: string | null;
  onboardedAt: Date | null;
}

function toProfile(
  row: OrganizationRow,
  taxRegistrations: OrganizationProfile['taxRegistrations']
): OrganizationProfile {
  return {
    ...row,
    taxRegistrations,
    onboardedAt: row.onboardedAt?.toISOString() ?? null,
  };
}

/**
 * The registrations this organization holds, for DISPLAY on the settings screen.
 *
 * ⚠️ A REFERENCE, NOT A SECOND COPY, AND THAT DISTINCTION IS THE WHOLE REASON
 *   THIS FUNCTION EXISTS. The clinic details screen has always shown a tax
 *   number; it used to show `organizations.tax_id`, a value typed into that
 *   screen and maintained nowhere else, which could disagree with what every
 *   invoice printed. Now it shows what the registrations say. Editing them is
 *   `/tax/registrations` — this endpoint reads and never writes them.
 *
 * ⚠️ ZERO IS AN ANSWER. A clinic below the registration threshold holds none, and
 *   the screen must say so rather than render an empty field that looks unfilled.
 *
 * Ordered live-first, then newest — the number in force reads above the ones it
 * succeeded.
 */
async function loadTaxRegistrations(
  tx: Parameters<Parameters<typeof withTenant>[1]>[0],
  at: Date
): Promise<OrganizationProfile['taxRegistrations']> {
  const rows = await tx.issuerTaxRegistration.findMany({
    where: { deletedAt: null },
    select: {
      id: true,
      scheme: true,
      registrationNumber: true,
      countryCode: true,
      regionCode: true,
      legalName: true,
      effectiveFrom: true,
      effectiveTo: true,
    },
    orderBy: [{ effectiveTo: 'asc' }, { effectiveFrom: 'desc' }],
  });

  const day = (value: Date): string => value.toISOString().slice(0, 10);

  return rows.map((row) => ({
    id: row.id,
    scheme: row.scheme,
    registrationNumber: row.registrationNumber,
    placeOfSupply: row.regionCode ? `${row.countryCode}-${row.regionCode}` : row.countryCode,
    legalName: row.legalName,
    // The same three-way derivation the tax service uses, from the same two
    // dates. Never stored: a status column is wrong from the following midnight.
    status:
      row.effectiveFrom > at
        ? ('SCHEDULED' as const)
        : row.effectiveTo !== null && row.effectiveTo < at
          ? ('LAPSED' as const)
          : ('ACTIVE' as const),
    effectiveFrom: day(row.effectiveFrom),
    effectiveTo: row.effectiveTo ? day(row.effectiveTo) : null,
  }));
}

export async function getOrganization(ctx: TenantContext): Promise<OrganizationProfile> {
  const result = await withTenant(ctx, async (tx) => {
    const row = await tx.organization.findFirst({
      // Not findUnique by id alone — see the header. deletedAt is checked here
      // because nothing else will: a soft-deleted organization is still a row.
      where: { id: ctx.organizationId, deletedAt: null },
      select: ORGANIZATION_SELECT,
    });
    if (!row) return null;

    return { row, taxRegistrations: await loadTaxRegistrations(tx, new Date()) };
  });

  if (!result) throw new NotFoundError('Organization');
  return toProfile(result.row, result.taxRegistrations);
}

export async function updateOrganization(
  ctx: TenantContext,
  input: UpdateOrganizationRequest,
  options: OrganizationActionOptions = {}
): Promise<OrganizationProfile> {
  const updated = await withTenant(ctx, async (tx) => {
    const before = await tx.organization.findFirst({
      where: { id: ctx.organizationId, deletedAt: null },
      select: ORGANIZATION_SELECT,
    });
    if (!before) throw new NotFoundError('Organization');

    /*
     * ⚠️ THE TAX-NUMBER CHECK THAT USED TO BE HERE IS GONE BECAUSE THE FIELD IS.
     *   `taxId` is no longer part of this request: the clinic's number is a
     *   property of a TAX REGISTRATION, which also carries the scheme, the
     *   jurisdiction and the dates it was in force, and validating a bare string
     *   here was the second of two independently maintained copies of it.
     *
     *   The country-aware shape check still runs at SIGNUP, where the number and
     *   the country arrive together and seed the clinic's first registration.
     *   `POST /tax/registrations` deliberately does not repeat it: that endpoint
     *   records a registration in any country under any of three schemes, and
     *   `taxIdFormatFor` knows one format per COUNTRY — checking a US sales-tax
     *   permit against it would reject a valid number. A shape check per
     *   (country, scheme) is the thing that would earn its place there.
     */
    const after = await tx.organization.update({
      where: { id: ctx.organizationId },
      // Only the keys the caller actually sent. The request is a partial, so an
      // absent key means "leave it alone" rather than "set null".
      data: Object.fromEntries(Object.entries(input).filter(([, v]) => v !== undefined)),
      select: ORGANIZATION_SELECT,
    });

    /*
     * A clinic that corrects its country is quoted in the currency that country
     * bills in — but only while nothing has been charged yet.
     *
     * The subscription row carries its own currency, denormalised from the price
     * (see the schema comment), and every billing read quotes from it. So a
     * trial opened in INR kept the whole billing screen in rupees after the
     * clinic told us it was in Ireland: the catalogue, the current plan and the
     * upgrade quote. `realignUnbilledCurrency` refuses to touch a subscription
     * that has ever been charged, which is where "fixed at subscribe time"
     * genuinely binds.
     */
    if (after.currency !== before.currency) {
      await realignUnbilledCurrency(tx, ctx, after.currency);
    }

    await recordAudit(tx, ctx, {
      action: 'UPDATE',
      entityType: 'organization',
      entityId: ctx.organizationId,
      before,
      after,
      ...options,
    });

    return { row: after, taxRegistrations: await loadTaxRegistrations(tx, new Date()) };
  });

  await invalidateOrganizationHosts(ctx);
  return toProfile(updated.row, updated.taxRegistrations);
}

/**
 * Drop the host -> tenant cache for every domain this organization answers on.
 *
 * `organization_domains` is RLS-exempt too — scoping the host -> tenant lookup
 * by the tenant it resolves would be circular — so the `where` is the only thing
 * keeping this from enumerating every clinic's hostname. Same rule as the rest
 * of the file.
 */
async function invalidateOrganizationHosts(ctx: TenantContext): Promise<void> {
  const domains = await withTenant(ctx, (tx) =>
    tx.organizationDomain.findMany({
      where: { organizationId: ctx.organizationId },
      select: { domain: true },
    })
  );

  await Promise.all(domains.map((d) => invalidateTenantCache(d.domain)));
}
