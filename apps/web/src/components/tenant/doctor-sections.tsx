'use client';

import { useActionState, useEffect, useRef, useState } from 'react';
import type {
  BranchDetail,
  DoctorDetail,
  DoctorQualificationDetail,
  QualificationSummary,
  SpecialtySummary,
  DoctorWeekResponse,
} from '@rcln/contracts';
import { Alert, useOutcomeFocus } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Input, Select, Textarea, type SelectOption } from '@/components/ui/field';
import { ClassificationPicker } from '@/components/tenant/classification-picker';
import { DoctorPanel, PanelEmpty } from '@/components/tenant/doctor-panel';
import {
  addQualification,
  saveDoctorWeek,
  removeQualification,
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

/** Blank inherits the clinic's setting rather than pinning a number (ADR-0015). */
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
 * What the front desk books against — a doctor's week, as a week (DS-1).
 *
 * ⚠️ TWO ANSWERS, AND THE FIRST ONE IS NOT A SHORTCUT FOR THE SECOND. A doctor
 *   who works whenever the clinic is open is recorded as exactly that, and the
 *   availability engine reads the branch's opening hours for them, live. It does
 *   NOT copy those hours onto the doctor: a clinic that later opens an hour
 *   earlier must not leave every full-time doctor quietly on the old rota, and a
 *   copy would do precisely that with nothing on any screen to show it.
 *
 * ⚠️ AND THE TABLE REPLACED AN "ADD A BLOCK" FORM, WHICH IS WHY IT HAS SEVEN
 *   FIXED ROWS. The old form asked for a day, a start, an end, a slot length, a
 *   cap and a start date, and let somebody add three overlapping Tuesdays with
 *   no view of the week at all — the overlap was refused by a database
 *   constraint, at submit, one block too late. Seven rows cannot express the
 *   overlap in the first place, and the week is legible at a glance.
 *
 * ⚠️ TWO PERIODS PER DAY, NOT ONE. Morning-and-evening OPD is the normal shape
 *   of a consulting week here — 9 to 1, then 5 to 8 — and a single from/to per
 *   day would have made the commonest arrangement in the product inexpressible.
 *   Three or more blocks on one day is no longer creatable; a doctor who already
 *   has them reads back as the outer span, and saving normalises to two.
 */
export function DoctorHoursPanel({
  slug,
  doctor,
  branches,
  weeks,
  canEdit,
}: {
  slug: string;
  doctor: DoctorDetail;
  branches: BranchDetail[];
  /** One per branch this caller can see. Fetched server-side; see the page. */
  weeks: DoctorWeekResponse[];
  canEdit: boolean;
}) {
  const [branchId, setBranchId] = useState(weeks[0]?.branchId ?? branches[0]?.id ?? '');
  const week = weeks.find((w) => w.branchId === branchId) ?? weeks[0];

  const [state, action, pending] = useActionState(saveDoctorWeek.bind(null, slug, doctor.id), IDLE);
  const formRef = useRef<HTMLFormElement>(null);
  useOutcomeFocus(state.status, formRef);

  /*
   * The radio is local state rather than a form value read back, because the
   * table has to disappear the moment "same as the clinic" is chosen — a table
   * still on screen under a radio that says it is being ignored is a screen
   * arguing with itself.
   */
  const [mode, setMode] = useState<'BRANCH' | 'OWN'>(week?.followsBranchHours ? 'BRANCH' : 'OWN');

  if (!week) {
    return (
      <DoctorPanel title="Working hours" note="What the front desk books against.">
        <Alert tone="info">
          This doctor is not attached to a site you can see, so their hours cannot be set here.
        </Alert>
      </DoctorPanel>
    );
  }

  const branchDay = (day: number) => week.branchHours.find((h) => h.dayOfWeek === day);
  const err = (name: string) => state.fieldErrors?.[name];

  return (
    <DoctorPanel title="Working hours" note="What the front desk books against.">
      {state.status !== 'idle' && state.message ? (
        <Alert tone={state.status === 'error' ? 'error' : 'success'} className="mb-4">
          {state.message}
        </Alert>
      ) : null}

      <form ref={formRef} action={action} className="space-y-5">
        <input type="hidden" name="branchId" value={week.branchId} />

        {weeks.length > 1 ? (
          <Select
            name="branchSelector"
            label="Which site"
            hint="Each site has its own hours. Save one before switching."
            value={branchId}
            onChange={(event) => {
              setBranchId(event.target.value);
              const next = weeks.find((w) => w.branchId === event.target.value);
              setMode(next?.followsBranchHours ? 'BRANCH' : 'OWN');
            }}
            options={weeks.map((w) => ({ value: w.branchId, label: w.branchName }))}
            disabled={!canEdit}
          />
        ) : null}

        <fieldset className="space-y-2" disabled={!canEdit}>
          <legend className="text-ink text-[0.9375rem] font-medium">When do they consult?</legend>

          <label className="border-rule hover:bg-drape-tint/30 flex cursor-pointer items-start gap-3 rounded-md border p-4">
            <input
              type="radio"
              name="followsBranchHours"
              value="BRANCH"
              checked={mode === 'BRANCH'}
              onChange={() => {
                setMode('BRANCH');
              }}
              className="accent-drape mt-0.5 size-4 shrink-0"
            />
            <span>
              <span className="text-ink block text-[0.9375rem]">
                Whenever {week.branchName} is open
              </span>
              <span className="text-muted block text-[0.8125rem]">
                For a doctor who works here full time. If the clinic changes its opening hours,
                theirs change with it.
              </span>
            </span>
          </label>

          <label className="border-rule hover:bg-drape-tint/30 flex cursor-pointer items-start gap-3 rounded-md border p-4">
            <input
              type="radio"
              name="followsBranchHours"
              value="OWN"
              checked={mode === 'OWN'}
              onChange={() => {
                setMode('OWN');
              }}
              className="accent-drape mt-0.5 size-4 shrink-0"
            />
            <span>
              <span className="text-ink block text-[0.9375rem]">Their own hours</span>
              <span className="text-muted block text-[0.8125rem]">
                For a visiting consultant, or anyone who keeps different hours from the clinic.
              </span>
            </span>
          </label>
        </fieldset>

        {mode === 'BRANCH' ? (
          /*
           * ⚠️ THE CLINIC'S WEEK IS SHOWN, NOT JUST NAMED. "Same as the clinic"
           *   is a promise about hours somebody would otherwise have to go and
           *   look up in another screen to check.
           */
          <div className="border-rule bg-drape-tint/30 rounded-md border p-4">
            <p className="text-drape-deep text-[0.875rem] font-medium">{week.branchName} is open</p>
            <ul className="text-drape mt-2 space-y-1 text-[0.875rem]">
              {DAY_ORDER.map((day) => {
                const hours = branchDay(day);
                return (
                  <li key={day} className="flex gap-3">
                    <span className="w-24 shrink-0">{DAYS[day]}</span>
                    <span>
                      {!hours || hours.isClosed
                        ? 'Closed'
                        : `${clockTime(hours.opensAt)} – ${clockTime(hours.closesAt)}`}
                    </span>
                  </li>
                );
              })}
            </ul>
            {week.branchHours.length === 0 ? (
              <p className="text-signal mt-3 text-[0.8125rem]">
                This site has no opening hours set yet, so nothing can be booked. Set them in
                Branches first.
              </p>
            ) : null}
          </div>
        ) : (
          <div className="space-y-3">
            {err('days') ? <Alert tone="error">{err('days')?.join(' ')}</Alert> : null}

            {/* p-1.5: a focus ring is drawn OUTSIDE the control, and an
                  `overflow-x-auto` box clips it — most visibly on the last
                  column, where the ring meets the table edge. The padding is
                  inside the scroll area, so it gives the ring room without
                  moving the table. */}
            <div className="overflow-x-auto p-1.5">
              <table className="w-full min-w-[49rem] border-separate border-spacing-0 text-[0.875rem]">
                <colgroup>
                  {/*
                   * ⚠️ FIVE COLUMNS, NOT SEVEN. Each session is ONE cell holding its
                   *   own "from" and "to" — the words are in the row rather than
                   *   in a header, so a row reads as a sentence rather than as
                   *   four identical boxes whose meaning lives two rows above.
                   *
                   * ⚠️ A ONE-LINE SESSION CELL HOLDS "from", a time field, "to" and a
                   *   second time field, and the fields are `flex-1` — the column
                   *   width minus the gutter is what they share. 10.5rem of
                   *   content is the floor, and it is reachable at all only
                   *   because the browser's picker glyph is hidden (see
                   *   `TIME_INPUT`). Below it the fields clip the value they are
                   *   showing, which is worse than a wide column.
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
                  {DAY_ORDER.map((day) => {
                    const row = week.days.find((d) => d.dayOfWeek === day);
                    return (
                      <tr key={day}>
                        <td className="border-rule text-ink border-b py-2 pr-6">{DAYS[day]}</td>
                        <SessionCell
                          day={DAYS[day] ?? ''}
                          session="First"
                          fromName={`am-from-${String(day)}`}
                          toName={`am-to-${String(day)}`}
                          from={row?.morning?.startTime}
                          to={row?.morning?.endTime}
                        />
                        <SessionCell
                          day={DAYS[day] ?? ''}
                          session="Second"
                          fromName={`pm-from-${String(day)}`}
                          toName={`pm-to-${String(day)}`}
                          from={row?.evening?.startTime}
                          to={row?.evening?.endTime}
                        />
                        <td className="border-rule border-b py-2 pr-6">
                          <input
                            type="number"
                            name={`slot-${String(day)}`}
                            min={5}
                            max={240}
                            defaultValue={row?.slotMinutes ?? ''}
                            placeholder="Clinic"
                            aria-label={`${DAYS[day]} slot length in minutes`}
                            className="border-rule bg-card text-ink w-full rounded border px-2 py-1"
                          />
                        </td>
                        <td className="border-rule border-b py-2">
                          <input
                            type="number"
                            name={`cap-${String(day)}`}
                            min={1}
                            max={500}
                            defaultValue={row?.maxPatients ?? ''}
                            placeholder="No cap"
                            aria-label={`${DAYS[day]} patient cap`}
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
              morning and evening — leave it blank if they do not. Slot length falls back to{' '}
              {week.effectiveSlotMinutes} minutes from the clinic&rsquo;s settings, and a blank cap
              means no limit.
            </p>
          </div>
        )}

        {canEdit ? (
          <div>
            <Button type="submit" disabled={pending}>
              {pending ? 'Saving…' : 'Save working hours'}
            </Button>
          </div>
        ) : null}
      </form>
    </DoctorPanel>
  );
}

/** Sunday last, because a working week starts on Monday for the person reading it. */
const DAY_ORDER = [1, 2, 3, 4, 5, 6, 0] as const;

/**
 * The time control in the week table. See the note in `SessionCell`.
 *
 * ⚠️ EXPORTED SO THE REGISTRATION FORM'S TABLE USES THE SAME ONE. The two
 *   tables are separate components for good reasons — one is controlled, the
 *   other is not — but a doctor's hours must not look or behave differently
 *   depending on which screen they were typed on, and the picker-glyph rule is
 *   exactly the sort of detail that gets fixed in one and forgotten in the other.
 */
export const TIME_INPUT =
  'border-rule bg-card text-ink min-w-0 flex-1 rounded border px-1.5 py-1 [&::-webkit-calendar-picker-indicator]:hidden';

/**
 * One session in the week table — "from [ ] to [ ]" in a single cell.
 *
 * ⚠️ THE WORDS ARE IN THE ROW, NOT IN A COLUMN HEADING. Four bare time boxes
 *   under a heading that says "First session" leave the reader counting
 *   positions to work out which one is the start; a row that reads "from 09:00
 *   to 13:00" does not. It also survives the table being scrolled sideways,
 *   where a header two rows up has gone off screen.
 *
 * Bare `<input>`s rather than `Field`: the visible words are the label, and
 * `Field` would wrap each in its own block. `aria-label` carries the full name —
 * day, session and end — which the two-word visible text cannot.
 */
function SessionCell({
  day,
  session,
  fromName,
  toName,
  from,
  to,
}: {
  day: string;
  session: 'First' | 'Second';
  fromName: string;
  toName: string;
  from: string | undefined;
  to: string | undefined;
}) {
  return (
    <td className="border-rule border-b py-2 pr-7">
      {/*
       * ⚠️ ONE LINE, AND THE PICKER GLYPH IS HIDDEN TO PAY FOR IT. A
       *   `type="time"` field draws a clock button roughly 1.5rem wide; with two
       *   fields and the words on one line that button was most of the reason
       *   the column could not go below about 14rem. Hiding it is the only
       *   lever left that does not cost the words or the single line.
       *
       *   THE COST, STATED: mouse users lose the dropdown. Typing still works,
       *   arrow keys still step the fields, and a touch device still opens its
       *   native picker on tap — so nothing is unreachable, but a desktop user
       *   who expected to click a clock will not find one.
       */}
      <div className="flex items-center gap-1">
        <span className="text-muted shrink-0 text-[0.8125rem]">from</span>
        <input
          type="time"
          name={fromName}
          defaultValue={from ?? ''}
          aria-label={`${day} ${session.toLowerCase()} session starts at`}
          className={TIME_INPUT}
        />
        <span className="text-muted shrink-0 text-[0.8125rem]">to</span>
        <input
          type="time"
          name={toName}
          defaultValue={to ?? ''}
          aria-label={`${day} ${session.toLowerCase()} session ends at`}
          className={TIME_INPUT}
        />
      </div>
    </td>
  );
}
