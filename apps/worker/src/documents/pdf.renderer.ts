/**
 * HTML → A4 PDF bytes.
 *
 * ⚠️ TWO RENDERS OF THE SAME DOCUMENT ARE NOT BYTE-IDENTICAL, AND THAT IS FINE.
 *   A PDF carries a CreationDate that Chromium takes from the wall clock, and
 *   this version of `page.pdf()` exposes no way to pin it. It would have been
 *   nice to have — but `files.checksum` is computed over the bytes at the moment
 *   they are STORED, and what it proves is that the document served today is the
 *   one that was stored then. That is the actual requirement, and it does not
 *   need reproducibility: an issued invoice's PDF is generated once and never
 *   regenerated, so there is no second render to compare against.
 *
 * ⚠️ NOTHING IN THIS FILE NAMES AN INVOICE, AND THAT IS THE SAME RULE
 *   `DocumentService` is written under. Prescriptions, lab reports, consent
 *   forms and discharge summaries all become PDFs the same way; the moment this
 *   function needs to know which one it is rendering, the seam has moved to the
 *   wrong place. What it takes is a self-contained HTML document. What it
 *   returns is bytes.
 */

import type { Buffer } from 'node:buffer';

import { createRenderContext } from './browser.js';

/**
 * Render one document.
 *
 * ⚠️ `setContent` WITH THE STRING, NEVER A URL OR A FILE. There is no server to
 *   point a browser at, no temporary file to clean up, and — the part that
 *   matters — no possibility of the renderer fetching something the preview did
 *   not. The document is closed over its own bytes.
 */
export async function renderPdf(html: string): Promise<Buffer> {
  const context = await createRenderContext();

  try {
    const page = await context.newPage();

    /*
     * ⚠️ `waitUntil: 'load'` AND NOT `networkidle`. The document makes no
     *   request at all — the fonts are data URIs and the template test asserts
     *   there is nothing else — so `networkidle` would wait out its own timeout
     *   on every single render for a network event that can never happen.
     */
    await page.setContent(html, { waitUntil: 'load' });

    /*
     * The fonts are inline, so they are parsed rather than fetched — but
     * "parsed" is still asynchronous, and `page.pdf()` snapshots what is
     * PAINTED. Without this the first render after a cold start can come out in
     * the fallback face: no error, no warning, just a document set in something
     * other than the one the clinic approved in the preview.
     */
    await page.evaluate('document.fonts.ready');

    return await page.pdf({
      /*
       * ⚠️ THE PAGE SIZE COMES FROM THE CSS, NOT FROM A `format` OPTION HERE.
       *   The stylesheet already declares `@page { size: A4 }` because the
       *   preview needs to know the geometry too. Stating it in both places is
       *   two sources of truth for one measurement, and the failure — a
       *   preview laid out for one paper size and a PDF printed on another — is
       *   precisely the drift this design exists to prevent.
       */
      preferCSSPageSize: true,
      /*
       * The tinted table header and the total band are information, not
       * decoration. Chromium drops backgrounds by default, which would leave
       * the column labels and the grand total visually indistinguishable from
       * body rows on the printed sheet.
       */
      printBackground: true,
      // The margins are in the CSS `@page` rule, for the same reason as the size.
      margin: { top: '0', right: '0', bottom: '0', left: '0' },
    });
  } finally {
    /*
     * The context, not the browser. A leaked context holds a renderer process
     * for the life of the worker, and the symptom is a container that is fine
     * for an hour and then killed for memory.
     */
    await context.close();
  }
}
