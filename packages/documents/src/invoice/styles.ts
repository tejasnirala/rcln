/**
 * The invoice's stylesheet, as one string.
 *
 * ⚠️ THE DIRECTION IS NOT INVENTED HERE. `apps/web/src/app/globals.css` decides
 *   the product's palette and type once, and every surface after it inherits —
 *   its own header says so. The values below are that file's tokens written as
 *   literals, because this stylesheet is served inside an `srcdoc` iframe and to
 *   a headless Chromium, neither of which can see the app's `@theme` block. They
 *   are copied deliberately and they are the whole list; a colour that is not
 *   here is a colour this document does not use.
 *
 * ⚠️ NO TAILWIND, AND THAT IS NOT A LIMITATION TO WORK AROUND. Tailwind needs a
 *   build step and a scan of the source it is styling; there is no build step
 *   between `renderInvoiceHtml()` and Chromium. Plain CSS is also what makes the
 *   document self-contained — one string, no external request, no asset that can
 *   be missing in one of the three runtimes and present in the other two.
 *
 * WHAT WAS DELIBERATELY LEFT OUT
 *   - `--font-display` (IBM Plex Serif). globals.css restricts it to headlines,
 *     and an invoice has no headline. A clinic's name is a name.
 *   - `--color-signal`. It means "the thing that is happening right now", and
 *     spending it anywhere else makes it stop working — globals.css is explicit.
 *     An issued invoice is finished. The VOID watermark, which is the one thing
 *     on this document that genuinely shouts, is heavy outlined `ink` instead.
 *   - `--color-paper` as the page. A full-bleed tint costs toner on every print
 *     and photocopies as grey. The page is white; the tint appears only in the
 *     two bands that carry it.
 *
 * THE SIGNATURE, AND THE ONE RISK
 *   Every horizontal division on the page is a 0.2mm hairline except exactly
 *   two, which are 0.5mm `drape`: the rule under the masthead and the rule above
 *   the grand total. Two heavy lines on the whole document, marking the only two
 *   questions it answers — who is billing, and what is owed. Everything else
 *   recedes.
 *
 *   The risk that goes with it: the item table has NO vertical rules and NO
 *   zebra striping. Column separation is carried entirely by tabular figures,
 *   right alignment and column widths fixed in millimetres. That fails if the
 *   columns are cramped, which is why the widths below are stated in mm and add
 *   up to the content width rather than being left to the table algorithm.
 */

/** A4 portrait, and the margins the content is laid out inside. */
const PAGE = {
  width: '210mm',
  margin: '14mm',
  /** Wider at the foot: the print footer sits in it. */
  marginBottom: '16mm',
  contentWidth: '182mm',
} as const;

export interface StylesheetOptions {
  /**
   * `@font-face` blocks, generated from the vendored subsets.
   *
   * Passed in rather than imported here so a test can render the document
   * without 141KB of base64 in every snapshot, and so the one place that knows
   * about fonts stays the one place that knows about fonts.
   */
  fontFaces: string;
}

export function invoiceStylesheet(options: StylesheetOptions): string {
  return `
${options.fontFaces}

/* ---------------------------------------------------------------------------
 * Reset. Narrow on purpose — this document owns every element it renders, so
 * there is nothing to normalise away except the browser's defaults on the few
 * tags actually used.
 * ------------------------------------------------------------------------ */
*, *::before, *::after { box-sizing: border-box; }
html, body { margin: 0; padding: 0; }
table { border-collapse: collapse; border-spacing: 0; width: 100%; }
th, td { padding: 0; text-align: left; font-weight: inherit; vertical-align: top; }

:root {
  /* globals.css, surgical-green ramp. */
  --ink: #0e1f1a;
  --ink-soft: #1c332c;
  --drape: #2f5d52;
  --drape-tint: #e3ece9;
  --muted: #5f716c;
  --rule: #d9e1dd;

  --sans: 'IBM Plex Sans', ui-sans-serif, system-ui, sans-serif;
  --mono: 'IBM Plex Mono', ui-monospace, SFMono-Regular, monospace;

  /* globals.css: tight radii — a precision instrument, not a consumer app. */
  --radius-xs: 0.5mm;

  --hairline: 0.2mm solid var(--rule);
  --heavyline: 0.5mm solid var(--drape);
}

/* ---------------------------------------------------------------------------
 * The page.
 *
 * \`preferCSSPageSize\` is set on the Playwright side, so THIS is what decides
 * the paper — one declaration rather than a size in the CSS and a \`format\`
 * option that could disagree with it.
 * ------------------------------------------------------------------------ */
@page {
  size: A4;
  margin: ${PAGE.margin} ${PAGE.margin} ${PAGE.marginBottom};
}

body {
  font-family: var(--sans);
  /*
   * 9pt, not px. The preview is a picture of a piece of paper, so the unit that
   * means the same thing on screen and on the sheet is the physical one.
   */
  font-size: 9pt;
  line-height: 1.45;
  color: var(--ink);
  background: #ffffff;
  -webkit-font-smoothing: antialiased;
  /* The tinted bands are information, not decoration — never dropped. */
  print-color-adjust: exact;
  -webkit-print-color-adjust: exact;
}

/*
 * On screen the document is a sheet on a desk; in print the page IS the sheet,
 * so the margin and shadow have to go or they are printed as blank inches.
 */
.sheet {
  width: ${PAGE.width};
  min-height: 297mm;
  margin: 0 auto;
  padding: ${PAGE.margin} ${PAGE.margin} ${PAGE.marginBottom};
  background: #ffffff;
}

/*
 * ⚠️ NO PADDING AND NO DROP SHADOW AROUND THE SHEET, THOUGH BOTH WERE HERE.
 *   They made a standalone preview look like a page lying on a desk, and this
 *   document is never viewed standalone: it is rendered into a sandboxed iframe
 *   on the invoice screen, and printed by Chromium where the print block below
 *   resets everything anyway. Inside that frame the 8mm band was simply dead
 *   space at the top and bottom, and the shadow was clipped by the frame's edge.
 *
 *   The grey stays. It shows only when the viewport is wider than the sheet,
 *   which is centred with margin auto — the one case where a backdrop is still
 *   the right answer rather than a white page bleeding into a white app.
 *
 * The 14mm inside .sheet is NOT this and must never be removed: that is the page
 * margin, it prints, and an invoice whose content runs to the paper edge is a
 * document a printer will crop.
 *
 * ⚠️ NO BACKTICKS IN THIS FILE'S COMMENTS. The whole stylesheet is one template
 *   literal, so a backtick ends it — and the syntax error surfaces hundreds of
 *   lines away, where nothing looks wrong.
 */
@media screen {
  body { background: #f3f5f2; padding: 0; }
}

@media print {
  body { background: #ffffff; padding: 0; }
  .sheet { width: auto; min-height: 0; margin: 0; padding: 0; box-shadow: none; }
}

/* ---------------------------------------------------------------------------
 * Shared atoms
 * ------------------------------------------------------------------------ */

/*
 * globals.css: "anything the system generated rather than a person wrote" is
 * set in mono — it names the token, the MRN, the GSTIN, the HSN and the invoice
 * number explicitly. This document is where most of that list finally appears.
 */
.mono {
  font-family: var(--mono);
  font-variant-numeric: tabular-nums;
  letter-spacing: -0.01em;
}

/* Money and quantities. Tabular figures are what let the columns hold without
 * a single vertical rule — see the header. */
.num {
  font-variant-numeric: tabular-nums;
  text-align: right;
  white-space: nowrap;
}

.label {
  font-size: 6.5pt;
  font-weight: 600;
  letter-spacing: 0.1em;
  text-transform: uppercase;
  color: var(--muted);
}

.muted { color: var(--muted); }
.strong { font-weight: 600; color: var(--ink-soft); }

/* ---------------------------------------------------------------------------
 * Masthead — who is billing, and which document this is
 * ------------------------------------------------------------------------ */
.masthead {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12mm;
  padding-bottom: 4mm;
  border-bottom: var(--heavyline);
}

.issuer-name {
  font-size: 13pt;
  font-weight: 600;
  line-height: 1.2;
  color: var(--ink);
}

.issuer-trade {
  font-size: 8pt;
  color: var(--muted);
  margin-top: 0.6mm;
}

.issuer-detail {
  margin-top: 2.5mm;
  font-size: 8pt;
  line-height: 1.5;
  color: var(--ink-soft);
  white-space: pre-line;
}

.issuer-tax {
  margin-top: 1.5mm;
  font-size: 8pt;
}

.doc { text-align: right; flex: 0 0 62mm; }

.doc-title {
  font-size: 12pt;
  font-weight: 600;
  letter-spacing: 0.14em;
  text-transform: uppercase;
  color: var(--drape);
  line-height: 1.1;
}

.doc-number {
  margin-top: 1.5mm;
  font-size: 10pt;
  font-weight: 600;
}

.doc-meta {
  margin-top: 3mm;
  display: grid;
  grid-template-columns: auto auto;
  gap: 0.8mm 4mm;
  justify-content: end;
  font-size: 8pt;
}

.doc-meta dt { color: var(--muted); text-align: right; }
.doc-meta dd { margin: 0; text-align: right; }

/* ---------------------------------------------------------------------------
 * Parties
 * ------------------------------------------------------------------------ */
.parties {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 0 10mm;
  padding: 4mm 0;
  border-bottom: var(--hairline);
}

.party-name {
  font-size: 10pt;
  font-weight: 600;
  margin-top: 1.5mm;
  color: var(--ink);
}

.party-detail {
  margin-top: 1mm;
  font-size: 8pt;
  line-height: 1.5;
  color: var(--ink-soft);
  white-space: pre-line;
}

.party-right { text-align: right; }

.supply-grid {
  margin-top: 1.5mm;
  display: grid;
  grid-template-columns: auto auto;
  gap: 0.8mm 4mm;
  justify-content: end;
  font-size: 8pt;
}

.supply-grid dt { color: var(--muted); }
.supply-grid dd { margin: 0; }

/* ---------------------------------------------------------------------------
 * Items
 *
 * Widths in mm, summing to the content width. The table algorithm is not asked
 * to guess, because a guess that comes out differently in the preview and in
 * print is precisely the drift this design exists to prevent.
 * ------------------------------------------------------------------------ */
.items { margin-top: 5mm; table-layout: fixed; width: ${PAGE.contentWidth}; }

.items thead th {
  background: var(--drape-tint);
  padding: 1.6mm 2mm;
  font-size: 6.5pt;
  font-weight: 600;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--ink-soft);
  border-radius: 0;
}
.items thead th:first-child { border-top-left-radius: var(--radius-xs); border-bottom-left-radius: var(--radius-xs); }
.items thead th:last-child  { border-top-right-radius: var(--radius-xs); border-bottom-right-radius: var(--radius-xs); }

.items tbody td {
  padding: 1.8mm 2mm;
  font-size: 8pt;
  border-bottom: var(--hairline);
  vertical-align: top;
}

/* A line is an atom. Splitting one across a page break puts a description on
 * one sheet and its price on the next. */
.items tbody tr { break-inside: avoid; page-break-inside: avoid; }

.col-n       { width: 6mm;  }
.col-desc    { width: 54mm; }
/*
 * The consultation table's description column. It absorbs the 25mm that the
 * HSN/SAC and Qty columns take on the generic table, so both tables total the
 * same 182mm and a reader flipping between two invoices sees the money columns
 * in the same place on the page. See items.tsx — and note that this whole
 * stylesheet is one template literal, so a backtick in a comment ends it.
 */
.col-desc-wide { width: 79mm; }
.col-code    { width: 14mm; }
.col-qty     { width: 11mm; }
.col-rate    { width: 19mm; }
.col-disc    { width: 17mm; }
.col-taxable { width: 20mm; }
.col-tax     { width: 18mm; }
.col-amount  { width: 23mm; }

.item-desc { color: var(--ink); }

/*
 * The per-line tax breakdown, under the description rather than in a column of
 * its own. In Karnataka a 12% line is CGST 6% + SGST 6% — two facts that do not
 * fit one cell, and that a reader needs beside the item rather than only in the
 * summary.
 */
.item-taxes {
  margin-top: 0.8mm;
  font-size: 7pt;
  color: var(--muted);
}

.item-reason {
  margin-top: 0.8mm;
  font-size: 7pt;
  color: var(--muted);
  font-style: italic;
}

/* ---------------------------------------------------------------------------
 * The foot: tax summary on the left, totals on the right
 * ------------------------------------------------------------------------ */
.foot {
  margin-top: 5mm;
  display: grid;
  grid-template-columns: 1fr 76mm;
  gap: 0 10mm;
  align-items: start;
  break-inside: avoid;
  page-break-inside: avoid;
}

.tax-table { margin-top: 2mm; font-size: 7.5pt; }
.tax-table th {
  padding: 0 2mm 1mm 0;
  font-size: 6.5pt;
  font-weight: 600;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--muted);
  border-bottom: var(--hairline);
}
.tax-table td { padding: 1.2mm 2mm 1.2mm 0; border-bottom: var(--hairline); }
.tax-table th:last-child, .tax-table td:last-child { padding-right: 0; }

.totals { width: 100%; font-size: 8.5pt; }
.totals td { padding: 1.2mm 0; }
.totals td:last-child { text-align: right; }
.totals .totals-label { color: var(--muted); }

.totals .grand td {
  padding: 2.2mm 2.5mm;
  background: var(--drape-tint);
  border-top: var(--heavyline);
  font-size: 11pt;
  font-weight: 600;
  color: var(--ink);
}
.totals .grand td:first-child { border-top-left-radius: var(--radius-xs); }
.totals .grand td:last-child  { border-top-right-radius: var(--radius-xs); }

.totals .settlement td {
  padding-top: 1.6mm;
  font-size: 8pt;
}

.balance td { font-weight: 600; color: var(--ink-soft); }

/* ---------------------------------------------------------------------------
 * Notes, declaration, signature
 * ------------------------------------------------------------------------ */
.closing {
  margin-top: 8mm;
  display: grid;
  grid-template-columns: 1fr 62mm;
  gap: 0 10mm;
  align-items: end;
  break-inside: avoid;
  page-break-inside: avoid;
}

.notes {
  font-size: 8pt;
  line-height: 1.5;
  color: var(--ink-soft);
  white-space: pre-line;
}

.signature {
  text-align: right;
  font-size: 8pt;
}

.signature-rule {
  margin-top: 14mm;
  padding-top: 1.5mm;
  border-top: var(--hairline);
  color: var(--muted);
}

.colophon {
  margin-top: 6mm;
  padding-top: 2mm;
  border-top: var(--hairline);
  font-size: 7pt;
  color: var(--muted);
  display: flex;
  justify-content: space-between;
  gap: 6mm;
}

/* ---------------------------------------------------------------------------
 * VOID
 *
 * The one element on the page allowed to shout. Outlined rather than filled so
 * the line items stay readable underneath it — a voided invoice still has to be
 * legible to the person reconciling it, and a solid block would make the
 * document unreadable rather than unusable.
 * ------------------------------------------------------------------------ */
.void-mark {
  position: absolute;
  top: 120mm;
  left: 0;
  right: 0;
  text-align: center;
  font-size: 48pt;
  font-weight: 600;
  letter-spacing: 0.2em;
  color: transparent;
  -webkit-text-stroke: 0.6mm var(--ink);
  opacity: 0.16;
  transform: rotate(-16deg);
  pointer-events: none;
}

.sheet { position: relative; }
`.trim();
}
