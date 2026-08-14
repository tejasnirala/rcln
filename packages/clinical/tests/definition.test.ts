/**
 * The whole definition document.
 *
 * ⚠️ THE REGISTRY IS THE AUTHORITY AND THE TEMPLATE IS NOT, AND THAT IS WHAT
 *   THESE CASES PIN. A template cannot give Prescription a set of fields, cannot
 *   leave History without any, cannot ask for a map on a section that draws
 *   none, and cannot say Diagnosis twice. Every one of those documents
 *   typechecks, reads sensibly and would render something plausible and wrong.
 */
import {
  mapCodesOf,
  parseTemplateDefinition,
  scopeCodesOf,
  visibleSections,
  type TemplateSection,
} from '../src/index.js';

const complaint = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  type: 'CHIEF_COMPLAINT',
  key: 'complaint',
  label: 'Chief complaint',
  order: 10,
  visible: true,
  required: true,
  ...over,
});

const history = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  type: 'HISTORY',
  key: 'dental_history',
  label: 'Dental history',
  order: 30,
  visible: true,
  required: false,
  fields: [{ key: 'brushing', type: 'TEXT', label: 'Brushing', required: false }],
  ...over,
});

const document = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  schemaVersion: 1,
  scopes: ['DENTISTRY'],
  sections: [complaint(), history()],
  ...over,
});

describe('a document that says nothing', () => {
  it('refuses an ABSENT definition', () => {
    expect(parseTemplateDefinition(undefined).ok).toBe(false);
    expect(parseTemplateDefinition(null).ok).toBe(false);
  });

  it('refuses an EMPTY definition', () => {
    /* ⚠️ Tested apart from the absent one. `{}` is an object, parses, looks
       configured, and renders a consultation with nothing on it. */
    const result = parseTemplateDefinition({});
    expect(result.ok).toBe(false);
  });

  it('refuses a definition whose "sections" exists but is empty', () => {
    const result = parseTemplateDefinition(document({ sections: [] }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.problem).toContain('no sections');
  });

  it('refuses a definition with no "scopes" rather than reading it as none', () => {
    const raw = document();
    delete raw['scopes'];
    const result = parseTemplateDefinition(raw);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.problem).toContain('scopes');
  });

  it('accepts an explicitly empty "scopes" — a template may scope nothing', () => {
    expect(parseTemplateDefinition(document({ scopes: [] })).ok).toBe(true);
  });

  it('refuses a document every section of which is hidden', () => {
    const result = parseTemplateDefinition(
      document({ sections: [complaint({ visible: false }), history({ visible: false })] })
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.problem).toContain('hidden');
  });

  it('refuses a schemaVersion the parser has not been written for', () => {
    expect(parseTemplateDefinition(document({ schemaVersion: 2 })).ok).toBe(false);
    const raw = document();
    delete raw['schemaVersion'];
    expect(parseTemplateDefinition(raw).ok).toBe(false);
  });
});

describe('a section that says nothing checkable', () => {
  it('refuses a section with no "visible"', () => {
    const raw = complaint();
    delete raw['visible'];
    const result = parseTemplateDefinition(document({ sections: [raw, history()] }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.problem).toContain('visible');
  });

  it('refuses a section with no "required"', () => {
    const raw = complaint();
    delete raw['required'];
    const result = parseTemplateDefinition(document({ sections: [raw, history()] }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.problem).toContain('required');
  });

  it('refuses a misspelled section key by name', () => {
    const result = parseTemplateDefinition(
      document({ sections: [complaint({ visibile: true }), history()] })
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.problem).toContain('visibile');
  });
});

describe('the registry decides what a section may say', () => {
  it('refuses a section type the engine has no component for', () => {
    const result = parseTemplateDefinition(
      document({ sections: [complaint({ type: 'GENOME_BROWSER' })] })
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.problem).toContain('component');
  });

  it('refuses a HISTORY section with no fields', () => {
    const raw = history();
    delete raw['fields'];
    const result = parseTemplateDefinition(document({ sections: [complaint(), raw] }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.problem).toContain('fields');
  });

  it('refuses fields on a PRESCRIPTION — it is not a generic dynamic form', () => {
    const result = parseTemplateDefinition(
      document({
        sections: [
          complaint(),
          {
            type: 'PRESCRIPTION',
            key: 'rx',
            label: 'Prescription',
            order: 80,
            visible: true,
            required: false,
            fields: [{ key: 'dose', type: 'TEXT', label: 'Dose', required: true }],
          },
        ],
      })
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.problem).toContain('fields');
  });

  it('refuses a VISUAL_MAPPING section with no map', () => {
    const result = parseTemplateDefinition(
      document({
        sections: [
          complaint(),
          {
            type: 'VISUAL_MAPPING',
            key: 'odontogram',
            label: 'Odontogram',
            order: 50,
            visible: true,
            required: false,
          },
        ],
      })
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.problem).toContain('mapCode');
  });

  it('refuses a map on a section that draws none', () => {
    const result = parseTemplateDefinition(
      document({ sections: [complaint({ mapCode: 'HUMAN_DENTAL' }), history()] })
    );
    expect(result.ok).toBe(false);
  });

  it('refuses two DIAGNOSIS sections — a consultation has one', () => {
    const diagnosis = (key: string): Record<string, unknown> => ({
      type: 'DIAGNOSIS',
      key,
      label: 'Diagnosis',
      order: 60,
      visible: true,
      required: false,
    });
    const result = parseTemplateDefinition(
      document({ sections: [complaint(), diagnosis('dx1'), diagnosis('dx2')] })
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.problem).toContain('DIAGNOSIS');
  });

  it('accepts two HISTORY sections — that is the per-specialty variation', () => {
    const result = parseTemplateDefinition(
      document({
        sections: [
          complaint(),
          history(),
          history({ key: 'family_history', label: 'Family history' }),
        ],
      })
    );
    expect(result.ok).toBe(true);
  });

  it('refuses two sections sharing a key, whatever their types', () => {
    const result = parseTemplateDefinition(
      document({ sections: [complaint(), history(), history({ label: 'Again' })] })
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.problem).toContain('dental_history');
  });

  it('refuses a scope on a section that draws on no vocabulary', () => {
    const result = parseTemplateDefinition(
      document({
        sections: [
          complaint(),
          {
            type: 'CLINICAL_NOTES',
            key: 'notes',
            label: 'Notes',
            order: 120,
            visible: true,
            required: false,
            scopes: ['DENTISTRY'],
          },
        ],
      })
    );
    expect(result.ok).toBe(false);
  });
});

describe('codes, never ids (CD-6)', () => {
  it('refuses a uuid where a scope code belongs', () => {
    const result = parseTemplateDefinition(
      document({ scopes: ['3f0d4bd6-6a3f-4a5b-9f27-2a9f6d1c9c11'] })
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.problem).toContain('code');
  });

  it('refuses a lowercase scope code', () => {
    expect(parseTemplateDefinition(document({ scopes: ['dentistry'] })).ok).toBe(false);
  });

  it('refuses the same scope twice', () => {
    expect(parseTemplateDefinition(document({ scopes: ['DENTISTRY', 'DENTISTRY'] })).ok).toBe(
      false
    );
  });

  it('collects every scope code, template-level and per-section, sorted and once', () => {
    const result = parseTemplateDefinition(
      document({
        scopes: ['DENTISTRY'],
        sections: [
          complaint(),
          {
            type: 'DIAGNOSIS',
            key: 'dx',
            label: 'Diagnosis',
            order: 60,
            visible: true,
            required: false,
            scopes: ['ORAL_MEDICINE', 'DENTISTRY'],
          },
        ],
      })
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(scopeCodesOf(result.value)).toEqual(['DENTISTRY', 'ORAL_MEDICINE']);
  });

  it('collects the map codes for CE-6 to resolve', () => {
    const result = parseTemplateDefinition(
      document({
        sections: [
          complaint(),
          {
            type: 'VISUAL_MAPPING',
            key: 'odontogram',
            label: 'Odontogram',
            order: 50,
            visible: true,
            required: false,
            mapCode: 'HUMAN_DENTAL',
          },
        ],
      })
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(mapCodesOf(result.value)).toEqual(['HUMAN_DENTAL']);
  });
});

describe('what actually renders', () => {
  it('drops hidden sections and orders the rest', () => {
    const result = parseTemplateDefinition(
      document({
        sections: [
          history({ order: 30 }),
          complaint({ order: 10 }),
          {
            type: 'ADVICE',
            key: 'advice',
            label: 'Advice',
            order: 100,
            visible: false,
            required: false,
          },
        ],
      })
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(visibleSections(result.value.sections).map((s) => s.key)).toEqual([
      'complaint',
      'dental_history',
    ]);
  });

  it('breaks an order tie by key, so two runs render the same screen', () => {
    const sections: TemplateSection[] = [
      { type: 'ADVICE', key: 'zeta', label: 'Z', order: 10, visible: true, required: false },
      {
        type: 'CLINICAL_NOTES',
        key: 'alpha',
        label: 'A',
        order: 10,
        visible: true,
        required: false,
      },
    ];
    expect(visibleSections(sections).map((s) => s.key)).toEqual(['alpha', 'zeta']);
  });

  it('falls back to the registry order and label when the section states neither', () => {
    const result = parseTemplateDefinition(
      document({
        sections: [
          { type: 'FOLLOW_UP', key: 'follow_up', visible: true, required: false },
          complaint(),
        ],
      })
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const [first, second] = visibleSections(result.value.sections);
    expect(first?.key).toBe('complaint');
    expect(second?.label).toBe('Follow-up');
  });
});
