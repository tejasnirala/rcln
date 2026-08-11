'use client';

import { useActionState, useEffect, useRef, useState } from 'react';
import type {
  BranchDetail,
  FeeScheduleView,
  QualificationSummary,
  SpecialtySummary,
} from '@rcln/contracts';
import { KNOWN_FEE_TYPES } from '@rcln/contracts';
import { Alert, useOutcomeFocus } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Input, Select, Textarea, type SelectOption } from '@/components/ui/field';
import { ClassificationPicker } from '@/components/tenant/classification-picker';
import { createDoctor, type DoctorFormState } from '@/app/(tenant)/t/[slug]/(app)/doctors/actions';

/**
 * Registering a doctor — the whole practitioner, in one sitting.
 *
 * ⚠️ THIS USED TO BE FOUR FIELDS, AND THAT WAS THE BUG. A doctor was created with
 *   a name and a council number, and their working hours, degrees, prices and pay
 *   were four separate journeys afterwards — so in practice the clinic saved the
 *   profile and stopped. A doctor with no working hours offers no bookable slots
 *   at all, which the front desk discovers while a patient is on the phone.
 *   Everything the clinic knows at the moment of registration is asked for at the
 *   moment of registration.
 *
 * ⚠️ ONE `<form>`, ONE SUBMISSION, ONE TRANSACTION. The API creates all of it or
 *   none of it (`createDoctorRequest`), so a rejected block of hours does not
 *   leave a half-registered consultant behind for nobody to clean up.
 *
 * ⚠️ EVERY OPTIONAL SECTION IS PERMISSION-GATED, AND HIDDEN RATHER THAN DISABLED.
 *   The API refuses a section the caller may not set — it does not silently drop
 *   it — so offering a greyed-out salary box would advertise a door that is
 *   locked, and offering a live one would produce a 403 after a long form.
 *
 * Quiet and conventional, per apps/web/AGENTS.md: this is dense data entry for
 * someone onboarding a colleague, so it reuses the card, the field vocabulary and
 * the section rhythm the rest of the app already has. The only structure added is
 * the numbered `Section`, which exists because a form this long needs somewhere
 * for the eye to rest.
 */

const IDLE: DoctorFormState = { status: 'idle' };

/**
 * Sunday first, matching `dayOfWeek` 0–6 in the contract, which in turn matches
 * Postgres `extract(dow)`. Not a display preference — renumbering here would
 * silently shift every stored day.
 */
const DAYS = [
  'Sunday',
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
] as const;

const DAY_OPTIONS: SelectOption[] = DAYS.map((day, index) => ({
  value: String(index),
  label: day,
}));

/** Blank inherits the clinic's setting rather than pinning a number (ADR-0015). */
const SLOT_LENGTHS: SelectOption[] = [10, 15, 20, 30, 45, 60].map((minutes) => ({
  value: String(minutes),
  label: `${String(minutes)} min`,
}));

const INTERVALS: SelectOption[] = [
  { value: 'MONTHLY', label: 'A month' },
  { value: 'FORTNIGHTLY', label: 'A fortnight' },
  { value: 'WEEKLY', label: 'A week' },
  { value: 'DAILY', label: 'A day' },
  { value: 'HOURLY', label: 'An hour' },
  { value: 'PER_SESSION', label: 'A session' },
];

/** The words a clinic uses for a visit, not the enum. */
const FEE_WORDS: Record<string, string> = {
  NEW: 'First visit',
  FOLLOW_UP: 'Follow-up',
  WALK_IN: 'Walk-in',
  TELECONSULT: 'Video consultation',
  PROCEDURE: 'Procedure',
  RESCHEDULE: 'Moving an appointment',
};

/** One block of working hours, as the form holds it before it is serialised. */
interface HoursRow {
  /** Local only — React needs a stable key that survives removing a middle row. */
  key: string;
  branchId: string;
  dayOfWeek: string;
  startTime: string;
  endTime: string;
  slotMinutes: string;
  maxPatients: string;
  validFrom: string;
}

interface DegreeRow {
  key: string;
  qualificationId: string;
  institute: string;
  yearOfCompletion: string;
}

let rowSeq = 0;
const nextKey = (): string => {
  rowSeq += 1;
  return `row-${String(rowSeq)}`;
};

export function DoctorCreateForm({
  slug,
  candidates,
  specialties,
  qualifications,
  branches,
  fees,
  canManageSchedules,
  canManageQualifications,
  canManageFees,
  canManagePay,
  onDone,
  onCancel,
}: {
  slug: string;
  candidates: { userId: string; fullName: string }[];
  specialties: SpecialtySummary[];
  qualifications: QualificationSummary[];
  branches: BranchDetail[];
  /**
   * The clinic's own price sheet, for the currency and the inherited defaults.
   *
   * Null when the caller may not read fees, which also removes the fee section —
   * see the permission note in the header.
   */
  fees: FeeScheduleView | null;
  canManageSchedules: boolean;
  canManageQualifications: boolean;
  canManageFees: boolean;
  canManagePay: boolean;
  onDone: () => void;
  onCancel: () => void;
}) {
  const [state, action, pending] = useActionState(createDoctor.bind(null, slug), IDLE);
  const formRef = useRef<HTMLFormElement>(null);
  useOutcomeFocus(state.status, formRef);

  useEffect(() => {
    if (state.status === 'saved') onDone();
  }, [state.status, onDone]);

  /*
   * Today in the browser's zone, read once at mount rather than in the render
   * body — a clock read during render differs between the server pass and
   * hydration, which the React Compiler rejects and which would flip the default
   * on a form opened near midnight. It is only a default for a date the user can
   * change; the branch's zone decides what the stored day means.
   */
  const [today] = useState(() => new Date().toISOString().slice(0, 10));

  const [hours, setHours] = useState<HoursRow[]>([]);
  const [degrees, setDegrees] = useState<DegreeRow[]>([]);

  const branchOptions: SelectOption[] = branches.map((b) => ({ value: b.id, label: b.name }));
  const qualificationOptions: SelectOption[] = qualifications.map((q) => ({
    value: q.id,
    label: q.name,
  }));

  /*
   * The repeatable sections travel as ONE JSON field each, the same shape the
   * classification picker already uses and for the same reason: indexed input
   * names (`schedules[0][startTime]`) silently renumber when a middle row is
   * removed, and have to be reassembled into an array by hand on the server.
   * Nothing is trusted for being well-formed — the action re-validates both with
   * the same Zod schema the API enforces.
   */
  const hoursPayload = JSON.stringify(
    hours
      .filter((row) => row.branchId !== '' && row.startTime !== '' && row.endTime !== '')
      .map((row) => ({
        branchId: row.branchId,
        dayOfWeek: Number(row.dayOfWeek),
        startTime: row.startTime,
        endTime: row.endTime,
        ...(row.slotMinutes !== '' ? { slotMinutes: Number(row.slotMinutes) } : {}),
        ...(row.maxPatients !== '' ? { maxPatients: Number(row.maxPatients) } : {}),
        validFrom: row.validFrom,
        isActive: true,
      }))
  );

  const degreesPayload = JSON.stringify(
    degrees
      .filter((row) => row.qualificationId !== '')
      .map((row) => ({
        qualificationId: row.qualificationId,
        ...(row.institute.trim() !== '' ? { institute: row.institute.trim() } : {}),
        ...(row.yearOfCompletion !== '' ? { yearOfCompletion: Number(row.yearOfCompletion) } : {}),
      }))
  );

  const errors = (field: string): { errors: string[] } | Record<string, never> =>
    state.fieldErrors?.[field] ? { errors: state.fieldErrors[field] } : {};

  return (
    <form ref={formRef} action={action} className="grid gap-8">
      <input type="hidden" name="schedules" value={hoursPayload} />
      <input type="hidden" name="qualifications" value={degreesPayload} />

      {state.status === 'error' && state.message ? (
        <Alert tone="error">{state.message}</Alert>
      ) : null}

      <Section
        title="Who they are"
        note="A doctor needs a login before they can be scheduled or sign a prescription, so they are invited from Staff first."
      >
        <div className="grid gap-4 sm:grid-cols-2">
          <Select
            name="userId"
            label="Colleague"
            required
            placeholder="Choose a colleague"
            options={candidates.map((c) => ({ value: c.userId, label: c.fullName }))}
            hint="Only people who already have a login here."
            {...errors('userId')}
          />
          <Input
            name="experienceYears"
            label="Years of experience"
            type="number"
            inputMode="numeric"
            min={0}
            max={80}
            {...errors('experienceYears')}
          />
        </div>
      </Section>

      <Section title="Registration" note="What makes a prescription this doctor signs a legal one.">
        <div className="grid gap-4 sm:grid-cols-3">
          <Input
            name="registrationNumber"
            label="Medical council number"
            className="font-mono"
            hint="Appears on every prescription they sign."
            {...errors('registrationNumber')}
          />
          <Input
            name="registrationCouncil"
            label="Council"
            hint="The body that issued it."
            {...errors('registrationCouncil')}
          />
          <Input
            name="registrationValidTill"
            label="Valid until"
            type="date"
            hint="Leave blank if it does not expire."
            {...errors('registrationValidTill')}
          />
        </div>
      </Section>

      <Section title="What they treat">
        <ClassificationPicker
          specialties={specialties}
          hint="What this doctor is trained in. Add as many as apply and mark one as their main one — the roster lists them under it."
        />
      </Section>

      {canManageQualifications ? (
        <Section
          title="Qualifications"
          note="Degrees and fellowships, as they should read on a prescription."
        >
          {degrees.length === 0 ? (
            <Empty>Nothing added yet.</Empty>
          ) : (
            <ul className="grid gap-3">
              {degrees.map((row) => (
                <li
                  key={row.key}
                  className="border-rule bg-card rounded-[var(--radius-md)] border p-3"
                >
                  <div className="grid gap-3 sm:grid-cols-3">
                    <Select
                      name={`degree-${row.key}`}
                      label="Qualification"
                      placeholder="Choose one"
                      options={qualificationOptions}
                      value={row.qualificationId}
                      onChange={(e) =>
                        setDegrees((prev) =>
                          prev.map((r) =>
                            r.key === row.key ? { ...r, qualificationId: e.target.value } : r
                          )
                        )
                      }
                    />
                    <Input
                      name={`institute-${row.key}`}
                      label="Institute"
                      value={row.institute}
                      onChange={(e) =>
                        setDegrees((prev) =>
                          prev.map((r) =>
                            r.key === row.key ? { ...r, institute: e.target.value } : r
                          )
                        )
                      }
                    />
                    <Input
                      name={`year-${row.key}`}
                      label="Year"
                      type="number"
                      inputMode="numeric"
                      min={1900}
                      max={2100}
                      value={row.yearOfCompletion}
                      onChange={(e) =>
                        setDegrees((prev) =>
                          prev.map((r) =>
                            r.key === row.key ? { ...r, yearOfCompletion: e.target.value } : r
                          )
                        )
                      }
                    />
                  </div>
                  <div className="mt-2">
                    <Button
                      type="button"
                      variant="ghost"
                      onClick={() => setDegrees((prev) => prev.filter((r) => r.key !== row.key))}
                    >
                      Remove
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
          )}

          <div className="mt-3">
            <Button
              type="button"
              variant="secondary"
              onClick={() =>
                setDegrees((prev) => [
                  ...prev,
                  { key: nextKey(), qualificationId: '', institute: '', yearOfCompletion: '' },
                ])
              }
            >
              Add a qualification
            </Button>
          </div>
        </Section>
      ) : null}

      {canManageSchedules ? (
        <Section
          title="Working hours"
          note="What the front desk books against. A doctor with no hours offers no slots at all, so this is worth filling in now."
        >
          {hours.length === 0 ? (
            <Empty>
              No hours yet — this doctor will not be bookable until some are added, here or on their
              profile.
            </Empty>
          ) : (
            <ul className="grid gap-3">
              {hours.map((row) => (
                <li
                  key={row.key}
                  className="border-rule bg-card rounded-[var(--radius-md)] border p-3"
                >
                  <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                    <Select
                      name={`branch-${row.key}`}
                      label="Branch"
                      placeholder="Choose one"
                      options={branchOptions}
                      value={row.branchId}
                      onChange={(e) => patchHours(setHours, row.key, { branchId: e.target.value })}
                    />
                    <Select
                      name={`day-${row.key}`}
                      label="Day"
                      options={DAY_OPTIONS}
                      value={row.dayOfWeek}
                      onChange={(e) => patchHours(setHours, row.key, { dayOfWeek: e.target.value })}
                    />
                    <Input
                      name={`from-${row.key}`}
                      label="From"
                      type="time"
                      value={row.startTime}
                      onChange={(e) => patchHours(setHours, row.key, { startTime: e.target.value })}
                    />
                    <Input
                      name={`to-${row.key}`}
                      label="To"
                      type="time"
                      value={row.endTime}
                      onChange={(e) => patchHours(setHours, row.key, { endTime: e.target.value })}
                    />
                    <Select
                      name={`slot-${row.key}`}
                      label="Slot length"
                      placeholder="Use clinic setting"
                      options={SLOT_LENGTHS}
                      value={row.slotMinutes}
                      onChange={(e) =>
                        patchHours(setHours, row.key, { slotMinutes: e.target.value })
                      }
                      hint="Leave as-is to follow the clinic's default."
                    />
                    <Input
                      name={`cap-${row.key}`}
                      label="Patient cap"
                      type="number"
                      inputMode="numeric"
                      min={1}
                      placeholder="No cap"
                      value={row.maxPatients}
                      onChange={(e) =>
                        patchHours(setHours, row.key, { maxPatients: e.target.value })
                      }
                    />
                    <Input
                      name={`validFrom-${row.key}`}
                      label="Starting from"
                      type="date"
                      value={row.validFrom}
                      onChange={(e) => patchHours(setHours, row.key, { validFrom: e.target.value })}
                    />
                  </div>
                  <div className="mt-2">
                    <Button
                      type="button"
                      variant="ghost"
                      onClick={() => setHours((prev) => prev.filter((r) => r.key !== row.key))}
                    >
                      Remove
                      <span className="sr-only">
                        {' '}
                        these hours on {DAYS[Number(row.dayOfWeek)] ?? 'this day'}
                      </span>
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
          )}

          <div className="mt-3">
            <Button
              type="button"
              variant="secondary"
              onClick={() =>
                setHours((prev) => [
                  ...prev,
                  {
                    key: nextKey(),
                    // Carried from the previous row: a week is usually the same
                    // branch and the same times on several days, and retyping
                    // 09:00 six times is how the sixth one becomes 19:00.
                    branchId: prev.at(-1)?.branchId ?? branches[0]?.id ?? '',
                    dayOfWeek: '1',
                    startTime: prev.at(-1)?.startTime ?? '',
                    endTime: prev.at(-1)?.endTime ?? '',
                    slotMinutes: prev.at(-1)?.slotMinutes ?? '',
                    maxPatients: '',
                    validFrom: prev.at(-1)?.validFrom ?? today,
                  },
                ])
              }
            >
              Add a block of hours
            </Button>
          </div>
        </Section>
      ) : null}

      {canManageFees && fees !== null ? (
        <Section
          title="What patients pay"
          note={`This doctor's prices, in ${fees.currency}. Leave a box blank to use the clinic's price for that kind of visit.`}
        >
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {KNOWN_FEE_TYPES.map((feeType) => {
              const inherited = fees.rows.find((r) => r.feeType === feeType)?.amountMinor ?? null;
              return (
                <div key={feeType}>
                  {/* The key travels beside the amount so the action knows which
                      boxes were on the form at all — see `feesFrom`. */}
                  <input type="hidden" name="feeType" value={feeType} />
                  <Input
                    name={`amount.${feeType}`}
                    label={FEE_WORDS[feeType] ?? feeType}
                    type="text"
                    inputMode="decimal"
                    className="font-mono"
                    placeholder={inherited === null ? 'Not priced' : (inherited / 100).toFixed(2)}
                    hint={
                      inherited === null
                        ? 'The clinic has no price for this.'
                        : "Blank uses the clinic's price."
                    }
                    {...errors(`amount.${feeType}`)}
                  />
                </div>
              );
            })}
          </div>
        </Section>
      ) : null}

      {canManagePay ? (
        <Section
          title="What the clinic pays"
          note="What has been agreed with this doctor. A record of the agreement — rcln does not pay it out. Leave blank if nothing has been agreed."
        >
          <div className="grid gap-4 sm:max-w-md sm:grid-cols-2">
            <Input
              name="salaryAmount"
              label={fees === null ? 'Amount' : `Amount · ${fees.currency}`}
              type="text"
              inputMode="decimal"
              className="font-mono"
              {...errors('salaryAmount')}
            />
            <Select
              name="salaryInterval"
              label="For every"
              options={INTERVALS}
              defaultValue="MONTHLY"
            />
          </div>
        </Section>
      ) : null}

      <Section title="Anything else" note="Shown on their profile. Optional.">
        <Textarea name="bio" label="About this doctor" rows={3} />
      </Section>

      <div className="border-rule flex flex-wrap gap-3 border-t pt-5">
        <Button type="submit" disabled={pending}>
          {pending ? 'Registering…' : 'Register this doctor'}
        </Button>
        <Button type="button" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

function patchHours(
  set: React.Dispatch<React.SetStateAction<HoursRow[]>>,
  key: string,
  change: Partial<HoursRow>
): void {
  set((prev) => prev.map((row) => (row.key === key ? { ...row, ...change } : row)));
}

function Section({
  title,
  note,
  children,
}: {
  title: string;
  note?: string;
  children: React.ReactNode;
}) {
  return (
    <section>
      <h3 className="eyebrow text-drape">{title}</h3>
      {note ? (
        <p className="text-muted mt-1 mb-3 text-[0.8125rem] leading-relaxed">{note}</p>
      ) : null}
      <div className={note ? '' : 'mt-3'}>{children}</div>
    </section>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return (
    <p className="border-rule text-muted rounded-[var(--radius-md)] border border-dashed px-3 py-4 text-[0.8125rem] leading-relaxed">
      {children}
    </p>
  );
}
