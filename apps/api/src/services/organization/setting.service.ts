/**
 * Settings: the twelve knobs a clinic can turn without a migration.
 *
 * `setting_definitions` is the catalogue — key, data type, default, which scopes
 * may carry a value. Adding a setting is an INSERT there. `setting_values` holds
 * the answers, one row per (key, scope, scope id), and resolution runs
 * USER -> BRANCH -> ORGANIZATION -> PLATFORM -> the definition's default, most
 * specific wins.
 *
 * This file is the ORGANIZATION scope only. It reads the platform row and the
 * definition default so it can say what a clinic would fall back to, and it
 * never reads or writes a branch's or a user's row: those are more specific and
 * would still overrule this one, so folding them in would make the screen claim
 * an authority it does not have.
 *
 * ⚠️ `setting_values` IS RLS-EXEMPT
 *   It is keyed by `(scope_type, scope_id)` rather than `organization_id`, so
 *   there is no column for `tenant_isolation` to filter on and the table is on
 *   the EXEMPT list. Nothing in Postgres distinguishes this clinic's
 *   `appointment.slot_minutes` from another's. Every statement below therefore
 *   pins BOTH halves of the key — `scopeType: 'ORGANIZATION'` AND
 *   `scopeId: ctx.organizationId` — and the scope id never comes from the
 *   request. A `where` that names only the key would return, and update, some
 *   other clinic's row.
 *
 * ⚠️ NO `upsert` HERE, EVER
 *   The unique is `(setting_key, scope_type, scope_id) NULLS NOT DISTINCT`, and
 *   Prisma refuses to build a `where` for a compound unique with a nullable
 *   component — `scope_id` is null on every PLATFORM row. `findFirst` then
 *   `create`/`update`, exactly as `prisma/seed.ts` does. Uniqueness is still the
 *   index's job. See PITFALLS.
 */
import { Prisma, withTenant, type TenantContext } from '@rcln/db';
import type { SettingChoice, SettingItem } from '@rcln/contracts';
import { NotFoundError, ValidationError } from '../../utils/errors.js';
import { recordAudit } from '../audit/audit.service.js';

/** Request metadata carried onto the audit row. Same shape as the branch service. */
export interface SettingActionOptions {
  ipAddress?: string | undefined;
  userAgent?: string | undefined;
}

type DataType = SettingItem['dataType'];

/**
 * The contract's JSON tree, which is the one that leaves this file.
 *
 * Prisma's `JsonValue` describes the same set of values but with optional
 * object properties, so the two are not mutually assignable even though every
 * value of one is a value of the other. Converting at the two boundaries keeps
 * the cast in one named place rather than sprinkled through the reads.
 */
type Json = SettingItem['value'];

function asJson(value: Prisma.JsonValue): Json {
  return value as Json;
}

/**
 * A JSON null is not a SQL NULL, and Prisma makes you say which.
 *
 * A bare `null` in a `data` clause means "set the column to NULL" — impossible
 * here, since `setting_values.value` is NOT NULL, so it is a runtime error
 * rather than a type error. `Prisma.JsonNull` is the JSON literal, which is a
 * legitimate value for a JSON-typed setting.
 */
function toWritable(value: Json): Prisma.InputJsonValue | typeof Prisma.JsonNull {
  return value === null ? Prisma.JsonNull : (value as Prisma.InputJsonValue);
}

/**
 * `allowed_scopes` is JSONB holding an array of scope names.
 *
 * Prisma types it as `JsonValue`, which is honest — the column can hold
 * anything. A definition row with a malformed value reads as "allows nothing",
 * which makes the setting appear locked rather than silently editable at a scope
 * the platform never sanctioned.
 */
function allowedScopes(value: Prisma.JsonValue): string[] {
  return Array.isArray(value) ? value.filter((s): s is string => typeof s === 'string') : [];
}

/**
 * Does this value fit the type the definition declares?
 *
 * The check has to live here rather than in the contract: the expected shape
 * comes from a row, not from a type. INT and DECIMAL are both JSON numbers to
 * Zod — the difference is whether a fraction is meaningful, and a slot length of
 * 12.5 minutes is a mistake worth naming.
 */
function fits(dataType: DataType, value: unknown): boolean {
  switch (dataType) {
    case 'STRING':
      return typeof value === 'string';
    case 'INT':
      return typeof value === 'number' && Number.isSafeInteger(value);
    case 'DECIMAL':
      return typeof value === 'number' && Number.isFinite(value);
    case 'BOOL':
      return typeof value === 'boolean';
    case 'JSON':
      // Anything JSON can express. The definition asked for a document.
      return true;
  }
}

const EXPECTED: Record<DataType, string> = {
  STRING: 'text',
  INT: 'a whole number',
  DECIMAL: 'a number',
  BOOL: 'true or false',
  JSON: 'a JSON value',
};

/**
 * `allowed_values` is JSONB holding `[{ value, label }]`, or NULL for an open
 * setting.
 *
 * Same reasoning as `allowedScopes`: the column can hold anything, so a
 * malformed row degrades to "no closed set" rather than throwing on read. That
 * direction is deliberate — the alternative is a settings screen that 500s
 * because someone hand-edited a catalogue row.
 */
function choicesOf(value: Prisma.JsonValue): SettingChoice[] | null {
  if (!Array.isArray(value)) return null;

  const parsed = value.flatMap((entry) => {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) return [];
    const { value: choice, label } = entry as { value?: unknown; label?: unknown };
    if (choice === undefined || typeof label !== 'string') return [];
    return [{ value: asJson(choice as Prisma.JsonValue), label }];
  });

  // An array that parsed to nothing is a broken row, not a setting with no
  // choices — reporting it as open is the safe direction, and the type check
  // below still applies.
  return parsed.length > 0 ? parsed : null;
}

const DEFINITION_SELECT = {
  key: true,
  module: true,
  dataType: true,
  defaultValue: true,
  allowedScopes: true,
  allowedValues: true,
  isTenantEditable: true,
  description: true,
  helpText: true,
} as const;

interface DefinitionRow {
  key: string;
  module: string;
  dataType: DataType;
  defaultValue: Prisma.JsonValue;
  allowedScopes: Prisma.JsonValue;
  allowedValues: Prisma.JsonValue;
  isTenantEditable: boolean;
  description: string | null;
  helpText: string | null;
}

interface ValueRow {
  settingKey: string;
  value: Prisma.JsonValue;
  updatedAt: Date;
}

/** True when the setting may carry an organization-level value at all. */
function isEditable(definition: DefinitionRow): boolean {
  return (
    definition.isTenantEditable && allowedScopes(definition.allowedScopes).includes('ORGANIZATION')
  );
}

function toItem(
  definition: DefinitionRow,
  platform: ValueRow | undefined,
  organization: ValueRow | undefined
): SettingItem {
  // What applies if the clinic's own value goes away. The platform row is the
  // next step down the chain; the definition default is the floor.
  const inheritedValue = asJson(platform ? platform.value : definition.defaultValue);
  const inheritedFrom = platform ? 'PLATFORM' : 'DEFAULT';

  return {
    key: definition.key,
    module: definition.module,
    dataType: definition.dataType,
    description: definition.description,
    helpText: definition.helpText,
    choices: choicesOf(definition.allowedValues),
    allowedScopes: allowedScopes(definition.allowedScopes),
    editable: isEditable(definition),
    value: organization ? asJson(organization.value) : inheritedValue,
    isOverridden: organization !== undefined,
    inheritedValue,
    inheritedFrom,
    updatedAt: organization?.updatedAt.toISOString() ?? null,
  };
}

/**
 * Every setting, as it resolves for this clinic.
 *
 * Three reads rather than a join: the definitions are a static catalogue, the
 * platform rows are shared, and the organization rows are the only tenant data
 * involved. Twelve definitions is not a pagination problem.
 */
export async function listSettings(ctx: TenantContext): Promise<SettingItem[]> {
  return withTenant(ctx, async (tx) => {
    const [definitions, platformValues, organizationValues] = await Promise.all([
      tx.settingDefinition.findMany({
        select: DEFINITION_SELECT,
        orderBy: [{ module: 'asc' }, { key: 'asc' }],
      }),
      tx.settingValue.findMany({
        // scopeId is null on a platform row — the reason upsert is unusable here.
        where: { scopeType: 'PLATFORM', scopeId: null },
        select: { settingKey: true, value: true, updatedAt: true },
      }),
      tx.settingValue.findMany({
        // Both halves of the key. See the header: nothing else scopes this table.
        where: { scopeType: 'ORGANIZATION', scopeId: ctx.organizationId },
        select: { settingKey: true, value: true, updatedAt: true },
      }),
    ]);

    const platform = new Map(platformValues.map((v) => [v.settingKey, v]));
    const organization = new Map(organizationValues.map((v) => [v.settingKey, v]));

    return definitions.map((definition) =>
      toItem(definition, platform.get(definition.key), organization.get(definition.key))
    );
  });
}

/**
 * Set this clinic's value for one setting.
 *
 * Refuses a key the catalogue does not carry (404), a setting the platform holds
 * for itself or does not allow at this scope (400), and a value of the wrong
 * shape (400). The last of those is why the contract accepts a bare JSON value:
 * the type it must be is a row.
 */
export async function setSetting(
  ctx: TenantContext,
  key: string,
  value: Json,
  options: SettingActionOptions = {}
): Promise<SettingItem> {
  return withTenant(ctx, async (tx) => {
    const definition = await tx.settingDefinition.findUnique({
      where: { key },
      select: DEFINITION_SELECT,
    });
    if (!definition) throw new NotFoundError('Setting');

    if (!isEditable(definition)) {
      throw new ValidationError(
        definition.isTenantEditable
          ? 'This setting cannot be set for the whole clinic.'
          : 'This setting is managed by rcln and cannot be changed here.'
      );
    }

    if (!fits(definition.dataType, value)) {
      throw new ValidationError(`${key} expects ${EXPECTED[definition.dataType]}.`);
    }

    /*
     * A closed set is closed here, not only in the select.
     *
     * The screen renders its options from this same column, so the two cannot
     * drift — but the screen is not the only caller. Without this check a
     * delivery channel could be set to anything a curl can spell, and the
     * failure would surface much later as a notification nothing can send.
     *
     * Compared by JSON: the values are numbers as often as strings (month 4,
     * not "4"), and `===` would reject a matching array or object outright.
     */
    const choices = choicesOf(definition.allowedValues);
    if (
      choices &&
      !choices.some((choice) => JSON.stringify(choice.value) === JSON.stringify(value))
    ) {
      throw new ValidationError(
        `${key} must be one of: ${choices.map((choice) => choice.label).join(', ')}.`
      );
    }

    const existing = await tx.settingValue.findFirst({
      where: { settingKey: key, scopeType: 'ORGANIZATION', scopeId: ctx.organizationId },
      select: { id: true, value: true },
    });

    const saved = existing
      ? await tx.settingValue.update({
          where: { id: existing.id },
          data: { value: toWritable(value), updatedBy: ctx.userId },
          select: { id: true, settingKey: true, value: true, updatedAt: true },
        })
      : await tx.settingValue.create({
          data: {
            settingKey: key,
            scopeType: 'ORGANIZATION',
            scopeId: ctx.organizationId,
            value: toWritable(value),
            updatedBy: ctx.userId,
          },
          select: { id: true, settingKey: true, value: true, updatedAt: true },
        });

    await recordAudit(tx, ctx, {
      action: existing ? 'UPDATE' : 'CREATE',
      entityType: 'setting_value',
      // The ROW's id, not the setting key. `audit_logs.entity_id` is a uuid
      // column, and a key like `patient.uhid_prefix` fails the cast at the
      // database — a 500 that typechecks cleanly, which is how this was found.
      // The key travels in the snapshot instead, where it is also more use.
      entityId: saved.id,
      // The setting key is the FIELD NAME, not a field. recordAudit stores only
      // the keys whose value moved, so a `{ key, value }` pair loses the key on
      // every update — leaving a row that says "20 became 30" about nothing in
      // particular. Naming the field after the setting keeps the subject on the
      // row while the diff still does its job.
      //
      // A configuration value is exactly what an audit trail is for, and none of
      // the twelve settings carries anything personal.
      ...(existing ? { before: { [key]: existing.value } } : {}),
      after: { [key]: saved.value },
      ...options,
    });

    const platform = await tx.settingValue.findFirst({
      where: { settingKey: key, scopeType: 'PLATFORM', scopeId: null },
      select: { settingKey: true, value: true, updatedAt: true },
    });

    return toItem(definition, platform ?? undefined, saved);
  });
}

/**
 * Drop this clinic's value and fall back to whatever it was overruling.
 *
 * A separate verb rather than `{ value: null }`, because null is a value a JSON
 * setting may legitimately hold. Clearing something that was never set is a
 * success — the caller asked for a state that already holds.
 */
export async function clearSetting(
  ctx: TenantContext,
  key: string,
  options: SettingActionOptions = {}
): Promise<SettingItem> {
  return withTenant(ctx, async (tx) => {
    const definition = await tx.settingDefinition.findUnique({
      where: { key },
      select: DEFINITION_SELECT,
    });
    if (!definition) throw new NotFoundError('Setting');

    const existing = await tx.settingValue.findFirst({
      where: { settingKey: key, scopeType: 'ORGANIZATION', scopeId: ctx.organizationId },
      select: { id: true, value: true },
    });

    if (existing) {
      // By primary key, and only after a read that pinned the scope. `deleteMany`
      // on the key alone would take out every clinic's row.
      await tx.settingValue.delete({ where: { id: existing.id } });

      await recordAudit(tx, ctx, {
        action: 'DELETE',
        entityType: 'setting_value',
        // The row id, not the key — see setSetting.
        entityId: existing.id,
        before: { [key]: existing.value },
        ...options,
      });
    }

    const platform = await tx.settingValue.findFirst({
      where: { settingKey: key, scopeType: 'PLATFORM', scopeId: null },
      select: { settingKey: true, value: true, updatedAt: true },
    });

    return toItem(definition, platform ?? undefined, undefined);
  });
}
