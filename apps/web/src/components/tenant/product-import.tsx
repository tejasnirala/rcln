'use client';

import { useState, useTransition } from 'react';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import {
  importProductsAction,
  type ProductImportState,
} from '@/app/(tenant)/t/[slug]/(app)/products/actions';

/**
 * Import a catalogue from a spreadsheet.
 *
 * ⚠️ THIS SCREEN EXISTS BECAUSE THE PLATFORM SHIPS NO PRODUCT DATA AND HAS NO
 *   SOURCE FOR ANY (KNOWN_ISSUES KI-9). Setting up meant typing a whole
 *   formulary into a form built for adding one product — a four-hundred-row job
 *   that decides whether a clinic ever finishes onboarding.
 *
 * ⚠️ CHECK BEFORE IMPORT, AND THE SCREEN INSISTS ON IT. The first press is
 *   always a dry run: the API returns exactly what a real import would and
 *   writes nothing, so somebody sees all their mistakes at once instead of
 *   fixing row 7, re-uploading and discovering row 12. Import only unlocks once
 *   a check comes back with no failures.
 *
 * ⚠️ THE FILE IS PARSED HERE, IN THE BROWSER, AND POSTED AS JSON. The API's
 *   contract is the ROWS, not a file — which keeps multipart handling, a size
 *   limit and a temp file out of the server, and makes the same import runnable
 *   from a script by anybody who would rather not use a screen.
 */

/** The columns, in the order the template writes them. */
const COLUMNS = [
  'code',
  'name',
  'type',
  'baseUnitCode',
  'brandName',
  'genericName',
  'categoryCode',
  'manufacturerCode',
  'barcode',
  'trackingMode',
  'isExpiryControlled',
  'defaultShelfLifeDays',
  'reorderLevelBase',
  'reorderQuantityBase',
  'isStockItem',
] as const;

/**
 * A CSV reader that handles quoted fields, and nothing more.
 *
 * ⚠️ WRITTEN RATHER THAN INSTALLED, BECAUSE THE ALTERNATIVE IS A DEPENDENCY FOR
 *   FORTY LINES. What it must get right is the quoted field — a product called
 *   `Paracetamol 650mg, film-coated` is the ordinary case, not the edge one, and
 *   splitting on commas would silently shift every column after it. Doubled
 *   quotes inside a quoted field are the escape, per RFC 4180.
 */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];

    if (quoted) {
      if (char === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          quoted = false;
        }
      } else {
        field += char;
      }
      continue;
    }

    if (char === '"') {
      quoted = true;
    } else if (char === ',') {
      row.push(field);
      field = '';
    } else if (char === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else if (char !== '\r') {
      field += char;
    }
  }

  if (field !== '' || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  /* A trailing newline is normal and must not become a row of empty strings. */
  return rows.filter((cells) => cells.some((cell) => cell.trim() !== ''));
}

/** A cell the contract wants as a boolean, written the way a spreadsheet writes one. */
function asBoolean(value: string | undefined, fallback: boolean): boolean {
  const cell = value?.trim().toLowerCase();
  if (cell === undefined || cell === '') return fallback;
  return cell === 'true' || cell === 'yes' || cell === 'y' || cell === '1';
}

function asNumber(value: string | undefined): number | undefined {
  const cell = value?.trim();
  if (cell === undefined || cell === '') return undefined;
  const parsed = Number(cell);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function asText(value: string | undefined): string | undefined {
  const cell = value?.trim();
  return cell === undefined || cell === '' ? undefined : cell;
}

/** One spreadsheet line, in the shape `productImportRow` expects. */
function toRow(header: string[], cells: string[]): Record<string, unknown> {
  const at = (name: string): string | undefined => {
    const index = header.indexOf(name);
    return index === -1 ? undefined : cells[index];
  };

  return {
    code: at('code')?.trim() ?? '',
    name: at('name')?.trim() ?? '',
    type: at('type')?.trim().toUpperCase() ?? 'MEDICINE',
    baseUnitCode: at('baseUnitCode')?.trim() ?? '',
    ...(asText(at('brandName')) ? { brandName: asText(at('brandName')) } : {}),
    ...(asText(at('genericName')) ? { genericName: asText(at('genericName')) } : {}),
    ...(asText(at('categoryCode')) ? { categoryCode: asText(at('categoryCode')) } : {}),
    ...(asText(at('manufacturerCode')) ? { manufacturerCode: asText(at('manufacturerCode')) } : {}),
    ...(asText(at('barcode')) ? { barcode: asText(at('barcode')) } : {}),
    trackingMode: asText(at('trackingMode'))?.toUpperCase() ?? 'NONE',
    isExpiryControlled: asBoolean(at('isExpiryControlled'), false),
    ...(asNumber(at('defaultShelfLifeDays')) === undefined
      ? {}
      : { defaultShelfLifeDays: asNumber(at('defaultShelfLifeDays')) }),
    ...(asText(at('reorderLevelBase')) ? { reorderLevelBase: asText(at('reorderLevelBase')) } : {}),
    ...(asText(at('reorderQuantityBase'))
      ? { reorderQuantityBase: asText(at('reorderQuantityBase')) }
      : {}),
    isStockItem: asBoolean(at('isStockItem'), true),
  };
}

const IDLE: ProductImportState = { status: 'idle' };

export function ProductImport({ slug }: { slug: string }) {
  const [rows, setRows] = useState<Record<string, unknown>[]>([]);
  const [fileName, setFileName] = useState('');
  const [readError, setReadError] = useState<string | null>(null);
  const [state, setState] = useState<ProductImportState>(IDLE);
  /* ⚠️ Import stays locked until a CHECK comes back clean — see the header. */
  const [checked, setChecked] = useState(false);
  const [pending, startTransition] = useTransition();

  const read = async (file: File): Promise<void> => {
    setState(IDLE);
    setChecked(false);
    setReadError(null);

    const table = parseCsv(await file.text());
    const header = table[0]?.map((cell) => cell.trim());
    if (!header || table.length < 2) {
      setRows([]);
      setFileName(file.name);
      setReadError('That file has a header row and nothing else in it.');
      return;
    }
    if (!header.includes('code') || !header.includes('name') || !header.includes('baseUnitCode')) {
      setRows([]);
      setFileName(file.name);
      setReadError(
        'That file is missing a required column. It needs at least code, name and baseUnitCode — download the template below.'
      );
      return;
    }

    setRows(table.slice(1).map((cells) => toRow(header, cells)));
    setFileName(file.name);
  };

  const run = (dryRun: boolean): void => {
    startTransition(async () => {
      const next = await importProductsAction(slug, rows, dryRun);
      setState(next);
      setChecked(next.status === 'done' && next.result.dryRun && next.result.failed === 0);
    });
  };

  const result = state.status === 'done' ? state.result : null;
  const problems = result?.results.filter((row) => row.outcome === 'FAILED') ?? [];

  return (
    <div className="space-y-6">
      <section className="border-rule bg-card space-y-4 rounded-md border p-4">
        <div>
          <label htmlFor="catalogue-file" className="text-ink block text-sm font-medium">
            The spreadsheet
          </label>
          <p className="text-muted mt-1 text-[0.8125rem]">
            A CSV with a header row. Codes, not ids — the unit, category and manufacturer are named
            by their own codes.
          </p>
          <input
            id="catalogue-file"
            type="file"
            accept=".csv,text/csv"
            className="text-ink mt-2 block w-full text-[0.875rem]"
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) void read(file);
            }}
          />
        </div>

        {readError ? <Alert tone="error">{readError}</Alert> : null}

        {rows.length > 0 ? (
          <p className="text-muted text-[0.875rem]">
            <span className="text-ink font-medium">{fileName}</span> — {rows.length}{' '}
            {rows.length === 1 ? 'row' : 'rows'} ready to check.
          </p>
        ) : null}

        <div className="flex flex-wrap gap-3">
          <Button
            type="button"
            variant="secondary"
            disabled={rows.length === 0 || pending}
            onClick={() => run(true)}
          >
            {pending ? 'Working…' : 'Check the file'}
          </Button>
          <Button type="button" disabled={!checked || pending} onClick={() => run(false)}>
            Import
          </Button>
        </div>
        {rows.length > 0 && !checked ? (
          <p className="text-muted text-[0.8125rem]">
            Check the file first. Nothing is written until it comes back with no problems.
          </p>
        ) : null}
      </section>

      {state.status === 'error' ? <Alert tone="error">{state.message}</Alert> : null}

      {result ? (
        <section className="space-y-3">
          {result.failed > 0 ? (
            <Alert tone="error">
              {result.failed} {result.failed === 1 ? 'row has' : 'rows have'} a problem, so nothing
              was written. Fix the file and check it again.
            </Alert>
          ) : result.dryRun ? (
            <Alert tone="success">
              Everything checks out. {result.results.filter((r) => r.outcome === 'CREATED').length}{' '}
              would be added
              {result.skipped > 0
                ? `, ${result.skipped} already exist and would be left alone`
                : ''}
              . Nothing has been written yet.
            </Alert>
          ) : (
            <Alert tone="success">
              {result.created} added
              {result.skipped > 0 ? `, ${result.skipped} already existed and were left alone` : ''}.
            </Alert>
          )}

          {problems.length > 0 ? (
            <ul className="border-rule divide-rule divide-y rounded-md border">
              {problems.map((row) => (
                <li key={`${String(row.row)}-${row.code}`} className="px-3.5 py-2.5">
                  <span className="text-ink text-[0.875rem]">
                    Row {row.row}
                    {row.code ? (
                      <span className="text-muted ml-2 font-mono">{row.code}</span>
                    ) : null}
                  </span>
                  <p className="text-muted mt-0.5 text-[0.8125rem]">{row.message}</p>
                </li>
              ))}
            </ul>
          ) : null}
        </section>
      ) : null}

      <section className="border-rule rounded-md border border-dashed p-4">
        <h2 className="text-ink text-[0.9375rem] font-medium">The columns</h2>
        <p className="text-muted mt-1 text-[0.8125rem]">
          <code className="font-mono">code</code>, <code className="font-mono">name</code> and{' '}
          <code className="font-mono">baseUnitCode</code> are required. The rest are optional:{' '}
          {COLUMNS.filter((c) => !['code', 'name', 'baseUnitCode'].includes(c)).join(', ')}.
        </p>
        <p className="text-muted mt-2 text-[0.8125rem]">
          Prices and tax categories are not part of this — a price belongs to a branch and a
          currency, a tax category to a country. They are set separately.
        </p>
      </section>
    </div>
  );
}
