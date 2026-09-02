'use client';

import { useRef, useState, useTransition } from 'react';
import Link from 'next/link';
import type { BranchSummary, ScanResolveResponse, ScanWarning } from '@rcln/contracts';
import { Input, Select } from '@/components/ui/field';
import { Button } from '@/components/ui/button';
import { Alert } from '@/components/ui/alert';
import { StockNav } from '@/components/tenant/stock-nav';
import { resolveScan, type ScanState } from '@/app/(tenant)/t/[slug]/(app)/lookup-actions';

/**
 * The scanner bench: point a reader at a box and find out what it is.
 *
 * ⚠️ THE FIELD IS THE SCREEN, AND EVERYTHING ELSE IS THE ANSWER. A hardware
 *   reader is a keyboard that types very fast and presses Enter. So: the field
 *   is focused on arrival, Enter resolves, and the text is SELECTED again
 *   afterwards so the next scan overwrites it without anybody touching the
 *   mouse. Somebody at a loading bay has both hands on a carton.
 *
 * ⚠️ THE PAYLOAD IS SENT VERBATIM. No trim, no upper-case, no stripping of the
 *   reader's `]d2` prefix — see the action's header. A lot number is
 *   case-sensitive to a regulator and the prefix is how a DataMatrix is told
 *   from a hand-typed line.
 *
 * ⚠️ AND ASCII 29 MAY NEVER ARRIVE. GS1 separates variable-length fields with
 *   FNC1, which a reader transmits as a control character that a great many
 *   keyboard-wedge configurations simply do not send. The decoder handles its
 *   absence — and says so, through `AMBIGUOUS_VARIABLE_LENGTH`, which is
 *   rendered here as a sentence telling the operator to check the lot against
 *   the box rather than as an enum nobody can act on.
 *
 * NO PHI. A barcode names a box. Which patient has a device is a different
 * screen, behind the logging that read carries.
 */

/**
 * The decoder's warnings, in the words of somebody holding a carton.
 *
 * ⚠️ NEVER THE ENUM. `regulatory` refusals render their `reason` verbatim
 *   because that string is written for a pharmacist; these are not — they are
 *   machine names, and a screen that shows `NON_NUMERIC_DATA` has told a
 *   storekeeper nothing they can do anything about.
 */
const WARNING_COPY: Record<ScanWarning, string> = {
  CHECK_DIGIT_FAILED:
    'The check digit does not match the rest of the code. That is usually a mis-read — scan it again before trusting it.',
  UNKNOWN_APPLICATION_IDENTIFIER:
    'Part of this code uses an identifier we do not read. Everything from that point on is shown below, unread — we do not guess where it ends.',
  TRUNCATED_ELEMENT: 'One part of this code is a different length from the one it declares.',
  INVALID_DATE: 'The date in this code is not a real calendar date.',
  NON_NUMERIC_DATA: 'A part of this code that should be digits is not.',
  AMBIGUOUS_VARIABLE_LENGTH:
    'This reader did not send a field separator, so the lot number may have run into whatever followed it. Check it against the box.',
};

interface Props {
  slug: string;
  branches: BranchSummary[];
}

const IDLE: ScanState = { status: 'idle' };

export function ScanConsole({ slug, branches }: Props) {
  const [code, setCode] = useState('');
  const [branchId, setBranchId] = useState('');
  const [state, setState] = useState<ScanState>(IDLE);
  const [pending, startTransition] = useTransition();
  const field = useRef<HTMLInputElement>(null);

  const run = (): void => {
    if (code.trim() === '') return;
    startTransition(async () => {
      setState(await resolveScan(slug, code, branchId === '' ? undefined : branchId));
      // Ready for the next carton without a click. See the header.
      field.current?.select();
    });
  };

  const result = state.status === 'done' ? state.result : null;

  return (
    <div className="space-y-8">
      <StockNav />

      <div className="max-w-4xl space-y-8">
        <header>
          <h1 className="font-display text-ink text-[1.75rem] leading-tight tracking-tight">
            Scan
          </h1>
          <p className="text-muted mt-1 text-[0.875rem]">
            Point a reader at a pack, or type what is printed under the bars. One scan can carry the
            product, the lot, the expiry and the serial at once.
          </p>
        </header>

        <div className="flex flex-wrap items-end gap-3">
          <Input
            ref={field}
            id="scanCode"
            type="text"
            label="Code"
            autoComplete="off"
            autoFocus
            spellCheck={false}
            value={code}
            onChange={(event) => setCode(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                run();
              }
            }}
            className="font-code"
            fieldClassName="min-w-[18rem] flex-1"
            aria-describedby="scanCode-note"
          />
          {branches.length > 1 ? (
            <Select
              name="scanBranch"
              label="Branch"
              value={branchId}
              onChange={(event) => setBranchId(event.target.value)}
              options={[
                { value: '', label: 'Every branch you cover' },
                ...branches.map((b) => ({ value: b.id, label: b.name })),
              ]}
              fieldClassName="min-w-[12rem]"
            />
          ) : null}
          <Button type="button" onClick={run} disabled={pending || code.trim() === ''}>
            {pending ? 'Reading…' : 'Read'}
          </Button>
        </div>
        <p id="scanCode-note" className="text-muted -mt-5 text-[0.8125rem] leading-snug">
          Send it exactly as the reader gives it. Both forms work — the raw payload and the
          bracketed one printed underneath.
        </p>

        {state.status === 'error' ? <Alert tone="error">{state.message}</Alert> : null}

        {result === null ? null : (
          <div className="space-y-8">
            <ElementStrip decoded={result.decoded} />

            {result.decoded.warnings.length > 0 ? (
              <Alert tone="warning">
                <ul className="space-y-1.5">
                  {result.decoded.warnings.map((warning) => (
                    <li key={warning}>{WARNING_COPY[warning]}</li>
                  ))}
                </ul>
              </Alert>
            ) : null}

            {result.isAmbiguous ? (
              <Alert tone="warning">
                More than one of your products carries this code. Two countries assign the same
                number to different medicines, and repackagers reuse them — choose from the list
                below rather than assuming.
              </Alert>
            ) : null}

            <Products result={result} />
            <Lots result={result} />
            <Devices result={result} />
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * The signature of this screen: the payload, taken apart in front of the person
 * who scanned it.
 *
 * ⚠️ IT SHOWS THE SEGMENTATION, NOT A SUMMARY, AND THAT IS THE WHOLE POINT. A
 *   GS1 element string is unreadable precisely because there is no separator
 *   between its fields — so when a scan resolves to the wrong lot, the only
 *   useful question is "where did the reader think one field ended and the next
 *   began". This answers it, in the same monospace the code is printed in.
 *   Anything the decoder refused to read on is the last cell, marked, rather
 *   than dropped.
 */
function ElementStrip({ decoded }: { decoded: ScanResolveResponse['decoded'] }) {
  if (decoded.format === 'PLAIN' && decoded.elements.length === 0) {
    return (
      <section>
        <h2 className="text-muted text-[0.75rem] font-medium tracking-[0.08em] uppercase">
          What was read
        </h2>
        <p className="text-ink font-code border-rule bg-paper mt-2 rounded-md border px-3.5 py-2.5 text-[0.9375rem] break-all">
          {decoded.raw}
        </p>
        <p className="text-muted mt-1.5 text-[0.8125rem]">
          Not a barcode this reads. Searched as a code of your own.
        </p>
      </section>
    );
  }

  return (
    <section>
      <h2 className="text-muted text-[0.75rem] font-medium tracking-[0.08em] uppercase">
        What was read
      </h2>
      <div className="border-rule divide-rule mt-2 flex divide-x overflow-x-auto rounded-md border">
        {decoded.elements.map((element, index) => (
          <div key={`${element.ai}-${String(index)}`} className="bg-card shrink-0 px-3.5 py-2.5">
            <p className="text-muted font-code text-[0.6875rem] tracking-[0.08em]">
              ({element.ai})
            </p>
            <p className="text-muted mt-0.5 text-[0.75rem]">{element.label}</p>
            <p className="text-ink font-code mt-1 text-[0.9375rem]">{element.value || '—'}</p>
          </div>
        ))}
        {decoded.unparsed === null ? null : (
          <div className="bg-danger-tint border-danger shrink-0 border-l-2 px-3.5 py-2.5">
            <p className="text-danger font-code text-[0.6875rem] tracking-[0.08em]">(??)</p>
            <p className="text-danger mt-0.5 text-[0.75rem]">Not read</p>
            <p className="text-ink font-code mt-1 text-[0.9375rem] break-all">{decoded.unparsed}</p>
          </div>
        )}
      </div>
    </section>
  );
}

function Products({ result }: { result: ScanResolveResponse }) {
  return (
    <section>
      <h2 className="text-ink border-rule border-b pb-2 text-[0.9375rem] font-medium">Product</h2>
      {result.products.length === 0 ? (
        <p className="text-muted mt-3 text-[0.875rem]">
          {result.decoded.gtin === null
            ? 'This code names no product in your catalogue.'
            : 'Nothing in your catalogue carries this barcode. If the delivery is right, add it to the product — the scan will find it next time.'}
        </p>
      ) : (
        <ul className="divide-rule mt-1 divide-y">
          {result.products.map((product) => (
            <li key={product.productId} className="flex flex-wrap items-baseline gap-x-3 py-3">
              <Link
                href={`/products/${product.productId}`}
                className="text-ink hover:text-drape text-[0.9375rem] underline-offset-2 hover:underline"
              >
                {product.productName}
              </Link>
              <span className="text-muted font-mono text-[0.75rem]">{product.productCode}</span>
              <span className="text-muted text-[0.8125rem]">
                matched on {product.matchedOn.type}
              </span>
              {product.isExpiryControlled ? (
                <span className="text-muted text-[0.8125rem]">· expiry controlled</span>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function Lots({ result }: { result: ScanResolveResponse }) {
  if (result.decoded.lotNumber === null) return null;

  return (
    <section>
      <h2 className="text-ink border-rule border-b pb-2 text-[0.9375rem] font-medium">
        Lot {result.decoded.lotNumber}
      </h2>
      {result.batches.length === 0 ? (
        <p className="text-muted mt-3 text-[0.875rem]">
          You hold no stock under this lot number. On a delivery that is expected — record the lot
          when you receive it.
        </p>
      ) : (
        <ul className="divide-rule mt-1 divide-y">
          {result.batches.map((batch) => (
            <li key={batch.id} className="py-3">
              <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
                <Link
                  href={`/stock/lots/${batch.id}`}
                  className="text-ink hover:text-drape text-[0.9375rem] underline-offset-2 hover:underline"
                >
                  {batch.productName}
                </Link>
                <span className="text-ink text-[0.875rem]">
                  {batch.availableQuantityBase} {batch.baseUnitSymbol} available
                </span>
              </div>
              <p className="text-muted mt-1 text-[0.8125rem]">
                {batch.branchName} · expires {batch.expiresOn ?? 'no expiry recorded'} ·{' '}
                {batch.isDispensable ? 'dispensable' : batch.status.toLowerCase()}
              </p>
              {/*
               * ⚠️ THE MISMATCH IS THE REASON THIS SCREEN EXISTS AT A GOODS
               *   RECEIPT. Either the wrong lot was picked or the wrong date was
               *   typed, and this is the only moment anybody holds both.
               */}
              {batch.expiryMatchesScan === false ? (
                <Alert tone="warning" className="mt-2">
                  The pack says {result.decoded.expiresOn} and this lot is recorded as expiring{' '}
                  {batch.expiresOn}. One of the two is wrong — check the carton before you put it
                  away.
                </Alert>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function Devices({ result }: { result: ScanResolveResponse }) {
  if (result.decoded.serialNumber === null) return null;

  return (
    <section>
      <h2 className="text-ink border-rule border-b pb-2 text-[0.9375rem] font-medium">
        Device {result.decoded.serialNumber}
      </h2>
      {result.serials.length === 0 ? (
        <p className="text-muted mt-3 text-[0.875rem]">
          No device on file with this serial number.
        </p>
      ) : (
        <ul className="divide-rule mt-1 divide-y">
          {result.serials.map((serial) => (
            <li
              key={serial.id}
              className="flex flex-wrap items-baseline justify-between gap-3 py-3"
            >
              <Link
                href={`/stock/serials/${serial.id}`}
                className="text-ink hover:text-drape text-[0.9375rem] underline-offset-2 hover:underline"
              >
                {serial.productName}
              </Link>
              <span className="text-muted text-[0.8125rem]">
                {serial.branchName} · {serial.currentLocationName ?? 'no location'} ·{' '}
                {serial.status.toLowerCase().replace('_', ' ')}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
