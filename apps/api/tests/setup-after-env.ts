/**
 * Runs in each suite's own module registry, after the test environment is up.
 *
 * ⚠️ THE API OPENS A REDIS CONNECTION THAT NO TEST ASKED FOR, AND ONLY FOUR
 *   SUITES KNEW TO CLOSE IT. `issueInvoice` enqueues the invoice-PDF job, which
 *   memoises a BullMQ producer inside `queue/producer.ts`. BullMQ's connection
 *   is built with `maxRetriesPerRequest: null` because it blocks on
 *   `BRPOPLPUSH`, so it never idles out: the suite prints a complete green
 *   summary and then the process simply does not exit.
 *
 *   That is a bad failure to own, because the run PASSED. It cost PI-23 a
 *   `--forceExit` across half the shards, which is a flag that also hides a
 *   real hang — the reason this hook exists rather than that flag.
 *
 *   `--detectOpenHandles` reports nothing for it, which is why it survived so
 *   long: the connection is opened lazily inside a service, several awaits deep
 *   in a route, so jest's async hooks do not attribute it to any test.
 *
 *   It is here rather than in each suite because "I issued an invoice, so I
 *   own a queue connection" is not a fact a suite about stock movements should
 *   have to know. `disconnectJobProducer` is idempotent — it closes what exists
 *   and clears the memo — so the four suites that already call it explicitly
 *   are unaffected, and a suite that never enqueued anything closes nothing.
 */

/**
 * ⚠️ IMPORTED INSIDE THE HOOK, NOT AT THE TOP, AND THAT IS NOT A STYLE CHOICE.
 *   This file shares a module registry with the suite, so a top-level import
 *   here is a top-level import in EVERY suite — and `queue/producer.js` pulls in
 *   `config/index.js`, which snapshots `process.env` into a frozen object the
 *   moment it loads. `storage-path.test.ts` sets `STORAGE_LOCAL_PATH` and then
 *   imports config to assert how a relative path resolves; with config already
 *   evaluated, its `await import` returns the CACHED module and the assignment
 *   measures nothing. Four cases broke that way the first time this file was
 *   written, which is the same trap that suite's own header describes.
 *
 *   By `afterAll` the tests have run, so importing then is free of it — and the
 *   producer is memoised, so this closes the instance the suite actually used
 *   rather than making a second one. A suite that never enqueued anything loads
 *   the module, finds no producer, and closes nothing.
 */
afterAll(async () => {
  const { disconnectJobProducer } = await import('../src/queue/producer.js');
  await disconnectJobProducer();
});
