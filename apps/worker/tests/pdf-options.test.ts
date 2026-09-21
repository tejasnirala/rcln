/**
 * What the printer is asked for — the half of the repeating chrome that is ours.
 *
 * ⚠️ THIS FILE EXISTS BECAUSE NOTHING PROVED THE HEADER AND FOOTER REPEAT
 *   (KNOWN_ISSUES #6), AND IT DELIBERATELY DOES NOT PROVE THAT EITHER.
 *   Repetition on every page, and the substitution of a total page count, are
 *   properties of CHROMIUM'S printer; asserting them needs a real render and a
 *   PDF text extractor, which is a dependency this repository has not taken.
 *
 *   What IS ours is which options Chromium is handed, and that was the untested
 *   half — the one where a plausible tidy-up turns the chrome off, or turns on
 *   Chromium's own. `packages/documents/tests/chrome.test.ts` covers the other
 *   side: that the templates are emitted, sized and self-contained.
 */
import { pdfOptionsFor } from '../src/documents/pdf.renderer.js';

describe('a document that carries chrome', () => {
  it('turns the printer chrome on and hands it both templates', () => {
    const options = pdfOptionsFor({ header: '<div>head</div>', footer: '<div>foot</div>' });

    expect(options?.displayHeaderFooter).toBe(true);
    expect(options?.headerTemplate).toBe('<div>head</div>');
    expect(options?.footerTemplate).toBe('<div>foot</div>');
  });

  it('sends an EMPTY STRING for the half it does not have, never undefined', () => {
    /*
     * ⚠️ THE NASTY CASE. A template Chromium is handed as `undefined` falls back
     *   to its BUILT-IN, so a document carrying only a footer would print the
     *   page URL across the top of every sheet — on an invoice, a `localhost`
     *   address above a tax document.
     */
    const footerOnly = pdfOptionsFor({ header: '', footer: '<div>foot</div>' });
    expect(footerOnly?.displayHeaderFooter).toBe(true);
    expect(footerOnly?.headerTemplate).toBe('');

    const headerOnly = pdfOptionsFor({ header: '<div>head</div>', footer: '' });
    expect(headerOnly?.displayHeaderFooter).toBe(true);
    expect(headerOnly?.footerTemplate).toBe('');
  });
});

describe('a document that carries none', () => {
  it('does not turn the printer chrome on AT ALL', () => {
    /*
     * ⚠️ NOT `displayHeaderFooter: false` WITH EMPTY TEMPLATES, AND NOT THE FLAG
     *   WITH TWO EMPTY STRINGS EITHER — the second prints Chromium's default
     *   chrome, which is the URL and today's date. The key must be absent.
     */
    const options = pdfOptionsFor({ header: '', footer: '' });

    expect(options).not.toHaveProperty('displayHeaderFooter');
    expect(options).not.toHaveProperty('headerTemplate');
    expect(options).not.toHaveProperty('footerTemplate');
  });
});

describe('the geometry comes from the stylesheet', () => {
  it('prefers the CSS page size and reserves no margin of its own', () => {
    /*
     * The bands the chrome sits in are reserved by the `@page` margins in
     * `@rcln/documents`. A margin stated here as well would be two sources of
     * truth for one measurement, and the failure is chrome printed on top of
     * the body.
     */
    const options = pdfOptionsFor({ header: '<div>h</div>', footer: '<div>f</div>' });

    expect(options?.preferCSSPageSize).toBe(true);
    expect(options?.margin).toEqual({ top: '0', right: '0', bottom: '0', left: '0' });
  });

  it('prints backgrounds, because the tint carries meaning', () => {
    expect(pdfOptionsFor({ header: '', footer: '' })?.printBackground).toBe(true);
  });
});
