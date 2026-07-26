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
  gstNumber: true,
  timezone: true,
  currency: true,
  countryCode: true,
  onboardedAt: true,
} as const;

interface OrganizationRow {
  id: string;
  slug: string;
  legalName: string;
  displayName: string;
  orgType: OrganizationProfile['orgType'];
  status: OrganizationProfile['status'];
  gstNumber: string | null;
  timezone: string;
  currency: string;
  countryCode: string;
  onboardedAt: Date | null;
}

function toProfile(row: OrganizationRow): OrganizationProfile {
  return {
    ...row,
    onboardedAt: row.onboardedAt?.toISOString() ?? null,
  };
}

export async function getOrganization(ctx: TenantContext): Promise<OrganizationProfile> {
  const row = await withTenant(ctx, (tx) =>
    tx.organization.findFirst({
      // Not findUnique by id alone — see the header. deletedAt is checked here
      // because nothing else will: a soft-deleted organization is still a row.
      where: { id: ctx.organizationId, deletedAt: null },
      select: ORGANIZATION_SELECT,
    })
  );

  if (!row) throw new NotFoundError('Organization');
  return toProfile(row);
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

    const after = await tx.organization.update({
      where: { id: ctx.organizationId },
      // Only the keys the caller actually sent. The request is a partial, so an
      // absent key means "leave it alone" — while `gstNumber: null` is a real
      // instruction to clear it, and must survive this filter.
      data: Object.fromEntries(Object.entries(input).filter(([, v]) => v !== undefined)),
      select: ORGANIZATION_SELECT,
    });

    await recordAudit(tx, ctx, {
      action: 'UPDATE',
      entityType: 'organization',
      entityId: ctx.organizationId,
      before,
      after,
      ...options,
    });

    return after;
  });

  await invalidateOrganizationHosts(ctx);
  return toProfile(updated);
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
