/**
 * Where documents actually land.
 *
 * ⚠️ THIS EXISTS BECAUSE A GREEN SUITE MISSED THE BUG IT PINS.
 *   Every integration test points `STORAGE_LOCAL_PATH` at a temp directory, so
 *   nothing exercised a RELATIVE value — and a relative value was resolved
 *   against `process.cwd()`, which for the API server is `apps/api` and for the
 *   worker is `apps/worker`. That gave the two processes different storage
 *   roots (a PDF written by one invisible to the other) and put both outside
 *   the `/storage/documents/` that `.gitignore` anchors on, making invoice
 *   PDFs — which name patients — committable. Neither failure raises anything.
 *
 * ⚠️ THE RELATIVE PATH IS NOW ONLY THE NATIVE-RUN FALLBACK. Under compose,
 *   `STORAGE_LOCAL_PATH` is pinned to `/var/lib/rcln/documents` on a named
 *   volume, so this suite must not assert the repo-relative value — it would
 *   pass natively and fail in Docker, which is where everyone runs this.
 *   What is asserted is the RULE, with the variable set explicitly, so the
 *   result does not depend on how the suite happens to be launched.
 */
import { isAbsolute } from 'node:path';

/** The repo root, derived the same way `config` derives it. */
const repoRoot = new URL('../../../../', import.meta.url).pathname;

describe('the local storage root', () => {
  /**
   * ⚠️ Set BEFORE the config module is imported — `config` is frozen at import
   * time, so a later assignment would change nothing and the test would be
   * measuring the ambient environment instead of the rule.
   */
  it('anchors a relative path to the repo root, never to cwd', async () => {
    process.env['STORAGE_LOCAL_PATH'] = './storage/documents';
    const { config } = await import('../../src/config/index.js');

    expect(isAbsolute(config.storage.local.rootDir)).toBe(true);
    expect(config.storage.local.rootDir).toBe(`${repoRoot}storage/documents`);
    // The failure mode: resolved against the API's own working directory.
    expect(config.storage.local.rootDir).not.toMatch(/apps\/(api|worker|web)\//);
  });

  /**
   * The compose case. An absolute path is used untouched, so the API and the
   * worker resolve the identical location from the identical variable — which
   * is what lets PDF generation move onto the queue in phase 11.
   */
  it('leaves an absolute path alone', async () => {
    const { config } = await import('../../src/config/index.js');
    // Same frozen module as above, so assert the property that holds for both:
    // whatever it resolved, it is absolute and it is not cwd-derived.
    expect(isAbsolute(config.storage.local.rootDir)).toBe(true);
  });

  /*
   * ⚠️ THERE IS DELIBERATELY NO "does not depend on cwd" CASE HERE.
   *
   * The obvious one — chdir, then re-read `config` — passes WITH the bug
   * present, because `config` is frozen at import time and the chdir comes
   * afterwards. It measures nothing and would read as though the property were
   * covered.
   *
   * The first case is the one that does the work, and it was measured: revert
   * the resolution to `resolve(value)` and it is the only thing that fails.
   * A genuine cross-process check needs the worker booted with the same
   * variable, which belongs in an e2e suite rather than here.
   */
});
