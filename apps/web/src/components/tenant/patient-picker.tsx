'use client';

import { useId, useState, useTransition } from 'react';
import type { PatientSummary } from '@rcln/contracts';
import { FieldError, Input } from '@/components/ui/field';
import { Button } from '@/components/ui/button';
import { Alert } from '@/components/ui/alert';
import {
  searchPatients,
  type PatientSearchState,
} from '@/app/(tenant)/t/[slug]/(app)/lookup-actions';

/**
 * Name the patient a record is about, by searching for them.
 *
 * ⚠️ THIS EXISTS BECAUSE ONE FORM ASKED A RECEPTIONIST TO TYPE A UUID
 *   (KNOWN_ISSUES #25). The online-order screen's "Patient" box was a free-text
 *   `Input` whose hint said "the patient's id" — it named the database's concern
 *   rather than the user's, it could only be filled by copying an id off another
 *   screen, and a mis-pasted character sent a parcel to a different person.
 *
 * ⚠️ IT SEARCHES THIS BRANCH, AND THAT IS NOT A PERFORMANCE CHOICE. Widening a
 *   patient search to the whole organization is a deliberate act that ADR-0016
 *   records as a disclosure; a picker on a dispensing form does not get to do it
 *   quietly. Somebody who genuinely needs the other site's patient goes to the
 *   patients screen, where the widening is a visible decision.
 *
 * ⚠️ PHI ON SCREEN, AND NOWHERE ELSE. Names and UHIDs are rendered and dropped —
 *   never put in a URL, `localStorage`, a cookie or a log line. The API writes
 *   the `data_access_logs` row for the search itself.
 *
 * The shape deliberately mirrors `ProductPicker`: same search-then-choose
 * behaviour, same hidden input, same reason. Two pickers that behave differently
 * are two things to learn.
 */

/** Enough of a patient to show which one is chosen. */
interface ChosenPatient {
  id: string;
  fullName: string;
  uhid: string;
}

interface Props {
  slug: string;
  /** The form field the chosen id posts under. */
  name: string;
  label: string;
  hint?: string;
  required?: boolean;
  errors?: string[];
  initial?: ChosenPatient | null;
  onChoose?: (patient: PatientSummary | null) => void;
  className?: string;
}

const IDLE: PatientSearchState = { status: 'idle' };

/** Age, sex and phone in one line — what tells two people with one name apart. */
function identityLine(patient: PatientSummary): string {
  return [
    patient.age === null
      ? null
      : `${patient.ageIsApproximate ? 'approx ' : ''}${String(patient.age)}`,
    patient.gender,
    patient.phone,
  ]
    .filter((part) => part !== null && part !== '')
    .join(' · ');
}

export function PatientPicker({
  slug,
  name,
  label,
  hint,
  required = false,
  errors,
  initial = null,
  onChoose,
  className,
}: Props) {
  const fieldId = useId();
  const [chosen, setChosen] = useState<ChosenPatient | null>(initial);
  const [term, setTerm] = useState('');
  const [state, setState] = useState<PatientSearchState>(IDLE);
  const [pending, startTransition] = useTransition();

  const choose = (patient: PatientSummary | null): void => {
    setChosen(patient);
    setState(IDLE);
    setTerm('');
    onChoose?.(patient);
  };

  const find = (): void => {
    const asked = term.trim();
    if (asked.length < 2) {
      setState({
        status: 'error',
        message: 'Type at least two characters — part of a name, a phone number or the UHID.',
      });
      return;
    }
    startTransition(async () => {
      setState(await searchPatients(slug, asked));
    });
  };

  if (chosen !== null) {
    return (
      <div className={className}>
        <p className="text-ink text-sm font-medium">{label}</p>
        <div className="border-rule bg-paper mt-2 flex flex-wrap items-center justify-between gap-3 rounded-md border px-3.5 py-2.5">
          <span className="text-ink text-[0.9375rem]">
            {chosen.fullName}
            <span className="text-muted ml-2 font-mono text-[0.75rem]">{chosen.uhid}</span>
          </span>
          <Button type="button" size="sm" variant="secondary" onClick={() => choose(null)}>
            Change
          </Button>
        </div>
        <input type="hidden" name={name} value={chosen.id} />
        {errors?.[0] ? <FieldError name={name} message={errors[0]} /> : null}
      </div>
    );
  }

  return (
    <div className={className}>
      {/* The hint sits outside the row so the button lines up with the box. */}
      <div className="flex flex-wrap items-end gap-3">
        <Input
          id={fieldId}
          type="search"
          label={
            required ? (
              <>
                {label} <span className="text-muted font-normal">(required)</span>
              </>
            ) : (
              label
            )
          }
          autoComplete="off"
          value={term}
          onChange={(event) => setTerm(event.target.value)}
          onKeyDown={(event) => {
            // Enter means "find", never "submit the form I am sitting in".
            if (event.key === 'Enter') {
              event.preventDefault();
              find();
            }
          }}
          fieldClassName="min-w-[14rem] flex-1"
          aria-describedby={`${fieldId}-note`}
        />
        <Button type="button" variant="secondary" onClick={find} disabled={pending}>
          {pending ? 'Searching…' : 'Find'}
        </Button>
      </div>
      <p id={`${fieldId}-note`} className="text-muted mt-1.5 text-[0.8125rem] leading-snug">
        {hint ?? 'Name, phone or UHID. Searched at this branch.'}
      </p>

      <input type="hidden" name={name} value="" />

      {errors?.[0] ? <FieldError name={name} message={errors[0]} /> : null}

      {state.status === 'error' ? (
        <Alert tone="error" className="mt-2">
          {state.message}
        </Alert>
      ) : null}

      {state.status === 'done' && state.patients.length > 0 ? (
        <ul className="border-rule divide-rule mt-2 divide-y rounded-md border">
          {state.patients.map((patient) => (
            <li key={patient.id}>
              <button
                type="button"
                onClick={() => choose(patient)}
                className="hover:bg-drape-tint/40 flex w-full cursor-pointer flex-wrap items-center justify-between gap-2 px-3.5 py-2.5 text-left"
              >
                <span className="text-ink text-[0.875rem]">
                  {patient.fullName}
                  <span className="text-muted ml-2 text-[0.75rem]">{identityLine(patient)}</span>
                </span>
                <span className="text-muted font-mono text-[0.75rem]">{patient.uhid}</span>
              </button>
            </li>
          ))}
        </ul>
      ) : null}

      {state.status === 'done' && state.patients.length === 0 ? (
        <p className="text-muted mt-2 text-[0.8125rem]">
          Nobody matched at this branch. Register them on the patients screen first.
        </p>
      ) : null}
    </div>
  );
}
