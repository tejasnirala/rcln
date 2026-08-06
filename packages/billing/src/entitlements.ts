/**
 * What a subscription actually grants.
 *
 * THE RESOLUTION ORDER IS FIXED, AND IT IS WRITTEN DOWN IN THE SCHEMA
 *   subscription_feature_overrides -> plan_features -> a hard default in code.
 *
 *   The override layer exists because sales promises things. A hospital chain
 *   that needs eleven branches on a plan that allows ten gets an override row
 *   with a reason on it, not a bespoke plan and not a quiet edit to the
 *   catalogue that changes the deal for everyone else on it.
 *
 * `-1` MEANS UNLIMITED, EVERYWHERE
 *   Not null, which would be indistinguishable from "nobody has set this", and
 *   not a separate boolean column per limit. Every comparison in this file and
 *   in `proration.ts` treats it as positive infinity.
 */

import type { FeatureValueType } from '@rcln/db';
import type { FeatureMap } from './proration.js';

/** UNLIMITED as it is stored. Compare with `isUnlimited`, never with `=== -1`. */
export const UNLIMITED = -1;

export function isUnlimited(value: number): boolean {
  return value < 0;
}

export interface FeatureRow {
  featureKey: string;
  valueType: FeatureValueType;
  intValue: number | null;
  boolValue: boolean | null;
}

export interface OverrideRow {
  featureKey: string;
  intValue: number | null;
  boolValue: boolean | null;
}

/**
 * The floor, for a key no plan mentions.
 *
 * Deliberately mean. A feature that has not been priced is a feature nobody has
 * agreed to sell, and defaulting a new module to "on" would hand it to every
 * existing customer for nothing the day it ships. New capability starts off and
 * is switched on by adding it to the plans that include it.
 */
const HARD_DEFAULTS: Readonly<Record<string, number | boolean>> = {
  max_branches: 1,
  max_users: 5,
  max_patients: 500,
  pharmacy_module: false,
  lab_module: false,
  whatsapp_notifications: false,
  custom_domain: false,
};

function valueOf(row: FeatureRow | OverrideRow, type?: FeatureValueType): number | boolean | null {
  const kind = 'valueType' in row ? row.valueType : type;
  if (kind === 'BOOL') return row.boolValue;
  if (kind === 'INT') return row.intValue;
  // An override carries no type of its own; whichever column is set wins.
  return row.boolValue ?? row.intValue;
}

/**
 * Flatten a plan and its overrides into the map the rest of the system reads.
 *
 * Hard defaults are folded in first so a key that exists nowhere still answers a
 * question, rather than returning undefined into a `>` comparison — which is
 * false for every number and therefore silently denies everything.
 */
export function resolveEntitlements(
  planFeatures: readonly FeatureRow[],
  overrides: readonly OverrideRow[] = []
): FeatureMap {
  const resolved: Record<string, number | boolean> = { ...HARD_DEFAULTS };

  for (const feature of planFeatures) {
    const value = valueOf(feature);
    if (value !== null) resolved[feature.featureKey] = value;
  }

  for (const override of overrides) {
    const value = valueOf(override);
    if (value !== null) resolved[override.featureKey] = value;
  }

  return resolved;
}

/** A numeric limit, or Infinity for unlimited. `undefined` keys read as 0. */
export function limitOf(features: FeatureMap, key: string): number {
  const value = features[key];
  if (typeof value !== 'number') return value === true ? 1 : 0;
  return isUnlimited(value) ? Number.POSITIVE_INFINITY : value;
}

/** Is a boolean module switched on? Anything non-boolean reads as off. */
export function hasModule(features: FeatureMap, key: string): boolean {
  return features[key] === true;
}

/**
 * Would adding `count` more of something breach the plan?
 *
 * Asked BEFORE the write, by the service that is about to create a branch or a
 * membership. Asking afterwards means the row exists and the clinic is over its
 * limit with no way back that does not delete something.
 */
export function wouldExceed(
  features: FeatureMap,
  key: string,
  currentUsage: number,
  count = 1
): boolean {
  return currentUsage + count > limitOf(features, key);
}
