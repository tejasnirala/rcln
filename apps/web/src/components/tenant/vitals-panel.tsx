'use client';

import { useActionState, useEffect, useState } from 'react';
import type { TemperatureUnit, TimeFormat, VitalRange, VitalsReading } from '@rcln/contracts';
import { VITAL_RANGES, fromCelsius, temperatureRangeFor, temperatureSymbol } from '@rcln/contracts';
import { Input, Textarea } from '@/components/ui/field';
import { formatClinicDateTime, formatClinicTime } from '@/lib/format';
import { Button } from '@/components/ui/button';
import { Alert } from '@/components/ui/alert';
import { VitalsHistory } from '@/components/tenant/vitals-history';
import {
  correctVitals,
  saveVitals,
  type VitalsState,
} from '@/app/(tenant)/t/[slug]/(app)/appointments/actions';

const IDLE: VitalsState = { status: 'idle' };

/**
 * The observations taken at one visit — the readings already recorded, and the
 * form for taking another.
 *
 * ⚠️ READINGS ACCUMULATE, AND CORRECTING ONE IS A DIFFERENT ACT FROM TAKING
 *   ANOTHER. A repeat blood pressure twenty minutes after a high first reading is
 *   a SECOND observation — the first is why the patient was sat down, and a chart
 *   that overwrote it would erase what the clinician saw when they decided.
 *   "Add a new record" does that. "Edit" is for a value that was never taken:
 *   1200 typed for 120. It amends in place, keeps the previous version, and every
 *   change is readable in the reading's own History drawer with both values.
 *
 * ⚠️ EVERY BOX IS DELIBERATELY EMPTY AND STAYS EMPTY. No box is pre-filled from
 *   the previous reading, however convenient that would be at the desk: a height
 *   carried forward is a measurement nobody took, and it looks exactly like one
 *   somebody did. "Not measured" and "measured, unchanged" must not render the
 *   same.
 *
 * Quiet and conventional, per apps/web/AGENTS.md — this is a dense data-entry
 * screen for someone working through a waiting room, so it is a plain grid of
 * native number inputs with the units in the labels.
 */
export function VitalsPanel({
  slug,
  appointmentId,
  vitals,
  canRecord,
  temperatureUnit,
  timezone,
  timeFormat,
}: {
  slug: string;
  appointmentId: string;
  vitals: VitalsReading[];
  /**
   * Whether this caller may take, correct or withdraw a reading — `clinical.vitals.record`.
   *
   * ⚠️ FALSE FOR A DOCTOR, AND THAT IS THE DESIGN. Seeing this panel needs
   *   `clinical.vitals.read`; writing in it needs the separate record code, which
   *   the front desk and the nurse hold and a doctor deliberately does not. A
   *   consultation reads the observations somebody else measured and signed for;
   *   it does not amend them. When this is false the panel is a chart: no form,
   *   no Edit, and the correction history still open to read.
   */
  canRecord: boolean;
  /**
   * The branch's zone, off the appointment.
   *
   * ⚠️ A READING IS STAMPED WITH AN INSTANT AND READ AS A WALL CLOCK. "Taken at
   *   16:40" has to mean the clinic's 16:40 — this line used to be a bare
   *   `toLocaleString()`, which is the container's UTC when the page is
   *   server-rendered. See `formatClinicTime`.
   */
  timezone: string;
  /** `12H` or `24H` — the clinic's clock face. Display only; see `formatClinicTime`. */
  timeFormat: TimeFormat;
  /**
   * What a clinician HERE writes a temperature in, from the clinic's country.
   *
   * ⚠️ DISPLAY AND DATA ENTRY ONLY. Every reading is stored in Celsius whatever
   *   this says — see `temperature_c` in schema.prisma. This prop decides the
   *   label, the range on the box and how the recorded value reads back; the
   *   conversion happens in `saveVitals`, which resolves the unit from the
   *   session itself rather than trusting anything the form sends.
   */
  temperatureUnit: TemperatureUnit;
}) {
  /*
   * ⚠️ TWO COMPONENTS, NOT ONE COMPONENT WITH FOUR `canRecord &&` GUARDS IN IT.
   *   That is what this was, and it is the wrong shape for a permission this
   *   consequential: the form, the "Add a new record" button and the per-reading
   *   Edit each tested the flag separately, so the read-only guarantee was four
   *   conditions that all had to stay right, in a component somebody will edit
   *   again to add a tenth measurement. Forgetting one puts a write control in
   *   front of a doctor who cannot use it, and the API's 403 is the only thing
   *   that would notice.
   *
   *   Split this way the guarantee is structural. `VitalsChart` does not import
   *   `ReadingForm`, has no `mode` state and takes no edit handler — there is
   *   nothing in that subtree to leak, and no future edit can add one without
   *   deliberately crossing back over this boundary.
   *
   * ⚠️ THE UI IS NOT THE CONTROL. `clinical.vitals.record` is enforced on every
   *   write route in appointments.routes.ts; this decides what is worth drawing.
   */
  return canRecord ? (
    <RecordableVitals
      slug={slug}
      appointmentId={appointmentId}
      vitals={vitals}
      timezone={timezone}
      timeFormat={timeFormat}
      temperatureUnit={temperatureUnit}
    />
  ) : (
    <VitalsChart
      slug={slug}
      appointmentId={appointmentId}
      vitals={vitals}
      timezone={timezone}
      timeFormat={timeFormat}
      temperatureUnit={temperatureUnit}
    />
  );
}

/**
 * The doctor's view: the observations, and no way to touch them.
 *
 * ⚠️ THE ONE ROLE THAT READS A CHART IT CANNOT WRITE, AND THE SCREEN SHOULD SAY
 *   SO RATHER THAN JUST BE MISSING BUTTONS. A consultation is what the doctor is
 *   here for; the cuff and the scales belong to whoever was with the patient
 *   beforehand. A panel that silently lacks an Edit reads as a page that has
 *   failed to finish loading — naming the desk turns it into a fact about how
 *   the clinic works.
 *
 * The correction history stays open: what a reading WAS before somebody fixed it
 * is part of reading it, and it is exactly what a clinician needs when a number
 * looks wrong.
 */
function VitalsChart({
  slug,
  appointmentId,
  vitals,
  timezone,
  timeFormat,
  temperatureUnit,
}: {
  slug: string;
  appointmentId: string;
  vitals: VitalsReading[];
  timezone: string;
  timeFormat: TimeFormat;
  temperatureUnit: TemperatureUnit;
}) {
  return (
    <section className="border-rule bg-card mt-4 rounded-lg border p-5">
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <h2 className="eyebrow text-drape">Vitals</h2>
        {vitals.length > 0 ? (
          <p className="text-muted text-[0.75rem]">Recorded at the front desk</p>
        ) : null}
      </div>

      {vitals.length === 0 ? (
        /*
         * Stated, not left blank. An empty space reads as "normal"; "nobody has
         * taken them" is a different and more useful answer — and for a reader
         * who cannot fix it, saying whose job it is turns a dead end into an
         * instruction: ask for them before you start.
         */
        <p className="text-muted mt-3 text-[0.8125rem]">
          Vitals have not been recorded for this visit yet. They are taken at the front desk before
          the patient comes in.
        </p>
      ) : (
        <Readings
          slug={slug}
          appointmentId={appointmentId}
          vitals={vitals}
          timezone={timezone}
          timeFormat={timeFormat}
          temperatureUnit={temperatureUnit}
        />
      )}
    </section>
  );
}

/** The front desk's and the nurse's view: the same readings, plus the form. */
function RecordableVitals({
  slug,
  appointmentId,
  vitals,
  timezone,
  timeFormat,
  temperatureUnit,
}: {
  slug: string;
  appointmentId: string;
  vitals: VitalsReading[];
  timezone: string;
  timeFormat: TimeFormat;
  temperatureUnit: TemperatureUnit;
}) {
  /*
   * ⚠️ THE FORM IS A MODE, NOT A FIXTURE, AND THE DEFAULT DEPENDS ON WHETHER
   *   THERE IS ANYTHING YET. On a visit with no readings the form IS the screen —
   *   taking the vitals is the only reason anyone opened it, and hiding it behind
   *   a button would be a click before every single patient. Once a reading
   *   exists the readings are the screen, and the form goes back behind "Add a
   *   new record" so the numbers already taken are not buried under nine empty
   *   boxes.
   *
   * ⚠️ THE INITIAL MODE IS `closed`, AND `open` DERIVES THE EMPTY-VISIT CASE
   *   RATHER THAN SEEDING IT. Starting at `{ kind: 'new' }` made the form open on
   *   a visit that already HAD readings — the state said "new" from the first
   *   render and nothing had happened to close it. Deriving it means the two
   *   cases cannot disagree, and there is no initial state to keep in step with
   *   a prop.
   */
  const [mode, setMode] = useState<Mode>({ kind: 'closed' });
  const editing = mode.kind === 'edit' ? vitals.find((v) => v.id === mode.id) : undefined;
  const open = vitals.length === 0 || mode.kind !== 'closed';

  return (
    <section className="border-rule bg-card mt-4 rounded-lg border p-5">
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <h2 className="eyebrow text-drape">Vitals</h2>
        {vitals.length > 0 && mode.kind === 'closed' ? (
          <Button size="sm" onClick={() => setMode({ kind: 'new' })}>
            Add a new record
          </Button>
        ) : null}
      </div>

      {vitals.length === 0 ? (
        <p className="text-muted mt-3 text-[0.8125rem]">No readings taken at this visit yet.</p>
      ) : (
        <Readings
          slug={slug}
          appointmentId={appointmentId}
          vitals={vitals}
          timezone={timezone}
          timeFormat={timeFormat}
          temperatureUnit={temperatureUnit}
          action={(reading) => {
            const editingThis = mode.kind === 'edit' && mode.id === reading.id;
            return (
              <Button
                size="sm"
                variant="secondary"
                aria-expanded={editingThis}
                onClick={() =>
                  setMode(editingThis ? { kind: 'closed' } : { kind: 'edit', id: reading.id })
                }
              >
                {editingThis ? 'Cancel' : 'Edit'}
              </Button>
            );
          }}
        />
      )}

      {open ? (
        /*
         * ⚠️ `key` REMOUNTS THE FORM WHEN THE TARGET CHANGES. The boxes are
         *   uncontrolled — `defaultValue` — so React keeps whatever is in them
         *   across a re-render. Without this, pressing Edit on a second reading
         *   would leave the first one's numbers on screen under the second one's
         *   heading, which is the worst possible failure on this particular form.
         */
        <ReadingForm
          key={editing?.id ?? 'new'}
          slug={slug}
          appointmentId={appointmentId}
          editing={editing}
          temperatureUnit={temperatureUnit}
          dismissible={vitals.length > 0}
          onDone={() => setMode({ kind: 'closed' })}
        />
      ) : null}
    </section>
  );
}

/**
 * The readings themselves, identical for both callers.
 *
 * ⚠️ `action` IS THE WHOLE PERMISSION BOUNDARY, AND IT IS AN ABSENCE RATHER THAN
 *   A FLAG. A caller that may not write simply does not pass one, so the Edit
 *   control does not exist in that tree — there is no `canEdit={false}` to get
 *   backwards and no condition to forget. The history drawer is unconditional
 *   because reading a correction is reading, not writing.
 */
function Readings({
  slug,
  appointmentId,
  vitals,
  timezone,
  timeFormat,
  temperatureUnit,
  action,
}: {
  slug: string;
  appointmentId: string;
  vitals: VitalsReading[];
  timezone: string;
  timeFormat: TimeFormat;
  temperatureUnit: TemperatureUnit;
  action?: (reading: VitalsReading) => React.ReactNode;
}) {
  return (
    <ul className="mt-3 space-y-3">
      {vitals.map((reading) => (
        <li key={reading.id} className="border-rule border-t pt-3 first:border-t-0 first:pt-0">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0">
              <p className="font-mono text-[0.875rem]">{summarise(reading, temperatureUnit)}</p>
              <p className="text-muted mt-0.5 text-[0.75rem]">
                {formatClinicDateTime(reading.recordedAt, timezone, timeFormat)}
                {reading.recordedByName !== null ? ` · ${reading.recordedByName}` : ''}
              </p>
              {reading.notes !== null ? (
                <p className="text-muted mt-1 text-[0.8125rem]">{reading.notes}</p>
              ) : null}
            </div>

            <div className="flex shrink-0 items-center gap-3">
              {action?.(reading)}
              {/*
                ⚠️ THE VITALS TRAIL, NOT THE GENERIC AUDIT ONE. `RecordHistory`
                  reads `audit_logs`, which deliberately carries no
                  measurements — it can say a blood pressure was corrected,
                  never that it went from 180 to 120. This reads the clinical
                  side, where the values are, behind the same permission that
                  shows the reading itself.

                ⚠️ THE LABEL IS THE TIME, NEVER THE PATIENT. It is the sheet's
                  heading, and CONVENTIONS.md forbids a patient name reaching
                  a history surface at all.
              */}
              <VitalsHistory
                slug={slug}
                appointmentId={appointmentId}
                vitalsId={reading.id}
                label={`Reading at ${formatClinicTime(reading.recordedAt, timezone, timeFormat)}`}
                timezone={timezone}
                timeFormat={timeFormat}
                temperatureUnit={temperatureUnit}
              />
            </div>
          </div>
        </li>
      ))}
    </ul>
  );
}

/** Which form is on screen, if any. */
type Mode = { kind: 'closed' } | { kind: 'new' } | { kind: 'edit'; id: string };

/**
 * The nine boxes — for a new reading, or for correcting one already taken.
 *
 * ⚠️ ONE FORM FOR BOTH, AND ONLY THE ACTION DIFFERS. A separate "edit" form is a
 *   second set of bounds, a second set of labels and a second chance for the
 *   correction to accept something the original refused. What changes is where
 *   it posts and what the boxes start with.
 *
 * ⚠️ CORRECTING IS NOT RECORDING, AND THE COPY SAYS SO. A repeat blood pressure
 *   twenty minutes after a high first reading is a NEW reading — the first is why
 *   the patient was sat down, and it stays on the chart. This is for a value that
 *   was never taken: 1200 typed for 120. The heading, the button and the note
 *   under it all name which of the two is happening.
 */
function ReadingForm({
  slug,
  appointmentId,
  editing,
  temperatureUnit,
  dismissible,
  onDone,
}: {
  slug: string;
  appointmentId: string;
  /** The reading being corrected, or undefined for a new one. */
  editing: VitalsReading | undefined;
  temperatureUnit: TemperatureUnit;
  /** False on a visit with no readings — there is nothing to go back to. */
  dismissible: boolean;
  onDone: () => void;
}) {
  const [state, action, pending] = useActionState(
    editing === undefined
      ? saveVitals.bind(null, slug, appointmentId)
      : correctVitals.bind(null, slug, appointmentId, editing.id),
    IDLE
  );

  /*
   * Closing on success is what makes the panel feel like a record rather than a
   * form: the corrected numbers appear in the list above and the boxes go away.
   * The parent re-renders from the server's data, so there is nothing stale to
   * leave behind.
   */
  useEffect(() => {
    if (state.status === 'saved') onDone();
  }, [state.status, onDone]);

  /*
   * ⚠️ THE STORED VALUE, CONVERTED BACK INTO THE UNIT THIS CLINIC TYPES IN.
   *   Every other box is populated with what is stored; this one cannot be, or a
   *   nurse in India would open a correction form showing 37.44 where she typed
   *   99.4 — and "correct" it to 37.44°F.
   */
  const startingTemperature =
    editing?.temperatureC == null ? '' : String(fromCelsius(editing.temperatureC, temperatureUnit));

  const initial = (value: number | null | undefined): string | undefined =>
    value === null || value === undefined ? '' : String(value);

  return (
    <form action={action} className="mt-5">
      <h3 className="text-[0.9375rem]">
        {editing === undefined ? 'Record a reading' : 'Correct this reading'}
      </h3>
      <p className="text-muted mt-1 text-[0.8125rem]">
        {editing === undefined
          ? 'Leave anything you did not measure blank. Saving a reading also checks the patient in.'
          : 'For fixing a number that was typed wrongly. A repeat measurement is a new reading, not a correction — go back and add one. What changes here is recorded against your name.'}
      </p>

      {state.status === 'error' && state.message ? (
        <div className="mt-3">
          <Alert tone="error">{state.message}</Alert>
        </div>
      ) : null}

      <div className="mt-4 grid grid-cols-2 gap-4 sm:grid-cols-3">
        {/*
         * ⚠️ EVERY BOX TAKES ITS `min`, `max` AND `step` FROM `VITAL_RANGES`,
         *   WHICH IS ALSO WHAT THE CONTRACT ENFORCES. They used to be bare
         *   `type="number"` boxes with no bounds at all, so a pulse of -5 or a
         *   saturation of 900 could be typed, submitted, and only then refused —
         *   by a sentence that read "Too small: expected number to be >=20". The
         *   value never reached the database; what was missing was the form
         *   knowing what the API knew. `boxFor` is that link, and it is why the
         *   two cannot drift.
         *
         * ⚠️ THE FORM IS THE COURTESY, THE CONTRACT IS THE AUTHORITY. `min` and
         *   `max` are hints a paste or an older browser can walk past, which is
         *   fine: `recordVitalsRequest` re-checks every one of them server-side
         *   and is what actually decides.
         *
         * ⚠️ `defaultValue`, NOT `value`. These are uncontrolled boxes seeded
         *   once — a controlled field would need state per measurement for no
         *   gain, and `key` on the form already handles switching target.
         */}
        <Input
          name="systolicMmHg"
          label="Systolic (mmHg)"
          {...boxFor(VITAL_RANGES.systolicMmHg)}
          defaultValue={initial(editing?.systolicMmHg)}
          errors={state.fieldErrors?.['systolicMmHg']}
        />
        <Input
          name="diastolicMmHg"
          label="Diastolic (mmHg)"
          {...boxFor(VITAL_RANGES.diastolicMmHg)}
          defaultValue={initial(editing?.diastolicMmHg)}
          hint="Both halves, or neither."
          errors={state.fieldErrors?.['diastolicMmHg']}
        />
        <Input
          name="pulseBpm"
          label="Pulse (bpm)"
          {...boxFor(VITAL_RANGES.pulseBpm)}
          defaultValue={initial(editing?.pulseBpm)}
          errors={state.fieldErrors?.['pulseBpm']}
        />
        {/*
          ⚠️ THE BOX IS `temperature`, NOT `temperatureC`. What it holds depends
            on where the clinic is, so a name that states a unit would be a lie in
            half the countries in `COUNTRIES`. The action converts it to Celsius
            before the contract ever sees it — and its bounds are the Celsius ones
            converted, never a second pair typed out by hand.
        */}
        <Input
          name="temperature"
          label={`Temperature (${temperatureSymbol(temperatureUnit)})`}
          {...boxFor(temperatureRangeFor(temperatureUnit))}
          defaultValue={startingTemperature}
          errors={state.fieldErrors?.['temperature']}
        />
        <Input
          name="spo2Percent"
          label="SpO₂ (%)"
          {...boxFor(VITAL_RANGES.spo2Percent)}
          defaultValue={initial(editing?.spo2Percent)}
          errors={state.fieldErrors?.['spo2Percent']}
        />
        <Input
          name="respiratoryRateBpm"
          label="Respiratory rate"
          {...boxFor(VITAL_RANGES.respiratoryRateBpm)}
          defaultValue={initial(editing?.respiratoryRateBpm)}
          errors={state.fieldErrors?.['respiratoryRateBpm']}
        />
        <Input
          name="heightCm"
          label="Height (cm)"
          {...boxFor(VITAL_RANGES.heightCm)}
          defaultValue={initial(editing?.heightCm)}
          errors={state.fieldErrors?.['heightCm']}
        />
        <Input
          name="weightKg"
          label="Weight (kg)"
          {...boxFor(VITAL_RANGES.weightKg)}
          defaultValue={initial(editing?.weightKg)}
          errors={state.fieldErrors?.['weightKg']}
        />
        <Input
          name="bloodGlucoseMgDl"
          label="Blood glucose (mg/dL)"
          {...boxFor(VITAL_RANGES.bloodGlucoseMgDl)}
          defaultValue={initial(editing?.bloodGlucoseMgDl)}
          errors={state.fieldErrors?.['bloodGlucoseMgDl']}
        />
      </div>

      <Textarea
        name="notes"
        label="Note"
        rows={2}
        className="mt-4"
        defaultValue={editing?.notes ?? ''}
        hint="Anything that changes how these numbers should be read."
      />

      <div className="mt-4 flex flex-wrap gap-2">
        <Button type="submit" disabled={pending}>
          {pending ? 'Saving…' : editing === undefined ? 'Record reading' : 'Save the correction'}
        </Button>
        {dismissible ? (
          <Button type="button" variant="secondary" onClick={onDone}>
            Cancel
          </Button>
        ) : null}
      </div>
    </form>
  );
}

/**
 * The native-input props for one measurement, from its one entry in
 * `VITAL_RANGES`.
 *
 * ⚠️ `inputMode`, NOT A BARE SPINNER, AND THE ORIGINAL REASON STILL HOLDS: a
 *   scroll wheel over a focused `type="number"` silently changes the value, and
 *   on a form of clinical numbers that is a reading nobody typed. `inputMode`
 *   brings up the right keypad on a phone without inviting that.
 */
function boxFor(range: VitalRange): {
  type: 'number';
  min: number;
  max: number;
  step: number;
  inputMode: 'numeric' | 'decimal';
} {
  return {
    type: 'number',
    min: range.min,
    max: range.max,
    step: range.step,
    inputMode: range.step === 1 ? 'numeric' : 'decimal',
  };
}

/**
 * One reading on one line, in the order a clinician scans for.
 *
 * BMI is shown where both height and weight are present — the API derives it and
 * never stores it, so it is always consistent with the two numbers beside it.
 */
function summarise(reading: VitalsReading, unit: TemperatureUnit): string {
  const parts: string[] = [];

  if (reading.systolicMmHg !== null && reading.diastolicMmHg !== null) {
    parts.push(`BP ${reading.systolicMmHg}/${reading.diastolicMmHg}`);
  }
  if (reading.pulseBpm !== null) parts.push(`Pulse ${reading.pulseBpm}`);
  /*
   * ⚠️ CONVERTED FOR DISPLAY, AND THE UNIT IS ALWAYS PRINTED BESIDE IT. A bare
   *   "Temp 37.4" on a screen where the nurse typed 99.4 is the reading nobody
   *   trusts; "99.4°F" is the number they wrote down.
   */
  if (reading.temperatureC !== null) {
    parts.push(`Temp ${String(fromCelsius(reading.temperatureC, unit))}${temperatureSymbol(unit)}`);
  }
  if (reading.spo2Percent !== null) parts.push(`SpO₂ ${reading.spo2Percent}%`);
  if (reading.respiratoryRateBpm !== null) parts.push(`RR ${reading.respiratoryRateBpm}`);
  if (reading.heightCm !== null) parts.push(`Ht ${reading.heightCm} cm`);
  if (reading.weightKg !== null) parts.push(`Wt ${reading.weightKg} kg`);
  if (reading.bmi !== null) parts.push(`BMI ${reading.bmi}`);
  if (reading.bloodGlucoseMgDl !== null) parts.push(`Glucose ${reading.bloodGlucoseMgDl} mg/dL`);

  return parts.join('  ·  ');
}
