/**
 * DATA ONLY — the clinical taxonomy list. `seedClinicalMasters` writes it.
 *
 * Kept apart from the seeding logic so adding a node is a one-line edit to a
 * list, with no chance of disturbing the parent-resolution code that walks it.
 */
import type { TaxonomyNodeType } from '../../../generated/prisma/index.js';

/**
 * The clinical taxonomy, seeded as PLATFORM rows (`organizationId = null`).
 *
 * Every clinic reads these; a clinic that needs a node we have not thought of
 * adds its own org-scoped row through `doctor.master.manage` rather than waiting
 * for a deploy. The RLS policy is deliberately read-permissive and write-strict,
 * so a tenant can never add to THIS list — see enable-rls.sql.
 *
 * ── WHAT THIS TREE IS, AND WHAT IT IS NOT ─────────────────────────────────────
 *
 * It is what a practitioner is TRAINED IN. It is deliberately none of:
 *
 *   · where they work      → `branches`, and `staff_profiles.department`
 *   · what they charge for → procedures/services, which reference a node here
 *   · what they hold       → `qualifications` (MBBS, MDS, board certification)
 *                            and `doctor_profiles.registration_*`
 *
 * So there is no "Angioplasty" node (a procedure) and no "Fellowship in
 * Cardiology" node (a credential). Both are real, and both live elsewhere.
 *
 * ── CODES ARE FLAT, NOT PATHS ─────────────────────────────────────────────────
 *
 * `INTERVENTIONAL_CARDIOLOGY`, never `MED-CARD-INTERVENTIONAL`. Two reasons, and
 * the second is the one that matters:
 *
 *   1. `createSpecialtyRequest` validates /^[A-Z0-9_]+$/ — hyphens are already
 *      rejected for tenant-authored codes, and the platform catalogue must not
 *      be spelled differently from the rows clinics add beside it.
 *   2. A path-encoded code becomes A LIE THE MOMENT A NODE MOVES. Re-parenting
 *      Sleep Medicine from Pulmonology to Neurology would demand a code change,
 *      the code is what the seed upserts on and what `doctor_specialties` was
 *      written against, and so the rename silently forks the node in two. The
 *      path already has a home: it is `parent_id`.
 *
 * ── ORDER-INDEPENDENT, BUT NO LONGER TWO-PASS ─────────────────────────────────
 *
 * ⚠️ This list used to be inserted flat and re-parented in a second pass. That
 *   is now unsafe. `specialties_sibling_name_key` is UNIQUE on
 *   (organization_id, parent_id, lower(name)) NULLS NOT DISTINCT — so during the
 *   old first pass, when every node briefly had parent_id NULL, EVERY NAME IN
 *   THIS FILE WAS A SIBLING OF EVERY OTHER. The seed would have started failing
 *   the first time two nodes anywhere in the tree shared a name, which is
 *   perfectly legal for nodes under different parents.
 *
 *   `ensureNode` below resolves each node's parent before writing the node, so
 *   a row is never persisted parentless. The order of this list therefore still
 *   does not matter — it is authored top-down only because that reads best.
 */
export const SPECIALTIES: {
  code: string;
  name: string;
  parent?: string;
  type?: TaxonomyNodeType;
  description?: string;
}[] = [
  // ── Domains ────────────────────────────────────────────────────────────────
  //
  // Seven roots, not the six the brief named. `TRAD` is the addition: Ayurveda
  // and Homeopathy already existed as top-level rows, and filing them under
  // `MED` would assert they are allopathic specialties, which they are not.
  // WHO's own framing is "Traditional and Complementary Medicine", and the
  // domain generalises past India — Unani, Siddha, TCM, osteopathy, chiropractic
  // all belong here rather than in a country-specific bucket.
  {
    code: 'MED',
    name: 'Medical',
    type: 'DOMAIN',
    description: 'Physician specialties in the allopathic tradition.',
  },
  {
    code: 'DEN',
    name: 'Dental',
    type: 'DOMAIN',
    description: 'Dental and oral health specialties.',
  },
  {
    code: 'MBH',
    name: 'Mental & Behavioural Health',
    type: 'DOMAIN',
    description:
      'Psychiatry, psychology and the behavioural therapies. Psychiatry is filed here rather than under Medical — see its own note.',
  },
  {
    code: 'ALH',
    name: 'Allied Health',
    type: 'DOMAIN',
    description:
      'Clinical professions outside medicine and dentistry: therapy, diagnostics support, optometry, dietetics.',
  },
  {
    code: 'DGN',
    name: 'Diagnostic Services',
    type: 'DOMAIN',
    description:
      'Physician specialties that report on investigations rather than treat directly. The allied professions that OPERATE the equipment sit under Allied Health.',
  },
  {
    code: 'REH',
    name: 'Rehabilitation',
    type: 'DOMAIN',
    description:
      'Restoring function after injury, surgery or illness. The rehabilitation DISCIPLINES; the professions delivering them are under Allied Health.',
  },
  {
    code: 'TRAD',
    name: 'Traditional & Complementary Medicine',
    type: 'DOMAIN',
    description:
      'Systems of medicine outside the allopathic tradition, recognised and licensed differently by jurisdiction.',
  },

  // ── Medical ────────────────────────────────────────────────────────────────
  { code: 'GENERAL_MEDICINE', name: 'General Medicine', parent: 'MED' },
  { code: 'FAMILY_MEDICINE', name: 'Family Medicine', parent: 'MED' },
  { code: 'GERIATRICS', name: 'Geriatric Medicine', parent: 'MED' },
  { code: 'EMERGENCY_MEDICINE', name: 'Emergency Medicine', parent: 'MED' },
  { code: 'PALLIATIVE_MEDICINE', name: 'Palliative Medicine', parent: 'MED' },
  { code: 'PREVENTIVE_MEDICINE', name: 'Preventive Medicine', parent: 'MED' },
  { code: 'OCCUPATIONAL_MEDICINE', name: 'Occupational Medicine', parent: 'MED' },
  { code: 'INFECTIOUS_DISEASES', name: 'Infectious Diseases', parent: 'MED' },
  { code: 'ALLERGY_IMMUNOLOGY', name: 'Allergy & Immunology', parent: 'MED' },
  { code: 'CLINICAL_GENETICS', name: 'Clinical Genetics', parent: 'MED' },

  { code: 'PAEDIATRICS', name: 'Paediatrics', parent: 'MED', type: 'DEPARTMENT' },
  { code: 'NEONATOLOGY', name: 'Neonatology', parent: 'PAEDIATRICS', type: 'SUB_SPECIALTY' },
  {
    code: 'PAEDIATRIC_CARDIOLOGY',
    name: 'Paediatric Cardiology',
    parent: 'PAEDIATRICS',
    type: 'SUB_SPECIALTY',
  },
  {
    code: 'PAEDIATRIC_NEUROLOGY',
    name: 'Paediatric Neurology',
    parent: 'PAEDIATRICS',
    type: 'SUB_SPECIALTY',
  },

  {
    code: 'OBSTETRICS_GYNAECOLOGY',
    name: 'Obstetrics & Gynaecology',
    parent: 'MED',
    type: 'DEPARTMENT',
  },
  {
    code: 'MATERNAL_FETAL_MEDICINE',
    name: 'Maternal & Fetal Medicine',
    parent: 'OBSTETRICS_GYNAECOLOGY',
    type: 'SUB_SPECIALTY',
  },
  {
    code: 'REPRODUCTIVE_MEDICINE',
    name: 'Reproductive Medicine',
    parent: 'OBSTETRICS_GYNAECOLOGY',
    type: 'SUB_SPECIALTY',
  },
  {
    code: 'GYNAECOLOGIC_ONCOLOGY',
    name: 'Gynaecologic Oncology',
    parent: 'OBSTETRICS_GYNAECOLOGY',
    type: 'SUB_SPECIALTY',
  },

  { code: 'CARDIOLOGY', name: 'Cardiology', parent: 'MED', type: 'DEPARTMENT' },
  {
    code: 'INTERVENTIONAL_CARDIOLOGY',
    name: 'Interventional Cardiology',
    parent: 'CARDIOLOGY',
    type: 'SUB_SPECIALTY',
  },
  {
    code: 'STRUCTURAL_HEART_DISEASE',
    name: 'Structural Heart Disease',
    parent: 'INTERVENTIONAL_CARDIOLOGY',
    type: 'SUB_SPECIALTY',
    description:
      'Four levels deep — MED → CARDIOLOGY → INTERVENTIONAL_CARDIOLOGY → here. Nothing in the schema knows or cares that this branch is deeper than Dental.',
  },
  {
    code: 'CORONARY_INTERVENTION',
    name: 'Coronary Intervention',
    parent: 'INTERVENTIONAL_CARDIOLOGY',
    type: 'SUB_SPECIALTY',
  },
  {
    code: 'ELECTROPHYSIOLOGY',
    name: 'Cardiac Electrophysiology',
    parent: 'CARDIOLOGY',
    type: 'SUB_SPECIALTY',
  },
  { code: 'HEART_FAILURE', name: 'Heart Failure', parent: 'CARDIOLOGY', type: 'SUB_SPECIALTY' },
  { code: 'CARDIOTHORACIC_SURGERY', name: 'Cardiothoracic Surgery', parent: 'MED' },
  { code: 'VASCULAR_SURGERY', name: 'Vascular Surgery', parent: 'MED' },

  { code: 'NEUROLOGY', name: 'Neurology', parent: 'MED', type: 'DEPARTMENT' },
  { code: 'STROKE_MEDICINE', name: 'Stroke Medicine', parent: 'NEUROLOGY', type: 'SUB_SPECIALTY' },
  { code: 'EPILEPTOLOGY', name: 'Epileptology', parent: 'NEUROLOGY', type: 'SUB_SPECIALTY' },
  {
    code: 'MOVEMENT_DISORDERS',
    name: 'Movement Disorders',
    parent: 'NEUROLOGY',
    type: 'SUB_SPECIALTY',
  },
  { code: 'NEUROSURGERY', name: 'Neurosurgery', parent: 'MED' },

  { code: 'ORTHOPAEDICS', name: 'Orthopaedics', parent: 'MED', type: 'DEPARTMENT' },
  { code: 'SPINE_SURGERY', name: 'Spine Surgery', parent: 'ORTHOPAEDICS', type: 'SUB_SPECIALTY' },
  {
    code: 'JOINT_REPLACEMENT',
    name: 'Joint Replacement',
    parent: 'ORTHOPAEDICS',
    type: 'SUB_SPECIALTY',
  },
  {
    code: 'SPORTS_MEDICINE',
    name: 'Sports Medicine',
    parent: 'ORTHOPAEDICS',
    type: 'SUB_SPECIALTY',
    description:
      'The physician sub-specialty. Distinct from SPORTS_REHABILITATION under Physiotherapy, which is the therapy focus area.',
  },
  { code: 'HAND_SURGERY', name: 'Hand Surgery', parent: 'ORTHOPAEDICS', type: 'SUB_SPECIALTY' },
  {
    code: 'PAEDIATRIC_ORTHOPAEDICS',
    name: 'Paediatric Orthopaedics',
    parent: 'ORTHOPAEDICS',
    type: 'SUB_SPECIALTY',
  },

  { code: 'GENERAL_SURGERY', name: 'General Surgery', parent: 'MED', type: 'DEPARTMENT' },
  {
    code: 'GASTROINTESTINAL_SURGERY',
    name: 'Gastrointestinal Surgery',
    parent: 'GENERAL_SURGERY',
    type: 'SUB_SPECIALTY',
  },
  {
    code: 'COLORECTAL_SURGERY',
    name: 'Colorectal Surgery',
    parent: 'GENERAL_SURGERY',
    type: 'SUB_SPECIALTY',
  },
  {
    code: 'BARIATRIC_SURGERY',
    name: 'Bariatric Surgery',
    parent: 'GENERAL_SURGERY',
    type: 'SUB_SPECIALTY',
  },
  { code: 'PLASTIC_SURGERY', name: 'Plastic & Reconstructive Surgery', parent: 'MED' },

  { code: 'DERMATOLOGY', name: 'Dermatology', parent: 'MED', type: 'DEPARTMENT' },
  { code: 'TRICHOLOGY', name: 'Trichology', parent: 'DERMATOLOGY', type: 'FOCUS_AREA' },
  { code: 'COSMETOLOGY', name: 'Cosmetology', parent: 'DERMATOLOGY', type: 'FOCUS_AREA' },

  { code: 'OPHTHALMOLOGY', name: 'Ophthalmology', parent: 'MED', type: 'DEPARTMENT' },
  {
    code: 'CORNEA',
    name: 'Cornea & Refractive Surgery',
    parent: 'OPHTHALMOLOGY',
    type: 'SUB_SPECIALTY',
  },
  {
    code: 'VITREORETINAL_SURGERY',
    name: 'Vitreoretinal Surgery',
    parent: 'OPHTHALMOLOGY',
    type: 'SUB_SPECIALTY',
  },
  { code: 'GLAUCOMA', name: 'Glaucoma', parent: 'OPHTHALMOLOGY', type: 'SUB_SPECIALTY' },
  {
    code: 'PAEDIATRIC_OPHTHALMOLOGY',
    name: 'Paediatric Ophthalmology',
    parent: 'OPHTHALMOLOGY',
    type: 'SUB_SPECIALTY',
  },

  { code: 'ENT', name: 'ENT (Otorhinolaryngology)', parent: 'MED', type: 'DEPARTMENT' },
  { code: 'OTOLOGY', name: 'Otology & Neurotology', parent: 'ENT', type: 'SUB_SPECIALTY' },
  { code: 'RHINOLOGY', name: 'Rhinology', parent: 'ENT', type: 'SUB_SPECIALTY' },
  { code: 'HEAD_NECK_SURGERY', name: 'Head & Neck Surgery', parent: 'ENT', type: 'SUB_SPECIALTY' },

  { code: 'GASTROENTEROLOGY', name: 'Gastroenterology', parent: 'MED', type: 'DEPARTMENT' },
  { code: 'HEPATOLOGY', name: 'Hepatology', parent: 'GASTROENTEROLOGY', type: 'SUB_SPECIALTY' },
  { code: 'NEPHROLOGY', name: 'Nephrology', parent: 'MED' },
  { code: 'UROLOGY', name: 'Urology', parent: 'MED', type: 'DEPARTMENT' },
  { code: 'ANDROLOGY', name: 'Andrology', parent: 'UROLOGY', type: 'SUB_SPECIALTY' },
  { code: 'ENDOCRINOLOGY', name: 'Endocrinology', parent: 'MED', type: 'DEPARTMENT' },
  { code: 'DIABETOLOGY', name: 'Diabetology', parent: 'ENDOCRINOLOGY', type: 'SUB_SPECIALTY' },
  { code: 'PULMONOLOGY', name: 'Pulmonology', parent: 'MED', type: 'DEPARTMENT' },
  { code: 'SLEEP_MEDICINE', name: 'Sleep Medicine', parent: 'PULMONOLOGY', type: 'SUB_SPECIALTY' },
  { code: 'RHEUMATOLOGY', name: 'Rheumatology', parent: 'MED' },
  { code: 'HAEMATOLOGY', name: 'Haematology', parent: 'MED' },

  { code: 'ONCOLOGY', name: 'Oncology', parent: 'MED', type: 'DEPARTMENT' },
  { code: 'MEDICAL_ONCOLOGY', name: 'Medical Oncology', parent: 'ONCOLOGY', type: 'SUB_SPECIALTY' },
  {
    code: 'SURGICAL_ONCOLOGY',
    name: 'Surgical Oncology',
    parent: 'ONCOLOGY',
    type: 'SUB_SPECIALTY',
  },
  {
    code: 'RADIATION_ONCOLOGY',
    name: 'Radiation Oncology',
    parent: 'ONCOLOGY',
    type: 'SUB_SPECIALTY',
  },
  {
    code: 'PAEDIATRIC_ONCOLOGY',
    name: 'Paediatric Oncology',
    parent: 'ONCOLOGY',
    type: 'SUB_SPECIALTY',
  },

  { code: 'ANAESTHESIOLOGY', name: 'Anaesthesiology', parent: 'MED', type: 'DEPARTMENT' },
  {
    code: 'PAIN_MEDICINE',
    name: 'Pain Medicine',
    parent: 'ANAESTHESIOLOGY',
    type: 'SUB_SPECIALTY',
  },
  {
    code: 'CRITICAL_CARE',
    name: 'Critical Care Medicine',
    parent: 'ANAESTHESIOLOGY',
    type: 'SUB_SPECIALTY',
  },

  // ── Dental ─────────────────────────────────────────────────────────────────
  //
  // ⚠️ `DENTISTRY` IS REPURPOSED, NOT REPLACED. It used to be the top-level
  //   dental node with Orthodontics and friends beneath it. `DEN` is now that
  //   root, and DENTISTRY becomes the "General Dentistry" leaf. The code is
  //   untouched on purpose: any doctor already tagged DENTISTRY meant "a
  //   dentist, unspecified", and General Dentistry is precisely that. Renaming
  //   the code instead would have orphaned those `doctor_specialties` rows.
  {
    code: 'DENTISTRY',
    name: 'General Dentistry',
    parent: 'DEN',
    description:
      'Formerly the root of the dental tree. Re-typed as the general-practice leaf when DEN was introduced; the code is preserved so existing assignments keep resolving.',
  },
  { code: 'ORTHODONTICS', name: 'Orthodontics', parent: 'DEN' },
  { code: 'ENDODONTICS', name: 'Endodontics', parent: 'DEN' },
  { code: 'PERIODONTICS', name: 'Periodontics', parent: 'DEN' },
  { code: 'PROSTHODONTICS', name: 'Prosthodontics', parent: 'DEN' },
  { code: 'PAEDIATRIC_DENTISTRY', name: 'Paediatric Dentistry', parent: 'DEN' },
  { code: 'ORAL_MEDICINE', name: 'Oral Medicine', parent: 'DEN' },
  { code: 'ORAL_PATHOLOGY', name: 'Oral & Maxillofacial Pathology', parent: 'DEN' },
  {
    code: 'ORAL_MAXILLOFACIAL_SURGERY',
    name: 'Oral & Maxillofacial Surgery',
    parent: 'DEN',
  },
  {
    code: 'ORAL_MAXILLOFACIAL_RADIOLOGY',
    name: 'Oral & Maxillofacial Radiology',
    parent: 'DEN',
  },
  { code: 'PUBLIC_HEALTH_DENTISTRY', name: 'Public Health Dentistry', parent: 'DEN' },
  { code: 'IMPLANTOLOGY', name: 'Implantology', parent: 'DEN', type: 'FOCUS_AREA' },

  // ── Mental & Behavioural Health ────────────────────────────────────────────
  //
  // ⚠️ PSYCHIATRY IS FILED HERE, NOT UNDER MED, AND A TREE FORCES THAT CHOICE.
  //   It is genuinely both: a physician specialty and a mental-health one. The
  //   brief lists it under both headings, which a single-parent hierarchy cannot
  //   express. MBH wins because a user browsing for mental health expects to
  //   find psychiatry there and would consider its absence a bug, whereas a user
  //   browsing Medical is not surprised to be sent one level sideways.
  //   If cross-listing is ever genuinely needed, it is a second edge — a
  //   join table — NOT a duplicate node with a second code.
  { code: 'PSYCHIATRY', name: 'Psychiatry', parent: 'MBH', type: 'DEPARTMENT' },
  {
    code: 'CHILD_ADOLESCENT_PSYCHIATRY',
    name: 'Child & Adolescent Psychiatry',
    parent: 'PSYCHIATRY',
    type: 'SUB_SPECIALTY',
  },
  {
    code: 'ADDICTION_PSYCHIATRY',
    name: 'Addiction Psychiatry',
    parent: 'PSYCHIATRY',
    type: 'SUB_SPECIALTY',
  },
  {
    code: 'GERIATRIC_PSYCHIATRY',
    name: 'Geriatric Psychiatry',
    parent: 'PSYCHIATRY',
    type: 'SUB_SPECIALTY',
  },
  {
    code: 'CONSULTATION_LIAISON_PSYCHIATRY',
    name: 'Consultation-Liaison Psychiatry',
    parent: 'PSYCHIATRY',
    type: 'SUB_SPECIALTY',
  },
  { code: 'PSYCHOLOGY', name: 'Psychology', parent: 'MBH', type: 'DEPARTMENT' },
  {
    code: 'CLINICAL_PSYCHOLOGY',
    name: 'Clinical Psychology',
    parent: 'PSYCHOLOGY',
    type: 'SUB_SPECIALTY',
  },
  {
    code: 'COUNSELLING_PSYCHOLOGY',
    name: 'Counselling Psychology',
    parent: 'PSYCHOLOGY',
    type: 'SUB_SPECIALTY',
  },
  { code: 'NEUROPSYCHOLOGY', name: 'Neuropsychology', parent: 'PSYCHOLOGY', type: 'SUB_SPECIALTY' },
  {
    code: 'CHILD_PSYCHOLOGY',
    name: 'Child Psychology',
    parent: 'PSYCHOLOGY',
    type: 'SUB_SPECIALTY',
  },
  { code: 'PSYCHOTHERAPY', name: 'Psychotherapy', parent: 'MBH' },
  { code: 'BEHAVIOURAL_THERAPY', name: 'Behavioural Therapy', parent: 'MBH' },
  { code: 'ADDICTION_MEDICINE', name: 'Addiction Medicine', parent: 'MBH' },

  // ── Allied Health ──────────────────────────────────────────────────────────
  //
  // Nursing is deliberately absent. A nurse's grade is a JOB TITLE, which this
  // codebase already models as a `designations` row attached to a staff profile.
  // Adding it here would create the second answer to "what is this person" that
  // the whole exercise exists to avoid.
  { code: 'PHYSIOTHERAPY', name: 'Physiotherapy', parent: 'ALH', type: 'DEPARTMENT' },
  {
    code: 'SPORTS_REHABILITATION',
    name: 'Sports Rehabilitation',
    parent: 'PHYSIOTHERAPY',
    type: 'FOCUS_AREA',
  },
  {
    code: 'NEURO_PHYSIOTHERAPY',
    name: 'Neurological Physiotherapy',
    parent: 'PHYSIOTHERAPY',
    type: 'FOCUS_AREA',
  },
  {
    code: 'PAEDIATRIC_PHYSIOTHERAPY',
    name: 'Paediatric Physiotherapy',
    parent: 'PHYSIOTHERAPY',
    type: 'FOCUS_AREA',
  },
  { code: 'OCCUPATIONAL_THERAPY', name: 'Occupational Therapy', parent: 'ALH' },
  { code: 'SPEECH_LANGUAGE_THERAPY', name: 'Speech & Language Therapy', parent: 'ALH' },
  { code: 'AUDIOLOGY', name: 'Audiology', parent: 'ALH' },
  { code: 'OPTOMETRY', name: 'Optometry', parent: 'ALH' },
  { code: 'NUTRITION_DIETETICS', name: 'Nutrition & Dietetics', parent: 'ALH', type: 'DEPARTMENT' },
  {
    code: 'CLINICAL_NUTRITION',
    name: 'Clinical Nutrition',
    parent: 'NUTRITION_DIETETICS',
    type: 'FOCUS_AREA',
  },
  {
    code: 'SPORTS_NUTRITION',
    name: 'Sports Nutrition',
    parent: 'NUTRITION_DIETETICS',
    type: 'FOCUS_AREA',
  },
  { code: 'RESPIRATORY_THERAPY', name: 'Respiratory Therapy', parent: 'ALH' },
  { code: 'PODIATRY', name: 'Podiatry', parent: 'ALH' },
  { code: 'PROSTHETICS_ORTHOTICS', name: 'Prosthetics & Orthotics', parent: 'ALH' },
  {
    code: 'MEDICAL_LABORATORY_TECHNOLOGY',
    name: 'Medical Laboratory Technology',
    parent: 'ALH',
    description:
      'The allied profession running the bench. PATHOLOGY under Diagnostic Services is the physician specialty that reports on it.',
  },
  {
    code: 'RADIOGRAPHY',
    name: 'Radiography & Imaging Technology',
    parent: 'ALH',
    description:
      'The allied profession that acquires the images. RADIOLOGY under Diagnostic Services is the physician specialty that reports them. Same equipment, different training, different node.',
  },

  // ── Diagnostic Services ────────────────────────────────────────────────────
  { code: 'RADIOLOGY', name: 'Radiology', parent: 'DGN', type: 'DEPARTMENT' },
  {
    code: 'INTERVENTIONAL_RADIOLOGY',
    name: 'Interventional Radiology',
    parent: 'RADIOLOGY',
    type: 'SUB_SPECIALTY',
  },
  { code: 'NEURORADIOLOGY', name: 'Neuroradiology', parent: 'RADIOLOGY', type: 'SUB_SPECIALTY' },
  {
    code: 'MUSCULOSKELETAL_RADIOLOGY',
    name: 'Musculoskeletal Radiology',
    parent: 'RADIOLOGY',
    type: 'SUB_SPECIALTY',
  },
  { code: 'PATHOLOGY', name: 'Pathology', parent: 'DGN', type: 'DEPARTMENT' },
  { code: 'HISTOPATHOLOGY', name: 'Histopathology', parent: 'PATHOLOGY', type: 'SUB_SPECIALTY' },
  { code: 'CYTOPATHOLOGY', name: 'Cytopathology', parent: 'PATHOLOGY', type: 'SUB_SPECIALTY' },
  {
    code: 'HAEMATOPATHOLOGY',
    name: 'Haematopathology',
    parent: 'PATHOLOGY',
    type: 'SUB_SPECIALTY',
  },
  {
    code: 'CLINICAL_BIOCHEMISTRY',
    name: 'Clinical Biochemistry',
    parent: 'PATHOLOGY',
    type: 'SUB_SPECIALTY',
  },
  {
    code: 'CLINICAL_MICROBIOLOGY',
    name: 'Clinical Microbiology',
    parent: 'PATHOLOGY',
    type: 'SUB_SPECIALTY',
  },
  { code: 'NUCLEAR_MEDICINE', name: 'Nuclear Medicine', parent: 'DGN' },
  { code: 'TRANSFUSION_MEDICINE', name: 'Transfusion Medicine', parent: 'DGN' },

  // ── Rehabilitation ─────────────────────────────────────────────────────────
  {
    code: 'PHYSICAL_MEDICINE_REHABILITATION',
    name: 'Physical Medicine & Rehabilitation',
    parent: 'REH',
    type: 'DEPARTMENT',
  },
  { code: 'NEURO_REHABILITATION', name: 'Neurological Rehabilitation', parent: 'REH' },
  { code: 'CARDIAC_REHABILITATION', name: 'Cardiac Rehabilitation', parent: 'REH' },
  { code: 'PULMONARY_REHABILITATION', name: 'Pulmonary Rehabilitation', parent: 'REH' },
  { code: 'GERIATRIC_REHABILITATION', name: 'Geriatric Rehabilitation', parent: 'REH' },

  // ── Traditional & Complementary ────────────────────────────────────────────
  { code: 'AYURVEDA', name: 'Ayurveda', parent: 'TRAD' },
  { code: 'HOMEOPATHY', name: 'Homeopathy', parent: 'TRAD' },
  { code: 'UNANI', name: 'Unani Medicine', parent: 'TRAD' },
  { code: 'SIDDHA', name: 'Siddha Medicine', parent: 'TRAD' },
  { code: 'NATUROPATHY', name: 'Naturopathy', parent: 'TRAD' },
  { code: 'YOGA_THERAPY', name: 'Yoga Therapy', parent: 'TRAD' },
  { code: 'ACUPUNCTURE', name: 'Acupuncture', parent: 'TRAD' },
  { code: 'CHIROPRACTIC', name: 'Chiropractic', parent: 'TRAD' },
  { code: 'OSTEOPATHIC_MEDICINE', name: 'Osteopathic Medicine', parent: 'TRAD' },
  {
    code: 'TRADITIONAL_CHINESE_MEDICINE',
    name: 'Traditional Chinese Medicine',
    parent: 'TRAD',
  },
];
