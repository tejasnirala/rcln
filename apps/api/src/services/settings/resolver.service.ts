/**
 * Reading a setting's EFFECTIVE value at a point in the scope hierarchy.
 *
 * `services/organization/setting.service.ts` is the ORGANIZATION-scope EDITOR:
 * it answers "what has this clinic set, and what would clearing it restore".
 * This module is the READER, and it answers a different question — "what value
 * actually applies to this doctor, at this branch, right now" — by walking the
 * whole ladder. The two are deliberately not merged: the editor must not
 * silently fold in a branch value that would overrule the row it is editing,
 * or the settings screen would claim an authority it does not have.
 *
 * RESOLUTION ORDER, most specific wins:
 *
 *     USER -> DOCTOR -> BRANCH -> ORGANIZATION -> PLATFORM -> definition default
 *
 * ⚠️ ⚠️ `setting_values` IS RLS-EXEMPT. THIS IS THE WHOLE RISK OF THIS FILE.
 *   The table is keyed by `(scope_type, scope_id)` and has no `organization_id`
 *   column, so there is nothing for `tenant_isolation` to filter on and it is on
 *   the EXEMPT list in check-rls.ts. NOTHING IN POSTGRES DISTINGUISHES THIS
 *   CLINIC'S `appointment.slot_minutes` FROM ANOTHER'S.
 *
 *   A `where` naming only `settingKey` and `scopeType` returns every clinic's
 *   rows, and picking the first would run one clinic's calendar on another
 *   clinic's cadence — silently, with no error and no failing test.
 *
 *   So: every predicate below pins BOTH halves of the key, and every `scopeId`
 *   comes from `TenantContext` or from a row already read under RLS. A scope id
 *   that arrived in a request body is a cross-tenant read of another clinic's
 *   configuration. `db:rls:check` will never catch a mistake here — it cannot,
 *   there is no policy to be missing — so the explicit pairs ARE the isolation.
 */
import type { Prisma, TxClient } from '@rcln/db';

/** The contract's JSON tree. Matches `SettingItem['value']` in @rcln/contracts. */
export type SettingValue = Prisma.JsonValue;

/**
 * Which scope ids to consider. `organizationId` is required and always comes
 * from `TenantContext`; the rest narrow the answer when they are known.
 */
export interface SettingScopes {
  organizationId: string;
  branchId?: string | undefined;
  doctorProfileId?: string | undefined;
  userId?: string | undefined;
}

/**
 * Most specific first. The resolver returns the value from the earliest entry
 * that has one, so this array IS the precedence rule — there is no second place
 * expressing it.
 *
 * `PATIENT` is a valid scope on `setting_definitions` (notification preferences)
 * but is deliberately absent: nothing resolved through this reader is a patient
 * preference, and including it would mean accepting a patient id from a caller
 * that has no business supplying one.
 */
const PRECEDENCE = ['USER', 'DOCTOR', 'BRANCH', 'ORGANIZATION', 'PLATFORM'] as const;

type ScopeName = (typeof PRECEDENCE)[number];

/**
 * Resolve several settings at once.
 *
 * Batched on purpose: the availability engine needs `appointment.slot_minutes`
 * and `appointment.allow_online_booking` together, and `withTenant` costs a
 * transaction per call. One query, all keys, all scopes.
 */
export async function resolveSettings(
  tx: TxClient,
  keys: string[],
  scopes: SettingScopes
): Promise<Map<string, SettingValue>> {
  const resolved = new Map<string, SettingValue>();
  if (keys.length === 0) return resolved;

  /*
   * The (scopeType, scopeId) pairs this caller is entitled to see, built ONLY
   * from what was passed in. A PLATFORM row is the one case with a null scope
   * id — it is the same row for everybody, which is what makes it safe.
   */
  const pairs: { scopeType: ScopeName; scopeId: string | null }[] = [
    { scopeType: 'ORGANIZATION', scopeId: scopes.organizationId },
    { scopeType: 'PLATFORM', scopeId: null },
  ];
  if (scopes.branchId) pairs.push({ scopeType: 'BRANCH', scopeId: scopes.branchId });
  if (scopes.doctorProfileId) pairs.push({ scopeType: 'DOCTOR', scopeId: scopes.doctorProfileId });
  if (scopes.userId) pairs.push({ scopeType: 'USER', scopeId: scopes.userId });

  const [definitions, values] = await Promise.all([
    tx.settingDefinition.findMany({
      where: { key: { in: keys } },
      select: { key: true, defaultValue: true },
    }),
    tx.settingValue.findMany({
      where: {
        settingKey: { in: keys },
        // Each disjunct pins BOTH halves of the key. See the file header —
        // this is the only tenant isolation this table has.
        OR: pairs.map((p) => ({ scopeType: p.scopeType, scopeId: p.scopeId })),
      },
      select: { settingKey: true, scopeType: true, scopeId: true, value: true },
    }),
  ]);

  /*
   * Defensive second pass. The `OR` above already constrains the result, but a
   * value whose (scopeType, scopeId) is not one we asked for must never win —
   * that is the exact shape of the cross-tenant bug this file is about, and one
   * malformed predicate should not be able to reintroduce it.
   */
  const allowed = new Set(pairs.map((p) => `${p.scopeType}:${p.scopeId ?? ''}`));

  const byKey = new Map<string, Map<ScopeName, SettingValue>>();
  for (const row of values) {
    if (!allowed.has(`${row.scopeType}:${row.scopeId ?? ''}`)) continue;
    let scoped = byKey.get(row.settingKey);
    if (!scoped) {
      scoped = new Map();
      byKey.set(row.settingKey, scoped);
    }
    scoped.set(row.scopeType as ScopeName, row.value);
  }

  const defaults = new Map(definitions.map((d) => [d.key, d.defaultValue]));

  for (const key of keys) {
    const scoped = byKey.get(key);
    const winner = scoped && PRECEDENCE.find((scope) => scoped.has(scope));

    if (winner && scoped) {
      resolved.set(key, scoped.get(winner) as SettingValue);
      continue;
    }

    /*
     * No value at any scope. Fall back to the definition's default — and if the
     * key is not in the catalogue at all, record `null` rather than omitting it,
     * so a caller reading a mistyped key gets an explicit "nothing" instead of a
     * silent `undefined` that reads as "not set yet".
     */
    resolved.set(key, defaults.get(key) ?? null);
  }

  return resolved;
}

/**
 * One setting, coerced to a positive integer.
 *
 * `setting_values.value` is JSONB, so an INT setting can legitimately arrive as
 * a JSON number or — if it was ever written through a path that stringified it —
 * as a string. Both resolve; anything else falls back rather than propagating a
 * `NaN` into slot arithmetic, where it would silently produce an empty calendar.
 */
export function asPositiveInt(value: SettingValue, fallback: number): number {
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

/** One setting, coerced to a boolean. Anything unparseable takes the fallback. */
export function asBoolean(value: SettingValue, fallback: boolean): boolean {
  if (typeof value === 'boolean') return value;
  if (value === 'true') return true;
  if (value === 'false') return false;
  return fallback;
}
