/**
 * The CSV a report becomes, and the arithmetic around its edges (PI-22).
 *
 * ⚠️ THE FORMULA-INJECTION CASE IS THE ONE THAT MATTERS AND THE ONE THAT LOOKS
 *   LIKE PEDANTRY. Every string in these files came out of a clinic's own text
 *   fields — a product name, a lot number keyed at a goods receipt, a quarantine
 *   reason — and none of them is validated against starting with `=`. A cell
 *   beginning with `=`, `+`, `-` or `@` is a FORMULA to Excel, LibreOffice and
 *   Sheets, so `=cmd|'/c calc'!A1` typed into a lot number becomes code on the
 *   machine of whoever opens the export. Escaping is not enough; the leading
 *   quote is what makes it text.
 */
import { csvFilename, toCsv } from '../../src/services/reports/csv.js';
import { foldTotals, minor, ratio } from '../../src/services/reports/shared.js';

interface Row extends Record<string, unknown> {
  name: string;
  value: number | null;
}

const COLUMNS = [
  { header: 'Name', field: 'name' as const },
  { header: 'Value_minor', field: 'value' as const },
];

describe('toCsv', () => {
  it('writes the header even when there are no rows', () => {
    /*
     * A file with no header reads as "the export is broken" rather than "there
     * is nothing to report", which is the wrong conclusion for somebody to
     * reach about their own stock.
     */
    expect(toCsv<Row>(COLUMNS, [], false)).toBe('Name,Value_minor\r\n');
  });

  it('quotes a field containing a comma, a quote or a newline', () => {
    const csv = toCsv<Row>(COLUMNS, [{ name: 'Gloves, sterile "large"', value: 100 }], false);
    expect(csv).toContain('"Gloves, sterile ""large"""');
  });

  it('renders a null as an empty cell, never as "null"', () => {
    const csv = toCsv<Row>(COLUMNS, [{ name: 'Uncosted', value: null }], false);
    expect(csv).toContain('Uncosted,\r\n');
  });

  it.each(['=cmd|"/c calc"!A1', '+1+1', '-2+3', '@SUM(A1:A9)'])(
    'defuses %s so a spreadsheet reads it as text',
    (dangerous) => {
      const csv = toCsv<Row>(COLUMNS, [{ name: dangerous, value: 1 }], false);
      const cell = csv.split('\r\n')[1] ?? '';
      /*
       * The apostrophe comes FIRST, and the RFC 4180 quoting — which a cell
       * containing a `"` or a `,` also needs — wraps it. Asserting the whole
       * cell rather than a substring is what proves the two are in that order:
       * `"'=..."` is inert and `'"=..."` is not.
       */
      expect(cell).toMatch(/^("?)'/);
      expect(cell.startsWith('=')).toBe(false);
      expect(cell.startsWith('@')).toBe(false);
      expect(cell.startsWith('+')).toBe(false);
      expect(cell.startsWith('-')).toBe(false);
    }
  );

  it('says so in the file when the export hit its cap', () => {
    const csv = toCsv<Row>(COLUMNS, [{ name: 'A', value: 1 }], true);
    expect(csv).toContain('# Truncated at 1 rows.');
  });

  it('names a point-in-time file by the day and a dated one by its window', () => {
    expect(csvFilename('inventory-valuation', null)).toMatch(
      /^inventory-valuation-\d{4}-\d{2}-\d{2}\.csv$/
    );
    expect(csvFilename('dispensing', { from: '2026-03-01', to: '2026-03-31' })).toBe(
      'dispensing-2026-03-01_2026-03-31.csv'
    );
  });
});

describe('foldTotals', () => {
  it('keeps two currencies apart rather than adding them', () => {
    const totals = foldTotals([
      { currency: 'INR', valueMinor: 1000, quantityBase: '10' },
      { currency: 'USD', valueMinor: 400, quantityBase: '4' },
      { currency: 'INR', valueMinor: 500, quantityBase: '5' },
    ]);

    expect(totals).toHaveLength(2);
    expect(totals.find((t) => t.currency === 'INR')?.valueMinor).toBe(1500);
    expect(totals.find((t) => t.currency === 'INR')?.quantityBase).toBe('15');
    expect(totals.find((t) => t.currency === 'USD')?.valueMinor).toBe(400);
  });

  /**
   * ⚠️ UNVALUED QUANTITY IS NEVER FOLDED INTO A MONEY TOTAL. The clinic holds it
   *   whichever set of books is being read, so it appears on every currency
   *   entry — and never as a zero-valued line that inflates `lineCount`.
   */
  it('carries the quantity it could not value beside the money', () => {
    const totals = foldTotals([
      { currency: 'INR', valueMinor: 1000, quantityBase: '10' },
      { currency: null, valueMinor: null, quantityBase: '7' },
    ]);

    expect(totals).toHaveLength(1);
    expect(totals[0]?.valueMinor).toBe(1000);
    expect(totals[0]?.lineCount).toBe(1);
    expect(totals[0]?.unvaluedQuantityBase).toBe('7');
  });

  it('still reports a quantity when nothing in the report could be valued at all', () => {
    const totals = foldTotals([{ currency: null, valueMinor: null, quantityBase: '7' }]);
    expect(totals).toHaveLength(1);
    expect(totals[0]?.currency).toBe('XXX');
    expect(totals[0]?.unvaluedQuantityBase).toBe('7');
  });
});

describe('ratio', () => {
  /**
   * ⚠️ NULL, NOT ZERO, WITH NOTHING TO DIVIDE BY. "This supplier filled 0% of
   *   what we ordered" and "we ordered nothing from this supplier" are different
   *   sentences, and rendering both as `0.0000` invites somebody to terminate a
   *   contract over an empty month.
   */
  it('answers null when the denominator is zero', () => {
    expect(ratio(0, 0)).toBeNull();
    expect(ratio(5, 0)).toBeNull();
  });

  it('answers four decimal places otherwise', () => {
    expect(ratio(982, 1000)).toBe('0.9820');
  });
});

describe('minor', () => {
  it('parses the text money arrives as, and keeps null as null', () => {
    expect(minor('24000')).toBe(24000);
    expect(minor(null)).toBeNull();
    expect(minor(undefined)).toBeNull();
  });

  it('rounds rather than truncating', () => {
    expect(minor('2400.6')).toBe(2401);
  });
});
