'use client';

import Link from 'next/link';
import { useActionState, useCallback, useEffect, useRef, useState } from 'react';
import type { PatientDuplicateMatch, PatientSummary } from '@rcln/contracts';
import { addressLabels, commonContactRelations, toE164 } from '@rcln/contracts';
import { Field, Input, Select, describedBy, type SelectOption } from '@/components/ui/field';
import { PhoneInput } from '@/components/ui/phone-input';
import { Button } from '@/components/ui/button';
import { Alert, useOutcomeFocus } from '@/components/ui/alert';
import { NationalIdInput } from '@/components/tenant/national-id-input';
import { GENDERS, ageLine } from '@/lib/patient-words';
import {
  checkForDuplicates,
  lookupPostalCode,
  registerPatient,
  searchPatients,
  type PatientFormState,
  type SearchState,
} from '@/app/(tenant)/t/[slug]/(app)/patients/actions';

/**
 * A branch, as much of one as a picker needs.
 *
 * ⚠️ DELIBERATELY NARROWER THAN `BranchDetail`. These screens only ever render a
 *   name against an id, and the branches they are handed come from the SESSION.
 *   `GET /branches` is behind `branch.read` — a permission the front desk does
 *   not hold, because it opens the branch MANAGEMENT screen — and asking for the
 *   fuller shape here is what forced that call and left this picker empty for
 *   the very people who need it. See `branchesInScope` in lib/session.ts.
 */
export type BranchChoice = { id: string; name: string };

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

/**
 * The sentinel the relation select uses to reveal a free-text box.
 *
 * ⚠️ NEVER SUBMITTED. `patientContactRequest.relation` is deliberately free text
 *   — a closed set of family relations is a cultural assumption, and "next
 *   friend" or a care-home key worker are real answers a fixed list refuses. The
 *   select is a shortcut for the four hundred times a day the answer is "Spouse",
 *   not a constraint; picking this swaps in an input and that is what is sent.
 */
const OTHER_RELATION = '__OTHER__';

/** What the duplicate banner should call the thing that matched. */
function matchWord(matches: PatientDuplicateMatch[]): string {
  const reasons = new Set(matches.flatMap((m) => m.matchedOn));
  if (reasons.has('NATIONAL_ID')) return 'ID';
  if (reasons.has('ABHA')) return 'ABHA number';
  if (reasons.has('PHONE')) return 'phone number';
  return 'name and date of birth';
}

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

/**
 * Whole years between a date of birth and today.
 *
 * ⚠️ DISPLAY ONLY — NOTHING COMPUTED HERE IS EVER SUBMITTED. `patients` carries a
 *   `patients_age_single_source` CHECK constraint and the contract refuses a date
 *   of birth and an approximate age together, precisely so a stale stored age can
 *   never be read instead of the date. Sending this back would be that bug with
 *   an extra step. The API derives the same number on read (`ageFrom`).
 *
 * Returns null for an unparseable or future date rather than a negative age, so
 * a half-typed year shows nothing instead of "-1980 years".
 */
function ageFromDob(value: string): number | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;

  const born = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(born.getTime())) return null;

  const now = new Date();
  let years = now.getUTCFullYear() - born.getUTCFullYear();
  const monthDelta = now.getUTCMonth() - born.getUTCMonth();
  if (monthDelta < 0 || (monthDelta === 0 && now.getUTCDate() < born.getUTCDate())) years -= 1;

  return years < 0 || years > 130 ? null : years;
}

/** Plain words for the age line under the date field. */
function ageLabel(years: number): string {
  return years === 0 ? 'Under a year old' : `${String(years)} year${years === 1 ? '' : 's'} old`;
}

const RELATIONS: SelectOption[] = [
  ...commonContactRelations.map((r) => ({ value: r, label: r })),
  { value: OTHER_RELATION, label: 'Someone else…' },
];

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
  countryCode,
  canCreate,
}: {
  slug: string;
  branches: BranchChoice[];
  /** The clinic's country, off the session. Drives every format on the form. */
  countryCode: string;
  canCreate: boolean;
}) {
  const [state, action, pending] = useActionState(searchPatients.bind(null, slug), EMPTY_SEARCH);
  const [registering, setRegistering] = useState(false);

  /**
   * The record just created, kept HERE rather than in the form.
   *
   * ⚠️ THE FORM UNMOUNTS ON SUCCESS, TAKING ITS OWN STATE WITH IT. That is why
   *   registering somebody used to look like it had failed: the action returned
   *   "Registered as P000001" and an id, the effect closed the panel, and the
   *   screen fell back to "Nothing loaded yet" — which reads as *nothing
   *   happened*. The outcome has to outlive the component that produced it, so
   *   the parent holds it.
   */
  const [registered, setRegistered] = useState<{ patientId: string; message: string } | null>(null);

  const closeRegister = useCallback((outcome?: { patientId: string; message: string }) => {
    setRegistering(false);
    if (outcome) setRegistered(outcome);
  }, []);

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
          <Button
            onClick={() => {
              // Opening the form clears the last confirmation — it belongs to
              // the person before this one, and leaving it up would have the
              // screen congratulating the desk about the wrong patient.
              setRegistered(null);
              setRegistering((open) => !open);
            }}
            aria-expanded={registering}
          >
            {registering ? 'Cancel' : 'Register a patient'}
          </Button>
        ) : null}
      </div>

      {registering ? (
        <div className="border-drape bg-drape-tint/40 mt-6 rounded-lg border p-5">
          <RegisterForm
            slug={slug}
            branches={branches}
            countryCode={countryCode}
            onDone={closeRegister}
          />
        </div>
      ) : null}

      {/*
       * ⚠️ THE UHID IS THE POINT OF THIS BANNER, not the reassurance. It is the
       *   number that goes on the file cover and gets read back down a phone,
       *   and the desk has no other way to learn it — the patient list is not
       *   rendered until somebody searches (see `Results`), deliberately, so a
       *   newly registered patient does not appear on their own.
       *
       * The name is NOT repeated here. It is already on the screen the desk just
       *   typed it into, and this banner persists after the form is gone.
       */}
      {registered ? (
        <div className="mt-6">
          <Alert tone="info">
            <span className="font-medium">{registered.message}.</span>{' '}
            <Link
              href={`/patients/${registered.patientId}`}
              className="text-drape font-medium underline underline-offset-2"
            >
              Open the record
            </Link>
          </Alert>
        </div>
      ) : null}

      <SearchForm
        action={action}
        pending={pending}
        state={state}
        multiBranch={branches.length > 1}
      />

      <Results state={state} pending={pending} registered={registered !== null} />
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
      {/*
       * ⚠️ THE HINT IS OUTSIDE THE ROW, NOT ON THE FIELD, and that is what makes
       *   the button line up. `Field` renders its hint INSIDE the field wrapper,
       *   below the control — so with a hint the wrapper is a line taller than
       *   the input, and `items-end` dutifully aligned the button to the bottom
       *   of the hint instead of the bottom of the box. Moving the sentence out
       *   makes the wrapper exactly as tall as its input again.
       */}
      <div className="flex flex-wrap items-end gap-3">
        <Input
          name="q"
          label="Find a patient"
          placeholder="Name, phone, P000123 or MRN000123"
          autoComplete="off"
          type="search"
          fieldClassName="min-w-[16rem] flex-1"
          minLength={2}
          aria-describedby="q-note"
        />
        <Button type="submit" disabled={pending}>
          {pending ? 'Searching…' : 'Search'}
        </Button>
      </div>
      <p id="q-note" className="text-muted mt-1.5 text-[0.8125rem] leading-snug">
        At least two characters.
      </p>

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

function Results({
  state,
  pending,
  registered,
}: {
  state: SearchState;
  pending: boolean;
  /** Something was just registered, and the banner above is already saying so. */
  registered: boolean;
}) {
  if (state.status === 'error') {
    return (
      <div className="mt-6">
        <Alert tone="error">{state.message}</Alert>
      </div>
    );
  }

  if (state.status === 'idle') {
    /*
     * ⚠️ SUPPRESSED RIGHT AFTER A REGISTRATION. "Search above, or register
     *   someone new" directly under "Registered as P000001" reads as a denial
     *   that anything happened — which is exactly how the successful
     *   registration of a real patient got reported as a bug. The banner answers
     *   "what just happened"; this panel answers "why is this list empty", and
     *   only one of those questions is being asked at a time.
     */
    if (registered) return null;

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
            <ResultRow patient={patient} />
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
/*
 * ⚠️ NO `slug` PROP, AND NO `/t/<slug>` IN THE HREF. The proxy derives the
 *   tenant from the Host header and rewrites `pmch.lvh.me/patients` to
 *   `/t/pmch/patients` — so a link that already carries the prefix is rewritten
 *   a second time, to `/t/pmch/t/pmch/patients/...`, and 404s. Relative links
 *   also cannot leak across tenants: the host decides which clinic you are in.
 */
function ResultRow({ patient }: { patient: PatientSummary }) {
  return (
    <Link
      href={`/patients/${patient.id}`}
      className="border-rule bg-card hover:bg-drape-tint/30 focus-visible:outline-drape flex flex-wrap items-center justify-between gap-4 rounded-lg border px-5 py-4 transition-colors focus-visible:outline-2 focus-visible:outline-offset-2"
    >
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-ink text-[1.0625rem] font-medium">{patient.fullName}</span>
          {/*
            ⚠️ A WORD, NOT AN ICON, AND IT IS ON THE ROW RATHER THAN ONLY ON THE
              RECORD. A search for "Kaapi Subramanian" returns the dog and the
              owner side by side, and the two rows are otherwise identical in
              shape — this is the one thing that stops the wrong one being
              opened at a counter.
          */}
          {patient.subjectType === 'ANIMAL' ? (
            <span className="bg-drape-tint text-drape rounded-xs px-2 py-0.5 text-[0.6875rem] font-medium">
              Animal
            </span>
          ) : null}
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
  countryCode,
  onDone,
}: {
  slug: string;
  branches: BranchChoice[];
  /** The clinic's country. Decides address labels, ID types and dialling code. */
  countryCode: string;
  /**
   * Called once the panel should close. The outcome is handed UP rather than
   * rendered here, because this component is about to unmount — see the note on
   * `registered` in PatientSearch.
   */
  onDone: (outcome?: { patientId: string; message: string }) => void;
}) {
  const [state, action, pending] = useActionState(registerPatient.bind(null, slug), IDLE);
  const [matches, setMatches] = useState<PatientDuplicateMatch[]>([]);
  const formRef = useRef<HTMLFormElement>(null);
  useOutcomeFocus(state.status, formRef);

  const labels = addressLabels(countryCode);

  /*
   * The date of birth is held in state only so the age can be shown beside it.
   * It is submitted as itself, and the age is never submitted at all — see
   * `ageFromDob`.
   */
  const [dob, setDob] = useState('');
  const age = ageFromDob(dob);

  const [city, setCity] = useState('');
  const [region, setRegion] = useState('');
  const [postcode, setPostcode] = useState('');
  const [lookingUp, setLookingUp] = useState(false);

  const [phoneCountry, setPhoneCountry] = useState(countryCode);
  const [phone, setPhone] = useState('');
  const [contactCountry, setContactCountry] = useState(countryCode);
  const [contactPhone, setContactPhone] = useState('');

  const [relation, setRelation] = useState('');

  /*
   * ⚠️ CHOSEN ONCE, AT REGISTRATION, AND NEVER EDITABLE AFTERWARDS — the API
   *   leaves `subjectType` off the update contract on purpose. So the control is
   *   at the TOP of the form rather than tucked among the optional fields: it
   *   changes what the rest of the form means, and it is the one answer here
   *   that cannot be corrected later without merging the record.
   */
  const [subjectType, setSubjectType] = useState('HUMAN');
  const isAnimal = subjectType === 'ANIMAL';

  /**
   * Fill the city and region from the postcode, on leaving the field.
   *
   * ⚠️ FILLS ONLY WHAT IS STILL EMPTY, AND NEVER BLOCKS. A desk that has already
   *   typed the city knows something the lookup does not — the patient's village
   *   rather than the district's post town — and overwriting it would be the
   *   form arguing with the person holding the address. A null answer (no data
   *   for that country, a timeout, a 404) is ordinary and silent.
   */
  const fillFromPostcode = useCallback(
    async (value: string) => {
      if (value.trim() === '') return;

      setLookingUp(true);
      try {
        const found = await lookupPostalCode(countryCode, value);
        if (!found) return;
        setCity((current) => (current.trim() === '' ? (found.city ?? '') : current));
        setRegion((current) => (current.trim() === '' ? (found.region ?? '') : current));
      } finally {
        setLookingUp(false);
      }
    },
    [countryCode]
  );

  useEffect(() => {
    if (state.status !== 'saved') return;
    onDone(
      state.patientId !== undefined
        ? { patientId: state.patientId, message: state.message ?? 'Patient registered' }
        : undefined
    );
  }, [state.status, state.patientId, state.message, onDone]);

  /**
   * Ask whether this person is already here, on leaving a field that could say.
   *
   * ⚠️ THE ID AND THE ABHA ARE NOT ADVISORY LIKE THE PHONE IS. Two siblings can
   *   share a phone number, so a phone match is a question. `national_id` and
   *   `abha_number` each carry a partial unique index, so a match there means
   *   the registration is going to be REFUSED — probing on blur is what lets the
   *   desk find the existing record now rather than after filling in the rest of
   *   the form and being told a number is taken.
   *
   * Accumulating rather than replacing would be wrong: each probe is a fresh
   * question about the field just left, and stale matches from a phone the desk
   * has since corrected would keep accusing them of a duplicate.
   */
  const probe = useCallback(
    async (field: 'phone' | 'nationalId' | 'abhaNumber', value: string) => {
      const trimmed = value.trim();
      // Below this nothing is specific enough to be worth a logged read.
      if (trimmed.length < 6) {
        setMatches([]);
        return;
      }
      setMatches(await checkForDuplicates(slug, { [field]: trimmed }));
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
              ? `Someone with this ${matchWord(matches)} is already registered.`
              : `${String(matches.length)} people with this ${matchWord(matches)} are already registered.`}
          </span>{' '}
          {/*
           * ⚠️ THE ADVICE DIFFERS BY WHAT MATCHED, because the consequence does.
           *   A phone match is a question — two siblings share a number — and the
           *   desk may legitimately carry on. An ID or ABHA match is not: both
           *   columns are uniquely indexed, so registering will be REFUSED, and
           *   telling somebody to "consider" opening the existing record would
           *   send them to fill in the rest of a form that cannot be submitted.
           */}
          {matches.some((m) => m.matchedOn.includes('NATIONAL_ID') || m.matchedOn.includes('ABHA'))
            ? 'That identifier belongs to one record only, so this registration will be refused. Open the existing record.'
            : 'Open the existing record instead of making a second one — a new record starts with an empty allergy list.'}
          <ul className="mt-2 grid gap-1">
            {matches.map((match) => (
              <li key={match.id}>
                <Link
                  href={`/patients/${match.id}`}
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

      <Select
        name="subjectType"
        label="Registering"
        value={subjectType}
        onChange={(event) => setSubjectType(event.target.value)}
        options={[
          { value: 'HUMAN', label: 'A person' },
          { value: 'ANIMAL', label: 'An animal' },
        ]}
        hint="This cannot be changed afterwards."
        fieldClassName="mt-4"
      />

      <div className="grid gap-4 sm:grid-cols-2">
        <Input
          name="firstName"
          label={isAnimal ? 'Name' : 'First name'}
          required
          autoComplete="off"
          {...(state.fieldErrors?.['firstName'] ? { errors: state.fieldErrors['firstName'] } : {})}
        />
        <Input
          name="lastName"
          label={isAnimal ? 'Household name' : 'Last name'}
          autoComplete="off"
        />

        {/*
          ⚠️ SPECIES AND BREED ONLY, AND DELIBERATELY NO WEIGHT. A weight has to
            carry the day it was taken — the contract refuses one without the
            other — and a registration desk with a queue behind it is not where
            an animal goes on the scales. It is recorded on the chart, where the
            person doing the weighing is standing.
        */}
        {isAnimal ? (
          <>
            <Input
              name="species"
              label="Species"
              autoComplete="off"
              hint="Whatever you call it — dog, cat, tortoise."
              {...(state.fieldErrors?.['animalProfile.species']
                ? { errors: state.fieldErrors['animalProfile.species'] }
                : {})}
            />
            <Input name="breed" label="Breed" autoComplete="off" />
          </>
        ) : null}

        {/*
         * ⚠️ ONE CONTROL, NOT TWO FIELDS, and the calling code IS selectable
         *   here — unlike the clinic's own reception number, which is fixed to
         *   the clinic's country. A patient may be a visitor, and a front desk
         *   that cannot enter a foreign mobile writes it into the notes instead.
         *   Submits E.164 from a hidden input; see PhoneInput.
         */}
        <Field
          name="phone"
          label="Phone"
          hint="Checked against existing records as you leave the field."
          {...(state.fieldErrors?.['phone'] ? { errors: state.fieldErrors['phone'] } : {})}
        >
          {/*
           * `onBlur` on the wrapper, because React's onBlur bubbles (it is
           * focusout underneath) and PhoneInput exposes no blur of its own. The
           * value probed is composed from STATE, not read off the DOM — the
           * visible box holds national digits, and what has to be matched is the
           * E.164 the form will submit and the column now stores.
           */}
          <div onBlur={() => void probe('phone', phone === '' ? '' : toE164(phoneCountry, phone))}>
            <PhoneInput
              id="phone"
              name="phone"
              countryCode={phoneCountry}
              national={phone}
              onCountryChange={setPhoneCountry}
              onNationalChange={setPhone}
              autoComplete="off"
              invalid={Boolean(state.fieldErrors?.['phone'])}
              describedBy={describedBy('phone', true, Boolean(state.fieldErrors?.['phone']))}
            />
          </div>
        </Field>
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
          value={dob}
          onChange={(event) => setDob(event.target.value)}
          // Nobody is born tomorrow. Stops a typo becoming a negative age.
          max={new Date().toISOString().slice(0, 10)}
          {...(age !== null ? { hint: ageLabel(age) } : {})}
          {...(state.fieldErrors?.['dateOfBirth']
            ? { errors: state.fieldErrors['dateOfBirth'] }
            : {})}
        />
        {/*
         * ⚠️ THE APPROXIMATE AGE DISAPPEARS ONCE A DATE OF BIRTH IS ENTERED, and
         *   it is UNMOUNTED rather than disabled — an unmounted input submits
         *   nothing, and the contract refuses a date and an age together
         *   (mirroring the `patients_age_single_source` CHECK). Disabling would
         *   look the same on screen and still leave the pair to be rejected on
         *   whichever browser ignores it.
         *
         *   Both fields exist because offering only the date pushes the desk into
         *   inventing one for the patient who knows they are "about 60" — and an
         *   invented birthday is what a paediatric dose gets calculated from. The
         *   age beside the date field above is computed, never stored.
         */}
        {dob === '' ? (
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
        ) : (
          <div aria-hidden="true" />
        )}

        <Select name="gender" label="Sex" options={GENDERS} defaultValue="UNKNOWN" />
        <Select
          name="bloodGroup"
          label="Blood group"
          options={BLOOD_GROUPS}
          defaultValue="UNKNOWN"
        />

        {/*
         * The country is the clinic's and is not asked for — it is what decides
         * the labels, the postcode lookup and the ID list. Carried on a hidden
         * input because the contract validates the ID against it.
         */}
        <input type="hidden" name="countryCode" value={countryCode} />

        <Input
          name="line1"
          label={labels.addressLine1}
          autoComplete="off"
          fieldClassName="sm:col-span-2"
        />

        {/*
         * ⚠️ THE POSTCODE COMES FIRST, ABOVE THE FIELDS IT FILLS. Reading order
         *   is the instruction: type this and the two below answer themselves.
         *   Under them it would read as an afterthought and be typed last, when
         *   the desk has already filled in what it would have populated.
         */}
        <Input
          name="pincode"
          label={labels.postalCode}
          value={postcode}
          onChange={(event) => setPostcode(event.target.value)}
          onBlur={(event) => void fillFromPostcode(event.target.value)}
          inputMode="numeric"
          autoComplete="off"
          hint={lookingUp ? 'Looking it up…' : `Fills in the ${labels.city.toLowerCase()} below.`}
        />
        <Input
          name="city"
          label={labels.city}
          value={city}
          onChange={(event) => setCity(event.target.value)}
          autoComplete="off"
        />
        {/*
         * Only where the country has a second level to ask for — Singapore and
         * the UAE do not, and an empty "State" box in a city-state is a question
         * with no answer.
         */}
        {labels.region !== null ? (
          <Input
            name="state"
            label={labels.region}
            value={region}
            onChange={(event) => setRegion(event.target.value)}
            autoComplete="off"
          />
        ) : null}

        <Input
          name="abhaNumber"
          label="ABHA number"
          autoComplete="off"
          className="font-mono"
          hint="14 digits, or an address like someone@abdm. One per person."
          onBlur={(event) => void probe('abhaNumber', event.currentTarget.value)}
          {...(state.fieldErrors?.['abhaNumber']
            ? { errors: state.fieldErrors['abhaNumber'] }
            : {})}
        />
        <NationalIdInput
          countryCode={countryCode}
          typeName="nationalIdType"
          valueName="nationalId"
          onSettled={(value) => void probe('nationalId', value)}
          {...(state.fieldErrors?.['nationalId']
            ? { errors: state.fieldErrors['nationalId'] }
            : {})}
        />
      </div>

      <fieldset className="border-rule border-t pt-4">
        <legend className="eyebrow text-drape">Who to ring</legend>
        <div className="mt-3 grid gap-4 sm:grid-cols-3">
          <Input name="contactName" label="Name" autoComplete="off" />

          {/*
           * A shortcut, not a constraint — see OTHER_RELATION. The select
           * submits under `contactRelation`; choosing "Someone else…" swaps in a
           * text input under the same name, so the action reads one field either
           * way.
           */}
          {relation === OTHER_RELATION ? (
            <Input
              name="contactRelation"
              label="Relation"
              autoComplete="off"
              autoFocus
              hint="Type it as the patient would say it."
              action={
                <button
                  type="button"
                  className="text-muted hover:text-drape text-[0.75rem] underline underline-offset-2"
                  onClick={() => setRelation('')}
                >
                  Pick from the list
                </button>
              }
            />
          ) : (
            <Select
              name="contactRelation"
              label="Relation"
              value={relation}
              onChange={(event) => setRelation(event.target.value)}
              placeholder="Not said"
              options={RELATIONS}
            />
          )}

          <Field name="contactPhone" label="Phone">
            <PhoneInput
              id="contactPhone"
              name="contactPhone"
              countryCode={contactCountry}
              national={contactPhone}
              onCountryChange={setContactCountry}
              onNationalChange={setContactPhone}
              autoComplete="off"
            />
          </Field>
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
