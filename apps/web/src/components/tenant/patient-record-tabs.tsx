'use client';

import Link from 'next/link';
import { useCallback, useEffect, useId, useRef, useState, useTransition } from 'react';
import type { AppointmentSummary, InvoiceListItem, TimeFormat } from '@rcln/contracts';
import { formatMoney, money } from '@rcln/payments/money';
import { Button } from '@/components/ui/button';
import { Alert } from '@/components/ui/alert';
import { AppointmentStatusChip } from '@/components/tenant/appointment-status';
import { StatusPill } from '@/components/tenant/invoice-list';
import { APPOINTMENT_STATUS_RAIL } from '@/lib/appointment-words';
import { cn } from '@/lib/cn';
import { formatClinicDate, formatClinicDateTime, formatCount } from '@/lib/format';
import {
  loadPatientAppointments,
  loadPatientInvoices,
  type PatientAppointmentsState,
  type PatientInvoicesState,
} from '@/app/(tenant)/t/[slug]/(app)/patients/actions';

type TabId = 'appointments' | 'invoices';

/**
 * The rest of the record: what this patient has been booked for, and what they
 * have been billed.
 *
 * ⚠️ TABS RATHER THAN TWO MORE PANELS, AND THE REASON IS THE READ, NOT THE ROOM.
 *   Each tab is a separate disclosure behind a separate permission — the
 *   bookings are `appointment.read`, the bills are `billing.invoice.read` — and
 *   only the visible one is fetched. A chart opened to check a telephone number
 *   therefore reads no invoices at all. Panels stacked down the page would fetch
 *   both every time, which is the audit-noise trap `visit-history` was moved to
 *   its own route to avoid.
 *
 * ⚠️ THE BOOKINGS ARRIVE WITH THE PAGE AND THE BILLS DO NOT. The first tab is
 *   rendered on the server, so the section is never a spinner on arrival; the
 *   second is fetched the first time somebody opens it and then kept. Loading
 *   both up front would pay for a read nobody asked for.
 *
 * ⚠️ NOTHING HERE INVENTS A VOCABULARY. The status chip and the coloured rail are
 *   the day board's, and the pill is the ledger's — a booking that reads amber on
 *   the board reads amber here, which is the whole reason those live in
 *   `appointment-words.ts` and `invoice-filters.ts` rather than in a screen.
 *
 * ⚠️ NEITHER TAB SHOWS A DIAGNOSIS. This is when somebody came in and what they
 *   were charged. What was concluded at a visit is the visit history, behind
 *   `clinical.encounter.read`, and it is a link at the top of this record.
 */
export function PatientRecordTabs({
  slug,
  patientId,
  timezone,
  timeFormat,
  canReadAppointments,
  canReadInvoices,
  initialAppointments,
}: {
  slug: string;
  patientId: string;
  /**
   * The clinic's zone, for the invoice dates. The bookings each carry their
   * own — a patient seen at two branches has a history spanning both, and one
   * page-level zone would print the satellite's visits in the main clinic's
   * hours (invariant 6).
   */
  timezone: string;
  timeFormat: TimeFormat;
  canReadAppointments: boolean;
  canReadInvoices: boolean;
  /** Page one, fetched by the page. Null when the caller may not read bookings. */
  initialAppointments: PatientAppointmentsState | null;
}) {
  const panelId = useId();

  const tabs: TabId[] = [
    ...(canReadAppointments ? (['appointments'] as const) : []),
    ...(canReadInvoices ? (['invoices'] as const) : []),
  ];
  const [active, setActive] = useState<TabId>(tabs[0] ?? 'appointments');

  const [appointments, setAppointments] = useState<PatientAppointmentsState | null>(
    initialAppointments
  );
  const [invoices, setInvoices] = useState<PatientInvoicesState | null>(null);
  const [pending, startTransition] = useTransition();

  const fetchAppointments = useCallback(
    (page: number) => {
      startTransition(async () => {
        setAppointments(await loadPatientAppointments(slug, patientId, page));
      });
    },
    [slug, patientId]
  );

  const fetchInvoices = useCallback(
    (page: number) => {
      startTransition(async () => {
        setInvoices(await loadPatientInvoices(slug, patientId, page));
      });
    },
    [slug, patientId]
  );

  /*
   * The first open of a tab fetches it; every later open shows what is already
   * held. `useRef` rather than the state itself, because a failed fetch leaves a
   * state that is set — and retrying it on every tab change would hammer an
   * endpoint that has already said no.
   */
  const requested = useRef<Set<TabId>>(new Set(initialAppointments ? ['appointments'] : []));

  useEffect(() => {
    if (requested.current.has(active)) return;
    requested.current.add(active);
    if (active === 'appointments') fetchAppointments(1);
    else fetchInvoices(1);
  }, [active, fetchAppointments, fetchInvoices]);

  if (tabs.length === 0) return null;

  return (
    <section
      className="border-rule bg-card mt-8 rounded-lg border"
      aria-labelledby={`${panelId}-h`}
    >
      <div className="border-rule flex items-end justify-between gap-4 border-b px-5">
        <h2 id={`${panelId}-h`} className="sr-only">
          This patient&rsquo;s activity
        </h2>
        {/*
          ⚠️ THE UNDERLINE TABLIST IS ALREADY IN THIS APP — it is what the sign-in
            screen uses to choose between a password and a code. A second tab
            treatment would be a second answer to a question this product has
            answered once.
        */}
        <div role="tablist" aria-label="This patient's activity" className="-mb-px flex gap-1">
          {tabs.map((tab) => (
            <button
              key={tab}
              role="tab"
              type="button"
              id={`${panelId}-tab-${tab}`}
              aria-selected={active === tab}
              aria-controls={`${panelId}-panel`}
              onClick={() => setActive(tab)}
              className={cn(
                'border-b-2 px-3 py-3 text-[0.875rem] font-medium transition-colors',
                active === tab
                  ? 'border-drape text-ink'
                  : 'text-muted hover:text-ink border-transparent'
              )}
            >
              {tab === 'appointments' ? 'Appointments' : 'Invoices'}
              {/*
                The count, once it is known. It sits inside the tab so somebody
                can see there are eleven bills without opening the tab that reads
                them — and it is absent, not zero, before the fetch, because "we
                have not looked" and "there are none" are different answers.
              */}
              <Count
                total={tab === 'appointments' ? appointments?.total : invoices?.total}
                dimmed={active !== tab}
              />
            </button>
          ))}
        </div>
      </div>

      <div
        role="tabpanel"
        id={`${panelId}-panel`}
        aria-labelledby={`${panelId}-tab-${active}`}
        aria-busy={pending}
        tabIndex={-1}
        className="p-5"
      >
        {active === 'appointments' ? (
          <AppointmentsTab
            state={appointments}
            timeFormat={timeFormat}
            pending={pending}
            onGo={fetchAppointments}
          />
        ) : (
          <InvoicesTab
            state={invoices}
            timezone={timezone}
            pending={pending}
            onGo={fetchInvoices}
          />
        )}
      </div>
    </section>
  );
}

function Count({ total, dimmed }: { total: number | undefined; dimmed: boolean }) {
  if (total === undefined) return null;
  return (
    <span
      className={cn(
        'ml-2 rounded-full px-1.5 py-0.5 text-[0.6875rem] tabular-nums',
        dimmed ? 'bg-drape-tint/50 text-muted' : 'bg-drape-tint text-drape-deep'
      )}
    >
      {formatCount(total)}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Appointments
// ---------------------------------------------------------------------------

function AppointmentsTab({
  state,
  timeFormat,
  pending,
  onGo,
}: {
  state: PatientAppointmentsState | null;
  timeFormat: TimeFormat;
  pending: boolean;
  onGo: (page: number) => void;
}) {
  if (state === null) return <Loading label="Loading appointments" />;
  if (state.status === 'error') return <Alert tone="error">{state.message}</Alert>;

  if (state.appointments.length === 0) {
    return (
      <Empty
        title="No appointments yet."
        note="Bookings made for this patient appear here, newest first."
        action={{ href: '/appointments', label: 'Go to the day board' }}
      />
    );
  }

  return (
    <div className={cn('space-y-4', pending && 'opacity-60')}>
      <ul className="space-y-2">
        {state.appointments.map((appointment) => (
          <AppointmentRow key={appointment.id} appointment={appointment} timeFormat={timeFormat} />
        ))}
      </ul>
      <Pager total={state.total} page={state.page} pageSize={state.pageSize} onGo={onGo} />
    </div>
  );
}

/**
 * ⚠️ THE INSTANT IS FORMATTED IN THE BOOKING'S OWN ZONE, not the clinic's. It is
 *   on the row for exactly this reason — see `appointmentSummary.timezone`.
 */
function AppointmentRow({
  appointment,
  timeFormat,
}: {
  appointment: AppointmentSummary;
  timeFormat: TimeFormat;
}) {
  /* The board's own rail, so a cancelled visit is as findable on the chart as it
     is on the queue. Decoration only — the chip beside it carries the meaning. */
  const rail = APPOINTMENT_STATUS_RAIL[appointment.status];

  return (
    <li
      className={cn(
        'border-rule hover:bg-drape-tint/30 relative isolate rounded-md border border-l-2 px-4 py-3 transition-colors',
        rail
      )}
    >
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <p className="text-ink text-[0.9375rem]">
          {formatClinicDateTime(appointment.scheduledStart, appointment.timezone, timeFormat)}
        </p>
        <AppointmentStatusChip status={appointment.status} />
      </div>
      <p className="text-muted mt-1 text-[0.8125rem]">
        {appointment.doctorName}
        <span aria-hidden="true"> · </span>
        <Link
          href={`/appointments/${appointment.id}`}
          className="text-drape font-mono hover:underline focus-visible:underline after:absolute after:inset-0 after:content-['']"
        >
          {appointment.appointmentNumber}
        </Link>
      </p>
      {/*
        Why it was called off, where there is room for it. Never `reason` — the
        chief complaint stays behind the endpoint that logs its disclosure, and
        this list is not that endpoint.
      */}
      {appointment.status === 'CANCELLED' && appointment.cancellationReason !== null ? (
        <p className="text-danger mt-1 text-[0.8125rem]">
          <span className="sr-only">Cancelled because: </span>
          {appointment.cancellationReason}
        </p>
      ) : null}
    </li>
  );
}

// ---------------------------------------------------------------------------
// Invoices
// ---------------------------------------------------------------------------

function InvoicesTab({
  state,
  timezone,
  pending,
  onGo,
}: {
  state: PatientInvoicesState | null;
  timezone: string;
  pending: boolean;
  onGo: (page: number) => void;
}) {
  if (state === null) return <Loading label="Loading invoices" />;
  if (state.status === 'error') return <Alert tone="error">{state.message}</Alert>;

  if (state.invoices.length === 0) {
    return (
      <Empty
        title="Nothing has been billed to this patient."
        note="Bills raised from a consultation or a dispense appear here."
      />
    );
  }

  return (
    <div className={cn('space-y-4', pending && 'opacity-60')}>
      {/* Four columns do not fit a phone, and dropping one would hide the money
          on the device the front desk is most likely holding. */}
      <div className="overflow-x-auto">
        <table className="w-full min-w-[34rem] border-collapse text-sm">
          <caption className="sr-only">
            This patient&rsquo;s invoices, newest first. Each row links to the invoice.
          </caption>
          <thead>
            <tr className="border-rule text-muted border-b text-left text-xs tracking-wide uppercase">
              <th scope="col" className="py-2 pr-4 font-medium">
                Number
              </th>
              <th scope="col" className="py-2 pr-4 font-medium">
                Supplied
              </th>
              <th scope="col" className="py-2 pr-4 font-medium">
                Status
              </th>
              <th scope="col" className="py-2 pr-4 text-right font-medium">
                Total
              </th>
              <th scope="col" className="py-2 text-right font-medium">
                Outstanding
              </th>
            </tr>
          </thead>
          <tbody>
            {state.invoices.map((invoice) => (
              <InvoiceRow key={invoice.id} invoice={invoice} timezone={timezone} />
            ))}
          </tbody>
        </table>
      </div>
      <Pager total={state.total} page={state.page} pageSize={state.pageSize} onGo={onGo} />
    </div>
  );
}

function InvoiceRow({ invoice, timezone }: { invoice: InvoiceListItem; timezone: string }) {
  const settled = invoice.balanceDueMinor === 0;
  const reversed = invoice.status === 'CANCELLED' || invoice.status === 'VOID';

  return (
    <tr className="border-rule hover:bg-drape-tint/30 relative isolate border-b last:border-b-0">
      <td className="py-3 pr-4">
        <Link
          href={`/invoices/${invoice.id}`}
          className="text-drape font-mono text-[0.8125rem] hover:underline focus-visible:underline after:absolute after:inset-0 after:content-['']"
        >
          {invoice.invoiceNumber ?? 'Draft'}
        </Link>
        {/* A credit note is a reversal, not a bill, and a column of totals that
            does not say which is which sums to the wrong number in somebody's
            head. */}
        {invoice.kind === 'CREDIT_NOTE' ? (
          <span className="text-muted ml-2 text-[0.6875rem]">Credit note</span>
        ) : null}
      </td>
      <td className="text-muted py-3 pr-4">{formatClinicDate(invoice.suppliedAt, timezone)}</td>
      <td className="py-3 pr-4">
        <StatusPill status={invoice.status} />
      </td>
      {/* Mono a step down from the prose beside it, and `tabular-nums` asked for
          explicitly — `.font-mono` does not carry it. See invoice-list.tsx. */}
      <td className="text-ink py-3 pr-4 text-right font-mono text-[0.8125rem] tabular-nums">
        {formatMoney(money(invoice.grandTotalMinor, invoice.currency))}
      </td>
      <td
        className={cn(
          'py-3 text-right font-mono text-[0.8125rem] tabular-nums',
          settled ? 'text-muted' : 'text-ink'
        )}
      >
        {reversed ? (
          <span className="text-muted">
            <span aria-hidden="true">—</span>
            <span className="sr-only">Nothing owed; this invoice was reversed</span>
          </span>
        ) : settled ? (
          <span className="text-muted">Settled</span>
        ) : (
          formatMoney(money(invoice.balanceDueMinor, invoice.currency))
        )}
      </td>
    </tr>
  );
}

// ---------------------------------------------------------------------------
// Shared furniture
// ---------------------------------------------------------------------------

function Loading({ label }: { label: string }) {
  return (
    <p className="text-muted py-6 text-center text-sm" aria-live="polite">
      {label}…
    </p>
  );
}

function Empty({
  title,
  note,
  action,
}: {
  title: string;
  note: string;
  action?: { href: string; label: string };
}) {
  return (
    <div className="py-8 text-center">
      <p className="text-ink font-medium">{title}</p>
      <p className="text-muted mx-auto mt-2 max-w-prose text-sm">{note}</p>
      {action ? (
        <Link
          href={action.href}
          className="text-drape mt-4 inline-block text-sm font-medium hover:underline focus-visible:underline"
        >
          {action.label}
        </Link>
      ) : null}
    </div>
  );
}

/**
 * ⚠️ OFFSET PAGES, WHICH IS WHAT BOTH ENDPOINTS OFFER. Same known limitation the
 *   ledger records: fine at a clinic's volume, wrong at the depth a decade of
 *   visits reaches, and a client-side workaround for a server-side pagination
 *   shape would be two problems instead of one.
 */
function Pager({
  total,
  page,
  pageSize,
  onGo,
}: {
  total: number;
  page: number;
  pageSize: number;
  onGo: (page: number) => void;
}) {
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  if (totalPages <= 1) return null;

  return (
    <nav className="flex items-center justify-between gap-4" aria-label="Pages">
      <Button variant="secondary" size="sm" disabled={page <= 1} onClick={() => onGo(page - 1)}>
        Previous
      </Button>
      <p className="text-muted text-sm" aria-live="polite">
        Page {formatCount(page)} of {formatCount(totalPages)}
      </p>
      <Button
        variant="secondary"
        size="sm"
        disabled={page >= totalPages}
        onClick={() => onGo(page + 1)}
      >
        Next
      </Button>
    </nav>
  );
}
