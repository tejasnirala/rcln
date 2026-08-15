'use client';

import { useEffect, useId, useRef, useState } from 'react';
import type { ConsultationFieldConfig } from '@rcln/contracts';
import { Field, Input, Select, Textarea } from '@/components/ui/field';
import { cn } from '@/lib/cn';
import { searchClinicalTerms } from '@/app/(tenant)/t/[slug]/(app)/appointments/consultation-actions';

/**
 * One field of a descriptor-driven section, drawn from its descriptor.
 *
 * ⚠️ THIS IS THE WHOLE OF "CONFIGURATION DRIVES THE SCREEN", AND ITS LIMIT. A
 *   template chooses from THIRTEEN field types this file has components for; it
 *   cannot invent a fourteenth, and a descriptor naming one was refused by
 *   `@rcln/clinical` long before it reached a browser. Nothing here falls back
 *   to a text box for a type it does not recognise — that would turn a rejected
 *   configuration into a silently wrong form.
 *
 * ⚠️ AND THERE IS NO SPECIALTY IN THIS FILE (§33). No `if (specialty === …)`, no
 *   dentistry branch, no hair-and-scalp branch. The server decided which fields
 *   exist and what they are called; this draws exactly that. The day a component
 *   starts branching on a specialty, adding the next specialty costs a screen.
 *
 * Quiet and conventional, per apps/web/AGENTS.md: native controls, labels above,
 * units in the label. This is a dense form somebody fills in with a patient in
 * the room.
 */

/** What one field's answer can be. Mirrors the shapes `validate.ts` accepts. */
export type FieldValue = string | number | boolean | string[] | undefined;

export interface FieldRendererProps {
  field: ConsultationFieldConfig;
  value: FieldValue;
  onChange: (value: FieldValue) => void;
  disabled: boolean;
  /** Namespaces the control ids so two sections can share a field key. */
  sectionKey: string;
  /** The clinic, for the server-backed selectors. Bound, never user-supplied. */
  slug: string;
  /** The section's vocabulary scope. Ranks the selector's results (§34). */
  scopeId?: string | undefined;
}

const asString = (value: FieldValue): string =>
  typeof value === 'string' ? value : typeof value === 'number' ? String(value) : '';

const asList = (value: FieldValue): string[] => (Array.isArray(value) ? value : []);

export function FieldRenderer({
  field,
  value,
  onChange,
  disabled,
  sectionKey,
  slug,
  scopeId,
}: FieldRendererProps) {
  const name = `${sectionKey}.${field.key}`;
  const shared = {
    label: field.label,
    ...(field.hint !== undefined ? { hint: field.hint } : {}),
    disabled,
  };

  switch (field.type) {
    case 'TEXT':
      return (
        <Input
          {...shared}
          name={name}
          value={asString(value)}
          onChange={(event) => onChange(event.target.value)}
          {...(field.placeholder !== undefined ? { placeholder: field.placeholder } : {})}
          {...(field.maxLength !== undefined ? { maxLength: field.maxLength } : {})}
        />
      );

    case 'TEXTAREA':
      return (
        <Textarea
          {...shared}
          name={name}
          rows={4}
          value={asString(value)}
          onChange={(event) => onChange(event.target.value)}
          {...(field.placeholder !== undefined ? { placeholder: field.placeholder } : {})}
          {...(field.maxLength !== undefined ? { maxLength: field.maxLength } : {})}
        />
      );

    case 'NUMBER':
    case 'MEASUREMENT':
      return (
        <Input
          /*
           * ⚠️ THE UNIT IS IN THE LABEL, NOT IN AN ADORNMENT INSIDE THE BOX. A
           *   label is read aloud by a screen reader with the field; a decorative
           *   "mm" beside the caret is not, and the number it belongs to is the
           *   one thing on a clinical form that must never be ambiguous.
           */
          {...shared}
          label={field.unit === undefined ? field.label : `${field.label} (${field.unit})`}
          name={name}
          type="number"
          inputMode="decimal"
          value={asString(value)}
          onChange={(event) =>
            onChange(event.target.value === '' ? undefined : Number(event.target.value))
          }
          {...(field.min !== undefined ? { min: field.min } : {})}
          {...(field.max !== undefined ? { max: field.max } : {})}
          {...(field.precision !== undefined
            ? { step: field.precision === 0 ? 1 : Number(`0.${'0'.repeat(field.precision - 1)}1`) }
            : {})}
        />
      );

    case 'SELECT':
      return (
        <Select
          {...shared}
          name={name}
          value={asString(value)}
          placeholder="Choose one"
          options={(field.options ?? []).map((option) => ({
            value: option.value,
            label: option.label,
          }))}
          onChange={(event) => onChange(event.target.value === '' ? undefined : event.target.value)}
        />
      );

    case 'BOOLEAN':
      /*
       * ⚠️ THREE STATES, NOT TWO, AND ON A CLINICAL FORM THAT IS THE POINT. A
       *   checkbox cannot tell "no" from "not asked" — and "no known drug
       *   allergies" is a clinical statement somebody is accountable for, where
       *   an unticked box is silence. So it is Yes / No, and empty until one is
       *   chosen.
       */
      return (
        <Select
          {...shared}
          name={name}
          value={value === true ? 'yes' : value === false ? 'no' : ''}
          placeholder="Not recorded"
          options={[
            { value: 'yes', label: 'Yes' },
            { value: 'no', label: 'No' },
          ]}
          onChange={(event) =>
            onChange(event.target.value === '' ? undefined : event.target.value === 'yes')
          }
        />
      );

    case 'DATE':
    case 'DATETIME':
      return (
        <Input
          {...shared}
          name={name}
          type={field.type === 'DATE' ? 'date' : 'datetime-local'}
          value={asString(value)}
          onChange={(event) => onChange(event.target.value === '' ? undefined : event.target.value)}
        />
      );

    case 'RADIO_GROUP':
      return (
        <ChoiceGroup
          field={field}
          name={name}
          type="radio"
          selected={value === undefined ? [] : [asString(value)]}
          disabled={disabled}
          onToggle={(option) => onChange(option)}
        />
      );

    case 'CHECKBOX_GROUP':
    case 'MULTI_SELECT':
      return (
        <ChoiceGroup
          field={field}
          name={name}
          type="checkbox"
          selected={asList(value)}
          disabled={disabled}
          onToggle={(option) => {
            const current = asList(value);
            onChange(
              current.includes(option)
                ? current.filter((entry) => entry !== option)
                : [...current, option]
            );
          }}
        />
      );

    case 'SEARCH_SELECT':
    case 'CLINICAL_SELECTOR':
      return (
        <ServerSelect
          field={field}
          name={name}
          value={asString(value)}
          disabled={disabled}
          slug={slug}
          {...(scopeId !== undefined ? { scopeId } : {})}
          onChange={onChange}
        />
      );
  }
}

/**
 * Radio buttons and checkboxes, laid out the same way.
 *
 * A `<fieldset>` with a `<legend>`, because a group of controls needs one label
 * for the group and one per option — the thing a bare `<label>` above a row of
 * boxes silently fails to provide.
 */
function ChoiceGroup({
  field,
  name,
  type,
  selected,
  disabled,
  onToggle,
}: {
  field: ConsultationFieldConfig;
  name: string;
  type: 'radio' | 'checkbox';
  selected: string[];
  disabled: boolean;
  onToggle: (option: string) => void;
}) {
  return (
    <fieldset className="min-w-0">
      <legend className="text-ink mb-2 block text-[0.8125rem] font-medium">{field.label}</legend>
      <div className="flex flex-wrap gap-x-5 gap-y-2">
        {(field.options ?? []).map((option) => (
          <label
            key={option.value}
            className={cn(
              'flex items-center gap-2 text-[0.9375rem]',
              disabled ? 'opacity-60' : 'cursor-pointer'
            )}
          >
            <input
              type={type}
              name={name}
              value={option.value}
              checked={selected.includes(option.value)}
              disabled={disabled}
              onChange={() => onToggle(option.value)}
              className="accent-drape size-4"
            />
            {option.label}
          </label>
        ))}
      </div>
      {field.hint === undefined ? null : (
        <p className="text-muted mt-2 text-[0.75rem]">{field.hint}</p>
      )}
    </fieldset>
  );
}

/**
 * A selector whose options come from the server, one query at a time.
 *
 * ⚠️ IT NEVER LOADS ITS MASTER (§39). The vocabulary is platform-wide and runs
 *   to thousands of rows: shipping it to the browser is slow at nine in the
 *   morning and stale by ten, because a word the clinic added at half past is
 *   not in the copy this tab holds. So it searches, debounced, on every query.
 *
 * ⚠️ AND IT STORES THE NAME, NOT THE ID. This is a descriptor-driven section,
 *   whose answers live in `encounter_sections.data` — a JSONB document, and an
 *   id inside a document is invisible to every constraint, join and cascade in
 *   the database (ADR-0006, CD-6). Coded clinical content is what the CE-4
 *   tables are for, where a diagnosis is a real foreign key.
 */
function ServerSelect({
  field,
  name,
  value,
  disabled,
  slug,
  scopeId,
  onChange,
}: {
  field: ConsultationFieldConfig;
  name: string;
  value: string;
  disabled: boolean;
  slug: string;
  scopeId?: string | undefined;
  onChange: (value: FieldValue) => void;
}) {
  const listId = useId();
  const [options, setOptions] = useState<{ id: string; name: string }[]>([]);
  const kind = field.masterKind ?? field.source;

  /*
   * ⚠️ DEBOUNCED, AND THE TIMER IS CLEARED ON EVERY CHANGE. Without the cleanup
   *   a fast typist queues one request per keystroke and the answers arrive out
   *   of order — the list ends up showing the results for a prefix of what is in
   *   the box.
   */
  /*
   * ⚠️ THE SHORT-QUERY CASE IS RENDERED AWAY RATHER THAN CLEARED IN THE EFFECT.
   *   Calling `setOptions([])` in the effect body is a synchronous state write
   *   during an effect, which cascades a render — and it was never needed: the
   *   suggestions a stale query returned simply are not drawn.
   */
  const searching = kind !== undefined && value.trim().length >= 2;

  const latest = useRef(0);
  useEffect(() => {
    if (!searching || kind === undefined) return;
    const query = ++latest.current;
    const timer = setTimeout(() => {
      void searchClinicalTerms(slug, kind, value, scopeId).then((results) => {
        /* Ignore an answer that a later query has already overtaken. */
        if (query === latest.current) setOptions(results);
      });
    }, 250);
    return () => clearTimeout(timer);
  }, [slug, kind, value, scopeId, searching]);

  return (
    <Field
      name={name}
      label={field.label}
      {...(field.hint !== undefined ? { hint: field.hint } : {})}
    >
      <input
        id={name}
        name={name}
        list={listId}
        value={value}
        disabled={disabled}
        autoComplete="off"
        placeholder={field.placeholder ?? 'Start typing to search'}
        onChange={(event) => onChange(event.target.value === '' ? undefined : event.target.value)}
        className="border-rule bg-paper text-ink focus:border-drape focus:ring-drape/30 h-10 w-full rounded-md border px-3 text-[0.9375rem] focus:ring-2 focus:outline-none"
      />
      {/*
        A native <datalist>: the suggestions are the operating system's, so the
        keyboard, the type-ahead and the mobile pickers come for free — the same
        trade `Select` documents. Typing something the list does not contain is
        deliberately allowed: §6 wants a clinician able to record a word the
        vocabulary has not learned yet.
      */}
      <datalist id={listId}>
        {(searching ? options : []).map((option) => (
          <option key={option.id} value={option.name} />
        ))}
      </datalist>
    </Field>
  );
}
