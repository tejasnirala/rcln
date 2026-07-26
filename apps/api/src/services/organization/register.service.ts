import { randomUUID } from 'node:crypto';
import { setTenantContext } from '@rcln/db';
import { unsafeDbClient } from '@rcln/db/unsafe';
import { SYSTEM_ROLES } from '@rcln/permissions';
import type { RegisterOrganizationRequest } from '@rcln/contracts';
import { config } from '../../config/index.js';
import { logger } from '../../utils/logger.js';
import { AppError, ConflictError } from '../../utils/errors.js';
import { invalidateTenantCache } from '../../middleware/tenant.middleware.js';
import { hashPassword } from '../auth/password.service.js';
import { recordAudit } from '../audit/audit.service.js';

/**
 * Clinic registration: the one transaction that turns a form into a tenant.
 *
 * WHY THIS USES @rcln/db/unsafe
 *   The same reason public.routes.ts does, and it is worth stating plainly:
 *   there is no tenant yet. `withTenant()` needs an organization id to scope to,
 *   and creating that organization is the entire point of this function. This is
 *   the pre-tenant category the escape hatch exists for.
 *
 * WHY IT IS NOT THAT SIMPLE
 *   `unsafeDbClient()` is NOT a privileged client. It returns the same rcln_app
 *   connection as everything else — it only skips setting the session variables.
 *   rcln_app has NOBYPASSRLS, so policies still apply to it.
 *
 *   The seven rows split across that line:
 *     RLS-exempt   organizations, organization_domains, users
 *     RLS-enforced branches, memberships, membership_roles, subscriptions
 *                  (WITH CHECK organization_id = app_current_org())
 *
 *   So a plain unscoped insert of the second group FAILS CLOSED — and it fails
 *   as "0 rows" or a policy violation, not as anything that reads like a bug.
 *
 * THE RESOLUTION
 *   Generate the organization and branch ids in application code, insert the
 *   exempt rows, then call setTenantContext() to adopt the organization we just
 *   created for the remainder of THIS transaction. The session variables are
 *   transaction-local (`set_config(..., true)`), so they revert on COMMIT or
 *   ROLLBACK exactly as they do inside withTenant. Nothing leaks to the next
 *   request that borrows this pooled connection.
 *
 *   membership_roles additionally carries the RESTRICTIVE branch_isolation
 *   policy, so app.branch_scope must contain the new branch as well — even
 *   though the ORG_OWNER row we write has branch_id NULL, which is the org-wide
 *   case that policy already permits.
 */

export interface RegisterOptions {
  /** Set when a platform admin provisions on a clinic's behalf. Audited. */
  actorUserId?: string | undefined;
  ipAddress?: string | undefined;
  userAgent?: string | undefined;
}

export interface RegisterResult {
  organizationId: string;
  slug: string;
  ownerUserId: string;
  branchId: string;
  loginUrl: string;
}

/** `alpha` -> `alpha.lvh.me`. The row resolveTenant looks the Host header up in. */
export function tenantHost(slug: string): string {
  return `${slug}.${config.rootDomain}`;
}

function loginUrl(slug: string): string {
  const scheme = config.isProduction ? 'https' : 'http';
  const port = config.isProduction ? '' : new URL(config.webUrl).port;
  const suffix = port ? `:${port}` : '';
  return `${scheme}://${tenantHost(slug)}${suffix}/login`;
}

/**
 * Is this subdomain free?
 *
 * Answers a question about who our customers are, so the route that exposes it
 * is rate-limited and returns a bare boolean. Reserved slugs are already
 * rejected by `availableSlug` in the contract.
 */
export async function isSlugAvailable(slug: string): Promise<boolean> {
  const db = unsafeDbClient();

  const [organization, domain] = await Promise.all([
    db.organization.findUnique({ where: { slug }, select: { id: true } }),
    db.organizationDomain.findUnique({ where: { domain: tenantHost(slug) }, select: { id: true } }),
  ]);

  return !organization && !domain;
}

export async function registerOrganization(
  input: RegisterOrganizationRequest,
  options: RegisterOptions = {}
): Promise<RegisterResult> {
  const db = unsafeDbClient();
  const { organization: org, branch, owner } = input;

  // ---------------------------------------------------------------------
  // Pre-flight. The database constraints are the real guarantee — these
  // checks only exist so the caller gets a message naming the field instead
  // of a generic 409 from a unique-violation.
  // ---------------------------------------------------------------------
  if (!(await isSlugAvailable(org.slug))) {
    throw new ConflictError('That subdomain is already taken. Try another.');
  }

  const existingUser = await db.user.findFirst({
    where: { OR: [{ email: owner.email }, { phone: owner.phone }] },
    select: { id: true, email: true },
  });

  if (existingUser) {
    /**
     * `users.email` and `users.phone` are globally unique — one login spans
     * every organization. So this is a real case, not an edge one.
     *
     * We refuse rather than attaching the new organization to that account.
     * Anyone who knows a doctor's email could otherwise create an organization
     * bound to their identity, and the doctor would find a clinic they never
     * registered sitting in their account switcher. Adding a second
     * organization is a thing you do while signed in, not while signing up.
     */
    throw new ConflictError(
      'An account with that email or phone already exists. Sign in to add another organization.'
    );
  }

  const plan = await db.plan.findUnique({
    where: { code: input.planCode },
    select: {
      id: true,
      trialDays: true,
      prices: {
        where: { currency: org.currency, billingInterval: 'MONTH', isActive: true },
        select: { id: true },
        take: 1,
      },
    },
  });

  const planPrice = plan?.prices[0];
  if (!plan || !planPrice) {
    // Not a 400. The caller sent a plan code from our own pricing page; if it
    // does not resolve, the seed did not run or the plan was withdrawn. That is
    // our fault, and it should page us rather than blame the clinic.
    logger.error(
      { planCode: input.planCode, currency: org.currency },
      'registration failed: plan or monthly price missing'
    );
    throw new AppError('Registration is temporarily unavailable.', 503, 'PLAN_UNAVAILABLE');
  }

  // Ids up front: the session variables must name the organization before the
  // RLS-enforced inserts run, and branch_scope must name the branch.
  const organizationId = randomUUID();
  const branchId = randomUUID();
  const ownerUserId = randomUUID();

  const passwordHash = await hashPassword(owner.password);

  const now = new Date();
  const trialEndsAt = new Date(now.getTime() + plan.trialDays * 24 * 60 * 60 * 1000);

  const result = await db.$transaction(async (tx) => {
    // -- RLS-exempt tables. No tenant context exists yet. ------------------
    await tx.organization.create({
      data: {
        id: organizationId,
        slug: org.slug,
        legalName: org.legalName,
        displayName: org.displayName,
        orgType: org.orgType,
        // The default is PENDING, which nothing currently activates —
        // requireTenant only rejects SUSPENDED, so a PENDING org would be
        // reachable but in a state no code understands. Self-serve signup is
        // complete at this point, so say so.
        status: 'ACTIVE',
        currency: org.currency,
        timezone: org.timezone,
        ownerUserId: null, // set below; the user row does not exist yet
        onboardedAt: now,
        ...(org.gstNumber !== undefined ? { gstNumber: org.gstNumber } : {}),
      },
    });

    await tx.organizationDomain.create({
      data: {
        organizationId,
        domain: tenantHost(org.slug),
        isPrimary: true,
        isPlatformSub: true,
        // A platform subdomain needs no DNS proof — we own the parent zone.
        // Custom domains are the ones that will have to earn verifiedAt.
        verifiedAt: now,
      },
    });

    await tx.user.create({
      data: {
        id: ownerUserId,
        email: owner.email,
        phone: owner.phone,
        passwordHash,
        fullName: owner.fullName,
        // Default is INVITED, which is the flow where someone else creates the
        // account. This person just chose their own password.
        status: 'ACTIVE',
        // emailVerifiedAt / phoneVerifiedAt stay null on purpose: no provider is
        // wired yet (TRAI DLT is blocked), so claiming verification would be a lie.
      },
    });

    await tx.organization.update({
      where: { id: organizationId },
      data: { ownerUserId },
    });

    // -- Adopt the tenant for the rest of this transaction. ----------------
    await setTenantContext(tx, {
      organizationId,
      branchIds: [branchId],
      userId: ownerUserId,
    });

    // -- RLS-enforced tables. These now satisfy WITH CHECK. -----------------
    await tx.branch.create({
      data: {
        id: branchId,
        organizationId,
        code: branch.code,
        name: branch.name,
        branchType: org.orgType === 'LAB' ? 'LAB' : 'CLINIC',
        timezone: org.timezone,
        isPrimary: true,
        status: 'ACTIVE',
        ...(branch.phone !== undefined ? { phone: branch.phone } : {}),
        ...(branch.addressLine1 !== undefined ? { addressLine1: branch.addressLine1 } : {}),
        ...(branch.city !== undefined ? { city: branch.city } : {}),
        ...(branch.state !== undefined ? { state: branch.state } : {}),
        ...(branch.pincode !== undefined ? { pincode: branch.pincode } : {}),
      },
    });

    const membership = await tx.membership.create({
      data: {
        userId: ownerUserId,
        organizationId,
        status: 'ACTIVE',
        joinedAt: now,
      },
      select: { id: true },
    });

    // The system ORG_OWNER role: organizationId null marks it system-owned, and
    // a trigger stops a tenant from shadowing the code with its own row.
    const ownerRole = await tx.role.findFirst({
      where: { code: SYSTEM_ROLES.ORG_OWNER, organizationId: null, isSystem: true },
      select: { id: true },
    });

    if (!ownerRole) {
      // Same category as a missing plan: the seed did not run.
      throw new AppError('Registration is temporarily unavailable.', 503, 'ROLE_UNAVAILABLE');
    }

    await tx.membershipRole.create({
      data: {
        membershipId: membership.id,
        organizationId,
        roleId: ownerRole.id,
        // NULL = every branch in the organization, now and in future. The owner
        // of a clinic that opens a second location should not need a new grant.
        branchId: null,
      },
    });

    await tx.subscription.create({
      data: {
        organizationId,
        planId: plan.id,
        planPriceId: planPrice.id,
        status: 'TRIALING',
        trialEndsAt,
        // Both are NOT NULL in the schema, so a trial still needs a period.
        // It is the trial window; the first paid period replaces it at checkout.
        currentPeriodStart: now,
        currentPeriodEnd: trialEndsAt,
        seatQuantity: 1,
      },
    });

    await recordAudit(
      tx,
      // Not the context handed to setTenantContext above: when a platform admin
      // provisions a clinic, the actor is the admin, not the owner whose account
      // is being created.
      { organizationId, branchIds: [branchId], userId: options.actorUserId ?? ownerUserId },
      {
        action: 'CREATE',
        entityType: 'organization',
        entityId: organizationId,
        // Ids and the slug only. The owner's name, email and phone are not
        // written here — an audit row is not a place to re-store PII.
        after: { slug: org.slug, planCode: input.planCode, branchId },
        ...(options.ipAddress !== undefined ? { ipAddress: options.ipAddress } : {}),
        ...(options.userAgent !== undefined ? { userAgent: options.userAgent } : {}),
      }
    );

    return { membershipId: membership.id };
  });

  /**
   * Drop the negative cache entry for the new host.
   *
   * resolveTenant caches misses for 300 seconds as the literal string 'MISS'.
   * The signup form's slug-availability check does not touch that cache, but
   * anything that hit the subdomain beforehand does — and without this, a clinic
   * that just registered watches its own subdomain 404 for five minutes with no
   * error anywhere to explain it.
   */
  await invalidateTenantCache(tenantHost(org.slug));

  logger.info(
    {
      organizationId,
      slug: org.slug,
      branchId,
      membershipId: result.membershipId,
      planCode: input.planCode,
    },
    'organization registered'
  );

  return {
    organizationId,
    slug: org.slug,
    ownerUserId,
    branchId,
    loginUrl: loginUrl(org.slug),
  };
}
