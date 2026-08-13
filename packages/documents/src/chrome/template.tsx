/**
 * The chrome, packaged the way Chromium's printer wants it — without becoming a
 * second copy of it.
 *
 * ── WHY THIS FILE EXISTS, WHICH IS A MEASURED FAILURE AND NOT A PREFERENCE ───
 *
 * The obvious way to repeat a header on every printed page is `position: fixed`,
 * and it very nearly works. Rendered against the worker's own Chromium
 * (151.0.7922.108) on a five-page document, it produces:
 *
 *     page 1   header ✓   footer ✗
 *     page 2   header ✓   footer ✓
 *     page 3   header ✓   footer ✓
 *     page 4   header ✓   footer ✓
 *     page 5   header ✗   footer ✓
 *
 * ⚠️ THE FIRST PAGE LOSES THE FOOTER AND THE LAST PAGE LOSES THE HEADER. An
 *   element pulled into the page margin with a negative offset — which is the
 *   only way to put it there — is culled on the boundary pages. It is not the
 *   `overflow` rule: the same probe with the clipping removed behaves
 *   identically. Positioning the same elements at `top: 0` / `bottom: 0`
 *   repeats them on all five pages, but then they sit INSIDE the page area and
 *   the body prints underneath them, because a fixed element reserves no space.
 *
 *   The failure is quiet in the worst way: a one-page invoice — which is every
 *   invoice anybody previews — is page one AND the last page, so it shows the
 *   header, and the missing footer looks like a design choice.
 *
 * So the printed chrome goes through `displayHeaderFooter`, which the same probe
 * shows on every page including the first and the last, and which is also the
 * only mechanism that supplies a TOTAL page count.
 *
 * ── AND IT IS STILL ONE SOURCE ──────────────────────────────────────────────
 * ⚠️ THE TEMPLATES ARE RENDERED FROM `PageHeader` AND `PageFooter` — THE SAME
 *   COMPONENTS THE PREVIEW DRAWS. Chromium's templates are a separate document
 *   that cannot see the page's stylesheet, so the naive implementation is to
 *   hand-write the header a second time in a string, and then it drifts the day
 *   somebody changes one of them. Here the markup has one definition and two
 *   deliveries; what is duplicated is only the small stylesheet below, which is
 *   generated from the same constants.
 *
 * ⚠️ THEY TRAVEL INSIDE THE DOCUMENT, IN TWO `<template>` ELEMENTS, SO THE HTML
 *   STAYS ONE SELF-CONTAINED STRING. `renderPdf` looks for them by id and knows
 *   nothing about invoices — the seam the whole package is built on survives.
 *   A `<template>` renders nothing, so the preview is unaffected.
 */

import type { JSX } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { PageFooter, PageHeader } from './page-chrome.js';
import { FOOTER_BAND, HEADER_BAND, PAGE } from './styles.js';
import type { DocumentChrome } from './types.js';

/** The ids `renderPdf` looks for. Changing one changes the worker too. */
export const HEADER_TEMPLATE_ID = 'rcln-pdf-header';
export const FOOTER_TEMPLATE_ID = 'rcln-pdf-footer';

/**
 * The stylesheet the printed chrome carries with it.
 *
 * ⚠️ CHROMIUM'S HEADER AND FOOTER TEMPLATES SEE NONE OF THE PAGE'S CSS — not the
 *   reset, not the custom properties, not the `@font-face` blocks. Everything
 *   they need is in here, and every value is either a constant from `styles.ts`
 *   or a literal copied from the token list with the token named beside it.
 *
 * ⚠️ AND THEIR DEFAULT TYPE SIZE IS ABOUT 8px WITH A ZERO MARGIN BOX. Chromium
 *   applies its own tiny defaults; a template that does not state a size prints
 *   the clinic's name in something close to unreadable.
 */
function chromeTemplateCss(fontFaces: string): string {
  return `
${fontFaces}
* { box-sizing: border-box; margin: 0; padding: 0; }
body { -webkit-print-color-adjust: exact; print-color-adjust: exact; }

.chrome-root {
  font-family: 'IBM Plex Sans', ui-sans-serif, system-ui, sans-serif;
  color: #0e1f1a;              /* --ink */
  width: 100%;
  padding: 0 ${PAGE.side};
  /*
   * ⚠️ THE BAND IS PINNED TOP AND BOTTOM. This is the fixed height the whole
   *   feature is about: a header that grew with a long clinic address would
   *   start the body at a different height on different sheets.
   */
  box-sizing: border-box;
}

.page-header {
  height: ${HEADER_BAND};
  min-height: ${HEADER_BAND};
  max-height: ${HEADER_BAND};
  overflow: hidden;
  /*
   * ⚠️ THE CONTENT SITS AT THE BOTTOM OF THE BAND. See HEADER_BAND: this is what
   *   keeps the gap under the rule constant whatever length the header is.
   */
  display: flex;
  flex-direction: column;
  justify-content: flex-end;
}

/* The rule hugs the content, not the band — see chrome/styles.ts. */
.page-header-inner {
  display: grid;
  grid-template-columns: 1fr auto;
  gap: 0 10mm;
  align-items: start;
  border-bottom: 0.5mm solid #2f5d52;   /* --heavyline / --drape */
  padding-bottom: 2mm;
}

.page-footer {
  height: ${FOOTER_BAND};
  min-height: ${FOOTER_BAND};
  max-height: ${FOOTER_BAND};
  overflow: hidden;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 6mm;
  border-top: 0.2mm solid #d9e1dd;      /* --hairline / --rule */
  padding-top: 1.5mm;
  font-size: 7pt;
  color: #5f716c;                        /* --muted */
}

.chrome-issuer-name { font-size: 11pt; font-weight: 600; line-height: 1.2; }
.chrome-issuer-trade { font-size: 8pt; color: #5f716c; }
.chrome-issuer-detail {
  font-size: 7pt;
  color: #5f716c;
  line-height: 1.35;
  margin-top: 0.8mm;
  /* Wrapped and clamped — see the note in chrome/styles.ts. */
  display: -webkit-box;
  -webkit-line-clamp: 3;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
.chrome-issuer-tax { font-size: 7pt; margin-top: 0.8mm; }

.chrome-doc { text-align: right; }
.chrome-doc-title {
  font-size: 11pt;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  color: #2f5d52;                        /* --drape */
  line-height: 1.2;
}
.chrome-doc-meta {
  margin-top: 1mm;
  display: grid;
  grid-template-columns: auto auto;
  gap: 0 3mm;
  justify-content: end;
  font-size: 7pt;
}
.chrome-doc-meta dt { color: #5f716c; text-align: right; }
.chrome-doc-meta dd { text-align: right; }

.mono { font-family: 'IBM Plex Mono', ui-monospace, SFMono-Regular, monospace; }
.strong { font-weight: 600; }
.label { color: #5f716c; }

/*
 * ⚠️ CHROMIUM SUBSTITUTES INTO THESE TWO CLASSES BY NAME. \`pageNumber\` and
 *   \`totalPages\` are filled in by the printer itself — they are the ONLY way to
 *   get a total, and they work only inside a header or footer template. An
 *   element with a different class name silently stays empty.
 */
.page-count { white-space: nowrap; }
`;
}

/** One template document: the styles plus the markup, and nothing external. */
function templateHtml(css: string, body: string): string {
  return `<style>${css}</style><div class="chrome-root">${body}</div>`;
}

/**
 * The two `<template>` elements the document carries for the printer.
 *
 * ⚠️ RENDERED WITH `dangerouslySetInnerHTML` BECAUSE A `<template>`'S CONTENT
 *   MUST SURVIVE AS MARKUP RATHER THAN BECOME REACT CHILDREN. The string is
 *   produced by `renderToStaticMarkup` from this package's own components a few
 *   lines above — there is no user input anywhere in it, and the alternative
 *   (nesting real elements) would have the browser parse them into the
 *   template's document fragment, which `innerHTML` then returns re-serialised
 *   and re-escaped.
 */
export function ChromeTemplates({
  chrome,
  fontFaces,
}: {
  chrome: DocumentChrome;
  fontFaces: string;
}): JSX.Element {
  const css = chromeTemplateCss(fontFaces);

  const header = templateHtml(css, renderToStaticMarkup(<PageHeader chrome={chrome} />));

  const footer = templateHtml(
    css,
    renderToStaticMarkup(
      <PageFooter chrome={chrome}>
        <span className="page-count">
          Page <span className="pageNumber" /> of <span className="totalPages" />
        </span>
      </PageFooter>
    )
  );

  return (
    <>
      <template id={HEADER_TEMPLATE_ID} dangerouslySetInnerHTML={{ __html: header }} />
      <template id={FOOTER_TEMPLATE_ID} dangerouslySetInnerHTML={{ __html: footer }} />
    </>
  );
}
