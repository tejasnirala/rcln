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

/**
 * What a picker hands back.
 *
 * ⚠️ `widened` IS NOT A DETAIL THE SCREEN MAY DROP. It is the difference between
 *   "the dental list is these four" and "no dental term matched, so this is the
 *   whole catalogue" — and a clinician who cannot tell them apart will read a
 *   general term as one their specialty endorses.
 */
export interface PickerResults {
  items: { id: string; name: string }[];
  widened: boolean;
}

/** `allSpecialties` is the picker's own toggle, not the caller's decision. */
export type PickerSearch = (term: string, allSpecialties: boolean) => Promise<PickerResults>;

/*
 * ⚠️ THREE SEARCHES HERE HAVE NO TAXONOMY SCOPE AND SO NEVER WIDEN: medicines
 *   (§42.8 — a dermatologist and a dentist prescribe the same amoxicillin), the
 *   referral specialty picker (it searches the taxonomy itself) and the
 *   colleague picker (it searches people). Each returns `widened: false` inline
 *   rather than through a helper, because `useCallback` wants a function
 *   EXPRESSION and the lint rule that says so is enforcing a real React
 *   Compiler constraint.
 */

/** What every section needs to talk to the server. */
export interface ContentSectionProps {
  slug: string;
  encounterId: string;
  content: EncounterContent;
  readOnly: boolean;
  /**
   * The section's vocabulary scopes — every node the template names, not the
   * first one. Scoped by default in the picker, with a toggle to widen (§34).
   */
  scopeIds?: readonly string[] | undefined;
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

/**
 * One recorded row: what it says, the controls that qualify it, and a remove.
 *
 * ⚠️ EXPORTED FOR THE CHART (CE-6), WHICH IS A TENTH SECTION OVER THE SAME
 *   SHAPE. A second copy of these five controls in `visual-mapping.tsx` would
 *   be five places for a finding's row to stop looking like a diagnosis's.
 */
export function Row({
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
export function Empty({ what }: { what: string }) {
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
 *
 * ⚠️ THE SINGLE-PICK VARIANT, AND IT IS NOT THE DEFAULT ANY MORE. Every section
 *   that adds a LIST of rows uses `TermMultiPicker` below, which can be browsed
 *   and ticked. This one survives for the two places that set ONE value and
 *   would be actively worse as a multi-select: a referral's destination, and a
 *   finding on a single tooth in `visual-mapping.tsx`.
 */
export function TermPicker({
  label,
  hint,
  placeholder,
  disabled,
  alreadyAdded,
  search,
  canWiden,
  onPick,
}: {
  label: string;
  hint?: string | undefined;
  placeholder?: string | undefined;
  disabled: boolean;
  /**
   * Ids this list already holds. Picking one again is refused with a sentence
   * rather than silently ignored.
   *
   * ⚠️ REFUSED AT COMMIT, NOT FILTERED OUT OF THE SUGGESTIONS. A `<datalist>`
   *   cannot disable an option, so the only way to pre-empt the choice is to
   *   drop it — and a dropped option is indistinguishable from one the
   *   catalogue does not have. Worse, the clinician could then type the name in
   *   full, fall through to the free-text branch, and have the referral handler
   *   discard it with nothing on screen. Refusing after the fact is the only
   *   version that says what happened.
   */
  alreadyAdded?: ReadonlySet<string> | undefined;
  search: PickerSearch;
  /** True where a scope exists to widen out of — draws the toggle. */
  canWiden?: boolean | undefined;
  /** `id` when a listed term was chosen, otherwise the words that were typed. */
  onPick: (picked: { id: string } | { text: string }) => void;
}) {
  const listId = useId();
  const name = useId();
  const [term, setTerm] = useState('');
  const [options, setOptions] = useState<{ id: string; name: string }[]>([]);
  const [refused, setRefused] = useState<string | null>(null);
  const [allSpecialties, setAllSpecialties] = useState(false);
  const [widened, setWidened] = useState(false);
  const latest = useRef(0);

  const searching = term.trim().length >= 2;

  useEffect(() => {
    if (!searching) return;
    const query = ++latest.current;
    const timer = setTimeout(() => {
      void search(term, allSpecialties).then((results) => {
        if (query !== latest.current) return;
        setOptions(results.items);
        setWidened(results.widened);
      });
    }, 250);
    return () => clearTimeout(timer);
  }, [term, searching, search, allSpecialties]);

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
    if (matched !== undefined && alreadyAdded?.has(matched.id) === true) {
      setRefused(`${matched.name} is already on this list.`);
      return;
    }
    setRefused(null);
    onPick(matched === undefined ? { text: typed } : { id: matched.id });
    setTerm('');
    setOptions([]);
  };

  return (
    <div className="flex flex-wrap items-end gap-3">
      <Field
        name={name}
        label={label}
        {...(refused !== null ? { errors: [refused] } : hint !== undefined ? { hint } : {})}
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
          onChange={(event) => {
            setTerm(event.target.value);
            /* The refusal is about the last thing pressed, not the field —
               editing it is the clinician answering, so it goes. */
            if (refused !== null) setRefused(null);
          }}
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
        <ScopeNote
          canWiden={canWiden === true}
          allSpecialties={allSpecialties}
          widened={widened}
          disabled={disabled}
          onToggle={setAllSpecialties}
        />
      </Field>
      <Button variant="secondary" onClick={commit} disabled={disabled || term.trim() === ''}>
        Add
      </Button>
    </div>
  );
}

/**
 * "Showing this specialty" and the way out of it.
 *
 * ⚠️ ONE COMPONENT FOR BOTH PICKERS, so the wording and the behaviour cannot
 *   drift. A clinician who learns the toggle in Symptoms must find the same one
 *   in Treatment.
 *
 * ⚠️ THE AUTOMATIC WIDENING ANNOUNCES ITSELF. `widened` means the scoped search
 *   matched nothing and this list is the whole catalogue — said in words,
 *   because a list that quietly changed what it was showing is how a general
 *   term gets read as one the specialty endorses.
 *
 * ⚠️ AND IT IS A CHECKBOX, NOT A FILTER CHIP. The state is binary and sticky for
 *   the life of the picker; the clinician who wants the wide list usually wants
 *   it for the next search too.
 */
function ScopeNote({
  canWiden,
  allSpecialties,
  widened,
  disabled,
  onToggle,
}: {
  canWiden: boolean;
  allSpecialties: boolean;
  widened: boolean;
  disabled: boolean;
  onToggle: (next: boolean) => void;
}) {
  if (!canWiden) return null;

  return (
    <div className="mt-2 flex flex-wrap items-center gap-2">
      <label className="text-muted flex cursor-pointer items-center gap-2 text-[0.8125rem]">
        <input
          type="checkbox"
          checked={allSpecialties}
          disabled={disabled}
          onChange={(event) => onToggle(event.target.checked)}
        />
        Show all specialties
      </label>
      {widened && !allSpecialties ? (
        <span className="text-muted text-[0.8125rem]">
          Nothing in this specialty matched — showing all.
        </span>
      ) : null}
    </div>
  );
}

/**
 * A section as two boxes side by side: what has been recorded, and how to add.
 *
 * ⚠️ THE RECORD IS ON THE LEFT AND THE CONTROLS ARE ON THE RIGHT, WHICH IS THE
 *   OPPOSITE OF HOW THESE SECTIONS USED TO READ. Stacked, the picker sat
 *   underneath a list that grows — so by the fourth symptom the way to add a
 *   fifth had walked off the bottom of the card, and the clinician scrolled to
 *   find a control that had not moved relative to anything except the thing they
 *   had just done. Side by side, the picker stays put and the record grows next
 *   to it.
 *
 * ⚠️ IT STACKS BELOW `lg`, AND THE RECORD COMES FIRST WHEN IT DOES. That is the
 *   reading order in the markup, so it is also the order a screen reader and a
 *   phone get: what is true about this patient, then the means to change it.
 *
 * ⚠️ `lg:items-start` IS LOAD-BEARING. Grid items stretch to the tallest row by
 *   default, which would pull the picker's border down the full height of a
 *   twelve-row prescription list and leave it framing empty space.
 *
 * ⚠️ AND THE COUNT IS IN THE HEADING, NOT INFERRED FROM THE LIST. "Medicines
 *   prescribed · 3" is checkable at a glance against what is on screen; a
 *   clinician scrolling a boxed list has no other way to know whether they are
 *   looking at all of it.
 */
/**
 * The catalogue ids a section is already holding.
 *
 * ⚠️ CODED ROWS ONLY, AND THE `null` IS NOT AN OVERSIGHT. A row recorded in the
 *   clinician's own words has no id to compare against, so it can never make a
 *   list option "already added" — two people typing similar sentences are two
 *   observations, not one duplicated, and the machine has no business deciding
 *   they are the same. The duplicate this guards is the exact one: the same
 *   catalogue entry added twice.
 *
 * Rebuilt on every render rather than memoised: it is a Set over a list that is
 * a handful of rows long, and a stale one here is a duplicate written to a
 * patient's record.
 */
function recordedIds(
  rows: { item?: { id: string } | null; product?: { id: string } | null }[]
): ReadonlySet<string> {
  const ids = new Set<string>();
  for (const row of rows) {
    const id = row.item?.id ?? row.product?.id;
    if (id !== undefined && id !== null) ids.add(id);
  }
  return ids;
}

function SplitSection({
  recordedLabel,
  count,
  picker,
  children,
}: {
  recordedLabel: string;
  count: number;
  /** `null` in a finalized consultation — the left box then takes the width. */
  picker: React.ReactNode;
  children: React.ReactNode;
}) {
  if (picker === null) {
    return (
      <div className="border-rule rounded-lg border p-4">
        <p className="text-ink text-[0.8125rem] font-medium">
          {recordedLabel}
          {count === 0 ? '' : ` · ${String(count)}`}
        </p>
        <div className="mt-3">{children}</div>
      </div>
    );
  }

  return (
    <div className="grid gap-4 lg:grid-cols-2 lg:items-start">
      <div className="border-rule rounded-lg border p-4">
        <p className="text-ink text-[0.8125rem] font-medium">
          {recordedLabel}
          {count === 0 ? '' : ` · ${String(count)}`}
        </p>
        {/*
          ⚠️ CAPPED AND SCROLLABLE, LIKE THE OPTION LIST OPPOSITE IT. A visit
            with fourteen prescriptions would otherwise make this column six
            times the height of the picker beside it, and the two-column layout
            would read as one column with something stranded at the top right.
        */}
        <div className="mt-3 max-h-[32rem] overflow-y-auto">{children}</div>
      </div>
      {picker}
    </div>
  );
}

/**
 * The same vocabulary, BROWSABLE, and several at a time.
 *
 * ⚠️ THIS EXISTS BECAUSE `TermPicker` ABOVE CANNOT BE BROWSED, AND THAT WAS THE
 *   WHOLE COMPLAINT. A `<datalist>` shows nothing until two characters are
 *   typed, so a clinician who does not already know what the clinic put in its
 *   catalogue sees an empty box and no way to find out. "I do not understand
 *   what to enter" is the correct reaction to that control, not a
 *   misunderstanding of it.
 *
 *   So this one opens showing the list. Searching NARROWS it rather than being
 *   the only way in.
 *
 * ⚠️ AND IT ADDS SEVERAL, BECAUSE A CONSULTATION IS SEVERAL. Four symptoms and
 *   two diagnoses is an ordinary visit; six round trips through a single-value
 *   box, each one re-rendering the section underneath, is not how anybody wants
 *   to spend a consultation with a patient in the room.
 *
 * ⚠️ SELECTION SURVIVES A SEARCH. Ticking "Amoxicillin", searching "para",
 *   ticking "Paracetamol" and pressing Add records BOTH — the chosen rows are
 *   held by id and name, not by position in whatever the box last returned. A
 *   picker that silently dropped the first one would be worse than no
 *   multi-select, because the loss is invisible until somebody reads the
 *   prescription.
 *
 * ⚠️ THE FREE-TEXT ESCAPE IS STILL HERE, and it is not decoration. §6 wants a
 *   symptom the vocabulary has not learned yet to be recordable, and the CHECK
 *   behind these rows accepts an id XOR the clinician's own words. Sections
 *   whose contract has no `customText` column pass `allowCustom={false}` and get
 *   the list alone.
 *
 * ⚠️ WHAT IS ALREADY ON THE RECORD CANNOT BE ADDED AGAIN. `alreadyAdded` carries
 *   the ids the section is already holding, and those options are rendered
 *   TICKED AND DISABLED with "already added" beside them.
 *
 *   ⚠️ DISABLED RATHER THAN HIDDEN, WHICH IS THE WHOLE POINT. An option that
 *     vanishes once it is used reads as a catalogue that has lost something —
 *     the clinician searches for "Fever", does not find it, and concludes the
 *     list is broken or that they never added it. Shown as already-added, the
 *     list answers the question instead of raising one.
 *
 *   ⚠️ AND `commit()` FILTERS AGAIN ON THE WAY OUT. The disabled checkbox is a
 *     courtesy, not the guarantee: the selection is held across searches and the
 *     content underneath refreshes on every add, so a row can arrive between
 *     ticking something and pressing Add — from this doctor in another tab, or
 *     from the same click landing twice. Checking once, at the point of writing,
 *     is what actually stops the duplicate.
 *
 * ⚠️ ADDS ARE SEQUENTIAL, NOT `Promise.all`. Each one is a row insert whose
 *   response replaces the section's content, and the server assigns
 *   `displayOrder` from what it already holds. Fired in parallel they race, and
 *   the recorded order comes back shuffled — which for a diagnosis list, where
 *   the first row is the one the rest of the screen treats as primary, is a
 *   clinical difference and not a cosmetic one.
 */
export function TermMultiPicker({
  label,
  hint,
  emptyNote,
  disabled,
  allowCustom = true,
  alreadyAdded,
  search,
  canWiden,
  onAdd,
}: {
  label: string;
  hint?: string | undefined;
  /** Shown when the catalogue itself is empty — see the note in the body. */
  emptyNote?: string | undefined;
  disabled: boolean;
  /** `true` where the row accepts the clinician's own words as well as an id. */
  allowCustom?: boolean;
  /** Ids this section already holds. Offered as already-added, never twice. */
  alreadyAdded: ReadonlySet<string>;
  search: PickerSearch;
  /** True where a scope exists to widen out of — draws the toggle. */
  canWiden?: boolean | undefined;
  onAdd: (picked: ({ id: string } | { text: string })[]) => Promise<void> | void;
}) {
  const searchName = useId();
  const customName = useId();

  const [term, setTerm] = useState('');
  const [options, setOptions] = useState<{ id: string; name: string }[]>([]);
  /*
   * ⚠️ WHICH TERM THE VISIBLE LIST ANSWERS, NOT AN `isLoading` FLAG. Setting one
   *   synchronously inside the effect is what the React Compiler's
   *   "cascading renders" rule refuses, and rightly — the fact being tracked is
   *   derived, not owned. `null` means nothing has come back yet.
   */
  const [loadedFor, setLoadedFor] = useState<string | null>(null);
  const [allSpecialties, setAllSpecialties] = useState(false);
  const [widened, setWidened] = useState(false);
  /** id -> name, so a chosen row can still be named after the list moves on. */
  const [chosen, setChosen] = useState<Map<string, string>>(new Map());
  const [custom, setCustom] = useState('');
  const [saving, setSaving] = useState(false);
  const latest = useRef(0);

  /*
   * Runs on mount with an empty term — which is what makes this browsable — and
   * again, debounced, on every change. The same guarded-latest arrangement
   * `TermPicker` documents: without it a fast typist ends up looking at the
   * results for a prefix of what is in the box.
   */
  useEffect(() => {
    const query = ++latest.current;
    const timer = setTimeout(
      () => {
        void search(term, allSpecialties).then((results) => {
          if (query !== latest.current) return;
          setOptions(results.items);
          setWidened(results.widened);
          setLoadedFor(term);
        });
      },
      /* No debounce on the first, empty query — that one IS the browse, and a
         quarter-second of "Loading…" before a list nobody asked to filter is a
         quarter-second of the panel looking broken. */
      term === '' ? 0 : 250
    );
    return () => clearTimeout(timer);
  }, [term, search, allSpecialties]);

  const toggle = (option: { id: string; name: string }): void => {
    if (alreadyAdded.has(option.id)) return;
    setChosen((current) => {
      const next = new Map(current);
      if (next.has(option.id)) next.delete(option.id);
      else next.set(option.id, option.name);
      return next;
    });
  };

  const commit = async (): Promise<void> => {
    const typed = custom.trim();
    const picked: ({ id: string } | { text: string })[] = [
      /* Filtered again here, not only at the checkbox — see the note above. */
      ...[...chosen.keys()].filter((id) => !alreadyAdded.has(id)).map((id) => ({ id })),
      ...(allowCustom && typed !== '' ? [{ text: typed }] : []),
    ];
    if (picked.length === 0) return;

    setSaving(true);
    try {
      await onAdd(picked);
      setChosen(new Map());
      setCustom('');
    } finally {
      setSaving(false);
    }
  };

  /*
   * Counts what would ACTUALLY be written. A selection that went stale — the row
   * arrived from somewhere else after it was ticked — must not be promised on
   * the button, or "Add 2" writes one and nothing explains the difference.
   */
  const addable = [...chosen.keys()].filter((id) => !alreadyAdded.has(id)).length;
  const count = addable + (allowCustom && custom.trim() !== '' ? 1 : 0);
  const busy = disabled || saving;

  return (
    <fieldset className="border-rule rounded-lg border p-4">
      <legend className="text-ink px-1 text-[0.8125rem] font-medium">{label}</legend>
      {hint === undefined ? null : <p className="text-muted text-[0.8125rem]">{hint}</p>}

      <div className="mt-3">
        <Input
          name={searchName}
          label="Search the list"
          value={term}
          disabled={busy}
          autoComplete="off"
          placeholder="Type to narrow it down"
          onChange={(event) => setTerm(event.target.value)}
        />
        <ScopeNote
          canWiden={canWiden === true}
          allSpecialties={allSpecialties}
          widened={widened}
          disabled={busy}
          onToggle={setAllSpecialties}
        />
      </div>

      {/*
        ⚠️ A SCROLLING BOX WITH A FIXED CEILING, NOT AN UNBOUNDED LIST. The
          section below it is the record being written; a catalogue of sixty
          procedures pushing it off the screen would make the picker the page.
      */}
      <div
        className="border-rule mt-3 max-h-56 overflow-y-auto rounded-md border"
        role="group"
        aria-label={label}
      >
        {loadedFor === null ? (
          <p className="text-muted p-3 text-[0.8125rem]">Loading…</p>
        ) : options.length === 0 ? (
          /*
            ⚠️ TWO DIFFERENT EMPTINESSES, SAID DIFFERENTLY. "Your search matched
              nothing" is a dead end the clinician can back out of; "this clinic
              has not put anything in this list yet" is a fact about the SETUP,
              and it names the screen that fixes it. Rendering the same shrug for
              both is how a clinic concludes the software is broken when what it
              actually needs is half an hour at /clinical-terms.
          */
          <p className="text-muted p-3 text-[0.8125rem]">
            {/* `loadedFor`, not `term` — it names what was actually searched,
                so the message cannot describe a query still being typed. */}
            {(loadedFor ?? '').trim() === ''
              ? (emptyNote ?? 'Nothing in this list yet.')
              : `Nothing matches “${(loadedFor ?? '').trim()}”.`}
          </p>
        ) : (
          <ul>
            {options.map((option) => (
              <li key={option.id} className="border-rule border-t first:border-t-0">
                {/*
                  The label WRAPS the box, which is the one place
                  apps/web/AGENTS.md says not to reach for `Field` — and the whole
                  row is the target, so it clears 24×24 (WCAG 2.5.8) by a margin
                  rather than being a 16px box somebody has to hit exactly.
                */}
                <label
                  className={cn(
                    'flex items-center gap-2.5 px-3 py-2 text-[0.875rem]',
                    alreadyAdded.has(option.id)
                      ? 'text-muted cursor-default'
                      : 'hover:bg-drape-tint/40 cursor-pointer'
                  )}
                >
                  <input
                    type="checkbox"
                    className="size-4 shrink-0"
                    checked={chosen.has(option.id) || alreadyAdded.has(option.id)}
                    disabled={busy || alreadyAdded.has(option.id)}
                    onChange={() => toggle(option)}
                  />
                  {option.name}
                  {/*
                    ⚠️ THE WORDS, NOT JUST THE GREY AND THE TICK (WCAG 1.4.1).
                      A disabled checkbox that is already ticked reads as "you
                      selected this a moment ago" to anybody who did not; it has
                      to say which.
                  */}
                  {alreadyAdded.has(option.id) ? (
                    <span className="text-muted ml-auto text-[0.75rem]">already added</span>
                  ) : null}
                </label>
              </li>
            ))}
          </ul>
        )}
      </div>

      {/*
        ⚠️ THE CHOSEN ROWS ARE LISTED, NOT JUST COUNTED. They are the half of the
          selection that may no longer be visible in the box above — see the note
          on surviving a search — so "3 selected" alone would be asking the
          clinician to trust a number about rows they cannot see.
      */}
      {chosen.size === 0 ? null : (
        <ul className="mt-3 flex flex-wrap gap-2" aria-label="Selected">
          {[...chosen].map(([id, name]) => (
            <li key={id}>
              <button
                type="button"
                disabled={busy}
                onClick={() => toggle({ id, name })}
                className="border-drape/30 bg-drape-tint/60 text-drape-deep hover:border-drape inline-flex cursor-pointer items-center gap-1.5 rounded-full border px-2.5 py-1 text-[0.75rem]"
              >
                {name}
                <span aria-hidden="true">×</span>
                <span className="sr-only">Remove from the selection</span>
              </button>
            </li>
          ))}
        </ul>
      )}

      {!allowCustom ? null : (
        <div className="mt-3">
          <Input
            name={customName}
            label="Not in the list?"
            hint="Type it in your own words. Recorded exactly as written."
            value={custom}
            disabled={busy}
            autoComplete="off"
            onChange={(event) => setCustom(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                void commit();
              }
            }}
          />
        </div>
      )}

      <div className="mt-4">
        <Button variant="secondary" disabled={busy || count === 0} onClick={() => void commit()}>
          {saving
            ? 'Adding…'
            : count === 0
              ? 'Add'
              : count === 1
                ? 'Add 1'
                : `Add ${String(count)}`}
        </Button>
      </div>
    </fieldset>
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
export function RowText({
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
export function RowSelect({
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

/*
 * ⚠️ TWO COLUMNS BEFORE THREE, BECAUSE THE ROW IS IN HALF THE WIDTH IT USED TO
 *   BE. These controls sit inside `SplitSection`'s left box now, so `sm:` — a
 *   640px viewport — is nothing like 640px of row. Three columns there put a
 *   "Dose unit" label on two lines above a box four characters wide. The third
 *   column comes back at `2xl`, where the half really is wide enough for it.
 */
const GRID = 'grid gap-3 sm:grid-cols-2 2xl:grid-cols-3';

// ---------------------------------------------------------------------------
// Symptoms
// ---------------------------------------------------------------------------

export function SymptomsSection(props: ContentSectionProps) {
  const { slug, content, readOnly, scopeIds, add, edit, remove } = props;
  const rows: EncounterSymptom[] = content.symptoms;

  const search = useCallback(
    (term: string, allSpecialties: boolean) =>
      searchClinicalTerms(slug, 'SYMPTOM', term, scopeIds ?? [], allSpecialties),
    [slug, scopeIds]
  );

  return (
    <SplitSection
      recordedLabel="Symptoms recorded"
      count={rows.length}
      picker={
        readOnly ? null : (
          <TermMultiPicker
            label="Add symptoms"
            hint="Tick as many as apply, or type your own words for something the list does not have."
            emptyNote="This clinic has not added any symptoms yet. An administrator sets them up under Clinical terms."
            disabled={readOnly}
            alreadyAdded={recordedIds(rows)}
            search={search}
            canWiden={(scopeIds?.length ?? 0) > 0}
            onAdd={async (picked) => {
              for (const one of picked) {
                await add('symptoms', 'id' in one ? { itemId: one.id } : { customText: one.text });
              }
            }}
          />
        )
      }
    >
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
    </SplitSection>
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
  const { slug, content, readOnly, scopeIds, add, edit, remove } = props;
  const rows: EncounterDiagnosis[] = content.diagnoses;

  const search = useCallback(
    (term: string, allSpecialties: boolean) =>
      searchClinicalTerms(slug, 'DIAGNOSIS', term, scopeIds ?? [], allSpecialties),
    [slug, scopeIds]
  );

  return (
    <SplitSection
      recordedLabel="Diagnoses recorded"
      count={rows.length}
      picker={
        readOnly ? null : (
          <TermMultiPicker
            label="Add diagnoses"
            hint="Tick as many as apply, or type your own words. None is primary until you say so — set it explicitly on the row."
            emptyNote="This clinic has not added any diagnoses yet. An administrator sets them up under Clinical terms."
            disabled={readOnly}
            alreadyAdded={recordedIds(rows)}
            search={search}
            canWiden={(scopeIds?.length ?? 0) > 0}
            onAdd={async (picked) => {
              /* One at a time, in the order they were chosen — see the note on
                 `TermMultiPicker`. `displayOrder` is assigned server-side. */
              for (const one of picked) {
                await add('diagnoses', 'id' in one ? { itemId: one.id } : { customText: one.text });
              }
            }}
          />
        )
      }
    >
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
    </SplitSection>
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

export function ProcedureSection(
  props: ContentSectionProps & {
    /**
     * The places this consultation's charts offer (CE-7). Empty when the
     * template resolved no chart, and the control is then not rendered at all —
     * a "Where" with one option saying "nowhere" is a question with no answer.
     */
    chartRegions: readonly { value: string; label: string }[];
  }
) {
  const { slug, content, readOnly, scopeIds, chartRegions, add, edit, remove } = props;
  const rows: EncounterProcedure[] = content.procedures;

  const search = useCallback(
    (term: string, allSpecialties: boolean) =>
      searchClinicalTerms(slug, 'PROCEDURE', term, scopeIds ?? [], allSpecialties),
    [slug, scopeIds]
  );

  /*
   * ⚠️ THE CHART IS WHERE A REGION IS CHOSEN, AND THIS IS THE SAME LIST IN A
   *   SELECT (CE-6 deferred it here on purpose). A procedure is not drawn on —
   *   it is recorded against a place — so it takes the region as a value rather
   *   than a click, and the two stay one list because both come from the
   *   template's resolved maps.
   */
  const regionOptions = [{ value: '', label: 'Not on the chart' }, ...chartRegions];

  /* What it treats — the diagnoses recorded on THIS consultation, and no others. */
  const diagnosisOptions = [
    { value: '', label: 'Not linked to a diagnosis' },
    ...content.diagnoses.map((diagnosis) => ({
      value: diagnosis.id,
      label: termLabel(diagnosis),
    })),
  ];

  return (
    <SplitSection
      recordedLabel="Procedures recorded"
      count={rows.length}
      picker={
        readOnly ? null : (
          <TermMultiPicker
            label="Add procedures"
            /*
             * ⚠️ `allowCustom={false}` AND THE HINT SAYS WHY. A procedure is
             *   billed, consumed from stock and reported on, so a typed one is a
             *   line nothing downstream can price or count. The picker enforces
             *   it; the sentence explains it.
             */
            hint="Tick as many as apply. Procedures come from the clinic's own list, because they are billed and consumed from stock."
            emptyNote="This clinic has not added any procedures yet. An administrator sets them up under Clinical terms."
            allowCustom={false}
            disabled={readOnly}
            alreadyAdded={recordedIds(rows)}
            search={search}
            canWiden={(scopeIds?.length ?? 0) > 0}
            onAdd={async (picked) => {
              for (const one of picked) {
                if ('id' in one) await add('procedures', { itemId: one.id });
              }
            }}
          />
        )
      }
    >
      {rows.length === 0 ? (
        <Empty what="procedures" />
      ) : (
        <ul>
          {rows.map((row) => (
            <Row
              key={row.id}
              /* "Root canal treatment — 36": the place is part of what the
                 procedure IS, and the contract carries the region so the list
                 does not need a lookup per row to say it. */
              title={
                row.region === null
                  ? (row.item?.name ?? '—')
                  : `${row.item?.name ?? '—'} — ${row.region.label}`
              }
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
                {chartRegions.length === 0 ? null : (
                  <RowSelect
                    label="Where"
                    value={row.region?.id ?? null}
                    options={regionOptions}
                    disabled={readOnly}
                    onCommit={(value) =>
                      void edit('procedures', row.id, {
                        visualRegionId: value === '' ? null : value,
                      })
                    }
                  />
                )}
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
    </SplitSection>
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
  const search = useCallback<PickerSearch>(
    async (term) => ({ items: await searchPrescribableProducts(slug, term), widened: false }),
    [slug]
  );

  return (
    <SplitSection
      recordedLabel="Medicines prescribed"
      count={rows.length}
      picker={
        readOnly ? null : (
          <TermMultiPicker
            label="Prescribe medicines"
            /*
             * ⚠️ THE DOSE IS NOT ASKED FOR HERE, AND THAT IS THE DELIBERATE
             *   TRADE. Tick the medicines, add them all, then fill the dose,
             *   frequency, course and food relation on each line — every one of
             *   those controls already exists on the row above. Asking for them
             *   in this panel would mean one medicine at a time, which is the
             *   thing being fixed.
             *
             *   ⚠️ WHICH MEANS AN ADDED MEDICINE STARTS WITH NO DOSE. That is a
             *     real state and the hint says so, because a prescription signed
             *     with a blank dose is a prescription a pharmacist cannot fill.
             */
            hint="Tick as many as you are prescribing. Set the dose and course on each line afterwards — a medicine is added with none."
            emptyNote="This clinic has no medicines in its catalogue yet. An administrator adds them under Products."
            allowCustom={false}
            disabled={readOnly}
            alreadyAdded={recordedIds(rows)}
            /* ⚠️ NO `canWiden` HERE, AND ITS ABSENCE IS THE POINT. §42.8 — a
               medicine belongs to no single specialty; a dermatologist and a
               dentist prescribe the same amoxicillin. There is nothing to widen
               out of, so offering the toggle would be a control that changes
               nothing, which teaches people to distrust the ones that do. */
            search={search}
            onAdd={async (picked) => {
              for (const one of picked) {
                if ('id' in one) await add('prescriptions', { productId: one.id });
              }
            }}
          />
        )
      }
    >
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
    </SplitSection>
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
  const { slug, content, readOnly, scopeIds, add, edit, remove } = props;
  const rows: EncounterInvestigation[] = content.investigations;

  const search = useCallback(
    (term: string, allSpecialties: boolean) =>
      searchClinicalTerms(slug, 'INVESTIGATION', term, scopeIds ?? [], allSpecialties),
    [slug, scopeIds]
  );

  return (
    <SplitSection
      recordedLabel="Investigations ordered"
      count={rows.length}
      picker={
        readOnly ? null : (
          <TermMultiPicker
            label="Order investigations"
            hint="Tick everything you are ordering. Comes from the clinic's own list."
            emptyNote="This clinic has not added any investigations yet. An administrator sets them up under Clinical terms."
            allowCustom={false}
            disabled={readOnly}
            alreadyAdded={recordedIds(rows)}
            search={search}
            canWiden={(scopeIds?.length ?? 0) > 0}
            onAdd={async (picked) => {
              for (const one of picked) {
                if ('id' in one) await add('investigations', { itemId: one.id });
              }
            }}
          />
        )
      }
    >
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
    </SplitSection>
  );
}

// ---------------------------------------------------------------------------
// Advice
// ---------------------------------------------------------------------------

/**
 * ⚠️ THE ROW IS THE ADVICE AND NOTHING ELSE — NO "What the patient was told" BOX.
 *   It used to carry one, seeded with `customText ?? item.name`, which on a row
 *   picked from the library meant a textarea repeating the title directly above
 *   it. Read as a form field that is what it looks like: a duplicate somebody
 *   forgot to remove.
 *
 *   ⚠️ WHAT IT ACTUALLY WAS, AND WHAT REMOVING IT COSTS: it was the TAILORING
 *     control — `updateEncounterAdviceRequest`, the one update in
 *     `encounter-content.ts` that touches the text, which turns "Brushing
 *     technique" into "brushing technique, and stop using the hard brush" and
 *     sets `isEdited`. That endpoint still exists and still works; there is now
 *     no way to reach it from this screen, so advice is given exactly as the
 *     library words it or typed in full through "Not in the list?".
 *
 *     `isEdited` is still rendered as a subtitle, because rows tailored before
 *     this change are still on the record and still say so.
 */
export function AdviceSection(props: ContentSectionProps) {
  const { slug, content, readOnly, scopeIds, add, remove } = props;
  const rows: EncounterAdvice[] = content.advice;

  const search = useCallback(
    (term: string, allSpecialties: boolean) =>
      searchClinicalTerms(slug, 'ADVICE', term, scopeIds ?? [], allSpecialties),
    [slug, scopeIds]
  );

  return (
    <SplitSection
      recordedLabel="Advice given"
      count={rows.length}
      picker={
        readOnly ? null : (
          <TermMultiPicker
            label="Add advice"
            hint="Tick as many as apply, or type your own words for anything the library does not cover."
            emptyNote="This clinic has not added any advice to its library yet. An administrator sets it up under Clinical terms."
            disabled={readOnly}
            alreadyAdded={recordedIds(rows)}
            search={search}
            canWiden={(scopeIds?.length ?? 0) > 0}
            onAdd={async (picked) => {
              for (const one of picked) {
                await add('advice', 'id' in one ? { itemId: one.id } : { customText: one.text });
              }
            }}
          />
        )
      }
    >
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
            />
          ))}
        </ul>
      )}
    </SplitSection>
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

  /* Neither of these reads the clinical vocabulary, so neither is scoped: one
     searches the taxonomy itself and the other searches people. */
  const searchSpecialty = useCallback<PickerSearch>(
    async (term) => ({ items: await searchReferralSpecialties(slug, term), widened: false }),
    [slug]
  );
  const searchColleague = useCallback<PickerSearch>(
    async (term) => ({ items: await searchReferralDoctors(slug, term), widened: false }),
    [slug]
  );

  /*
   * Two lists, not one, because a referral names EITHER a specialty or a
   * colleague and the ids come from different tables — a specialty id colliding
   * with a doctor profile id would be a coincidence, but relying on it not
   * happening is not a guarantee worth taking. An external referral is a typed
   * name with no id, so it is not deduped; see `recordedIds`.
   */
  const referredSpecialties = new Set(
    rows.map((row) => row.specialtyId).filter((id): id is string => id !== null)
  );
  const referredColleagues = new Set(
    rows.map((row) => row.doctorProfileId).filter((id): id is string => id !== null)
  );

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
            alreadyAdded={referredSpecialties}
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
            alreadyAdded={referredColleagues}
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
