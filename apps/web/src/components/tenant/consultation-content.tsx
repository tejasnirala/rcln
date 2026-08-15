'use client';

import { useCallback, useEffect, useId, useRef, useState } from 'react';
import type {
  EncounterAdvice,
  EncounterAttachment,
  EncounterContent,
  EncounterDiagnosis,
  EncounterInvestigation,
  EncounterPrescription,
  EncounterProcedure,
  EncounterReferral,
  EncounterSymptom,
  FollowUpIntervalUnitValue,
  FollowUpRecommendation,
  FollowUpTypeValue,
  SetFollowUpRecommendationRequest,
} from '@rcln/contracts';
import { Button } from '@/components/ui/button';
import { Field, Input, Select, Textarea, inputClass } from '@/components/ui/field';
import { cn } from '@/lib/cn';
import {
  searchClinicalTerms,
  searchPrescribableProducts,
  searchReferralDoctors,
  searchReferralSpecialties,
  type ContentCollection,
  type ContentResult,
} from '@/app/(tenant)/t/[slug]/(app)/appointments/consultation-actions';

/**
 * The first-class clinical sections (CE-4): what the clinician concluded,
 * prescribed, ordered, advised and asked for.
 *
 * ⚠️ NO SPECIALTY ANYWHERE IN THIS FILE (§33). No dentistry branch, no
 *   hair-and-scalp branch, no `if` on a classification. The server resolved
 *   which sections appear and over which vocabulary; these components draw
 *   exactly that. The day one starts branching on a specialty, adding the next
 *   specialty costs a screen — which is the outcome this programme exists to
 *   avoid.
 *
 * ⚠️ AND NO SELECTOR EVER LOADS ITS MASTER (§39). Every picker searches the
 *   server, debounced. A clinical vocabulary is platform-wide and a formulary
 *   runs to tens of thousands of rows: shipping either to the browser is slow
 *   at nine in the morning and stale by ten, because a word the clinic added at
 *   half past is not in the copy this tab holds.
 *
 * ── THE SHAPE EVERY SECTION SHARES ───────────────────────────────────────────
 *
 * A list of what has been recorded, and one row at the bottom to add to it.
 * Adding writes immediately — these are ROWS with server-issued ids, not
 * document fields, so there is nothing sensible to debounce. Editing a recorded
 * row commits on blur, which is the same trade: the caret stays where it is
 * while typing and the write happens when the clinician moves on.
 *
 * Quiet and conventional, per apps/web/AGENTS.md. This is a dense form filled
 * in with a patient in the room; every control is a native one from
 * `components/ui/field.tsx` and no colour is written by hand.
 */

/** What every section needs to talk to the server. */
export interface ContentSectionProps {
  slug: string;
  encounterId: string;
  content: EncounterContent;
  readOnly: boolean;
  /** The section's vocabulary scope. RANKS the selector's results (§34). */
  scopeId?: string | undefined;
  add: (collection: ContentCollection, body: Record<string, unknown>) => Promise<ContentResult>;
  edit: (
    collection: ContentCollection,
    rowId: string,
    body: Record<string, unknown>
  ) => Promise<ContentResult>;
  remove: (collection: ContentCollection, rowId: string) => Promise<ContentResult>;
}

// ---------------------------------------------------------------------------
// Shared furniture
// ---------------------------------------------------------------------------

/** One recorded row: what it says, the controls that qualify it, and a remove. */
function Row({
  title,
  subtitle,
  onRemove,
  readOnly,
  children,
}: {
  title: string;
  subtitle?: string | undefined;
  onRemove: () => void;
  readOnly: boolean;
  children?: React.ReactNode;
}) {
  return (
    <li className="border-rule border-t py-3 first:border-t-0 first:pt-0">
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <div>
          <p className="text-[0.9375rem]">{title}</p>
          {subtitle === undefined ? null : (
            <p className="text-muted mt-0.5 text-[0.8125rem]">{subtitle}</p>
          )}
        </div>
        {readOnly ? null : (
          <Button variant="ghost" onClick={onRemove}>
            Remove
          </Button>
        )}
      </div>
      {children === undefined ? null : <div className="mt-3">{children}</div>}
    </li>
  );
}

/**
 * "Nothing recorded" — said, not left blank.
 *
 * ⚠️ AN EMPTY SECTION AND A BROKEN ONE LOOK THE SAME IF NEITHER SAYS ANYTHING.
 *   A clinician reading a colleague's finalized consultation needs to know that
 *   no diagnosis was recorded, which is a clinical fact, rather than wonder
 *   whether the screen failed to load one.
 */
function Empty({ what }: { what: string }) {
  return <p className="text-muted text-[0.9375rem]">Nothing {what} recorded.</p>;
}

/**
 * A selector whose options come from the server, one query at a time.
 *
 * ⚠️ IT RETURNS AN ID WHEN THE CLINICIAN PICKED A LISTED TERM AND THE TEXT WHEN
 *   THEY DID NOT, and both are legitimate. §6 wants a symptom the vocabulary
 *   has not learned yet to be recordable; the CHECK constraint behind this
 *   accepts exactly one of the two, which is why this component answers with
 *   exactly one.
 *
 * ⚠️ DEBOUNCED, WITH THE TIMER CLEARED ON EVERY CHANGE AND LATE ANSWERS
 *   DISCARDED. Without both, a fast typist queues one request per keystroke and
 *   the list ends up showing the results for a prefix of what is in the box —
 *   the bug `ServerSelect` in `field-renderer.tsx` records.
 */
function TermPicker({
  label,
  hint,
  placeholder,
  disabled,
  search,
  onPick,
}: {
  label: string;
  hint?: string | undefined;
  placeholder?: string | undefined;
  disabled: boolean;
  search: (term: string) => Promise<{ id: string; name: string }[]>;
  /** `id` when a listed term was chosen, otherwise the words that were typed. */
  onPick: (picked: { id: string } | { text: string }) => void;
}) {
  const listId = useId();
  const name = useId();
  const [term, setTerm] = useState('');
  const [options, setOptions] = useState<{ id: string; name: string }[]>([]);
  const latest = useRef(0);

  const searching = term.trim().length >= 2;

  useEffect(() => {
    if (!searching) return;
    const query = ++latest.current;
    const timer = setTimeout(() => {
      void search(term).then((results) => {
        if (query === latest.current) setOptions(results);
      });
    }, 250);
    return () => clearTimeout(timer);
  }, [term, searching, search]);

  const commit = () => {
    const typed = term.trim();
    if (typed === '') return;
    /*
     * ⚠️ MATCHED BY NAME, CASE-INSENSITIVELY, BECAUSE A `<datalist>` GIVES BACK
     *   THE OPTION'S TEXT AND NOT ITS VALUE. Anything the list did not offer is
     *   the clinician's own words, which is the whole point of the free-text
     *   half — see the model note on `custom_text`.
     */
    const matched = options.find((option) => option.name.toLowerCase() === typed.toLowerCase());
    onPick(matched === undefined ? { text: typed } : { id: matched.id });
    setTerm('');
    setOptions([]);
  };

  return (
    <div className="flex flex-wrap items-end gap-3">
      <Field
        name={name}
        label={label}
        {...(hint !== undefined ? { hint } : {})}
        className="min-w-[16rem] flex-1"
      >
        <input
          id={name}
          name={name}
          list={listId}
          value={term}
          disabled={disabled}
          autoComplete="off"
          placeholder={placeholder ?? 'Start typing to search'}
          onChange={(event) => setTerm(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault();
              commit();
            }
          }}
          className={inputClass}
        />
        {/*
          A native <datalist>: the suggestions are the operating system's, so
          keyboard navigation, type-ahead and the mobile picker come for free.
          Typing something the list does not contain is deliberately allowed.
        */}
        <datalist id={listId}>
          {(searching ? options : []).map((option) => (
            <option key={option.id} value={option.name} />
          ))}
        </datalist>
      </Field>
      <Button variant="secondary" onClick={commit} disabled={disabled || term.trim() === ''}>
        Add
      </Button>
    </div>
  );
}

/**
 * A control that writes when the clinician moves on, not while they type.
 *
 * ⚠️ ON BLUR AND NOT ON CHANGE. Each of these is a real row on the server, so a
 *   per-keystroke write would be one request per character with no debounce to
 *   hide behind — and a debounce here would fight the same caret the autosave
 *   is written to protect. Blur is the moment the clinician has finished with
 *   the field, which is exactly when the value is worth keeping.
 */
function useCommitOnBlur<T>(initial: T, commit: (value: T) => void) {
  const [value, setValue] = useState<T>(initial);
  /*
   * ⚠️ THE PREVIOUS SERVER VALUE IS HELD IN STATE, NOT IN A REF, AND THIS IS THE
   *   ONE PATTERN REACT DOCUMENTS FOR "adjust state when a prop changes". A ref
   *   written during render is the rule `consultation-engine.tsx` already
   *   records breaking once, and eslint refuses it — the tracked value here is
   *   needed FOR rendering, which is exactly what makes it state.
   *
   *   It re-syncs when the server's copy moves under us: a save that came back
   *   with a corrected value, or the whole content being swapped after a row in
   *   another list changed.
   */
  const [seen, setSeen] = useState<T>(initial);
  if (seen !== initial) {
    setSeen(initial);
    setValue(initial);
  }
  const onBlur = useCallback(() => {
    if (value !== initial) commit(value);
  }, [value, initial, commit]);
  return { value, setValue, onBlur };
}

/** A short text box on a recorded row. */
function RowText({
  label,
  value,
  disabled,
  rows,
  onCommit,
}: {
  label: string;
  value: string | null;
  disabled: boolean;
  rows?: number;
  onCommit: (value: string | null) => void;
}) {
  const field = useCommitOnBlur(value ?? '', (next) => onCommit(next === '' ? null : next));
  const name = useId();
  return rows === undefined ? (
    <Input
      name={name}
      label={label}
      disabled={disabled}
      value={field.value}
      onChange={(event) => field.setValue(event.target.value)}
      onBlur={field.onBlur}
    />
  ) : (
    <Textarea
      name={name}
      label={label}
      rows={rows}
      disabled={disabled}
      value={field.value}
      onChange={(event) => field.setValue(event.target.value)}
      onBlur={field.onBlur}
    />
  );
}

/** A dropdown on a recorded row. Commits immediately — a pick IS the decision. */
function RowSelect({
  label,
  value,
  options,
  disabled,
  placeholder,
  onCommit,
}: {
  label: string;
  value: string | null;
  options: { value: string; label: string }[];
  disabled: boolean;
  placeholder?: string;
  onCommit: (value: string) => void;
}) {
  const name = useId();
  return (
    <Select
      name={name}
      label={label}
      disabled={disabled}
      value={value ?? ''}
      {...(placeholder !== undefined ? { placeholder } : {})}
      options={options}
      onChange={(event) => onCommit(event.target.value)}
    />
  );
}

/** A number box on a recorded row. */
function RowNumber({
  label,
  value,
  disabled,
  min,
  onCommit,
}: {
  label: string;
  value: number | null;
  disabled: boolean;
  min?: number;
  onCommit: (value: number | null) => void;
}) {
  const field = useCommitOnBlur(value === null ? '' : String(value), (next) =>
    onCommit(next === '' ? null : Number(next))
  );
  const name = useId();
  return (
    <Input
      name={name}
      label={label}
      type="number"
      min={min ?? 1}
      disabled={disabled}
      value={field.value}
      onChange={(event) => field.setValue(event.target.value)}
      onBlur={field.onBlur}
    />
  );
}

/** The label a coded-or-typed row renders under. */
function termLabel(row: { item: { name: string } | null; customText: string | null }): string {
  return row.item?.name ?? row.customText ?? '—';
}

const DURATION_UNITS = [
  { value: 'HOURS', label: 'hours' },
  { value: 'DAYS', label: 'days' },
  { value: 'WEEKS', label: 'weeks' },
  { value: 'MONTHS', label: 'months' },
  { value: 'YEARS', label: 'years' },
];

const SEVERITIES = [
  { value: 'MILD', label: 'Mild' },
  { value: 'MODERATE', label: 'Moderate' },
  { value: 'SEVERE', label: 'Severe' },
];

const GRID = 'grid gap-3 sm:grid-cols-3';

// ---------------------------------------------------------------------------
// Symptoms
// ---------------------------------------------------------------------------

export function SymptomsSection(props: ContentSectionProps) {
  const { slug, content, readOnly, scopeId, add, edit, remove } = props;
  const rows: EncounterSymptom[] = content.symptoms;

  const search = useCallback(
    (term: string) => searchClinicalTerms(slug, 'SYMPTOM', term, scopeId),
    [slug, scopeId]
  );

  return (
    <div>
      {rows.length === 0 ? (
        <Empty what="symptoms" />
      ) : (
        <ul>
          {rows.map((row) => (
            <Row
              key={row.id}
              title={termLabel(row)}
              subtitle={row.item === null ? 'Recorded in your own words' : undefined}
              readOnly={readOnly}
              onRemove={() => void remove('symptoms', row.id)}
            >
              <div className={GRID}>
                <RowNumber
                  label="Going on for"
                  value={row.durationValue}
                  disabled={readOnly}
                  onCommit={(value) =>
                    void edit('symptoms', row.id, {
                      durationValue: value,
                      /* The CHECK wants both or neither — clearing one clears both. */
                      ...(value === null ? { durationUnit: null } : {}),
                    })
                  }
                />
                <RowSelect
                  label="Unit"
                  value={row.durationUnit}
                  placeholder="—"
                  options={DURATION_UNITS}
                  disabled={readOnly}
                  onCommit={(value) =>
                    void edit('symptoms', row.id, { durationUnit: value === '' ? null : value })
                  }
                />
                <RowSelect
                  label="Severity"
                  value={row.severity}
                  placeholder="Not recorded"
                  options={SEVERITIES}
                  disabled={readOnly}
                  onCommit={(value) =>
                    void edit('symptoms', row.id, { severity: value === '' ? null : value })
                  }
                />
                <RowText
                  label="How often"
                  value={row.frequency}
                  disabled={readOnly}
                  onCommit={(value) => void edit('symptoms', row.id, { frequency: value })}
                />
                <RowText
                  label="Where"
                  value={row.site}
                  disabled={readOnly}
                  onCommit={(value) => void edit('symptoms', row.id, { site: value })}
                />
                <RowText
                  label="Notes"
                  value={row.notes}
                  disabled={readOnly}
                  onCommit={(value) => void edit('symptoms', row.id, { notes: value })}
                />
              </div>
            </Row>
          ))}
        </ul>
      )}

      {readOnly ? null : (
        <div className="mt-4">
          <TermPicker
            label="Add a symptom"
            hint="Pick one from the list, or type your own words for something it does not have."
            disabled={readOnly}
            search={search}
            onPick={(picked) =>
              void add(
                'symptoms',
                'id' in picked ? { itemId: picked.id } : { customText: picked.text }
              )
            }
          />
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Diagnoses
// ---------------------------------------------------------------------------

const DIAGNOSIS_ROLES = [
  { value: 'PRIMARY', label: 'Primary' },
  { value: 'SECONDARY', label: 'Secondary' },
  { value: 'DIFFERENTIAL', label: 'Differential' },
];

const CERTAINTIES = [
  { value: 'CONFIRMED', label: 'Confirmed' },
  { value: 'PROVISIONAL', label: 'Provisional' },
  { value: 'SUSPECTED', label: 'Suspected' },
  { value: 'RULED_OUT', label: 'Ruled out' },
];

export function DiagnosisSection(props: ContentSectionProps) {
  const { slug, content, readOnly, scopeId, add, edit, remove } = props;
  const rows: EncounterDiagnosis[] = content.diagnoses;

  const search = useCallback(
    (term: string) => searchClinicalTerms(slug, 'DIAGNOSIS', term, scopeId),
    [slug, scopeId]
  );

  return (
    <div>
      {rows.length === 0 ? (
        <Empty what="diagnoses" />
      ) : (
        <ul>
          {rows.map((row) => (
            <Row
              key={row.id}
              title={termLabel(row)}
              subtitle={row.item === null ? 'Recorded in your own words' : undefined}
              readOnly={readOnly}
              onRemove={() => void remove('diagnoses', row.id)}
            >
              <div className={GRID}>
                {/*
                  ⚠️ AT MOST ONE PRIMARY PER CONSULTATION, and the server refuses
                  a second with a sentence rather than a constraint name. The
                  control does not hide the option: telling a clinician why is
                  more useful than making the choice quietly unavailable.
                */}
                <RowSelect
                  label="Role"
                  value={row.role}
                  options={DIAGNOSIS_ROLES}
                  disabled={readOnly}
                  onCommit={(value) => void edit('diagnoses', row.id, { role: value })}
                />
                <RowSelect
                  label="Certainty"
                  value={row.certainty}
                  options={CERTAINTIES}
                  disabled={readOnly}
                  onCommit={(value) => void edit('diagnoses', row.id, { certainty: value })}
                />
                <RowText
                  label="Notes"
                  value={row.notes}
                  disabled={readOnly}
                  onCommit={(value) => void edit('diagnoses', row.id, { notes: value })}
                />
              </div>
            </Row>
          ))}
        </ul>
      )}

      {readOnly ? null : (
        <div className="mt-4">
          <TermPicker
            label="Add a diagnosis"
            hint="Pick one from the list, or type your own words. The first one you add is recorded as secondary — set the primary explicitly."
            disabled={readOnly}
            search={search}
            onPick={(picked) =>
              void add(
                'diagnoses',
                'id' in picked ? { itemId: picked.id } : { customText: picked.text }
              )
            }
          />
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Procedures
// ---------------------------------------------------------------------------

const PROCEDURE_STATUSES = [
  { value: 'PLANNED', label: 'Planned' },
  { value: 'PERFORMED', label: 'Performed' },
  { value: 'CANCELLED', label: 'Called off' },
];

export function ProcedureSection(props: ContentSectionProps) {
  const { slug, content, readOnly, scopeId, add, edit, remove } = props;
  const rows: EncounterProcedure[] = content.procedures;

  const search = useCallback(
    (term: string) => searchClinicalTerms(slug, 'PROCEDURE', term, scopeId),
    [slug, scopeId]
  );

  /* What it treats — the diagnoses recorded on THIS consultation, and no others. */
  const diagnosisOptions = [
    { value: '', label: 'Not linked to a diagnosis' },
    ...content.diagnoses.map((diagnosis) => ({
      value: diagnosis.id,
      label: termLabel(diagnosis),
    })),
  ];

  return (
    <div>
      {rows.length === 0 ? (
        <Empty what="procedures" />
      ) : (
        <ul>
          {rows.map((row) => (
            <Row
              key={row.id}
              title={row.item?.name ?? '—'}
              readOnly={readOnly}
              onRemove={() => void remove('procedures', row.id)}
            >
              <div className={GRID}>
                <RowSelect
                  label="Status"
                  value={row.status}
                  options={PROCEDURE_STATUSES}
                  disabled={readOnly}
                  onCommit={(value) => void edit('procedures', row.id, { status: value })}
                />
                <RowDate
                  label="Done on"
                  value={row.performedOn}
                  disabled={readOnly}
                  onCommit={(value) => void edit('procedures', row.id, { performedOn: value })}
                />
                <RowSelect
                  label="For"
                  value={row.diagnosisId}
                  options={diagnosisOptions}
                  disabled={readOnly}
                  onCommit={(value) =>
                    void edit('procedures', row.id, { diagnosisId: value === '' ? null : value })
                  }
                />
                <RowText
                  label="Notes"
                  value={row.notes}
                  disabled={readOnly}
                  onCommit={(value) => void edit('procedures', row.id, { notes: value })}
                />
              </div>
            </Row>
          ))}
        </ul>
      )}

      {readOnly ? null : (
        <div className="mt-4">
          <TermPicker
            label="Add a procedure"
            /*
             * ⚠️ THE HINT SAYS WHY THERE IS NO FREE-TEXT OPTION HERE. A
             *   procedure is billed, consumed from stock and reported on, so a
             *   typed one is a line nothing downstream can price or count.
             */
            hint="Procedures come from the clinic's own list, because they are billed and consumed from stock. Add a missing one under Clinical terms."
            disabled={readOnly}
            search={search}
            onPick={(picked) => {
              if (!('id' in picked)) return;
              void add('procedures', { itemId: picked.id });
            }}
          />
        </div>
      )}
    </div>
  );
}

/** A calendar date on a recorded row. ⚠️ `YYYY-MM-DD`, never a locale format. */
function RowDate({
  label,
  value,
  disabled,
  onCommit,
}: {
  label: string;
  value: string | null;
  disabled: boolean;
  onCommit: (value: string | null) => void;
}) {
  const field = useCommitOnBlur(value ?? '', (next) => onCommit(next === '' ? null : next));
  const name = useId();
  return (
    <Input
      name={name}
      label={label}
      type="date"
      disabled={disabled}
      value={field.value}
      onChange={(event) => field.setValue(event.target.value)}
      onBlur={field.onBlur}
    />
  );
}

// ---------------------------------------------------------------------------
// Prescriptions
// ---------------------------------------------------------------------------

const ROUTES = [
  { value: 'ORAL', label: 'By mouth' },
  { value: 'TOPICAL', label: 'On the skin' },
  { value: 'INTRAVENOUS', label: 'Intravenous' },
  { value: 'INTRAMUSCULAR', label: 'Intramuscular' },
  { value: 'SUBCUTANEOUS', label: 'Subcutaneous' },
  { value: 'INHALATION', label: 'Inhaled' },
  { value: 'OPHTHALMIC', label: 'In the eye' },
  { value: 'OTIC', label: 'In the ear' },
  { value: 'NASAL', label: 'In the nose' },
  { value: 'RECTAL', label: 'Rectal' },
  { value: 'VAGINAL', label: 'Vaginal' },
  { value: 'SUBLINGUAL', label: 'Under the tongue' },
  { value: 'TRANSDERMAL', label: 'Patch' },
  { value: 'OTHER', label: 'Other — say how below' },
];

const FREQUENCY_UNITS = [
  { value: 'DAY', label: 'per day' },
  { value: 'WEEK', label: 'per week' },
  { value: 'MONTH', label: 'per month' },
];

const FOOD_RELATIONS = [
  { value: 'BEFORE_FOOD', label: 'Before food' },
  { value: 'AFTER_FOOD', label: 'After food' },
  { value: 'WITH_FOOD', label: 'With food' },
  { value: 'ANY', label: 'Any time' },
];

export function PrescriptionSection(props: ContentSectionProps) {
  const { slug, content, readOnly, add, edit, remove } = props;
  const rows: EncounterPrescription[] = content.prescriptions;

  /*
   * ⚠️ THE PRODUCT CATALOGUE, NOT THE CLINICAL VOCABULARY (§11). A medicine is a
   *   stocked, batched, taxed thing — which is why the PRESCRIPTION section's
   *   registry entry carries no vocabulary at all.
   */
  const search = useCallback((term: string) => searchPrescribableProducts(slug, term), [slug]);

  return (
    <div>
      {rows.length === 0 ? (
        <Empty what="medicines" />
      ) : (
        <ul>
          {rows.map((row) => (
            <Row
              key={row.id}
              title={row.product?.name ?? '—'}
              subtitle={row.strength ?? undefined}
              readOnly={readOnly}
              onRemove={() => void remove('prescriptions', row.id)}
            >
              <div className={GRID}>
                <RowText
                  label="Strength"
                  value={row.strength}
                  disabled={readOnly}
                  onCommit={(value) => void edit('prescriptions', row.id, { strength: value })}
                />
                {/*
                  ⚠️ THE DOSE IS A STRING ON THE WIRE. Half a tablet is "0.5",
                  and a JSON number is an IEEE-754 double — the same reason every
                  quantity in the inventory contracts is a decimal string.
                */}
                <RowText
                  label="Dose"
                  value={row.dose}
                  disabled={readOnly}
                  onCommit={(value) =>
                    void edit('prescriptions', row.id, {
                      dose: value,
                      /* Both or neither — the CHECK. */
                      ...(value === null ? { doseUnit: null } : {}),
                    })
                  }
                />
                <RowText
                  label="Dose unit"
                  value={row.doseUnit}
                  disabled={readOnly}
                  onCommit={(value) => void edit('prescriptions', row.id, { doseUnit: value })}
                />
                <RowSelect
                  label="How"
                  value={row.route}
                  placeholder="Not recorded"
                  options={ROUTES}
                  disabled={readOnly}
                  onCommit={(value) =>
                    void edit('prescriptions', row.id, { route: value === '' ? null : value })
                  }
                />
                <RowNumber
                  label="How often"
                  value={row.frequency}
                  disabled={readOnly}
                  onCommit={(value) =>
                    void edit('prescriptions', row.id, {
                      frequency: value,
                      ...(value === null ? { frequencyUnit: null } : {}),
                    })
                  }
                />
                <RowSelect
                  label="Per"
                  value={row.frequencyUnit}
                  placeholder="—"
                  options={FREQUENCY_UNITS}
                  disabled={readOnly}
                  onCommit={(value) =>
                    void edit('prescriptions', row.id, {
                      frequencyUnit: value === '' ? null : value,
                    })
                  }
                />
                <RowNumber
                  label="For"
                  value={row.durationValue}
                  disabled={readOnly}
                  onCommit={(value) =>
                    void edit('prescriptions', row.id, {
                      durationValue: value,
                      ...(value === null ? { durationUnit: null } : {}),
                    })
                  }
                />
                <RowSelect
                  label="Unit"
                  value={row.durationUnit}
                  placeholder="—"
                  options={DURATION_UNITS}
                  disabled={readOnly}
                  onCommit={(value) =>
                    void edit('prescriptions', row.id, {
                      durationUnit: value === '' ? null : value,
                    })
                  }
                />
                <RowSelect
                  label="Food"
                  value={row.foodRelation}
                  placeholder="Not recorded"
                  options={FOOD_RELATIONS}
                  disabled={readOnly}
                  onCommit={(value) =>
                    void edit('prescriptions', row.id, {
                      foodRelation: value === '' ? null : value,
                    })
                  }
                />
                <RowText
                  label="When"
                  value={row.timing}
                  disabled={readOnly}
                  onCommit={(value) => void edit('prescriptions', row.id, { timing: value })}
                />
                <RowText
                  label="Total to dispense"
                  value={row.quantity}
                  disabled={readOnly}
                  onCommit={(value) => void edit('prescriptions', row.id, { quantity: value })}
                />
                <RowDate
                  label="Starting"
                  value={row.startDate}
                  disabled={readOnly}
                  onCommit={(value) => void edit('prescriptions', row.id, { startDate: value })}
                />
              </div>
              <div className="mt-3 grid gap-3 sm:grid-cols-2">
                <RowText
                  label="Instructions for the patient"
                  value={row.instructions}
                  rows={2}
                  disabled={readOnly}
                  onCommit={(value) => void edit('prescriptions', row.id, { instructions: value })}
                />
                <div>
                  {/*
                    ⚠️ "AS NEEDED" IS NOT THE SAME AS LEAVING THE FREQUENCY
                    BLANK. PRN says the patient decides when; a blank says the
                    doctor did not write it down.
                  */}
                  <label className="flex items-center gap-2 text-[0.9375rem]">
                    <input
                      type="checkbox"
                      className="size-4"
                      checked={row.isPrn}
                      disabled={readOnly}
                      onChange={(event) =>
                        void edit('prescriptions', row.id, { isPrn: event.target.checked })
                      }
                    />
                    Take as needed
                  </label>
                  <p className="text-muted mt-1 text-[0.75rem]">
                    Different from leaving the frequency blank — this says the patient decides when.
                  </p>
                </div>
              </div>
            </Row>
          ))}
        </ul>
      )}

      {readOnly ? null : (
        <div className="mt-4">
          <TermPicker
            label="Prescribe a medicine"
            hint="Searches the clinic's catalogue. Fill in the dose and course on the line it adds."
            placeholder="Start typing a medicine"
            disabled={readOnly}
            search={search}
            onPick={(picked) => {
              if (!('id' in picked)) return;
              void add('prescriptions', { productId: picked.id });
            }}
          />
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Investigations
// ---------------------------------------------------------------------------

const PRIORITIES = [
  { value: 'ROUTINE', label: 'Routine' },
  { value: 'URGENT', label: 'Urgent' },
  { value: 'STAT', label: 'Immediately' },
];

const INVESTIGATION_STATUSES = [
  { value: 'ORDERED', label: 'Ordered' },
  { value: 'COLLECTED', label: 'Sample taken' },
  { value: 'COMPLETED', label: 'Result back' },
  { value: 'CANCELLED', label: 'Called off' },
];

export function InvestigationSection(props: ContentSectionProps) {
  const { slug, content, readOnly, scopeId, add, edit, remove } = props;
  const rows: EncounterInvestigation[] = content.investigations;

  const search = useCallback(
    (term: string) => searchClinicalTerms(slug, 'INVESTIGATION', term, scopeId),
    [slug, scopeId]
  );

  return (
    <div>
      {rows.length === 0 ? (
        <Empty what="investigations" />
      ) : (
        <ul>
          {rows.map((row) => (
            <Row
              key={row.id}
              title={row.item?.name ?? '—'}
              readOnly={readOnly}
              onRemove={() => void remove('investigations', row.id)}
            >
              <div className={GRID}>
                <RowSelect
                  label="How soon"
                  value={row.priority}
                  options={PRIORITIES}
                  disabled={readOnly}
                  onCommit={(value) => void edit('investigations', row.id, { priority: value })}
                />
                <RowSelect
                  label="Where it has got to"
                  value={row.status}
                  options={INVESTIGATION_STATUSES}
                  disabled={readOnly}
                  onCommit={(value) => void edit('investigations', row.id, { status: value })}
                />
                <RowText
                  label="Why"
                  value={row.reason}
                  disabled={readOnly}
                  onCommit={(value) => void edit('investigations', row.id, { reason: value })}
                />
                <RowText
                  label="Instructions"
                  value={row.instructions}
                  disabled={readOnly}
                  onCommit={(value) => void edit('investigations', row.id, { instructions: value })}
                />
              </div>
            </Row>
          ))}
        </ul>
      )}

      {readOnly ? null : (
        <div className="mt-4">
          <TermPicker
            label="Order an investigation"
            hint="Comes from the clinic's own list. Add a missing one under Clinical terms."
            disabled={readOnly}
            search={search}
            onPick={(picked) => {
              if (!('id' in picked)) return;
              void add('investigations', { itemId: picked.id });
            }}
          />
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Advice
// ---------------------------------------------------------------------------

export function AdviceSection(props: ContentSectionProps) {
  const { slug, content, readOnly, scopeId, add, edit, remove } = props;
  const rows: EncounterAdvice[] = content.advice;

  const search = useCallback(
    (term: string) => searchClinicalTerms(slug, 'ADVICE', term, scopeId),
    [slug, scopeId]
  );

  return (
    <div>
      {rows.length === 0 ? (
        <Empty what="advice" />
      ) : (
        <ul>
          {rows.map((row) => (
            <Row
              key={row.id}
              title={termLabel(row)}
              subtitle={row.isEdited ? 'Tailored from the clinic’s standard advice' : undefined}
              readOnly={readOnly}
              onRemove={() => void remove('advice', row.id)}
            >
              {/*
                ⚠️ EDITING THE TEXT MOVES THE ROW FROM CODED TO TYPED, which the
                CHECK constraint requires and the server does. Which library
                entry it started from is on the audit trail, and `isEdited` is
                what tells the clinic which of its standard advice reaches
                patients unchanged.
              */}
              <RowText
                label="What the patient was told"
                value={row.customText ?? row.item?.name ?? ''}
                rows={2}
                disabled={readOnly}
                onCommit={(value) => {
                  if (value === null) return;
                  void edit('advice', row.id, { customText: value });
                }}
              />
            </Row>
          ))}
        </ul>
      )}

      {readOnly ? null : (
        <div className="mt-4">
          <TermPicker
            label="Add advice"
            hint="Pick from the clinic's library, or type your own. Either can be tailored afterwards."
            disabled={readOnly}
            search={search}
            onPick={(picked) =>
              void add(
                'advice',
                'id' in picked ? { itemId: picked.id } : { customText: picked.text }
              )
            }
          />
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Referrals
// ---------------------------------------------------------------------------

const URGENCIES = [
  { value: 'ROUTINE', label: 'Routine' },
  { value: 'URGENT', label: 'Urgent' },
  { value: 'EMERGENCY', label: 'Emergency' },
];

export function ReferralSection(props: ContentSectionProps) {
  const { slug, content, readOnly, add, edit, remove } = props;
  const rows: EncounterReferral[] = content.referrals;
  const [to, setTo] = useState('');
  const name = useId();

  const searchSpecialty = useCallback(
    (term: string) => searchReferralSpecialties(slug, term),
    [slug]
  );
  const searchColleague = useCallback((term: string) => searchReferralDoctors(slug, term), [slug]);

  return (
    <div>
      {rows.length === 0 ? (
        <Empty what="referrals" />
      ) : (
        <ul>
          {rows.map((row) => (
            <Row
              key={row.id}
              title={row.specialtyName ?? row.doctorName ?? row.externalName ?? '—'}
              readOnly={readOnly}
              onRemove={() => void remove('referrals', row.id)}
            >
              <div className={GRID}>
                <RowSelect
                  label="How urgent"
                  value={row.urgency}
                  options={URGENCIES}
                  disabled={readOnly}
                  onCommit={(value) => void edit('referrals', row.id, { urgency: value })}
                />
                <RowText
                  label="Why"
                  value={row.reason}
                  disabled={readOnly}
                  onCommit={(value) => void edit('referrals', row.id, { reason: value })}
                />
                <RowText
                  label="Notes"
                  value={row.notes}
                  disabled={readOnly}
                  onCommit={(value) => void edit('referrals', row.id, { notes: value })}
                />
              </div>
            </Row>
          ))}
        </ul>
      )}

      {readOnly ? null : (
        <div className="mt-4 space-y-3">
          {/*
            ⚠️ THREE DESTINATIONS, THREE CONTROLS, AND THE CHECK CONSTRAINT WANTS
              EXACTLY ONE OF THEM PER ROW. A specialty ("see a cardiologist"), a
              named colleague inside this organization, or somebody outside it by
              name. CE-4 offered only the third and said the other two were CE-5's;
              these are they.

            ⚠️ AND THE COLLEAGUE PICKER IS NOT THE DOCTOR ROSTER. A DOCTOR does not
              hold `doctor.directory.read` — the roster is a personnel list, and
              `GET /doctors` refuses them. `searchReferralDoctors` goes to
              `/doctors/referral-targets`, which sits behind the authoring code,
              requires a search term, and answers a name and a specialty. You can
              confirm the colleague you already know; you cannot ask who works here.
          */}
          <TermPicker
            label="Refer to a specialty"
            hint="A classification, when the patient needs a kind of clinician rather than a named one."
            placeholder="Start typing a specialty"
            disabled={readOnly}
            search={searchSpecialty}
            onPick={(picked) => {
              /* ⚠️ A SPECIALTY MUST BE PICKED, NOT TYPED. `specialty_id` is a
                 foreign key; free text here would have to become an
                 `externalName`, which silently turns "see a cardiologist" into
                 "refer to a person called Cardiology". */
              if ('id' in picked) void add('referrals', { specialtyId: picked.id });
            }}
          />

          <TermPicker
            label="Refer to a colleague"
            hint="Somebody at this organization. Type at least two letters of their name."
            placeholder="Start typing a name"
            disabled={readOnly}
            search={searchColleague}
            onPick={(picked) => {
              /* Same rule as the specialty above: an id or nothing. Somebody who
                 is not on the list is an outside referral, below. */
              if ('id' in picked) void add('referrals', { doctorProfileId: picked.id });
            }}
          />

          <div className="flex flex-wrap items-end gap-3">
            <Field
              name={name}
              label="Refer outside the clinic"
              hint="A clinician or hospital elsewhere, by name."
              className="min-w-[16rem] flex-1"
            >
              <input
                id={name}
                name={name}
                value={to}
                disabled={readOnly}
                className={inputClass}
                onChange={(event) => setTo(event.target.value)}
              />
            </Field>
            <Button
              variant="secondary"
              disabled={readOnly || to.trim() === ''}
              onClick={() => {
                void add('referrals', { externalName: to.trim() });
                setTo('');
              }}
            >
              Add
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Attachments
// ---------------------------------------------------------------------------

const ATTACHMENT_KINDS = [
  { value: 'PHOTO', label: 'Photograph' },
  { value: 'REPORT', label: 'Report' },
  { value: 'SCAN', label: 'Scan or X-ray' },
  { value: 'CONSENT', label: 'Consent' },
  { value: 'LETTER', label: 'Letter' },
  { value: 'OTHER', label: 'Other' },
];

/**
 * ⚠️ THE BYTES DO NOT GO THROUGH THIS COMPONENT (§27). Uploading is the
 *   documents surface's job — it owns storage providers, checksums and the
 *   `files` row. This links a file that already exists to the consultation and
 *   says what it is clinically, which is the only part the chart owns.
 */
export function AttachmentsSection(props: ContentSectionProps) {
  const { content, readOnly, edit, remove } = props;
  const rows: EncounterAttachment[] = content.attachments;

  return (
    <div>
      {rows.length === 0 ? (
        <Empty what="files" />
      ) : (
        <ul>
          {rows.map((row) => (
            <Row
              key={row.id}
              title={row.originalName}
              subtitle={`${Math.max(1, Math.round(row.sizeBytes / 1024))} KB`}
              readOnly={readOnly}
              onRemove={() => void remove('attachments', row.id)}
            >
              <div className="grid gap-3 sm:grid-cols-2">
                <RowSelect
                  label="What it is"
                  value={row.kind}
                  options={ATTACHMENT_KINDS}
                  disabled={readOnly}
                  onCommit={(value) => void edit('attachments', row.id, { kind: value })}
                />
                <RowText
                  label="Caption"
                  value={row.caption}
                  disabled={readOnly}
                  onCommit={(value) => void edit('attachments', row.id, { caption: value })}
                />
              </div>
            </Row>
          ))}
        </ul>
      )}
      {readOnly ? null : (
        <p className="text-muted mt-4 text-[0.8125rem]">
          Files are uploaded from the patient’s record and attached here.
        </p>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Follow-up (CD-13)
// ---------------------------------------------------------------------------

const INTERVAL_UNITS = [
  { value: 'DAYS', label: 'days' },
  { value: 'WEEKS', label: 'weeks' },
  { value: 'MONTHS', label: 'months' },
];

const FOLLOW_UP_TYPES = [
  { value: 'ROUTINE', label: 'Routine review' },
  { value: 'PROCEDURE_REVIEW', label: 'After a procedure' },
  { value: 'LAB_REVIEW', label: 'To go through results' },
  { value: 'POST_OPERATIVE', label: 'Post-operative' },
  { value: 'OTHER', label: 'Something else' },
];

/**
 * What the doctor ASKED the patient to do — which is not a booking (CD-13).
 *
 * ⚠️ "NO FOLLOW-UP NEEDED" IS A REAL ANSWER AND IS THE POINT OF THE SWITCH. A
 *   screen that only ever recorded a plan when one WAS needed could not tell
 *   "the doctor decided against one" from "the doctor forgot" — and the recall
 *   list is built on knowing the difference.
 *
 * ⚠️ AND IT IS NOT AN APPOINTMENT. Nothing here consumes a slot, burns an
 *   appointment number or appears on the day board. The patient books when they
 *   book, and the desk ticks this recommendation off when they do.
 */
export function FollowUpSection({
  followUp,
  readOnly,
  onSet,
}: {
  followUp: FollowUpRecommendation | null;
  readOnly: boolean;
  /*
   * ⚠️ THE CONTRACT'S OWN TYPE, NOT A LOOSER RESTATEMENT OF IT. `intervalUnit`
   *   and `followUpType` are closed enums; typing them as `string` here would
   *   move the check from the compiler to a 400 with a patient in the chair.
   */
  onSet: (body: SetFollowUpRecommendationRequest) => void;
}) {
  const [required, setRequired] = useState(followUp?.isRequired ?? true);
  const [value, setValue] = useState(
    followUp?.intervalValue === null || followUp?.intervalValue === undefined
      ? ''
      : String(followUp.intervalValue)
  );
  const [unit, setUnit] = useState<FollowUpIntervalUnitValue>(followUp?.intervalUnit ?? 'DAYS');
  const [type, setType] = useState<FollowUpTypeValue>(followUp?.followUpType ?? 'ROUTINE');
  const [reason, setReason] = useState(followUp?.reason ?? '');
  const nameId = useId();

  const booked = followUp?.fulfilledByAppointmentId !== null && followUp !== null;

  return (
    <div>
      {followUp === null ? null : (
        <p className="text-muted mb-4 text-[0.8125rem]">
          {booked
            ? 'The patient has booked against this recommendation.'
            : followUp.cancelledAt !== null
              ? 'This recommendation was cancelled.'
              : followUp.isRequired
                ? `Recorded${followUp.dueOn === null ? '' : ` — due ${followUp.dueOn}`}.`
                : 'Recorded: no follow-up needed.'}
        </p>
      )}

      <label className="flex items-center gap-2 text-[0.9375rem]">
        <input
          type="checkbox"
          className="size-4"
          checked={required}
          disabled={readOnly || booked}
          onChange={(event) => setRequired(event.target.checked)}
        />
        The patient should come back
      </label>

      {required ? (
        <div className={cn(GRID, 'mt-4')}>
          <Input
            name={`${nameId}-value`}
            label="In"
            type="number"
            min={1}
            disabled={readOnly || booked}
            value={value}
            onChange={(event) => setValue(event.target.value)}
          />
          <Select
            name={`${nameId}-unit`}
            label="Unit"
            options={INTERVAL_UNITS}
            disabled={readOnly || booked}
            value={unit}
            onChange={(event) => setUnit(event.target.value as FollowUpIntervalUnitValue)}
          />
          <Select
            name={`${nameId}-type`}
            label="What for"
            options={FOLLOW_UP_TYPES}
            disabled={readOnly || booked}
            value={type}
            onChange={(event) => setType(event.target.value as FollowUpTypeValue)}
          />
        </div>
      ) : null}

      <div className="mt-4">
        <Textarea
          name={`${nameId}-reason`}
          label="Why"
          hint="Recorded on the recall list, so whoever rings the patient knows what it is about."
          rows={2}
          disabled={readOnly || booked}
          value={reason}
          onChange={(event) => setReason(event.target.value)}
        />
      </div>

      {readOnly || booked ? null : (
        <Button
          variant="secondary"
          className="mt-4"
          disabled={required && value.trim() === ''}
          onClick={() =>
            onSet({
              isRequired: required,
              /* ⚠️ NOT REQUIRED CARRIES NO INTERVAL — the CHECK, and the point. */
              ...(required
                ? { intervalValue: Number(value), intervalUnit: unit, followUpType: type }
                : {}),
              reason: reason.trim() === '' ? null : reason.trim(),
            })
          }
        >
          {followUp === null ? 'Record the follow-up plan' : 'Update the follow-up plan'}
        </Button>
      )}
    </div>
  );
}
