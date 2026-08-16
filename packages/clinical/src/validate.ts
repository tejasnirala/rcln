/**
 * The ANSWER side of the grammar: an encounter's section data against the
 * descriptors it was collected under (CE-3).
 *
 * `descriptors.ts` decides whether a template SAYS something checkable. This
 * file decides whether what a clinician typed satisfies it. Same package, same
 * rule, opposite direction — and the same reason for living here rather than in
 * a service: it holds no Prisma client, no clock and no React, so it is
 * unit-tested with fixtures instead of with a database (CD-10).
 *
 * ── WHEN THIS RUNS, AND WHEN IT DELIBERATELY DOES NOT ────────────────────────
 *
 * ⚠️ AT FINALIZATION, AND NEVER AT AUTOSAVE. A draft is allowed to be
 *   incomplete — that is what a draft IS, and a doctor half way through typing
 *   an examination must not be interrupted by an error about a field they have
 *   not reached. What must not be possible is SIGNING an incomplete record, so
 *   the check sits on the one transition that makes the record permanent.
 *
 * ⚠️ AND IT RUNS AGAINST THE ENCOUNTER'S FROZEN SNAPSHOT, NEVER THE LIVE
 *   TEMPLATE (§29). A clinic that publishes a new version mid-consultation must
 *   not have its doctor's half-written record judged against a form they never
 *   saw.
 *
 * ── WHY AN UNKNOWN KEY IS AN ERROR ───────────────────────────────────────────
 *
 * ⚠️ DATA UNDER A KEY NO DESCRIPTOR DECLARES IS REFUSED RATHER THAN IGNORED, and
 *   this is the PI-5 lesson pointing the other way. A silently kept stray key is
 *   an answer nothing will ever render: it was typed into a field that has since
 *   been renamed, it will not appear on the printed record, and the clinician has
 *   no way to discover that what they wrote is gone. Refusing at the one moment
 *   somebody is present to fix it is the honest outcome.
 */
import { capabilityOf } from './registry.js';
import type { FieldDescriptor, Parsed, TemplateDefinition, TemplateSection } from './types.js';

/** One section's answers, as they come off `encounter_sections`. */
export interface SectionAnswers {
  readonly key: string;
  readonly data: Readonly<Record<string, unknown>>;
}

/** Everything wrong with a consultation, not merely the first thing. */
export interface ValidationProblem {
  readonly sectionKey: string;
  readonly fieldKey: string | null;
  readonly problem: string;
}

function isBlank(value: unknown): boolean {
  if (value === undefined || value === null) return true;
  if (typeof value === 'string') return value.trim() === '';
  if (Array.isArray(value)) return value.length === 0;
  return false;
}

/**
 * Is this answer a legal SHAPE for its field type?
 *
 * ⚠️ SHAPE ONLY — RANGE AND OPTION MEMBERSHIP ARE CHECKED SEPARATELY BELOW, so
 *   that "you typed text into a number" and "42 is above the maximum" are two
 *   different sentences. A single combined message would tell a clinician their
 *   entry is invalid without telling them which half is wrong.
 */
/**
 * `2026-08-16`, and a real day.
 *
 * ⚠️ THE REGEX ALONE WOULD ACCEPT `2026-02-31`, which is why the round trip
 *   through `Date` is here: a calendar date that does not exist renders as
 *   something else entirely on the printed record, and the only moment anybody
 *   can fix it is before the record is signed.
 */
function isCalendarDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

/**
 * An ISO instant with a `Z` on it — invariant 6, inside a JSONB document.
 *
 * ⚠️ A LOCAL WALL CLOCK IS REFUSED, AND THAT IS THE POINT. `datetime-local`
 *   hands back `2026-08-16T14:30` with no zone, and a clinical answer stored
 *   that way means 14:30 in whichever zone whoever reads it next happens to be
 *   in — five and a half hours out between the clinic and the container, with
 *   nothing on screen saying it shifted. The web control converts through the
 *   branch's zone before it saves; this is what makes that non-optional.
 */
function isInstant(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?Z$/.test(value)) return false;
  return !Number.isNaN(new Date(value).getTime());
}

function shapeProblem(field: FieldDescriptor, value: unknown): string | null {
  switch (field.type) {
    case 'TEXT':
    case 'TEXTAREA':
    case 'SEARCH_SELECT':
    case 'CLINICAL_SELECTOR':
    case 'SELECT':
    case 'RADIO_GROUP':
      return typeof value === 'string' ? null : 'is not text';
    case 'DATE':
      if (typeof value !== 'string') return 'is not a date';
      return isCalendarDate(value) ? null : 'is not a date (expected YYYY-MM-DD)';
    case 'DATETIME':
      if (typeof value !== 'string') return 'is not a date and time';
      return isInstant(value) ? null : 'is not a date and time in UTC (expected an ISO instant)';
    case 'NUMBER':
    case 'MEASUREMENT':
      return typeof value === 'number' && Number.isFinite(value) ? null : 'is not a number';
    case 'BOOLEAN':
      return typeof value === 'boolean' ? null : 'is not true or false';
    case 'MULTI_SELECT':
    case 'CHECKBOX_GROUP':
      if (!Array.isArray(value) || !value.every((entry) => typeof entry === 'string')) {
        return 'is not a list of choices';
      }
      /*
       * ⚠️ THE SAME CHOICE TWICE IS REFUSED RATHER THAN DEDUPLICATED. A list
       *   that reads "Diabetes, Diabetes" on the printed record is a question
       *   about the record; silently collapsing it is an edit to what a
       *   clinician wrote, made by the software, after the fact.
       */
      return new Set(value as string[]).size === value.length
        ? null
        : 'has the same choice in it twice';
  }
}

function optionProblem(field: FieldDescriptor, value: unknown): string | null {
  if (field.options === undefined) return null;
  const allowed = new Set(field.options.map((option) => option.value));
  const chosen = Array.isArray(value) ? value : [value];
  for (const entry of chosen) {
    if (typeof entry === 'string' && !allowed.has(entry)) {
      return `is not one of its choices ("${entry}")`;
    }
  }
  return null;
}

function rangeProblem(field: FieldDescriptor, value: unknown): string | null {
  if (typeof value === 'number') {
    if (field.min !== undefined && value < field.min) return `is below ${String(field.min)}`;
    if (field.max !== undefined && value > field.max) return `is above ${String(field.max)}`;
  }
  if (
    typeof value === 'string' &&
    field.maxLength !== undefined &&
    value.length > field.maxLength
  ) {
    return `is longer than ${String(field.maxLength)} characters`;
  }
  return null;
}

function validateSection(
  section: TemplateSection,
  answers: Readonly<Record<string, unknown>> | undefined
): ValidationProblem[] {
  const problems: ValidationProblem[] = [];
  const fields = section.fields ?? [];
  const data = answers ?? {};

  for (const field of fields) {
    const value = data[field.key];

    if (isBlank(value)) {
      /*
       * ⚠️ A REQUIRED FIELD IN AN OPTIONAL SECTION IS STILL REQUIRED ONCE THE
       *   SECTION HAS ANY ANSWER AT ALL. An untouched optional section is
       *   skipped entirely (see below); one the clinician started is finished.
       */
      if (field.required) {
        problems.push({
          sectionKey: section.key,
          fieldKey: field.key,
          problem: `"${field.label}" is required`,
        });
      }
      continue;
    }

    const problem =
      shapeProblem(field, value) ?? optionProblem(field, value) ?? rangeProblem(field, value);
    if (problem !== null) {
      problems.push({
        sectionKey: section.key,
        fieldKey: field.key,
        problem: `"${field.label}" ${problem}`,
      });
    }
  }

  const declared = new Set(fields.map((field) => field.key));
  for (const key of Object.keys(data)) {
    if (!declared.has(key)) {
      problems.push({
        sectionKey: section.key,
        fieldKey: key,
        problem: `"${key}" is not a field of this section`,
      });
    }
  }

  return problems;
}

/**
 * Every problem with a consultation about to be signed.
 *
 * ⚠️ IT RETURNS ALL OF THEM, NOT THE FIRST. A doctor sent back to the form three
 *   times for three missing fields learns to distrust the button; one list of
 *   three is one trip.
 *
 * ⚠️ AN UNTOUCHED, NOT-REQUIRED SECTION IS SKIPPED ENTIRELY. A template that
 *   offers a dental history to a clinic that never fills one in must not make
 *   every consultation unsignable — `section.required` is how a clinic says
 *   otherwise, and it is checked here.
 */
export function encounterProblems(
  definition: TemplateDefinition,
  answers: readonly SectionAnswers[]
): readonly ValidationProblem[] {
  const byKey = new Map(answers.map((entry) => [entry.key, entry.data]));
  const problems: ValidationProblem[] = [];

  for (const section of definition.sections) {
    if (!section.visible) continue;
    /*
     * Only the descriptor-driven sections answer into `encounter_sections`; the
     * first-class ones have their own tables (CE-4) and are validated by the
     * services that own them. The registry is what knows the difference — a
     * template cannot claim otherwise.
     */
    if (!capabilityOf(section.type).descriptorDriven) continue;

    const data = byKey.get(section.key);
    const untouched = data === undefined || Object.keys(data).length === 0;
    if (untouched && !section.required) continue;
    if (untouched) {
      problems.push({
        sectionKey: section.key,
        fieldKey: null,
        problem: `"${section.label}" has not been filled in`,
      });
      continue;
    }

    problems.push(...validateSection(section, data));
  }

  /*
   * ⚠️ AN ANSWER FOR A SECTION THE TEMPLATE DOES NOT DECLARE IS REFUSED for the
   *   reason an undeclared FIELD is: it renders nowhere and prints nowhere, and
   *   the only moment anybody can act on it is now.
   */
  const declaredSections = new Set(definition.sections.map((section) => section.key));
  for (const entry of answers) {
    if (!declaredSections.has(entry.key)) {
      problems.push({
        sectionKey: entry.key,
        fieldKey: null,
        problem: `"${entry.key}" is not a section of this consultation`,
      });
    }
  }

  return problems;
}

// ---------------------------------------------------------------------------
// The shape of a stored document, independent of any descriptor (CE-8)
// ---------------------------------------------------------------------------

/**
 * ⚠️ THE LIMITS THE DESCRIPTORS CANNOT ENFORCE, BECAUSE THEY RUN BEFORE ANY
 *   DESCRIPTOR IS CONSULTED.
 *
 *   `encounter_sections.data` is `Record<string, unknown>` on the wire — and it
 *   has to be, because narrowing it in Zod would refuse a legal answer for a
 *   field type added later, at the API, with a patient in the chair (see the
 *   contract). What that leaves is an unbounded JSONB write behind an autosave
 *   that fires every few seconds: a megabyte of nesting per keystroke, in the
 *   densest PHI table in the product, accepted without a word.
 *
 *   ⚠️ SO THE AUTOSAVE CHECKS THE SHAPE AND FINALIZATION CHECKS THE MEANING.
 *     A draft is allowed to be incomplete; it is not allowed to be a document no
 *     renderer could ever draw. These bounds are deliberately far above any real
 *     consultation — a history section with two hundred answers is not a form
 *     somebody filled in.
 */
const MAX_FIELDS_PER_SECTION = 200;
const MAX_KEY_LENGTH = 64;
const MAX_TEXT_LENGTH = 20_000;
const MAX_LIST_ENTRIES = 200;
const MAX_DOCUMENT_BYTES = 64 * 1024;

/**
 * ⚠️ THE SAME NUMBERS ON BOTH SIDES OF THE DOOR, AND `descriptors.ts` IS THE
 *   SIDE THAT MATTERS MORE.
 *
 *   A template declaring 250 fields, or a checkbox group with 300 options, used
 *   to publish cleanly and then fail HERE — at the autosave, with a patient in
 *   the chair, in front of a doctor who did not write the template and cannot
 *   fix it. The template author is the person who can, and publishing is the
 *   moment they are present. So the bounds are enforced at BOTH ends and stated
 *   once.
 *
 *   ⚠️ `documentBytes` IS DELIBERATELY NOT MIRRORED AT PUBLISH TIME. The
 *     worst-case size of a template is the sum of every field's ceiling, and
 *     four TEXT fields that nobody bounded already exceed 64 KB on paper while
 *     being an entirely ordinary form. Refusing that would refuse every real
 *     template to catch a hypothetical one, so the byte ceiling stays where the
 *     actual bytes are.
 */
export const DOCUMENT_LIMITS = {
  fieldsPerSection: MAX_FIELDS_PER_SECTION,
  keyLength: MAX_KEY_LENGTH,
  textLength: MAX_TEXT_LENGTH,
  listEntries: MAX_LIST_ENTRIES,
  documentBytes: MAX_DOCUMENT_BYTES,
} as const;
/** How many problems one document reports before it stops counting. See below. */
const MAX_REPORTED_PROBLEMS = 20;

/**
 * ⚠️ SCALARS AND LISTS OF SCALARS, AND NOTHING ELSE. Every field type in the
 *   grammar answers with a string, a number, a boolean or a list of strings —
 *   there is no descriptor that produces a nested object, so one arriving means
 *   either a caller that is not the consultation screen or a shape no
 *   `FieldRenderer` branch can render. Refusing it here keeps the one thing
 *   `validateEncounter` assumes about a stored document true.
 */
function valueProblem(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'boolean') return null;
  if (typeof value === 'number') {
    return Number.isFinite(value) ? null : 'is not a finite number';
  }
  if (typeof value === 'string') {
    return value.length > MAX_TEXT_LENGTH
      ? `is longer than ${String(MAX_TEXT_LENGTH)} characters`
      : null;
  }
  if (Array.isArray(value)) {
    if (value.length > MAX_LIST_ENTRIES) {
      return `has more than ${String(MAX_LIST_ENTRIES)} entries`;
    }
    for (const entry of value) {
      if (typeof entry === 'string') {
        if (entry.length > MAX_TEXT_LENGTH) {
          return `has an entry longer than ${String(MAX_TEXT_LENGTH)} characters`;
        }
        continue;
      }
      if (typeof entry === 'number' && Number.isFinite(entry)) continue;
      if (typeof entry === 'boolean') continue;
      return 'is a list of something no field can hold';
    }
    return null;
  }
  return 'is not an answer any field can hold';
}

/**
 * Everything structurally wrong with one section's document.
 *
 * ⚠️ CHECKED AT AUTOSAVE, NOT ONLY AT FINALIZATION, and that is the opposite of
 *   the rule the rest of this file follows — deliberately. The descriptor checks
 *   wait for the signature because interrupting a half-typed examination is
 *   worse than the incompleteness. These do not, because what they refuse is not
 *   an incomplete answer: it is a write that would put a document in the table
 *   that nothing can render and nobody can correct afterwards.
 */
export function documentProblems(
  sectionKey: string,
  data: Readonly<Record<string, unknown>>
): readonly ValidationProblem[] {
  const problems: ValidationProblem[] = [];
  const keys = Object.keys(data);

  if (keys.length > MAX_FIELDS_PER_SECTION) {
    problems.push({
      sectionKey,
      fieldKey: null,
      problem: `"${sectionKey}" has more than ${String(MAX_FIELDS_PER_SECTION)} answers in it`,
    });
  }

  for (const key of keys) {
    /*
     * ⚠️ THE LIST OF PROBLEMS IS BOUNDED, AND THE REASON IS THE FUNCTION'S OWN.
     *   `encounterProblems` reports every problem at once because a doctor sent
     *   back three times for three fields learns to distrust the button — and it
     *   can, because the fields it walks come from a template the grammar has
     *   already bounded. THIS walks a document from the wire. A megabyte of
     *   one-character keys is a hundred thousand problems, which the caller
     *   joins into one sentence, puts in a 400 body AND logs at error level: a
     *   validator turned into an amplifier. Twenty is more than anybody reads.
     */
    if (problems.length >= MAX_REPORTED_PROBLEMS) {
      problems.push({
        sectionKey,
        fieldKey: null,
        problem: `"${sectionKey}" has more wrong with it than can be listed`,
      });
      return problems;
    }

    if (key.length > MAX_KEY_LENGTH) {
      problems.push({
        sectionKey,
        fieldKey: key,
        problem: `a field name longer than ${String(MAX_KEY_LENGTH)} characters is not a field`,
      });
      continue;
    }
    const problem = valueProblem(data[key]);
    if (problem !== null) {
      problems.push({ sectionKey, fieldKey: key, problem: `"${key}" ${problem}` });
    }
  }

  /*
   * ⚠️ THE BYTE CEILING IS LAST AND IS MEASURED ON THE SERIALISED DOCUMENT,
   *   because two hundred legal answers of twenty thousand characters each is
   *   every per-value bound satisfied and four megabytes written.
   */
  if (problems.length === 0) {
    /* `TextEncoder` rather than `Buffer` — this package runs in the browser too. */
    const size = new TextEncoder().encode(JSON.stringify(data)).length;
    if (size > MAX_DOCUMENT_BYTES) {
      problems.push({
        sectionKey,
        fieldKey: null,
        problem: `"${sectionKey}" is larger than ${String(MAX_DOCUMENT_BYTES / 1024)} KB`,
      });
    }
  }

  return problems;
}

/**
 * The FIRST-CLASS sections a template says a consultation cannot be signed
 * without (CE-4).
 *
 * ⚠️ THE COUNTERPART TO `encounterProblems`, AND THE SPLIT IS THE ARCHITECTURE.
 *   That function checks the sections whose answers live in a DOCUMENT and can
 *   therefore be checked against descriptors here, with no database. A
 *   diagnosis, a prescription and an order live in their own TABLES — this
 *   package holds no Prisma client and never will (CD-10), so it cannot count
 *   them.
 *
 *   So the engine answers the half it owns — WHICH sections a clinic said are
 *   required — and the service answers the half it owns: whether any rows
 *   exist. Neither half knows the rule the other enforces, and the rule itself
 *   is stated in exactly one place: the template.
 *
 * ⚠️ CHIEF_COMPLAINT AND CLINICAL_NOTES ARE FIRST-CLASS AND ARE NOT IN HERE.
 *   They are columns on `encounters` rather than lists, so "has it any rows" is
 *   the wrong question — the encounter service checks them directly against the
 *   columns it already has in hand.
 */
export function requiredContentSections(
  definition: TemplateDefinition
): readonly TemplateSection[] {
  return definition.sections.filter(
    (section) => section.visible && section.required && !capabilityOf(section.type).descriptorDriven
  );
}

/**
 * The same check as one sentence, in the `Parsed` shape the rest of the package
 * speaks.
 *
 * ⚠️ ONE IMPLEMENTATION, TWO SHAPES. The route turns this sentence into a 400;
 *   a screen that marks the offending fields red reads `encounterProblems`
 *   instead. Writing the rule twice is how the two answers start to disagree.
 */
export function validateEncounter(
  definition: TemplateDefinition,
  answers: readonly SectionAnswers[]
): Parsed<true> {
  const problems = encounterProblems(definition, answers);
  if (problems.length === 0) return { ok: true, value: true };
  return { ok: false, problem: problems.map((entry) => entry.problem).join('; ') };
}
