'use client';

import { useRef, useState, useTransition } from 'react';
import type { TemperatureUnit, TimeFormat, VitalsChange, VitalsRevision } from '@rcln/contracts';
import { VITAL_RANGES, fromCelsius, temperatureSymbol } from '@rcln/contracts';
import { Alert } from '@/components/ui/alert';
import { HistoryDialog } from '@/components/tenant/record-history';
import { formatClinicDateTime } from '@/lib/format';
import { loadVitalsRevisions } from '@/app/(tenant)/t/[slug]/(app)/appointments/actions';

/**
 * Every correction ever made to one reading — what changed, from what, to what,
 * and by whom.
 *
 * ⚠️ A DIFFERENT TRAIL FROM `RecordHistory`, AND DELIBERATELY SO. That one reads
 *   `audit_logs`, which is behind `audit.record.read` — a compliance code held by
 *   people with no clinical access — and therefore carries no measurements at
 *   all: it can say a blood pressure was corrected, never that it went from 180
 *   to 120. Both facts are needed and they cannot live in the same table, so the
 *   values come from the clinical side instead: `clinical.vitals.read`, and the
 *   read is logged in `data_access_logs` like any other read of a patient's
 *   observations.
 *
 * ⚠️ IT IS THE SAME SHEET, ON PURPOSE. Two history drawers that open the same way
 *   and look different is worse than either.
 *
 * ⚠️ THE NUMBERS ARE SHOWN IN THE UNIT THE CLINIC TYPES IN. A temperature is
 *   stored in Celsius everywhere; a trail that showed 37.44 to a nurse who typed
 *   99.4 would be a trail she cannot check her own correction against.
 *
 * ⚠️ NEWEST CORRECTION FIRST, matching the audit drawer. "What was changed last?"
 *   is the question somebody opening a trail has; a correction from three weeks
 *   ago is context rather than the answer. The ordering is the API's — the
 *   service pairs the versions chronologically and reverses afterwards, because
 *   each stored version is the state BEFORE one correction and the pairing only
 *   holds while the list runs forwards.
 *
 * FETCHED ON OPEN, like the audit drawer, for the same reason: a visit with four
 * readings would otherwise cost four PHI reads to render four buttons nobody
 * pressed.
 */

/** What each measurement is called on the form, so the trail says the same thing. */
const FIELD_LABELS: Record<string, string> = {
  heightCm: 'Height',
  weightKg: 'Weight',
  temperatureC: 'Temperature',
  pulseBpm: 'Pulse',
  respiratoryRateBpm: 'Respiratory rate',
  systolicMmHg: 'Systolic',
  diastolicMmHg: 'Diastolic',
  spo2Percent: 'SpO₂',
  bloodGlucoseMgDl: 'Blood glucose',
};

type State =
  { status: 'idle' } | { status: 'ok'; revisions: VitalsRevision[] } | { status: 'error' };

export function VitalsHistory({
  slug,
  appointmentId,
  vitalsId,
  /** The reading's time, as the sheet's heading. ⚠️ NEVER the patient's name. */
  label,
  timezone,
  timeFormat,
  temperatureUnit,
}: {
  slug: string;
  appointmentId: string;
  vitalsId: string;
  label: string;
  timezone: string;
  timeFormat: TimeFormat;
  temperatureUnit: TemperatureUnit;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [state, setState] = useState<State>({ status: 'idle' });
  const [pending, startTransition] = useTransition();

  const open = (): void => {
    dialog.current?.showModal();

    // Re-read on every open: a reading changes as somebody corrects it, and a
    // cached trail is a trail that quietly omits the correction just made.
    startTransition(async () => {
      const revisions = await loadVitalsRevisions(slug, appointmentId, vitalsId);
      setState(revisions === null ? { status: 'error' } : { status: 'ok', revisions });
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

        {state.status === 'error' ? (
          <Alert tone="error">This reading&rsquo;s history could not be loaded.</Alert>
        ) : null}

        {state.status === 'ok' ? (
          state.revisions.length === 0 ? (
            <p className="text-muted text-[0.875rem] leading-relaxed">
              This reading has not been corrected. If it ever is, every correction appears here —
              what changed, from what to what, who changed it and when — with the most recent first.
            </p>
          ) : (
            <ol className="grid gap-5">
              {state.revisions.map((revision) => (
                <li key={revision.id}>
                  <Revision
                    revision={revision}
                    timezone={timezone}
                    timeFormat={timeFormat}
                    temperatureUnit={temperatureUnit}
                  />
                </li>
              ))}
            </ol>
          )
        ) : null}
      </HistoryDialog>
    </>
  );
}

function Revision({
  revision,
  timezone,
  timeFormat,
  temperatureUnit,
}: {
  revision: VitalsRevision;
  timezone: string;
  timeFormat: TimeFormat;
  temperatureUnit: TemperatureUnit;
}) {
  return (
    <article>
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
        <h3 className="text-ink text-[0.875rem] font-medium">Corrected</h3>
        <p className="text-muted text-[0.8125rem]">
          {/* "by nobody" is wrong; the actor is genuinely unknown once the
              account is gone, and the correction is kept precisely so it is not
              lost with them. */}
          by {revision.supersededByName ?? 'a deleted account'}
        </p>
      </div>

      <p className="text-muted mt-0.5 font-mono text-[0.75rem]">
        <time dateTime={revision.supersededAt}>
          {formatClinicDateTime(revision.supersededAt, timezone, timeFormat)}
        </time>
      </p>

      {revision.changes.length > 0 || revision.noteChanged ? (
        /*
         * ⚠️ A TWO-COLUMN GRID, NOT A RUN-ON LINE. "Systolic was 180, now 120"
         *   as flowing text wrapped mid-value in a narrow sheet and turned a
         *   trail into a paragraph. The label column is fixed, the value column
         *   takes the rest and wraps inside itself, so nothing ever scrolls
         *   sideways.
         */
        <dl className="border-rule mt-2 grid gap-1.5 border-l pl-3">
          {revision.changes.map((change) => (
            <Change key={change.field} change={change} temperatureUnit={temperatureUnit} />
          ))}
          {revision.noteChanged ? (
            <div className="grid gap-0.5">
              <dt className="text-muted text-[0.75rem]">Note</dt>
              <dd className="text-ink min-w-0 text-[0.75rem] break-words">
                <span className="text-muted line-through">{revision.noteBefore ?? 'not set'}</span>{' '}
                <span aria-hidden="true" className="text-muted">
                  →
                </span>{' '}
                <span>{revision.noteAfter ?? 'not set'}</span>
                <span className="sr-only">
                  was {revision.noteBefore ?? 'not set'}, now {revision.noteAfter ?? 'not set'}
                </span>
              </dd>
            </div>
          ) : null}
        </dl>
      ) : (
        <p className="text-muted mt-2 text-[0.75rem]">Saved without changing any measurement.</p>
      )}
    </article>
  );
}

/**
 * One measurement that moved.
 *
 * ⚠️ STRIKETHROUGH AND AN ARROW ARE NOT READABLE AS "WAS, IS" TO A SCREEN READER
 *   (WCAG 1.4.1), so the same fact is stated in words in an `sr-only` span —
 *   the same arrangement `RecordHistory` uses.
 */
function Change({
  change,
  temperatureUnit,
}: {
  change: VitalsChange;
  temperatureUnit: TemperatureUnit;
}) {
  const label = FIELD_LABELS[change.field] ?? change.field;
  const before = display(change.field, change.before, temperatureUnit);
  const after = display(change.field, change.after, temperatureUnit);

  return (
    <div className="grid gap-0.5 sm:grid-cols-[9rem_1fr] sm:gap-3">
      <dt className="text-muted text-[0.75rem]">{label}</dt>
      <dd className="text-ink flex min-w-0 flex-wrap items-baseline gap-1.5 font-mono text-[0.75rem] break-words">
        <span className="text-muted line-through">{before}</span>
        <span aria-hidden="true" className="text-muted">
          →
        </span>
        <span className="font-medium">{after}</span>
        <span className="sr-only">
          was {before}, now {after}
        </span>
      </dd>
    </div>
  );
}

/**
 * A stored value as the clinic reads it: converted where the unit is the
 * clinic's, and with the unit printed so a bare number is never ambiguous.
 */
function display(field: string, value: number | null, unit: TemperatureUnit): string {
  if (value === null) return 'not recorded';

  if (field === 'temperatureC') {
    return `${String(fromCelsius(value, unit))}${temperatureSymbol(unit)}`;
  }

  const range = VITAL_RANGES[field as keyof typeof VITAL_RANGES];
  if (range === undefined) return String(value);

  // No space before a percent sign, a space before a word. Same rule as
  // `vitalRangeMessage`, which writes the same units into its own sentence.
  return range.unit === '%' ? `${String(value)}%` : `${String(value)} ${range.unit}`;
}
