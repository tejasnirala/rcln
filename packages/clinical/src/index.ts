/**
 * `@rcln/clinical` — the consultation engine's logic, with nothing around it.
 *
 * Modelled directly on `@rcln/regulatory`, and for the same reason: it holds no
 * Prisma client, reads no database, knows no clock, renders no React and
 * contains no country and no specialty. The caller loads the rows and passes
 * them in; the package returns a parsed configuration or a sentence saying why
 * it could not. That is what makes a template a fixture rather than a migration,
 * and it is why the engine is unit-tested here and nowhere else (CD-10).
 *
 * ⚠️ THE ONE INVARIANT EVERY CALLER MUST HONOUR: **A CONFIGURATION THAT SAYS
 *   NOTHING CHECKABLE IS AN ERROR.** `{ "require": true }` for
 *   `{ "required": true }` is one typo, and a parser that reads an absent key as
 *   "not required" silently switches off a mandatory field on a clinical form.
 *   Nothing here defaults; everything here refuses. See `descriptors.ts`.
 *
 * ⚠️ AND NOTHING HERE HOLDS A FOREIGN KEY. Templates name vocabulary scopes and
 *   visual maps by CODE — the ids are resolved by the caller, against rows the
 *   database can actually constrain (CD-6, ADR-0006).
 */

export * from './types.js';
export * from './registry.js';
export * from './descriptors.js';
export * from './definition.js';
export * from './resolve.js';
export * from './validate.js';
