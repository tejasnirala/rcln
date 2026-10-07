# Consultation charts — regions, recording and motion

Spec for the chart workspace on the **Consultation** page (Paper:
`Clinic › Consultation`). It is the visit screen of `/appointments/[id]`, moved
to its own design page. Not a new route.

Status: **proposed** — design only, nothing built. Builds on CE-6 (visual
mapping): `visual_maps`, `visual_regions`, `clinical_findings`,
`encounter_procedures.visual_region_id`.

## 0. Page layout (decided 2026-10-06)

One vertical page, not tabs. Order: Last time · Reason · Vitals · Consultation
(the template's sections, in the template's order — the full set is the 14
`consultationSectionType` values: chief complaint, symptoms, history,
examination, chart, diagnosis, procedures/treatment, prescription,
investigations, advice, referral, notes, attachments, follow-up) · nothing else. A doctor sees only the sections the template for their specialty
switches on (Admin › Consultation templates). Vitals are not a section. No billing, invoice or appointment booking on the doctor's page: the Follow-up section puts the patient on the recall list and the front desk books.
A section strip pinned under the patient header jumps to each section
and underlines the one in view, with counts; Saved and **Sign** sit at its right.
Diagnoses and procedures show the chart entry numbers they cover.
The Chart section is one layout on every chart: image, then **On this chart**
(numbered list: No · Area · Seen · one chart-specific column) on the left; the
**inspector** for the open entry on the right (area, What you see, What it
means, What you do). Clicking a marker or a row opens it in the inspector.
CN2–CN4 are close-ups of this section, not separate screens.
Diagnosis and Procedures sections and the inspector show the SAME records: the
sections list the whole visit (including items on another chart or on none);
the inspector filters them to the open area. Area numbers in the sections open
that entry; inspector items say "also on areas … · see Diagnosis ↓"; linking a
diagnosis in the inspector offers the visit's existing ones first.
Signed state: read-only text, no add buttons, a signed banner, and **Start an
amendment** for holders of `clinical.encounter.amend` only. Paper: CN8 / CN8b.

**Past visits** (CN9, CN9b). "Past visits · n" in the patient header and "All
past visits" on the Last time card open a right-hand sheet over the consultation
(the draft stays put). Same data as `/patients/[id]/visit-history`: journeys
(clinical episodes) newest first, and visits inside each also latest first
(decided 2026-10-06; the code currently orders them oldest-first), with date in
the branch's zone, appointment number or "Walk-in · no booking", doctor,
diagnoses (or the chief complaint), status and counts. "Read the consultation"
opens that visit's signed page read-only under a dark bar: "You're reading a
past visit", older / newer, and "Back to today's consultation". "Open as a
page" goes to the full visit-history route. The header's old "History" is
renamed "Record history" (the DS 08 change log) so the two are not confused.

Journeys follow `.kb/Consultation/FOLLOW_UP_ARCHITECTURE.md`: a follow-up joins
its parent's journey; a fresh booking opens a new one, even for the same
diagnosis. Each visit row says how it got there — "First visit · opened this
journey", "Walk-in", or "Follow-up of 14 Sep" (`parent_appointment_id`). Each
journey shows its date range. A journey whose diagnosis also appears in an
earlier, separate journey shows "Had this before · Mar – May 2023 ↓" — a link
between two journeys, never a merge.

## 1. Who sees it

| Holds                        | Sees                                                 | Default roles (matrix)                        |
| ---------------------------- | ---------------------------------------------------- | --------------------------------------------- |
| `clinical.encounter.read`    | The workspace read-only: charts, marks, the ledger   | Owner, org admin, branch admin, doctor, nurse |
| `clinical.encounter.create`  | Records findings, diagnoses and procedures on charts | Doctor                                        |
| `clinical.encounter.close`   | Ends and signs the consultation                      | Doctor                                        |
| `clinical.encounter.amend`   | Changes a signed consultation (an amendment)         | Doctor                                        |
| `clinical.prescription.sign` | Signs the prescription                               | Doctor                                        |
| none of the above            | Not linked, and the API refuses                      | Receptionist, lab, pharmacist, accountant     |

Invariant 7 holds: only DOCTOR authors by default; a clinic widens it by
cloning a role or granting a code.

Which charts appear: a map is offered when its `specialty_id` is the
consulting doctor's specialty or one of its ancestors, or is NULL (the body
chart is everyone's). The template's `VISUAL_MAPPING` sections still decide
what a consultation shows; the tab strip only switches between them.

| Chart    | Map code                  | Offered to                                                                           |
| -------- | ------------------------- | ------------------------------------------------------------------------------------ |
| Teeth    | `HUMAN_DENTAL` (extended) | `DEN` and below (Orthodontics, …)                                                    |
| Scalp    | `HUMAN_SCALP` (replaced)  | `DERMATOLOGY` and below (Trichology, Cosmetology)                                    |
| Body     | `HUMAN_BODY` (replaced)   | Everyone (no specialty)                                                              |
| Skeleton | `HUMAN_SKELETON` (new)    | `ORTHOPAEDICS` and below (Spine, Hand, Paeds)                                        |
| Muscles  | `HUMAN_MUSCULAR` (new)    | `PHYSIOTHERAPY` and below, `SPORTS_MEDICINE`, `RHEUMATOLOGY`, `PAIN_MEDICINE`, `REH` |

A map has one `specialty_id`, so Muscles needs either one row per specialty or
a map-to-specialty join table (`visual_map_specialties`) — the join table, per
ADR-0006, since five specialties share one drawing.

## 1a. How the charts are drawn

- **Teeth are vector.** The dental charts (permanent, primary, mixed) are SVG
  built from one approved vector tooth set, so they stay sharp at any zoom.
  Every tooth is its own shape; selecting it **recolours the whole tooth**, and
  findings tint it the same way in their own colour.
- **Everything else is a realistic image** (decided 2026-10-07): body, face,
  scalp views, skeleton and its detail views, muscles. Vector traces of these
  were tried and were less realistic, or failed outright. Ship them as
  high-resolution raster (2× / 3× variants for dense screens) with region marks
  drawn over the image from each region's geometry.
- **Image charts are a reference, not a control** (decided 2026-10-06). Only
  teeth are picked by tapping. On every image chart (body, scalp, skeleton,
  muscles, and any future eye, ear, gut, liver…) entries are added through
  **+ Add finding**, and the image shows them as **numbered markers** at each
  region's preset `label_x/label_y`. Tapping a marker opens its entry; the list
  beside the image is the primary way in. Tapping a small area on a picture is
  too inaccurate on every device.
- **The Add finding picker is one component for every chart**, driven by data:
  1. _Where_ — search plus a drill-down over the chart's region tree
     (`Body › Left upper limb › Forearm, volar`), a Left / Right switch so the
     tree is not doubled, recent and specialty-common regions first, several
     regions at once.
  2. _What you see_ — finding term, severity, then the chart's own qualifiers
     (`visual_maps.qualifiers`: pain score, lesion type, loss %…).
  3. _What it means_ — link to a diagnosis. 4. _What you do_ — add a procedure.

  A new chart needs an image, its region tree and marker positions; no new
  screen.

- **Markers live in the image's pixel coordinates** (`view_box` = image size),
  so they scale with the picture on every screen. Each view is its own whole
  image; a device-specific crop would need its own coordinates.
- **Future: Mark exact spot** (optional step after the picker). Shows the chosen
  part as a close-up filling the screen (forearm, hand, one finger) and takes
  one tap. Rules:
  - One consistent art source for every close-up. Candidate: Servier Medical
    Art (CC BY 4.0, credit line in app); confirm files and terms before use.
    Only CC0 / public domain / CC BY; never personal-use-only or stock licences
    that forbid in-product use. Generated close-ups in the main images' style
    are an equal option; vector is not required.
  - The spot is stored relative to the part's own drawing plus the region code
    (in the finding's `metadata`), so it lands the same on any screen. Left
    and right share one drawing, mirrored.
- **Realistic, not diagrammatic**, in one consistent style across the charts.

State palette (fill multiplies over the part's own shading, so the anatomy
stays readable):

| State    | Fill                      | Edge                         |
| -------- | ------------------------- | ---------------------------- |
| Selected | `#2F6FD6` at 55 %         | ink `#0F1C24`, 3 px          |
| Finding  | signal `#C27A2C` at 50 %  | signal, 2 px                 |
| Planned  | teal `#4FA3B3` at 42 %    | drape `#1E5E6A`, 2 px dashed |
| Done     | success `#1A6B47` at 42 % | success, 2 px                |
| Hover    | `#CFE2E6` at 55 %         | ink at 35 %, 1.5 px          |
| Missing  | none (part ghosted)       | control `#7F8C93`, dashed    |

`#2F6FD6` and `#4FA3B3` are new tokens (`--color-select`, `--color-planned`).

## 2. The flow, the same on every chart

**Select area → What you see (finding) → What it means (diagnosis) → What you
do (procedure)**

| Step      | Stored as                                                  | Fields (existing contracts)                                                                 |
| --------- | ---------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| Area      | `visual_region_id`                                         | region code + label; derived classification (e.g. "lower left first molar")                 |
| Finding   | `clinical_findings` row                                    | term (`FINDING_TYPE`), severity, notes, qualifiers (`metadata`)                             |
| Diagnosis | `encounter_diagnoses` + finding.`diagnosisId` ("Explains") | term or own words, role, certainty, notes                                                   |
| Procedure | `encounter_procedures` with `visualRegionId`               | term, status (Planned / Performed / Cancelled), performed on, treats (`diagnosisId`), notes |

One area can carry several findings and several procedures. Several areas can
be selected at once (both knees, 36 + 37) and a finding is written to each.

## 3. Regions

All codes are flat (`^[A-Z][A-Z0-9_]*$`), stable for ever, and unique within
their map. Laterality is always the **patient's** side: `_R` / `_L`. Groups are
regions with no geometry (`parentId`), as today.

**Level of detail.** Small structures (tooth surfaces aside) are real regions
drawn in the same coordinate space, but only shown once the camera is zoomed
in. A region's geometry gains an optional `lod` (1 = always, 2 = zoomed to its
group, 3 = zoomed to a detail). This is the one change to the geometry grammar
in `@rcln/clinical`'s `regions.ts`; no schema change.

### 3.1 Teeth — `HUMAN_DENTAL` (extended)

Basis: FDI two-digit notation (ISO 3950), as seeded.

- **Permanent, 32**: `TOOTH_11`–`TOOTH_18`, `_21`–`_28`, `_31`–`_38`, `_41`–`_48`.
  Groups `QUADRANT_1`–`QUADRANT_4` (kept).
- **Primary, 20 (new)**: `TOOTH_51`–`_55`, `_61`–`_65`, `_71`–`_75`, `_81`–`_85`.
  Groups `QUADRANT_5`–`QUADRANT_8`. The chart shows Permanent / Primary / Mixed.
- **Three drawings, one map.** Permanent (32, about 12 years and up), Primary
  (20, about 6 months to 6 years) and Mixed (about 6 to 12 years: erupted
  permanent incisors and first molars beside the remaining primary canines and
  molars). Unerupted successors (13–15, 23–25, 33–35, 43–45) are **hidden by
  default** behind a "Show developing teeth" switch; one that carries a finding
  (e.g. 35 agenesis) is always shown, faint with a dashed edge in the finding
  colour. With the switch on, all are drawn faint and selectable. Mixed is not
  a fixed set: the chart draws whichever tooth is present, from the findings
  `erupted` / `unerupted` / `exfoliated`, so one child's chart moves from
  Primary to Permanent over the years without changing map.
- **Art source (Paper, CN1 / CN1b / CN1c).** One approved vector set of 14
  tooth shapes (11–17, 41–47). Every other tooth is that art placed with a
  transform: the left side mirrored, third molars 18/28/38/48 as 17/47 at 88 %,
  milk teeth as the matching type at 72–84 %, developing successors at 20 %
  opacity. Implement by exporting these SVGs, not redrawing them.
- **Sextants (new, groups, for BPE / CPI)**: `SEXTANT_1` 18–14, `SEXTANT_2`
  13–23, `SEXTANT_3` 24–28, `SEXTANT_4` 38–34, `SEXTANT_5` 33–43, `SEXTANT_6`
  44–48. A sextant is a second grouping, so it lives in qualifiers, not
  `parentId` (one parent per region).
- **Oral soft tissue (new, 16)**: `LIP_UPPER`, `LIP_LOWER`, `COMMISSURE_R/L`,
  `BUCCAL_MUCOSA_R/L`, `GINGIVA_UPPER`, `GINGIVA_LOWER`, `PALATE_HARD`,
  `PALATE_SOFT`, `TONGUE_DORSUM`, `TONGUE_VENTRAL`, `TONGUE_LATERAL_R/L`,
  `FLOOR_OF_MOUTH`, `OROPHARYNX`, plus `TMJ_R/L`. Group `ORAL_SOFT_TISSUE`.

Classification is **derived from the code**, never stored: quadrant, arch,
dentition, and type (central incisor, lateral incisor, canine, first/second
premolar, first/second/third molar; primary: incisor, canine, first/second
molar).

Tooth qualifiers (`finding.metadata`):

| Key           | Values                                                                                                                      |
| ------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `surfaces`    | any of `M` mesial, `D` distal, `O` occlusal / `I` incisal, `B` buccal / `F` facial, `L` lingual / `P` palatal, `C` cervical |
| `roots`       | any of `MB`, `DB`, `P`, `M`, `D`, `SINGLE` — depends on tooth type                                                          |
| `mobility`    | `0`, `I`, `II`, `III` (Miller)                                                                                              |
| `furcation`   | `0`, `I`, `II`, `III` (Glickman), molars only                                                                               |
| `pocketsMm`   | 6 sites: `MB`, `B`, `DB`, `ML`, `L`, `DL`, each 0–15                                                                        |
| `recessionMm` | same 6 sites                                                                                                                |
| `bleeding`    | the sites that bled on probing                                                                                              |

Typical finding terms (clinic vocabulary, seeded as `FINDING_TYPE`): sound,
caries, restoration, crown, bridge abutment, pontic, implant, root canal
treated, missing, extracted, unerupted, impacted, root stump, fracture,
periapical lesion, attrition, abrasion, erosion, fluorosis, hypoplasia,
sensitivity, mobility, calculus.

### 3.2 Scalp and hair — `HUMAN_SCALP` (replaced, 5 views)

Basis: the four SALT-score views (top 40 %, back 24 %, each side 18 %) used
for alopecia areata, plus the zones of Norwood–Hamilton and Ludwig grading,
plus facial hair. Every region sits in exactly one view.

| View (group) | Regions                                                                                                                           |
| ------------ | --------------------------------------------------------------------------------------------------------------------------------- |
| `VIEW_TOP`   | `HAIRLINE_FRONTAL`, `TEMPORAL_RECESSION_R`, `TEMPORAL_RECESSION_L`, `FRONTAL`, `MID_SCALP`, `VERTEX`, `CROWN_WHORL` (lod 2)       |
| `VIEW_BACK`  | `OCCIPITAL_UPPER`, `OCCIPITAL_LOWER` (donor), `NAPE`, `NAPE_HAIRLINE`                                                             |
| `VIEW_RIGHT` | `PARIETAL_R`, `TEMPORAL_R`, `SIDEBURN_R`, `RETROAURICULAR_R`, `DONOR_LATERAL_R`                                                   |
| `VIEW_LEFT`  | `PARIETAL_L`, `TEMPORAL_L`, `SIDEBURN_L`, `RETROAURICULAR_L`, `DONOR_LATERAL_L`                                                   |
| `VIEW_FACE`  | `EYEBROW_R`, `EYEBROW_L`, `EYELASHES_R`, `EYELASHES_L`, `MOUSTACHE`, `BEARD_CHEEK_R`, `BEARD_CHEEK_L`, `BEARD_CHIN`, `BEARD_NECK` |

28 regions, up from 9. The safe donor area is `OCCIPITAL_LOWER` +
`DONOR_LATERAL_R/L`, shown as a hatched overlay, not a fourth kind of region.

Qualifiers:

| Key             | Values                                                                                                                                                |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pattern`       | scale + grade: `NORWOOD` I, II, IIa, III, IIIa, III vertex, IV, IVa, V, Va, VI, VII; `LUDWIG` I–III; `SINCLAIR` 1–5                                   |
| `lossPercent`   | 0–100, per region; the SALT score is computed, not typed                                                                                              |
| `densityPerCm2` | hairs / cm² (trichoscopy)                                                                                                                             |
| `pullTest`      | positive / negative                                                                                                                                   |
| `trichoscopy`   | signs: yellow dots, black dots, exclamation-mark hairs, broken hairs, miniaturisation, perifollicular scaling, peripilar sign, honeycomb pigmentation |
| `scalp`         | oily / dry / normal; scaling: none / mild / moderate / severe; erythema: same                                                                         |

The pattern grade belongs to the whole scalp, not one zone, so it is recorded
on `VIEW_TOP` — a group may carry a finding.

### 3.3 Body — `HUMAN_BODY` (replaced)

Basis: surface anatomy regions used for dermatology body maps and burn charts
(Lund–Browder), with the nine abdominal regions. Two figures, front and back,
plus zoom details for the hands, feet and face. Neutral figure; one map for
all sexes.

| Group                     | Front (`ANT_`)                                                                                                                    | Back (`POST_`)                                                             |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| Head (lod 1 / face lod 3) | `SCALP`, `FOREHEAD`, `TEMPLE_R/L`, `PERIORBITAL_R/L`, `NOSE`, `CHEEK_R/L`, `EAR_R/L`, `LIP_UPPER`, `LIP_LOWER`, `CHIN`, `JAW_R/L` | `SCALP_POSTERIOR`, `OCCIPUT`, `EAR_POSTERIOR_R/L`                          |
| Neck                      | `NECK_ANTERIOR`, `NECK_LATERAL_R/L`                                                                                               | `NECK_POSTERIOR`                                                           |
| Shoulder                  | `SHOULDER_R/L`                                                                                                                    | `SHOULDER_POSTERIOR_R/L`                                                   |
| Chest                     | `CHEST_R/L`, `STERNAL`, `BREAST_R/L`, `AXILLA_R/L`                                                                                | `SCAPULAR_R/L`, `INTERSCAPULAR`                                            |
| Abdomen (9)               | `HYPOCHONDRIAC_R/L`, `EPIGASTRIC`, `LUMBAR_R/L`, `UMBILICAL`, `ILIAC_R/L`, `HYPOGASTRIC`                                          | `MID_BACK_R/L`, `FLANK_R/L`, `LOW_BACK_R/L`                                |
| Pelvis                    | `GROIN_R/L`, `PUBIC`, `GENITAL`                                                                                                   | `SACRAL`, `BUTTOCK_R/L`, `PERIANAL`                                        |
| Upper limb, each side     | `UPPER_ARM_ANT`, `ANTECUBITAL`, `FOREARM_VOLAR`, `WRIST_VOLAR`, `PALM`                                                            | `UPPER_ARM_POST`, `ELBOW`, `FOREARM_DORSAL`, `WRIST_DORSAL`, `HAND_DORSUM` |
| Hand detail (lod 3)       | `THUMB`, `FINGER_INDEX`, `FINGER_MIDDLE`, `FINGER_RING`, `FINGER_LITTLE` (palmar)                                                 | same five, dorsal, plus `NAILS`                                            |
| Lower limb, each side     | `HIP`, `THIGH_ANT`, `KNEE_ANT`, `SHIN`, `ANKLE_ANT`, `FOOT_DORSUM`                                                                | `THIGH_POST`, `POPLITEAL`, `CALF`, `ANKLE_POST`, `HEEL`                    |
| Foot detail (lod 3)       | `TOE_GREAT`, `TOES_2_5` (dorsal)                                                                                                  | `SOLE_FORE`, `SOLE_MID`, `SOLE_HEEL`, toenails                             |

Codes read `ANT_FOREARM_VOLAR_R`, `POST_SOLE_HEEL_L`, and so on: about 150 regions, up from 24. Groups
(`HEAD`, `NECK`, `TRUNK`, `UPPER_LIMB_R`, …) are what the figure shows at the
first zoom level; a tap on a group zooms into it.

Qualifiers:

| Key            | Values                                                                                                    |
| -------------- | --------------------------------------------------------------------------------------------------------- |
| `morphology`   | macule, patch, papule, plaque, nodule, vesicle, bulla, pustule, wheal, erosion, ulcer, scar, crust, scale |
| `sizeMm`       | longest diameter                                                                                          |
| `count`        | single, few (2–5), multiple, numerous                                                                     |
| `distribution` | localised, grouped, linear, annular, dermatomal, symmetrical, generalised                                 |
| `colour`       | erythematous, hyperpigmented, hypopigmented, violaceous, skin-coloured                                    |
| `bsaPercent`   | body-surface area involved; the total is computed                                                         |
| `pain`         | 0–10, and type: sharp, dull, burning, radiating                                                           |

### 3.4 Skeleton — `HUMAN_SKELETON` (new)

Basis: bones and joints as an orthopaedic surgeon records them; long bones
split into proximal, shaft and distal segments, as the AO/OTA fracture
classification does (segment 1, 2, 3). Front and back figures, plus zoom
details for the spine, hands and feet.

| Group          | Regions                                                                                                                                                                                                                                                                    |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Skull          | `CRANIUM_FRONTAL`, `CRANIUM_PARIETAL_R/L`, `CRANIUM_TEMPORAL_R/L`, `CRANIUM_OCCIPITAL`, `MAXILLA`, `MANDIBLE`, `ZYGOMA_R/L`, `NASAL`, `ORBIT_R/L`, `TMJ_R/L`                                                                                                               |
| Spine (detail) | `C1`–`C7`, `T1`–`T12`, `L1`–`L5`, `SACRUM`, `COCCYX`; discs `DISC_C2_C3` … `DISC_L5_S1` (lod 3); `SI_JOINT_R/L`                                                                                                                                                            |
| Thorax         | `MANUBRIUM`, `STERNUM_BODY`, `XIPHOID`, `RIB_1_R` … `RIB_12_L`, `CLAVICLE_R/L`, `SCAPULA_R/L`                                                                                                                                                                              |
| Shoulder       | `SHOULDER_GH_R/L` (glenohumeral), `AC_JOINT_R/L`, `SC_JOINT_R/L`                                                                                                                                                                                                           |
| Arm            | `HUMERUS_PROX`, `HUMERUS_SHAFT`, `HUMERUS_DIST`, `ELBOW`, `RADIUS_PROX`, `RADIUS_SHAFT`, `RADIUS_DIST`, `ULNA_PROX` (olecranon), `ULNA_SHAFT`, `ULNA_DIST`, `WRIST` — each `_R/_L`                                                                                         |
| Hand (detail)  | carpals `SCAPHOID`, `LUNATE`, `TRIQUETRUM`, `PISIFORM`, `TRAPEZIUM`, `TRAPEZOID`, `CAPITATE`, `HAMATE`; `MC_1`–`MC_5`; phalanges `PP_1`–`PP_5`, `MP_2`–`MP_5`, `DP_1`–`DP_5` — each `_R/_L`                                                                                |
| Pelvis         | `ILIUM_R/L`, `ISCHIUM_R/L`, `PUBIS_R/L`, `PUBIC_SYMPHYSIS`, `ACETABULUM_R/L`, `HIP_R/L`                                                                                                                                                                                    |
| Leg            | `FEMUR_HEAD_NECK`, `FEMUR_TROCHANTERIC`, `FEMUR_SHAFT`, `FEMUR_DIST`, `PATELLA`, `KNEE_MEDIAL`, `KNEE_LATERAL`, `KNEE_PF`, `TIBIA_PLATEAU`, `TIBIA_SHAFT`, `TIBIA_PLAFOND`, `MEDIAL_MALLEOLUS`, `FIBULA_HEAD`, `FIBULA_SHAFT`, `LATERAL_MALLEOLUS`, `ANKLE` — each `_R/_L` |
| Foot (detail)  | `TALUS`, `CALCANEUS`, `NAVICULAR`, `CUBOID`, `CUNEIFORM_MED`, `CUNEIFORM_INT`, `CUNEIFORM_LAT`, `MT_1`–`MT_5`, `PP_1`–`PP_5`, `MP_2`–`MP_5`, `DP_1`–`DP_5` — each `_R/_L`, prefixed `FOOT_`                                                                                |

About 330 regions. The full figure shows bones at lod 1 (skull, spine as one
column, ribcage, each long bone whole); segments, joints, vertebrae, carpals
and phalanges appear at lod 2 and 3.

Qualifiers:

| Key        | Values                                                                                                                                                                                                        |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `fracture` | pattern: transverse, oblique, spiral, comminuted, segmental, greenstick, avulsion, impacted, stress; `open` yes/no; `displacement` none / minimal / displaced / angulated; `aoCode` (free text, e.g. `42-A2`) |
| `joint`    | effusion, instability, crepitus, locking; ROM limited by % (0–100)                                                                                                                                            |
| `pain`     | 0–10, on rest / movement / palpation                                                                                                                                                                          |
| `implant`  | plate, screw, nail, wire, arthroplasty, external fixator                                                                                                                                                      |
| `imaging`  | X-ray, CT, MRI, ultrasound — what the finding was seen on                                                                                                                                                     |

### 3.5 Muscles — `HUMAN_MUSCULAR` (new)

Basis: the superficial muscles a physiotherapist or sports physician palpates
and grades, front and back, with the deep layer one zoom level down. Every
muscle is `_R` / `_L` except the midline ones. About 160 regions.

| Group            | Front (`ANT_`)                                                                                                                                                    | Back (`POST_`)                                                                                                                                                                                            |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Head and neck    | `FRONTALIS`, `TEMPORALIS`, `MASSETER`, `ORBICULARIS_ORIS`, `STERNOCLEIDOMASTOID`, `SCALENES`, `PLATYSMA`                                                          | `OCCIPITALIS`, `SPLENIUS_CAPITIS`, `LEVATOR_SCAPULAE`, `SUBOCCIPITALS` (lod 3)                                                                                                                            |
| Shoulder         | `DELTOID_ANTERIOR`, `DELTOID_LATERAL`, `PECTORALIS_MINOR` (lod 3)                                                                                                 | `DELTOID_POSTERIOR`, `SUPRASPINATUS`, `INFRASPINATUS`, `TERES_MINOR`, `TERES_MAJOR`, `SUBSCAPULARIS` (lod 3)                                                                                              |
| Chest / back     | `PECTORALIS_MAJOR_CLAVICULAR`, `PECTORALIS_MAJOR_STERNAL`, `SERRATUS_ANTERIOR`                                                                                    | `TRAPEZIUS_UPPER`, `TRAPEZIUS_MIDDLE`, `TRAPEZIUS_LOWER`, `RHOMBOIDS` (lod 2), `LATISSIMUS_DORSI`, `ERECTOR_SPINAE_THORACIC`, `ERECTOR_SPINAE_LUMBAR`, `QUADRATUS_LUMBORUM` (lod 3), `MULTIFIDUS` (lod 3) |
| Abdomen          | `RECTUS_ABDOMINIS_UPPER`, `RECTUS_ABDOMINIS_LOWER`, `EXTERNAL_OBLIQUE`, `INTERNAL_OBLIQUE` (lod 3), `TRANSVERSUS_ABDOMINIS` (lod 3)                               | `EXTERNAL_OBLIQUE_POSTERIOR`                                                                                                                                                                              |
| Arm              | `BICEPS_BRACHII`, `BRACHIALIS`, `CORACOBRACHIALIS`                                                                                                                | `TRICEPS_LONG`, `TRICEPS_LATERAL`, `TRICEPS_MEDIAL`, `ANCONEUS`                                                                                                                                           |
| Forearm and hand | `BRACHIORADIALIS`, `PRONATOR_TERES`, `FLEXOR_CARPI_RADIALIS`, `PALMARIS_LONGUS`, `FLEXOR_CARPI_ULNARIS`, `FLEXOR_DIGITORUM_SUPERFICIALIS`, `THENAR`, `HYPOTHENAR` | `EXTENSOR_CARPI_RADIALIS`, `EXTENSOR_DIGITORUM`, `EXTENSOR_CARPI_ULNARIS`, `SUPINATOR` (lod 3), `DORSAL_INTEROSSEI` (lod 3)                                                                               |
| Hip and pelvis   | `ILIOPSOAS`, `TENSOR_FASCIAE_LATAE`, `PECTINEUS`                                                                                                                  | `GLUTEUS_MAXIMUS`, `GLUTEUS_MEDIUS`, `GLUTEUS_MINIMUS` (lod 3), `PIRIFORMIS` (lod 3)                                                                                                                      |
| Thigh            | `RECTUS_FEMORIS`, `VASTUS_LATERALIS`, `VASTUS_MEDIALIS`, `VASTUS_INTERMEDIUS` (lod 3), `SARTORIUS`, `ADDUCTOR_LONGUS`, `ADDUCTOR_MAGNUS`, `GRACILIS`              | `BICEPS_FEMORIS`, `SEMITENDINOSUS`, `SEMIMEMBRANOSUS`, `ILIOTIBIAL_BAND`                                                                                                                                  |
| Leg and foot     | `TIBIALIS_ANTERIOR`, `FIBULARIS_LONGUS`, `EXTENSOR_DIGITORUM_LONGUS`, `EXTENSOR_HALLUCIS_LONGUS`                                                                  | `GASTROCNEMIUS_MEDIAL`, `GASTROCNEMIUS_LATERAL`, `SOLEUS`, `ACHILLES_TENDON`, `PLANTAR_FASCIA` (lod 3)                                                                                                    |

Qualifiers:

| Key           | Values                                                  |
| ------------- | ------------------------------------------------------- |
| `strain`      | grade I, II, III; `tear` partial / complete             |
| `strengthMrc` | 0–5 (Medical Research Council scale)                    |
| `tone`        | normal, spasm, hypertonic, flaccid                      |
| `palpation`   | tenderness, trigger point, taut band, swelling, wasting |
| `rom`         | movement limited by % (0–100), and which movement       |
| `pain`        | 0–10, on rest / contraction / stretch                   |

## 4. Selection motion — "the Lens"

> **Revised:** the Lens is no longer an outline drawn over the anatomy. The
> selected part itself recolours (see §1a). The motion below keeps its timings,
> but "the Lens glides and morphs" now means the selection colour travels from
> the last part into the new one: the old part fades back to its natural colour
> as the new one floods in from the tap point, clipped to its own shape.

The signature: **one selection outline that travels.** There is a single
Lens on the canvas, not one highlight per region. Selecting a region moves
the Lens to it and morphs its outline into the region's shape, so moving
from 36 to 37, or from the knee to the shin, reads as one continuous gesture.

| Moment        | What moves                                                                                                                                             | Timing                                     |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------ |
| Hover         | Region fills to `card`, its label appears beside the pointer                                                                                           | 120 ms ease-out                            |
| Press         | Region scales to 0.97 around its centre                                                                                                                | 80 ms                                      |
| Select        | Fill floods outward **from the tap point** (radial clip) in `drape-tint`; the Lens glides from the last region and morphs to this outline (2 px `ink`) | 280 ms, spring (stiffness 320, damping 30) |
| Settle        | One soft ring breathes out from the outline and fades                                                                                                  | 520 ms, once, never loops                  |
| Focus         | Everything else dims to 55 % and desaturates; marks on other regions stay at full strength                                                             | 200 ms                                     |
| Camera        | Canvas eases so the region sits centre-left of the inspector; zooms only when the region is below 24 px on screen (teeth, fingers, vertebrae)          | 420 ms spring                              |
| Reveal detail | Sub-regions (lod 2/3) fade and rise 4 px, staggered by 18 ms                                                                                           | 160 ms each                                |
| Inspector     | The region's name lifts off the canvas and lands as the inspector heading (shared element); fields stagger in                                          | 320 ms; fields 30 ms apart                 |
| Record        | The mark drops onto the region: 0 → 1.15 → 1, in the finding's colour; the count ticks                                                                 | 240 ms spring                              |
| Multi-select  | Shift-tap or drag a lasso; each added region gets its own Lens, the first one leads                                                                    | 60 ms stagger                              |
| Keyboard      | Arrow keys move to the anatomical neighbour (next tooth, next vertebra); the Lens slides                                                               | same as Select                             |
| Deselect      | Reverse, faster                                                                                                                                        | 180 ms                                     |

Rules:

- Under 450 ms end to end, and input is never blocked by an animation.
- Motion never hides clinical data: marks are not dimmed, and the inspector
  shows the existing findings in the first frame.
- `prefers-reduced-motion`: no camera, scale or ripple. Fill and outline
  appear at once; the inspector cross-fades in 120 ms.
- Only `transform`, `opacity` and `clip-path` animate; outlines morph with an
  SVG path tween. The geometry is already in the region rows.

## 5. What this asks of the build

0. Imagery: every chart is a realistic anatomical illustration with region
   overlays, never boxes or a hand-drawn diagram. That is the existing
   `IMAGE_MAP` renderer: the picture is the map's `asset_key`, and each region's
   geometry is the hotspot over it. Detail views (knee, hand, spine, the four
   scalp views, the face) are their own assets on the same map. Paper frames
   CN1–CN4 use generated placeholders; production needs licensed or
   commissioned art in one consistent style.
1. Grammar: `lod` on region geometry (`@rcln/clinical` `regions.ts`), plus
   optional `labelAnchor` per region (exists). No Prisma change.
2. Seed: extend `HUMAN_DENTAL`, replace `HUMAN_SCALP` and `HUMAN_BODY` region
   rows, add `HUMAN_SKELETON`. Old codes that are removed (`FRONTAL`,
   `ANT_ARM_R`, …) are **kept, inactive**, never deleted: findings reference
   them (`onDelete: Restrict`) and history must still render. They become
   groups of the new detailed regions where they map one to many.
3. Qualifier schemas per map, so the inspector knows which qualifier fields to
   draw. Proposal: a `qualifiers` document on the map (JSONB, configuration,
   no PHI), validated in `@rcln/clinical`. This is the one new column —
   `visual_maps.qualifiers`. Needs `/db-migration`.
4. Finding terms: seed the `FINDING_TYPE` words listed under each chart.
5. Web: the generic renderer gains camera, lod and the Lens; no per-chart
   component (CE-7's rule).
