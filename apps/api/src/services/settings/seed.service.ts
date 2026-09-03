/**
 * Writing a setting's value ONCE, where the clinic has not already answered.
 *
 * This is the mechanism ADR-0018 rests on. The onboarding wizard captures a
 * handful of facts about a clinic — who it treats, when it opens, how it bills —
 * and turns each of them into a CONCRETE `setting_values` row that the clinic
 * then owns. It does not keep the profile as a shadow source that settings are
 * derived from at read time, because two answers to one question is how a
 * settings screen starts lying.
 *
 * ⚠️ IT NEVER UPDATES. THAT IS THE WHOLE FUNCTION.
 *   "Seed" means write only where no explicit value exists at this exact scope.
 *   It is what makes re-entering a step in year two safe: the clinic that adds a
 *   pharmacy re-runs the modules step, and the `inventory.batch_selection_strategy`
 *   they tuned six months ago is left alone. A seeder that upserted would make
 *   the wizard destructive, and destructive in the way nobody notices until a
 *   dispensing queue starts offering the wrong batch.
 *
 *   The corollary: a clinic that wants to CHANGE one of these goes to the
 *   settings screen, which is `setting.service.ts` and audits it as an edit.
 *
 * ⚠️ ⚠️ `setting_values` IS RLS-EXEMPT, AND THIS FILE WRITES TO IT.
 *   The table is keyed by `(scope_type, scope_id)` and carries no
 *   `organization_id`, so there is no column for `tenant_isolation` to filter on
 *   and it is on the EXEMPT list in `check-rls.ts`. NOTHING IN POSTGRES
 *   DISTINGUISHES THIS CLINIC'S ROW FROM ANOTHER'S, and `db:rls:check` will
 *   never catch a mistake here because there is no policy to be missing.
 *
 *   So, exactly as `resolver.service.ts` and `setting.service.ts` require:
 *     — every predicate pins BOTH halves of the key, `settingKey` AND
 *       (`scopeType`, `scopeId`);
 *     — every `scopeId` comes from `TenantContext` or from a row already read
 *       under RLS, and NEVER from a request body.
 *   A branch id that arrived from a caller unchecked is a write into another
 *   clinic's configuration, silently, with no error and no failing test.
 *
 * ⚠️ NO `upsert`, EVER.
 *   The unique is `(setting_key, scope_type, scope_id) NULLS NOT DISTINCT` and
 *   Prisma refuses to build a `where` for a compound unique with a nullable
 *   component. `findFirst` then `create`, as everywhere else that touches this
 *   table. Uniqueness remains the index's job.
 */
import type { Prisma, TxClient } from '@rcln/db';

/** What a setting row may hold. Matches `SettingItem['value']` in @rcln/contracts. */
export type SeedableValue = Prisma.InputJsonValue;

/**
 * The scopes the wizard may seed at.
 *
 * ⚠️ DELIBERATELY NOT `SettingScopeType`, WHICH ALSO HAS PLATFORM, USER, DOCTOR
 *   AND PATIENT. A PLATFORM row is every clinic's fallback and must never be
 *   written by a tenant; the other three are more specific than anything the
 *   wizard knows about. Narrowing the type here is what stops a later caller
 *   passing `'PLATFORM'` and a `scopeId` of null, which would typecheck and
 *   would reconfigure the platform.
 */
export type SeedScope = 'ORGANIZATION' | 'BRANCH';

export interface SeedSettingInput {
  key: string;
  scopeType: SeedScope;
  /**
   * ⚠️ FROM `TenantContext`, OR FROM A BRANCH ROW ALREADY READ UNDER RLS.
   *   See the file header — this is the isolation, and there is no second layer
   *   behind it.
   */
  scopeId: string;
  value: SeedableValue;
  /** Recorded as `updated_by`, so the settings screen can say who set it. */
  userId: string;
}

/**
 * Write the value if — and only if — this scope has no explicit answer yet.
 *
 * Returns true when a row was written, false when one already existed and was
 * left untouched. Callers use the flag for the audit snapshot: a step that
 * seeded nothing should not claim in the audit trail that it configured
 * something.
 */
export async function seedSettingIfUnset(tx: TxClient, input: SeedSettingInput): Promise<boolean> {
  const existing = await tx.settingValue.findFirst({
    // Both halves of the key. See the header; this line is the isolation.
    where: { settingKey: input.key, scopeType: input.scopeType, scopeId: input.scopeId },
    select: { id: true },
  });

  if (existing) return false;

  /*
   * ⚠️ THE DEFINITION MUST EXIST, AND A MISSING ONE IS SILENCE RATHER THAN A
   *   THROW. `setting_values.setting_key` is a foreign key into
   *   `setting_definitions`, so seeding a key nobody seeded a definition for
   *   raises a constraint violation mid-transaction and rolls back the whole
   *   step — losing the clinic's care contexts because a setting they never
   *   asked about is missing. A key absent from the catalogue means the seed
   *   file and this list disagree, which is a deployment problem, not the
   *   clinic's; skipping leaves the wizard finishable and the setting at its
   *   coded default.
   */
  const definition = await tx.settingDefinition.findUnique({
    where: { key: input.key },
    select: { key: true },
  });
  if (!definition) return false;

  await tx.settingValue.create({
    data: {
      settingKey: input.key,
      scopeType: input.scopeType,
      scopeId: input.scopeId,
      value: input.value,
      updatedBy: input.userId,
    },
    select: { id: true },
  });

  return true;
}

/**
 * Seed several at once, reporting which ones actually took.
 *
 * ⚠️ SEQUENTIAL, NOT `Promise.all`. They share one transaction and one
 *   connection, so concurrency buys nothing here and costs the ordering that
 *   makes a failure legible. There are at most four keys per step.
 */
export async function seedSettings(
  tx: TxClient,
  inputs: readonly SeedSettingInput[]
): Promise<Record<string, SeedableValue>> {
  const seeded: Record<string, SeedableValue> = {};
  for (const input of inputs) {
    if (await seedSettingIfUnset(tx, input)) seeded[input.key] = input.value;
  }
  return seeded;
}
