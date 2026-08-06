/**
 * The small amount of shaping every provider adapter needs, in one place.
 *
 * WHY THIS FILE EXISTS
 *   These started as module-private helpers in `cashfree.ts`. The second adapter
 *   needed the same six, and a second copy of `headerValue` is exactly the
 *   duplication `pnpm kb:find` exists to prevent — the two copies drift, and the
 *   drift shows up as a webhook that verifies on one provider and not the other.
 *
 * WHY THE ACCESSORS AND NOT PLAIN INDEXING
 *   A provider's JSON is `unknown` in principle and wrong in practice: fields are
 *   renamed between API versions, and numbers arrive as strings about half the
 *   time. Reading through these means an absent field is `undefined` and lands
 *   the event in `unknown` — recorded and ignored — rather than producing a
 *   `NaN` amount that reaches the ledger.
 */

/** Anything JSON-shaped. Read through the accessors below, never indexed raw. */
export type Json = Record<string, unknown>;

export function str(source: Json | undefined, key: string): string | undefined {
  const value = source?.[key];
  return typeof value === 'string' && value !== '' ? value : undefined;
}

export function num(source: Json | undefined, key: string): number | undefined {
  const value = source?.[key];
  if (typeof value === 'number') return value;
  if (typeof value === 'string' && value.trim() !== '' && !Number.isNaN(Number(value))) {
    return Number(value);
  }
  return undefined;
}

export function obj(source: Json | undefined, key: string): Json | undefined {
  const value = source?.[key];
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Json)
    : undefined;
}

export function arr(source: Json | undefined, key: string): Json[] {
  const value = source?.[key];
  if (!Array.isArray(value)) return [];
  return value.filter(
    (entry): entry is Json => typeof entry === 'object' && entry !== null && !Array.isArray(entry)
  );
}

/** An ISO-8601 timestamp, or undefined if it is absent or unparseable. */
export function isoDate(value: string | undefined): Date | undefined {
  if (!value) return undefined;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed;
}

/**
 * A unix timestamp in SECONDS, which is what Indian gateways overwhelmingly use.
 *
 * Zero is treated as absent: Razorpay returns `0` rather than `null` for "this
 * has not happened yet", and `new Date(0)` is 1970 — a `paidAt` of 1970 is worse
 * than no `paidAt`, because it looks like data.
 */
export function unixDate(value: number | undefined): Date | undefined {
  if (value === undefined || !Number.isFinite(value) || value <= 0) return undefined;
  return new Date(value * 1000);
}

/**
 * Treat an empty or whitespace-only value as "not set".
 *
 * ⚠️ `??` DOES NOT KNOW THAT, AND THAT COST A LIVE OUTAGE.
 *   `.env` files ship optional keys with the value blank — `CASHFREE_WEBHOOK_SECRET=`
 *   — which reaches an adapter as `''`, and `'' ?? fallback` is `''`. Every
 *   signature was then verified against a zero-length key and every delivery
 *   answered 401, with a log line that said only "signature did not verify".
 */
export function blankToUndefined(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed === '' ? undefined : trimmed;
}

/**
 * Read a header without caring how it was cased.
 *
 * Node lowercases incoming header names, so the direct lookup is what runs in
 * production. `RawWebhook.headers` is a public type though, and a caller
 * building one by hand — a replay tool, a test, a future transport that is not
 * Express — can easily hand over `X-Razorpay-Signature`. Missing it presents as
 * "missing signature headers", which reads like the provider's fault.
 */
export function headerValue(
  headers: Readonly<Record<string, string | string[] | undefined>>,
  name: string
): string | undefined {
  const direct = headers[name];
  const value =
    direct ??
    Object.entries(headers).find(([key]) => key.toLowerCase() === name.toLowerCase())?.[1];

  return Array.isArray(value) ? value[0] : value;
}
