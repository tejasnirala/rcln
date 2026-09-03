'use client';

import { useId, useState, useTransition } from 'react';
import type { ClinicalMasterItem } from '@rcln/contracts';
import { FieldError, Input } from '@/components/ui/field';
import { Button } from '@/components/ui/button';
import { Alert } from '@/components/ui/alert';
import {
  searchProcedures,
  type ProcedureSearchState,
} from '@/app/(tenant)/t/[slug]/(app)/lookup-actions';

/**
 * Name a procedure by searching the clinical dictionary.
 *
 * ⚠️ THE LAST CAPPED PICKER IN THE APPLICATION (KNOWN_ISSUES #34). PI-23 removed
 *   every capped `<select>` over the PRODUCT catalogue and stopped at this one,
 *   because it reads the clinical dictionary instead — a different endpoint and
 *   a different permission, so not identifier-resolution work. The effect on the
 *   person using it was identical though: `/usage/templates` fetched the first
 *   hundred procedures at render and filtered them in the browser, so a clinic
 *   with a longer list could not reach the rest and had no way to know why.
 *
 * ⚠️ NO PHI. A procedure is a dictionary entry and names nobody, which is why
 *   `GET /clinical-data` is deliberately not read-audited — see that route's
 *   header. This picker therefore needs none of `PatientPicker`'s care about
 *   scope, and says so rather than leaving the difference to be inferred.
 *
 * The shape deliberately mirrors `ProductPicker` and `PatientPicker`: same
 * search-then-choose behaviour, same hidden input, same reason. Three pickers
 * that behave differently would be three things to learn.
 */

/** Enough of a procedure to show which one is chosen. */
interface ChosenProcedure {
  id: string;
  name: string;
  code?: string | undefined;
}

interface Props {
  slug: string;
  /** The form field the chosen id posts under. */
  name: string;
  label: string;
  hint?: string;
  required?: boolean;
  errors?: string[];
  initial?: ChosenProcedure | null;
  onChoose?: (procedure: ClinicalMasterItem | null) => void;
  className?: string;
}

const IDLE: ProcedureSearchState = { status: 'idle' };

/** The first coding, which is what a clinician recognises it by. */
function codeOf(procedure: ClinicalMasterItem): string | undefined {
  return procedure.codings[0]?.code;
}

export function ProcedurePicker({
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
  const [chosen, setChosen] = useState<ChosenProcedure | null>(initial);
  const [term, setTerm] = useState('');
  const [state, setState] = useState<ProcedureSearchState>(IDLE);
  const [pending, startTransition] = useTransition();

  const choose = (procedure: ClinicalMasterItem | null): void => {
    setChosen(
      procedure === null
        ? null
        : { id: procedure.id, name: procedure.name, code: codeOf(procedure) }
    );
    setState(IDLE);
    setTerm('');
    onChoose?.(procedure);
  };

  const find = (): void => {
    const asked = term.trim();
    if (asked.length < 2) {
      setState({
        status: 'error',
        message: 'Type at least two characters — part of the name, or its code.',
      });
      return;
    }
    startTransition(async () => {
      setState(await searchProcedures(slug, asked));
    });
  };

  if (chosen !== null) {
    return (
      <div className={className}>
        <p className="text-ink text-sm font-medium">{label}</p>
        <div className="border-rule bg-paper mt-2 flex flex-wrap items-center justify-between gap-3 rounded-md border px-3.5 py-2.5">
          <span className="text-ink text-[0.9375rem]">
            {chosen.name}
            {chosen.code === undefined ? null : (
              <span className="text-muted ml-2 font-mono text-[0.75rem]">{chosen.code}</span>
            )}
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
            /* Enter means "find", never "submit the form I am sitting in". */
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
        {hint ?? 'Part of the name, or its code.'}
      </p>

      {/* An empty hidden input while nothing is chosen, so the field is present
          in the FormData and its Zod error lands under the right name. */}
      <input type="hidden" name={name} value="" />

      {errors?.[0] ? <FieldError name={name} message={errors[0]} /> : null}

      {state.status === 'error' ? (
        <Alert tone="error" className="mt-2">
          {state.message}
        </Alert>
      ) : null}

      {state.status === 'done' && state.procedures.length > 0 ? (
        <ul className="border-rule divide-rule mt-2 divide-y rounded-md border">
          {state.procedures.map((procedure) => (
            <li key={procedure.id}>
              <button
                type="button"
                onClick={() => choose(procedure)}
                className="hover:bg-drape-tint/40 flex w-full cursor-pointer flex-wrap items-center justify-between gap-2 px-3.5 py-2.5 text-left"
              >
                <span className="text-ink text-[0.875rem]">{procedure.name}</span>
                {codeOf(procedure) === undefined ? null : (
                  <span className="text-muted font-mono text-[0.75rem]">{codeOf(procedure)}</span>
                )}
              </button>
            </li>
          ))}
        </ul>
      ) : null}

      {state.status === 'done' && state.procedures.length === 0 ? (
        <p className="text-muted mt-2 text-[0.8125rem]">
          No procedure matched. Add it to the clinical dictionary first.
        </p>
      ) : null}
    </div>
  );
}
