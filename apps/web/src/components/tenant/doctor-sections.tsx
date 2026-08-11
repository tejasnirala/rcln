'use client';

import { useActionState, useEffect, useRef, useState } from 'react';
import type {
  BranchDetail,
  DoctorDetail,
  DoctorQualificationDetail,
  QualificationSummary,
  SpecialtySummary,
} from '@rcln/contracts';
import { Alert, useOutcomeFocus } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Input, Select, Textarea, type SelectOption } from '@/components/ui/field';
import { ClassificationPicker } from '@/components/tenant/classification-picker';
import { DoctorPanel, PanelEmpty } from '@/components/tenant/doctor-panel';
import {
  addQualification,
  addSchedule,
  removeQualification,
  removeSchedule,
  retireDoctor,
  updateDoctor,
  updateQualification,
  type DoctorFormState,
} from '@/app/(tenant)/t/[slug]/(app)/doctors/actions';

/**
 * The editable sections of a doctor's profile.
 *
 * ⚠️ EACH SECTION OWNS ITS OWN EDIT STATE, AND THAT REPLACED A SINGLE "CHANGE
 *   THIS DOCTOR" BOX. That box held three buttons at the top of the page and
 *   opened its forms there, so pressing "Working hours" scrolled you away from
 *   the hours it was about to change, and the panel below still showed the old
 *   ones. A section that edits itself in place keeps the control, the data and
 *   the result in one field of view — and makes it obvious what a Save applies
 *   to, which one shared box never could.
 *
 * ⚠️ EVERY SECTION FALLS BACK TO THE READ VIEW, AND THAT IS THE DEFAULT. `canEdit`
 *   false renders exactly the markup the read-only profile always had, with no
 *   button and no disabled control — the front desk and a doctor viewing their
 *   own `/profile` see no doors at all, locked or otherwise.
 *
 * ⚠️ EACH SECTION SAVES THROUGH ITS OWN ENDPOINT, AND THE PROFILE FIELDS THROUGH
 *   A *PARTIAL* PATCH. `updateDoctorRequest` distinguishes an absent key from an
 *   empty one, so a form that edits only the registration number leaves the
 *   specialties alone rather than clearing them — the sentinel the classification
 *   picker carries is what makes splitting one form into three safe.
 */

const IDLE: DoctorFormState = { status: 'idle' };

const STATUSES: SelectOption[] = [
  { value: 'ACTIVE', label: 'Consulting' },
  { value: 'INACTIVE', label: 'Not consulting' },
];

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

const STATUS_WORDS: Record<DoctorDetail['status'], string> = {
  ACTIVE: 'Practising here',
  INACTIVE: 'Not currently practising',
  ARCHIVED: 'Retired from this clinic',
};

/** 09:00, from the "09:00:00" the API sends. */
function clockTime(value: string): string {
  return value.slice(0, 5);
}

/**
 * The control that opens and closes a section.
 *
 * One component so every section's affordance reads the same and announces the
 * same way — `aria-expanded` on all of them, and the label says what closing
 * does rather than repeating the section name.
 */
function EditToggle({
  editing,
  onToggle,
  label,
}: {
  editing: boolean;
  onToggle: () => void;
  /** What pressing it edits, e.g. "working hours". Used in the label and for AT. */
  label: string;
}) {
  return (
    <Button variant="secondary" size="sm" onClick={onToggle} aria-expanded={editing}>
      {editing ? 'Done' : 'Edit'}
      <span className="sr-only"> {label}</span>
    </Button>
  );
}

function fieldErrors(
  state: DoctorFormState,
  field: string
): { errors: string[] } | Record<string, never> {
  return state.fieldErrors?.[field] ? { errors: state.fieldErrors[field] } : {};
}

/**
 * Whether a section is open, closing itself the moment its save succeeds.
 *
 * ⚠️ THE CLOSE IS A RENDER-PHASE ADJUSTMENT, NOT AN EFFECT, AND THAT IS NOT A
 *   STYLE CHOICE. `useEffect(() => { if (saved) setEditing(false) })` is a
 *   synchronous setState inside an effect: the React Compiler rejects it, and it
 *   cascades a render — the form paints once more over now-stale defaults before
 *   collapsing. Comparing the status against the last one seen makes the section
 *   close in the same pass that delivered the result, so there is no flash of a
 *   form the save has already superseded.
 *
 *   Same shape as the board's filter reset in `appointment-board.tsx`, which is
 *   where this pattern is explained at length.
 *
 * Leaving the section open on `error` is deliberate: the message and the fields
 * it refers to are both inside the form.
 */
function useSectionEditing(
  status: DoctorFormState['status']
): [boolean, React.Dispatch<React.SetStateAction<boolean>>] {
  const [editing, setEditing] = useState(false);
  const [seen, setSeen] = useState(status);

  if (status !== seen) {
    setSeen(status);
    if (status === 'saved') setEditing(false);
  }

  return [editing, setEditing];
}

// ---------------------------------------------------------------------------
// Identity: the header card
// ---------------------------------------------------------------------------

/**
 * Who this doctor is and what registers them to practise.
 *
 * The name is not editable here, deliberately: it belongs to the user record and
 * is changed on the person, not on their doctor profile. Retiring lives at the
 * bottom of this section's edit mode because it is the most destructive thing on
 * the page and belongs behind a deliberate act, not beside a Save.
 */
export function DoctorIdentityCard({
  slug,
  doctor,
  canEdit,
  canArchive,
}: {
  slug: string;
  doctor: DoctorDetail;
  canEdit: boolean;
  canArchive: boolean;
}) {
  const [state, action, pending] = useActionState(updateDoctor.bind(null, slug, doctor.id), IDLE);
  const formRef = useRef<HTMLFormElement>(null);
  useOutcomeFocus(state.status, formRef);
  const [retiring, setRetiring] = useState(false);

  // Closes itself once the save lands — see `useSectionEditing`.
  const [editing, setEditing] = useSectionEditing(state.status);

  const primary = doctor.specialties.find((s) => s.isPrimary);

  return (
    <header className="border-rule bg-card mt-4 rounded-lg border p-5">
      <div className="flex flex-wrap items-start justify-between gap-6">
        <div className="min-w-0">
          <h1 className="font-display text-3xl tracking-tight">{doctor.fullName}</h1>
          <p className="text-muted mt-2 text-[0.9375rem]">
            {primary?.name ?? doctor.primarySpecialty ?? 'No specialty recorded'}
            {doctor.experienceYears !== null ? (
              <> · {doctor.experienceYears} years’ experience</>
            ) : null}
          </p>
          {/*
           * Status in words, never as a colour alone (WCAG 1.4.1). "Retired from
           * this clinic" is the fact a receptionist about to book them needs.
           */}
          <p className="text-muted mt-1 text-[0.8125rem]">{STATUS_WORDS[doctor.status]}</p>
        </div>

        <div className="flex items-start gap-4">
          {doctor.registrationNumber !== null && !editing ? (
            <div className="text-right">
              <p className="eyebrow text-drape">Registration</p>
              {/* Mono, like the UHID: this is a number read aloud and copied onto
                  a prescription, and it is what makes one legal. */}
              <p className="mt-1 font-mono text-[0.9375rem]">{doctor.registrationNumber}</p>
              {doctor.registrationCouncil !== null ? (
                <p className="text-muted mt-1 text-[0.75rem]">{doctor.registrationCouncil}</p>
              ) : null}
              {doctor.registrationValidTill !== null ? (
                <p className="text-muted mt-1 text-[0.75rem]">
                  Valid until {doctor.registrationValidTill}
                </p>
              ) : null}
            </div>
          ) : null}

          {canEdit ? (
            <EditToggle
              editing={editing}
              onToggle={() => setEditing((open) => !open)}
              label="registration and experience"
            />
          ) : null}
        </div>
      </div>

      {editing && canEdit ? (
        <div className="border-rule mt-5 border-t pt-5">
          <form ref={formRef} action={action} className="grid gap-4">
            {state.status !== 'idle' && state.message ? (
              <Alert tone={state.status === 'error' ? 'error' : 'info'}>{state.message}</Alert>
            ) : null}

            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              <Input
                name="registrationNumber"
                label="Medical council number"
                className="font-mono"
                defaultValue={doctor.registrationNumber ?? ''}
                {...fieldErrors(state, 'registrationNumber')}
              />
              <Input
                name="registrationCouncil"
                label="Council"
                defaultValue={doctor.registrationCouncil ?? ''}
                {...fieldErrors(state, 'registrationCouncil')}
              />
              <Input
                name="registrationValidTill"
                label="Valid until"
                type="date"
                defaultValue={doctor.registrationValidTill ?? ''}
                {...fieldErrors(state, 'registrationValidTill')}
              />
              <Input
                name="experienceYears"
                label="Years of experience"
                type="number"
                inputMode="numeric"
                min={0}
                max={80}
                defaultValue={doctor.experienceYears ?? ''}
                {...fieldErrors(state, 'experienceYears')}
              />
              <Select
                name="status"
                label="Currently"
                defaultValue={doctor.status === 'ARCHIVED' ? 'INACTIVE' : doctor.status}
                options={STATUSES}
                hint="Pausing keeps the profile but offers no new slots."
              />
            </div>

            <div className="flex gap-3">
              <Button type="submit" disabled={pending}>
                {pending ? 'Saving…' : 'Save'}
              </Button>
              <Button variant="ghost" onClick={() => setEditing(false)}>
                Cancel
              </Button>
            </div>
          </form>

          {canArchive && doctor.status !== 'ARCHIVED' ? (
            <div className="border-rule mt-5 border-t pt-5">
              {retiring ? (
                <div className="grid gap-3">
                  <p className="text-muted text-[0.8125rem] leading-relaxed">
                    Retiring removes {doctor.fullName} from the roster and clears their working
                    hours. Past appointments and prescriptions keep pointing at them.
                  </p>
                  <div className="flex gap-3">
                    <Button
                      variant="danger"
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
      ) : null}
    </header>
  );
}

// ---------------------------------------------------------------------------
// About
// ---------------------------------------------------------------------------

export function DoctorAboutPanel({
  slug,
  doctor,
  canEdit,
}: {
  slug: string;
  doctor: DoctorDetail;
  canEdit: boolean;
}) {
  const [state, action, pending] = useActionState(updateDoctor.bind(null, slug, doctor.id), IDLE);
  const formRef = useRef<HTMLFormElement>(null);
  useOutcomeFocus(state.status, formRef);
  const [editing, setEditing] = useSectionEditing(state.status);

  // Nothing written and nobody who could write it: the section would be an empty
  // box saying "Nothing recorded" on a screen that already has enough of those.
  if (doctor.bio === null && !canEdit) return null;

  return (
    <DoctorPanel
      title="About"
      action={
        canEdit ? (
          <EditToggle
            editing={editing}
            onToggle={() => setEditing((open) => !open)}
            label="the description"
          />
        ) : undefined
      }
    >
      {editing && canEdit ? (
        <form ref={formRef} action={action} className="mt-3 grid gap-4">
          {state.status !== 'idle' && state.message ? (
            <Alert tone={state.status === 'error' ? 'error' : 'info'}>{state.message}</Alert>
          ) : null}
          <Textarea
            name="bio"
            label="About this doctor"
            rows={4}
            defaultValue={doctor.bio ?? ''}
            hint="Shown on their profile."
            {...fieldErrors(state, 'bio')}
          />
          <div className="flex gap-3">
            <Button type="submit" disabled={pending}>
              {pending ? 'Saving…' : 'Save'}
            </Button>
            <Button variant="ghost" onClick={() => setEditing(false)}>
              Cancel
            </Button>
          </div>
        </form>
      ) : doctor.bio === null ? (
        <PanelEmpty>Nothing recorded.</PanelEmpty>
      ) : (
        <p className="mt-3 text-[0.9375rem] whitespace-pre-line">{doctor.bio}</p>
      )}
    </DoctorPanel>
  );
}

// ---------------------------------------------------------------------------
// Specialties
// ---------------------------------------------------------------------------

export function DoctorSpecialtiesPanel({
  slug,
  doctor,
  specialties,
  canEdit,
}: {
  slug: string;
  doctor: DoctorDetail;
  specialties: SpecialtySummary[];
  canEdit: boolean;
}) {
  const [state, action, pending] = useActionState(updateDoctor.bind(null, slug, doctor.id), IDLE);
  const formRef = useRef<HTMLFormElement>(null);
  useOutcomeFocus(state.status, formRef);
  const [editing, setEditing] = useSectionEditing(state.status);

  return (
    <DoctorPanel
      title="Specialties"
      note="The classification this doctor is listed under, most specific last."
      action={
        canEdit ? (
          <EditToggle
            editing={editing}
            onToggle={() => setEditing((open) => !open)}
            label="the specialties"
          />
        ) : undefined
      }
    >
      {editing && canEdit ? (
        <form ref={formRef} action={action} className="mt-3 grid gap-4">
          {state.status !== 'idle' && state.message ? (
            <Alert tone={state.status === 'error' ? 'error' : 'info'}>{state.message}</Alert>
          ) : null}
          {/*
           * ⚠️ THE PICKER CARRIES THE `classificationsPresent` SENTINEL, WHICH IS
           *   WHAT MAKES THIS SECTION SAFE TO SPLIT OFF. An empty selection here
           *   genuinely means "this doctor now has none" and must clear the set;
           *   the OTHER two forms on this page omit the picker entirely, so the
           *   API leaves classifications alone when they save. Without the
           *   sentinel, editing the bio would wipe every specialty.
           */}
          <ClassificationPicker
            specialties={specialties}
            defaultValue={doctor.specialties.map((s) => ({
              specialtyId: s.specialtyId,
              isPrimary: s.isPrimary,
              proficiency: s.proficiency,
              effectiveFrom: s.effectiveFrom,
              effectiveTo: s.effectiveTo,
            }))}
          />
          <div className="flex gap-3">
            <Button type="submit" disabled={pending}>
              {pending ? 'Saving…' : 'Save'}
            </Button>
            <Button variant="ghost" onClick={() => setEditing(false)}>
              Cancel
            </Button>
          </div>
        </form>
      ) : doctor.specialties.length === 0 ? (
        <PanelEmpty>Nothing recorded.</PanelEmpty>
      ) : (
        <ul className="mt-3 space-y-3">
          {doctor.specialties.map((specialty) => (
            <li key={specialty.id}>
              <p className="text-[0.9375rem]">
                {specialty.name}
                {specialty.isPrimary ? <span className="text-muted"> · primary</span> : null}
                {specialty.proficiency !== null ? (
                  <span className="text-muted"> · {specialty.proficiency.toLowerCase()}</span>
                ) : null}
              </p>
              {/* The ancestor chain, so "Structural Heart Disease" reads as
                  part of Cardiology rather than as a free-floating label. */}
              {specialty.ancestors.length > 0 ? (
                <p className="text-muted mt-0.5 text-[0.75rem]">
                  {specialty.ancestors.map((a) => a.name).join(' › ')}
                </p>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </DoctorPanel>
  );
}

// ---------------------------------------------------------------------------
// Qualifications
// ---------------------------------------------------------------------------

/**
 * Degrees: add, correct and remove, in place.
 *
 * ⚠️ CORRECTING A ROW IS A REAL OPERATION, NOT DELETE-THEN-ADD. Removing and
 *   re-adding to fix a misspelt institute loses the row's `createdAt` and files
 *   two audit entries for one correction, so the trail reads as though a
 *   qualification was withdrawn and a different one granted. `PATCH
 *   /qualifications/:rowId` exists for exactly this.
 *
 * Each row is its own `<form>`, SIBLINGS rather than nested — nested forms are
 * invalid HTML and the parser re-parents the inner one's controls onto the outer,
 * which is how a Save button ends up submitting somebody else's row.
 */
export function DoctorQualificationsPanel({
  slug,
  doctor,
  qualifications,
  canEdit,
}: {
  slug: string;
  doctor: DoctorDetail;
  qualifications: QualificationSummary[];
  canEdit: boolean;
}) {
  const [editing, setEditing] = useState(false);

  return (
    <DoctorPanel
      title="Qualifications"
      note={
        editing ? 'Correct what is recorded, or add a degree this doctor has earned.' : undefined
      }
      action={
        canEdit ? (
          <EditToggle
            editing={editing}
            onToggle={() => setEditing((open) => !open)}
            label="the qualifications"
          />
        ) : undefined
      }
    >
      {doctor.qualifications.length === 0 && !editing ? (
        <PanelEmpty>Nothing recorded.</PanelEmpty>
      ) : null}

      {doctor.qualifications.length > 0 ? (
        <ul className="mt-3 space-y-3">
          {doctor.qualifications.map((row) =>
            editing && canEdit ? (
              <li key={row.id}>
                <QualificationRow
                  slug={slug}
                  doctorId={doctor.id}
                  row={row}
                  qualifications={qualifications}
                />
              </li>
            ) : (
              <li key={row.id}>
                <p className="text-[0.9375rem]">{row.name}</p>
                <p className="text-muted mt-0.5 text-[0.75rem]">
                  {row.institute ?? 'Institute not recorded'}
                  {row.yearOfCompletion !== null ? ` · ${String(row.yearOfCompletion)}` : ''}
                </p>
              </li>
            )
          )}
        </ul>
      ) : null}

      {editing && canEdit ? (
        <div className="border-rule mt-4 border-t pt-4">
          <AddQualificationForm slug={slug} doctorId={doctor.id} qualifications={qualifications} />
        </div>
      ) : null}
    </DoctorPanel>
  );
}

function QualificationRow({
  slug,
  doctorId,
  row,
  qualifications,
}: {
  slug: string;
  doctorId: string;
  row: DoctorQualificationDetail;
  qualifications: QualificationSummary[];
}) {
  const [state, action, pending] = useActionState(
    updateQualification.bind(null, slug, doctorId, row.id),
    IDLE
  );
  const formRef = useRef<HTMLFormElement>(null);
  useOutcomeFocus(state.status, formRef);

  /*
   * ⚠️ A CATALOGUE ENTRY THAT HAS SINCE BEEN RETIRED IS STILL LISTED HERE. The
   *   masters call returns only active rows, so a doctor holding a qualification
   *   the clinic has since retired would otherwise see the select silently fall
   *   to its first option — and saving would rewrite their degree to whatever
   *   happened to be top of the list.
   */
  const options: SelectOption[] = qualifications.some((q) => q.id === row.qualificationId)
    ? qualifications.map((q) => ({ value: q.id, label: q.name }))
    : [
        { value: row.qualificationId, label: `${row.name} (no longer offered)` },
        ...qualifications.map((q) => ({ value: q.id, label: q.name })),
      ];

  return (
    <div className="border-rule bg-paper rounded-[var(--radius-md)] border p-3">
      <form ref={formRef} action={action} className="grid gap-3">
        {state.status !== 'idle' && state.message ? (
          <Alert tone={state.status === 'error' ? 'error' : 'info'}>{state.message}</Alert>
        ) : null}

        <div className="grid gap-3 sm:grid-cols-3">
          <Select
            name="qualificationId"
            label="Qualification"
            defaultValue={row.qualificationId}
            options={options}
            {...fieldErrors(state, 'qualificationId')}
          />
          <Input
            name="institute"
            label="Institute"
            defaultValue={row.institute ?? ''}
            hint="Clear it to remove what is recorded."
            {...fieldErrors(state, 'institute')}
          />
          <Input
            name="yearOfCompletion"
            label="Year"
            type="number"
            inputMode="numeric"
            min={1900}
            max={2100}
            defaultValue={row.yearOfCompletion ?? ''}
            {...fieldErrors(state, 'yearOfCompletion')}
          />
        </div>

        <div className="flex flex-wrap gap-2">
          <Button type="submit" size="sm" disabled={pending}>
            {pending ? 'Saving…' : 'Save'}
            <span className="sr-only"> changes to {row.name}</span>
          </Button>
          {/*
            Outside the submit path — `Button` defaults to type="button", so this
            calls the delete action rather than submitting the row it sits in.
          */}
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              void removeQualification(slug, doctorId, row.id);
            }}
          >
            Remove
            <span className="sr-only"> {row.name}</span>
          </Button>
        </div>
      </form>
    </div>
  );
}

function AddQualificationForm({
  slug,
  doctorId,
  qualifications,
}: {
  slug: string;
  doctorId: string;
  qualifications: QualificationSummary[];
}) {
  const [state, action, pending] = useActionState(
    addQualification.bind(null, slug, doctorId),
    IDLE
  );
  const formRef = useRef<HTMLFormElement>(null);
  useOutcomeFocus(state.status, formRef);

  // Clear the boxes after a save so the next degree starts from empty rather
  // than from the one just added.
  useEffect(() => {
    if (state.status === 'saved') formRef.current?.reset();
  }, [state.status]);

  return (
    <form ref={formRef} action={action} className="grid gap-3">
      {state.status !== 'idle' && state.message ? (
        <Alert tone={state.status === 'error' ? 'error' : 'info'}>{state.message}</Alert>
      ) : null}

      <div className="grid gap-3 sm:grid-cols-3">
        <Select
          name="qualificationId"
          label="Add a qualification"
          required
          placeholder="Choose one"
          options={qualifications.map((q) => ({ value: q.id, label: q.name }))}
          {...fieldErrors(state, 'qualificationId')}
        />
        <Input name="institute" label="Institute" {...fieldErrors(state, 'institute')} />
        <Input
          name="yearOfCompletion"
          label="Year"
          type="number"
          inputMode="numeric"
          min={1900}
          max={2100}
          {...fieldErrors(state, 'yearOfCompletion')}
        />
      </div>

      <div>
        <Button type="submit" size="sm" disabled={pending}>
          {pending ? 'Adding…' : 'Add this qualification'}
        </Button>
      </div>
    </form>
  );
}

// ---------------------------------------------------------------------------
// Working hours
// ---------------------------------------------------------------------------

/**
 * What the front desk books against.
 *
 * Blocks are added and removed one at a time rather than the week being replaced
 * wholesale, which is the opposite of the branch hours editor — and deliberately
 * so. A branch has exactly one span per day, so replacing the set is unambiguous.
 * A doctor's week is a variable number of blocks across branches, and a
 * replace-everything form would make removing one block require re-entering all
 * the others.
 *
 * ⚠️ THERE IS NO EDIT-IN-PLACE FOR A BLOCK, AND THAT IS THE API'S SHAPE, NOT AN
 *   OVERSIGHT. `doctor_schedules` is guarded by a GiST exclusion constraint
 *   against overlaps, so changing a block's times is a delete and an insert
 *   whichever way it is expressed; the endpoints are POST and DELETE only.
 *   Pretending otherwise here would mean a "Save" that silently did both and
 *   could half-fail.
 */
export function DoctorHoursPanel({
  slug,
  doctor,
  branches,
  canEdit,
}: {
  slug: string;
  doctor: DoctorDetail;
  branches: BranchDetail[];
  canEdit: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const [state, action, pending] = useActionState(addSchedule.bind(null, slug, doctor.id), IDLE);
  const formRef = useRef<HTMLFormElement>(null);
  useOutcomeFocus(state.status, formRef);

  /*
   * Today, read once at mount rather than in the render body — a clock read
   * during render differs between the server pass and hydration, which the React
   * Compiler rejects. It is only the default for a date the user can change.
   */
  const [today] = useState(() => new Date().toISOString().slice(0, 10));

  const ordered = doctor.schedules
    .slice()
    .sort((a, b) =>
      a.dayOfWeek === b.dayOfWeek
        ? a.startTime.localeCompare(b.startTime)
        : a.dayOfWeek - b.dayOfWeek
    );

  return (
    <DoctorPanel
      title="Working hours"
      note="What the front desk books against."
      action={
        canEdit ? (
          <EditToggle
            editing={editing}
            onToggle={() => setEditing((open) => !open)}
            label="the working hours"
          />
        ) : undefined
      }
    >
      {ordered.length === 0 && !editing ? <PanelEmpty>No working hours set.</PanelEmpty> : null}

      {ordered.length > 0 ? (
        <ul className={editing && canEdit ? 'mt-3 grid gap-2' : 'mt-3 space-y-2'}>
          {ordered.map((schedule) =>
            editing && canEdit ? (
              <li
                key={schedule.id}
                className="border-rule bg-paper flex flex-wrap items-center justify-between gap-3 rounded-md border px-3 py-2"
              >
                <div className="min-w-0">
                  <p className="text-ink text-[0.875rem]">
                    {DAYS[schedule.dayOfWeek]}{' '}
                    <span className="font-mono text-[0.8125rem]">
                      {clockTime(schedule.startTime)}–{clockTime(schedule.endTime)}
                    </span>
                  </p>
                  <p className="text-muted mt-0.5 text-[0.75rem]">
                    {schedule.branchName} ·{' '}
                    {/*
                      Inheritance is a real concept here (ADR-0015), so the row
                      says which of the two it is rather than showing a number
                      whose origin the reader has to guess.
                    */}
                    {schedule.slotMinutes === null
                      ? `${String(schedule.effectiveSlotMinutes)} min slots, from clinic settings`
                      : `${String(schedule.slotMinutes)} min slots, set here`}
                    {schedule.maxPatients !== null
                      ? ` · up to ${String(schedule.maxPatients)} patients`
                      : ''}
                    {!schedule.isActive ? ' · not in use' : ''}
                  </p>
                </div>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    void removeSchedule(slug, doctor.id, schedule.id);
                  }}
                >
                  Remove
                  <span className="sr-only">
                    {' '}
                    {DAYS[schedule.dayOfWeek]} {clockTime(schedule.startTime)} to{' '}
                    {clockTime(schedule.endTime)}
                  </span>
                </Button>
              </li>
            ) : (
              <li key={schedule.id} className="text-[0.9375rem]">
                <span className="inline-block w-24">{DAYS[schedule.dayOfWeek] ?? 'Unknown'}</span>
                <span className="font-mono text-[0.8125rem]">
                  {clockTime(schedule.startTime)}–{clockTime(schedule.endTime)}
                </span>
                <span className="text-muted text-[0.75rem]">
                  {' · '}
                  {schedule.branchName}
                  {/* `effectiveSlotMinutes`, not `slotMinutes` — the latter is
                      null when the block inherits from the settings ladder, and
                      "null min slots" is what a raw read renders (ADR-0015). */}
                  {' · '}
                  {schedule.effectiveSlotMinutes} min slots
                  {!schedule.isActive ? ' · not in use' : ''}
                </span>
              </li>
            )
          )}
        </ul>
      ) : null}

      {editing && canEdit ? (
        <div className="border-rule mt-4 border-t pt-4">
          <form ref={formRef} action={action} className="grid gap-4">
            {state.status !== 'idle' && state.message ? (
              <Alert tone={state.status === 'error' ? 'error' : 'info'}>{state.message}</Alert>
            ) : null}

            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              <Select
                name="branchId"
                label="Branch"
                required
                options={branches.map((b) => ({ value: b.id, label: b.name }))}
                {...fieldErrors(state, 'branchId')}
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
                {...fieldErrors(state, 'startTime')}
              />
              <Input
                name="endTime"
                label="To"
                type="time"
                required
                {...fieldErrors(state, 'endTime')}
              />
              <Input
                name="maxPatients"
                label="Patient cap"
                type="number"
                inputMode="numeric"
                min={1}
                placeholder="No cap"
              />
              <Input
                name="validFrom"
                label="Starting from"
                type="date"
                required
                defaultValue={today}
              />
            </div>

            <div>
              <Button type="submit" disabled={pending}>
                {pending ? 'Adding…' : 'Add these hours'}
              </Button>
            </div>
          </form>
        </div>
      ) : null}
    </DoctorPanel>
  );
}
