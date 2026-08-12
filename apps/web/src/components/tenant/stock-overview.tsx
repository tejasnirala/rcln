import Link from 'next/link';
import type { ExpiryReportResponse, StockBalanceListResponse } from '@rcln/contracts';
import { StockNav } from '@/components/tenant/stock-nav';
import { BucketBar, expiryPhrase, readable } from '@/components/tenant/stock-status';

/**
 * The screen a storekeeper opens in the morning.
 *
 * ⚠️ IT LEADS WITH WHAT IS WRONG, NOT WITH A TOTAL. The obvious opening for an
 *   inventory dashboard is a big number — "4,812 items in stock" — and it is the
 *   wrong one, because nobody opens this screen to admire a total. They open it
 *   to find out what needs doing today: what is about to expire, what is being
 *   held, what has run down. A total across four thousand products in nine
 *   conditions is not even a meaningful number; it adds tablets to millilitres.
 *
 *   So expiry comes first, and the shelves come second.
 *
 * ⚠️ NEAR-EXPIRY IS AN ALERT AND NEVER A STATUS. A lot expiring in thirty days
 *   is perfectly dispensable and often SHOULD be dispensed first — that is what
 *   FEFO is for. Only the sweep, on the day itself and in the branch's zone,
 *   moves anything. This panel is a list of things to use up, not a list of
 *   problems.
 *
 * The window is a SETTING (`inventory.expiry_alert_days`, PI-ADR-015), resolved
 * server-side and echoed back so the screen can say which window it is showing
 * rather than implying a constant.
 *
 * NO PHI on this screen.
 */
export function StockOverview({
  expiring,
  balances,
}: {
  expiring: ExpiryReportResponse;
  balances: StockBalanceListResponse;
}) {
  /*
   * Group the balance rows by location, so the answer reads the way a person
   * walks the store: shelf by shelf, rather than as one flat list of buckets.
   */
  const byLocation = new Map<
    string,
    { name: string; rows: StockBalanceListResponse['balances'] }
  >();

  for (const row of balances.balances) {
    const existing = byLocation.get(row.locationId);
    if (existing) existing.rows.push(row);
    else byLocation.set(row.locationId, { name: row.locationName, rows: [row] });
  }

  return (
    <div className="space-y-8">
      <header>
        <h1 className="font-display text-ink text-[1.75rem] leading-tight tracking-tight">Stock</h1>
        <p className="text-muted mt-1 text-[0.875rem]">
          What is on the shelves, and what is about to need attention.
        </p>
      </header>

      <StockNav />

      {/* ---- what needs doing ------------------------------------------- */}
      <section aria-labelledby="expiring-heading" className="space-y-3">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 id="expiring-heading" className="text-ink text-[1.0625rem] font-medium">
            Expiring soon
          </h2>
          <p className="text-muted text-[0.75rem]">
            Lots expiring within {expiring.windowDays} days. Change this in Clinic settings.
          </p>
        </div>

        {expiring.rows.length === 0 ? (
          <div className="border-rule bg-card rounded-md border p-8 text-center">
            <p className="text-ink text-[0.9375rem]">Nothing is expiring in this window.</p>
            <p className="text-muted mx-auto mt-2 max-w-md text-[0.875rem]">
              Lots appear here as they approach their expiry date, so they can be used first.
            </p>
          </div>
        ) : (
          <ul className="border-rule divide-rule bg-card divide-y rounded-md border">
            {expiring.rows.map((row) => (
              <li
                key={row.batchId}
                className="flex flex-wrap items-baseline gap-x-3 gap-y-1 px-4 py-3"
              >
                <Link
                  href={`/stock/lots?q=${encodeURIComponent(row.lotNumber)}`}
                  className="text-ink text-[0.9375rem] font-medium"
                >
                  {row.productName}
                </Link>
                <span className="font-mono text-muted text-[0.75rem]">{row.lotNumber}</span>
                <span className="text-ink font-mono text-[0.8125rem]">
                  {readable(row.quantityAvailable)} {row.baseUnitSymbol}
                </span>
                {/*
                  ⚠️ THE PHRASE, NOT THE DATE, IS WHAT DECIDES AN ACTION — and it
                     comes from the server, computed in the BRANCH's timezone.
                     Recomputing it here from the date and the browser's clock
                     would read "expires today" a day early for half the world.
                */}
                <span
                  className={
                    row.daysRemaining < 0
                      ? 'text-signal ml-auto text-[0.8125rem]'
                      : 'text-muted ml-auto text-[0.8125rem]'
                  }
                >
                  {expiryPhrase(row.daysRemaining)}
                  <span className="text-muted/70 ml-2 font-mono text-[0.75rem]">
                    {row.expiresOn}
                  </span>
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* ---- what is where ---------------------------------------------- */}
      <section aria-labelledby="shelves-heading" className="space-y-3">
        <h2 id="shelves-heading" className="text-ink text-[1.0625rem] font-medium">
          On the shelves
        </h2>

        {byLocation.size === 0 ? (
          <div className="border-rule bg-card rounded-md border p-8 text-center">
            <p className="text-ink text-[0.9375rem]">No stock has been recorded yet.</p>
            <p className="text-muted mx-auto mt-2 max-w-md text-[0.875rem]">
              Add the places you keep stock, then record what is in them.
            </p>
            <Link
              href="/stock/locations"
              className="text-drape mt-4 inline-block text-[0.875rem] underline underline-offset-4"
            >
              Set up locations
            </Link>
          </div>
        ) : (
          <div className="space-y-6">
            {[...byLocation.entries()].map(([locationId, group]) => (
              <div key={locationId} className="border-rule bg-card rounded-md border">
                <h3 className="border-rule text-ink border-b px-4 py-2.5 text-[0.875rem] font-medium">
                  {group.name}
                </h3>
                <ul className="divide-rule divide-y">
                  {/*
                    One row per (product, lot) with its buckets folded into the
                    bar. Grouped in the component rather than asked of the API,
                    because the API's row IS the bucket — that is what
                    `stock_balances` is keyed by, and flattening it server-side
                    would invent a shape the ledger does not have.
                  */}
                  {foldBuckets(group.rows).map((entry) => (
                    <li key={entry.key} className="px-4 py-3">
                      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                        <span className="text-ink text-[0.9375rem]">{entry.productName}</span>
                        <span className="font-mono text-muted text-[0.75rem]">
                          {entry.productCode}
                        </span>
                        {entry.lotNumber ? (
                          <span className="text-muted text-[0.75rem]">
                            lot <span className="font-mono">{entry.lotNumber}</span>
                          </span>
                        ) : null}
                        {entry.expiresOn ? (
                          <span className="text-muted ml-auto font-mono text-[0.75rem]">
                            {entry.expiresOn}
                          </span>
                        ) : null}
                      </div>
                      <div className="mt-2 max-w-md">
                        <BucketBar
                          buckets={entry.buckets}
                          unit={entry.unit}
                          label={`${entry.productName}${entry.lotNumber ? ` lot ${entry.lotNumber}` : ''} at ${group.name}`}
                        />
                      </div>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        )}

        {balances.meta.total > balances.balances.length ? (
          <p className="text-muted text-[0.8125rem]">
            Showing {balances.balances.length} of {balances.meta.total} entries.{' '}
            <Link href="/stock/lots" className="text-drape underline underline-offset-4">
              See every lot
            </Link>
          </p>
        ) : null}
      </section>
    </div>
  );
}

interface FoldedEntry {
  key: string;
  productName: string;
  productCode: string;
  lotNumber: string | null;
  expiresOn: string | null;
  unit: string;
  buckets: { status: StockBalanceListResponse['balances'][number]['status']; quantity: string }[];
}

/** Collapse one location's bucket rows into one entry per (product, lot). */
function foldBuckets(rows: StockBalanceListResponse['balances']): FoldedEntry[] {
  const folded = new Map<string, FoldedEntry>();

  for (const row of rows) {
    const key = `${row.productId}:${row.batchId ?? '-'}:${row.serialId ?? '-'}`;
    const existing = folded.get(key);

    if (existing) {
      existing.buckets.push({ status: row.status, quantity: row.quantity });
      continue;
    }

    folded.set(key, {
      key,
      productName: row.productName,
      productCode: row.productCode,
      lotNumber: row.lotNumber,
      expiresOn: row.expiresOn,
      unit: row.baseUnitSymbol,
      buckets: [{ status: row.status, quantity: row.quantity }],
    });
  }

  return [...folded.values()];
}
