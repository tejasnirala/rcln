'use client';

import { useRef, useState, useTransition } from 'react';
import type { AuditEntry, AuditHistoryResponse, TimeFormat } from '@rcln/contracts';
import {
  readRecordHistory,
  type HistoryState,
} from '@/app/(tenant)/t/[slug]/(app)/history-actions';
import { Alert } from '@/components/ui/alert';
import { formatClinicDateTime } from '@/lib/format';

/**
 * What has happened to one record: who changed it, what moved, and when.
 *
 * ONE COMPONENT, EVERY SCREEN. A branch row, a staff member, a role, the clinic's
 * own settings — the trail has the same shape for all of them because
 * `recordAudit` writes the same shape for all of them. Anything that starts
 * writing audit rows gets a history panel by passing two props, which is the point:
 * a per-screen history is a per-screen chance to render it differently.
 *
 * WHY A NATIVE `<dialog>`
 *   Focus trapping, Escape to close, returning focus to the trigger, and inertness
 *   of the page behind it are all things the platform does correctly and that
 *   hand-rolled panels get wrong. `showModal()` gives all four. The only thing
 *   added here is the sheet geometry — full height, pinned right — because a
 *   centred box is the wrong shape for a list that can be long.
 *
 *   This is the one modal in the product, and it earns the exception to the
 *   expand-in-place convention: history is a reference you consult beside what you
 *   are doing, not a step in doing it. Expanding a row would push the record you
 *   are comparing against off the screen.
 *
 * FETCHED ON OPEN, NOT WITH THE PAGE. A list of twenty branches would otherwise
 * cost twenty audit queries to render a button nobody pressed.
 *
 * NOTHING HERE IS DELETABLE, and there is no control suggesting otherwise.
 * `audit_logs` is append-only at the database — `rcln_app` holds no UPDATE or
 * DELETE, and a trigger refuses both regardless. See the `audit_immutability`
 * migration.
 */

export function RecordHistory({
  slug,
  entityType,
  entityId,
  /** What this record is called, for the panel's heading. Never a patient name. */
  label,
}: {
  slug: string;
  entityType: string;
  entityId: string;
  label: string;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  /*
   * ⚠️ THE ACTION'S OWN `HistoryState`, NOT A HAND-WRITTEN COPY OF IT. This used
   *   to restate the shape inline, so adding `timezone` to what the action
   *   returns left the component typed as if it had never arrived. A type
   *   crosses the `'use server'` boundary happily — it erases — and is the one
   *   thing that keeps the two ends in step.
   */
  const [state, setState] = useState<HistoryState | { status: 'idle' }>({ status: 'idle' });
  const [pending, startTransition] = useTransition();

  const open = (): void => {
    dialog.current?.showModal();

    // Re-read every time it is opened. A record's history changes as the record
    // does, and a cached trail is a trail that quietly omits the edit just made.
    startTransition(async () => {
      setState(await readRecordHistory(slug, entityType, entityId));
    });
  };

  return (
    <>
      <button
        type="button"
        onClick={open}
        // py-1 keeps the target above the 24px minimum (apps/web/AGENTS.md).
        className="text-muted hover:text-drape py-1 text-[0.8125rem] underline-offset-2 hover:underline"
      >
        History
      </button>

      <HistoryDialog ref={dialog} label={label}>
        {pending && state.status === 'idle' ? (
          <p className="text-muted text-[0.8125rem]" role="status">
            Loading…
          </p>
        ) : null}

        {state.status === 'error' ? <Alert tone="error">{state.message}</Alert> : null}

        {state.status === 'ok' ? (
          <Trail history={state.history} timezone={state.timezone} timeFormat={state.timeFormat} />
        ) : null}
      </HistoryDialog>
    </>
  );
}

/**
 * The sheet every history opens in.
 *
 * ⚠️ EXPORTED, BECAUSE THERE IS A SECOND TRAIL AND IT MUST NOT LOOK DIFFERENT.
 *   The vitals drawer shows before/after VALUES, which `audit_logs` deliberately
 *   does not carry — a different endpoint and a different permission, but the
 *   same sheet, the same heading and the same close affordance. Two drawers that
 *   open the same way and look different is the failure this avoids.
 *
 * ⚠️ IT SCROLLS VERTICALLY AND MUST NEVER SCROLL HORIZONTALLY. A trail is a list
 *   of unknown length, so "fits without scrolling" is not a property it can have
 *   — what it CAN have is every line readable without dragging sideways, which is
 *   what `max-w-2xl`, wrapping values and a two-column grid buy. See `Change`.
 */
export function HistoryDialog({
  ref,
  label,
  children,
}: {
  ref: React.RefObject<HTMLDialogElement | null>;
  label: string;
  children: React.ReactNode;
}) {
  /*
   * A click on the backdrop closes it. `<dialog>` gives Escape for free but not
   * this, and the backdrop is the target everybody reaches for first.
   *
   * The test is on the dialog element itself rather than on a wrapper: the
   * backdrop is not a node, so a click on it lands on the dialog, while a click
   * anywhere inside lands on a descendant.
   */
  const onClick = (event: React.MouseEvent<HTMLDialogElement>): void => {
    if (event.target === ref.current) ref.current?.close();
  };

  return (
    <dialog
      ref={ref}
      onClick={onClick}
      aria-labelledby="record-history-title"
      /*
       * `open:flex` rather than `flex`: a `<dialog>` is `display: none` until
       * opened, and a flex utility would override that and leave it on screen.
       * `backdrop:` styles the ::backdrop pseudo-element.
       */
      /*
       * `max-w-2xl`, up from `max-w-md`. At 28rem a "was 120, now 80" line wrapped
       * three times and the sheet became a column of fragments; the extra width
       * is what lets a change render as one line.
       */
      className="open:flex bg-card text-ink ml-auto h-dvh max-h-dvh w-full max-w-2xl flex-col p-0 shadow-2xl backdrop:bg-ink/40"
    >
      <div className="border-rule flex items-start gap-4 border-b p-5">
        <div className="min-w-0">
          <p className="eyebrow text-drape">History</p>
          <h2
            id="record-history-title"
            className="font-display mt-1 truncate text-xl tracking-tight"
          >
            {label}
          </h2>
        </div>
        <button
          type="button"
          onClick={() => ref.current?.close()}
          className="text-muted hover:text-ink ml-auto shrink-0 px-2 py-1 text-[0.8125rem] underline underline-offset-2"
        >
          Close
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-5">{children}</div>
    </dialog>
  );
}

function Trail({
  history,
  timezone,
  timeFormat,
}: {
  history: AuditHistoryResponse;
  timezone: string;
  timeFormat: TimeFormat;
}) {
  if (history.entries.length === 0) {
    return (
      <p className="text-muted text-[0.875rem] leading-relaxed">
        Nothing recorded yet. Every change from here on appears here, with who made it and when,
        most recent first.
      </p>
    );
  }

  return (
    <>
      <ol className="grid gap-5">
        {history.entries.map((entry) => (
          <li key={entry.id}>
            <Entry entry={entry} timezone={timezone} timeFormat={timeFormat} />
          </li>
        ))}
      </ol>

      {history.truncated ? (
        <p className="border-rule text-muted mt-5 border-t pt-4 text-[0.75rem]">
          Older entries exist beyond this page.
        </p>
      ) : null}
    </>
  );
}

/** Past tense, because every one of these has already happened. */
const ACTION_LABEL: Record<AuditEntry['action'], string> = {
  CREATE: 'Created',
  UPDATE: 'Changed',
  DELETE: 'Removed',
  LOGIN: 'Signed in',
  LOGOUT: 'Signed out',
  EXPORT: 'Exported',
  SWITCH_BRANCH: 'Switched branch',
  IMPERSONATE: 'Opened by rcln staff',
  PERMISSION_CHANGE: 'Access changed',
};

function Entry({
  entry,
  timezone,
  timeFormat,
}: {
  entry: AuditEntry;
  timezone: string;
  timeFormat: TimeFormat;
}) {
  return (
    <article>
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
        <h3 className="text-ink text-[0.875rem] font-medium">{ACTION_LABEL[entry.action]}</h3>
        <p className="text-muted text-[0.8125rem]">
          {/* "by nobody" is wrong; the actor is genuinely unknown once the account
              is gone, and the row is kept precisely so the change is not lost. */}
          by {entry.actor?.fullName ?? 'a deleted account'}
          {entry.onBehalfOf ? (
            <>
              {' · '}
              <span className="text-signal">as rcln staff ({entry.onBehalfOf.fullName})</span>
            </>
          ) : null}
        </p>
      </div>

      {/*
        ⚠️ IN THE CLINIC'S ZONE, NOT THE READER'S, AND THAT IS A CHANGE. This used
          to render in whatever zone the browser was set to, with
          `suppressHydrationWarning` papering over the server disagreeing — the
          note said "the reader's clock is correct", which is true for a laptop
          and wrong for a record. "Edited at 16:40" has to mean the same 16:40 as
          the appointment it is about, or two screens describe one afternoon
          differently. Pinning the zone also makes the two renders agree, so the
          hydration suppression is gone rather than hidden.

          `dateTime` stays the raw instant, which is what a machine should read.
      */}
      <p className="text-muted mt-0.5 font-mono text-[0.75rem]">
        <time dateTime={entry.occurredAt}>
          {formatClinicDateTime(entry.occurredAt, timezone, timeFormat)}
        </time>
      </p>

      {entry.changes.length > 0 ? (
        <dl className="border-rule mt-2 grid gap-1.5 border-l pl-3">
          {entry.changes.map((change) => (
            /* The same two-column shape as the vitals trail, so the two drawers
               read alike: a fixed label column and a value column that wraps
               inside itself rather than pushing the sheet sideways. */
            <div key={change.field} className="grid gap-0.5 sm:grid-cols-[9rem_1fr] sm:gap-3">
              <dt className="text-muted text-[0.75rem]">{fieldLabel(change.field)}</dt>
              {/* `break-words` and `min-w-0`: an unbroken id or a long setting
                  value used to push the sheet sideways rather than wrap. */}
              <dd className="text-ink flex min-w-0 flex-wrap items-baseline gap-1.5 font-mono text-[0.75rem] break-words">
                {'before' in change ? (
                  <span className="text-muted line-through">{format(change.before)}</span>
                ) : null}
                {'before' in change && 'after' in change ? (
                  <span aria-hidden="true" className="text-muted">
                    →
                  </span>
                ) : null}
                {'after' in change ? <span>{format(change.after)}</span> : null}
                {/* Strikethrough and an arrow are not readable as "was, is" to a
                    screen reader (WCAG 1.4.1). */}
                <span className="sr-only">
                  {'before' in change && 'after' in change
                    ? `was ${format(change.before)}, now ${format(change.after)}`
                    : 'before' in change
                      ? `was ${format(change.before)}, now unset`
                      : `set to ${format(change.after)}`}
                </span>
              </dd>
            </div>
          ))}
        </dl>
      ) : null}
    </article>
  );
}

/**
 * `displayName` -> "display name". The API stores the column as it is written.
 *
 * ⚠️ A FEW KEYS ARE NOT COLUMN NAMES AND MUST NOT BE DE-CAMELED INTO NONSENSE.
 *   `has_note` became "has note" against a bare "yes", and `observations`
 *   rendered a JSON array. Both are shapes a service put on the row
 *   deliberately, and both read as gibberish under the generic rule — so the
 *   ones that exist get a written label, and everything else keeps the
 *   mechanical one.
 */
const FIELD_LABELS: Record<string, string> = {
  has_note: 'Note recorded',
  observations: 'Observations taken',
  amended: 'Measurements corrected',
  recorded_at: 'Taken at',
  appointment_id: 'Appointment',
  patient_id: 'Patient',

  /*
   * The invoice trail. Two shapes here are deliberate on the audit row and read
   * as nonsense without a written label:
   *
   *   - `…Minor` — money as an integer count of the currency's smallest unit,
   *     which is what `audit_logs` stores so a ledger figure cannot round on its
   *     way through JSON. The row does not reliably carry a currency (a diff
   *     holds only what MOVED), so this drawer cannot render ₹1,999.00 honestly
   *     and says which unit it is showing instead.
   *   - `hasNotes` / `hasCancellationReason` — booleans standing in for free
   *     text that must not reach this table. "Reason recorded: no → yes" is the
   *     auditable fact; the sentence itself is on the invoice.
   */
  lineCount: 'Lines',
  sourceType: 'Raised from',
  suppliedAt: 'Date of supply',
  invoiceNumber: 'Invoice number',
  customerTaxId: 'Customer’s tax number',
  subtotalMinor: 'Subtotal (smallest unit)',
  lineDiscountTotalMinor: 'Line discounts (smallest unit)',
  invoiceDiscountTotalMinor: 'Bill discount (smallest unit)',
  taxableAmountMinor: 'Taxable amount (smallest unit)',
  taxTotalMinor: 'Tax (smallest unit)',
  roundingAdjustmentMinor: 'Cash rounding (smallest unit)',
  grandTotalMinor: 'Grand total (smallest unit)',
  taxTreatment: 'Tax treatment',
  placeOfSupply: 'Place of supply',
  issuerTaxId: 'Issued under',
  issuerTaxRegistrationId: 'Registration',
  hasNotes: 'Note recorded',
  hasCancellationReason: 'Reason recorded',

  /* The rate card, whose rows have been auditable since Phase 9 unread. */
  registrationNumber: 'Registration number',
  effectiveFrom: 'In force from',
  effectiveTo: 'In force until',
  taxCategory: 'Category',
};

function fieldLabel(field: string): string {
  return (
    FIELD_LABELS[field] ??
    field
      .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
      .replace(/_/g, ' ')
      .toLowerCase()
  );
}

/** `systolic_mm_hg` -> "systolic". What a person calls the measurement. */
const MEASUREMENT_WORDS: Record<string, string> = {
  height: 'height',
  weight: 'weight',
  temperature: 'temperature',
  pulse: 'pulse',
  respiratory_rate: 'respiratory rate',
  blood_pressure: 'blood pressure',
  spo2: 'oxygen saturation',
  spo2_percent: 'oxygen saturation',
  blood_glucose: 'blood glucose',
  height_cm: 'height',
  weight_kg: 'weight',
  temperature_c: 'temperature',
  pulse_bpm: 'pulse',
  respiratory_rate_bpm: 'respiratory rate',
  systolic_mm_hg: 'systolic',
  diastolic_mm_hg: 'diastolic',
  blood_glucose_mg_dl: 'blood glucose',
};

/**
 * A stored value, as one line of text.
 *
 * Audit values are ids, codes and configuration — `recordAudit` redacts
 * credentials and CONVENTIONS.md forbids putting a name on the row — so there is
 * no formatting to do beyond making an object readable and an absence visible.
 */
function format(value: unknown): string {
  if (value === null || value === undefined) return 'not set';
  if (value === '') return 'empty';
  if (typeof value === 'boolean') return value ? 'yes' : 'no';

  /*
   * ⚠️ A LIST IS READ OUT, NOT JSON.stringify-D. `observations` and `amended`
   *   are both arrays of measurement names, and they rendered as
   *   `["systolic_mm_hg","diastolic_mm_hg"]` — brackets, quotes, underscores and
   *   all — in a drawer meant to be read by a clinic administrator. They are the
   *   only arrays this trail carries today; anything else still falls through to
   *   JSON rather than being guessed at.
   */
  if (Array.isArray(value)) {
    if (value.length === 0) return 'none';
    const words = value.map((item) =>
      typeof item === 'string' ? (MEASUREMENT_WORDS[item] ?? item.replace(/_/g, ' ')) : String(item)
    );
    const last = words.pop();
    return words.length === 0 ? String(last) : `${words.join(', ')} and ${String(last)}`;
  }

  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}
