/**
 * A report as a file somebody opens in a spreadsheet.
 *
 * ⚠️ THE COLUMN LIST IS DECLARED, NEVER DERIVED FROM THE FIRST ROW. Two reasons,
 *   and both have bitten real products: a report with no rows would produce a
 *   file with no header at all, which reads as "the export is broken" rather
 *   than "there is nothing to report"; and a column order that follows whatever
 *   `Object.keys` returns changes silently when somebody reorders a mapping in a
 *   service, which breaks every saved spreadsheet formula pointing at column F.
 *   A CSV's columns are a contract with the file, and this is where it is
 *   written down.
 *
 * ⚠️ AND MONEY IS EXPORTED IN MINOR UNITS, EXACTLY AS THE JSON CARRIES IT. A
 *   file that helpfully divided by 100 would be right in India, wrong in Japan,
 *   and — worse — would disagree with the API for the same figure. The header
 *   says `_minor` on every such column so the person reading it knows.
 */

/**
 * One field escaped the way RFC 4180 wants it.
 *
 * ⚠️ THE LEADING APOSTROPHE ON `=`, `+`, `-` AND `@` IS A SECURITY CONTROL, NOT
 *   A FORMATTING PREFERENCE. A cell beginning with one of those is a FORMULA to
 *   Excel, LibreOffice and Sheets — so a lot number keyed as `=cmd|...` at a
 *   goods receipt becomes code that runs on the machine of whoever opens the
 *   export. Every string that reaches a cell here has been through a clinic's
 *   own text fields (a product name, a quarantine reason, a supplier's name),
 *   and none of them is validated against this. The quote is what makes it text.
 */
function cell(value: unknown): string {
  if (value === null || value === undefined) return '';
  const text = String(value);
  const guarded = /^[=+\-@\t\r]/.test(text) ? `'${text}` : text;
  return /[",\n\r]/.test(guarded) ? `"${guarded.replaceAll('"', '""')}"` : guarded;
}

/** A column: the heading a person reads, and the field it comes from. */
export interface CsvColumn<T> {
  header: string;
  field: keyof T & string;
}

export function toCsv<T extends Record<string, unknown>>(
  columns: readonly CsvColumn<T>[],
  rows: readonly T[],
  truncated: boolean
): string {
  const lines = [columns.map((column) => cell(column.header)).join(',')];
  for (const row of rows) {
    lines.push(columns.map((column) => cell(row[column.field])).join(','));
  }
  /*
   * ⚠️ THE TRUNCATION NOTICE IS A ROW IN THE FILE AND NOT ONLY A HEADER. A
   *   response header is invisible to the person who double-clicks the download,
   *   and an export that quietly stops at five thousand rows is a file that
   *   looks complete and is not.
   */
  if (truncated) {
    lines.push('');
    lines.push(cell(`# Truncated at ${rows.length} rows. Narrow the filters and export again.`));
  }
  return `${lines.join('\r\n')}\r\n`;
}

/** `stock-valuation-2026-08-25.csv` — a name that sorts and says what it is. */
export function csvFilename(key: string, window: { from: string; to: string } | null): string {
  const suffix = window ? `${window.from}_${window.to}` : new Date().toISOString().slice(0, 10);
  return `${key}-${suffix}.csv`;
}
