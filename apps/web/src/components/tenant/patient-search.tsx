'use client';

import Link from 'next/link';
import { useActionState, useCallback, useEffect, useRef, useState } from 'react';
import type { BranchDetail, PatientDuplicateMatch, PatientSummary } from '@rcln/contracts';
import { Input, Select, type SelectOption } from '@/components/ui/field';
import { Button } from '@/components/ui/button';
import { Alert, useOutcomeFocus } from '@/components/ui/alert';
import {
  checkForDuplicates,
  registerPatient,
  searchPatients,
  type PatientFormState,
  type SearchState,
} from '@/app/(tenant)/t/[slug]/(app)/patients/actions';

const IDLE: PatientFormState = { status: 'idle' };

/**
 * ⚠️ DECLARED HERE, NOT IMPORTED FROM `actions.ts`.
 *
 * That file is `'use server'`, and every export from one must be an async
 * function — Next compiles each into a server reference. A constant exported
 * alongside them arrives as `undefined` in the browser, and the crash lands
 * wherever it is first dereferenced rather than at the import, which is a long
 * way from the mistake. `SearchState` is a type and erases, so it can be shared;
 * the value cannot.
 */
const EMPTY_SEARCH: SearchState = {
  status: 'idle',
  patients: [],
  scope: 'BRANCH',
  total: 0,
};

const GENDERS: SelectOption[] = [
  { value: 'FEMALE', label: 'Female' },
  { value: 'MALE', label: 'Male' },
  { value: 'OTHER', label: 'Other' },
  { value: 'UNKNOWN', label: 'Not recorded' },
];

const BLOOD_GROUPS: SelectOption[] = [
  { value: 'UNKNOWN', label: 'Not known' },
  { value: 'O_POSITIVE', label: 'O positive' },
  { value: 'O_NEGATIVE', label: 'O negative' },
  { value: 'A_POSITIVE', label: 'A positive' },
  { value: 'A_NEGATIVE', label: 'A negative' },
  { value: 'B_POSITIVE', label: 'B positive' },
  { value: 'B_NEGATIVE', label: 'B negative' },
  { value: 'AB_POSITIVE', label: 'AB positive' },
  { value: 'AB_NEGATIVE', label: 'AB negative' },
];

const GENDER_WORDS: Record<string, string> = {
  FEMALE: 'Female',
  MALE: 'Male',
  OTHER: 'Other',
  UNKNOWN: 'Sex not recorded',
};

/** "34 · Female", or "approx. 60 · Male" when the age was estimated. */
export function ageLine(patient: {
  age: number | null;
  ageIsApproximate: boolean;
  gender: string;
}): string {
  const sex = GENDER_WORDS[patient.gender] ?? 'Sex not recorded';
  if (patient.age === null) return sex;
  return `${patient.ageIsApproximate ? 'approx. ' : ''}${String(patient.age)} · ${sex}`;
}

/**
 * Patient lookup.
 *
 * ⚠️ THE TERM IS NEVER PUT IN THE URL. Searching is a server action into
 * component state, not a navigation — see the header of actions.ts. The visible
 * consequence is that results do not survive a refresh, which is deliberate: a
 * link to somebody's medical record is exactly the artefact that should not
 * exist.
 *
 * The screen opens empty and stays empty until someone asks a question. That is
 * the design, not a loading state.
 */
export function PatientSearch({
  slug,
  branches,
  canCreate,
}: {
  slug: string;
  branches: BranchDetail[];
  canCreate: boolean;
}) {
  const [state, action, pending] = useActionState(searchPatients.bind(null, slug), EMPTY_SEARCH);
  const [registering, setRegistering] = useState(false);
  const closeRegister = useCallback(() => setRegistering(false), []);

  return (
    <>
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="eyebrow text-drape">Records</p>
          <h1 className="font-display mt-2 text-3xl tracking-tight">Patients</h1>
          <p className="text-muted mt-2 max-w-xl text-[0.9375rem] leading-relaxed">
            Look someone up by name, phone, hospital number or record number. Opening a record is
            logged.
          </p>
        </div>
        {canCreate && branches.length > 0 ? (
          <Button onClick={() => setRegistering((open) => !open)} aria-expanded={registering}>
            {registering ? 'Cancel' : 'Register a patient'}
          </Button>
        ) : null}
      </div>

      {registering ? (
        <div className="border-drape bg-drape-tint/40 mt-6 rounded-lg border p-5">
          <RegisterForm slug={slug} branches={branches} onDone={closeRegister} />
        </div>
      ) : null}

      <SearchForm
        action={action}
        pending={pending}
        state={state}
        multiBranch={branches.length > 1}
      />

      <Results state={state} slug={slug} pending={pending} />
    </>
  );
}

function SearchForm({
  action,
  pending,
  state,
  multiBranch,
}: {
  action: (formData: FormData) => void;
  pending: boolean;
  state: SearchState;
  multiBranch: boolean;
}) {
  return (
    <form action={action} className="border-rule bg-card mt-8 rounded-lg border p-5">
      <div className="flex flex-wrap items-end gap-4">
        <Input
          name="q"
          label="Find a patient"
          placeholder="Name, phone, P000123 or MRN000123"
          autoComplete="off"
          fieldClassName="min-w-[16rem] flex-1"
          hint="At least two characters."
          minLength={2}
        />
        <Button type="submit" disabled={pending}>
          {pending ? 'Searching…' : 'Search'}
        </Button>
      </div>

      {/*
       * Widening the search past this clinic is a deliberate act with a plain
       * label, not a hidden default. It is how a duplicate is found before a
       * second record is created — and every widened search is recorded.
       */}
      {multiBranch ? (
        <fieldset className="border-rule mt-4 border-t pt-4">
          <legend className="sr-only">Where to look</legend>
          <div className="flex flex-wrap gap-x-6 gap-y-2">
            <label className="text-ink flex items-center gap-2 text-[0.875rem]">
              <input
                type="radio"
                name="scope"
                value="BRANCH"
                defaultChecked={state.scope === 'BRANCH'}
                className="accent-drape"
              />
              This clinic
            </label>
            <label className="text-ink flex items-center gap-2 text-[0.875rem]">
              <input
                type="radio"
                name="scope"
                value="ORGANIZATION"
                defaultChecked={state.scope === 'ORGANIZATION'}
                className="accent-drape"
              />
              Every clinic in the group
            </label>
          </div>
          <p className="text-muted mt-2 text-[0.8125rem]">
            Search the whole group before registering someone new — it is how you find the record
            another clinic already made.
          </p>
        </fieldset>
      ) : null}
    </form>
  );
}

function Results({ state, slug, pending }: { state: SearchState; slug: string; pending: boolean }) {
  if (state.status === 'error') {
    return (
      <div className="mt-6">
        <Alert tone="error">{state.message}</Alert>
      </div>
    );
  }

  if (state.status === 'idle') {
    return (
      <div className="border-rule bg-card mt-6 rounded-lg border border-dashed p-8 text-center">
        <p className="text-ink text-[0.9375rem] font-medium">Nothing loaded yet</p>
        <p className="text-muted mx-auto mt-2 max-w-md text-[0.875rem] leading-relaxed">
          Patient records are not listed until you ask for one. Search above, or register someone
          new.
        </p>
      </div>
    );
  }

  if (state.patients.length === 0) {
    return (
      <div className="border-rule bg-card mt-6 rounded-lg border border-dashed p-8 text-center">
        <p className="text-ink text-[0.9375rem] font-medium">No one matched</p>
        <p className="text-muted mx-auto mt-2 max-w-md text-[0.875rem] leading-relaxed">
          {state.scope === 'BRANCH'
            ? 'Try searching every clinic in the group — they may be registered elsewhere.'
            : 'Nobody in this organization matches. Register them as a new patient.'}
        </p>
      </div>
    );
  }

  return (
    <div className="mt-6" aria-busy={pending}>
      <p className="text-muted text-[0.8125rem]" role="status">
        {state.total === 1 ? '1 record' : `${String(state.total)} records`}
        {state.scope === 'ORGANIZATION' ? ' across every clinic in the group' : ' at this clinic'}
      </p>

      <ul className="mt-3 grid gap-2">
        {state.patients.map((patient) => (
          <li key={patient.id}>
            <ResultRow slug={slug} patient={patient} />
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * One result.
 *
 * The signature of this screen: the numbers a clinic says out loud are set in
 * mono and given their own column, because "P000451" is what the front desk
 * reads back down the phone and what is written on a file cover. Name is the
 * heading; the identifiers are the index.
 */
function ResultRow({ slug, patient }: { slug: string; patient: PatientSummary }) {
  return (
    <Link
      href={`/t/${slug}/patients/${patient.id}`}
      className="border-rule bg-card hover:bg-drape-tint/30 focus-visible:outline-drape flex flex-wrap items-center justify-between gap-4 rounded-lg border px-5 py-4 transition-colors focus-visible:outline-2 focus-visible:outline-offset-2"
    >
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-ink text-[1.0625rem] font-medium">{patient.fullName}</span>
          {patient.status !== 'ACTIVE' ? (
            <span className="bg-signal-tint text-signal rounded-xs px-2 py-0.5 text-[0.6875rem] font-medium">
              {patient.status === 'DECEASED' ? 'Deceased' : patient.status.toLowerCase()}
            </span>
          ) : null}
        </div>
        <p className="text-muted mt-1 text-[0.8125rem]">
          {ageLine(patient)}
          {patient.phone !== null ? ` · ${patient.phone}` : ''}
        </p>
      </div>

      <div className="text-right">
        <p className="text-ink font-mono text-[0.8125rem]">
          <span className="sr-only">Hospital number: </span>
          {patient.uhid}
        </p>
        {patient.mrn !== null ? (
          <p className="text-muted font-mono text-[0.75rem]">
            <span className="sr-only">Record number: </span>
            {patient.mrn}
          </p>
        ) : (
          /*
           * No MRN visible means this person attends a different clinic in the
           * group. Said in words, not implied by an absence — otherwise the
           * desk reads a blank as "not registered yet" and registers them
           * again, which is the exact duplicate this search exists to prevent.
           */
          <p className="text-signal text-[0.75rem]">Registered at another clinic</p>
        )}
      </div>
    </Link>
  );
}

/**
 * Register someone new.
 *
 * The duplicate check runs on blur of the phone field rather than on submit:
 * warning after the form is filled is a warning nobody acts on, because the
 * work is already done. Phone is the field people actually remember, so it is
 * the one that triggers it.
 */
function RegisterForm({
  slug,
  branches,
  onDone,
}: {
  slug: string;
  branches: BranchDetail[];
  onDone: () => void;
}) {
  const [state, action, pending] = useActionState(registerPatient.bind(null, slug), IDLE);
  const [matches, setMatches] = useState<PatientDuplicateMatch[]>([]);
  const formRef = useRef<HTMLFormElement>(null);
  useOutcomeFocus(state.status, formRef);

  useEffect(() => {
    if (state.status === 'saved') onDone();
  }, [state.status, onDone]);

  const probe = useCallback(
    async (phone: string) => {
      if (phone.trim().length < 6) {
        setMatches([]);
        return;
      }
      setMatches(await checkForDuplicates(slug, { phone: phone.trim() }));
    },
    [slug]
  );

  return (
    <form ref={formRef} action={action} className="grid gap-4">
      {state.status === 'error' && state.message ? (
        <Alert tone="error">{state.message}</Alert>
      ) : null}

      {/*
       * `error` rather than `info`, and the tone is the point: this is not a
       * note, it is a stop. `Alert` gives an error `role="alert"`, which
       * interrupts a screen reader mid-form — correct here, because carrying on
       * produces a duplicate record with an empty allergy list.
       */}
      {matches.length > 0 ? (
        <Alert tone="error">
          <span className="font-medium">
            {matches.length === 1
              ? 'Someone with this phone number is already registered.'
              : `${String(matches.length)} people with this phone number are already registered.`}
          </span>{' '}
          Open the existing record instead of making a second one — a new record starts with an
          empty allergy list.
          <ul className="mt-2 grid gap-1">
            {matches.map((match) => (
              <li key={match.id}>
                <Link
                  href={`/t/${slug}/patients/${match.id}`}
                  className="text-drape font-medium underline underline-offset-2"
                >
                  {match.fullName}
                </Link>
                <span className="text-muted font-mono text-[0.75rem]"> {match.uhid}</span>
                {match.branchNames.length > 0 ? (
                  <span className="text-muted text-[0.75rem]">
                    {' '}
                    · {match.branchNames.join(', ')}
                  </span>
                ) : null}
              </li>
            ))}
          </ul>
        </Alert>
      ) : null}

      <div className="grid gap-4 sm:grid-cols-2">
        <Input
          name="firstName"
          label="First name"
          required
          autoComplete="off"
          {...(state.fieldErrors?.['firstName'] ? { errors: state.fieldErrors['firstName'] } : {})}
        />
        <Input name="lastName" label="Last name" autoComplete="off" />

        <Input
          name="phone"
          label="Phone"
          type="tel"
          autoComplete="off"
          hint="Checked against existing records as you leave the field."
          onBlur={(event) => void probe(event.currentTarget.value)}
          {...(state.fieldErrors?.['phone'] ? { errors: state.fieldErrors['phone'] } : {})}
        />
        <Select
          name="branchId"
          label="Registering at"
          required
          options={branches.map((b) => ({ value: b.id, label: b.name }))}
          hint="Decides which record number they get."
        />

        <Input
          name="dateOfBirth"
          label="Date of birth"
          type="date"
          {...(state.fieldErrors?.['dateOfBirth']
            ? { errors: state.fieldErrors['dateOfBirth'] }
            : {})}
        />
        {/*
         * Both age fields on the form, and the contract refuses both filled.
         * Offering only the date would push the desk into inventing one for the
         * patient who knows they are "about 60" — and an invented birthday is
         * the number a paediatric dose gets calculated from.
         */}
        <Input
          name="approxAgeYears"
          label="…or age in years"
          type="number"
          inputMode="numeric"
          min={0}
          max={130}
          hint="Only if the date of birth is not known."
          {...(state.fieldErrors?.['approxAgeYears']
            ? { errors: state.fieldErrors['approxAgeYears'] }
            : {})}
        />

        <Select name="gender" label="Sex" options={GENDERS} defaultValue="UNKNOWN" />
        <Select
          name="bloodGroup"
          label="Blood group"
          options={BLOOD_GROUPS}
          defaultValue="UNKNOWN"
        />

        <Input name="line1" label="Address" autoComplete="off" fieldClassName="sm:col-span-2" />
        <Input name="city" label="City" autoComplete="off" />
        <Input name="pincode" label="PIN code" inputMode="numeric" autoComplete="off" />

        <Input
          name="abhaNumber"
          label="ABHA number"
          autoComplete="off"
          className="font-mono"
          hint="14 digits, or an address like someone@abdm."
          {...(state.fieldErrors?.['abhaNumber']
            ? { errors: state.fieldErrors['abhaNumber'] }
            : {})}
        />
        <Input name="nationalId" label="ID produced" autoComplete="off" hint="Aadhaar, passport." />
      </div>

      <fieldset className="border-rule border-t pt-4">
        <legend className="eyebrow text-drape">Who to ring</legend>
        <div className="mt-3 grid gap-4 sm:grid-cols-3">
          <Input name="contactName" label="Name" autoComplete="off" />
          <Input name="contactRelation" label="Relation" autoComplete="off" placeholder="Spouse" />
          <Input name="contactPhone" label="Phone" type="tel" autoComplete="off" />
        </div>
      </fieldset>

      <div className="flex gap-3">
        <Button type="submit" disabled={pending}>
          {pending ? 'Registering…' : 'Register patient'}
        </Button>
      </div>
    </form>
  );
}
