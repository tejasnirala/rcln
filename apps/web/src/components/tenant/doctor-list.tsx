'use client';

import { useActionState, useCallback, useEffect, useRef, useState } from 'react';
import type {
  BranchDetail,
  DoctorScheduleDetail,
  DoctorSummary,
  SpecialtySummary,
} from '@rcln/contracts';
import { Input, Select, type SelectOption } from '@/components/ui/field';
import { Button } from '@/components/ui/button';
import { RecordHistory } from '@/components/tenant/record-history';
import { Alert, useOutcomeFocus } from '@/components/ui/alert';
import {
  addSchedule,
  createDoctor,
  removeSchedule,
  retireDoctor,
  updateDoctor,
  type DoctorFormState,
} from '@/app/(tenant)/t/[slug]/(app)/doctors/actions';

const IDLE: DoctorFormState = { status: 'idle' };

/**
 * Sunday first, matching `dayOfWeek` 0–6 in the contract, which in turn matches
 * Postgres `extract(dow)`. Not a display preference — renumbering here would
 * silently shift every stored day.
 */
const DAYS = [
  { short: 'Sun', full: 'Sunday' },
  { short: 'Mon', full: 'Monday' },
  { short: 'Tue', full: 'Tuesday' },
  { short: 'Wed', full: 'Wednesday' },
  { short: 'Thu', full: 'Thursday' },
  { short: 'Fri', full: 'Friday' },
  { short: 'Sat', full: 'Saturday' },
] as const;

const DAY_OPTIONS: SelectOption[] = DAYS.map((d, i) => ({ value: String(i), label: d.full }));

/** Blank inherits the clinic's setting rather than pinning a number. */
const SLOT_LENGTHS: SelectOption[] = [10, 15, 20, 30, 45, 60].map((minutes) => ({
  value: String(minutes),
  label: `${String(minutes)} min`,
}));

const STATUSES: SelectOption[] = [
  { value: 'ACTIVE', label: 'Consulting' },
  { value: 'INACTIVE', label: 'Not consulting' },
];

/**
 * The week strip, adapted from the one on Branches — and the difference between
 * them is the point.
 *
 * A branch has ONE opening span per day, so its cell holds two times. A doctor
 * can have several blocks in a day (a morning clinic and an evening one) and can
 * hold them at different branches, so the cell stacks blocks and names the
 * branch when the clinic has more than one. That stacking is the honest shape of
 * the data: flattening it to "09:00–17:00" would invent a lunchtime that is
 * actually bookable.
 *
 * The week is a real sequence, so its order carries information — which is what
 * earns the seven-cell layout rather than it being decoration.
 *
 * A day with no hours is marked with a dash AND the word, never colour alone
 * (WCAG 1.4.1, and AGENTS.md lists it as a rule already got wrong once).
 */
function DoctorWeek({
  schedules,
  showBranch,
}: {
  schedules: DoctorScheduleDetail[];
  showBranch: boolean;
}) {
  const active = schedules.filter((s) => s.isActive);

  if (active.length === 0) {
    return (
      <p className="text-muted mt-4 text-[0.8125rem]">
        No working hours set. This doctor will offer no bookable slots.
      </p>
    );
  }

  return (
    <ul className="border-rule mt-4 grid grid-cols-7 gap-px overflow-hidden rounded-md border bg-[color:var(--color-rule)]">
      {DAYS.map((day, index) => {
        const blocks = active
          .filter((s) => s.dayOfWeek === index)
          .sort((a, b) => a.startTime.localeCompare(b.startTime));

        return (
          <li key={day.full} className="bg-card px-1.5 py-2 text-center">
            <p className="eyebrow text-muted" aria-hidden="true">
              {day.short}
            </p>
            <span className="sr-only">{day.full}: </span>

            {blocks.length === 0 ? (
              <p className="text-muted mt-1 font-mono text-[0.75rem]">
                <span aria-hidden="true">—</span>
                <span className="sr-only">Not consulting</span>
              </p>
            ) : (
              <div className="mt-1 grid gap-1.5">
                {blocks.map((block) => (
                  <div key={block.id}>
                    <p className="text-ink font-mono text-[0.6875rem] leading-tight">
                      {block.startTime}
                      <br />
                      {block.endTime}
                    </p>
                    {showBranch ? (
                      <p className="text-muted mt-0.5 text-[0.625rem] leading-tight">
                        {block.branchName}
                      </p>
                    ) : null}
                  </div>
                ))}
              </div>
            )}
          </li>
        );
      })}
    </ul>
  );
}

export function DoctorList({
  slug,
  doctors,
  schedules,
  branches,
  specialties,
  candidates,
  canReadSchedules,
  canManageSchedules,
  canCreate,
  canUpdate,
  canArchive,
  canReadHistory,
}: {
  slug: string;
  doctors: DoctorSummary[];
  schedules: Record<string, DoctorScheduleDetail[]>;
  branches: BranchDetail[];
  specialties: SpecialtySummary[];
  candidates: { userId: string; fullName: string }[];
  canReadSchedules: boolean;
  canManageSchedules: boolean;
  canCreate: boolean;
  canUpdate: boolean;
  canArchive: boolean;
  canReadHistory: boolean;
}) {
  const [adding, setAdding] = useState(false);
  const closeCreate = useCallback(() => setAdding(false), []);

  return (
    <>
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="eyebrow text-drape">Practitioners</p>
          <h1 className="font-display mt-2 text-3xl tracking-tight">Doctors</h1>
          <p className="text-muted mt-2 max-w-xl text-[0.9375rem] leading-relaxed">
            Who consults here, and when. Working hours decide which appointment slots the front desk
            can offer.
          </p>
        </div>
        {canCreate && candidates.length > 0 ? (
          <Button onClick={() => setAdding((open) => !open)} aria-expanded={adding}>
            {adding ? 'Cancel' : 'Add a doctor'}
          </Button>
        ) : null}
      </div>

      {adding ? (
        <div className="border-drape bg-drape-tint/40 mt-6 rounded-lg border p-5">
          <CreateForm
            slug={slug}
            candidates={candidates}
            specialties={specialties}
            onDone={closeCreate}
          />
        </div>
      ) : null}

      {doctors.length === 0 ? (
        <div className="border-rule bg-card mt-8 rounded-lg border border-dashed p-8 text-center">
          <p className="text-ink text-[0.9375rem] font-medium">No doctors yet</p>
          <p className="text-muted mx-auto mt-2 max-w-md text-[0.875rem] leading-relaxed">
            {candidates.length === 0
              ? 'Invite a colleague from Staff first — a doctor needs a login before they can be scheduled or sign a prescription.'
              : 'Add a colleague as a doctor, then set the hours they consult in. Until then there is nothing for the front desk to book.'}
          </p>
        </div>
      ) : (
        <ul className="mt-8 grid gap-4">
          {doctors.map((doctor) => (
            <DoctorCard
              key={doctor.id}
              slug={slug}
              doctor={doctor}
              schedules={schedules[doctor.id] ?? []}
              branches={branches}
              canReadSchedules={canReadSchedules}
              canManageSchedules={canManageSchedules}
              canUpdate={canUpdate}
              canArchive={canArchive}
              canReadHistory={canReadHistory}
            />
          ))}
        </ul>
      )}
    </>
  );
}

/**
 * A doctor, with editors expanded in place.
 *
 * No modal: the codebase has never had one, and every other row-level action in
 * the app already expands in place. A second pattern for the same job is worse
 * than this one being imperfect.
 */
function DoctorCard({
  slug,
  doctor,
  schedules,
  branches,
  canReadSchedules,
  canManageSchedules,
  canUpdate,
  canArchive,
  canReadHistory,
}: {
  slug: string;
  doctor: DoctorSummary;
  schedules: DoctorScheduleDetail[];
  branches: BranchDetail[];
  canReadSchedules: boolean;
  canManageSchedules: boolean;
  canUpdate: boolean;
  canArchive: boolean;
  canReadHistory: boolean;
}) {
  const [panel, setPanel] = useState<'none' | 'details' | 'hours'>('none');
  const toggle = (next: 'details' | 'hours') => setPanel((p) => (p === next ? 'none' : next));

  return (
    <li className="border-rule bg-card rounded-lg border p-5">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-ink text-[1.0625rem] font-medium">{doctor.fullName}</h2>
            {doctor.status !== 'ACTIVE' ? (
              <span className="bg-signal-tint text-signal rounded-xs px-2 py-0.5 text-[0.6875rem] font-medium">
                {doctor.status === 'INACTIVE' ? 'Not consulting' : 'Retired'}
              </span>
            ) : null}
          </div>

          <p className="text-muted mt-1 text-[0.8125rem]">
            {doctor.primarySpecialty ?? 'No specialty recorded'}
            {doctor.experienceYears !== null ? ` · ${String(doctor.experienceYears)} years` : ''}
          </p>

          {/* A council registration number is an identifier, so it is set in mono. */}
          {doctor.registrationNumber ? (
            <p className="text-muted mt-1 font-mono text-[0.75rem]">
              <span className="sr-only">Registration number: </span>
              {doctor.registrationNumber}
            </p>
          ) : null}
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {canUpdate ? (
            <Button
              variant="secondary"
              onClick={() => toggle('details')}
              aria-expanded={panel === 'details'}
            >
              Edit
            </Button>
          ) : null}
          {canManageSchedules ? (
            <Button
              variant="secondary"
              onClick={() => toggle('hours')}
              aria-expanded={panel === 'hours'}
            >
              Working hours
            </Button>
          ) : null}
          {canReadHistory ? (
            <RecordHistory
              slug={slug}
              entityType="doctor_profile"
              entityId={doctor.id}
              label={doctor.fullName}
            />
          ) : null}
        </div>
      </div>

      {canReadSchedules ? (
        <DoctorWeek schedules={schedules} showBranch={branches.length > 1} />
      ) : null}

      {panel === 'details' ? (
        <div className="border-rule mt-5 border-t pt-5">
          <DetailsForm slug={slug} doctor={doctor} canArchive={canArchive} />
        </div>
      ) : null}

      {panel === 'hours' ? (
        <div className="border-rule mt-5 border-t pt-5">
          <HoursEditor slug={slug} doctorId={doctor.id} schedules={schedules} branches={branches} />
        </div>
      ) : null}
    </li>
  );
}

function CreateForm({
  slug,
  candidates,
  specialties,
  onDone,
}: {
  slug: string;
  candidates: { userId: string; fullName: string }[];
  specialties: SpecialtySummary[];
  onDone: () => void;
}) {
  const [state, action, pending] = useActionState(createDoctor.bind(null, slug), IDLE);
  const formRef = useRef<HTMLFormElement>(null);
  useOutcomeFocus(state.status, formRef);

  useEffect(() => {
    if (state.status === 'saved') onDone();
  }, [state.status, onDone]);

  return (
    <form ref={formRef} action={action} className="grid gap-4">
      {state.status === 'error' && state.message ? (
        <Alert tone="error">{state.message}</Alert>
      ) : null}

      <div className="grid gap-4 sm:grid-cols-2">
        <Select
          name="userId"
          label="Who"
          required
          placeholder="Choose a colleague"
          options={candidates.map((c) => ({ value: c.userId, label: c.fullName }))}
          hint="Only people who already have a login here."
          {...(state.fieldErrors?.['userId'] ? { errors: state.fieldErrors['userId'] } : {})}
        />
        <Select
          name="primarySpecialtyId"
          label="Main specialty"
          placeholder="Not recorded"
          options={specialties.map((s) => ({ value: s.id, label: s.name }))}
        />
        <Input
          name="registrationNumber"
          label="Medical council number"
          hint="Appears on prescriptions this doctor signs."
          {...(state.fieldErrors?.['registrationNumber']
            ? { errors: state.fieldErrors['registrationNumber'] }
            : {})}
        />
        <Input
          name="experienceYears"
          label="Years of experience"
          type="number"
          inputMode="numeric"
          min={0}
          max={80}
        />
      </div>

      <div className="flex gap-3">
        <Button type="submit" disabled={pending}>
          {pending ? 'Adding…' : 'Add doctor'}
        </Button>
      </div>
    </form>
  );
}

function DetailsForm({
  slug,
  doctor,
  canArchive,
}: {
  slug: string;
  doctor: DoctorSummary;
  canArchive: boolean;
}) {
  const [state, action, pending] = useActionState(updateDoctor.bind(null, slug, doctor.id), IDLE);
  const formRef = useRef<HTMLFormElement>(null);
  useOutcomeFocus(state.status, formRef);
  const [retiring, setRetiring] = useState(false);

  return (
    <div className="grid gap-5">
      <form ref={formRef} action={action} className="grid gap-4">
        {state.status !== 'idle' && state.message ? (
          <Alert tone={state.status === 'error' ? 'error' : 'info'}>{state.message}</Alert>
        ) : null}

        <div className="grid gap-4 sm:grid-cols-2">
          <Input
            name="registrationNumber"
            label="Medical council number"
            defaultValue={doctor.registrationNumber ?? ''}
            {...(state.fieldErrors?.['registrationNumber']
              ? { errors: state.fieldErrors['registrationNumber'] }
              : {})}
          />
          <Input
            name="experienceYears"
            label="Years of experience"
            type="number"
            inputMode="numeric"
            min={0}
            max={80}
            defaultValue={doctor.experienceYears ?? ''}
          />
          <Select
            name="status"
            label="Currently"
            defaultValue={doctor.status === 'ARCHIVED' ? 'INACTIVE' : doctor.status}
            options={STATUSES}
            hint="Pausing keeps the profile but offers no new slots."
          />
        </div>

        <div>
          <Button type="submit" disabled={pending}>
            {pending ? 'Saving…' : 'Save'}
          </Button>
        </div>
      </form>

      {canArchive && doctor.status !== 'ARCHIVED' ? (
        <div className="border-rule border-t pt-5">
          {retiring ? (
            <div className="grid gap-3">
              <p className="text-muted text-[0.8125rem] leading-relaxed">
                Retiring removes {doctor.fullName} from the roster and clears their working hours.
                Past appointments and prescriptions keep pointing at them.
              </p>
              <div className="flex gap-3">
                <Button
                  variant="secondary"
                  onClick={() => {
                    void retireDoctor(slug, doctor.id);
                  }}
                >
                  Retire {doctor.fullName}
                </Button>
                <Button variant="ghost" onClick={() => setRetiring(false)}>
                  Keep
                </Button>
              </div>
            </div>
          ) : (
            <Button variant="ghost" onClick={() => setRetiring(true)}>
              Retire this doctor
            </Button>
          )}
        </div>
      ) : null}
    </div>
  );
}

/**
 * Add and remove blocks of working hours.
 *
 * Blocks are added one at a time rather than the week being replaced wholesale,
 * which is the opposite of the branch hours editor — and deliberately so. A
 * branch has exactly one span per day, so replacing the set is unambiguous. A
 * doctor's week is a variable number of blocks across branches, and a
 * replace-everything form would make removing one block require re-entering all
 * the others.
 */
function HoursEditor({
  slug,
  doctorId,
  schedules,
  branches,
}: {
  slug: string;
  doctorId: string;
  schedules: DoctorScheduleDetail[];
  branches: BranchDetail[];
}) {
  const [state, action, pending] = useActionState(addSchedule.bind(null, slug, doctorId), IDLE);
  const formRef = useRef<HTMLFormElement>(null);
  useOutcomeFocus(state.status, formRef);

  const today = new Date().toISOString().slice(0, 10);
  const active = schedules.filter((s) => s.isActive);

  return (
    <div className="grid gap-5">
      {state.status !== 'idle' && state.message ? (
        <Alert tone={state.status === 'error' ? 'error' : 'info'}>{state.message}</Alert>
      ) : null}

      {active.length > 0 ? (
        <ul className="grid gap-2">
          {active
            .slice()
            .sort((a, b) =>
              a.dayOfWeek === b.dayOfWeek
                ? a.startTime.localeCompare(b.startTime)
                : a.dayOfWeek - b.dayOfWeek
            )
            .map((block) => (
              <li
                key={block.id}
                className="border-rule flex flex-wrap items-center justify-between gap-3 rounded-md border px-3 py-2"
              >
                <div className="min-w-0">
                  <p className="text-ink text-[0.875rem]">
                    {DAYS[block.dayOfWeek]?.full}{' '}
                    <span className="font-mono text-[0.8125rem]">
                      {block.startTime}–{block.endTime}
                    </span>
                  </p>
                  <p className="text-muted mt-0.5 text-[0.75rem]">
                    {block.branchName} ·{' '}
                    {/*
                      Inheritance is a real concept here (ADR-0015), so the row
                      says which of the two it is rather than showing a number
                      whose origin the reader has to guess.
                    */}
                    {block.slotMinutes === null
                      ? `${String(block.effectiveSlotMinutes)} min slots, from clinic settings`
                      : `${String(block.slotMinutes)} min slots, set here`}
                    {block.maxPatients !== null
                      ? ` · up to ${String(block.maxPatients)} patients`
                      : ''}
                  </p>
                </div>
                <Button
                  variant="ghost"
                  onClick={() => {
                    void removeSchedule(slug, doctorId, block.id);
                  }}
                >
                  Remove
                </Button>
              </li>
            ))}
        </ul>
      ) : null}

      <form ref={formRef} action={action} className="grid gap-4">
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <Select
            name="branchId"
            label="Branch"
            required
            options={branches.map((b) => ({ value: b.id, label: b.name }))}
            {...(state.fieldErrors?.['branchId'] ? { errors: state.fieldErrors['branchId'] } : {})}
          />
          <Select name="dayOfWeek" label="Day" required options={DAY_OPTIONS} />
          <Select
            name="slotMinutes"
            label="Slot length"
            placeholder="Use clinic setting"
            options={SLOT_LENGTHS}
            hint="Leave as-is to follow the clinic's default."
          />
          <Input
            name="startTime"
            label="From"
            type="time"
            required
            {...(state.fieldErrors?.['startTime']
              ? { errors: state.fieldErrors['startTime'] }
              : {})}
          />
          <Input
            name="endTime"
            label="To"
            type="time"
            required
            {...(state.fieldErrors?.['endTime'] ? { errors: state.fieldErrors['endTime'] } : {})}
          />
          <Input
            name="maxPatients"
            label="Patient cap"
            type="number"
            inputMode="numeric"
            min={1}
            placeholder="No cap"
          />
          <Input name="validFrom" label="Starting from" type="date" required defaultValue={today} />
        </div>

        <div>
          <Button type="submit" disabled={pending}>
            {pending ? 'Adding…' : 'Add these hours'}
          </Button>
        </div>
      </form>
    </div>
  );
}
