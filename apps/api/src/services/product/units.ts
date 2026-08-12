/**
 * The unit conversion algebra — MOVED TO `@rcln/inventory` IN PI-2, AND
 * RE-EXPORTED HERE SO NOTHING THAT ALREADY IMPORTED IT HAD TO CHANGE.
 *
 * ⚠️ WHY IT LEFT `apps/api`. The expiry sweep is a WORKER processor, and the
 *   worker cannot import from the API — they are two applications, and an
 *   app-to-app dependency would pull express and argon2 into a queue consumer.
 *   Every quantity the sweep writes still has to go through the one conversion
 *   engine and the one ledger writer, so both moved into a package the two
 *   applications share. That is the shape `@rcln/billing` already has, and for
 *   the same reason: two copies of a rule is two opinions about it.
 *
 * ⚠️ IT THROWS `InventoryError` NOW, NOT `ValidationError`. The API's error
 *   middleware maps `InventoryError('VALIDATION')` onto exactly the 400 that
 *   `ValidationError` produced, so nothing on the wire changed — but a `catch
 *   (e) { if (e instanceof ValidationError) }` written against this module would
 *   silently stop matching. There is no such catch today; this note is for
 *   whoever writes the first one.
 *
 * The file is kept rather than deleting it and rewriting a dozen imports,
 * because the import path is the thing `pnpm kb:find` and every existing caller
 * already know.
 */
export * from '@rcln/inventory';
