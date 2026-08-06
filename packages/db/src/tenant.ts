import { getDbClient, type PrismaClient } from './client.js';

/**
 * Tenant-scoped Prisma client.
 *
 * THE PROBLEM
 *   RLS policies read `current_setting('app.current_org')`. Postgres session
 *   settings live on the CONNECTION. Prisma pools connections. A connection
 *   still holding org A's setting, handed to a request for org B, leaks patient
 *   data across clinics — silently, with no error.
 *
 * THE FIX
 *   `set_config(key, value, true)` — the `true` makes it TRANSACTION-local, so
 *   it reverts on COMMIT or ROLLBACK. Every tenant-scoped operation therefore
 *   runs inside a transaction that sets the vars first. This is also why
 *   PgBouncer *transaction* pooling mode is safe here.
 *
 * COST
 *   Roughly two extra round-trips per query. Mitigate by grouping related reads
 *   into one `withTenant()` block rather than issuing many separate queries, and
 *   by caching tenant/permission lookups in Redis.
 */

export interface TenantContext {
  organizationId: string;
  /**
   * Branches this request may touch. An org-wide admin gets every branch id;
   * a branch-scoped user gets one. Empty array = no branch access.
   */
  branchIds: string[];
  userId: string;
  /** Set when a platform admin is acting inside a tenant. Audited, never silent. */
  impersonatedByUserId?: string | undefined;
}

const SET_TENANT_SQL = `
  SELECT set_config('app.current_org',    $1, true),
         set_config('app.branch_scope',   $2, true),
         set_config('app.current_user',   $3, true),
         set_config('app.impersonator',   $4, true)
`;

function encodeBranchScope(branchIds: string[]): string {
  // Postgres array literal: {uuid,uuid}. Empty -> {} which matches no rows.
  return `{${branchIds.join(',')}}`;
}

/**
 * The client handed to a `withTenant` callback.
 *
 * Exported so a helper can accept the transaction rather than opening its own —
 * an audit row that can commit independently of the mutation it describes is
 * worse than no audit row.
 */
export type TxClient = Omit<
  PrismaClient,
  '$connect' | '$disconnect' | '$on' | '$transaction' | '$extends'
>;

/**
 * Run a unit of work identified as a USER but scoped to no organization.
 *
 * THE PROBLEM IT SOLVES
 *   "Which organizations do I belong to?" is inherently cross-tenant — it is
 *   the question whose answer tells you what tenants exist for you. But
 *   `memberships` is org-scoped and RLS-enforced, so reading it with no context
 *   fails closed and returns nothing, and reading it inside withTenant requires
 *   already knowing the organization.
 *
 * HOW THIS IS SAFE
 *   It sets ONLY `app.current_user`, leaving `app.current_org` unset. The
 *   matching policy on memberships is
 *       USING (user_id = app_current_user() AND app_current_org() IS NULL)
 *   so it grants exactly one thing: your own membership rows, and only in a
 *   transaction that has claimed no tenant. It cannot widen a normal request,
 *   because a normal request always has app.current_org set, which switches
 *   this policy off entirely.
 *
 *   It is emphatically NOT a way to read tenant data without a tenant. Every
 *   other org-scoped table still sees a NULL app.current_org and returns
 *   nothing.
 */
export async function withUserIdentity<T>(
  userId: string,
  fn: (tx: TxClient) => Promise<T>
): Promise<T> {
  const prisma = getDbClient();

  return prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`SELECT set_config('app.current_user', $1, true)`, userId);
    return fn(tx as TxClient);
  });
}

/**
 * Run a unit of work that may read ONE payment intent, by an id it already has.
 *
 * THE PROBLEM IT SOLVES
 *   A payment provider POSTs a webhook to a public endpoint. There is no host to
 *   resolve a tenant from, no session, and no user — and `payment_intents` is
 *   RLS-enforced, so a read with no context returns nothing. Which organization
 *   the webhook concerns is written on the intent row we cannot read. That is
 *   the same circularity `withUserIdentity` solves for memberships.
 *
 * HOW THIS IS SAFE
 *   It sets ONLY `app.payment_reference`, leaving `app.current_org` unset. The
 *   matching policy is
 *       USING (app_current_org() IS NULL AND id = app_payment_reference())
 *   so it grants exactly one row: the one whose uuid you already named, and only
 *   in a transaction that has claimed no tenant. It cannot enumerate — there is
 *   no predicate that matches more than a single primary key — and it cannot
 *   widen an ordinary request, because a normal request always has
 *   app.current_org set, which switches the policy off entirely.
 *
 *   It is SELECT-only at the database. Nothing is writable through it.
 *
 * ⚠️ CALL IT ONLY WITH A REFERENCE FROM A VERIFIED WEBHOOK.
 *   The uuid is the capability. It is random, it is known only to us and to the
 *   provider, and the route that supplies it has already checked the signature
 *   over the exact bytes. Passing a reference straight from an unauthenticated
 *   request body would turn this into an oracle for "does this id exist".
 */
export async function withPaymentReference<T>(
  reference: string,
  fn: (tx: TxClient) => Promise<T>
): Promise<T> {
  const prisma = getDbClient();

  return prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`SELECT set_config('app.payment_reference', $1, true)`, reference);
    return fn(tx as TxClient);
  });
}

/**
 * Apply the tenant session variables to a transaction already in flight.
 *
 * `withTenant` is the right tool whenever the tenant is known before the work
 * starts, which is almost always. The exception is organization registration:
 * the tenant does not exist yet, and the rows that create it span both
 * RLS-exempt tables (organizations, users) and RLS-enforced ones (branches,
 * memberships, membership_roles, subscriptions). That transaction has to insert
 * the organization first and only then adopt it — which is this function.
 *
 * It is exported so there is exactly one copy of the SQL. Do NOT reach for it
 * to avoid `withTenant`; the eslint rule will not stop you, and neither will
 * the type system.
 */
export async function setTenantContext(
  tx: Pick<TxClient, '$executeRawUnsafe'>,
  ctx: TenantContext
): Promise<void> {
  await tx.$executeRawUnsafe(
    SET_TENANT_SQL,
    ctx.organizationId,
    encodeBranchScope(ctx.branchIds),
    ctx.userId,
    ctx.impersonatedByUserId ?? ''
  );
}

/**
 * Run a unit of work with tenant session variables applied.
 *
 * Prefer ONE call wrapping several queries over several calls with one query
 * each — the session-variable round-trip is paid per transaction, not per query.
 *
 * @example
 * const data = await withTenant(ctx, async (tx) => {
 *   const branches = await tx.branch.findMany();
 *   const staff    = await tx.membership.count();
 *   return { branches, staff };
 * });
 */
export async function withTenant<T>(
  ctx: TenantContext,
  fn: (tx: TxClient) => Promise<T>
): Promise<T> {
  const prisma = getDbClient();

  return prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(
      SET_TENANT_SQL,
      ctx.organizationId,
      encodeBranchScope(ctx.branchIds),
      ctx.userId,
      ctx.impersonatedByUserId ?? ''
    );
    return fn(tx as TxClient);
  });
}

/**
 * Client extension form: every operation is transparently wrapped.
 *
 * Convenient for repositories that were written against a plain client, but it
 * pays the transaction cost per query. `withTenant()` is the better default;
 * reach for this only when you cannot restructure the call site.
 */
export function forTenant(ctx: TenantContext): ReturnType<PrismaClient['$extends']> {
  const prisma = getDbClient();

  return prisma.$extends({
    name: 'rls-tenant-scope',
    query: {
      $allModels: {
        async $allOperations({ args, query }) {
          return prisma.$transaction(async (tx) => {
            await tx.$executeRawUnsafe(
              SET_TENANT_SQL,
              ctx.organizationId,
              encodeBranchScope(ctx.branchIds),
              ctx.userId,
              ctx.impersonatedByUserId ?? ''
            );
            return query(args);
          });
        },
      },
    },
  });
}

export type TenantClient = ReturnType<typeof forTenant>;
