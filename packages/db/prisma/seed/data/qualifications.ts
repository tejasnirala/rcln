/**
 * DATA ONLY — the credential list. `seedClinicalMasters` writes it.
 */

/**
 * Credentials, seeded as PLATFORM rows.
 *
 * ── THIS IS NOT THE TAXONOMY, AND MUST NEVER BECOME IT ───────────────────────
 * A qualification is what someone HOLDS; a `specialties` node is what they are
 * TRAINED IN. "MD" and "Cardiology" answer different questions and a doctor has
 * both independently — an MD who practises dermatology is not a contradiction.
 * ⚠️ Never add "Fellowship in Cardiology" here AND a Cardiology node there and
 *   expect them to stay in step; the fellowship is the credential, the node is
 *   the classification, and joining them would recreate the single-field
 *   `specialization` string this schema exists to replace.
 *
 * ── WHY THE LIST IS EXPLICITLY MULTI-JURISDICTION ────────────────────────────
 * It began as India-only — MBBS/MD/MS/DNB/BAMS — which quietly made the product
 * India-only too: a clinic in Nairobi or Dubai opening the qualification picker
 * found nothing their doctors actually hold, and the only way forward was
 * typing a free-text row per doctor. The taxonomy was deliberately built to
 * work internationally (ADR-free, but see the DOMAIN roots in SPECIALTIES);
 * leaving credentials parochial would have undone that at the one point a
 * clinic notices.
 *
 * ⚠️ NO CODE HERE WAS RENAMED. The seed upserts on (organization_id, code) and
 *   `doctor_qualifications` rows point at these ids, so a rename would orphan
 *   existing records. Entries were added, and some display names clarified.
 *
 * Licensing and registration remain a SEPARATE system —
 * `doctor_profiles.registration_number` / `registration_council`. A licence is
 * jurisdiction-specific and expires; a degree does neither.
 */
export const QUALIFICATIONS: { code: string; name: string }[] = [
  // ── Medical, entry to practice ────────────────────────────────────────────
  { code: 'MBBS', name: 'MBBS — Bachelor of Medicine, Bachelor of Surgery' },
  { code: 'MD_US', name: 'MD — Doctor of Medicine (US/Canada entry degree)' },
  { code: 'DO_US', name: 'DO — Doctor of Osteopathic Medicine (US)' },
  { code: 'MBCHB', name: 'MBChB — Bachelor of Medicine and Surgery (UK/Africa/NZ)' },
  { code: 'MBBCH', name: 'MB BCh BAO — Bachelor of Medicine (Ireland)' },
  { code: 'CEREMED', name: 'State medical degree (other jurisdiction)' },

  // ── Medical, postgraduate ─────────────────────────────────────────────────
  { code: 'MD', name: 'MD — Doctor of Medicine (postgraduate)' },
  { code: 'MS', name: 'MS — Master of Surgery' },
  { code: 'DNB', name: 'DNB — Diplomate of National Board (India)' },
  { code: 'DM', name: 'DM — Doctorate of Medicine (super-specialty)' },
  { code: 'MCH', name: 'MCh — Magister Chirurgiae (super-specialty)' },
  { code: 'DIPLOMA', name: 'Post-graduate Diploma' },
  { code: 'RESIDENCY', name: 'Residency — completed' },
  { code: 'FELLOWSHIP', name: 'Clinical fellowship' },
  { code: 'PHD', name: 'PhD' },
  { code: 'MPH', name: 'MPH — Master of Public Health' },

  // ── Board certification and college membership ────────────────────────────
  //
  // The recognised route to specialist practice differs by country and none of
  // these is a superset of the others.
  { code: 'BOARD_CERT', name: 'Board certification (specialty board)' },
  { code: 'FRCS', name: 'FRCS — Fellow, Royal College of Surgeons' },
  { code: 'FRCP', name: 'FRCP — Fellow, Royal College of Physicians' },
  { code: 'MRCP', name: 'MRCP — Member, Royal College of Physicians' },
  { code: 'MRCS', name: 'MRCS — Member, Royal College of Surgeons' },
  { code: 'MRCGP', name: 'MRCGP — Member, Royal College of General Practitioners' },
  { code: 'FACS', name: 'FACS — Fellow, American College of Surgeons' },
  { code: 'FACP', name: 'FACP — Fellow, American College of Physicians' },
  { code: 'FRACP', name: 'FRACP — Fellow, Royal Australasian College of Physicians' },
  { code: 'FRCPC', name: 'FRCPC — Fellow, Royal College of Physicians of Canada' },
  { code: 'FCPS', name: 'FCPS — Fellow, College of Physicians & Surgeons' },
  { code: 'EUR_SPEC', name: 'European specialist qualification (CCT/equivalent)' },

  // ── Dental ────────────────────────────────────────────────────────────────
  { code: 'BDS', name: 'BDS — Bachelor of Dental Surgery' },
  { code: 'MDS', name: 'MDS — Master of Dental Surgery' },
  { code: 'DDS', name: 'DDS — Doctor of Dental Surgery (US/Canada)' },
  { code: 'DMD', name: 'DMD — Doctor of Dental Medicine (US/Canada)' },

  // ── Traditional & complementary ───────────────────────────────────────────
  { code: 'BAMS', name: 'BAMS — Ayurvedic Medicine & Surgery' },
  { code: 'BHMS', name: 'BHMS — Homeopathic Medicine & Surgery' },
  { code: 'BUMS', name: 'BUMS — Unani Medicine & Surgery' },
  { code: 'BSMS', name: 'BSMS — Siddha Medicine & Surgery' },
  { code: 'BNYS', name: 'BNYS — Naturopathy & Yogic Sciences' },
  { code: 'DC_CHIRO', name: 'DC — Doctor of Chiropractic' },
  { code: 'LAC_TCM', name: 'L.Ac. — Licensed Acupuncturist / TCM' },

  // ── Mental & behavioural health ───────────────────────────────────────────
  { code: 'PSYD', name: 'PsyD — Doctor of Psychology' },
  { code: 'MPHIL_CLIN_PSY', name: 'MPhil Clinical Psychology' },
  { code: 'MA_PSYCH', name: 'Master of Psychology / Counselling' },
  { code: 'MSW', name: 'MSW — Master of Social Work' },

  // ── Allied health ─────────────────────────────────────────────────────────
  { code: 'BPT', name: 'BPT — Bachelor of Physiotherapy' },
  { code: 'MPT', name: 'MPT — Master of Physiotherapy' },
  { code: 'DPT', name: 'DPT — Doctor of Physical Therapy (US)' },
  { code: 'BOT', name: 'BOT — Bachelor of Occupational Therapy' },
  { code: 'MOT', name: 'MOT — Master of Occupational Therapy' },
  { code: 'SLP', name: 'Speech & Language Pathology degree' },
  { code: 'AUD', name: 'AuD — Doctor of Audiology' },
  { code: 'BOPTOM', name: 'Optometry degree (BOptom / OD)' },
  { code: 'RD_DIET', name: 'Registered Dietitian / Nutrition degree' },
  { code: 'RRT_RESP', name: 'Respiratory therapy qualification' },
  { code: 'DPM_POD', name: 'DPM — Doctor of Podiatric Medicine' },
  { code: 'DMLT', name: 'DMLT — Medical Laboratory Technology' },
  { code: 'BMLT', name: 'BMLT — Bachelor of Medical Lab Technology' },
  { code: 'BSC_RADIO', name: 'Radiography / Medical Imaging degree' },

  // ── Nursing ───────────────────────────────────────────────────────────────
  //
  // Present as CREDENTIALS only. Nursing is deliberately absent from the
  // clinical taxonomy, where a nurse's grade is a `designations` row instead.
  { code: 'BSC_NURSING', name: 'BSc Nursing' },
  { code: 'MSC_NURSING', name: 'MSc Nursing' },
  { code: 'GNM', name: 'GNM — General Nursing & Midwifery' },
  { code: 'ANM', name: 'ANM — Auxiliary Nurse Midwife' },
  { code: 'RN', name: 'RN — Registered Nurse' },
  { code: 'NP_ADV', name: 'Nurse Practitioner / Advanced Practice Nurse' },
  { code: 'MIDWIFERY', name: 'Midwifery qualification' },

  // ── Pharmacy ──────────────────────────────────────────────────────────────
  { code: 'BPHARM', name: 'B.Pharm' },
  { code: 'MPHARM', name: 'M.Pharm' },
  { code: 'DPHARM', name: 'D.Pharm' },
  { code: 'PHARMD', name: 'PharmD — Doctor of Pharmacy' },
];
