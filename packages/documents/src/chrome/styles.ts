/**
 * The paged geometry every rcln document shares, and the preview's chrome.
 *
 * ── WHERE THE PRINTED HEADER AND FOOTER ACTUALLY COME FROM ──────────────────
 * Not from here. `template.tsx` renders them into Chromium's own
 * `headerTemplate` / `footerTemplate`, and its file header records the
 * measurement that forced that choice — `position: fixed` chrome is culled on
 * the first or last page, and there is no way to put an element in the page
 * margin without it.
 *
 * What this file owns is:
 *
 *   the geometry     `PAGE`, `HEADER_BAND`, `FOOTER_BAND` — one declaration of
 *                    the paper, shared by the stylesheet, the preview and the
 *                    print templates so they cannot disagree
 *   the `@page` rule the margins that RESERVE the two bands
 *   the preview      the same header and footer, drawn once at the top and
 *                    bottom of the on-screen sheet and hidden in print
 *
 * ⚠️ THE PREVIEW'S CHROME AND THE PRINTED CHROME ARE THE SAME COMPONENTS WITH
 *   TWO STYLESHEETS, AND THAT DUPLICATION IS DELIBERATE AND BOUNDED. Chromium's
 *   templates are a separate document that inherits nothing, so the print copy
 *   carries its own CSS (in `template.tsx`) built from the same constants. The
 *   MARKUP has one definition — `page-chrome.tsx` — which is the half that would
 *   otherwise drift.
 *
 * ── THE BANDS ARE FIXED HEIGHT, WHICH IS THE POINT ──────────────────────────
 * The `@page` margins reserve the bands; the chrome is pinned to exactly that
 * height at both ends. A header that grew with a long clinic address would start
 * the body at a different height on different sheets, and every table row would
 * land somewhere else on every page. `min-height` sets the floor, `max-height`
 * and `overflow: hidden` the ceiling — a very long address loses its last line
 * rather than moving the whole document.
 */

/**
 * A4 portrait, and every measurement derived from it.
 *
 * ⚠️ ONE DECLARATION OF THE PAPER, HERE. `preferCSSPageSize` is set on the
 *   Playwright side precisely so this is what decides the geometry — a `format`
 *   option there and a `size` here are two sources of truth for one measurement,
 *   and the failure is a preview laid out for one paper size and a PDF printed
 *   on another.
 */
const SIDE_MM = 8;
const WIDTH_MM = 210;

/**
 * The width the body actually has, in millimetres.
 *
 * ⚠️ EXPORTED AS A NUMBER BECAUSE `items.tsx` DOES ARITHMETIC WITH IT. That file
 *   computes a colgroup whose widths must sum to exactly this — the column COUNT
 *   is data, so the sum cannot be written down in CSS — and a second copy of the
 *   figure there is how a table quietly starts overflowing the margin.
 */
export const CONTENT_WIDTH_MM = WIDTH_MM - SIDE_MM * 2;

export const PAGE = {
  width: `${String(WIDTH_MM)}mm`,
  height: '297mm',
  /**
   * The left and right margin.
   *
   * ⚠️ 8mm, DOWN FROM 14mm, AND IT IS NOW THE SAME AS THE VERTICAL GAP. The air
   *   between the header rule and the body is `marginTop - HEADER_BAND` = 8mm,
   *   and between the body and the footer rule the same — so the workspace has
   *   one uniform inset on all four sides rather than a wider one at the ends.
   *
   * ⚠️ AND IT DOES NOT GO MUCH BELOW THIS. What this margin protects against is
   *   the non-printable edge of an ordinary office laser printer, which is
   *   commonly 5–6.35mm; at 8mm the outer columns still clear it on every
   *   printer worth designing for. Take it to 3mm and the invoice looks roomier
   *   on screen and comes out of some printers with the Amount column shaved off
   *   — a failure nobody sees until a patient is holding the paper.
   */
  side: `${String(SIDE_MM)}mm`,
  contentWidth: `${String(CONTENT_WIDTH_MM)}mm`,

  /**
   * The top margin: the header band plus the air between it and the body.
   *
   * ⚠️ CHANGE THIS AND `HEADER_BAND` TOGETHER OR THE BODY OVERLAPS THE HEADER ON
   *   EVERY PAGE. The printed header lives in this margin; the margin is the
   *   only thing keeping body text out from under it. It must stay larger than
   *   `HEADER_BAND` by however much air is wanted between the two.
   */
  marginTop: '38mm',
  /** The footer band plus the air below the body. Same warning as above. */
  marginBottom: '18mm',
} as const;

/**
 * How tall the header is allowed to be. Fixed — see the file header.
 *
 * ⚠️ 30mm AND NOT 26mm, AND THE FOUR MILLIMETRES ARE A REAL CLINIC'S ADDRESS.
 *   A hospital with a five-line address overflowed a 26mm band, and because the
 *   band is clipped the last lines vanished UNDER the rule that closes it —
 *   which reads as the rule cutting through the text. The address block is also
 *   laid out to wrap now rather than to print one line per entry, which is what
 *   actually makes a long address fit; this is the headroom that stops the
 *   common case ever reaching the clamp.
 *
 * ⚠️ THE HEADER SITS AT THE BOTTOM OF THIS BAND, NOT THE TOP, AND THAT IS WHAT
 *   MAKES THE GAP BELOW THE RULE CONSTANT. The rule hugs the header's content
 *   (so a three-line header does not get a chasm between its address and the
 *   line), and the band is a fixed height (so the body starts in the same place
 *   on every page). Anchor the content to the TOP and those two facts fight: the
 *   leftover height falls between the rule and the body, and a short header
 *   pushes "Billed to" 20mm down the page. Anchored to the bottom, the leftover
 *   becomes air above the header — which reads as an ordinary top margin — and
 *   the gap under the rule is always `PAGE.marginTop - HEADER_BAND`.
 */
export const HEADER_BAND = '30mm';
/** The band along the foot: a rule, the document's small print, the page count. */
export const FOOTER_BAND = '10mm';

/**
 * The `@page` rule: the paper, and the margins that reserve the two bands.
 *
 * ⚠️ NO `@bottom-right { content: counter(page) }` HERE, THOUGH IT WORKS IN THIS
 *   CHROMIUM AND WAS TRIED. The page count comes from the footer template
 *   instead, so that the number and the rule above it are one box laid out
 *   together rather than two boxes in the same band hoping not to collide.
 */
export function pageRule(): string {
  return `
@page {
  size: A4;
  /*
   * ⚠️ THE MARGINS RESERVE THE HEADER AND FOOTER BANDS, AND CHROMIUM PRINTS ITS
   *   TEMPLATES INTO THEM. Shrink either one without shrinking the matching
   *   band in \`template.tsx\` and the running chrome overlaps the body — on
   *   page two onwards only, which no preview will ever show you.
   */
  margin: ${PAGE.marginTop} ${PAGE.side} ${PAGE.marginBottom};
}
`;
}

/**
 * The chrome as the PREVIEW draws it — once, in flow, hidden when printing.
 *
 * ⚠️ THE PRINTED CHROME IS NOT THIS. See `template.tsx`. Styling only this and
 *   expecting the PDF to follow is the mistake this comment exists to prevent.
 */
export function chromeStylesheet(): string {
  return `
.page-header {
  /*
   * ⚠️ NOT \`position: fixed\`, THOUGH IT WAS AND THAT IS THE WHOLE STORY OF
   *   THIS FILE. A fixed element pulled into the page margin is culled on the
   *   first or last page by Chromium — measured, see \`template.tsx\`. This copy
   *   is the PREVIEW's header and simply sits at the top of the sheet; the
   *   printed one is a header template.
   */
  height: ${HEADER_BAND};
  /*
   * ⚠️ FLOOR AND CEILING BOTH. \`min-height\` alone lets a clinic with a
   *   four-line address grow the band, which shifts the body on that page only.
   *   The overflow rule is what makes the geometry a promise rather than a hope.
   */
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

.page-header-inner {
  display: grid;
  grid-template-columns: 1fr auto;
  gap: 0 10mm;
  align-items: start;
  border-bottom: var(--heavyline);
  padding-bottom: 2mm;
  box-sizing: border-box;
}

.page-footer {
  /*
   * The preview's footer, pushed to the foot of the sheet. See \`.page-header\`.
   *
   * \`margin-top: auto\` needs the sheet to be a column flexbox, which it is —
   * so on a short invoice the footer sits at the bottom of the page rather than
   * floating directly under the last line, which is where it prints.
   */
  margin-top: auto;
  padding-top: 1.5mm;
  height: ${FOOTER_BAND};
  min-height: ${FOOTER_BAND};
  max-height: ${FOOTER_BAND};
  overflow: hidden;
  border-top: var(--hairline);
  box-sizing: border-box;
  font-size: 7.5pt;
  color: var(--muted);
  display: flex;
  align-items: center;
}

/* --- the header's two columns ------------------------------------------- */

.chrome-issuer-name {
  font-size: 11pt;
  font-weight: 600;
  letter-spacing: -0.01em;
  line-height: 1.2;
}
.chrome-issuer-trade { font-size: 8.5pt; color: var(--muted); }
.chrome-issuer-detail {
  font-size: 7.5pt;
  color: var(--muted);
  line-height: 1.35;
  margin-top: 0.8mm;
  /*
   * ⚠️ WRAPPED, NOT ONE LINE PER ADDRESS ENTRY, AND THAT IS WHAT MAKES A LONG
   *   ADDRESS FIT. The left column is over 100mm wide, so a five-line postal
   *   address joined with separators occupies two or three wrapped lines
   *   instead of five stacked ones. The old rule was \`white-space: pre-line\`,
   *   which honoured every newline and pushed the tail of a hospital's address
   *   out of the clipped band.
   *
   * ⚠️ AND THE CLAMP IS THE GUARANTEE, NOT THE LAYOUT. It bounds the truly
   *   pathological case so the band's height stays a promise; the wrapping is
   *   what stops ordinary clinics ever reaching it.
   */
  display: -webkit-box;
  -webkit-line-clamp: 3;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
.chrome-issuer-tax { font-size: 7.5pt; margin-top: 0.5mm; }

.chrome-doc { text-align: right; }
.chrome-doc-title {
  font-size: 12pt;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  line-height: 1.2;
}
/*
 * A two-column grid rather than a run of lines, so the values line up down the
 * right edge however long the labels are.
 */
.chrome-doc-meta {
  margin-top: 1mm;
  display: grid;
  grid-template-columns: auto auto;
  gap: 0 3mm;
  justify-content: end;
  font-size: 7.5pt;
}
.chrome-doc-meta dt { color: var(--muted); text-align: right; }
.chrome-doc-meta dd { margin: 0; text-align: right; }

/* ---------------------------------------------------------------------------
 * On screen.
 *
 * ⚠️ THE PREVIEW SHOWS THE CHROME ONCE, AT THE TOP AND BOTTOM OF THE SHEET, AND
 *   SHOWS NO PAGE NUMBER. That is honest rather than a limitation worked around:
 *   the preview is one continuous sheet, so it HAS no second page to repeat onto
 *   and no total to count. Pinning these to the viewport instead — which is what
 *   \`position: fixed\` means on screen — would float them over the body as the
 *   user scrolled the iframe, which reads as a bug.
 * ------------------------------------------------------------------------ */
@media print {
  /*
   * ⚠️ THE IN-DOCUMENT CHROME IS HIDDEN IN PRINT, AND THE PRINTED ONE COMES FROM
   *   \`template.tsx\`. Both exist on purpose: this copy is what the preview
   *   shows, and Chromium's template is what actually repeats on every page.
   *   Leaving this one visible would print the header TWICE on page one — once
   *   in the margin band and once at the top of the body.
   */
  .page-header,
  .page-footer {
    display: none;
  }
}
`;
}
