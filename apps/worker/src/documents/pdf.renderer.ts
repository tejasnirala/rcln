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

import { FOOTER_TEMPLATE_ID, HEADER_TEMPLATE_ID } from '@rcln/documents';

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

    /*
     * ⚠️ THE RUNNING HEADER AND FOOTER TRAVEL INSIDE THE DOCUMENT, IN TWO INERT
     *   `<template>` ELEMENTS, AND THIS IS WHERE THEY ARE UNPACKED. Chromium
     *   will only repeat chrome on every page — including the first and the
     *   last — through `displayHeaderFooter`, and it will only substitute a
     *   TOTAL page count into a footer template. Both are properties of
     *   `page.pdf()` rather than of the page, so something has to carry them
     *   across the seam.
     *
     *   Carrying them in the HTML rather than in this function's arguments is
     *   what keeps the rule at the top of this file true: the renderer still
     *   takes one self-contained string and still names no document type. It
     *   looks for two ids and does not care what is inside them.
     *
     * ⚠️ IF A DOCUMENT CARRIES NEITHER, NOTHING IS TURNED ON. `displayHeaderFooter`
     *   with empty templates does NOT print nothing — it prints Chromium's own
     *   default header, which is the URL and the date. A document without chrome
     *   must therefore not enable it at all.
     */
    /*
     * ⚠️ A STRING, NOT A CLOSURE, AND FOR A TYPE REASON RATHER THAN A STYLE ONE.
     *   The body runs in the BROWSER, but TypeScript checks it against this
     *   project's libs — and the worker is Node, with no DOM. A closure
     *   mentioning `document` does not compile, and the fix is not to add `dom`
     *   to the worker's `lib`: that would make every Node file in the app accept
     *   `window` and `localStorage` at compile time and fail at runtime. The
     *   file already talks to the page this way for `document.fonts.ready`.
     */
    const chrome = (await page.evaluate(`(() => {
      const read = (id) => {
        const node = document.getElementById(id);
        return node && node.tagName === 'TEMPLATE' ? node.innerHTML : '';
      };
      return { header: read('${HEADER_TEMPLATE_ID}'), footer: read('${FOOTER_TEMPLATE_ID}') };
    })()`)) as { header: string; footer: string };

    const hasChrome = chrome.header !== '' || chrome.footer !== '';

    return await page.pdf({
      ...(hasChrome
        ? {
            displayHeaderFooter: true,
            /*
             * Empty string rather than the missing one: a template Chromium is
             * given as `undefined` falls back to its built-in, so a document
             * with only a footer would print Chromium's URL header above it.
             */
            headerTemplate: chrome.header,
            footerTemplate: chrome.footer,
          }
        : {}),
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
