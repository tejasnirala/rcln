/**
 * The running header and footer, as markup.
 *
 * ⚠️ WHAT THIS FILE CANNOT TELL YOU IS WHETHER THE CHROME ACTUALLY REPEATS, AND
 *   NOTHING IN CI CURRENTLY CAN. Repetition is a property of Chromium's printer,
 *   not of this string: every assertion below passed just as happily against the
 *   `position: fixed` implementation that silently dropped the footer from page
 *   one and the header from the last page. It was caught by rendering a real
 *   multi-page PDF by hand and counting.
 *
 *   `apps/worker` has no test harness — no jest, no config, no `tests/` — so
 *   there is nowhere for that check to live yet. Until there is, a Chromium
 *   version change from a `docker build` (see `browser.ts`: the browser comes
 *   from the base image, not the lockfile) can regress this with no test going
 *   red. Recorded in `.kb/PharmacyInventory/KNOWN_ISSUES.md`; the reproduction
 *   is four lines of Playwright over `renderInvoiceHtml(longInvoice(60))`.
 */
import {
  renderInvoiceHtml,
  indianInvoice,
  unregisteredInvoice,
  longInvoice,
  longAddressInvoice,
  HEADER_TEMPLATE_ID,
  FOOTER_TEMPLATE_ID,
  PAGE,
  HEADER_BAND,
} from '../src/index.js';

/** The printer's copy of the chrome, pulled out of the document by id. */
function templateOf(html: string, id: string): string {
  const match = new RegExp(`<template id="${id}"[^>]*>([\\s\\S]*?)</template>`).exec(html);
  return match?.[1] ?? '';
}

const html = renderInvoiceHtml(indianInvoice, { omitFonts: true });
const header = templateOf(html, HEADER_TEMPLATE_ID);
const footer = templateOf(html, FOOTER_TEMPLATE_ID);

describe('the document carries chrome for the printer', () => {
  it('emits both templates', () => {
    expect(header).not.toBe('');
    expect(footer).not.toBe('');
  });

  it('names the clinic in the header, on every page it will be printed on', () => {
    expect(header).toContain(indianInvoice.issuer.legalName);
    expect(header).toContain(indianInvoice.issuer.branchName);
  });

  it('carries the registration number, which is the most consequential string', () => {
    expect(header).toContain(indianInvoice.issuer.taxId ?? 'MISSING');
    expect(header).toContain(indianInvoice.issuer.taxIdLabel);
  });

  it('carries what the document is and which one it is', () => {
    expect(header).toContain('Tax Invoice');
    expect(header).toContain(indianInvoice.invoiceNumber ?? 'MISSING');
  });

  it('prints no registration line at all for a clinic that holds none', () => {
    /*
     * ⚠️ NOT AN EMPTY LABEL. A bare "GSTIN:" reads as a data-entry omission; a
     *   clinic below the registration threshold has a legal position.
     */
    const unregistered = templateOf(
      renderInvoiceHtml(unregisteredInvoice, { omitFonts: true }),
      HEADER_TEMPLATE_ID
    );

    /*
     * The CLASS, not the bare name — the selector is in the template's own
     * stylesheet either way, so matching the name alone always fails.
     */
    expect(unregistered).not.toContain('class="chrome-issuer-tax"');
    expect(unregistered).not.toContain('GSTIN');
    // The registered sample proves the assertion can fail.
    expect(header).toContain('class="chrome-issuer-tax"');
  });
});

describe('the page count', () => {
  it('uses the two class names Chromium substitutes into', () => {
    /*
     * ⚠️ THESE TWO NAMES ARE AN API, NOT A CHOICE. Chromium fills in elements
     *   classed `pageNumber` and `totalPages` inside a footer template and
     *   nothing else — a rename leaves the footer silently blank where the
     *   numbers should be.
     */
    expect(footer).toContain('class="pageNumber"');
    expect(footer).toContain('class="totalPages"');
    expect(footer).toContain('Page');
  });

  it('does not put a page count in the on-screen chrome', () => {
    // One continuous sheet has no second page to be on, and no total to count.
    const body = html.slice(html.indexOf('<body>'), html.indexOf(`<template`));
    expect(body).not.toContain('totalPages');
  });
});

describe('the bands are a fixed height, which is the whole point', () => {
  it('pins the header at both ends rather than letting it grow', () => {
    /*
     * A header that grew with a long clinic address would start the body at a
     * different height on different sheets, and every table row would land
     * somewhere else on every page.
     */
    expect(header).toContain(`min-height: ${HEADER_BAND}`);
    expect(header).toContain(`max-height: ${HEADER_BAND}`);
    expect(header).toMatch(/overflow:\s*hidden/);
  });

  it('pins the footer the same way', () => {
    expect(footer).toMatch(/min-height:\s*10mm/);
    expect(footer).toMatch(/max-height:\s*10mm/);
  });

  it('reserves room for both in the page margin', () => {
    /*
     * ⚠️ THE MARGIN MUST EXCEED THE BAND. Chromium prints the templates INTO the
     *   margin; a margin smaller than the band clips the chrome, and a body that
     *   starts too high runs underneath it — on page two onwards, where no
     *   preview will show it.
     */
    /*
     * Built from the constants rather than written out, so a deliberate change
     * to the geometry does not need this assertion edited to match — only a
     * change that breaks the RELATIONSHIP should fail here.
     */
    expect(html).toMatch(
      new RegExp(
        `@page\\s*\\{[\\s\\S]*?margin:\\s*${PAGE.marginTop}\\s+${PAGE.side}\\s+${PAGE.marginBottom}`
      )
    );

    /*
     * ⚠️ AND THE MARGIN MUST EXCEED THE BAND BY THE GAP, WHICH IS THE ONLY AIR
     *   BETWEEN THE HEADER AND THE BODY FROM PAGE TWO ONWARDS. On page one the
     *   first block of the body used to pad the top as well, so a too-small gap
     *   looked fine in every preview and left the repeated table header jammed
     *   against the rule on every later page.
     */
    const gap = Number.parseFloat(PAGE.marginTop) - Number.parseFloat(HEADER_BAND);
    expect(gap).toBeGreaterThanOrEqual(6);
  });
});

describe('the printed chrome is self-contained', () => {
  it('carries its own styles, because Chromium templates inherit none', () => {
    expect(header).toContain('<style>');
    expect(footer).toContain('<style>');
  });

  it('carries its own typefaces for the same reason', () => {
    const withFonts = templateOf(renderInvoiceHtml(indianInvoice), HEADER_TEMPLATE_ID);

    /*
     * ⚠️ A TEMPLATE WITHOUT THESE PRINTS THE CLINIC'S NAME IN THE FALLBACK FACE.
     *   No error, and only on paper — the preview looks right because the
     *   preview uses the document's own stylesheet.
     */
    expect(withFonts).toContain('@font-face');
    expect(withFonts).toContain('data:font/woff2;base64,');
  });

  it('makes no external request, exactly like the document around it', () => {
    for (const fragment of [header, footer]) {
      expect(fragment).not.toMatch(/src\s*=\s*["']https?:/i);
      expect(fragment).not.toMatch(/url\(\s*["']?https?:/i);
      expect(fragment).not.toContain('<script');
    }
  });
});

describe('the on-screen chrome does not print', () => {
  it('is hidden in print, so page one does not carry two headers', () => {
    expect(html).toMatch(/@media print\s*\{[\s\S]*?\.page-header,[\s\S]*?display:\s*none/);
  });

  it('still exists for the preview, which has no printer chrome at all', () => {
    const body = html.slice(html.indexOf('<body>'));
    expect(body).toContain('class="page-header"');
    expect(body).toContain('class="page-footer"');
  });
});

describe('the preview lays the chrome out like a page', () => {
  it('puts the footer AFTER the body, not directly under the header', () => {
    /*
     * ⚠️ THE REGRESSION THIS PINS SHIPPED AND WAS FOUND ON SCREEN. While the
     *   chrome was `position: fixed` the header and footer were declared
     *   together at the top, because source order did not affect where they
     *   painted. When print moved to Chromium's templates these became ordinary
     *   flow elements, and the footer rendered directly beneath the header —
     *   above the invoice — in every preview. The PDF was correct the whole
     *   time, which is why nothing caught it.
     */
    /*
     * ⚠️ THE TEMPLATES HAVE TO COME OUT FIRST. They sit near the top of the body
     *   and contain their own `class="page-footer"`, so searching the raw markup
     *   finds the PRINTER's footer and the assertion passes no matter where the
     *   preview's one is.
     */
    const body = html.slice(html.indexOf('<body>')).replace(/<template[\s\S]*?<\/template>/g, '');
    const headerAt = body.indexOf('class="page-header"');
    const footerAt = body.indexOf('class="page-footer"');
    const totalsAt = body.indexOf('class="totals"');

    expect(headerAt).toBeGreaterThan(-1);
    expect(footerAt).toBeGreaterThan(totalsAt);
    expect(totalsAt).toBeGreaterThan(headerAt);
  });
});

describe('a clinic whose address runs to five lines', () => {
  const longAddress = templateOf(
    renderInvoiceHtml(longAddressInvoice(20), { omitFonts: true }),
    HEADER_TEMPLATE_ID
  );

  it('keeps the last line of the address rather than clipping it away', () => {
    /*
     * ⚠️ THE BAND IS CLIPPED, SO AN ADDRESS THAT DOES NOT FIT DOES NOT OVERFLOW
     *   — IT DISAPPEARS UNDER THE RULE THAT CLOSES THE HEADER, which reads as
     *   the rule striking through the text. A five-line address used to do
     *   exactly that.
     */
    expect(longAddress).toContain('Beside the District Civil Court');
  });

  it('wraps the address instead of printing one line per entry', () => {
    /*
     * The wrapping is what makes it fit: the left column is over 100mm wide, so
     * five postal lines become two or three wrapped ones. `white-space:
     * pre-line` would honour every newline and put the tail back outside the
     * band.
     */
    expect(longAddress).toContain(' · ');
    expect(longAddress).not.toMatch(/white-space:\s*pre-line/);
  });
});

describe('a long document', () => {
  it('emits exactly one header template however many lines it has', () => {
    /*
     * The chrome is rendered once and repeated by the printer. Emitting it per
     * page — or per line, which is the shape of mistake a table invites — would
     * multiply the embedded fonts by the page count.
     */
    const long = renderInvoiceHtml(longInvoice(80), { omitFonts: true });

    expect(long.match(new RegExp(`id="${HEADER_TEMPLATE_ID}"`, 'g'))).toHaveLength(1);
    expect(long.match(new RegExp(`id="${FOOTER_TEMPLATE_ID}"`, 'g'))).toHaveLength(1);
  });
});
