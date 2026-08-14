/**
 * Parsing a whole `consultation_template_versions.definition`.
 *
 * ⚠️ NOTHING IN THE PRODUCT READS A RAW `definition` DOCUMENT. Not the service,
 *   not the route, not a component, not a report. Everything goes through this
 *   function, gets a `TemplateDefinition` or a sentence, and acts on nothing in
 *   between (CD-10). The moment one caller reaches into the JSONB directly, the
 *   guarantees in `descriptors.ts` stop being guarantees and become a
 *   convention.
 *
 * The document, in full:
 *
 *   {
 *     "schemaVersion": 1,
 *     "scopes": ["DENTISTRY"],
 *     "sections": [
 *       { "type": "CHIEF_COMPLAINT", "key": "complaint", "label": "…",
 *         "order": 10, "visible": true, "required": true },
 *       { "type": "HISTORY", "key": "dental_history", "label": "…",
 *         "order": 30, "visible": true, "required": false,
 *         "fields": [ … descriptors … ] },
 *       { "type": "VISUAL_MAPPING", "key": "odontogram", "label": "…",
 *         "order": 50, "visible": true, "required": false,
 *         "mapCode": "HUMAN_DENTAL" }
 *     ]
 *   }
 *
 * ⚠️ `scopes` AND `mapCode` ARE CODES. NEVER IDS (CD-6, ADR-0006). An id in a
 *   JSONB document is invisible to every foreign key, cascade and RLS policy in
 *   the database — and it belongs to one tenant, so a template carrying one
 *   cannot be a platform row and cannot be copied between clinics.
 */
import { parseFieldDescriptors } from './descriptors.js';
import { capabilityOf, isSectionType } from './registry.js';
import type { Parsed, TemplateDefinition, TemplateSection } from './types.js';

function fail<T>(problem: string): Parsed<T> {
  return { ok: false, problem };
}

const KEY_PATTERN = /^[a-z][a-z0-9_]*$/;
/** A taxonomy or map code, spelled the way every other code in this repo is. */
const CODE_PATTERN = /^[A-Z][A-Z0-9_]*$/;

function asRecord(value: unknown, what: string): Parsed<Record<string, unknown>> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return fail(`${what} is not an object`);
  }
  return { ok: true, value: value as Record<string, unknown> };
}

const SECTION_KEYS: readonly string[] = [
  'type',
  'key',
  'label',
  'order',
  'visible',
  'required',
  'fields',
  'scopes',
  'mapCode',
];

function readCodeList(raw: unknown, where: string, key: string): Parsed<readonly string[]> {
  if (!Array.isArray(raw)) return fail(`${where}'s "${key}" is not a list`);
  const codes: string[] = [];
  for (const [index, entry] of raw.entries()) {
    if (typeof entry !== 'string' || !CODE_PATTERN.test(entry)) {
      return fail(
        `${where}'s "${key}" entry ${index + 1} is not a code — uppercase letters, digits and underscores`
      );
    }
    /*
     * ⚠️ AND IT IS A CODE, WHICH MEANS IT IS NOT A UUID. This is the check that
     *   catches the mistake CD-6 exists to prevent: somebody pastes a
     *   `specialty_id` in here because it was to hand, the resolver finds no
     *   node with that code, and the section quietly ranks nothing.
     */
    if (codes.includes(entry)) return fail(`${where}'s "${key}" names "${entry}" twice`);
    codes.push(entry);
  }
  return { ok: true, value: codes };
}

function parseSection(input: unknown, index: number): Parsed<TemplateSection> {
  const where = `section ${index + 1}`;
  const record = asRecord(input, where);
  if (!record.ok) return fail(record.problem);
  const source = record.value;

  const rawType = source['type'];
  if (!isSectionType(rawType)) {
    /*
     * ⚠️ AN UNKNOWN SECTION TYPE IS AN ERROR, NOT A BLANK (ARCHITECTURE.md). The
     *   registry has exactly one component per member of a closed set. Skipping
     *   a section the engine does not know renders a consultation that LOOKS
     *   complete and is missing whatever the clinic thought it had configured.
     */
    return fail(`${where}'s "type" is not a section this engine has a component for`);
  }
  const capability = capabilityOf(rawType);

  const rawKey = source['key'];
  if (typeof rawKey !== 'string' || !KEY_PATTERN.test(rawKey)) {
    return fail(
      `${where}'s "key" is missing or malformed — lowercase letters, digits and underscores, starting with a letter`
    );
  }

  const rawLabel = source['label'];
  if (rawLabel !== undefined && (typeof rawLabel !== 'string' || rawLabel.trim() === '')) {
    return fail(`${where}'s "label" is empty`);
  }
  const label = typeof rawLabel === 'string' ? rawLabel.trim() : capability.defaultLabel;
  if (label.length > 160) return fail(`${where}'s "label" is longer than 160 characters`);

  const rawOrder = source['order'];
  if (rawOrder !== undefined && (typeof rawOrder !== 'number' || !Number.isInteger(rawOrder))) {
    return fail(`${where}'s "order" is not a whole number`);
  }
  const order = typeof rawOrder === 'number' ? rawOrder : capability.defaultOrder;

  /*
   * ⚠️ `visible` AND `required` ARE MANDATORY, FOR THE REASON `required` IS
   *   MANDATORY ON EVERY FIELD DESCRIPTOR. "Not stated means shown" and "not
   *   stated means optional" are both readings that turn a typo into a
   *   configuration nobody chose — and a section is a bigger unit to lose than a
   *   field. State both, or the document is refused.
   */
  const rawVisible = source['visible'];
  if (typeof rawVisible !== 'boolean') {
    return fail(
      `${where} does not say "visible" as true or false. State it explicitly — an omission is not read as visible.`
    );
  }
  const rawRequired = source['required'];
  if (typeof rawRequired !== 'boolean') {
    return fail(
      `${where} does not say "required" as true or false. State it explicitly — an omission is not read as optional.`
    );
  }

  for (const present of Object.keys(source)) {
    if (!SECTION_KEYS.includes(present)) {
      return fail(`${where} carries an unknown key "${present}". Check the spelling.`);
    }
  }

  const section: { -readonly [K in keyof TemplateSection]: TemplateSection[K] } = {
    type: rawType,
    key: rawKey,
    label,
    order,
    visible: rawVisible,
    required: rawRequired,
  };

  /*
   * ── THE REGISTRY DECIDES, THE TEMPLATE DOES NOT ──────────────────────────
   *
   * A descriptor-driven section MUST carry fields and a first-class one MUST
   * NOT. The second half is the one worth stating: a template that gives
   * Prescription a set of fields is describing a component that never reads
   * them, so the fields exist, validate, review well and render nowhere — §11.
   */
  if (capability.descriptorDriven) {
    if (source['fields'] === undefined) {
      return fail(`${where} is a ${rawType} section and carries no "fields"`);
    }
    const fields = parseFieldDescriptors(source['fields'], where);
    if (!fields.ok) return fail(fields.problem);
    section.fields = fields.value;
  } else if (source['fields'] !== undefined) {
    return fail(
      `${where} is a ${rawType} section, which has its own component and its own table — it cannot carry "fields"`
    );
  }

  if (capability.requiresMap) {
    const rawMap = source['mapCode'];
    if (typeof rawMap !== 'string' || !CODE_PATTERN.test(rawMap)) {
      return fail(`${where} is a ${rawType} section and does not name a "mapCode"`);
    }
    section.mapCode = rawMap;
  } else if (source['mapCode'] !== undefined) {
    return fail(`${where} is a ${rawType} section and does not draw a map`);
  }

  if (source['scopes'] !== undefined) {
    /*
     * ⚠️ A SCOPE ON A SECTION WITH NO VOCABULARY IS REFUSED, NOT IGNORED.
     *   Scoping Clinical Notes is somebody expecting a ranking that will never
     *   happen, and the screen gives them no way to tell.
     */
    if (capability.vocabulary === null && rawType !== 'PRESCRIPTION') {
      return fail(`${where} is a ${rawType} section and draws on no clinical vocabulary to scope`);
    }
    const scopes = readCodeList(source['scopes'], where, 'scopes');
    if (!scopes.ok) return fail(scopes.problem);
    section.scopes = scopes.value;
  }

  return { ok: true, value: section };
}

/**
 * Parse and validate a whole definition document.
 *
 * ⚠️ REFUSES THE EMPTY DOCUMENT AS WELL AS THE ABSENT ONE, and the two are
 *   tested separately. Covering only "no definition" is precisely the gap that
 *   let PI-5 ship a permissive typo: `{}` and `{"sections": []}` both parse as
 *   objects, both look configured, and both render a consultation with nothing
 *   on it that a doctor reads as a loading failure.
 */
export function parseTemplateDefinition(input: unknown): Parsed<TemplateDefinition> {
  const record = asRecord(input, 'the template definition');
  if (!record.ok) return fail(record.problem);
  const source = record.value;

  for (const present of Object.keys(source)) {
    if (present !== 'schemaVersion' && present !== 'scopes' && present !== 'sections') {
      return fail(`the template definition carries an unknown key "${present}"`);
    }
  }

  /*
   * ⚠️ `schemaVersion` IS THE DOCUMENT'S SHAPE, NOT THE ROW'S `version` COLUMN.
   *   A clinic on v7 of its dentistry template has seven `schemaVersion: 1`
   *   documents. Conflating them means the day the document shape changes,
   *   every historical version claims to be the new shape — and a finalized
   *   consultation's frozen snapshot (§29) is exactly what must not.
   */
  if (source['schemaVersion'] !== 1) {
    return fail('the template definition does not say "schemaVersion": 1');
  }

  if (source['scopes'] === undefined) {
    return fail(
      'the template definition does not say "scopes". State it explicitly, as [] if the template scopes nothing — a scope ranks the vocabulary and never filters it.'
    );
  }
  const scopes = readCodeList(source['scopes'], 'the template definition', 'scopes');
  if (!scopes.ok) return fail(scopes.problem);

  const rawSections = source['sections'];
  if (!Array.isArray(rawSections)) return fail('the template definition has no "sections" list');
  if (rawSections.length === 0) {
    return fail('the template definition has no sections — a consultation with none renders empty');
  }

  const sections: TemplateSection[] = [];
  const keys = new Set<string>();
  const typeCounts = new Map<string, number>();

  for (const [index, entry] of rawSections.entries()) {
    const parsed = parseSection(entry, index);
    if (!parsed.ok) return fail(parsed.problem);

    /*
     * ⚠️ TWO SECTIONS SHARING A KEY WRITE TO THE SAME `encounter_sections` ROW.
     *   The key is that table's business key, so the second save overwrites the
     *   first — and it is a UNIQUE violation at best and silent data loss at
     *   worst, depending on which order the engine happens to save in.
     */
    if (keys.has(parsed.value.key)) {
      return fail(`two sections share the key "${parsed.value.key}"`);
    }
    keys.add(parsed.value.key);

    const count = (typeCounts.get(parsed.value.type) ?? 0) + 1;
    typeCounts.set(parsed.value.type, count);
    if (count > 1 && !capabilityOf(parsed.value.type).repeatable) {
      return fail(
        `the template has two ${parsed.value.type} sections, and a consultation may only have one`
      );
    }

    sections.push(parsed.value);
  }

  /*
   * ⚠️ A TEMPLATE WITH NOTHING VISIBLE IS REFUSED. Every section switched off is
   *   a document that validates, publishes, resolves and renders a blank
   *   consultation — the failure mode with no error message that this whole
   *   package exists to make impossible.
   */
  if (!sections.some((section) => section.visible)) {
    return fail('every section in the template is hidden, so the consultation would render empty');
  }

  return { ok: true, value: { schemaVersion: 1, scopes: scopes.value, sections } };
}

/**
 * Every scope code the definition names, template-level and per-section, once.
 *
 * This is what the resolver turns into taxonomy ids for the selectors. Returned
 * sorted so two runs over the same document produce the same list — a resolved
 * configuration is cached and compared, and an unstable order looks like a
 * change that did not happen.
 */
export function scopeCodesOf(definition: TemplateDefinition): readonly string[] {
  const codes = new Set<string>(definition.scopes);
  for (const section of definition.sections) {
    for (const code of section.scopes ?? []) codes.add(code);
  }
  return [...codes].sort();
}

/** Every visual-map code the definition names, once. Resolved to rows in CE-6. */
export function mapCodesOf(definition: TemplateDefinition): readonly string[] {
  const codes = new Set<string>();
  for (const section of definition.sections) {
    if (section.mapCode !== undefined) codes.add(section.mapCode);
  }
  return [...codes].sort();
}
