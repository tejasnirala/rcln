/**
 * DATA ONLY — the reference clinical vocabulary. `seedClinicalVocabulary` writes it.
 *
 * ⚠️ DELIBERATELY TINY, AND IT MUST STAY THAT WAY (§41). This is enough to prove
 *   the engine for two configurations — Dentistry, and Dermatology → Hair &
 *   Scalp — and it is not, and must never become, a medical knowledge base.
 *
 * ⚠️ NOBODY MAY INVENT A CLINICAL CODE HERE. The same rule the regulatory pack
 *   works under, for a related reason: these words appear in a picker a
 *   clinician chooses a DIAGNOSIS from, and a plausible-looking invention is a
 *   patient-safety defect that reads as perfectly ordinary. Two consequences:
 *
 *     1. `codings` are ICD-10 codes and are present ONLY where the code was
 *        looked up in the WHO ICD-10 browser. An item with no verified code
 *        carries none — a missing code is a correct outcome, a wrong one is not.
 *     2. Nothing here claims completeness for any specialty. A clinic adds its
 *        own terms through `clinical.master.manage`.
 *
 * ── SCOPES RANK, THEY DO NOT FILTER ──────────────────────────────────────────
 *
 * `specialties` here says "this word is especially relevant to that node". It
 * never means "only that node may use it" — see `ClinicalMasterScope` and §34.
 * A dentist may record "Fever"; it just will not sort first.
 */
import type { ClinicalMasterKind } from '../../../generated/prisma/index.js';

export interface ClinicalMasterSeed {
  kind: ClinicalMasterKind;
  code: string;
  name: string;
  description?: string;
  /** Taxonomy node codes. Ranking only. */
  specialties?: string[];
  /** ⚠️ Verified codes only. See the header. */
  codings?: { system: string; code: string }[];
}

export const CLINICAL_MASTERS: ClinicalMasterSeed[] = [
  // ── Dentistry ──────────────────────────────────────────────────────────────
  {
    kind: 'SYMPTOM',
    code: 'TOOTH_PAIN',
    name: 'Tooth pain',
    specialties: ['DEN'],
  },
  { kind: 'SYMPTOM', code: 'TOOTH_SENSITIVITY', name: 'Sensitivity', specialties: ['DEN'] },
  { kind: 'SYMPTOM', code: 'GUM_BLEEDING', name: 'Gum bleeding', specialties: ['DEN'] },
  { kind: 'SYMPTOM', code: 'FACIAL_SWELLING', name: 'Swelling', specialties: ['DEN'] },
  {
    kind: 'DIAGNOSIS',
    code: 'DENTAL_CARIES',
    name: 'Dental caries',
    specialties: ['DEN'],
    codings: [{ system: 'ICD10', code: 'K02' }],
  },
  {
    kind: 'DIAGNOSIS',
    code: 'GINGIVITIS',
    name: 'Gingivitis',
    specialties: ['DEN'],
    codings: [{ system: 'ICD10', code: 'K05.1' }],
  },
  {
    kind: 'PROCEDURE',
    code: 'ROOT_CANAL_TREATMENT',
    name: 'Root canal treatment',
    specialties: ['DEN'],
  },
  { kind: 'PROCEDURE', code: 'SCALING', name: 'Scaling and polishing', specialties: ['DEN'] },
  /*
   * ⚠️ FINDING_TYPE IS NOT DIAGNOSIS, and the pair below is why the two kinds
   *   exist separately. "Caries" is what the dentist SEES on tooth 36; "Dental
   *   caries" is what it MEANS. CE-6 records the first against a visual region
   *   and lets the second hang off it.
   */
  { kind: 'FINDING_TYPE', code: 'CARIES', name: 'Caries', specialties: ['DEN'] },
  { kind: 'FINDING_TYPE', code: 'MOBILITY', name: 'Mobility', specialties: ['DEN'] },
  {
    kind: 'FINDING_TYPE',
    code: 'BLEEDING_ON_PROBING',
    name: 'Bleeding on probing',
    specialties: ['DEN'],
  },
  { kind: 'ADVICE', code: 'BRUSHING_TECHNIQUE', name: 'Brushing technique', specialties: ['DEN'] },
  { kind: 'ADVICE', code: 'FLOSSING', name: 'Flossing', specialties: ['DEN'] },
  {
    kind: 'ADVICE',
    code: 'POST_EXTRACTION_CARE',
    name: 'Post-extraction care',
    specialties: ['DEN'],
  },
  { kind: 'INVESTIGATION', code: 'OPG', name: 'Orthopantomogram (OPG)', specialties: ['DEN'] },

  // ── Dermatology · Hair & Scalp ─────────────────────────────────────────────
  { kind: 'SYMPTOM', code: 'HAIR_FALL', name: 'Hair fall', specialties: ['DERMATOLOGY'] },
  { kind: 'SYMPTOM', code: 'HAIR_THINNING', name: 'Hair thinning', specialties: ['DERMATOLOGY'] },
  { kind: 'SYMPTOM', code: 'SCALP_ITCHING', name: 'Itching', specialties: ['DERMATOLOGY'] },
  { kind: 'SYMPTOM', code: 'DANDRUFF', name: 'Dandruff', specialties: ['DERMATOLOGY'] },
  {
    kind: 'DIAGNOSIS',
    code: 'ANDROGENETIC_ALOPECIA',
    name: 'Androgenetic alopecia',
    specialties: ['DERMATOLOGY'],
    codings: [{ system: 'ICD10', code: 'L64' }],
  },
  {
    kind: 'DIAGNOSIS',
    code: 'TELOGEN_EFFLUVIUM',
    name: 'Telogen effluvium',
    specialties: ['DERMATOLOGY'],
    codings: [{ system: 'ICD10', code: 'L65.0' }],
  },
  {
    kind: 'FINDING_TYPE',
    code: 'REDUCED_DENSITY',
    name: 'Reduced density',
    specialties: ['DERMATOLOGY'],
  },
  { kind: 'FINDING_TYPE', code: 'ERYTHEMA', name: 'Erythema', specialties: ['DERMATOLOGY'] },
  { kind: 'FINDING_TYPE', code: 'SCALING_SCALP', name: 'Scaling', specialties: ['DERMATOLOGY'] },
  {
    kind: 'ADVICE',
    code: 'HAIR_CARE_ROUTINE',
    name: 'Hair care routine',
    specialties: ['DERMATOLOGY'],
  },
  { kind: 'ADVICE', code: 'SCALP_CARE', name: 'Scalp care', specialties: ['DERMATOLOGY'] },
  { kind: 'ADVICE', code: 'SUN_PROTECTION', name: 'Sun protection', specialties: ['DERMATOLOGY'] },

  // ── Cross-specialty ────────────────────────────────────────────────────────
  //
  // ⚠️ NO `specialties` ON ANY OF THESE, AND THE ABSENCE IS THE POINT. A history
  //   of diabetes matters to a dentist planning an extraction as much as to a
  //   physician, and "CBC" is ordered by everybody. Tagging them to one node
  //   would sort them below a specialty's own words everywhere else — the exact
  //   failure a hard filter would cause, in slow motion.
  { kind: 'HISTORY_ITEM', code: 'DIABETES_MELLITUS', name: 'Diabetes mellitus' },
  { kind: 'HISTORY_ITEM', code: 'HYPERTENSION', name: 'Hypertension' },
  { kind: 'HISTORY_ITEM', code: 'SMOKING', name: 'Smoking' },
  { kind: 'HISTORY_ITEM', code: 'PENICILLIN_ALLERGY', name: 'Penicillin allergy' },
  { kind: 'INVESTIGATION', code: 'CBC', name: 'Complete blood count (CBC)' },
  { kind: 'INVESTIGATION', code: 'BLOOD_SUGAR_FASTING', name: 'Fasting blood sugar' },
  { kind: 'ADVICE', code: 'COMPLETE_THE_COURSE', name: 'Complete the full course of medication' },
];
