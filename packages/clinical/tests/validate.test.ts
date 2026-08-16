/**
 * The answer side of the grammar: what a consultation must satisfy to be signed.
 *
 * ⚠️ THE TWO SHAPES OF "NOTHING" ARE BOTH COVERED HERE, and covering only the
 *   first is the gap PI-5 shipped: a section that is ABSENT and a section that
 *   EXISTS but is empty must both fail a required check. A validator that only
 *   looked for the missing key would pass `{}` and let an unfilled examination
 *   be signed.
 */
import {
  documentProblems,
  encounterProblems,
  requiredContentSections,
  validateEncounter,
} from '../src/index.js';
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
 * Dates, and the two different things the word means (CE-8).
 *
 * ⚠️ BOTH USED TO PASS AS "TEXT", which is how `banana` and a wall clock with no
 *   zone were legal answers on a signed clinical record. A date that renders as
 *   something else on the printed record is not a formatting problem — it is the
 *   record saying something nobody wrote.
 */
describe('a date is a date', () => {
  const dateField = {
    key: 'onset_on',
    type: 'DATE' as const,
    label: 'Onset',
    required: true,
  };

  it('accepts a calendar date', () => {
    const result = validateEncounter(examination([dateField]), [
      { key: 'examination', data: { onset_on: '2026-08-16' } },
    ]);
    expect(result.ok).toBe(true);
  });

  it.each(['16/08/2026', 'yesterday', '2026-08-16T00:00:00Z', ''])('refuses %p', (value) => {
    const result = validateEncounter(examination([dateField]), [
      { key: 'examination', data: { onset_on: value } },
    ]);
    expect(result.ok).toBe(false);
  });

  /** ⚠️ THE REGEX ALONE WOULD TAKE THIS. February has no thirty-first. */
  it('refuses a day that does not exist', () => {
    const result = validateEncounter(examination([dateField]), [
      { key: 'examination', data: { onset_on: '2026-02-31' } },
    ]);
    expect(result.ok).toBe(false);
  });
});

/**
 * ⚠️ INVARIANT 6, INSIDE A JSONB DOCUMENT. A DATETIME answer is an INSTANT.
 *   `2026-08-16T14:30` is 14:30 in whichever zone whoever reads it next happens
 *   to be in, and it looks exactly like a time — which is why nothing downstream
 *   would ever notice it was five and a half hours out.
 */
describe('a date and time is an instant', () => {
  const stampField = {
    key: 'seen_at',
    type: 'DATETIME' as const,
    label: 'Seen at',
    required: true,
  };

  it.each(['2026-08-16T09:00:00.000Z', '2026-08-16T09:00:00Z', '2026-08-16T09:00Z'])(
    'accepts %p',
    (value) => {
      const result = validateEncounter(examination([stampField]), [
        { key: 'examination', data: { seen_at: value } },
      ]);
      expect(result.ok).toBe(true);
    }
  );

  it.each(['2026-08-16T14:30', '2026-08-16T14:30:00+05:30', '2026-08-16'])(
    'refuses %p, which names no moment',
    (value) => {
      const result = validateEncounter(examination([stampField]), [
        { key: 'examination', data: { seen_at: value } },
      ]);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.problem).toMatch(/UTC/);
    }
  );
});

/**
 * ⚠️ THE SAME CHOICE TWICE IS REFUSED RATHER THAN DEDUPLICATED. Collapsing it
 *   silently would be the software editing what a clinician wrote, after the
 *   fact, with nothing on screen saying so.
 */
describe('a list of choices', () => {
  const listField = {
    key: 'habits',
    type: 'CHECKBOX_GROUP' as const,
    label: 'Habits',
    required: false,
    options: [
      { value: 'SMOKING', label: 'Smoking' },
      { value: 'BRUXISM', label: 'Bruxism' },
    ],
  };

  it('takes each choice once', () => {
    const result = validateEncounter(examination([listField], { required: false }), [
      { key: 'examination', data: { habits: ['SMOKING', 'BRUXISM'] } },
    ]);
    expect(result.ok).toBe(true);
  });

  it('refuses the same choice twice', () => {
    const result = validateEncounter(examination([listField], { required: false }), [
      { key: 'examination', data: { habits: ['SMOKING', 'SMOKING'] } },
    ]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.problem).toMatch(/twice/);
  });
});

/**
 * The shape of the stored document, which is checked at AUTOSAVE rather than at
 * signing — the one place in this file where the rule runs early (CE-8).
 *
 * ⚠️ WHAT IT REFUSES IS NOT AN INCOMPLETE ANSWER. It is a write that would put a
 *   document in the densest PHI table in the product that no renderer could ever
 *   draw and nobody could correct afterwards.
 */
describe('the shape of a stored document', () => {
  it('takes the four shapes the field types actually produce', () => {
    const problems = documentProblems('examination', {
      finding: 'Caries on 36',
      depth: 4.5,
      tender: true,
      habits: ['SMOKING'],
      /* An unanswered field. Absence is what a draft is made of. */
      grade: null,
    });
    expect(problems).toEqual([]);
  });

  /**
   * ⚠️ THE BOUNDARY, NOT ONLY THE REFUSAL. Every case in this block is one over
   *   a limit, and a limit tested only from above is an off-by-one away from
   *   refusing a legal consultation — which is the failure nobody would report
   *   as a bug, because it looks like the rule working.
   */
  it('accepts a document sitting exactly on every limit', () => {
    const data: Record<string, unknown> = {};
    for (let index = 0; index < 200; index += 1) {
      data[`field_${String(index)}`] = index === 0 ? 'x'.repeat(300) : index;
    }
    data['k'.repeat(64)] = Array.from({ length: 200 }, (_, index) => String(index));

    /* 201 keys is over — drop one so the count is exactly at the limit. */
    delete data['field_199'];

    expect(Object.keys(data)).toHaveLength(200);
    expect(documentProblems('examination', data)).toEqual([]);
  });

  it('refuses a nested document, which no field can hold', () => {
    const problems = documentProblems('examination', { finding: { text: 'Caries' } });
    expect(problems).toHaveLength(1);
    expect(problems[0]?.problem).toMatch(/any field can hold/);
  });

  it('refuses a value longer than any clinical answer', () => {
    const problems = documentProblems('examination', { finding: 'x'.repeat(20_001) });
    expect(problems).toHaveLength(1);
    expect(problems[0]?.problem).toMatch(/longer than/);
  });

  it('refuses a list nobody ticked', () => {
    const problems = documentProblems('examination', {
      habits: Array.from({ length: 201 }, (_, index) => `H${String(index)}`),
    });
    expect(problems).toHaveLength(1);
    expect(problems[0]?.problem).toMatch(/more than 200 entries/);
  });

  /** ⚠️ EVERY PER-VALUE BOUND SATISFIED, AND MEGABYTES WRITTEN. */
  it('refuses a document that is only large in total', () => {
    const data: Record<string, unknown> = {};
    for (let index = 0; index < 100; index += 1) {
      data[`field_${String(index)}`] = 'x'.repeat(1000);
    }
    const problems = documentProblems('examination', data);
    expect(problems).toHaveLength(1);
    expect(problems[0]?.problem).toMatch(/larger than/);
  });

  /**
   * ⚠️ THE VALIDATOR MUST NOT BECOME THE AMPLIFIER. The caller joins these into
   *   one sentence, puts it in a 400 body and logs it — so a megabyte of
   *   one-character keys would otherwise produce a multi-megabyte error message
   *   for a request whose whole purpose was to be refused.
   */
  it('stops listing problems long before a hostile document runs out of them', () => {
    const data: Record<string, unknown> = {};
    for (let index = 0; index < 5_000; index += 1) {
      data[`k${String(index)}`] = { nested: true };
    }
    const problems = documentProblems('examination', data);

    expect(problems.length).toBeLessThanOrEqual(22);
    expect(problems.at(-1)?.problem).toMatch(/more wrong with it than can be listed/);
  });

  it('refuses a field name that is not a field name', () => {
    const problems = documentProblems('examination', { ['k'.repeat(65)]: 'x' });
    expect(problems).toHaveLength(1);
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
