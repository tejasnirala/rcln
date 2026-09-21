'use client';

import { useState } from 'react';
import { applyNationalIdMask, nationalIdTypesFor, normalizeNationalId } from '@rcln/contracts';
import { Field, Select, inputClass } from '@/components/ui/field';

/**
 * "ID produced" — which document, and then the number in that document's shape.
 *
 * ⚠️ THE TYPE IS CHOSEN FIRST AND THE NUMBER FIELD FOLLOWS IT. Before this the
 *   field was one free-text box hinted "Aadhaar, passport", which meant the
 *   column held Aadhaars, PANs and passport numbers with no way to tell which —
 *   and no way to check any of them, because a check needs to know what it is
 *   looking at.
 *
 * ⚠️ THE GROUPING IS DISPLAY ONLY. Aadhaar is typed and read back as
 *   `2345 6789 0123` because that is how it is printed on the card, but what is
 *   SUBMITTED is `234567890123` — the same normalisation the column stores and
 *   the duplicate check compares against. A hidden input carries the normalised
 *   value so the visible box can be pretty without the two ever diverging.
 *
 * The list comes from the clinic's country, and always ends with Passport and
 * "Something else", neither of which has a pattern. That is the escape hatch the
 * contract's comment insists on: a rejected document makes the desk leave the
 * field blank, which loses the identity check entirely.
 */
export function NationalIdInput({
  countryCode,
  typeName,
  valueName,
  defaultType,
  defaultValue,
  errors,
  onSettled,
}: {
  /** The clinic's country. Decides which documents are offered. */
  countryCode: string;
  typeName: string;
  valueName: string;
  /**
   * What is already on the record, when this is an edit rather than a
   * registration. `defaultValue` arrives NORMALISED — that is how the column
   * stores it — and is put back through the document's mask for display, so an
   * Aadhaar reads as `2345 6789 0123` again without the stored value changing.
   *
   * Read once, on mount. A form that re-seeded itself from props mid-edit would
   * throw away what somebody was halfway through typing.
   */
  defaultType?: string | null | undefined;
  defaultValue?: string | null | undefined;
  errors?: string[] | undefined;
  /**
   * The NORMALISED value, once the field is left.
   *
   * The caller uses it to ask whether this document is already on record — the
   * column is uniquely indexed, so a clash refuses the registration outright.
   * Normalised rather than as displayed, because that is what is stored and what
   * the check compares against.
   */
  onSettled?: ((value: string) => void) | undefined;
}) {
  const types = nationalIdTypesFor(countryCode);
  const [typeCode, setTypeCode] = useState(defaultType ?? '');
  const [raw, setRaw] = useState(() =>
    defaultValue ? applyNationalIdMask(countryCode, defaultType ?? '', defaultValue) : ''
  );

  const format = types.find((t) => t.code === typeCode) ?? null;
  const normalized = normalizeNationalId(raw);

  /**
   * Every keystroke goes through the document's mask.
   *
   * ⚠️ THE MASK IS THE GATE, NOT A FORMATTER. It drops any character that cannot
   *   go in the next position and stops accepting past the document's length —
   *   so an Aadhaar field takes exactly twelve digits and no thirteenth, and a
   *   PAN field refuses a digit in its first five slots. Filtering only by
   *   `numeric`, as this did, allowed both: `5678988899` in a PAN and as many
   *   digits as anybody cared to type in an Aadhaar, with the mistake surfacing
   *   on submit if at all.
   *
   *   Documents whose shape genuinely varies (a passport) have no mask and are
   *   only length-capped. See `applyNationalIdMask`.
   */
  const accept = (next: string): void => {
    setRaw(format ? applyNationalIdMask(countryCode, typeCode, next) : next.slice(0, 64));
  };

  return (
    <>
      <Select
        name={typeName}
        label="ID produced"
        value={typeCode}
        onChange={(event) => {
          setTypeCode(event.target.value);
          /*
           * Cleared on a type change, deliberately. Re-grouping an Aadhaar as a
           * PAN produces a plausible-looking value that was never on any
           * document — worse than an empty field, because it reads as checked.
           */
          setRaw('');
        }}
        placeholder="No ID produced"
        options={types.map((t) => ({ value: t.code, label: t.label }))}
      />

      <Field
        name={valueName}
        label="ID number"
        {...(format?.example ? { hint: `For example ${format.example}.` } : {})}
        {...(errors ? { errors } : {})}
      >
        <input
          id={valueName}
          className={`${inputClass} font-mono`}
          value={raw}
          onChange={(event) => accept(event.target.value)}
          onBlur={() => onSettled?.(normalized)}
          /*
           * No type chosen means nothing to record against — see the Select
           * above. The exception is a record that already carries a number with
           * no type on it: rows predate `nationalIdType`, and locking the field
           * would leave the one value that most needs correcting uneditable.
           */
          disabled={typeCode === '' && raw === ''}
          autoComplete="off"
          inputMode={format?.numeric === true ? 'numeric' : 'text'}
          /*
           * A belt to the mask's braces, and it counts the SEPARATORS too — the
           * mask's own length, not the document's, because that is what is on
           * screen. The mask is what actually stops the typing; this stops a
           * paste being longer than the box before the mask sees it.
           */
          maxLength={format?.mask?.length ?? format?.maxLength ?? 64}
          aria-describedby={errors ? `${valueName}-error` : `${valueName}-hint`}
          aria-invalid={errors ? true : undefined}
          placeholder={format?.example ?? ''}
        />
        {/* What actually submits. Normalised, so display never reaches the API. */}
        <input type="hidden" name={valueName} value={normalized} />
      </Field>
    </>
  );
}
