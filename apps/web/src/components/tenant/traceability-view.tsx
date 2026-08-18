'use client';

import { useRouter, useSearchParams } from 'next/navigation';
import type { BackwardTraceResponse, ForwardTraceResponse } from '@rcln/contracts';
import { ProductRecallNav } from '@/components/tenant/product-recall-nav';
import { formatClinicDate, formatClinicDateTime } from '@/lib/format';

/**
 * Both directions of the same question, on one screen.
 *
 * ⚠️ THE FORWARD PANEL ANSWERS IN COUNTS AND NAMES NOBODY, and that is the whole
 *   design rather than a limitation of this screen. "29 people received it" is
 *   what a storekeeper needs to know to escalate; who they are is a second
 *   request, a second permission and a logged disclosure — and it is reached
 *   from a NOTICE, because contacting people is work a recall coordinates.
 *
 * ⚠️ AND THE BACKWARD PANEL IS PAPERWORK, NOT PEOPLE. Lot to delivery to order
 *   to supplier: no patient appears in it at any point, which is why it needs no
 *   permission beyond the read code.
 */
interface Props {
  slug: string;
  forward: ForwardTraceResponse | null;
  backward: BackwardTraceResponse | null;
  /** What the caller asked about, echoed back into the field. */
  batchId: string;
  message: string | null;
  timeZone: string;
  timeFormat: '12H' | '24H';
}

export function TraceabilityView({
  forward,
  backward,
  batchId,
  message,
  timeZone,
  timeFormat,
}: Props) {
  const router = useRouter();
  const params = useSearchParams();

  return (
    <div className="space-y-8">
      <header>
        <h1 className="font-display text-ink text-[1.75rem] leading-tight tracking-tight">
          Trace a lot
        </h1>
        <p className="text-muted mt-1 text-[0.875rem]">
          Where a lot came from, and where it went. Asked most often before anybody has decided
          there is a recall — which is usually how one starts.
        </p>
      </header>

      <ProductRecallNav />

      <form
        className="border-rule bg-card flex flex-wrap items-end gap-3 rounded-md border p-4"
        action={(form) => {
          const value = String(form.get('batchId') ?? '').trim();
          const next = new URLSearchParams(params.toString());
          if (value) next.set('batchId', value);
          else next.delete('batchId');
          router.push(`/product-recalls/trace?${next.toString()}`);
        }}
      >
        <label className="text-[0.875rem]">
          <span className="text-muted block">Lot id</span>
          <input
            name="batchId"
            defaultValue={batchId}
            placeholder="Paste a lot id from the Stock screen"
            className="border-rule bg-paper mt-1 w-[26rem] max-w-full rounded-md border px-3 py-2 text-[0.875rem]"
          />
        </label>
        <button
          type="submit"
          className="bg-drape text-paper hover:bg-drape-deep rounded-md px-4 py-2 text-[0.875rem] font-medium"
        >
          Trace it
        </button>
      </form>

      {message ? <p className="text-muted text-[0.875rem]">{message}</p> : null}

      {backward ? (
        <section className="space-y-3">
          <h2 className="font-display text-ink text-[1.125rem]">Where it came from</h2>
          <p className="text-[0.875rem]">
            {backward.productName} · lot {backward.lotNumber ?? '—'}
            {backward.manufacturerName ? ` · made by ${backward.manufacturerName}` : ''}
            {backward.expiresOn
              ? ` · expires ${formatClinicDate(backward.expiresOn, timeZone)}`
              : ''}
          </p>
          {backward.receipts.length === 0 ? (
            <p className="text-muted text-[0.875rem]">
              No delivery on record. The lot was created by hand — an opening balance or a
              correction — rather than received against an order.
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left text-[0.875rem]">
                <thead className="text-muted border-rule border-b">
                  <tr>
                    <th className="py-2 pr-4 font-medium">Delivery</th>
                    <th className="py-2 pr-4 font-medium">Supplier</th>
                    <th className="py-2 pr-4 font-medium">Their invoice</th>
                    <th className="py-2 pr-4 font-medium">Order</th>
                    <th className="py-2 pr-4 font-medium">Received</th>
                    <th className="py-2 pr-4 font-medium">Quantity</th>
                  </tr>
                </thead>
                <tbody>
                  {backward.receipts.map((receipt) => (
                    <tr key={receipt.goodsReceiptId} className="border-rule border-b last:border-0">
                      <td className="py-2 pr-4">{receipt.receiptNumber ?? '—'}</td>
                      <td className="py-2 pr-4">
                        {receipt.supplierName}
                        <span className="text-muted block text-[0.75rem]">
                          {receipt.branchName}
                        </span>
                      </td>
                      <td className="py-2 pr-4">{receipt.supplierInvoiceNumber ?? '—'}</td>
                      <td className="py-2 pr-4">{receipt.purchaseOrderNumber ?? '—'}</td>
                      <td className="py-2 pr-4">
                        {formatClinicDateTime(receipt.receivedAt, timeZone, timeFormat)}
                      </td>
                      <td className="py-2 pr-4">
                        {receipt.receivedQuantityBase} {backward.baseUnitSymbol}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      ) : null}

      {forward ? (
        <section className="space-y-3">
          <h2 className="font-display text-ink text-[1.125rem]">Where it went</h2>

          <dl className="grid grid-cols-2 gap-4 text-[0.875rem] sm:grid-cols-4">
            <div>
              <dt className="text-muted">Dispensed</dt>
              <dd>
                {forward.quantityDispensedBase} {forward.baseUnitSymbol}
                <span className="text-muted block text-[0.75rem]">
                  {forward.supplyCount} suppl{forward.supplyCount === 1 ? 'y' : 'ies'}
                </span>
              </dd>
            </div>
            <div>
              <dt className="text-muted">Used in procedures</dt>
              <dd>
                {forward.quantityConsumedBase} {forward.baseUnitSymbol}
                <span className="text-muted block text-[0.75rem]">
                  {forward.procedureCount} procedure{forward.procedureCount === 1 ? '' : 's'}
                </span>
              </dd>
            </div>
            <div>
              <dt className="text-muted">People affected</dt>
              <dd>
                {forward.patientCount}
                <span className="text-muted block text-[0.75rem]">
                  Names are reached from a notice.
                </span>
              </dd>
            </div>
            <div>
              <dt className="text-muted">Movements</dt>
              <dd>{forward.movementCount}</dd>
            </div>
          </dl>

          <h3 className="text-ink text-[0.9375rem]">Still on the shelf</h3>
          {forward.onHand.length === 0 ? (
            <p className="text-muted text-[0.875rem]">None of it is left anywhere.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left text-[0.875rem]">
                <thead className="text-muted border-rule border-b">
                  <tr>
                    <th className="py-2 pr-4 font-medium">Branch</th>
                    <th className="py-2 pr-4 font-medium">Where</th>
                    <th className="py-2 pr-4 font-medium">Condition</th>
                    <th className="py-2 pr-4 font-medium">Quantity</th>
                  </tr>
                </thead>
                <tbody>
                  {forward.onHand.map((row) => (
                    <tr
                      key={`${row.locationId}-${row.status}`}
                      className="border-rule border-b last:border-0"
                    >
                      <td className="py-2 pr-4">{row.branchName}</td>
                      <td className="py-2 pr-4">{row.locationName}</td>
                      <td className="py-2 pr-4">{row.status}</td>
                      <td className="py-2 pr-4">
                        {row.quantityBase} {forward.baseUnitSymbol}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      ) : null}
    </div>
  );
}
