/**
 * Reading a record's history back out.
 *
 * The other half of `audit.service.ts`, which writes it. That file is the only way
 * a row gets in; this is the only way one comes out.
 *
 * WHY THE ROWS ARE SAFE TO RETURN
 *   `audit_logs` is org-scoped and under `tenant_isolation`, so `withTenant`
 *   confines this to the caller's own organization at the database — not by a
 *   `where` clause this file could forget. A caller asking for an entity id
 *   belonging to another clinic gets an empty list, which is also the answer for
 *   an id that never existed: the two are indistinguishable, deliberately, or this
 *   endpoint becomes a way to test whether a given id is real somewhere.
 *
 * WHY NAMES ARE JOINED HERE AND NOT STORED
 *   An audit row holds `actor_user_id` and nothing else about the person.
 *   CONVENTIONS.md forbids re-storing PII on an audit row, and a name copied at
 *   write time is the name as it was at write time — wrong the moment somebody
 *   changes theirs. So the ids are resolved on the way out.
 *
 *   `users` is RLS-exempt, which makes that join the one place this file could
 *   leak. It cannot: the id set is taken from audit rows THIS TENANT can already
 *   see, so the only names resolvable are of people who have acted on this
 *   clinic's records. There is no id in the request that reaches `users`.
 */
import { withTenant, type TenantContext } from '@rcln/db';
import { unsafeDbClient } from '@rcln/db/unsafe';
import type { AuditEntry, AuditFieldChange, AuditHistoryResponse } from '@rcln/contracts';

/** One page. A record with more history than this is a scroll, not a page. */
const DEFAULT_LIMIT = 50;

/**
 * Rebuild the field-by-field diff from the two JSON blobs.
 *
 * `recordAudit` already narrowed these to the keys that moved, so the union of
 * their keys IS the change set. A create has no `before` and a delete no `after`;
 * in both cases the one blob present is the whole story, and the missing side is
 * left absent rather than sent as null — null is a value a field can genuinely
 * hold, and conflating the two would render "was unset" and "did not exist" the
 * same way.
 */
function changesFrom(before: unknown, after: unknown): AuditFieldChange[] {
  const beforeRow = isRecord(before) ? before : {};
  const afterRow = isRecord(after) ? after : {};

  const fields = [...new Set([...Object.keys(beforeRow), ...Object.keys(afterRow)])].sort();

  return fields.map((field) => ({
    field,
    ...(field in beforeRow ? { before: beforeRow[field] } : {}),
    ...(field in afterRow ? { after: afterRow[field] } : {}),
  }));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export interface AuditHistoryInput {
  entityType: string;
  entityId: string;
  limit?: number | undefined;
}

export async function readHistory(
  ctx: TenantContext,
  input: AuditHistoryInput
): Promise<AuditHistoryResponse> {
  const limit = input.limit ?? DEFAULT_LIMIT;

  /*
   * One extra row, to tell "exactly a full page" apart from "there is more". The
   * alternative is a COUNT over the same predicate, which doubles the query for
   * an answer the UI only needs as a boolean.
   */
  const rows = await withTenant(ctx, (tx) =>
    tx.auditLog.findMany({
      where: { entityType: input.entityType, entityId: input.entityId },
      orderBy: { occurredAt: 'desc' },
      take: limit + 1,
      select: {
        id: true,
        action: true,
        occurredAt: true,
        actorUserId: true,
        impersonatedByUserId: true,
        beforeData: true,
        afterData: true,
      },
    })
  );

  const truncated = rows.length > limit;
  const page = truncated ? rows.slice(0, limit) : rows;

  const names = await resolveActorNames(page);

  const entries: AuditEntry[] = page.map((row) => ({
    id: row.id,
    action: row.action,
    occurredAt: row.occurredAt.toISOString(),
    actor: row.actorUserId ? (names.get(row.actorUserId) ?? null) : null,
    /*
     * Only when it differs from the actor. `claimImpersonation` sets both to the
     * admin's own id (ADR-0012 — they act as themselves, not as an employee), so
     * reporting it unconditionally would render "changed by Priya on behalf of
     * Priya" on every row a super admin touched.
     */
    onBehalfOf:
      row.impersonatedByUserId && row.impersonatedByUserId !== row.actorUserId
        ? (names.get(row.impersonatedByUserId) ?? null)
        : null,
    changes: changesFrom(row.beforeData, row.afterData),
  }));

  return {
    entityType: input.entityType,
    entityId: input.entityId,
    entries,
    truncated,
  };
}

/**
 * Ids to names, for the people on this page and nobody else.
 *
 * `unsafeDbClient` because `users` is RLS-exempt — it is identity, and scoping it
 * by organization would be circular in exactly the way `sessions` is. Safe here
 * because the id set comes from rows the tenant could already read: this cannot be
 * asked about an id the caller supplied.
 */
async function resolveActorNames(
  rows: { actorUserId: string | null; impersonatedByUserId: string | null }[]
): Promise<Map<string, { id: string; fullName: string }>> {
  const ids = [
    ...new Set(
      rows.flatMap((row) =>
        [row.actorUserId, row.impersonatedByUserId].filter((id): id is string => id !== null)
      )
    ),
  ];

  if (ids.length === 0) return new Map();

  const users = await unsafeDbClient().user.findMany({
    where: { id: { in: ids } },
    select: { id: true, fullName: true },
  });

  return new Map(users.map((user) => [user.id, user]));
}
