/**
 * Reading a field descriptor out of a template's JSONB `definition`, safely.
 *
 * ⚠️ THE DOCUMENT IS `unknown` AND MUST STAY `unknown` UNTIL IT IS CHECKED. It
 *   comes out of a JSONB column, so the type system knows nothing about it: a
 *   half-written descriptor typechecks perfectly, casts perfectly, and then
 *   renders a mandatory field as optional on a clinical form.
 *
 * ── THE PI-5 LESSON, TRANSPLANTED VERBATIM (CD-10) ───────────────────────────
 *
 *     { "require": true }   ONE TYPO   →   field silently not required   WRONG
 *                                      →   descriptor rejected           RIGHT
 *
 *   `readBoolean` cannot distinguish ABSENT from MISSPELLED — nothing can. So
 *   this parser does two things instead of defaulting:
 *
 *     1. `required` IS MANDATORY on every descriptor. A document that omits it
 *        is refused. There is no "not stated means not required", because that
 *        reading is what turns a typo into a switched-off safety check.
 *     2. AN UNKNOWN KEY IS REFUSED. `require` is not silently ignored — it is
 *        named in the error, which is what turns a five-minute mystery into a
 *        sentence. A permissive parser cannot tell a typo from an extension, and
 *        a clinical form is not the place to guess.
 *
 * ⚠️ AND EVERY TYPE'S ESSENTIAL KEY IS MANDATORY FOR THAT TYPE. A SELECT with no
 *   options is a dropdown a clinician cannot answer; a MEASUREMENT with no unit
 *   is a number nobody can interpret; a CLINICAL_SELECTOR with no master kind
 *   searches nothing. Each is refused rather than rendered empty.
 *
 * No Prisma, no clock, no React, no country, no specialty — see the package
 * README and `@rcln/regulatory`, on which this is modelled.
 */
import type {
  ClinicalVocabularyKind,
  ConsultationFieldType,
  FieldDescriptor,
  FieldOption,
  Parsed,
} from './types.js';
import { CONSULTATION_FIELD_TYPES } from './types.js';
import { DOCUMENT_LIMITS } from './validate.js';

function fail<T>(problem: string): Parsed<T> {
  return { ok: false, problem };
}

function asRecord(value: unknown, what: string): Parsed<Record<string, unknown>> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return fail(`${what} is not an object`);
  }
  return { ok: true, value: value as Record<string, unknown> };
}

/**
 * ⚠️ `[a-z0-9_]` AND NOTHING ELSE, BECAUSE A KEY IS A STORAGE ADDRESS. It names
 *   a property in `encounter_sections.data`, is read back by every consultation
 *   that ever used this template, and appears in reporting SQL. A key with a dot
 *   or a space in it is a path expression somewhere downstream.
 */
const KEY_PATTERN = /^[a-z][a-z0-9_]*$/;

const VOCABULARY_KINDS: readonly ClinicalVocabularyKind[] = [
  'SYMPTOM',
  'DIAGNOSIS',
  'PROCEDURE',
  'INVESTIGATION',
  'ADVICE',
  'HISTORY_ITEM',
  'FINDING_TYPE',
];

/**
 * Which keys each field type may carry, beyond the common ones.
 *
 * ⚠️ THE LIST IS AN ALLOW-LIST AND ITS ABSENCE IS AN ERROR. `options` on a
 *   MEASUREMENT is not harmless clutter — it is somebody who believes they
 *   configured a dropdown and did not, and the screen they get back looks
 *   deliberate.
 */
const TYPE_KEYS: Readonly<Record<ConsultationFieldType, readonly string[]>> = {
  TEXT: ['maxLength', 'placeholder'],
  TEXTAREA: ['maxLength', 'placeholder'],
  NUMBER: ['min', 'max', 'precision', 'placeholder'],
  SELECT: ['options'],
  MULTI_SELECT: ['options'],
  RADIO_GROUP: ['options'],
  CHECKBOX_GROUP: ['options'],
  BOOLEAN: [],
  DATE: [],
  DATETIME: [],
  MEASUREMENT: ['unit', 'min', 'max', 'precision'],
  SEARCH_SELECT: ['source'],
  CLINICAL_SELECTOR: ['masterKind'],
};

/** The key every field type carries, whatever it is. */
const COMMON_KEYS: readonly string[] = ['key', 'type', 'label', 'required', 'hint'];

/**
 * The key a type is MEANINGLESS without. `null` = the type is complete on its
 * own, which is a statement rather than an omission.
 */
const ESSENTIAL_KEY: Readonly<Record<ConsultationFieldType, string | null>> = {
  TEXT: null,
  TEXTAREA: null,
  NUMBER: null,
  SELECT: 'options',
  MULTI_SELECT: 'options',
  RADIO_GROUP: 'options',
  CHECKBOX_GROUP: 'options',
  BOOLEAN: null,
  DATE: null,
  DATETIME: null,
  MEASUREMENT: 'unit',
  SEARCH_SELECT: 'source',
  CLINICAL_SELECTOR: 'masterKind',
};

function readRequiredString(
  source: Record<string, unknown>,
  key: string,
  where: string,
  max: number
): Parsed<string> {
  const raw = source[key];
  if (raw === undefined || raw === null) return fail(`${where} does not say "${key}"`);
  if (typeof raw !== 'string') return fail(`${where}'s "${key}" is not a string`);
  const trimmed = raw.trim();
  if (trimmed === '') return fail(`${where}'s "${key}" is empty`);
  if (trimmed.length > max) return fail(`${where}'s "${key}" is longer than ${max} characters`);
  return { ok: true, value: trimmed };
}

function readOptionalString(
  source: Record<string, unknown>,
  key: string,
  where: string,
  max: number
): Parsed<string | undefined> {
  if (source[key] === undefined || source[key] === null) return { ok: true, value: undefined };
  return readRequiredString(source, key, where, max);
}

/**
 * ⚠️ MANDATORY, AND THE ERROR SAYS SO. See the file header — this single
 *   decision is why the package exists.
 */
function readRequiredBoolean(
  source: Record<string, unknown>,
  key: string,
  where: string
): Parsed<boolean> {
  const raw = source[key];
  if (raw === undefined || raw === null) {
    return fail(
      `${where} does not say "${key}". State it explicitly as true or false — an omission is not read as false.`
    );
  }
  if (typeof raw !== 'boolean') return fail(`${where}'s "${key}" is not true or false`);
  return { ok: true, value: raw };
}

function readOptionalNumber(
  source: Record<string, unknown>,
  key: string,
  where: string,
  options: { integer?: boolean; min?: number; max?: number } = {}
): Parsed<number | undefined> {
  const raw = source[key];
  if (raw === undefined || raw === null) return { ok: true, value: undefined };
  if (typeof raw !== 'number' || !Number.isFinite(raw)) {
    return fail(`${where}'s "${key}" is not a number`);
  }
  if (options.integer === true && !Number.isInteger(raw)) {
    return fail(`${where}'s "${key}" is not a whole number`);
  }
  if (options.min !== undefined && raw < options.min) {
    return fail(`${where}'s "${key}" is less than ${options.min}`);
  }
  if (options.max !== undefined && raw > options.max) {
    return fail(`${where}'s "${key}" is more than ${options.max}`);
  }
  return { ok: true, value: raw };
}

function readOptions(raw: unknown, where: string): Parsed<readonly FieldOption[]> {
  if (!Array.isArray(raw)) return fail(`${where}'s "options" is not a list`);
  /*
   * ⚠️ AN EMPTY LIST IS REFUSED, AND THIS IS THE SECOND HALF OF THE PI-5 GAP.
   *   Every test there covered an ABSENT parameter and none covered one that
   *   EXISTED but was empty — so `"options": []` sailed through as "configured",
   *   and produced a dropdown with nothing in it that reads on screen as a
   *   loading failure rather than a broken template.
   */
  if (raw.length === 0) return fail(`${where}'s "options" is empty`);
  /*
   * ⚠️ AND A CEILING, BECAUSE THE ANSWER HAS ONE (CE-8). A stored list answer is
   *   bounded at `DOCUMENT_LIMITS.listEntries`, so a group offering more choices
   *   than a clinician could ever legally tick is a template that publishes and
   *   then cannot be filled in.
   */
  if (raw.length > DOCUMENT_LIMITS.listEntries) {
    return fail(
      `${where}'s "options" has more than ${String(DOCUMENT_LIMITS.listEntries)} choices in it`
    );
  }

  const seen = new Set<string>();
  const parsed: FieldOption[] = [];
  for (const [index, entry] of raw.entries()) {
    const record = asRecord(entry, `${where}'s option ${index + 1}`);
    if (!record.ok) return fail(record.problem);

    const value = readRequiredString(record.value, 'value', `${where}'s option ${index + 1}`, 64);
    if (!value.ok) return fail(value.problem);
    const label = readRequiredString(record.value, 'label', `${where}'s option ${index + 1}`, 160);
    if (!label.ok) return fail(label.problem);

    for (const key of Object.keys(record.value)) {
      if (key !== 'value' && key !== 'label') {
        return fail(`${where}'s option ${index + 1} carries an unknown key "${key}"`);
      }
    }

    /*
     * ⚠️ DUPLICATES ARE REFUSED RATHER THAN DEDUPLICATED. Two options sharing a
     *   value are two labels that write the same answer, so the record cannot
     *   say which one the clinician chose — and a silent dedupe would delete
     *   whichever one the author actually meant to keep.
     */
    if (seen.has(value.value)) {
      return fail(`${where} has two options with the value "${value.value}"`);
    }
    seen.add(value.value);
    parsed.push({ value: value.value, label: label.value });
  }
  return { ok: true, value: parsed };
}

/**
 * Parse one field descriptor.
 *
 * `where` names the descriptor in every error — "the field 3 of section
 * `dental_history`" — because a template is edited as one document and "a
 * descriptor is invalid" is not something anybody can act on.
 */
export function parseFieldDescriptor(input: unknown, where: string): Parsed<FieldDescriptor> {
  const record = asRecord(input, where);
  if (!record.ok) return fail(record.problem);
  const source = record.value;

  const key = readRequiredString(source, 'key', where, 64);
  if (!key.ok) return fail(key.problem);
  if (!KEY_PATTERN.test(key.value)) {
    return fail(
      `${where}'s "key" is "${key.value}" — a key is lowercase letters, digits and underscores, starting with a letter`
    );
  }

  const rawType = source['type'];
  if (
    typeof rawType !== 'string' ||
    !CONSULTATION_FIELD_TYPES.includes(rawType as ConsultationFieldType)
  ) {
    /*
     * ⚠️ AN UNKNOWN FIELD TYPE IS AN ERROR, NOT A BLANK. The renderer has one
     *   component per member of a closed set; a template naming something else
     *   is describing a screen this engine cannot draw, and drawing nothing
     *   there looks to a clinician exactly like a field that was answered.
     */
    return fail(`${where}'s "type" is not a field type this engine can render`);
  }
  const type = rawType as ConsultationFieldType;

  const label = readRequiredString(source, 'label', where, 160);
  if (!label.ok) return fail(label.problem);

  const required = readRequiredBoolean(source, 'required', where);
  if (!required.ok) return fail(required.problem);

  const allowed = new Set([...COMMON_KEYS, ...TYPE_KEYS[type]]);
  for (const present of Object.keys(source)) {
    if (!allowed.has(present)) {
      return fail(
        `${where} carries "${present}", which a ${type} field does not use. Check the spelling — an unrecognised key is never ignored.`
      );
    }
  }

  const essential = ESSENTIAL_KEY[type];
  if (essential !== null && (source[essential] === undefined || source[essential] === null)) {
    return fail(`${where} is a ${type} field and does not say "${essential}"`);
  }

  const hint = readOptionalString(source, 'hint', where, 240);
  if (!hint.ok) return fail(hint.problem);
  const placeholder = readOptionalString(source, 'placeholder', where, 160);
  if (!placeholder.ok) return fail(placeholder.problem);

  const descriptor: {
    -readonly [K in keyof FieldDescriptor]: FieldDescriptor[K];
  } = { key: key.value, type, label: label.value, required: required.value };
  if (hint.value !== undefined) descriptor.hint = hint.value;
  if (placeholder.value !== undefined) descriptor.placeholder = placeholder.value;

  if (source['options'] !== undefined) {
    const options = readOptions(source['options'], where);
    if (!options.ok) return fail(options.problem);
    descriptor.options = options.value;
  }

  if (source['unit'] !== undefined) {
    const unit = readRequiredString(source, 'unit', where, 24);
    if (!unit.ok) return fail(unit.problem);
    descriptor.unit = unit.value;
  }

  const precision = readOptionalNumber(source, 'precision', where, { integer: true, min: 0 });
  if (!precision.ok) return fail(precision.problem);
  if (precision.value !== undefined) descriptor.precision = precision.value;

  const min = readOptionalNumber(source, 'min', where);
  if (!min.ok) return fail(min.problem);
  if (min.value !== undefined) descriptor.min = min.value;

  const max = readOptionalNumber(source, 'max', where);
  if (!max.ok) return fail(max.problem);
  if (max.value !== undefined) descriptor.max = max.value;

  /*
   * ⚠️ AN IMPOSSIBLE RANGE IS REFUSED HERE RATHER THAN AT DATA ENTRY. A field
   *   with min 10 and max 5 rejects every value a clinician can type, and the
   *   message they get says the number is out of range — which sends them
   *   looking at the patient rather than at the template.
   */
  if (min.value !== undefined && max.value !== undefined && min.value > max.value) {
    return fail(`${where} has a "min" greater than its "max"`);
  }

  const maxLength = readOptionalNumber(source, 'maxLength', where, {
    integer: true,
    min: 1,
    /* The stored answer's own ceiling. A field that permitted more would be a
       form the autosave refuses — see DOCUMENT_LIMITS. */
    max: DOCUMENT_LIMITS.textLength,
  });
  if (!maxLength.ok) return fail(maxLength.problem);
  if (maxLength.value !== undefined) descriptor.maxLength = maxLength.value;

  if (source['masterKind'] !== undefined) {
    const raw = source['masterKind'];
    if (typeof raw !== 'string' || !VOCABULARY_KINDS.includes(raw as ClinicalVocabularyKind)) {
      return fail(`${where}'s "masterKind" is not a clinical vocabulary this engine knows`);
    }
    descriptor.masterKind = raw as ClinicalVocabularyKind;
  }

  if (source['source'] !== undefined) {
    const value = readRequiredString(source, 'source', where, 64);
    if (!value.ok) return fail(value.problem);
    descriptor.source = value.value;
  }

  return { ok: true, value: descriptor };
}

/**
 * Parse a section's whole field list.
 *
 * ⚠️ AN EMPTY LIST IS REFUSED. A descriptor-driven section with no fields is a
 *   heading with nothing under it — and the registry only ever asks for fields
 *   on the two section types that have nothing else to render.
 */
export function parseFieldDescriptors(
  input: unknown,
  where: string
): Parsed<readonly FieldDescriptor[]> {
  if (!Array.isArray(input)) return fail(`${where}'s "fields" is not a list`);
  if (input.length === 0) return fail(`${where}'s "fields" is empty`);
  /*
   * ⚠️ AND A CEILING, FOR THE REASON `readOptions` HAS ONE (CE-8). A section of
   *   250 fields writes a document the autosave refuses — at the keyboard of a
   *   doctor who did not write the template. The author is told here instead.
   */
  if (input.length > DOCUMENT_LIMITS.fieldsPerSection) {
    return fail(
      `${where}'s "fields" has more than ${String(DOCUMENT_LIMITS.fieldsPerSection)} fields in it`
    );
  }

  const seen = new Set<string>();
  const fields: FieldDescriptor[] = [];
  for (const [index, entry] of input.entries()) {
    const parsed = parseFieldDescriptor(entry, `${where}, field ${index + 1}`);
    if (!parsed.ok) return fail(parsed.problem);
    /*
     * ⚠️ TWO FIELDS SHARING A KEY WRITE TO THE SAME PROPERTY OF
     *   `encounter_sections.data`. Whichever renders second wins, silently, and
     *   the first field's answer is simply never recorded.
     */
    if (seen.has(parsed.value.key)) {
      return fail(`${where} has two fields with the key "${parsed.value.key}"`);
    }
    seen.add(parsed.value.key);
    fields.push(parsed.value);
  }
  return { ok: true, value: fields };
}
