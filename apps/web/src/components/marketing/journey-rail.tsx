'use client';

import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { cn } from '@/lib/cn';

/*
 * The signature element: one clinic day as a sequence, with a single token
 * travelling it.
 *
 * A sequence is what the product actually is — the same record picked up by the
 * front desk, the doctor, the pharmacist, the lab and the billing counter — so
 * ordering the sections carries real information rather than decorating them.
 *
 * Every value below is invented. Never put a plausible patient name here.
 */

type Row = { label: string; value: string; mono?: boolean; note?: string };

type Station = {
  key: string;
  short: string;
  label: string;
  time: string;
  actor: string;
  headline: string;
  rows: Row[];
};

const STATIONS: Station[] = [
  {
    key: 'token',
    short: 'Token',
    label: 'Front desk',
    time: '09:12',
    actor: 'Reception · Andheri branch',
    headline: 'Walk-in registered, token issued',
    rows: [
      { label: 'Token', value: 'T-014', mono: true },
      { label: 'Patient', value: 'Test Patient, 34' },
      { label: 'MRN', value: 'AND/MRN-000014', mono: true, note: 'branch-local' },
      { label: 'Queue', value: 'General OPD · 4 ahead' },
    ],
  },
  {
    key: 'consult',
    short: 'Consult',
    label: 'Consulting room',
    time: '09:41',
    actor: 'Dr. A. Rao · General medicine',
    headline: 'Vitals recorded, encounter open',
    rows: [
      { label: 'Complaint', value: 'Fever, 3 days' },
      { label: 'BP', value: '124/82 mmHg', mono: true },
      { label: 'Temp', value: '99.1 °F', mono: true },
      { label: 'Weight', value: '71.0 kg', mono: true },
    ],
  },
  {
    key: 'rx',
    short: 'Rx',
    label: 'Prescription',
    time: '09:48',
    actor: 'Dr. A. Rao · signed',
    headline: 'Prescribed against the same record',
    rows: [
      { label: 'Drug', value: 'Paracetamol 500 mg' },
      { label: 'Dose', value: '1–0–1 after food', mono: true },
      { label: 'Duration', value: '3 days' },
      { label: 'Allergy check', value: 'No conflict found', note: 'from the patient file' },
    ],
  },
  {
    key: 'pharmacy',
    short: 'Pharmacy',
    label: 'Dispensing counter',
    time: '09:56',
    actor: 'Pharmacy · in-house',
    headline: 'Dispensed from the earliest-expiring batch',
    rows: [
      { label: 'Batch', value: 'PCM-2409', mono: true, note: 'FEFO' },
      { label: 'Expiry', value: '08/2027', mono: true },
      { label: 'Quantity', value: '6 tablets' },
      { label: 'Stock left', value: '112 tablets', note: 'ledger updated' },
    ],
  },
  {
    key: 'lab',
    short: 'Lab',
    label: 'Diagnostics',
    time: '10:20',
    actor: 'In-house lab',
    headline: 'Sample collected, result released',
    rows: [
      { label: 'Order', value: 'Complete blood count' },
      { label: 'Sample', value: 'LB-0031', mono: true },
      { label: 'Parameters', value: '22 measured' },
      { label: 'Status', value: 'Verified and released' },
    ],
  },
  {
    key: 'invoice',
    short: 'Invoice',
    label: 'Billing counter',
    time: '10:34',
    actor: 'Front desk · UPI',
    headline: 'One invoice for the whole visit',
    rows: [
      { label: 'Consultation', value: '₹400.00', mono: true, note: 'GST exempt' },
      { label: 'Complete blood count', value: '₹350.00', mono: true, note: 'GST exempt' },
      { label: 'Paracetamol 500 mg', value: '₹42.00', mono: true, note: '₹37.50 + 12% GST' },
      { label: 'Total paid', value: '₹792.00', mono: true, note: 'INV/2026-27/00187' },
    ],
  },
];

const ADVANCE_MS = 3400;

export function JourneyRail() {
  const [active, setActive] = useState(0);
  /** The explicit play/pause state. WCAG 2.2.2 requires the control to exist. */
  const [auto, setAuto] = useState(true);
  /** Held still while a pointer or keyboard focus is inside the rail. */
  const [engaged, setEngaged] = useState(false);
  const [reduced, setReduced] = useState(false);
  const [visible, setVisible] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const tablistRef = useRef<HTMLDivElement>(null);
  const tabRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const baseId = useId();

  // Only run while the rail is actually on screen; a hero animating in a
  // background tab is wasted work.
  useEffect(() => {
    const node = containerRef.current;
    if (!node) return;

    const observer = new IntersectionObserver(
      (entries) => {
        const entry = entries[0];
        if (entry) setVisible(entry.isIntersecting);
      },
      { threshold: 0.35 }
    );

    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  // Someone who asked for less motion gets the stations without the travel.
  // They stay selectable — the content is never behind the animation.
  useEffect(() => {
    const query = window.matchMedia('(prefers-reduced-motion: reduce)');
    const apply = () => setReduced(query.matches);
    apply();
    query.addEventListener('change', apply);
    return () => query.removeEventListener('change', apply);
  }, []);

  // Reading beats animating. Hovering or tabbing into the rail holds it still
  // without counting as the explicit pause, so it resumes when you leave.
  const running = auto && visible && !reduced && !engaged;

  useEffect(() => {
    if (!running) return;
    const timer = window.setInterval(() => {
      setActive((index) => (index + 1) % STATIONS.length);
    }, ADVANCE_MS);
    return () => window.clearInterval(timer);
  }, [running]);

  /*
   * Below the `sm` breakpoint the rail is a horizontal scroller, so an
   * auto-advancing station walks off the edge and the reader is left watching a
   * card change with no idea which station it belongs to. Keep the active one
   * centred in the strip.
   *
   * This sets the strip's own `scrollLeft` rather than calling
   * `scrollIntoView`, which would also scroll every scrollable ancestor — page
   * included — and yank the whole document around every few seconds.
   */
  useEffect(() => {
    const list = tablistRef.current;
    const tab = tabRefs.current[active];
    if (!list || !tab) return;
    if (list.scrollWidth <= list.clientWidth) return; // laid out as a grid; nothing to scroll

    // Measured from bounding rects, not offsetLeft: offsetLeft is relative to
    // the nearest positioned ancestor, so it silently stops agreeing with the
    // strip the moment anything above it gains a `position`.
    const listBox = list.getBoundingClientRect();
    const tabBox = tab.getBoundingClientRect();
    const delta = tabBox.left + tabBox.width / 2 - (listBox.left + listBox.width / 2);

    // Instant, not smooth. `behavior: 'smooth'` was measured doing nothing at
    // all here — it fails silently and leaves the active station off-screen,
    // which is worse than a jump. The travel is at most ~50px anyway, so the
    // animation was never buying much.
    list.scrollBy({ left: delta, behavior: 'auto' });
  }, [active]);

  // Choosing a station is taking control; stop moving things under the reader.
  const select = useCallback((index: number) => {
    setActive(index);
    setAuto(false);
  }, []);

  const onKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLButtonElement>) => {
      const offset =
        event.key === 'ArrowRight' || event.key === 'ArrowDown'
          ? 1
          : event.key === 'ArrowLeft' || event.key === 'ArrowUp'
            ? -1
            : 0;
      if (offset === 0) return;

      event.preventDefault();
      const next = (active + offset + STATIONS.length) % STATIONS.length;
      select(next);
      tabRefs.current[next]?.focus();
    },
    [active, select]
  );

  const station = STATIONS[active];
  if (!station) return null;

  return (
    <div
      ref={containerRef}
      className="mt-14 sm:mt-16"
      onMouseEnter={() => setEngaged(true)}
      onMouseLeave={() => setEngaged(false)}
      onFocusCapture={() => setEngaged(true)}
      onBlurCapture={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
          setEngaged(false);
        }
      }}
    >
      {/*
       * The travelling chip carries the MRN, not the token number. The token is
       * spent once the patient is called; what actually survives all six
       * stations is the record — which is the entire claim being made.
       */}
      <div aria-hidden="true" className="relative hidden h-7 sm:block">
        <div
          className="absolute top-0 transition-[left] duration-700 ease-out"
          style={{
            // Positioned with `left`, not `translateX`. The wrapper has no width
            // of its own this way, so it shrink-wraps the chip; when it was
            // `inset-x-0` plus a transform it stayed full width and dragged
            // five sixths of the page off the right edge at the last station.
            left: `calc(${active} * (100% / ${STATIONS.length}) + (100% / ${STATIONS.length * 2}))`,
          }}
        >
          <span className="bg-signal-tint text-signal ring-signal/20 inline-flex -translate-x-1/2 items-center gap-1.5 rounded-sm px-2 py-1 font-mono text-[0.6875rem] font-medium tracking-wide whitespace-nowrap ring-1">
            <span className="bg-signal size-1.5 rounded-full" />
            MRN-000014
          </span>
        </div>
      </div>

      {/* The rail */}
      <div
        ref={tablistRef}
        role="tablist"
        aria-label="A visit, one station at a time"
        aria-orientation="horizontal"
        /*
         * No scroll-snap. Snap points override programmatic smooth scrolling —
         * the browser re-snaps to the nearest point mid-animation, so centring
         * the active station silently did nothing. Snap only helps a user
         * swiping, and here the rail advances on its own.
         */
        className="scrollbar-none -mx-gutter flex gap-1 overflow-x-auto px-gutter sm:mx-0 sm:grid sm:grid-cols-6 sm:gap-0 sm:overflow-visible sm:px-0"
      >
        {STATIONS.map((item, index) => {
          const isActive = index === active;
          const isPast = index < active;

          return (
            <button
              key={item.key}
              ref={(node) => {
                tabRefs.current[index] = node;
              }}
              type="button"
              role="tab"
              id={`${baseId}-tab-${item.key}`}
              aria-selected={isActive}
              aria-controls={`${baseId}-panel`}
              tabIndex={isActive ? 0 : -1}
              onClick={() => select(index)}
              onKeyDown={onKeyDown}
              className="group shrink-0 px-3 pb-1 sm:shrink sm:px-0"
            >
              {/*
               * Line and dot share one row so they actually meet, and the dot is
               * centred on its own label at every width — on mobile it used to
               * sit at a fixed 12px from the button's left edge, which put it
               * over the first letter of a long label and past the end of a
               * short one.
               */}
              <span aria-hidden="true" className="relative block h-3">
                <span
                  className={cn(
                    'absolute top-1/2 h-px -translate-y-1/2 transition-colors duration-500',
                    // Bleed past the button on mobile so the rail reads as one
                    // continuous line rather than six stitched segments.
                    '-inset-x-3 sm:inset-x-0',
                    isPast || isActive ? 'bg-drape/45' : 'bg-rule'
                  )}
                />
                <span
                  className={cn(
                    'absolute top-1/2 left-1/2 size-[0.5625rem] -translate-x-1/2 -translate-y-1/2 rounded-full ring-4 transition-[background-color,box-shadow,scale] duration-500',
                    isActive
                      ? 'bg-signal ring-signal-tint scale-125'
                      : isPast
                        ? 'bg-drape ring-paper'
                        : 'bg-rule ring-paper group-hover:bg-drape/50'
                  )}
                />
              </span>
              <span
                className={cn(
                  'mt-3 block text-center text-[0.8125rem] font-medium whitespace-nowrap transition-colors duration-300',
                  isActive ? 'text-ink' : 'text-muted group-hover:text-ink'
                )}
              >
                {item.short}
              </span>
            </button>
          );
        })}
      </div>

      {/*
       * WCAG 2.2.2: content that moves automatically needs a way to stop it.
       * Selecting a station also stops it, but that is not discoverable — this
       * is. Hidden when the OS already asked for reduced motion, because then
       * nothing is moving to stop.
       */}
      {reduced ? null : (
        <div className="mt-4 flex justify-end">
          <button
            type="button"
            onClick={() => setAuto((on) => !on)}
            className="text-muted hover:text-ink inline-flex items-center gap-1.5 rounded-sm px-2 py-1.5 font-mono text-[0.6875rem] tracking-wide uppercase transition-colors"
          >
            <span aria-hidden="true" className={auto ? 'text-signal' : 'text-muted'}>
              {auto ? '❙❙' : '▶'}
            </span>
            {auto ? 'Pause' : 'Play'}
            <span className="sr-only"> the station sequence</span>
          </button>
        </div>
      )}

      {/* The card for the selected station */}
      <div
        role="tabpanel"
        id={`${baseId}-panel`}
        aria-labelledby={`${baseId}-tab-${station.key}`}
        tabIndex={0}
        className="border-rule bg-card mt-6 rounded-lg border shadow-[0_1px_2px_rgba(14,31,26,0.04),0_12px_32px_-16px_rgba(14,31,26,0.18)]"
      >
        <div className="border-rule flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 border-b px-5 py-3.5 sm:px-6">
          <div className="flex items-baseline gap-3">
            <span className="text-signal font-mono text-[0.8125rem] font-medium tabular-nums">
              {station.time}
            </span>
            <span className="text-ink text-sm font-medium">{station.label}</span>
          </div>
          <span className="text-muted text-[0.8125rem]">{station.actor}</span>
        </div>

        <div className="px-5 py-5 sm:px-6">
          <p className="text-ink text-[0.9375rem] font-medium">{station.headline}</p>

          <dl className="mt-4 grid gap-x-8 gap-y-3 sm:grid-cols-2">
            {station.rows.map((row) => (
              <div
                key={row.label}
                className="border-rule/70 flex items-baseline justify-between gap-4 border-b pb-2.5 last:border-b-0 sm:last:border-b"
              >
                <dt className="text-muted text-[0.8125rem]">{row.label}</dt>
                <dd className="flex items-baseline gap-2 text-right">
                  {/* Full-strength muted: at 80% this note was 3.44:1 on white. */}
                  {row.note ? (
                    <span className="text-muted font-mono text-[0.6875rem] tracking-wide">
                      {row.note}
                    </span>
                  ) : null}
                  <span
                    className={cn(
                      'text-ink text-[0.8125rem]',
                      row.mono && 'font-mono tabular-nums'
                    )}
                  >
                    {row.value}
                  </span>
                </dd>
              </div>
            ))}
          </dl>
        </div>

        <p className="text-muted border-rule border-t px-5 py-3 text-[0.8125rem] sm:px-6">
          Same patient record throughout. Nobody retyped a name, a dose or an amount.
        </p>
      </div>
    </div>
  );
}
