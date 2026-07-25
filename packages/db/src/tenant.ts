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

type TxClient = Omit<
  PrismaClient,
  '$connect' | '$disconnect' | '$on' | '$transaction' | '$extends'
>;

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
