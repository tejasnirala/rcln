/**
 * Field descriptors, tested for the failure this package exists to prevent.
 *
 * ⚠️ THE CASES THAT MATTER MOST ARE THE ONES WHERE THE DOCUMENT SAYS NOTHING. A
 *   permissive parser is invisible in every other test: the form renders, the
 *   fields appear, and the failure is a mandatory finding a clinician was never
 *   asked for. Those cases are first.
 *
 * ⚠️ AND BOTH SHAPES OF "NOTHING" ARE COVERED — THE KEY THAT IS ABSENT AND THE
 *   ONE THAT EXISTS BUT IS EMPTY. Covering only the first is exactly the gap
 *   that let PI-5 ship a permissive typo (CD-10).
 */
import { parseFieldDescriptor, parseFieldDescriptors } from '../src/index.js';

const WHERE = 'the field';

const text = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  key: 'notes',
  type: 'TEXT',
  label: 'Notes',
  required: false,
  ...over,
});

describe('a descriptor that says nothing checkable', () => {
  it('refuses a descriptor with no "required" rather than reading it as optional', () => {
    const withoutRequired = text();
    delete withoutRequired['required'];

    const result = parseFieldDescriptor(withoutRequired, WHERE);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.problem).toContain('"required"');
  });

  it('refuses the misspelled key by NAME instead of ignoring it', () => {
    const misspelled = text();
    delete misspelled['required'];
    misspelled['require'] = true;

    const result = parseFieldDescriptor(misspelled, WHERE);
    expect(result.ok).toBe(false);
    /* The typo is what the author must see. "required is missing" would send
       them looking at a key they believe they wrote. */
    if (!result.ok) expect(result.problem).toContain('require');
  });

  it('refuses "required" written as a string', () => {
    const result = parseFieldDescriptor(text({ required: 'yes' }), WHERE);
    expect(result.ok).toBe(false);
  });

  it('accepts an explicit false — stating it is the point, not avoiding it', () => {
    const result = parseFieldDescriptor(text({ required: false }), WHERE);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.required).toBe(false);
  });
});

describe('the essential key of each type', () => {
  it('refuses a SELECT whose "options" is ABSENT', () => {
    const result = parseFieldDescriptor(
      { key: 'severity', type: 'SELECT', label: 'Severity', required: true },
      WHERE
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.problem).toContain('options');
  });

  it('refuses a SELECT whose "options" EXISTS but is EMPTY', () => {
    /* ⚠️ The second half of the PI-5 gap. `[]` looks configured and renders a
       dropdown a clinician reads as a loading failure. */
    const result = parseFieldDescriptor(
      { key: 'severity', type: 'SELECT', label: 'Severity', required: true, options: [] },
      WHERE
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.problem).toContain('empty');
  });

  it('refuses a MEASUREMENT with no unit', () => {
    const result = parseFieldDescriptor(
      { key: 'probing_depth', type: 'MEASUREMENT', label: 'Probing depth', required: true },
      WHERE
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.problem).toContain('unit');
  });

  it('refuses a MEASUREMENT whose unit is an empty string', () => {
    const result = parseFieldDescriptor(
      {
        key: 'probing_depth',
        type: 'MEASUREMENT',
        label: 'Probing depth',
        required: true,
        unit: '   ',
      },
      WHERE
    );
    expect(result.ok).toBe(false);
  });

  it('refuses a CLINICAL_SELECTOR with no master kind', () => {
    const result = parseFieldDescriptor(
      { key: 'condition', type: 'CLINICAL_SELECTOR', label: 'Condition', required: false },
      WHERE
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.problem).toContain('masterKind');
  });

  it('refuses a master kind the vocabulary does not have', () => {
    const result = parseFieldDescriptor(
      {
        key: 'condition',
        type: 'CLINICAL_SELECTOR',
        label: 'Condition',
        required: false,
        masterKind: 'MEDICINE',
      },
      WHERE
    );
    expect(result.ok).toBe(false);
  });

  it('accepts a TEXT field with no extra keys — "no essential key" is a statement', () => {
    const result = parseFieldDescriptor(text(), WHERE);
    expect(result.ok).toBe(true);
  });
});

describe('what the renderer can actually draw', () => {
  it('refuses a field type the engine has no component for', () => {
    const result = parseFieldDescriptor(text({ type: 'ULTRASOUND_LOOP' }), WHERE);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.problem).toContain('render');
  });

  it('refuses a key with a dot in it — a key is a storage address', () => {
    const result = parseFieldDescriptor(text({ key: 'history.dental' }), WHERE);
    expect(result.ok).toBe(false);
  });

  it('refuses a key starting with a digit', () => {
    expect(parseFieldDescriptor(text({ key: '3_month' }), WHERE).ok).toBe(false);
  });

  it('refuses a key a template author would expect to work but the store cannot hold', () => {
    expect(parseFieldDescriptor(text({ key: 'Dental History' }), WHERE).ok).toBe(false);
  });

  it('refuses "options" on a MEASUREMENT — an unknown key is never ignored', () => {
    const result = parseFieldDescriptor(
      {
        key: 'depth',
        type: 'MEASUREMENT',
        label: 'Depth',
        required: true,
        unit: 'mm',
        options: [{ value: 'a', label: 'A' }],
      },
      WHERE
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.problem).toContain('options');
  });

  it('refuses a descriptor that is not an object at all', () => {
    expect(parseFieldDescriptor('required', WHERE).ok).toBe(false);
    expect(parseFieldDescriptor(null, WHERE).ok).toBe(false);
    expect(parseFieldDescriptor([], WHERE).ok).toBe(false);
  });
});

describe('options', () => {
  const select = (options: unknown): Record<string, unknown> => ({
    key: 'severity',
    type: 'SELECT',
    label: 'Severity',
    required: true,
    options,
  });

  it('refuses two options with the same value rather than deduplicating', () => {
    const result = parseFieldDescriptor(
      select([
        { value: 'MILD', label: 'Mild' },
        { value: 'MILD', label: 'Slight' },
      ]),
      WHERE
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.problem).toContain('MILD');
  });

  it('refuses an option with a label and no value', () => {
    expect(parseFieldDescriptor(select([{ label: 'Mild' }]), WHERE).ok).toBe(false);
  });

  it('refuses an unknown key inside an option', () => {
    const result = parseFieldDescriptor(
      select([{ value: 'MILD', label: 'Mild', default: true }]),
      WHERE
    );
    expect(result.ok).toBe(false);
  });

  it("keeps the author's order — options are not sorted", () => {
    const result = parseFieldDescriptor(
      select([
        { value: 'SEVERE', label: 'Severe' },
        { value: 'MILD', label: 'Mild' },
      ]),
      WHERE
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.options?.map((o) => o.value)).toEqual(['SEVERE', 'MILD']);
  });
});

describe('numeric bounds', () => {
  it('refuses a min greater than its max', () => {
    const result = parseFieldDescriptor(
      {
        key: 'depth',
        type: 'MEASUREMENT',
        label: 'Depth',
        required: true,
        unit: 'mm',
        min: 10,
        max: 5,
      },
      WHERE
    );
    expect(result.ok).toBe(false);
  });

  it('accepts a min equal to its max', () => {
    const result = parseFieldDescriptor(
      {
        key: 'depth',
        type: 'MEASUREMENT',
        label: 'Depth',
        required: true,
        unit: 'mm',
        min: 5,
        max: 5,
      },
      WHERE
    );
    expect(result.ok).toBe(true);
  });

  it('refuses a fractional precision', () => {
    const result = parseFieldDescriptor(
      {
        key: 'depth',
        type: 'MEASUREMENT',
        label: 'Depth',
        required: true,
        unit: 'mm',
        precision: 1.5,
      },
      WHERE
    );
    expect(result.ok).toBe(false);
  });
});

describe("a section's field list", () => {
  it('refuses an empty list — a section with no fields is a heading', () => {
    const result = parseFieldDescriptors([], 'section 1');
    expect(result.ok).toBe(false);
  });

  it('refuses two fields with the same key', () => {
    const result = parseFieldDescriptors([text(), text()], 'section 1');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.problem).toContain('notes');
  });

  it('names the position of the field that failed', () => {
    const result = parseFieldDescriptors(
      [text(), text({ key: 'other', type: 'NOPE' })],
      'section 1'
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.problem).toContain('field 2');
  });

  it('parses a well-formed list', () => {
    const result = parseFieldDescriptors(
      [text(), text({ key: 'onset', type: 'DATE', required: true })],
      'section 1'
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toHaveLength(2);
  });
});
