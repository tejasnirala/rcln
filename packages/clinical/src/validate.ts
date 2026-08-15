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
function shapeProblem(field: FieldDescriptor, value: unknown): string | null {
  switch (field.type) {
    case 'TEXT':
    case 'TEXTAREA':
    case 'DATE':
    case 'DATETIME':
    case 'SEARCH_SELECT':
    case 'CLINICAL_SELECTOR':
    case 'SELECT':
    case 'RADIO_GROUP':
      return typeof value === 'string' ? null : 'is not text';
    case 'NUMBER':
    case 'MEASUREMENT':
      return typeof value === 'number' && Number.isFinite(value) ? null : 'is not a number';
    case 'BOOLEAN':
      return typeof value === 'boolean' ? null : 'is not true or false';
    case 'MULTI_SELECT':
    case 'CHECKBOX_GROUP':
      return Array.isArray(value) && value.every((entry) => typeof entry === 'string')
        ? null
        : 'is not a list of choices';
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
