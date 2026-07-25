/**
 * Escape hatch: the RAW client, with no tenant scoping.
 *
 * RLS still applies (the app role cannot bypass it), but no session variables
 * are set, so every tenant-scoped policy evaluates against a NULL org and
 * matches nothing. That is deliberate — it fails closed.
 *
 * Legitimate uses: tenant resolution by hostname, login by email/phone, and
 * platform-admin reads over `organizations` / `plans`. All of those touch tables
 * that are intentionally NOT tenant-scoped.
 *
 * Imported from a separate path so `grep -r "@rcln/db/unsafe"` lists every
 * place that skips scoping, and code review can check each one.
 */
export { getDbClient as unsafeDbClient } from './client.js';
