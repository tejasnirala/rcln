/**
 * The worker's one Chromium.
 *
 * ⚠️ CHROMIUM IS IN THE WORKER AND NOT IN THE API, AND THAT PLACEMENT IS THE
 *   ANSWER TO A MEASURED PROBLEM RATHER THAN A PREFERENCE. The api container is
 *   capped at 1g and already exits 137 running its own test suite beside the dev
 *   server; a browser process per render would land on top of that. The worker
 *   is a separate container with its own limit, it already mounts the document
 *   folder at the identical path the API reads from, and `queues.ts` has said
 *   "a slow PDF render must never occupy a request handler" since before there
 *   was one.
 *
 * ⚠️ ONE BROWSER FOR THE PROCESS, A NEW CONTEXT PER JOB. Launching Chromium
 *   costs a few hundred milliseconds and a lot of memory; doing it per invoice
 *   would make a busy afternoon at the front desk a queue of browser launches. A
 *   CONTEXT, on the other hand, is cheap and is the isolation boundary — one per
 *   job means no cookie, cache entry or storage key can carry from one clinic's
 *   document to another's. Reusing a page across tenants would be a PHI leak
 *   between renders of the sort nothing would ever report.
 *
 * ⚠️ IT IS THE DISTRIBUTION'S CHROMIUM, NOT ONE PLAYWRIGHT DOWNLOADED.
 *   `playwright-core` is deliberately the dependency rather than `playwright`:
 *   the latter downloads its own browser build on install, which does not run on
 *   Alpine's musl at all. The image installs `chromium` from apk and this points
 *   at it. The consequence to know is that the browser version now moves when
 *   the base image moves rather than when the npm dependency does — so a layout
 *   regression can arrive from a `docker build` with no change in the lockfile.
 *   That is the trade for a 250MB browser instead of a 400MB one that cannot
 *   start.
 */

import { chromium, type Browser, type BrowserContext } from 'playwright-core';

/**
 * Where the system Chromium is.
 *
 * An environment variable with a sensible default, because the path genuinely
 * differs: `/usr/bin/chromium` on Alpine, `/usr/bin/chromium-browser` on Debian
 * and older Alpine. A wrong path fails at launch with a clear error, which is
 * the right failure — unlike most of this subsystem's failure modes.
 */
const EXECUTABLE_PATH = process.env['CHROMIUM_EXECUTABLE_PATH'] ?? '/usr/bin/chromium';

/**
 * Flags, and why each one is here.
 *
 * ⚠️ `--disable-dev-shm-usage` IS NOT OPTIONAL IN A CONTAINER. Docker gives
 *   `/dev/shm` 64MB by default, Chromium uses it for renderer shared memory, and
 *   a document with a large table exhausts it — the tab crashes and
 *   `page.pdf()` rejects with a "target closed" that names nothing useful. This
 *   moves that allocation to /tmp.
 *
 * ⚠️ `--no-sandbox` IS A REAL CONCESSION, AND IT IS BOUNDED. Chromium's sandbox
 *   needs user namespaces the container does not grant. What makes it
 *   acceptable here and would NOT make it acceptable in a browser that visits
 *   the web: this process opens exactly one kind of content — an HTML string
 *   this repository generated, from a database row, with no script tag, no
 *   network access and no user-supplied URL. The template test asserts the "no
 *   external request" half of that, which is what keeps the concession bounded.
 */
const LAUNCH_ARGS = [
  '--no-sandbox',
  '--disable-dev-shm-usage',
  '--disable-gpu',
  // Nothing here plays audio or video, and the codecs are a large attack surface.
  '--mute-audio',
  // No extensions, no first-run profile, no background updater in a container.
  '--disable-extensions',
  '--no-first-run',
  '--no-default-browser-check',
];

let browser: Browser | null = null;
let launching: Promise<Browser> | null = null;

/**
 * The shared browser, launched on first use.
 *
 * ⚠️ THE IN-FLIGHT PROMISE IS MEMOISED, NOT JUST THE RESULT. Two jobs arriving
 *   together would otherwise both see `browser === null` and both launch one,
 *   and the loser's instance is leaked for the life of the process — a few
 *   hundred megabytes that nothing will ever close. Concurrency is 1 today,
 *   which makes this unreachable and makes it exactly the kind of thing that
 *   breaks the day somebody raises it.
 */
export async function getBrowser(): Promise<Browser> {
  if (browser?.isConnected() === true) return browser;

  launching ??= chromium
    .launch({ executablePath: EXECUTABLE_PATH, args: LAUNCH_ARGS })
    .then((launched) => {
      browser = launched;
      /*
       * A browser that dies — OOM, a segfault, the container being squeezed —
       * must not leave a disconnected handle memoised, or every job after it
       * fails against a corpse. Clearing both here means the next job launches a
       * fresh one.
       */
      launched.on('disconnected', () => {
        browser = null;
        launching = null;
      });
      return launched;
    })
    .catch((error: unknown) => {
      launching = null;
      throw error;
    });

  return launching;
}

/** A context for one job. Always closed by the caller, in a finally. */
export async function createRenderContext(): Promise<BrowserContext> {
  const active = await getBrowser();
  return active.newContext({
    /*
     * Pinned, not inherited. The container's zone is UTC and its locale is
     * whatever the base image sets, and a document that formatted anything from
     * the runtime would print a different string here than in the preview. The
     * template does not rely on either — every formatter takes its zone and
     * locale from the data — so this is a second line of defence rather than the
     * mechanism, and it is here so that a future `new Date().toString()` in a
     * template fails loudly in review rather than quietly in Kolkata.
     */
    locale: 'en-GB',
    timezoneId: 'UTC',
    /*
     * ⚠️ JAVASCRIPT STAYS ON, AND IT IS NOT BECAUSE THE DOCUMENT NEEDS IT.
     *   The document contains no script tag — a template test asserts that — so
     *   turning JS off would be free defence in depth. What it would also turn
     *   off is `document.fonts.ready`, which is the only way to know the
     *   embedded typefaces have been decoded before `page.pdf()` snapshots what
     *   is painted. A document set in the fallback font produces no error, no
     *   warning and a perfectly plausible PDF that does not match the preview
     *   the clinic approved. A real guarantee beats a theoretical hardening
     *   against scripts that the test says are not there.
     */
    javaScriptEnabled: true,
  });
}

export async function closeBrowser(): Promise<void> {
  const active = browser;
  browser = null;
  launching = null;
  await active?.close();
}
