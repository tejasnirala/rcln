/**
 * The answer side of the grammar: what a consultation must satisfy to be signed.
 *
 * ⚠️ THE TWO SHAPES OF "NOTHING" ARE BOTH COVERED HERE, and covering only the
 *   first is the gap PI-5 shipped: a section that is ABSENT and a section that
 *   EXISTS but is empty must both fail a required check. A validator that only
 *   looked for the missing key would pass `{}` and let an unfilled examination
 *   be signed.
 */
import { encounterProblems, requiredContentSections, validateEncounter } from '../src/index.js';
import type { FieldDescriptor, TemplateDefinition } from '../src/index.js';

type Section = TemplateDefinition['sections'][number];

const examination = (
  fields: readonly FieldDescriptor[],
  over: Partial<Section> = {}
): TemplateDefinition => ({
  schemaVersion: 1,
  scopes: [],
  sections: [
    {
      type: 'EXAMINATION',
      key: 'examination',
      label: 'Examination',
      order: 40,
      visible: true,
      required: true,
      fields,
      ...over,
    },
  ],
});

const textField = {
  key: 'finding',
  type: 'TEXT' as const,
  label: 'Finding',
  required: true,
};

describe('a required field', () => {
  it('passes when it is answered', () => {
    const result = validateEncounter(examination([textField]), [
      { key: 'examination', data: { finding: 'Caries on 36' } },
    ]);
    expect(result.ok).toBe(true);
  });

  it('fails when the whole section is ABSENT', () => {
    const result = validateEncounter(examination([textField]), []);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.problem).toMatch(/has not been filled in/i);
  });

  /** ⚠️ The second shape of nothing — present, and empty. */
  it('fails when the section EXISTS but is empty', () => {
    const result = validateEncounter(examination([textField]), [{ key: 'examination', data: {} }]);
    expect(result.ok).toBe(false);
  });

  it('fails when the answer is whitespace', () => {
    const result = validateEncounter(examination([textField]), [
      { key: 'examination', data: { finding: '   ' } },
    ]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.problem).toMatch(/required/i);
  });

  it('fails when a list answer is empty', () => {
    const result = validateEncounter(
      examination([
        { ...textField, type: 'CHECKBOX_GROUP', options: [{ value: 'a', label: 'A' }] },
      ]),
      [{ key: 'examination', data: { finding: [] } }]
    );
    expect(result.ok).toBe(false);
  });
});

describe('an optional section', () => {
  const optional = examination([{ ...textField, required: false }], { required: false });

  /**
   * ⚠️ AN UNTOUCHED OPTIONAL SECTION MUST NOT MAKE A CONSULTATION UNSIGNABLE. A
   *   template that offers a dental history to a clinic that never fills one in
   *   would otherwise block every consultation in the building.
   */
  it('is skipped entirely when nobody touched it', () => {
    expect(validateEncounter(optional, []).ok).toBe(true);
  });

  it('still checks its required fields once it has been started', () => {
    const definition = examination(
      [textField, { key: 'note', type: 'TEXT', label: 'Note', required: false }],
      {
        required: false,
      }
    );
    const result = validateEncounter(definition, [
      { key: 'examination', data: { note: 'started' } },
    ]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.problem).toMatch(/"Finding" is required/);
  });
});

describe('the shape of an answer', () => {
  it('refuses text where a number belongs', () => {
    const result = validateEncounter(
      examination([
        { key: 'depth', type: 'MEASUREMENT', label: 'Pocket depth', required: true, unit: 'mm' },
      ]),
      [{ key: 'examination', data: { depth: 'deep' } }]
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.problem).toMatch(/is not a number/);
  });

  it('refuses a choice the descriptor does not offer', () => {
    const result = validateEncounter(
      examination([
        {
          key: 'grade',
          type: 'SELECT',
          label: 'Grade',
          required: true,
          options: [
            { value: 'I', label: 'I' },
            { value: 'II', label: 'II' },
          ],
        },
      ]),
      [{ key: 'examination', data: { grade: 'IV' } }]
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.problem).toMatch(/not one of its choices/);
  });

  it('enforces the advisory bounds', () => {
    const definition = examination([
      { key: 'depth', type: 'NUMBER', label: 'Depth', required: true, min: 0, max: 15 },
    ]);
    expect(validateEncounter(definition, [{ key: 'examination', data: { depth: 9 } }]).ok).toBe(
      true
    );
    expect(validateEncounter(definition, [{ key: 'examination', data: { depth: 40 } }]).ok).toBe(
      false
    );
  });
});

/**
 * ⚠️ A STRAY ANSWER IS AN ERROR, NOT SOMETHING TO IGNORE. It was typed into a
 *   field that has since been renamed: it renders nowhere, prints nowhere, and
 *   the only moment anybody is present to fix it is now.
 */
describe('answers nothing declares', () => {
  it('refuses a field the section does not have', () => {
    const result = validateEncounter(examination([textField]), [
      { key: 'examination', data: { finding: 'ok', mystery: 'x' } },
    ]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.problem).toMatch(/not a field of this section/);
  });

  it('refuses a section the template does not have', () => {
    const result = validateEncounter(examination([textField]), [
      { key: 'examination', data: { finding: 'ok' } },
      { key: 'ghost', data: { anything: 1 } },
    ]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.problem).toMatch(/not a section of this consultation/);
  });
});

describe('what is checked, and what is somebody else’s job', () => {
  /**
   * ⚠️ FIRST-CLASS SECTIONS ARE NOT VALIDATED HERE. A diagnosis and a
   *   prescription have their own tables and their own services (CE-4); this
   *   function knows only the descriptor-driven ones, and the registry is what
   *   tells them apart.
   */
  it('ignores a first-class section, however required it claims to be', () => {
    const definition: TemplateDefinition = {
      schemaVersion: 1,
      scopes: [],
      sections: [
        {
          type: 'PRESCRIPTION',
          key: 'prescription',
          label: 'Prescription',
          order: 80,
          visible: true,
          required: true,
        },
      ],
    };
    expect(validateEncounter(definition, []).ok).toBe(true);
  });

  it('ignores an invisible section', () => {
    const definition = examination([textField], { visible: false });
    expect(validateEncounter(definition, []).ok).toBe(true);
  });

  /**
   * ⚠️ ALL THE PROBLEMS, NOT THE FIRST. A doctor sent back three times for three
   *   missing fields learns to distrust the button.
   */
  it('reports every problem at once', () => {
    const definition = examination([
      textField,
      { key: 'grade', type: 'TEXT', label: 'Grade', required: true },
    ]);
    const problems = encounterProblems(definition, [{ key: 'examination', data: { other: 1 } }]);
    expect(problems).toHaveLength(3);
    expect(problems.map((p) => p.fieldKey)).toEqual(['finding', 'grade', 'other']);
  });
});

/**
 * The half of finalization the engine owns (CE-4).
 *
 * ⚠️ THE SPLIT IS THE ARCHITECTURE, NOT AN OMISSION. `encounterProblems` checks
 *   sections whose answers live in a DOCUMENT, which it can do with no
 *   database. A diagnosis, a prescription and an order live in their own
 *   TABLES — this package holds no Prisma client and never will (CD-10), so it
 *   answers WHICH sections a clinic marked required and the service answers
 *   whether any rows exist. The rule itself is stated in exactly one place: the
 *   template.
 */
describe('requiredContentSections', () => {
  const withSections = (sections: Section[]): TemplateDefinition => ({
    schemaVersion: 1,
    scopes: [],
    sections,
  });

  const section = (over: Partial<Section> & Pick<Section, 'type' | 'key'>): Section => ({
    label: over.key,
    order: 10,
    visible: true,
    required: true,
    ...over,
  });

  it('names the required first-class sections', () => {
    const definition = withSections([
      section({ type: 'DIAGNOSIS', key: 'diagnosis' }),
      section({ type: 'PRESCRIPTION', key: 'prescription' }),
    ]);
    expect(requiredContentSections(definition).map((s) => s.key)).toEqual([
      'diagnosis',
      'prescription',
    ]);
  });

  /**
   * ⚠️ DESCRIPTOR-DRIVEN SECTIONS ARE `encounterProblems`' BUSINESS AND MUST NOT
   *   BE COUNTED TWICE. A required EXAMINATION appearing in both lists would
   *   report the same missing section as two problems in one sentence.
   */
  it('leaves the descriptor-driven sections to encounterProblems', () => {
    const definition = withSections([
      section({ type: 'EXAMINATION', key: 'examination', fields: [textField] }),
      section({ type: 'HISTORY', key: 'history', fields: [textField] }),
      section({ type: 'DIAGNOSIS', key: 'diagnosis' }),
    ]);
    expect(requiredContentSections(definition).map((s) => s.key)).toEqual(['diagnosis']);
  });

  /** A section a clinic switched off cannot make a consultation unsignable. */
  it('ignores an invisible section and an optional one', () => {
    const definition = withSections([
      section({ type: 'DIAGNOSIS', key: 'diagnosis', visible: false }),
      section({ type: 'ADVICE', key: 'advice', required: false }),
    ]);
    expect(requiredContentSections(definition)).toHaveLength(0);
  });
});
