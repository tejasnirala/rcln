'use client';

import { Fragment, useActionState, useEffect, useRef, useState } from 'react';
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
import { TIME_INPUT } from '@/components/tenant/doctor-sections';
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

/** Blank inherits the clinic's setting rather than pinning a number (ADR-0015). */
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
/** One row of the seven-day table. Empty strings mean "not consulting then". */
interface WeekRow {
  amFrom: string;
  amTo: string;
  pmFrom: string;
  pmTo: string;
  slotMinutes: string;
  maxPatients: string;
}

type WeekRows = Record<number, WeekRow>;

/** Monday first — Sunday last is how the person filling this in reads a week. */
const WEEK = [1, 2, 3, 4, 5, 6, 0] as const;

const BLANK_ROW: WeekRow = {
  amFrom: '',
  amTo: '',
  pmFrom: '',
  pmTo: '',
  slotMinutes: '',
  maxPatients: '',
};

const EMPTY_WEEK: WeekRows = Object.fromEntries(WEEK.map((day) => [day, BLANK_ROW]));

function patchWeek(
  set: React.Dispatch<React.SetStateAction<WeekRows>>,
  day: number,
  patch: Partial<WeekRow>
): void {
  set((prev) => ({ ...prev, [day]: { ...(prev[day] ?? BLANK_ROW), ...patch } }));
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
  candidates: { userId: string; fullName: string; email: string | null }[];
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

  /*
   * The week, as the table edits it (DS-1). Seven fixed rows keyed by day rather
   * than a growable list: the old form let somebody add three overlapping
   * Tuesdays and gave no view of the week at all, and the overlap was refused by
   * a database constraint at submit — one block too late to be useful.
   */
  const [week, setWeek] = useState<WeekRows>(EMPTY_WEEK);
  const [hoursBranchId, setHoursBranchId] = useState(branches[0]?.id ?? '');
  const [hoursMode, setHoursMode] = useState<'BRANCH' | 'OWN'>('BRANCH');
  const hoursBranch = branches.find((b) => b.id === hoursBranchId) ?? branches[0];
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
  /*
   * The repeatable sections travel as ONE JSON field each, the same shape the
   * classification picker uses and for the same reason: indexed input names
   * (`schedules[0][startTime]`) silently renumber when a middle row is removed.
   * Nothing is trusted for being well-formed — the action re-validates with the
   * same Zod schema the API enforces.
   *
   * ⚠️ A DAY WITH NO FIRST SESSION IS A DAY OFF AND IS NOT SENT. An evening with
   *   no morning is dropped here too rather than sent to fail validation: the
   *   contract refuses it with a message about the missing morning, which is
   *   true but reads as a rule rather than as the typo it usually is.
   */
  const hoursPayload = JSON.stringify(
    hoursMode === 'OWN' && hoursBranchId !== ''
      ? WEEK.flatMap((day) => {
          const row = week[day];
          if (row.amFrom === '' || row.amTo === '') return [];

          const common = {
            branchId: hoursBranchId,
            dayOfWeek: day,
            ...(row.slotMinutes !== '' ? { slotMinutes: Number(row.slotMinutes) } : {}),
            ...(row.maxPatients !== '' ? { maxPatients: Number(row.maxPatients) } : {}),
            validFrom: today,
            isActive: true,
          };

          return [
            { ...common, startTime: row.amFrom, endTime: row.amTo },
            ...(row.pmFrom !== '' && row.pmTo !== ''
              ? [{ ...common, startTime: row.pmFrom, endTime: row.pmTo }]
              : []),
          ];
        })
      : []
  );

  /** The sites this doctor works the clinic's own hours at. See the contract. */
  const followsPayload = JSON.stringify(
    hoursMode === 'BRANCH' && hoursBranchId !== '' ? [hoursBranchId] : []
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
      <input type="hidden" name="followsBranchHours" value={followsPayload} />
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
            options={candidates.map((c) => ({
              value: c.userId,
              // The email disambiguates two people with the same name, which a
              // clinic with two Dr Sharmas has and a bare name cannot separate.
              // Absent for a member invited by phone alone.
              label: c.email ? `${c.fullName} — ${c.email}` : c.fullName,
            }))}
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
          {branches.length === 0 ? (
            <Empty>No sites to set hours for yet.</Empty>
          ) : (
            <div className="grid gap-5">
              {branches.length > 1 ? (
                <Select
                  name="hoursBranch"
                  label="Which site"
                  hint="Set this one now; their other sites are set up on their profile."
                  options={branchOptions}
                  value={hoursBranchId}
                  onChange={(e) => {
                    setHoursBranchId(e.target.value);
                  }}
                />
              ) : null}

              <fieldset className="grid gap-2">
                <legend className="text-ink text-[0.9375rem] font-medium">
                  When do they consult?
                </legend>

                <label className="border-rule hover:bg-drape-tint/30 flex cursor-pointer items-start gap-3 rounded-[var(--radius-md)] border p-4">
                  <input
                    type="radio"
                    name="hoursMode"
                    value="BRANCH"
                    checked={hoursMode === 'BRANCH'}
                    onChange={() => {
                      setHoursMode('BRANCH');
                    }}
                    className="accent-drape mt-0.5 size-4 shrink-0"
                  />
                  <span>
                    <span className="text-ink block text-[0.9375rem]">
                      Whenever {hoursBranch?.name ?? 'the clinic'} is open
                    </span>
                    <span className="text-muted block text-[0.8125rem]">
                      For a doctor who works here full time. If the clinic changes its opening
                      hours, theirs change with it.
                    </span>
                  </span>
                </label>

                <label className="border-rule hover:bg-drape-tint/30 flex cursor-pointer items-start gap-3 rounded-[var(--radius-md)] border p-4">
                  <input
                    type="radio"
                    name="hoursMode"
                    value="OWN"
                    checked={hoursMode === 'OWN'}
                    onChange={() => {
                      setHoursMode('OWN');
                    }}
                    className="accent-drape mt-0.5 size-4 shrink-0"
                  />
                  <span>
                    <span className="text-ink block text-[0.9375rem]">Their own hours</span>
                    <span className="text-muted block text-[0.8125rem]">
                      For a visiting consultant, or anyone who keeps different hours from the
                      clinic.
                    </span>
                  </span>
                </label>
              </fieldset>

              {hoursMode === 'BRANCH' ? (
                /*
                 * ⚠️ THE CLINIC'S WEEK IS SHOWN, NOT JUST NAMED. "Same as the
                 *   clinic" is a promise about hours the person registering a
                 *   doctor would otherwise have to leave this form to check —
                 *   and if the site has none set, this is where they find out,
                 *   rather than after the first patient cannot be booked.
                 */
                <div className="border-rule bg-drape-tint/30 rounded-[var(--radius-md)] border p-4">
                  <p className="text-drape-deep text-[0.875rem] font-medium">
                    {hoursBranch?.name ?? 'This site'} is open
                  </p>
                  {(hoursBranch?.operatingHours.length ?? 0) === 0 ? (
                    <p className="text-signal mt-2 text-[0.8125rem]">
                      This site has no opening hours set yet, so this doctor would not be bookable.
                      Set them in Branches, or give this doctor their own hours below.
                    </p>
                  ) : (
                    <ul className="text-drape mt-2 space-y-1 text-[0.875rem]">
                      {WEEK.map((day) => {
                        const open = hoursBranch?.operatingHours.find((h) => h.dayOfWeek === day);
                        return (
                          <li key={day} className="flex gap-3">
                            <span className="w-24 shrink-0">{DAYS[day]}</span>
                            <span>
                              {!open || open.isClosed
                                ? 'Closed'
                                : `${open.opensAt} – ${open.closesAt}`}
                            </span>
                          </li>
                        );
                      })}
                    </ul>
                  )}
                </div>
              ) : (
                <div className="grid gap-3">
                  <div className="overflow-x-auto p-1.5">
                    <table className="w-full min-w-[49rem] border-separate border-spacing-0 text-[0.875rem]">
                      <colgroup>
                        {/*
                         * ⚠️ FIVE COLUMNS, NOT SEVEN. Each session is ONE cell holding its own
                         *   "from" and "to" — the words live in the row rather than in a
                         *   header, so a row reads as a sentence rather than as four
                         *   identical boxes whose meaning is two rows above them.
                         *
                         * ⚠️ A ONE-LINE SESSION CELL HOLDS "from", a time field, "to" and a
                         *   second time field, and the fields are `flex-1` — the column
                         *   width MINUS the gutter is what they share. 10.5rem of content
                         *   is the floor, reachable only because the picker glyph is
                         *   hidden (see `TIME_INPUT`).
                         *
                         * ⚠️ 12.25rem, AND THE `pr-7` ON THE SESSION CELLS IS PART OF IT.
                         *   The fields are `flex-1`, so the column width minus that
                         *   gutter is what they share — widening the gap without
                         *   widening the column would just shrink the fields back into
                         *   clipping. Day and Slot carry `pr-6` for the same reason at
                         *   a smaller scale: with no gutters the row reads as one
                         *   continuous run of boxes rather than five columns.
                         */}
                        <col className="w-[7rem]" />
                        <col className="w-[12.25rem]" />
                        <col className="w-[12.25rem]" />
                        <col className="w-[7rem]" />
                        <col className="w-[7rem]" />
                      </colgroup>
                      <thead>
                        <tr className="text-muted text-left text-[0.8125rem]">
                          <th scope="col" className="border-rule border-b py-2 pr-6 font-normal">
                            Day
                          </th>
                          <th scope="col" className="border-rule border-b py-2 pr-7 font-normal">
                            First session
                          </th>
                          <th scope="col" className="border-rule border-b py-2 pr-7 font-normal">
                            Second session
                          </th>
                          <th scope="col" className="border-rule border-b py-2 pr-6 font-normal">
                            Slot
                          </th>
                          <th scope="col" className="border-rule border-b py-2 font-normal">
                            Cap
                          </th>
                        </tr>
                      </thead>
                      <tbody>
                        {WEEK.map((day) => {
                          const row = week[day];
                          return (
                            <tr key={day}>
                              <td className="border-rule text-ink border-b py-2 pr-6">
                                {DAYS[day]}
                              </td>
                              {(
                                [
                                  ['First', 'amFrom', 'amTo'],
                                  ['Second', 'pmFrom', 'pmTo'],
                                ] as const
                              ).map(([session, fromField, toField]) => (
                                <td key={session} className="border-rule border-b py-2 pr-7">
                                  {/*
                                   * ⚠️ ONE LINE, AND THE PICKER GLYPH IS HIDDEN TO PAY FOR IT — see the
                                   *   same note on the profile panel's table. A `type="time"` field draws a
                                   *   clock button about 1.5rem wide, and with two fields plus the words on
                                   *   one line that button was most of the reason the column could not go
                                   *   below 14rem. Typing and arrow keys still work; a desktop user loses
                                   *   the dropdown, a touch device does not.
                                   */}
                                  <div className="flex items-center gap-1">
                                    {(
                                      [
                                        ['from', fromField, 'starts at'],
                                        ['to', toField, 'ends at'],
                                      ] as const
                                    ).map(([word, field, spoken]) => (
                                      <Fragment key={field}>
                                        <span className="text-muted shrink-0 text-[0.8125rem]">
                                          {word}
                                        </span>
                                        <input
                                          type="time"
                                          aria-label={`${DAYS[day] ?? ''} ${session.toLowerCase()} session ${spoken}`}
                                          value={row[field]}
                                          onChange={(e) => {
                                            patchWeek(setWeek, day, { [field]: e.target.value });
                                          }}
                                          className={TIME_INPUT}
                                        />
                                      </Fragment>
                                    ))}
                                  </div>
                                </td>
                              ))}
                              <td className="border-rule border-b py-2 pr-6">
                                <input
                                  type="number"
                                  min={5}
                                  max={240}
                                  aria-label={`${DAYS[day]} slot length in minutes`}
                                  placeholder="Clinic"
                                  value={row.slotMinutes}
                                  onChange={(e) => {
                                    patchWeek(setWeek, day, { slotMinutes: e.target.value });
                                  }}
                                  className="border-rule bg-card text-ink w-full rounded border px-2 py-1"
                                />
                              </td>
                              <td className="border-rule border-b py-2">
                                <input
                                  type="number"
                                  min={1}
                                  max={500}
                                  aria-label={`${DAYS[day]} patient cap`}
                                  placeholder="No cap"
                                  value={row.maxPatients}
                                  onChange={(e) => {
                                    patchWeek(setWeek, day, { maxPatients: e.target.value });
                                  }}
                                  className="border-rule bg-card text-ink w-full rounded border px-2 py-1"
                                />
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>

                  <p className="text-muted text-[0.8125rem]">
                    Leave a day blank for a day off. The second session is for a doctor who consults
                    morning and evening. Slot length falls back to the clinic&rsquo;s setting, and a
                    blank cap means no limit.
                  </p>
                </div>
              )}
            </div>
          )}
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
