/**
 * Template resolution — the specificity walk.
 *
 * ⚠️ THE CASE THAT MATTERS MOST IS THE ONE WHERE THE CLINIC'S OWN TEMPLATE LOSES
 *   SILENTLY. A platform template and a clinic's own sit at the same node; if
 *   the tie-break is missing, whichever the query returned first applies, and
 *   the clinic sees a perfectly reasonable consultation that is not the one it
 *   configured. There is no error, and nothing on the screen to notice.
 */
import {
  parseTemplateDefinition,
  resolveTemplate,
  type TemplateCandidate,
  type TemplateDefinition,
} from '../src/index.js';

/* HUMAN → MED → DERMATOLOGY → HAIR_AND_SCALP */
const HUMAN = 'node-human';
const MED = 'node-med';
const DERM = 'node-derm';
const HAIR = 'node-hair';
const PATH = [HUMAN, MED, DERM, HAIR];

const parsed = ((): TemplateDefinition => {
  const result = parseTemplateDefinition({
    schemaVersion: 1,
    scopes: [],
    sections: [
      {
        type: 'CHIEF_COMPLAINT',
        key: 'complaint',
        label: 'Chief complaint',
        order: 10,
        visible: true,
        required: true,
      },
    ],
  });
  if (!result.ok) throw new Error(result.problem);
  return result.value;
})();

const candidate = (over: Partial<TemplateCandidate> = {}): TemplateCandidate => ({
  templateId: `tpl-${over.code ?? 'x'}`,
  code: 'GENERAL_HUMAN',
  specialtyId: null,
  isOwn: false,
  publishedVersion: { versionId: 'ver-1', version: 1, definition: parsed },
  ...over,
});

describe('most specific wins, walking up', () => {
  it("prefers the doctor's own node over an ancestor", () => {
    const result = resolveTemplate({
      taxonomyPath: PATH,
      candidates: [
        candidate({ code: 'DERM', templateId: 'tpl-derm', specialtyId: DERM }),
        candidate({ code: 'HAIR', templateId: 'tpl-hair', specialtyId: HAIR }),
      ],
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.templateId).toBe('tpl-hair');
  });

  it('falls back to the nearest ancestor when the leaf has nothing', () => {
    const result = resolveTemplate({
      taxonomyPath: PATH,
      candidates: [
        candidate({ code: 'GENERAL_HUMAN', templateId: 'tpl-general', specialtyId: null }),
        candidate({ code: 'DERM', templateId: 'tpl-derm', specialtyId: DERM }),
      ],
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.templateId).toBe('tpl-derm');
  });

  it('reaches the care-context default when the doctor has no classification at all', () => {
    /* Scenario 3: the path is the care context and nothing else. */
    const result = resolveTemplate({
      taxonomyPath: [HUMAN],
      candidates: [
        candidate({ code: 'GENERAL_HUMAN', templateId: 'tpl-general', specialtyId: null }),
        candidate({ code: 'DERM', templateId: 'tpl-derm', specialtyId: DERM }),
      ],
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.templateId).toBe('tpl-general');
  });

  it('ignores a template attached to a node that is not on this path', () => {
    const result = resolveTemplate({
      taxonomyPath: [HUMAN, MED],
      candidates: [candidate({ code: 'HAIR', templateId: 'tpl-hair', specialtyId: HAIR })],
    });
    expect(result.ok).toBe(false);
  });

  it('reports which node it matched, so a clinic can see the level it configured', () => {
    const result = resolveTemplate({
      taxonomyPath: PATH,
      candidates: [candidate({ code: 'DERM', templateId: 'tpl-derm', specialtyId: DERM })],
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.matchedSpecialtyId).toBe(DERM);
      expect(result.value.matchedDepth).toBe(2);
    }
  });
});

describe('a tie at the same node', () => {
  it("gives the clinic's own template the win over the platform's", () => {
    const result = resolveTemplate({
      taxonomyPath: PATH,
      candidates: [
        candidate({ code: 'DENTAL', templateId: 'tpl-platform', specialtyId: DERM, isOwn: false }),
        candidate({ code: 'MY_DERM', templateId: 'tpl-mine', specialtyId: DERM, isOwn: true }),
      ],
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.templateId).toBe('tpl-mine');
  });

  it('gives the same answer whatever order the candidates arrive in', () => {
    const a = candidate({ code: 'AAA', templateId: 'tpl-a', specialtyId: DERM });
    const b = candidate({ code: 'BBB', templateId: 'tpl-b', specialtyId: DERM });
    const forwards = resolveTemplate({ taxonomyPath: PATH, candidates: [a, b] });
    const backwards = resolveTemplate({ taxonomyPath: PATH, candidates: [b, a] });
    expect(forwards.ok && backwards.ok).toBe(true);
    if (forwards.ok && backwards.ok) {
      expect(forwards.value.templateId).toBe(backwards.value.templateId);
      expect(forwards.value.templateId).toBe('tpl-a');
    }
  });
});

describe('drafts are not configuration', () => {
  it('walks past an unpublished template at the leaf to a published ancestor', () => {
    /* ⚠️ The filter runs BEFORE the walk. A clinic that started a Hair & Scalp
       template and never published it consults on Dermatology's, rather than
       being told nothing applies. */
    const result = resolveTemplate({
      taxonomyPath: PATH,
      candidates: [
        candidate({
          code: 'HAIR',
          templateId: 'tpl-hair',
          specialtyId: HAIR,
          publishedVersion: null,
        }),
        candidate({ code: 'DERM', templateId: 'tpl-derm', specialtyId: DERM }),
      ],
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.templateId).toBe('tpl-derm');
  });

  it('refuses rather than inventing a consultation when nothing is published', () => {
    const result = resolveTemplate({
      taxonomyPath: PATH,
      candidates: [candidate({ specialtyId: null, publishedVersion: null })],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.problem).toContain('Publish');
  });

  it('refuses when there is no care context to resolve within', () => {
    const result = resolveTemplate({ taxonomyPath: [], candidates: [candidate()] });
    expect(result.ok).toBe(false);
  });

  it('carries the published version through, not the template row', () => {
    const result = resolveTemplate({
      taxonomyPath: [HUMAN],
      candidates: [
        candidate({
          specialtyId: null,
          publishedVersion: { versionId: 'ver-7', version: 7, definition: parsed },
        }),
      ],
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.versionId).toBe('ver-7');
      expect(result.value.version).toBe(7);
    }
  });
});
