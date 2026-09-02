/**
 * The barcode decoder (PI-23).
 *
 * ⚠️ THIS SUITE IS THE PHASE'S SAFETY NET, AND IT IS A UNIT SUITE ON PURPOSE.
 *   Every defect this file pins produces a plausible, well-formed, WRONG answer:
 *   a lot number that is a prefix of the real one, an expiry a month early, a
 *   product that resolves to nothing because the catalogue holds thirteen digits
 *   and the pack carries fourteen. None of them throws, none of them logs, and
 *   an integration test against a seeded clinic would pass through every one of
 *   them because a demo catalogue has no collisions and its dates are all in the
 *   2020s.
 *
 * The payloads below are real GS1 shapes. `08901234567890` is a valid GTIN — its
 * check digit is computed, not invented — and `890` is India's GS1 prefix, which
 * is the right country for the clinic the rest of this repository describes.
 *
 * NO PHI. A barcode names a box.
 */
import {
  decodeGs1Date,
  decodeScan,
  gtinVariants,
  hasValidCheckDigit,
  normaliseGtin,
} from '@rcln/inventory';

/** ASCII 29. FNC1 on the wire; written as an escape so it is visible in review. */
const GS = '\u001D';

/** A fixed "now", so the century window is asserted rather than observed. */
const NOW = new Date('2026-03-17T00:00:00.000Z');

const GTIN13 = '8901234567890';
const GTIN14 = '08901234567890';

describe('the mod-10 check digit', () => {
  it('accepts a real GTIN-13 and its zero-padded GTIN-14', () => {
    expect(hasValidCheckDigit(GTIN13)).toBe(true);
    expect(hasValidCheckDigit(GTIN14)).toBe(true);
  });

  it('rejects the same digits with the check digit changed', () => {
    expect(hasValidCheckDigit('8901234567891')).toBe(false);
  });

  /*
   * ⚠️ THE WEIGHTS RUN FROM THE RIGHT, SO THEY DEPEND ON THE LENGTH. Written as a
   *   fixed 3,1 alternation from the LEFT, GTIN-12 and GTIN-13 come out opposite
   *   ways round — and a UPC-A would then fail its own check digit while an
   *   EAN-13 passed, which reads as "our scanner does not like American stock".
   */
  it('gets a UPC-A right as well, which a left-to-right weighting would not', () => {
    expect(hasValidCheckDigit('036000291452')).toBe(true);
  });

  it('refuses anything that is not digits', () => {
    expect(hasValidCheckDigit('890123456789X')).toBe(false);
    expect(hasValidCheckDigit('')).toBe(false);
  });
});

describe('GTIN normalisation', () => {
  it('pads every defined length to fourteen', () => {
    expect(normaliseGtin('12345670')).toBe('00000012345670');
    expect(normaliseGtin(GTIN13)).toBe(GTIN14);
    expect(normaliseGtin(GTIN14)).toBe(GTIN14);
  });

  it('refuses a length GS1 does not define', () => {
    // Nine and eleven digits are not GTINs, whatever else they might be.
    expect(normaliseGtin('123456789')).toBeNull();
    expect(normaliseGtin('12345678901')).toBeNull();
  });

  /*
   * ⚠️ THE CATALOGUE HOLDS WHATEVER SOMEBODY TYPED AND THE PACK CARRIES FOURTEEN
   *   DIGITS. Searching one form alone is a barcode that resolves nothing, and it
   *   is reported months later as "the scanner does not work for this product" by
   *   somebody who cannot reproduce it on any other product.
   */
  it('offers every form a catalogue might legitimately hold', () => {
    expect(gtinVariants(GTIN14)).toEqual([GTIN14, GTIN13]);
  });

  /*
   * ⚠️ AND IT STOPS AT THE ZEROS. A GTIN-14 whose leading digit is a real
   *   packaging indicator is a DIFFERENT trade item from the GTIN-13 inside it —
   *   a case of twelve, not one box. Stripping it would resolve a case of stock
   *   to the single unit and receive twelve times too little.
   */
  it('does not strip a packaging indicator', () => {
    expect(gtinVariants('10012345678902')).toEqual(['10012345678902']);
  });
});

describe('the GS1 date', () => {
  const IN_2026 = new Date('2026-03-17T00:00:00.000Z');

  it('reads an ordinary expiry', () => {
    expect(decodeGs1Date('270831', IN_2026)).toBe('2027-08-31');
  });

  /*
   * ⚠️ DAY 00 IS THE END OF THE MONTH, AND MOST CARTONS USE IT. A pack printed
   *   `EXP 01/2027` encodes `270100`. Reading it as the 1st expires a whole
   *   month of stock early; refusing it outright refuses a correctly printed
   *   pack.
   */
  it('reads day 00 as the last day of that month', () => {
    expect(decodeGs1Date('270100', IN_2026)).toBe('2027-01-31');
    expect(decodeGs1Date('280200', IN_2026)).toBe('2028-02-29');
    expect(decodeGs1Date('290200', IN_2026)).toBe('2029-02-28');
  });

  /*
   * ⚠️ THE CENTURY WINDOW. GS1 says 49 years back, 50 forward. A naive
   *   `2000 + yy` works perfectly until 2050 and then dates every pack fifty
   *   years in the past — every lot in the country expired, on one morning.
   */
  it('puts a distant year in the past, not fifty years ahead', () => {
    expect(decodeGs1Date('770101', IN_2026)).toBe('1977-01-01');
  });

  it('still reads a far-future expiry as the future', () => {
    expect(decodeGs1Date('750101', IN_2026)).toBe('2075-01-01');
  });

  it('keeps the window moving with the clock', () => {
    // The same six digits, read in 2074: now inside the forward half.
    expect(decodeGs1Date('770101', new Date('2074-01-01T00:00:00.000Z'))).toBe('2077-01-01');
  });

  it('refuses a date that is not a date', () => {
    expect(decodeGs1Date('271301', IN_2026)).toBeNull();
    expect(decodeGs1Date('270231', IN_2026)).toBeNull();
    expect(decodeGs1Date('27013', IN_2026)).toBeNull();
  });
});

describe('a bare barcode', () => {
  it('reads an EAN-13 off the back of a box', () => {
    const scan = decodeScan(GTIN13);
    expect(scan.format).toBe('GTIN');
    expect(scan.gtin).toBe(GTIN14);
    expect(scan.warnings).toEqual([]);
  });

  /*
   * ⚠️ TRIED BEFORE THE ELEMENT-STRING PARSE, BECAUSE `01` IS A VALID AI. A
   *   fourteen-digit GTIN beginning `01` would otherwise be read as AI 01
   *   carrying a twelve-digit, truncated value.
   */
  it('is not mistaken for AI 01 with a short value', () => {
    const scan = decodeScan('01234567890128');
    expect(scan.format).toBe('GTIN');
    expect(scan.gtin).toBe('01234567890128');
  });

  it('reports a mis-read rather than resolving it', () => {
    expect(decodeScan('8901234567891').warnings).toContain('CHECK_DIGIT_FAILED');
  });

  it('hands back anything else untouched, as a code of the clinic’s own', () => {
    const scan = decodeScan('MED-AMOX-500');
    expect(scan.format).toBe('PLAIN');
    expect(scan.raw).toBe('MED-AMOX-500');
    expect(scan.gtin).toBeNull();
  });

  it('is empty for an empty scan rather than throwing', () => {
    expect(decodeScan('   ').format).toBe('PLAIN');
    expect(decodeScan('   ').elements).toEqual([]);
  });
});

describe('a GS1 element string', () => {
  it('takes a DataMatrix apart into product, expiry and lot', () => {
    const scan = decodeScan(`01${GTIN14}17270831${GS}10AMX24K118`, NOW);
    expect(scan.format).toBe('GS1');
    expect(scan.gtin).toBe(GTIN14);
    expect(scan.expiresOn).toBe('2027-08-31');
    expect(scan.lotNumber).toBe('AMX24K118');
    expect(scan.unparsed).toBeNull();
    expect(scan.warnings).toEqual([]);
  });

  it('reads the bracketed form printed underneath it', () => {
    const scan = decodeScan(`(01)${GTIN14}(17)270831(10)AMX24K118`, NOW);
    expect(scan.gtin).toBe(GTIN14);
    expect(scan.lotNumber).toBe('AMX24K118');
    expect(scan.expiresOn).toBe('2027-08-31');
  });

  it('strips the reader’s symbology prefix', () => {
    expect(decodeScan(`]d201${GTIN14}`).gtin).toBe(GTIN14);
  });

  it('accepts a printable stand-in for FNC1, which wedge readers emit', () => {
    const scan = decodeScan(`01${GTIN14}10AB12<GS>21SN7742`, NOW);
    expect(scan.lotNumber).toBe('AB12');
    expect(scan.serialNumber).toBe('SN7742');
  });

  it('reads a lot, a serial and a count together', () => {
    const scan = decodeScan(`01${GTIN14}${GS}21SN7742${GS}3012`, NOW);
    expect(scan.serialNumber).toBe('SN7742');
    expect(scan.quantity).toBe('12');
  });

  /*
   * ⚠️ A FIXED-LENGTH AI IS NOT FOLLOWED BY FNC1, AND EVERY ONE OF THEM SITS
   *   FLUSH AGAINST THE NEXT. This is the whole reason the AI table has to carry
   *   lengths at all: `17270831` and `10AMX…` run together with nothing between
   *   them.
   */
  it('reads fixed-length elements that touch each other', () => {
    const scan = decodeScan(`01${GTIN14}112608011727083110AB`, NOW);
    expect(scan.producedOn).toBe('2026-08-01');
    expect(scan.expiresOn).toBe('2027-08-31');
    expect(scan.lotNumber).toBe('AB');
  });

  /*
   * ⚠️ AN UNKNOWN AI STOPS THE PARSE. There is no way to know how many characters
   *   it consumes, so skipping it resumes reading in the MIDDLE of somebody's
   *   data and produces a lot number that looks entirely plausible and is not the
   *   one on the box. The remainder is handed back verbatim instead.
   */
  it('stops at an identifier it does not know, and says what it stopped at', () => {
    const scan = decodeScan(`01${GTIN14}9912345`);
    expect(scan.gtin).toBe(GTIN14);
    expect(scan.unparsed).toBe('9912345');
    expect(scan.warnings).toContain('UNKNOWN_APPLICATION_IDENTIFIER');
  });

  /*
   * ⚠️ WITHOUT FNC1 A VARIABLE-LENGTH FIELD EATS WHATEVER FOLLOWS, AND THE
   *   DECODER SAYS SO RATHER THAN TRUNCATING AT THE AI'S MAXIMUM. A lot cut at
   *   twenty characters is a plausible PREFIX of the real one that matches
   *   nothing and looks correct on screen; a lot that visibly swallowed a serial
   *   is wrong to anybody holding the box.
   */
  it('warns when a lot runs past its own maximum with no separator to end it', () => {
    // Twenty characters is the whole of AI 10, so twenty-eight of them plus a
    // serial is a field that has certainly eaten the one after it.
    const scan = decodeScan(`01${GTIN14}10AB12345678901234567890AB21SN7742`);
    expect(scan.warnings).toContain('AMBIGUOUS_VARIABLE_LENGTH');
    expect(scan.lotNumber).toBe('AB12345678901234567890AB21SN7742');
  });

  /*
   * ⚠️ AND THE ORDINARY SHAPE IS NOT WARNED ABOUT. `01…17…10LOT` with the lot
   *   last and no FNC1 is what most medicine DataMatrix payloads look like;
   *   warning on it would make the warning meaningless within a day.
   */
  it('says nothing about a lot that simply ends the payload', () => {
    expect(decodeScan(`01${GTIN14}17270831` + `10AMX24K118`, NOW).warnings).toEqual([]);
  });

  it('reports a bad check digit inside an element string', () => {
    expect(decodeScan(`0108901234567891${GS}17270831`).warnings).toContain('CHECK_DIGIT_FAILED');
  });

  it('reports an impossible date rather than silently dropping it', () => {
    const scan = decodeScan(`01${GTIN14}17271301`);
    expect(scan.expiresOn).toBeNull();
    expect(scan.warnings).toContain('INVALID_DATE');
  });

  /*
   * A national reimbursement number is the ONLY code on the pack in several
   * countries, and it is a product identifier in its own right — kept as an
   * element so the resolver can look it up country-qualified.
   */
  it('keeps a national healthcare reimbursement number', () => {
    const scan = decodeScan(`01${GTIN14}${GS}71012345678`);
    expect(scan.elements.map((e) => e.ai)).toContain('710');
  });

  it('falls back to a best-before date when there is no expiry', () => {
    expect(decodeScan(`01${GTIN14}15270831`, NOW).expiresOn).toBe('2027-08-31');
  });
});
