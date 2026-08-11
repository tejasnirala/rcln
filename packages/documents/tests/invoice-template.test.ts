/**
 * What the invoice must say, asserted on the rendered HTML.
 *
 * ⚠️ THESE ARE NOT SNAPSHOT TESTS, DELIBERATELY. A snapshot of a document this
 *   size passes for ever and then fails entirely, and the reviewer's only
 *   available response to a 400-line diff is to accept it. What is asserted here
 *   is the handful of claims that make the document CORRECT rather than merely
 *   unchanged — what it calls itself, that ₹ is present, that the totals on the
 *   page are the totals in the data — because those are the ones that can be
 *   broken by a plausible-looking edit.
 *
 * ⚠️ AND THEY RUN WITHOUT THE FONTS. `omitFonts` keeps 141KB of base64 out of
 *   every failure message. The one thing that genuinely needs the real font
 *   block has its own test below.
 */

import { renderInvoiceHtml } from '../src/invoice/render.js';
import { documentTitle } from '../src/invoice/document.js';
import { fontFaceCss } from '../src/fonts.js';
import {
  indianInvoice,
  unregisteredInvoice,
  yenInvoice,
  longInvoice,
} from '../src/invoice/samples.js';

const render = (data: Parameters<typeof renderInvoiceHtml>[0]): string =>
  renderInvoiceHtml(data, { omitFonts: true });

describe('what the document calls itself', () => {
  it('is a tax invoice for a registered Indian clinic charging tax', () => {
    expect(documentTitle('IN', 'STANDARD')).toBe('Tax Invoice');
  });

  /*
   * ⚠️ THE CASE THAT MATTERS. Under GST an exempt supply is billed on a Bill of
   *   Supply, and a registered clinic that heads it "Tax Invoice" has issued the
   *   wrong document — for the single most common line an Indian clinic bills,
   *   because healthcare services are exempt.
   */
  it('is a bill of supply for an exempt Indian supply', () => {
    expect(documentTitle('IN', 'EXEMPT')).toBe('Bill of Supply');
  });

  it('is a plain invoice when the clinic holds no registration', () => {
    expect(documentTitle('IN', 'NOT_REGISTERED')).toBe('Invoice');
    expect(render(unregisteredInvoice)).toContain('>Invoice<');
    expect(render(unregisteredInvoice)).not.toContain('Tax Invoice');
  });

  /*
   * "Tax invoice" is the right heading in Australia and the wrong one in
   * Ireland. Phase 2b's whole lesson was that a document can be arithmetically
   * perfect and compliant nowhere.
   */
  it('follows the country, not the tax', () => {
    expect(documentTitle('AU', 'STANDARD')).toBe('Tax Invoice');
    expect(documentTitle('IE', 'STANDARD')).toBe('Invoice');
    expect(documentTitle('GB', 'STANDARD')).toBe('Invoice');
  });
});

describe('the money on the page is the money in the data', () => {
  it('prints the grand total exactly once, from the snapshot', () => {
    const html = render(indianInvoice);
    // 71500 minor units, grouped Indian-style at two decimal places.
    expect(html).toContain('715.00');
  });

  it('groups Indian amounts in lakhs', () => {
    const big = {
      ...indianInvoice,
      totals: { ...indianInvoice.totals, grandTotalMinor: 1234567800 },
    };
    // 12,345,678.00 in en-GB; 1,23,45,678.00 in en-IN. The clinic is Indian.
    expect(render(big)).toContain('1,23,45,678.00');
  });

  it('keeps the western grouping outside India', () => {
    const irish = { ...indianInvoice, countryCode: 'IE', currency: 'EUR' };
    const html = render({
      ...irish,
      totals: { ...irish.totals, grandTotalMinor: 1234567800 },
    });
    expect(html).toContain('12,345,678.00');
  });

  /*
   * ⚠️ ¥ HAS NO MINOR UNIT. A template hard-coded to two decimal places prints a
   *   ¥5,500 bill as ¥55.00 — a hundredfold error that looks like a plausible
   *   price. `minorUnitExponent` is asked rather than assumed.
   */
  it('prints a zero-decimal currency without decimals', () => {
    const html = render(yenInvoice);
    expect(html).toContain('5,500');
    expect(html).not.toContain('55.00');
  });
});

describe('tax presentation', () => {
  it('prints both halves of an Indian split as their own rows', () => {
    const html = render(indianInvoice);
    expect(html).toContain('CGST');
    expect(html).toContain('SGST');
    // Owed to two different governments — the jurisdiction is printed, not implied.
    expect(html).toContain('IN-KA');
  });

  it('prints a rate that is not a whole percent', () => {
    // Quebec's QST is 9.975%. A whole-number percent column prints 10%.
    const quebec = {
      ...indianInvoice,
      taxSummary: [
        {
          name: 'QST',
          jurisdiction: 'CA-QC',
          rateBps: 997.5,
          taxableAmountMinor: 10000,
          taxAmountMinor: 998,
        },
      ],
    };
    expect(render(quebec)).toContain('9.975%');
  });

  /*
   * A document that charged nothing has to say why. "No tax" with no reason
   * reads as an omission, and the reason is a legal position an auditor needs.
   */
  it('explains why no tax was charged', () => {
    expect(render(unregisteredInvoice)).toContain('not registered for tax');
  });
});

describe('the things that must never appear', () => {
  it('puts the invoice number in the title and never the patient', () => {
    const html = render(indianInvoice);
    expect(html).toContain(`<title>${indianInvoice.invoiceNumber}</title>`);
    /*
     * The title becomes the PDF's document title, the browser tab and the
     * default filename of a "save as" — three places a patient's name would
     * travel to that nobody thinks of as storage.
     */
    const title = /<title>(.*)<\/title>/.exec(html)?.[1] ?? '';
    expect(title).not.toContain(indianInvoice.customer.name);
  });

  /*
   * ⚠️ THE MEASURED CLAIM OF THE WHOLE DESIGN. One external request — a
   *   stylesheet, a font, an image — and the preview and the print stop being
   *   the same document: `page.pdf()` snapshots whatever is painted, and a font
   *   still in flight is a page set in the fallback. It fails silently, so it is
   *   asserted rather than reviewed.
   */
  it('makes no external request of any kind', () => {
    const html = renderInvoiceHtml(indianInvoice);
    expect(html).not.toMatch(/<link\b/i);
    expect(html).not.toMatch(/<script\b/i);
    expect(html).not.toMatch(/<img\b/i);
    expect(html).not.toMatch(/https?:\/\//);
    // The only URLs are the inlined typefaces.
    const urls = [...html.matchAll(/url\(([^)]*)\)/g)].map((match) => match[1] ?? '');
    expect(urls.length).toBeGreaterThan(0);
    expect(urls.every((url) => url.startsWith('data:'))).toBe(true);
  });

  it('escapes the one value React does not render', () => {
    const hostile = { ...indianInvoice, invoiceNumber: 'INV-<script>-1' };
    const html = renderInvoiceHtml(hostile, { omitFonts: true });
    expect(html).toContain('INV-&lt;script&gt;-1');
    expect(html).not.toContain('<script>');
  });
});

describe('the typefaces', () => {
  /*
   * ⚠️ THE RUPEE SIGN IS U+20B9, WHICH IS NOT IN THE `latin` SUBSET. If the
   *   `latin-ext` face or its unicode-range goes missing, ₹ renders as a
   *   missing-glyph box on every Indian invoice — and nothing throws. This
   *   asserts the range that carries it is declared.
   */
  it('declares the range that carries ₹', () => {
    expect(fontFaceCss()).toContain('U+20AD-20C0');
  });

  it('inlines every face as data, never as a URL', () => {
    const faces = [...fontFaceCss().matchAll(/src: url\(([^)]*)\)/g)].map((m) => m[1] ?? '');
    expect(faces.length).toBe(6);
    expect(faces.every((url) => url.startsWith('data:font/woff2;base64,'))).toBe(true);
  });

  it('actually prints ₹ on an Indian invoice', () => {
    expect(render(indianInvoice)).toContain('₹');
  });
});

describe('pagination', () => {
  /*
   * A real `<thead>` is what makes Chromium repeat the column labels on every
   * printed page. A three-page pharmacy bill whose columns are labelled only on
   * page one is unreadable, and the alternative is a pagination routine of our
   * own.
   */
  it('uses a real table header so the columns repeat across pages', () => {
    const html = render(longInvoice());
    expect(html).toContain('<thead>');
    expect(html).toContain('HSN/SAC');
  });

  it('renders every line it is given', () => {
    const html = render(longInvoice(45));
    expect(html).toContain('Consumable item 45');
  });
});

describe('void', () => {
  it('marks a voided invoice on its face', () => {
    const html = render({ ...indianInvoice, status: 'VOID' });
    expect(html).toContain('<div class="void-mark">VOID</div>');
  });

  /*
   * The class is always in the stylesheet; what must be absent is the ELEMENT.
   * Asserting on the class name passed while the mark was rendered on every
   * invoice, which is the wrong direction for this particular mistake.
   */
  it('leaves an issued invoice unmarked', () => {
    expect(render(indianInvoice)).not.toContain('<div class="void-mark">');
  });
});
