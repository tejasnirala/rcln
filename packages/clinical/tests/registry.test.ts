/**
 * The section registry.
 *
 * ⚠️ THESE ARE THE ASSERTIONS THAT KEEP THE CONFIGURATION LINE WHERE
 *   ARCHITECTURE.md PUTS IT. If Prescription ever becomes descriptor-driven, or
 *   Chief Complaint repeatable, the engine has changed shape and this file
 *   should be the first thing that says so.
 */
import {
  CONSULTATION_SECTION_TYPES,
  capabilityOf,
  isSectionType,
  sectionTypesInDefaultOrder,
} from '../src/index.js';

describe('the closed set', () => {
  it('recognises every member and nothing else', () => {
    for (const type of CONSULTATION_SECTION_TYPES) expect(isSectionType(type)).toBe(true);
    expect(isSectionType('GENOME_BROWSER')).toBe(false);
    expect(isSectionType(undefined)).toBe(false);
    expect(isSectionType(42)).toBe(false);
  });

  it('has a capability row for every section type', () => {
    for (const type of CONSULTATION_SECTION_TYPES) {
      expect(capabilityOf(type)).toBeDefined();
    }
  });
});

describe('the two kinds of section', () => {
  it('makes exactly History and Examination descriptor-driven', () => {
    const driven = CONSULTATION_SECTION_TYPES.filter((t) => capabilityOf(t).descriptorDriven);
    expect(driven).toEqual(['HISTORY', 'EXAMINATION']);
  });

  it('leaves the prescription to the product catalogue, not the clinical masters', () => {
    /* §11 and PI-ADR-001: a medicine is a stocked, batched, taxed thing, not a
       clinical word — so PRESCRIPTION draws on no `ClinicalMasterKind`. */
    expect(capabilityOf('PRESCRIPTION').vocabulary).toBeNull();
    expect(capabilityOf('DIAGNOSIS').vocabulary).toBe('DIAGNOSIS');
    expect(capabilityOf('VISUAL_MAPPING').vocabulary).toBe('FINDING_TYPE');
  });

  it('lets only the sections that legitimately recur repeat', () => {
    const repeatable = CONSULTATION_SECTION_TYPES.filter((t) => capabilityOf(t).repeatable);
    expect(repeatable.sort()).toEqual(['EXAMINATION', 'HISTORY', 'VISUAL_MAPPING']);
  });

  it('requires a map for the mapping section and for nothing else', () => {
    const mapped = CONSULTATION_SECTION_TYPES.filter((t) => capabilityOf(t).requiresMap);
    expect(mapped).toEqual(['VISUAL_MAPPING']);
  });
});

describe('the default consultation', () => {
  it('runs complaint → findings → conclusion → treatment → follow-up', () => {
    expect(sectionTypesInDefaultOrder()).toEqual([
      'CHIEF_COMPLAINT',
      'SYMPTOMS',
      'HISTORY',
      'EXAMINATION',
      'VISUAL_MAPPING',
      'DIAGNOSIS',
      'PROCEDURE',
      'PRESCRIPTION',
      'INVESTIGATION',
      'ADVICE',
      'REFERRAL',
      'CLINICAL_NOTES',
      'ATTACHMENTS',
      'FOLLOW_UP',
    ]);
  });

  it('gives every type a distinct default order, so the fallback is a total order', () => {
    const orders = CONSULTATION_SECTION_TYPES.map((t) => capabilityOf(t).defaultOrder);
    expect(new Set(orders).size).toBe(orders.length);
  });
});
