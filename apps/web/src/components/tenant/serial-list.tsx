import Link from 'next/link';
import type { SerialListResponse } from '@rcln/contracts';
import { StockNav } from '@/components/tenant/stock-nav';

/**
 * Serialised devices and implants.
 *
 * ⚠️ THE ONLY SCREEN IN THIS SECTION THAT TOUCHES PHI. A serial's
 *   `assignedPatientId` answers "which patient has device 7742", and every read
 *   that returns it writes a `data_access_logs` row (PI-ADR-016) — including
 *   this list, because a list filtered by patient is the same disclosure arrived
 *   at from the other end.
 *
 * ⚠️ SO THE SCREEN SHOWS THAT A DEVICE IS ISSUED AND DOES NOT SHOW TO WHOM. The
 *   API returns an id and never a name, and rendering a patient id would be a
 *   number nobody can act on anyway. Linking a device to a named person belongs
 *   on the patient's own chart, behind the patient permissions — not on a stock
 *   screen behind `inventory.stock.read`.
 *
 * There is no assignment control here either: `POST /serials/:id/assign` exists
 * and is gated on `inventory.stock.adjust`, but the moment a device is fitted is
 * a clinical one and the screen for it belongs beside the procedure that fitted
 * it (PI-9).
 */
const STATUS_LABEL: Record<string, string> = {
  IN_STOCK: 'In stock',
  ISSUED: 'Issued',
  RETURNED: 'Returned',
  QUARANTINED: 'On hold',
  RECALLED: 'Recalled',
  DAMAGED: 'Damaged',
  DISPOSED: 'Disposed',
};

export function SerialList({
  serials,
  meta,
  canManage,
}: {
  serials: SerialListResponse['serials'];
  meta: SerialListResponse['meta'];
  canManage: boolean;
}) {
  return (
    <div className="space-y-8">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="font-display text-ink text-[1.75rem] leading-tight tracking-tight">
            Serials
          </h1>
          <p className="text-muted mt-1 text-[0.875rem]">
            Devices and implants tracked one by one.
          </p>
        </div>
        {canManage ? (
          <Link
            href="/stock/serials/new"
            className="bg-drape text-paper hover:bg-drape-deep inline-flex items-center justify-center rounded-md px-5 py-3 text-[0.9375rem] font-medium transition-colors duration-150"
          >
            Record a serial
          </Link>
        ) : null}
      </header>

      <StockNav />

      {serials.length === 0 ? (
        <div className="border-rule bg-card rounded-md border p-10 text-center">
          <p className="text-ink text-[0.9375rem]">No serials have been recorded.</p>
          <p className="text-muted mx-auto mt-2 max-w-md text-[0.875rem]">
            A serial belongs to a product whose tracking mode is “by serial number”. Set that on the
            product in the catalogue first.
          </p>
        </div>
      ) : (
        <ul className="border-rule divide-rule bg-card divide-y rounded-md border">
          {serials.map((serial) => (
            <li key={serial.id} className="flex flex-wrap items-baseline gap-x-3 gap-y-1 px-4 py-3">
              <span className="text-ink font-mono text-[0.9375rem]">{serial.serialNumber}</span>
              <span className="text-ink text-[0.875rem]">{serial.productName}</span>
              {serial.lotNumber ? (
                <span className="text-muted text-[0.75rem]">
                  lot <span className="font-mono">{serial.lotNumber}</span>
                </span>
              ) : null}

              {/* Status as a word. Colour alone would fail WCAG 1.4.1. */}
              <span
                className={
                  serial.status === 'IN_STOCK'
                    ? 'text-drape border-drape/30 rounded-xs border px-1.5 py-0.5 text-[0.6875rem]'
                    : 'text-muted border-rule rounded-xs border px-1.5 py-0.5 text-[0.6875rem]'
                }
              >
                {STATUS_LABEL[serial.status] ?? serial.status}
              </span>

              {/*
                ⚠️ THAT IT IS ASSIGNED, NOT TO WHOM. See the header — the id is
                   PHI, it is not rendered, and it would not be actionable if it
                   were.
              */}
              {serial.assignedPatientId ? (
                <span className="text-muted text-[0.75rem]">assigned to a patient</span>
              ) : null}

              <span className="text-muted ml-auto text-[0.75rem]">
                {serial.currentLocationName ?? 'no location recorded'}
                {serial.expiresOn ? ` · expires ${serial.expiresOn}` : ''}
              </span>
            </li>
          ))}
        </ul>
      )}

      {meta.total > serials.length ? (
        <p className="text-muted text-[0.8125rem]">
          Showing {serials.length} of {meta.total}.
        </p>
      ) : null}
    </div>
  );
}
