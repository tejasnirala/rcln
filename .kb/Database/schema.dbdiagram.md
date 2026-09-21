// =============================================================================
// rcln — full database schema (dbdiagram.io / DBML)
// Generated from packages/db/prisma/schema/*.prisma — 2026-08-18
// 152 tables · 129 enums
//
// Paste the whole file into https://dbdiagram.io to render the ERD.
//
// Reading it:
//   - Tables are grouped by the schema file (domain) they live in; the
//     TableGroup blocks at the bottom reproduce that grouping in dbdiagram.
//   - `organization_id` is the tenant discriminator and is on every tenant
//     table. A NULLABLE `organization_id` means the table is
//     platform-extensible: a NULL row is shared catalogue/reference data
//     owned by nobody.
//   - Composite refs of the form `(organization_id, id)` are the composite
//     foreign keys that make a cross-tenant row unrepresentable (ADR-0004).
//   - Index sort direction (DESC), GIN/partial-index details and operator
//     classes are carried in each index note — DBML has no syntax for them.
//   - Soft delete is `deleted_at`, never a boolean.
// =============================================================================

Project rcln {
  database_type: 'PostgreSQL'
  Note: 'rcln — multi-tenant healthcare management SaaS. One organization is the tenant, one or many branches are the places. Tenant isolation is enforced in Postgres by row-level security, composite foreign keys and application scoping.'
}

// ---------------------------------------------------------------------------
// ENUMS
// ---------------------------------------------------------------------------

Enum MembershipStatus {
  INVITED
  ACTIVE
  SUSPENDED
}

Enum RoleScopeLevel {
  PLATFORM
  ORGANIZATION
  BRANCH
}

Enum OverrideEffect {
  GRANT
  DENY
}

// Whether a registration is currently good. ⚠️ IT IS A RECORDED FACT, NOT A COMPUTED ONE. `EXPIRED` is what the clinic marked; `expires_on` in the past is what the calendar says.
Enum ProfessionalRegistrationStatus {
  ACTIVE
  SUSPENDED [note: 'Suspended by the authority. Not a licence, and distinct from expired.']
  EXPIRED
}

// Should this reach a bill at all? ⚠️ SEPARATE FROM CONSUMPTION, WHICH IS THE WHOLE POINT (PI-ADR-005). "It left the shelf" and "somebody owes for it" are two facts, and a system that derives the second …
Enum ChargePolicy {
  NEVER_BILL [note: 'Consumed, never charged — gloves, disinfectant, the swab.']
  INCLUDED_IN_SERVICE [note: 'Consumed, and its cost is already inside a procedure or consultation fee']
  SEPARATELY_BILLABLE [note: 'Its own invoice line — a dispensed medicine, an implant.']
  OPTIONAL [note: 'A human decides, at the charge-review step. The request sits `PENDING` until they do, and no invoice may be raised from …']
  CONTRACT_DEFINED [note: 'The payer contract decides. ⚠️ THERE IS NO CONTRACT ENGINE, AND THIS RESOLVES TO A HUMAN DECISION EXACTLY AS `OPTIONAL` …']
  JURISDICTION_CONFIGURED [note: 'The regulatory or tax configuration decides. Same treatment and the same reason as `CONTRACT_DEFINED`.']
}

// Which tier of the precedence chain produced the policy on a charge request. ⚠️ SNAPSHOTTED ON THE REQUEST BESIDE THE POLICY ITSELF, so an old bill can still explain itself after the rules have been ed …
Enum ChargePolicyScope {
  PRODUCT [note: 'A rule naming this exact product.']
  PRODUCT_CATEGORY [note: 'A rule naming a category this product is in.']
  PRODUCT_TYPE [note: '''A rule naming this product's type.''']
  DEFAULT [note: 'No rule matched. `SEPARATELY_BILLABLE` for a medicine or a vaccine, `NEVER_BILL` for everything else']
}

// Where a charge request is. PENDING ──▶ INVOICED │ ├──▶ SUPPRESSED (policy said no, or a human said no) └──▶ CANCELLED (the supply it cites was reversed before billing) ⚠️ `SUPPRESSED` IS A TERMINAL SU …
Enum ChargeRequestStatus {
  PENDING [note: 'Waiting to be billed, or waiting for a human where the policy asked for one.']
  SUPPRESSED [note: 'Deliberately not billed. Carries the reason.']
  INVOICED [note: 'On an invoice. `invoice_id` is set, and it is written by `services/invoicing`.']
  CANCELLED [note: 'The supply behind it was undone before it reached a bill.']
}

// What kind of movement this request is the money side of. ⚠️ A REVERSAL IS NOT A NEGATIVE SUPPLY. Its quantity is POSITIVE and its direction is in this column, for the reason `stock_ledger` keeps the s …
Enum ChargeRequestKind {
  SUPPLY [note: 'Something was supplied. The ordinary case.']
  REVERSAL [note: 'Something came back. Reduces what is owed — by cancelling the original request where it was never billed, and by a CREDI …']
}

// What KIND of clinical word this is. ⚠️ ONE TABLE WITH A DISCRIMINATOR, NOT SEVEN TABLES (CD-5). This is the house pattern: `products` is one table with a `ProductType` discriminator over twelve types …
Enum ClinicalMasterKind {
  SYMPTOM [note: 'What the patient reports. "Hair fall", "Tooth pain".']
  DIAGNOSIS [note: 'What the clinician concludes. "Androgenetic alopecia", "Dental caries".']
  PROCEDURE [note: 'What is done about it. "Root canal treatment", "Chemical peel".']
  INVESTIGATION [note: 'What is ordered. "CBC", "OPG", "Biopsy". ⚠️ NOT A LAB TEST. The lab module does not exist (only its permission codes do) …']
  ADVICE [note: 'What the patient is told to do. "Brushing technique", "Sun protection".']
  HISTORY_ITEM [note: 'A structured history entry. "Diabetes mellitus", "Smoking", "Penicillin".']
  FINDING_TYPE [note: 'What is observed AT an anatomical region, for the visual map (CE-6). "Caries", "Mobility", "Erythema".']
}

// Whether a treatment journey is still running. Deliberately two states. "Abandoned" and "completed" are both CLOSED and the difference belongs in `closureReason`, not in the enum
Enum ClinicalEpisodeStatus {
  OPEN
  CLOSED
}

// Whether the patient is a person or an animal (CD-4). ⚠️ THE ONLY THING IN THE CONSULTATION ENGINE THAT BRANCHES ON THIS IS CARE CONTEXT RESOLUTION.
Enum CareSubjectType {
  HUMAN
  ANIMAL
}

// How long a clinical thing has been going on. ⚠️ DELIBERATELY NOT `FollowUpIntervalUnit`, WHICH IT RESEMBLES.
Enum ClinicalDurationUnit {
  HOURS
  DAYS
  WEEKS
  MONTHS
  YEARS
}

// How the complaint began. UNKNOWN is a real answer — the patient does not always know, and a NULL would say the clinician did not ask.
Enum ClinicalOnset {
  SUDDEN
  GRADUAL
  UNKNOWN
}

// The unit a follow-up interval is expressed in.
Enum FollowUpIntervalUnit {
  DAYS
  WEEKS
  MONTHS
}

// Why the patient is being asked back. Drives the recall list's grouping and nothing else — it is never an authorization or billing input.
Enum FollowUpType {
  ROUTINE
  PROCEDURE_REVIEW
  LAB_REVIEW
  POST_OPERATIVE
  OTHER
}

// Where a template version is in its life. ⚠️ A PUBLISHED VERSION IS IMMUTABLE IN EVERY FIELD, INCLUDING ITS DATES. `assertVersionIsDraft` guards every writer
Enum ConsultationTemplateStatus {
  DRAFT
  PUBLISHED
  RETIRED [note: 'Superseded. Kept, never deleted: encounters cite it, and the FK is what answers "how many consultations used v3".']
}

// The sections a consultation can be made of. ⚠️ THE AUTHORITATIVE COPY OF THIS SET IS `ConsultationSectionType` IN `packages/clinical/src/types.ts`, AND THE TWO ARE ASSERTED EQUAL BY A TYPE-LEVEL CHECK …
Enum ConsultationSectionType {
  CHIEF_COMPLAINT
  SYMPTOMS
  HISTORY
  EXAMINATION
  VISUAL_MAPPING
  DIAGNOSIS
  PROCEDURE
  PRESCRIPTION
  INVESTIGATION
  ADVICE
  REFERRAL
  CLINICAL_NOTES
  ATTACHMENTS
  FOLLOW_UP
}

// Where a consultation is in its life. ⚠️ AMENDED IS A STATE OF THE SUPERSEDED ROW, NOT OF THE CORRECTION. The amendment itself is DRAFT and then FINALIZED like any other consultation;
Enum EncounterStatus {
  DRAFT
  FINALIZED
  AMENDED [note: 'Superseded by a later row that cites it. Kept for ever.']
  CANCELLED [note: 'Abandoned before it was finalized. Kept rather than deleted: "the doctor started a consultation and abandoned it" is a f …']
}

// How bad the patient says it is. Three steps and not ten: a scale a clinician has to think about is a scale they stop filling in.
Enum ClinicalSeverity {
  MILD
  MODERATE
  SEVERE
}

// What a diagnosis IS to this consultation. ⚠️ `DIFFERENTIAL` IS NOT A WEAKER `SECONDARY`. A differential is something being considered and not concluded;
Enum DiagnosisRole {
  PRIMARY
  SECONDARY
  DIFFERENTIAL
}

// How sure the clinician is. `RULED_OUT` is a real and useful answer — "we looked and it is not this" is worth as much on a chart as a confirmation.
Enum DiagnosisCertainty {
  CONFIRMED
  PROVISIONAL
  SUSPECTED
  RULED_OUT
}

// Where a procedure recorded on a consultation has got to. ⚠️ NOT AN INVENTORY STATE. What was consumed doing it is `stock_ledger` (PI-9);
Enum EncounterProcedureStatus {
  PLANNED
  PERFORMED
  CANCELLED
}

// How soon an investigation is wanted.
Enum InvestigationPriority {
  ROUTINE
  URGENT
  STAT
}

// Where an order has got to. ⚠️ THE LAB MODULE DOES NOT EXIST, AND THIS ENUM IS NOT PRETENDING IT DOES. These are the states the CLINIC can observe from the consultation side
Enum InvestigationStatus {
  ORDERED
  COLLECTED
  COMPLETED
  CANCELLED
}

// How soon a referral is wanted.
Enum ReferralUrgency {
  ROUTINE
  URGENT
  EMERGENCY
}

// How a medicine is taken. ⚠️ AN ENUM WHERE `clinical_master_codings.system` IS A VARCHAR, AND THE DIFFERENCE IS REAL.
Enum MedicationRoute {
  ORAL
  TOPICAL
  INTRAVENOUS
  INTRAMUSCULAR
  SUBCUTANEOUS
  INHALATION
  OPHTHALMIC
  OTIC
  NASAL
  RECTAL
  VAGINAL
  SUBLINGUAL
  TRANSDERMAL
  OTHER
}

// The period a dose count is per. "1 × per DAY", "2 × per WEEK". ⚠️ DELIBERATELY NOT `ClinicalDurationUnit`, WHICH IT RESEMBLES AND WHICH THIS TABLE ALSO USES.
Enum MedicationFrequencyUnit {
  DAY
  WEEK
  MONTH
}

// When to take it relative to eating. `ANY` is a real answer and NULL is not: NULL says the clinician did not say, which for a medicine that must be taken with food is a different and more dangerous sta …
Enum MedicationFoodRelation {
  BEFORE_FOOD
  AFTER_FOOD
  WITH_FOOD
  ANY
}

// What an attachment on a consultation is. ⚠️ NOT `DocumentType`, WHICH IT SITS BESIDE. `DocumentType` says what kind of FILE the platform is storing and is read by the storage layer;
Enum EncounterAttachmentKind {
  PHOTO [note: 'A clinical photograph. ⚠️ The densest PHI the product stores.']
  REPORT [note: 'A report the patient brought, or one the clinic produced.']
  SCAN [note: 'An X-ray, an OPG, a scan.']
  CONSENT [note: 'A signed consent.']
  LETTER [note: 'A letter to or from another clinician.']
  OTHER
}

// How a map is drawn. ⚠️ AN ENUM WITH TWO MEMBERS RATHER THAN A BOOLEAN, because the third is foreseeable — a photograph a clinician pins findings onto is neither of these.
Enum VisualMapRenderer {
  SVG [note: 'Regions are vector shapes, drawn from their own geometry. The only renderer CE-6 ships a map for.']
  IMAGE_MAP [note: 'Regions are hotspots over a raster asset named by `asset_key`.']
}

// What a consumption record points at. ⚠️ TWO MEMBERS ARE BUILT AND TWO ARE DECLARED. `ENCOUNTER` and `ENCOUNTER_PROCEDURE` have columns;
Enum ConsumptionAnchorKind {
  ENCOUNTER [note: 'The consultation itself — a dressing, an injectable, anything used at a visit that is not filed under a named procedure.']
  ENCOUNTER_PROCEDURE [note: '''A named procedure within a consultation. The ordinary case, and the one `encounter_procedures`' own `(organization_id, i …''']
  LAB_ORDER [note: 'Reagents, kits, tubes. ⚠️ NO COLUMN — the lab module is permission codes and nothing else.']
  IMAGING_STUDY [note: 'Contrast media. ⚠️ NO COLUMN — imaging does not exist here either.']
}

// Where a template is in its life. ⚠️ A TEMPLATE IS A STARTING POINT AND NEVER A COMMITMENT. Nothing is deducted from stock by any row in a template; only an actual recording moves quantity.
Enum ConsumptionTemplateStatus {
  DRAFT [note: 'Being written. Not offered to a clinician.']
  ACTIVE [note: 'In force for its effective window.']
  RETIRED [note: 'Superseded or withdrawn. Kept for ever — a consumption record cites the version it was pre-filled from, and that citatio …']
}

// Is this record what was used, or a correction to what was recorded? ⚠️ A CORRECTION AFTER THE ENCOUNTER CLOSES IS A SECOND RECORD, NEVER AN EDIT.
Enum ClinicalConsumptionKind {
  CONSUMPTION [note: 'What was used. Writes `CLINICAL_CONSUMPTION` legs.']
  ADDITIONAL_CONSUMPTION [note: 'More was used than was recorded, and the encounter has closed.']
  CONSUMPTION_REVERSAL [note: 'Less was used than was recorded, and the encounter has closed. Writes `RETURN` legs']
}

// What KIND of node this is in the clinical taxonomy tree. ⚠️ THIS IS A LABEL, NOT A DEPTH. Nothing in the database or the services asserts that a SUB_SPECIALTY sits exactly three levels down, and nothi …
Enum TaxonomyNodeType {
  CARE_CONTEXT [note: '⚠️ THE TRUE ROOT, ABOVE `DOMAIN` — Human, Veterinary (CE-1, CD-3).']
  DOMAIN [note: 'Tree root — Medical, Dental, Allied Health. Practically never assigned to a doctor directly.']
  DEPARTMENT [note: 'A broad grouping that a hospital would plausibly also run as an org unit.']
  SPECIALTY
  SUB_SPECIALTY
  FOCUS_AREA [note: 'Narrower than a sub-specialty and not a recognised training pathway — "Sports Rehabilitation" under Physiotherapy.']
  EXPERTISE [note: 'The finest grain. ⚠️ NOT a procedure — see the note on `Specialty`.']
}

// How deeply a doctor practises one node. ADVISORY AND DISPLAY-ONLY. ⚠️ NEVER an authorization input. "Is this doctor allowed to do X" is a permission question answered by `membership_roles`, and answer …
Enum SpecialtyProficiency {
  PRACTISING
  SPECIALIST
  EXPERT
}

Enum DoctorStatus {
  ACTIVE
  INACTIVE
  ARCHIVED [note: 'Retired from practice here. Kept because prescriptions reference them.']
}

// LEAVE and BLOCK remove availability; EXTRA_SHIFT adds it.
Enum ScheduleExceptionType {
  LEAVE
  BLOCK
  EXTRA_SHIFT
}

// Only APPROVED exceptions affect the availability engine. A REQUESTED leave shows on the doctor's own calendar as pending and changes nothing else.
Enum ScheduleExceptionStatus {
  REQUESTED
  APPROVED
  REJECTED
  CANCELLED
}

// ⚠️ DECLARATION ORDER IS LOAD-BEARING — it is the Postgres enum's sort order, and the day board is read `ORDER BY scheduled_start, status` so that a patient still waiting sorts above one already seen.
Enum PayoutInterval {
  MONTHLY
  FORTNIGHTLY
  WEEKLY
  DAILY
  HOURLY
  PER_SESSION
}

Enum UserStatus {
  INVITED
  ACTIVE
  SUSPENDED
  LOCKED
}

Enum AuthTokenPurpose {
  LOGIN_OTP
  PASSWORD_RESET
  VERIFY_EMAIL
  VERIFY_PHONE
  INVITE_ACCEPT
}

// What a storage location IS, for grouping in the UI and for matching against a product's storage requirements. ⚠️ METADATA, NEVER AUTHORIZATION.
Enum LocationKind {
  MAIN_PHARMACY
  SATELLITE_PHARMACY
  REFRIGERATOR
  FREEZER
  CONTROLLED_CABINET
  DEPARTMENT_STORE
  PROCEDURE_ROOM
  LAB_STORE
  DENTAL_STORE
  VETERINARY_STORE
  CENTRAL_WAREHOUSE
  CONSIGNMENT [note: '''Stock owned by a supplier and held on the clinic's premises.''']
  DISPOSAL [note: 'The quarantine bin things go to before they are destroyed.']
}

// Where a BATCH is in its own lifecycle. ⚠️ NOT A PRODUCT STATUS AND NOT A STOCK STATUS (PI-ADR-013). Three enums, three columns, no shared vocabulary, and nothing may read one to infer another.
Enum BatchStatus {
  ACTIVE
  QUARANTINED
  EXPIRED
  RECALLED
  DAMAGED
  DISPOSED
}

// The condition a QUANTITY is held in. The second axis of PI-ADR-013. ⚠️ ONLY `AVAILABLE` IS ALLOCATABLE. Everything else is visible, countable and valued but not dispensable
Enum StockStatus {
  AVAILABLE
  RESERVED [note: 'Spoken for by a pending dispense, an order or a scheduled procedure. Becomes real in PI-3;']
  QUARANTINED
  BLOCKED [note: 'Held by a regulator, a quality hold, or a manual review.']
  EXPIRED
  DAMAGED
  RECALLED
  DISPOSED
  IN_TRANSIT [note: 'Sent from one branch and not yet received at the other. PI-3.']
}

// A serialised unit's own lifecycle. Devices and implants only.
Enum SerialStatus {
  IN_STOCK
  ISSUED [note: 'Fitted to, or issued to, a patient. `assigned_patient_id` is then set.']
  RETURNED
  QUARANTINED
  RECALLED
  DAMAGED
  DISPOSED
}

// Why a quantity moved. ⚠️ THE SIGN IS A PROPERTY OF THE MEMBER, NOT A CHOICE OF THE CALLER. The `stock_ledger_direction` CHECK in the migration pairs each member with the sign it is allowed to carry AN …
Enum StockMovementType {
  PURCHASE_RECEIPT
  TRANSFER_IN
  TRANSFER_OUT
  DISPENSING
  CLINICAL_CONSUMPTION
  ADJUSTMENT
  DAMAGE
  EXPIRY
  RECALL
  RETURN [note: 'Coming back from a patient or a department, INTO stock. Not a purchase return, which is `PURCHASE_RETURN` immediately be …']
  PURCHASE_RETURN [note: '''Going back to the SUPPLIER (PI-4.7). ⚠️ ITS OWN MEMBER, AND A DELIBERATE REFINEMENT OF WHAT `RETURN`'S COMMENT SAID IN P …''']
  DISPOSAL
  RESERVATION
  RELEASE
  QUARANTINE
  QUARANTINE_RELEASE
  RECALL_RELEASE [note: 'Coming BACK out of the RECALLED bucket, into AVAILABLE (PI-10).']
}

// What a movement was FOR. Half of the traceability key. `reference_id` is deliberately NOT a foreign key: the row it names lives in a different domain, several of those domains do not exist yet (`presc …
Enum StockReferenceType {
  MANUAL [note: 'No external cause: an opening balance, a stock take, a manual correction.']
  GOODS_RECEIPT
  PURCHASE_RETURN
  DISPENSE
  CONSUMPTION
  TRANSFER
  STOCK_TAKE
  RECALL
  EXPIRY_SWEEP [note: 'The expiry sweep. The only reference type written by a worker.']
  ONLINE_ORDER
}

// Which direction of adjustment a reason code may be cited on. "Found in the fridge" cannot explain stock going missing and "broken in transit" cannot explain it appearing, so a single flat list would l …
Enum StockReasonDirection {
  INCREASE
  DECREASE
  BOTH [note: 'Legitimately both — a stock take corrects in whichever direction the count came out.']
}

// Where a transfer has got to. ⚠️ THERE IS NO `IN_TRANSIT` STOCK STATUS IN THIS FLOW, AND THAT IS THE PI-3 DECISION.
Enum StockTransferStatus {
  DRAFT [note: 'Being built. Nothing has moved and no ledger row exists.']
  DISPATCHED [note: '''Sent. The `TRANSFER_OUT` legs are written and the sending branch's shelves are already lighter. Nothing has arrived.''']
  PARTIALLY_RECEIVED [note: '''Some lines received, some outstanding. Still reachable from the receiving branch's "to receive" list, which is the whole …''']
  RECEIVED
  CANCELLED [note: 'Killed before dispatch (no ledger rows) or after (a compensating `TRANSFER_IN` back to the sender).']
}

// What a reservation is doing now.
Enum StockReservationStatus {
  ACTIVE [note: 'Quantity is sitting in the `RESERVED` bucket, held for this reference.']
  RELEASED [note: 'Given back to `AVAILABLE` by a person.']
  EXPIRED [note: 'Given back to `AVAILABLE` by the sweep, because `expires_at` passed.']
  CONSUMED [note: 'Dispensed or consumed. PI-7 and PI-9 move it out of `RESERVED` directly.']
}

// What the invoice was raised FOR. Drives the `{SOURCE}` segment of the number and, from Phase 7, which invoices a caller is allowed to see at all. ⚠️ THE ENUM IS COMPLETE; THE INTEGRATIONS ARE NOT.
Enum InvoiceSourceType {
  APPOINTMENT [note: 'A consultation. The only source integrated end to end today (Phase 8).']
  PROCEDURE [note: 'A billable clinical procedure that is not a consultation.']
  SERVICE [note: '''Anything from the clinic's own service catalogue.''']
  LAB
  PHARMACY
  INVENTORY
  OTHER [note: 'A manual invoice typed by the cashier, citing nothing.']
}

// Is this document a charge or a reversal of one? (PI-8.) ⚠️ A CREDIT NOTE IS AN INVOICE ROW WITH A DIFFERENT KIND, NOT A PARALLEL SET OF TABLES, AND THAT IS THE LOAD-BEARING DECISION OF PI-8.
Enum InvoiceKind {
  INVOICE [note: 'A charge. Every row written before PI-8 is one, which is why it is the default']
  CREDIT_NOTE [note: 'A reversal of an issued invoice, in whole or in part. Cites the invoice it credits, and never edits it.']
}

// Where an invoice is in its life. ⚠️ `DRAFT` IS THE ONLY STATE IN WHICH ANY MONEY COLUMN MAY MOVE. Everything from ISSUED onwards is a document a patient has been handed and may have claimed against in …
Enum InvoiceStatus {
  DRAFT [note: 'Being assembled. No number has been issued, so nothing here consumes a serial']
  FINALIZING [note: 'The brief moment inside finalisation: the number has been taken and the totals frozen, but the transaction has not commi …']
  ISSUED [note: 'Issued to the patient. Immutable from here.']
  PARTIALLY_PAID [note: 'Some money has arrived, and less than `grand_total` has.']
  PAID
  CANCELLED [note: 'Abandoned before it was ever issued. Only reachable from DRAFT, which is what distinguishes it from VOID']
  VOID [note: 'Issued and then reversed. The row and its number stay for ever: voiding is how a series stays contiguous when a document …']
}

// How a discount was expressed by whoever entered it. The INPUT is kept alongside the computed amount because "10% off" and "₹150 off" print differently and are re-derivable from each other only by know …
Enum InvoiceDiscountType {
  PERCENTAGE [note: 'Basis points, in `discount_bps`. 10% is 1000.']
  FIXED [note: 'A currency amount, in `discount_fixed`.']
}

Enum DemoRequestStatus {
  NEW
  CONTACTED
  CONVERTED
  SPAM
}

Enum NumberSequenceType {
  UHID
  MRN
  APPOINTMENT
  QUEUE_TOKEN
  EMPLOYEE [note: 'Staff employee codes, issued when an invitation is accepted.']
  INVOICE [note: 'Patient invoice serials. One counter per (branch, source, period)']
  STOCK_TRANSFER [note: 'Stock transfer documents (PI-3). One counter per SENDING branch, issued at dispatch and never at create']
  PURCHASE_REQUISITION [note: 'Issued on SUBMIT.']
  PURCHASE_ORDER [note: 'Issued on ISSUE. The number the supplier quotes back on their invoice.']
  GOODS_RECEIPT [note: 'Issued on POST. The receipt the accountant reconciles the invoice against.']
  PURCHASE_RETURN [note: 'Issued on SEND.']
  DISPENSE [note: '⚠️ PRESENT AND UNUSED, DELIBERATELY. Dispensing is PI-7, and adding a member to a Postgres enum is a migration']
  CLINICAL_EPISODE [note: 'Treatment journeys (CE-1). ⚠️ PER ORGANIZATION, NOT PER BRANCH, and it never resets']
  ENCOUNTER [note: 'Consultations (CE-3). ⚠️ PER BRANCH — the opposite shape from `CLINICAL_EPISODE` immediately above, and deliberately.']
  RECALL [note: 'Recall notices (PI-10). ⚠️ ORG-WIDE AND NEVER RESETS, unlike every procurement counter above.']
}

// ⚠️ NOT A CLOSED SET IN THE REAL WORLD, AND STORED AS AN ENUM ANYWAY. `OTHER` carries every identity these four labels do not, and `UNKNOWN` is the honest answer for an unconscious patient at the desk …
Enum Gender {
  MALE
  FEMALE
  OTHER
  UNKNOWN
}

// The eight ABO/Rh groups plus the unrecorded case. `UNKNOWN` is the default because a blank blood group and O-negative must never look alike.
Enum BloodGroup {
  A_POSITIVE
  A_NEGATIVE
  B_POSITIVE
  B_NEGATIVE
  AB_POSITIVE
  AB_NEGATIVE
  O_POSITIVE
  O_NEGATIVE
  UNKNOWN
}

Enum MaritalStatus {
  SINGLE
  MARRIED
  WIDOWED
  DIVORCED
  SEPARATED
  UNKNOWN
}

// `DECEASED` is a clinical fact and NOT a soft delete — the record stays readable, billable and auditable. `MERGED` marks the losing side of a duplicate merge;
Enum PatientStatus {
  ACTIVE
  INACTIVE
  DECEASED
  MERGED
}

Enum PatientRegistrationStatus {
  ACTIVE
  INACTIVE
}

Enum AddressType {
  HOME
  WORK
  OTHER
}

// `OTHER` covers latex, contrast media and everything else that is neither a marketed drug nor a food.
Enum AllergenType {
  DRUG
  FOOD
  ENVIRONMENT
  OTHER
}

// ⚠️ DECLARATION ORDER IS LOAD-BEARING — see `PatientConditionStatus`. The allergy list is read `ORDER BY severity DESC`, so SEVERE comes first, which is the order a prescriber needs it in.
Enum AllergySeverity {
  MILD
  MODERATE
  SEVERE
}

// `CHRONIC` is not "active for a long time" — it changes what the medication list means. A chronic condition never resolves and its drugs are expected to be ongoing; an ACTIVE one is expected to end.
Enum PatientConditionStatus {
  ACTIVE
  CHRONIC
  RESOLVED
}

// Where a prescription has got to in the dispensary — pharmacy's own state, beside a clinical record it may not touch. ⚠️ `NEW` IS NEVER STORED. A prescription with no fulfilment row IS new;
Enum PrescriptionFulfilmentStatus {
  NEW
  VERIFIED [note: 'A pharmacist has read it and confirmed it is dispensable. Step [6] of the flow in PHARMACY_ARCHITECTURE.md.']
  PARTIALLY_DISPENSED
  COMPLETED
  CANCELLED [note: 'The dispensary is not going to supply it — the patient went elsewhere, the prescriber withdrew it.']
}

// Was there a prescription behind this supply? ⚠️ THERE IS NO `is_otc` ANYWHERE IN THIS PROGRAMME, AND THIS ENUM IS NOT ONE IN DISGUISE. It records what HAPPENED
Enum DispenseKind {
  PRESCRIPTION
  COUNTER_SALE
}

Enum DispenseStatus {
  DISPENSED
  PARTIALLY_RETURNED
  RETURNED
}

// What happened to stock that came back. ⚠️ THE DEFAULT IS `QUARANTINED` AND IT IS NOT A CONSERVATISM WE INVENTED.
Enum DispenseReturnDisposition {
  RESTOCKED
  QUARANTINED
}

// Whether we still buy from this supplier. ⚠️ NOT A SOFT DELETE, AND `deleted_at` IS NOT A STATUS. A supplier cited by four years of purchase orders can never be removed, so `deleted_at` only ever means …
Enum SupplierStatus {
  ACTIVE
  ON_HOLD [note: 'Temporarily not ordering from. Existing orders continue.']
  BLACKLISTED [note: 'Never order from again. A new PO is refused with a sentence.']
}

// Where a branch's request to buy something has got to. ⚠️ `APPROVED` AND `ORDERED` ARE TWO STATES BECAUSE APPROVAL AND COMMITMENT ARE TWO DECISIONS.
Enum PurchaseRequisitionStatus {
  DRAFT
  SUBMITTED [note: 'Sent for approval. The requester can no longer edit it.']
  APPROVED
  REJECTED
  CANCELLED
  ORDERED [note: 'A purchase order has been raised from it. See `purchase_orders.requisition_id`.']
}

// Where a purchase order has got to. ⚠️ `CLOSED` IS NOT `RECEIVED`. `RECEIVED` means every line arrived in full; `CLOSED` means the buyer decided nothing more is coming
Enum PurchaseOrderStatus {
  DRAFT
  ISSUED [note: 'Committed and sent to the supplier. The number is issued here, never at create — the same call `stock_transfers` makes.']
  PARTIALLY_RECEIVED
  RECEIVED
  CLOSED [note: 'Short-shipped and abandoned. See the enum comment.']
  CANCELLED
}

// Where a goods receipt has got to. ⚠️ ONLY `POSTED` HAS WRITTEN LEDGER ROWS, AND THERE IS DELIBERATELY NO `REVERSED`.
Enum GoodsReceiptStatus {
  DRAFT [note: 'Being keyed in. Nothing has moved and no lot row exists.']
  POSTED [note: 'Committed. The `PURCHASE_RECEIPT` legs are written, the lots exist and the shelves are heavier.']
  CANCELLED [note: 'Abandoned before posting. Never reachable from POSTED.']
}

// Whether a received line has passed inspection. The optional hold between receipt and availability. When the branch or the product category requires it, the receipt lands in `QUARANTINED` and an accept …
Enum GoodsReceiptQualityStatus {
  NOT_REQUIRED [note: 'No hold applied. The line went straight to `AVAILABLE`.']
  PENDING [note: 'Held in `QUARANTINED`, waiting for somebody to look at it.']
  ACCEPTED [note: 'Inspected and released to `AVAILABLE`.']
  REJECTED [note: 'Inspected and refused. The quantity stays out of `AVAILABLE` and is returned or disposed of.']
}

// Where a return to the supplier has got to.
Enum PurchaseReturnStatus {
  DRAFT
  SENT [note: 'Gone back. The `PURCHASE_RETURN` legs are written and the shelves are lighter.']
  CANCELLED
}

// What a unit MEASURES. Conversion across classes is refused: there is no general answer to "how many millilitres in a tablet", and any product-specific answer (density, fill volume) belongs on the prod …
Enum UnitClass {
  COUNT [note: 'Discrete things — tablet, capsule, piece, pair, vial.']
  VOLUME
  MASS
  LENGTH
  AREA [note: 'Dressings and films, which are genuinely sold by area.']
}

// The kind of thing, for grouping, filtering and reporting. ⚠️ METADATA, NEVER AUTHORIZATION. Do not gate a permission on it, and do not infer regulation from it
Enum ProductType {
  MEDICINE
  VACCINE
  CONSUMABLE
  SURGICAL_SUPPLY
  MEDICAL_DEVICE
  IMPLANT
  DENTAL_MATERIAL
  LAB_REAGENT
  DIAGNOSTIC_KIT
  VETERINARY_MEDICINE
  VETERINARY_CONSUMABLE
  GENERAL_CLINICAL_SUPPLY
}

// Where a product is in ITS OWN lifecycle. ⚠️ NOT A BATCH STATUS AND NOT A STOCK STATUS (PI-ADR-013). A `DISCONTINUED` product with an `AVAILABLE` batch on the shelf is normal and must stay dispensable …
Enum ProductStatus {
  DRAFT [note: 'Not yet released for use. Visible to whoever is curating the catalogue.']
  ACTIVE
  DISCONTINUED [note: 'No longer purchased. Existing stock still dispenses.']
  WITHDRAWN [note: 'Withdrawn from use entirely. Distinct from a batch recall, which is per lot.']
}

// How individual units of this product are identified in the ledger (PI-ADR-014). ⚠️ EXPIRY IS A SEPARATE BOOLEAN, NOT A FIFTH MEMBER.
Enum TrackingMode {
  NONE
  LOT_BATCH
  SERIAL
  LOT_AND_SERIAL
}

// Which lot goes out first when several could (PI-3.5). ⚠️ FEFO IS THE DEFAULT AND NOT THE LAW. It is right for anything that expires and wrong for a good deal that does not: a device with a five-year w …
Enum AllocationStrategy {
  FEFO [note: 'First-Expiry-First-Out. Expiry ascending, then received ascending.']
  FIFO [note: 'Oldest received first, expiry ignored.']
  LIFO [note: 'Newest received first. Rare, and legitimate for stock whose value falls with age only after it is opened.']
}

// The namespace an identifier value belongs to. ⚠️ THE VALUE IS NOT UNIQUE ON ITS OWN. A GTIN is globally unique in principle and routinely is not in practice
Enum ProductIdentifierType {
  GTIN
  EAN
  UPC
  NDC [note: 'US National Drug Code.']
  NATIONAL_CODE [note: '''Whatever the country's own register calls it.''']
  MANUFACTURER_CODE
  INTERNAL_SKU [note: '''The clinic's own SKU. Always tenant-scoped in practice.''']
  LOCAL_REGULATORY [note: 'A regulator-issued identifier that is not a product code — a licence or a marketing-authorisation number.']
}

// The physical form a medicine is presented in. An enum rather than a lookup table, deliberately: the list is closed enough that adding "orodispersible film" is a migration somebody reviews, and a table …
Enum DosageForm {
  TABLET
  CAPSULE
  SYRUP
  SUSPENSION
  SOLUTION
  INJECTION
  INFUSION
  CREAM
  OINTMENT
  GEL
  LOTION
  DROPS
  SPRAY
  INHALER
  PATCH
  SUPPOSITORY
  PESSARY
  POWDER
  GRANULES
  LOZENGE
  IMPLANT
  OTHER
}

// How it goes in.
Enum AdministrationRoute {
  ORAL
  SUBLINGUAL
  BUCCAL
  INTRAVENOUS
  INTRAMUSCULAR
  SUBCUTANEOUS
  INTRADERMAL
  TOPICAL
  TRANSDERMAL
  INHALATION
  NASAL
  OPHTHALMIC
  OTIC
  RECTAL
  VAGINAL
  INTRATHECAL
  INTRA_ARTICULAR
  OTHER
}

// Release profile. Clinically load-bearing: a modified-release tablet is not substitutable for an immediate-release one of the same composition, whatever the composition equivalence says.
Enum ReleaseType {
  IMMEDIATE
  MODIFIED
  SUSTAINED
  EXTENDED
  DELAYED
  CONTROLLED
}

// How light-sensitive a product is. Descriptive; nothing enforces it yet.
Enum LightSensitivity {
  NONE
  PROTECT_FROM_LIGHT
  PROTECT_FROM_DIRECT_SUNLIGHT
}

// Where a recall is in its life. ⚠️ `EXECUTED` MEANS "THE STOCK WAS PULLED", NOT "THE RECALL IS FINISHED".
Enum RecallStatus {
  DRAFT [note: 'Being assembled: the notice is recorded and the lots are being identified. ⚠️ NOTHING IS HELD YET']
  EXECUTED [note: 'The scope was executed: every lot in it moved into the RECALLED bucket.']
  CLOSED [note: 'The work is finished. Kept for ever; a recall is the document a regulator asks for years later.']
  CANCELLED [note: 'Raised in error, or withdrawn by whoever issued the notice. ⚠️ CANCELLING AN EXECUTED RECALL DOES **NOT** PUT THE STOCK …']
}

// How bad it is. The Class I / II / III shape is the one the FDA, the EU and CDSCO all use, which is why it is modelled rather than left free text.
Enum RecallClassification {
  CLASS_I [note: 'Reasonable probability of serious harm or death.']
  CLASS_II [note: 'Temporary or reversible harm.']
  CLASS_III [note: 'Unlikely to cause harm — labelling, packaging, documentation.']
  UNCLASSIFIED [note: 'The notice did not say, or the jurisdiction does not classify.']
}

// Who says so. Recorded because it decides who the clinic reports back TO, and because an internal quality hold is a different conversation from a regulator's notice even when the stock movement is iden …
Enum RecallSource {
  MANUFACTURER
  REGULATOR
  SUPPLIER
  INTERNAL [note: '''The clinic's own quality decision — a fridge that failed overnight, a lot that looks wrong.''']
}

// What happened to ONE lot inside a recall.
Enum RecallBatchStatus {
  PENDING [note: 'In the scope, not yet acted on. The state every row starts in.']
  HELD [note: 'Moved into the RECALLED bucket. Un-dispensable and un-consumable from every path, because allocation reads `stock_balanc …']
  RELEASED [note: 'Cleared: the notice did not cover this lot after all, or the manufacturer withdrew it.']
  DISPOSED [note: 'Destroyed or sent back. ⚠️ THE ROW IS NOT DELETED — what happened to recalled stock is the question the regulator asks.']
  NO_STOCK [note: 'The lot was already fully gone when the recall reached it. Distinguished from `HELD` with a zero quantity because "nothi …']
}

// How far a jurisdiction's rule pack has actually got (PI-ADR-009). ⚠️ A STATE, NOT A BOOLEAN, AND THE LAST TWO ARE NOT REACHABLE FROM CODE.
Enum RulePackMaturity {
  ARCHITECTURE_SUPPORTED [note: 'The engine can EXPRESS this kind of rule. No rows yet.']
  RULES_CONFIGURED [note: 'Rows exist for this jurisdiction.']
  RULES_IMPLEMENTED [note: 'The engine acts on them at the call sites.']
  AUTOMATED_TESTED [note: 'Behaviour tests pass, versioned alongside the pack.']
  SOURCE_VERIFIED [note: 'Every rule cites a source somebody has re-checked.']
  REGULATORY_REVIEW_PENDING [note: 'Handed to a qualified human. The last state code may set.']
  REGULATORY_REVIEWED [note: 'A named human signed off the content. Human-only.']
  PRODUCTION_ENABLED [note: 'Signed off and live. Human-only.']
}

// Where one rule is in its own life. Orthogonal to the pack's maturity: a pack can be `SOURCE_VERIFIED` and still carry a `DRAFT` rule somebody is drafting.
Enum RegulatoryRuleStatus {
  DRAFT [note: 'Being written. Never evaluated.']
  ACTIVE [note: 'In force for its effective window.']
  SUPERSEDED [note: 'Replaced by a newer version of the same rule. Kept for history']
  WITHDRAWN [note: 'Withdrawn by the authority without a replacement.']
}

// What kind of statement a rule makes. Open by design: a new member is a migration plus handling in `@rcln/regulatory`, never a special case at a call site.
Enum RegulatoryRuleType {
  PRESCRIPTION_REQUIRED
  PRESCRIBER_AUTHORITY
  PHARMACIST_AUTHORITY
  CONTROLLED_SCHEDULE
  QUANTITY_LIMIT
  REFILL_RULE
  AGE_RESTRICTION
  SUBSTITUTION
  ONLINE_DISPENSING
  STORAGE_REQUIREMENT
  RECORD_RETENTION
  TRACEABILITY_REQUIREMENT
  LABELLING_REQUIREMENT
  REPORTING_REQUIREMENT
  DISPOSAL_REQUIREMENT
  IMPORT_RESTRICTION
}

// What is being attempted. Mirrors `RegulatoryTransaction` in `@rcln/regulatory` — the caller says what it is about to do, and the engine selects only the rules that speak to it.
Enum RegulatoryTransactionType {
  DISPENSE
  COUNTER_SALE
  ONLINE_DISPENSE
  CONSUME
  STOCK
  TRANSFER
  DISPOSE
}

// How far a source has been checked. ⚠️ `UNVERIFIED` IS THE HONEST DEFAULT AND IT IS NOT A FAILURE. It means one person wrote the citation down.
Enum RegulatorySourceStatus {
  UNVERIFIED
  VERIFIED
  UNAVAILABLE [note: 'The URL no longer resolves, or the document moved.']
  SUPERSEDED [note: 'The authority replaced it. The rules citing it need re-sourcing.']
}

// Whether a product is registered with the authority of a jurisdiction. ⚠️ `UNKNOWN` IS NOT `NOT_REGISTERED`. The first says the clinic has not recorded it;
Enum ProductRegistrationStatus {
  UNKNOWN
  NOT_REGISTERED
  PENDING
  REGISTERED
  SUSPENDED
  CANCELLED
  WITHDRAWN
}

// What a clinic asserts about whether this product needs a prescription HERE. ⚠️ AN ASSERTION, NOT AN AUTHORISATION. Nothing may gate a dispense on this column. It is an INPUT to `evaluate()`
Enum PrescriptionRequirement {
  UNKNOWN
  NOT_REQUIRED
  PHARMACIST_ONLY [note: '''Sold in a pharmacy under a pharmacist's supervision, no prescription.''']
  PRESCRIPTION_REQUIRED
  CONTROLLED [note: 'Prescription plus a controlled-drug regime — a register, a witness, a dedicated cabinet.']
}

// Whether this product may be sold to a patient remotely, here.
Enum OnlineSalePosition {
  UNKNOWN
  PERMITTED
  RESTRICTED [note: 'Permitted with conditions the rules state — a tele-consult, an e-prescription.']
  PROHIBITED
}

// What the engine answered, frozen at the moment somebody acted on it.
Enum RegulatoryDecisionOutcome {
  PERMITTED
  PERMITTED_WITH_CONDITIONS
  REFUSED
  UNDETERMINED
}

// Why the patient is coming. Billing reads this later — a follow-up inside the free window is not chargeable
Enum AppointmentVisitType {
  NEW
  FOLLOW_UP
  WALK_IN
  TELECONSULT
  PROCEDURE
}

// Who made the booking. Kept apart from `visitType` because "a follow-up booked on WhatsApp" is two independent facts, and the online-booking setting is enforced against this one.
Enum AppointmentSource {
  FRONT_DESK
  ONLINE
  PHONE
  WHATSAPP
}

// Who asked for an appointment to be moved. ⚠️ THIS EXISTS SO THE CLINIC IS NEVER CHARGED FOR ITS OWN LEAVE. A patient-initiated move adds the `RESCHEDULE` fee; a clinic-initiated one adds nothing.
Enum RescheduleInitiator {
  PATIENT
  CLINIC
}

Enum AppointmentStatus {
  BOOKED
  CONFIRMED
  CHECKED_IN
  IN_PROGRESS
  COMPLETED
  CANCELLED
  NO_SHOW
}

Enum SettingScopeType {
  PLATFORM
  ORGANIZATION
  BRANCH
  USER
  PATIENT
  DOCTOR
}

Enum SettingDataType {
  STRING
  INT
  BOOL
  DECIMAL
  JSON
}

Enum AuditAction {
  CREATE
  UPDATE
  DELETE
  LOGIN
  LOGOUT
  EXPORT
  SWITCH_BRANCH
  IMPERSONATE
  PERMISSION_CHANGE
}

// What a stored document IS, independent of what generated it. Deliberately a document taxonomy rather than a module list — `INVOICE_PDF`, not `BILLING`.
Enum DocumentType {
  INVOICE_PDF [note: 'The frozen PDF of an issued invoice. See `DocumentStatus` for why it has a lifecycle at all.']
  CREDIT_NOTE_PDF [note: 'A credit note against an invoice.']
  UPLOAD [note: 'Anything a user uploaded rather than the system generating. The historical meaning of every row in this table before the …']
  CLINICAL_ATTACHMENT [note: 'A file that belongs to a consultation (CE-4) — a clinical photograph, a report the patient brought, a signed consent.']
}

// Whether the bytes are actually there yet. ⚠️ THIS EXISTS SO THAT "THE INVOICE IS ISSUED" AND "THE PDF EXISTS" CAN BE TWO DIFFERENT FACTS, WHICH THEY GENUINELY ARE (§40, §42).
Enum DocumentStatus {
  PENDING [note: 'Recorded, not yet rendered. The state a queued generation starts in.']
  GENERATING [note: '''A renderer has claimed it. Distinct from PENDING so a crashed worker's rows are findable rather than looking like fresh …''']
  READY [note: 'Bytes are in storage and the checksum is recorded. The only state a download may be served from.']
  FAILED [note: 'Rendering failed. `failure_reason` says why, for an operator — never for a client.']
}

// What a PHI read was: a view, a search, a print, an export, a share.
Enum DataAccessType {
  VIEW
  SEARCH
  PRINT
  EXPORT
  SHARE
}

// What kind of record was read. Not the table name — the clinical noun, so the enum survives a table being split or renamed.
Enum DataAccessResource {
  PATIENT
  PATIENT_LIST
  MEDICAL_HISTORY
  APPOINTMENT
  VITALS [note: 'Observations taken at a visit. Kept apart from MEDICAL_HISTORY because the two answer different questions in a disclosur …']
  PRESCRIPTION
  LAB_REPORT
  INVOICE
  DOCUMENT
  INVENTORY_SERIAL [note: 'A serialised device or implant that is fitted to, or issued to, a named person (PI-2, PI-ADR-016).']
  ENCOUNTER [note: 'A consultation: what the doctor concluded, prescribed and advised (CE-3).']
  CLINICAL_EPISODE [note: 'A treatment journey (CE-1). Reading one discloses that a named person is under ongoing treatment, and its title usually …']
  CHARGE_REQUEST [note: 'What a named person is being billed for, before it reaches an invoice (PI-8). ⚠️ NOT `INVOICE`, AND NOT `PRESCRIPTION`.']
  CLINICAL_CONSUMPTION [note: 'What was USED on a named person during a procedure (PI-9). ⚠️ NOT `INVENTORY_SERIAL` AND NOT `ENCOUNTER`.']
  RECALL_TRACE [note: 'Turning a recalled lot into the NAMES of the people who received it (PI-10).']
}

Enum BillingInterval {
  MONTH
  YEAR
}

Enum FeatureValueType {
  INT
  BOOL
}

Enum SubscriptionStatus {
  TRIALING [note: 'Inside the free trial. No money has been asked for yet.']
  INCOMPLETE [note: 'Checkout has started and the first payment has not landed. Entitlements are NOT granted here']
  ACTIVE
  PAST_DUE [note: 'A renewal was attempted and failed. Access continues until `grace_period_end`, which is what dunning is retrying against …']
  CANCELED
  EXPIRED
}

Enum SubscriptionInvoiceStatus {
  DRAFT
  OPEN
  PAID
  VOID
  UNCOLLECTIBLE
}

Enum PaymentStatus {
  PENDING
  SUCCESS
  FAILED
  REFUNDED
}

// An authorisation to debit without the customer present. PENDING means the customer was shown the authorisation page and has not finished. ACTIVE is the ONLY state a debit may be attempted from
Enum MandateStatus {
  PENDING
  ACTIVE
  PAUSED
  CANCELLED
  FAILED
}

// One attempt to move money, and the row a provider's webhook is matched to. CREATED is before the provider has been asked;
Enum PaymentIntentStatus {
  CREATED
  PENDING
  SUCCEEDED
  FAILED
  EXPIRED
  CANCELLED
}

// Why money is being asked for. Drives what the webhook handler does on success, so it is a column and not something inferred from which foreign keys happen to be set.
Enum PaymentPurpose {
  SUBSCRIPTION_START [note: 'First payment for a subscription — from trial, or after expiry.']
  UPGRADE [note: 'The prorated difference on a mid-period plan change.']
  RENEWAL [note: 'An automatic charge at period end.']
  MANDATE_SETUP [note: 'A zero-or-nominal charge whose only job is to authorise future debits.']
  INVOICE_PAYMENT [note: 'A customer paying an open invoice by hand, typically after dunning.']
}

// What happened to a subscription, and why. The billing audit trail proper — `audit_logs` records that a row changed; this records the commercial event.
Enum SubscriptionChangeType {
  SUBSCRIBE
  UPGRADE
  RENEW
  CANCEL_AT_PERIOD_END
  CANCEL_IMMEDIATE
  RESUME
  REACTIVATE
  TRIAL_EXPIRED
  PAYMENT_FAILED
  SUSPENDED
}

Enum InvoiceLineKind {
  SUBSCRIPTION
  PRORATION_CREDIT
  PRORATION_CHARGE
  TAX
  ADJUSTMENT
}

// The lifecycle of one inbound webhook delivery. IGNORED is a success, not a failure: providers send event types we do not act on, and recording that we saw and dismissed one is what makes the ledger an …
Enum WebhookProcessingStatus {
  RECEIVED
  PROCESSED
  IGNORED
  FAILED
}

// What an invoice line is for. A prorated upgrade produces a credit line and a charge line on the same invoice, and a clinic reading its own invoice has to be able to tell which is which without doing t …
Enum TaxBehavior {
  EXCLUSIVE [note: 'The catalogue figure is net; tax is added on top. The default, and what every current `plan_prices` row means.']
  INCLUSIVE [note: 'The catalogue figure is what the customer pays, tax already inside it.']
}

// Why a supply was taxed the way it was. Recorded on the invoice because it is the thing an auditor asks about, and it cannot be recomputed later
Enum TaxTreatment {
  STANDARD [note: 'Tax charged at the rate of the place of supply.']
  REVERSE_CHARGE [note: '''The customer accounts for the tax themselves. EU cross-border B2B with a valid VAT number, and India's reverse-charge ca …''']
  ZERO_RATED [note: 'Taxable at 0% — an export of services out of a jurisdiction we collect in.']
  EXEMPT [note: 'Outside the scope of the tax entirely.']
  NOT_REGISTERED [note: 'We hold no registration covering this place of supply, so we may not collect. NOT a rate of zero']
  UNRATED [note: '''We ARE registered here, but no `tax_rules` row says what this item's tax category is taxed at, so nothing was charged.''']
  PROVIDER_REQUIRED [note: '''The jurisdiction's tax cannot be computed from a rate table at all, and no external tax provider is configured to comput …''']
}

// How ONE rate becomes the tax LINES printed on an invoice. A rate and a line are not the same thing, and conflating them is what makes a tax engine India-shaped.
Enum TaxSplit {
  NONE [note: 'One rate, one line. Every VAT country, and every GST country except India.']
  INTRA_STATE_HALVES [note: '''India's constitutional split. A supply INSIDE the state the issuer is registered in is halved between the centre and the …''']
}

// Whether a customer's tax identifier has been checked with the authority that issued it.
Enum TaxIdStatus {
  NOT_PROVIDED
  UNVALIDATED [note: 'Given, not yet checked. Treated as absent when deciding reverse charge.']
  VALID
  INVALID [note: 'Checked and refused. Kept rather than blanked, so the customer is not asked for it again in a loop and support can see w …']
}

// The kind of tax a registration is for. Determines which engine handles it.
Enum TaxScheme {
  GST
  VAT
  SALES_TAX
}

Enum OrganizationStatus {
  PENDING
  ACTIVE
  SUSPENDED
  CANCELLED
}

Enum OrganizationType {
  CLINIC
  HOSPITAL
  CHAIN
  LAB
}

Enum BranchType {
  CLINIC
  HOSPITAL
  LAB
  PHARMACY
}

Enum BranchStatus {
  ACTIVE
  INACTIVE
  CLOSED
}

// ---------------------------------------------------------------------------
// TABLES
// ---------------------------------------------------------------------------

// ===== access-control.prisma =======================================

Table memberships {
  id              uuid             [pk, not null, default: `uuid()`]
  user_id         uuid             [not null]
  organization_id uuid             [not null]
  status          MembershipStatus [not null, default: 'INVITED']
  invited_by      uuid             [null]
  joined_at       timestamptz      [null]
  last_branch_id  uuid             [null, note: 'The branch this person last worked in, so signing in puts them back where they were rather than in whichever branch happens to be primary.']
  created_at      timestamptz      [not null, default: `now()`]
  updated_at      timestamptz      [not null, note: 'auto-updated on write']
  deleted_at      timestamptz      [null]

  indexes {
    (user_id, organization_id) [unique]
    (organization_id, status)
  }

  Note: 'user × organization. The join that makes one login work across tenants.'
}

Table roles {
  id              uuid           [pk, not null, default: `uuid()`]
  organization_id uuid           [null]
  code            varchar(64)    [not null]
  name            varchar(128)   [not null]
  description     varchar(512)   [null]
  scope_level     RoleScopeLevel [not null]
  is_system       boolean        [not null, default: false]
  created_at      timestamptz    [not null, default: `now()`]
  updated_at      timestamptz    [not null, note: 'auto-updated on write']

  indexes {
    (organization_id, code) [unique]
    is_system
  }

  Note: 'System roles have organizationId = null and are never edited by a tenant. A tenant clones one into an org-scoped custom role instead.'
}

Table permissions {
  id          uuid         [pk, not null, default: `uuid()`]
  code        varchar(128) [unique, not null]
  module      varchar(64)  [not null]
  action      varchar(64)  [not null]
  description varchar(512) [null]
  created_at  timestamptz  [not null, default: `now()`]

  indexes {
    module
  }
}

Table role_permissions {
  id            uuid [pk, not null, default: `uuid()`]
  role_id       uuid [not null]
  permission_id uuid [not null]

  indexes {
    (role_id, permission_id) [unique]
  }
}

Table membership_roles {
  id              uuid        [pk, not null, default: `uuid()`]
  membership_id   uuid        [not null]
  organization_id uuid        [not null, note: 'Denormalised from membership so RLS can filter without a join, and so the composite FK to branches can be enforced.']
  role_id         uuid        [not null]
  branch_id       uuid        [null]
  valid_from      timestamptz [null]
  valid_to        timestamptz [null]
  created_at      timestamptz [not null, default: `now()`]

  indexes {
    (membership_id, role_id, branch_id) [unique]
    (organization_id, branch_id)
    membership_id
  }

  Note: 'The heart of the access model. branchId NULL -> the role applies to EVERY branch in the organization branchId set -> the role applies to that branch only One admin over all three branches = 1 row, branchId null A separate admin per branch = 1 row each, branchId set Admin over A and B, another over A …'
}

Table membership_permission_overrides {
  id              uuid           [pk, not null, default: `uuid()`]
  membership_id   uuid           [not null]
  organization_id uuid           [not null]
  permission_id   uuid           [not null]
  branch_id       uuid           [null]
  effect          OverrideEffect [not null]
  reason          varchar(512)   [null]
  created_at      timestamptz    [not null, default: `now()`]

  indexes {
    (membership_id, permission_id, branch_id) [unique]
    organization_id
  }

  Note: 'Per-person exceptions. DENY always beats GRANT, and both beat role grants.'
}

Table invitations {
  id              uuid         [pk, not null, default: `uuid()`]
  organization_id uuid         [not null]
  email           varchar(255) [not null]
  phone           varchar(20)  [null]
  role_id         uuid         [not null]
  designation_id  uuid         [null, note: 'The job title this invite is for. Copied onto the staff profile when the invitation is accepted, so the answer is decided by whoever knows it']
  token           varchar(255) [unique, not null]
  invited_by      uuid         [not null]
  expires_at      timestamptz  [not null]
  accepted_at     timestamptz  [null]
  revoked_at      timestamptz  [null]
  created_at      timestamptz  [not null, default: `now()`]

  indexes {
    (organization_id, email)
  }
}

Table invitation_branches {
  id            uuid [pk, not null, default: `uuid()`]
  invitation_id uuid [not null]
  branch_id     uuid [not null]

  indexes {
    (invitation_id, branch_id) [unique]
  }
}

Table designations {
  id              uuid         [pk, not null, default: `uuid()`]
  organization_id uuid         [null, note: 'NULL = platform row, visible to every tenant.']
  code            varchar(64)  [not null]
  name            varchar(128) [not null]
  is_active       boolean      [not null, default: true]
  created_at      timestamptz  [not null, default: `now()`]
  updated_at      timestamptz  [not null, note: 'auto-updated on write']
  deleted_at      timestamptz  [null]

  indexes {
    (organization_id, code) [unique, note: '⚠️ Rewritten NULLS NOT DISTINCT in the migration — without it the platform rows are not unique among themselves.']
    (organization_id, is_active)
  }

  Note: 'The job titles a clinic hands out. Platform catalogue with per-tenant extension: `organizationId = NULL` is a platform row every clinic sees. Exists as a table rather than free text on `staff_profiles` because a designation is a closed set the clinic curates'
}

Table role_designations {
  id              uuid        [pk, not null, default: `uuid()`]
  organization_id uuid        [null, note: 'NULL = platform pairing, visible to every tenant.']
  role_id         uuid        [not null]
  designation_id  uuid        [not null]
  is_excluded     boolean     [not null, default: false, note: 'A tenant row that SUPPRESSES a platform default rather than adding one: "our Receptionists are never Clinic Managers".']
  created_at      timestamptz [not null, default: `now()`]

  indexes {
    (organization_id, role_id, designation_id) [unique, note: '⚠️ NULLS NOT DISTINCT in the migration — platform pairings carry a NULL organization_id and must be unique among themselves.']
    role_id
    designation_id
  }

  Note: 'Which job titles fit which role. A "Receptionist" is not a "Radiologist". A real join table rather than an array on either side (ADR-0006): the relationship is genuinely many-to-many — "Consultant" fits only DOCTOR, while "Clinic Manager" fits ORG_ADMIN, BRANCH_ADMIN and RECEPTIONIST'
}

Table staff_profiles {
  id             uuid         [pk, not null, default: `uuid()`]
  membership_id  uuid         [unique, not null]
  employee_code  varchar(64)  [null, note: 'Issued from the EMPLOYEE sequence at accept time. Stable for life: it is how the clinic refers to this person, so a re-join keeps the original.']
  department     varchar(128) [null]
  designation_id uuid         [null, note: 'Replaced the free-text `designation` column, which had no rows. One source of truth: a designation is a row in `designations`, never a typed string.']
  joined_on      date         [null]
  relieved_on    date         [null]

  indexes {
    designation_id
  }

  Note: 'Employment facts are per-organization, so this keys on membership, not user. `employeeCode`, `designationId` and `joinedOn` are AUTO-POPULATED when an invitation is accepted — see `acceptInvitation`. They stay editable afterwards from the Staff screen.'
}

Table membership_professional_registrations {
  id                  uuid                           [pk, not null, default: `uuid()`]
  membership_id       uuid                           [not null]
  licence_type        varchar(64)                    [not null, note: '''The exact-match key into a rule's licence list. See the header.''']
  registration_number varchar(128)                   [not null]
  jurisdiction_code   varchar(10)                    [null, note: 'Who issued it — `IN`, `IN-KA`, `GB`. The same shape `jurisdictions` uses, and NULLABLE because a clinic recording "she is a registered pharmacist" wit …']
  authority_name      varchar(255)                   [null, note: '''The council's name as the clinic knows it. Presentation only — nothing matches on it, for the reason `item_code` is not `tax_category`.''']
  issued_on           date                           [null, note: '''⚠️ DATES, NOT INSTANTS. A registration runs to the end of a calendar day in the council's own reckoning, not to an instant in UTC.''']
  expires_on          date                           [null]
  status              ProfessionalRegistrationStatus [not null, default: 'ACTIVE']
  created_at          timestamptz                    [not null, default: `now()`]
  updated_at          timestamptz                    [not null, note: 'auto-updated on write']
  deleted_at          timestamptz                    [null]

  indexes {
    (membership_id, licence_type) [unique, note: 'One row per licence type per person. A pharmacist re-registering replaces the number on the row rather than growing a second one;']
    (membership_id, status) [note: '''The actor resolver's read: every live registration for one member.''']
  }

  Note: '''A professional registration a member of staff holds (PI-8, closing KNOWN_ISSUES #9). ⚠️ THIS EXISTS BECAUSE `RegulatoryActor.licenceTypes` WAS EMPTY ON EVERY CALL. Rules across this programme's target jurisdictions say things like "the supply must be made by a registered pharmacist"'''
}

// ===== charging.prisma =============================================

Table charge_policy_rules {
  id                  uuid         [pk, not null, default: `uuid()`]
  organization_id     uuid         [not null]
  product_id          uuid         [null, note: '⚠️ EXACTLY ONE OF THE THREE IS SET, BY CHECK. A rule that named both a product and a type would have two places in the precedence chain and the resolv …']
  product_category_id uuid         [null]
  product_type        ProductType  [null]
  policy              ChargePolicy [not null]
  note                text         [null, note: 'Why the clinic decided this. Not PHI — it is about a catalogue row.']
  created_at          timestamptz  [not null, default: `now()`]
  updated_at          timestamptz  [not null, note: 'auto-updated on write']
  updated_by          uuid         [null]
  deleted_at          timestamptz  [null]

  indexes {
    (organization_id, product_id, product_category_id, product_type) [unique, note: '⚠️ NULLS NOT DISTINCT in the migration. Every scoping column is nullable, and a plain unique does not constrain NULLs']
    (organization_id, id) [unique]
    (organization_id, product_id) [note: '''The resolver's read: every candidate rule for one product, in one index.''']
    (organization_id, product_category_id)
    (organization_id, product_type)
  }

  Note: '''A clinic's standing answer to "is this billed?". ⚠️ NOT EFFECTIVE-DATED, DELIBERATELY, AND THE SNAPSHOT IS WHY. A charge request records the policy AND the tier that produced it at the moment of supply, so history is answerable from the request rather than from this table's past.'''
}

Table product_prices {
  id              uuid           [pk, not null, default: `uuid()`]
  organization_id uuid           [not null]
  branch_id       uuid           [null, note: '''NULL = the organization's default, which every branch inherits.''']
  product_id      uuid           [not null, note: 'Plain FK into a platform-extensible table — see `product_visible`.']
  unit_id         uuid           [not null, note: '⚠️ THE UNIT THE PRICE IS PER, AND IT IS NOT NECESSARILY THE BASE UNIT. A clinic prices a strip, not a tablet, and an invoice line reading "2 × ₹45.00" …']
  amount          decimal(14, 2) [not null, note: '⚠️ Decimal, never a float, and never minor units in an integer column here: this is a stored money value and matches `invoice_items.unit_price` exactl …']
  currency        char(3)        [not null, default: 'INR', note: 'ISO 4217. Denormalised from the organization so a price row can be read without a second query, and CHECKed against nothing']
  created_at      timestamptz    [not null, default: `now()`]
  updated_at      timestamptz    [not null, note: 'auto-updated on write']
  updated_by      uuid           [null]
  deleted_at      timestamptz    [null]

  indexes {
    (organization_id, product_id, branch_id, currency) [unique, note: '⚠️ NULLS NOT DISTINCT in the migration, for the reason `fee_schedule_entries` needs it: `branch_id` is nullable and one clinic may hold exactly one or …']
    (organization_id, id) [unique]
    (organization_id, product_id) [note: '''The resolver's read: both candidate rows for one product, in one index.''']
  }

  Note: 'What a clinic SELLS a product for. ⚠️ A SELLING PRICE IS NOT AN INVENTORY COST, AND NEITHER IS DERIVED FROM THE OTHER (PI-ADR-010). `product_cost_averages` is what the clinic paid; this is what it charges.'
}

Table charge_requests {
  id                      uuid                [pk, not null, default: `uuid()`]
  organization_id         uuid                [not null]
  branch_id               uuid                [not null, note: 'The counter it happened at. The place of supply, the number series and the RLS boundary — the same three things it is on an invoice.']
  source_type             InvoiceSourceType   [not null, note: 'Which invoice source this becomes. ⚠️ CHECKed to `PHARMACY` or `INVENTORY` — those are the two this programme hands over, and an `APPOINTMENT` charge …']
  kind                    ChargeRequestKind   [not null, default: 'SUPPLY']
  status                  ChargeRequestStatus [not null, default: 'PENDING']
  dispense_line_id        uuid                [null, note: '⚠️ ONE TYPED REFERENCE PER SOURCE, NEVER A POLYMORPHIC `source_id`. Exactly the argument `invoices` makes in its own header: a loose uuid cannot be fo …']
  dispense_return_line_id uuid                [null]
  consumption_line_id     uuid                [null]
  product_id              uuid                [not null, note: 'What was supplied. Plain FKs into platform-extensible tables.']
  patient_id              uuid                [null, note: '⚠️ PHI, AND NULLABLE FOR THE REASON `dispenses.patient_id` IS. A counter sale is frequently to somebody who is not a patient here.']
  occurred_at             timestamptz         [not null, note: '''⚠️ WHEN THE SUPPLY HAPPENED, WHICH IS NOT WHEN IT IS BILLED. It becomes the invoice's `supplied_at`, so it selects the effective-dated tax rule and th …''']
  quantity_base           decimal(18, 6)      [not null, note: '⚠️ THE QUANTITY IN BASE UNITS AND THE QUANTITY ON THE BILL ARE DIFFERENT NUMBERS AT DIFFERENT SCALES, AND BOTH ARE STORED.']
  quantity                decimal(14, 3)      [not null]
  unit_id                 uuid                [not null, note: 'The unit `quantity` and `unit_price` are both expressed in.']
  policy                  ChargePolicy        [not null, note: '⚠️ EVERY FIELD FROM HERE TO `tax_category` IS A SNAPSHOT TAKEN AT SUPPLY. The policy table and the price table are both live and both editable, and an …']
  policy_scope            ChargePolicyScope   [not null]
  policy_rule_id          uuid                [null, note: 'Which rule produced it, where one did. NULL on `DEFAULT`. ⚠️ `Restrict`, AND `SetNull` IS NOT AVAILABLE HERE']
  description             varchar(255)        [not null, note: 'What the patient should see on the line. ⚠️ PHI-capable: it names a medicine, and it becomes `invoice_items.description` verbatim.']
  unit_price              decimal(14, 2)      [null, note: '⚠️ NULL IS A VISIBLE CONFIGURATION GAP AND NEVER A DEFAULT — the same rule `resolveTaxCategory` follows.']
  currency                char(3)             [not null, default: 'INR']
  tax_category            varchar(64)         [null, note: 'The exact-match key into `tax_rules`. NOT the printed HSN.']
  item_code               varchar(32)         [null, note: 'The printed HSN/SAC. Presentation only — see `invoice_items`.']
  invoice_id              uuid                [null, note: '⚠️ WRITTEN BY `services/invoicing`, NEVER BY THIS PROGRAMME. The only link back, and the direction of the arrow is the whole seam.']
  suppressed_reason       text                [null, note: 'Why it was suppressed, where it was. Required by CHECK on `SUPPRESSED`: "we did not bill this" with no reason is indistinguishable from a bug.']
  decided_by_id           uuid                [null, note: 'Who took the decision, where a human did. NULL where the policy decided.']
  decided_at              timestamptz         [null]
  created_at              timestamptz         [not null, default: `now()`]
  updated_at              timestamptz         [not null, note: 'auto-updated on write']

  indexes {
    (organization_id, id) [unique]
    (organization_id, dispense_line_id) [note: '⚠️ ONE CHARGE REQUEST PER SUPPLIED LINE, AND THIS IS THE IDEMPOTENCY GUARANTEE RATHER THAN A TIDINESS ONE.']
    (organization_id, dispense_return_line_id)
    (organization_id, consumption_line_id) [note: 'The same partial-unique treatment (PI-9): `WHERE consumption_line_id IS NOT NULL`, in the migration, because Prisma cannot express it and a plain uniq …']
    (organization_id, branch_id, status, occurred_at) [note: 'The charge-review screen: what is outstanding at this counter, oldest first. The one query that renders it.']
    (organization_id, patient_id, occurred_at) [note: '''"What does this patient owe for?" — and the reversal's lookup of the request its original supply raised.''']
    (organization_id, invoice_id)
  }

  Note: 'One thing that happened, offered to billing. ⚠️ IT IS WRITTEN IN THE SAME TRANSACTION AS THE SUPPLY THAT CAUSED IT. A charge request that can commit independently of its dispense is one that will, on the day the dispense rolls back — and the clinic bills for medicine that never left the shelf.'
}

// ===== clinical.prisma =============================================

Table clinical_master_items {
  id              uuid               [pk, not null, default: `uuid()`]
  organization_id uuid               [null, note: 'NULL = platform row, visible to every tenant.']
  kind            ClinicalMasterKind [not null]
  parent_id       uuid               [null, note: 'Optional grouping within a kind — "Cardiovascular" over a set of symptoms. ⚠️ `onDelete: Restrict`, NOT SetNull, for the reason `specialties` records: …']
  code            varchar(64)        [not null, note: '⚠️ FLAT, NOT A PATH — `DENTAL_CARIES`, never `DENT-CARIES-DEEP`. A path-encoded code becomes a lie the moment a node is re-parented, and the path alre …']
  name            varchar(255)       [not null]
  description     text               [null, note: 'Clinician-facing detail. NOT patient data — this is a dictionary entry.']
  display_order   integer            [not null, default: 0, note: 'Sort among siblings. Ties break by `name` so the order is total.']
  metadata        jsonb              [null, note: 'Free-form document: display labels per locale, severity vocabularies a kind wants to offer, units for a measurement.']
  is_active       boolean            [not null, default: true]
  created_at      timestamptz        [not null, default: `now()`]
  updated_at      timestamptz        [not null, note: 'auto-updated on write']
  deleted_at      timestamptz        [null]

  indexes {
    (organization_id, kind, code) [unique, note: '⚠️ Rewritten NULLS NOT DISTINCT in the migration — without it the platform rows (organization_id NULL) are not unique among themselves.']
    (organization_id, id) [unique, note: 'Composite-FK target for the codings and scopes below, so a tenant can never bolt its own coding onto a PLATFORM word (ADR-0004).']
    (organization_id, kind, is_active) [note: 'The search: one kind, active rows, one tenant plus the platform.']
    parent_id [note: 'Descendant walks recurse on `parent_id`. Without this the recursive CTE seq-scans the table once PER LEVEL — the lesson `specialties` records.']
  }

  Note: 'Every clinical word the platform or a clinic can say (CD-5). Platform catalogue with per-tenant extension, exactly like `specialties`: `organizationId = NULL` is a row every clinic sees, and a clinic that needs a word we have not thought of adds its own rather than waiting for a deploy.'
}

Table clinical_master_codings {
  id              uuid         [pk, not null, default: `uuid()`]
  organization_id uuid         [null, note: '''Mirrors the parent's. NULL for a coding on a platform item.''']
  item_id         uuid         [not null]
  system          varchar(32)  [not null, note: '''`ICD10`, `ICD11`, `SNOMEDCT`, `LOINC`, or a clinic's own label.''']
  code            varchar(64)  [not null]
  display         varchar(512) [null, note: 'The term as that system words it, which is often not how the clinic does.']
  is_primary      boolean      [not null, default: false, note: 'Which code to print on a report when several exist. At most one TRUE per (item, system), enforced by a partial unique index in the migration']
  created_at      timestamptz  [not null, default: `now()`]
  updated_at      timestamptz  [not null, note: 'auto-updated on write']

  indexes {
    (organization_id, item_id, system, code) [unique, note: '⚠️ NULLS NOT DISTINCT in the migration.']
    (organization_id, system, code)
  }

  Note: '''External codes for a clinical word. ICD-10, SNOMED CT, LOINC, ICD-11, or a clinic's own scheme — all at once, on the same row. ⚠️ WHY THIS IS A TABLE AND NOT TWO COLUMNS ON THE ITEM (§9).'''
}

Table clinical_master_scopes {
  id              uuid        [pk, not null, default: `uuid()`]
  organization_id uuid        [null]
  item_id         uuid        [not null]
  specialty_id    uuid        [not null, note: 'A node anywhere in the taxonomy — a care context, a domain, a specialty or a sub-specialty. Scoping a word to DENTISTRY covers every node beneath it;']
  relevance       smallint    [not null, default: 0, note: 'Higher sorts first among scoped matches. A tie-break, not a filter.']
  created_at      timestamptz [not null, default: `now()`]

  indexes {
    (organization_id, item_id, specialty_id) [unique]
    (organization_id, specialty_id)
  }

  Note: 'Which parts of the clinical taxonomy a word is relevant to (§34). ⚠️ THIS RANKS. IT DOES NOT FILTER. §11 and §34 both say so in as many words: "Prescription search should be context-aware but must not prevent the doctor from using an appropriate medicine merely because it is not tagged to a specialt …'
}

Table product_clinical_scopes {
  id              uuid        [pk, not null, default: `uuid()`]
  organization_id uuid        [null]
  product_id      uuid        [not null]
  specialty_id    uuid        [not null]
  relevance       smallint    [not null, default: 0]
  created_at      timestamptz [not null, default: `now()`]

  indexes {
    (organization_id, product_id, specialty_id) [unique]
    (organization_id, specialty_id)
  }

  Note: 'The same relevance mapping for the product catalogue (§34, §42.8). ⚠️ A SEPARATE TABLE RATHER THAN A POLYMORPHIC `entity_type` COLUMN ON `clinical_master_scopes`.'
}

Table clinical_episodes {
  id                   uuid                  [pk, not null, default: `uuid()`]
  organization_id      uuid                  [not null]
  patient_id           uuid                  [not null]
  code                 varchar(32)           [not null, note: 'Human-facing identifier, issued from the `CLINICAL_EPISODE` counter. Said out loud and quoted on a report, so it is issued rather than typed.']
  title                varchar(255)          [null, note: '⚠️ PHI. "Androgenetic alopecia — management". Optional: a clinic that never titles an episode still gets the grouping, and an untitled journey renders …']
  primary_specialty_id uuid                  [null, note: 'What the journey is broadly about. Advisory grouping for reporting; never an authorization input, and never what resolves a consultation template']
  status               ClinicalEpisodeStatus [not null, default: 'OPEN']
  opened_on            date                  [not null, note: 'A DATE, not an instant: "when did this journey start" is a calendar question a clinic answers in its own timezone.']
  closed_on            date                  [null]
  closure_reason       text                  [null, note: '''⚠️ PHI. Why it was closed, in the clinician's words.''']
  notes                text                  [null, note: '⚠️ PHI.']
  opened_by            uuid                  [null, note: 'SetNull: the person who opened it may leave; the journey stays.']
  closed_by            uuid                  [null]
  created_at           timestamptz           [not null, default: `now()`]
  updated_at           timestamptz           [not null, note: 'auto-updated on write']
  deleted_at           timestamptz           [null]

  indexes {
    (organization_id, code) [unique]
    (organization_id, id) [unique, note: 'Composite-FK target: appointments and, from CE-3, encounters reference (organization_id, id) so a cross-tenant child is unrepresentable (ADR-0004).']
    (organization_id, patient_id, opened_on) [note: '"What journeys is this patient on?" — the visit-history read, newest first.']
    (organization_id, status) [note: 'The open-episode picker at the front desk.']
  }

  Note: 'One continuous treatment journey: every appointment about the same thing. ⚠️ THREE DIFFERENT QUESTIONS, THREE DIFFERENT MECHANISMS, AND CONFLATING ANY TWO IS THE MISTAKE THIS MODEL EXISTS TO PREVENT: "what visit did this one come from?" -> appointments.parent_appointment_id "what journey is this par …'
}

Table animal_profiles {
  id              uuid          [pk, not null, default: `uuid()`]
  organization_id uuid          [not null]
  patient_id      uuid          [not null]
  species         varchar(64)   [null, note: 'Free text, not an enum: the species list is unbounded and a veterinary clinic that treats a tortoise must not need a migration.']
  breed           varchar(128)  [null]
  weight_kg       decimal(8, 3) [null, note: 'Recorded weight in kilograms. ⚠️ Decimal, never a float — a dose is calculated from it.']
  guardian_name   varchar(255)  [null, note: '''Who brings the animal in and is billed. NOT a `patients` row: the guardian is not the patient, and making them one would put a human's identity on an …''']
  guardian_phone  varchar(20)   [null]
  created_at      timestamptz   [not null, default: `now()`]
  updated_at      timestamptz   [not null, note: 'auto-updated on write']

  indexes {
    (organization_id, patient_id) [unique]
  }

  Note: 'Species, breed and weight, when the patient is not a person (CD-4). ⚠️ DELIBERATELY THIN, AND DELIBERATELY NOT ON `patients`. §42.7 forbids building veterinary functionality now; §4 asks only that the architecture stop assuming humans.'
}

Table encounter_follow_up_recommendations {
  id                          uuid                 [pk, not null, default: `uuid()`]
  organization_id             uuid                 [not null]
  branch_id                   uuid                 [not null, note: 'Copied from the appointment rather than reached through a parent, so this row is an ordinary member of the branch RLS loop.']
  encounter_id                uuid                 [not null, note: '⚠️ NOT NULL SINCE CE-3, AND THE MIGRATION THAT ADDED THE FK IS THE ONE THAT TIGHTENED IT. Advice is given IN a consultation;']
  appointment_id              uuid                 [not null, note: 'The visit at which the advice was given. Denormalised from the encounter so the recall list can be assembled without joining through it.']
  patient_id                  uuid                 [not null]
  is_required                 boolean              [not null, default: true, note: '⚠️ FALSE IS A REAL ANSWER, NOT AN ABSENCE. "No follow-up needed" is a clinical decision worth recording, and it carries no interval.']
  interval_value              smallint             [null, note: '"In 15 days." ⚠️ EXACTLY ONE OF (intervalValue + intervalUnit) OR `recommendedDate` is set — a CHECK constraint in the migration, not a convention.']
  interval_unit               FollowUpIntervalUnit [null]
  recommended_date            date                 [null, note: '"On 4 September." A DATE, not an instant — compare with `startOfCalendarDay`, never against a timestamp.']
  follow_up_type              FollowUpType         [not null, default: 'ROUTINE']
  reason                      text                 [null, note: '⚠️ PHI.']
  notes                       text                 [null, note: '⚠️ PHI.']
  fulfilled_by_appointment_id uuid                 [null, note: 'The booking that satisfied this, once the patient actually made one. ⚠️ NULL IS THE INTERESTING STATE — it is the whole recall list.']
  fulfilled_at                timestamptz          [null]
  cancelled_at                timestamptz          [null, note: 'The patient declined, or the plan changed before they booked. Recorded rather than deleted: "we asked and they said no" is the answer to a recall chas …']
  cancelled_by                uuid                 [null]
  cancelled_reason            text                 [null, note: '⚠️ PHI.']
  created_at                  timestamptz          [not null, default: `now()`]
  updated_at                  timestamptz          [not null, note: 'auto-updated on write']
  deleted_at                  timestamptz          [null]

  indexes {
    (organization_id, patient_id, created_at) [note: 'The recall list: everything still outstanding, soonest first. ⚠️ The partial predicate (`fulfilled_by_appointment_id IS NULL AND cancelled_at IS NULL` …']
    (organization_id, branch_id, recommended_date)
    (organization_id, encounter_id) [note: '''"What did this consultation ask for?" — the read CE-4's screen does.''']
  }

  Note: 'What the doctor ASKED the patient to do — which is not an appointment (CD-13). ⚠️ THE TABLE LANDS IN CE-1 AND FILLS IN CE-4. `encounterId` is nullable ONLY until `encounters` exists in CE-3; the column is documented as required and the migration that adds the FK also makes it NOT NULL.'
}

Table consultation_templates {
  id              uuid         [pk, not null, default: `uuid()`]
  organization_id uuid         [null, note: 'NULL = platform row, visible to every tenant.']
  code            varchar(64)  [not null, note: '⚠️ FLAT, NOT A PATH — `DENTAL_GENERAL`, never `HUMAN-DEN-GENERAL`. Same rule as every other code in this repo: a path-encoded code becomes a lie the m …']
  name            varchar(160) [not null]
  description     text         [null]
  care_context_id uuid         [not null, note: 'The CARE CONTEXT this template belongs to — the `CARE_CONTEXT` root of the taxonomy (CD-3).']
  specialty_id    uuid         [null, note: 'The node this template is attached to, anywhere below the care context. ⚠️ NULL IS THE CARE-CONTEXT DEFAULT AND IS THE MOST IMPORTANT VALUE THIS COLUM …']
  is_active       boolean      [not null, default: true]
  created_at      timestamptz  [not null, default: `now()`]
  updated_at      timestamptz  [not null, note: 'auto-updated on write']
  deleted_at      timestamptz  [null]

  indexes {
    (organization_id, code) [unique, note: '⚠️ Rewritten NULLS NOT DISTINCT in the migration — without it the platform templates are not unique among themselves.']
    (organization_id, id) [unique, note: 'Composite-FK target for the versions, so a tenant can never bolt its own version onto a PLATFORM template (ADR-0004).']
    (organization_id, care_context_id, is_active) [note: '''The resolver's read: every candidate for one care context, in one index scan.''']
    (organization_id, specialty_id)
  }

  Note: '''One clinic's (or the platform's) consultation configuration for one part of the clinical taxonomy. ── WHY THIS IS TWO TABLES AND NOT ONE ─────────────────────────────────────── The template is the IDENTITY — "our dentistry consultation" — and it is what a clinic names, deactivates and thinks about.'''
}

Table consultation_template_versions {
  id              uuid                       [pk, not null, default: `uuid()`]
  organization_id uuid                       [null, note: '''Mirrors the parent's. NULL for a version of a platform template.''']
  template_id     uuid                       [not null]
  version         integer                    [not null, note: 'Monotonic per template, issued by the service. 1, 2, 3 — never reused.']
  definition      jsonb                      [not null, note: 'The configuration document. ⚠️ PARSED BY `@rcln/clinical` BEFORE ANYTHING ACTS ON IT, ALWAYS.']
  status          ConsultationTemplateStatus [not null, default: 'DRAFT']
  published_at    timestamptz                [null]
  published_by    uuid                       [null, note: 'SetNull: the person who published it may leave; the configuration stays.']
  retired_at      timestamptz                [null]
  created_at      timestamptz                [not null, default: `now()`]
  updated_at      timestamptz                [not null, note: 'auto-updated on write']

  indexes {
    (organization_id, template_id, version) [unique, note: '⚠️ NULLS NOT DISTINCT in the migration.']
    (organization_id, id) [unique, note: 'Composite-FK target for `encounters.template_version_id` in CE-3.']
    (organization_id, template_id, status) [note: '''The resolver's read: the latest PUBLISHED version of each candidate.''']
  }

  Note: '''One published (or draft, or retired) configuration document. ⚠️ `version` IS THE ROW'S, `definition.schemaVersion` IS THE DOCUMENT'S, AND THEY ARE NOT THE SAME NUMBER. A clinic on v7 of its dentistry template has seven `schemaVersion: 1` documents.'''
}

Table encounters {
  id                             uuid                 [pk, not null, default: `uuid()`]
  organization_id                uuid                 [not null]
  branch_id                      uuid                 [not null, note: '''Where the consultation happened. Copied from the appointment when there is one, and taken from the acting membership's branch for a walk-in.''']
  patient_id                     uuid                 [not null]
  appointment_id                 uuid                 [null, note: '⚠️ NULL FOR A WALK-IN (CD-1). See the model note.']
  clinical_episode_id            uuid                 [not null, note: 'The journey this consultation belongs to. NOT NULL for the same reason `appointments.clinical_episode_id` is: an episode of one is the ordinary case, …']
  doctor_profile_id              uuid                 [not null, note: 'Who wrote it. Restrict, never SetNull: an unsigned clinical record is not a thing, and a doctor leaving the clinic does not un-write what they saw.']
  encounter_number               varchar(32)          [null, note: 'Branch-local, issued from the `ENCOUNTER` counter. ⚠️ NULL UNTIL FINALIZATION, AND ISSUED THERE RATHER THAN AT CREATE.']
  template_id                    uuid                 [not null, note: 'The configuration this consultation was conducted under. Restrict on both: a template version an encounter cites can be RETIRED but never deleted, bec …']
  template_version_id            uuid                 [not null]
  template_snapshot              jsonb                [not null, note: '''⚠️ THE FROZEN COPY OF THE PARSED DEFINITION (§29). Written at open, read by every render and by finalization's validation, and never rewritten.''']
  status                         EncounterStatus      [not null, default: 'DRAFT']
  chief_complaint                text                 [null, note: '''⚠️ PHI. "Pain in the lower left molar." Free text and not a master item on purpose: the chief complaint is the patient's own words, and forcing it thr …''']
  chief_complaint_duration_value smallint             [null, note: '"Three days." Value and unit travel together or not at all — a CHECK in the migration, because a duration of "3" of nothing is not a duration.']
  chief_complaint_duration_unit  ClinicalDurationUnit [null]
  onset                          ClinicalOnset        [null]
  clinical_notes                 text                 [null, note: '''⚠️ PHI. The doctor's own narrative, which every specialty wants and no template can structure away.''']
  started_at                     timestamptz          [not null, default: `now()`, note: '''When the doctor opened it. Not the appointment's `startedAt`: a consultation can be written up after the patient has left, and pretending otherwise wo …''']
  finalized_at                   timestamptz          [null]
  finalized_by                   uuid                 [null, note: 'Restrict on the FK, not SetNull: who signed a clinical record is part of the record. Contrast every other `*_by` column in this file.']
  amends_encounter_id            uuid                 [null, note: 'The consultation THIS ONE CORRECTS. NULL on an original.']
  amended_at                     timestamptz          [null, note: '''Set on the row that WAS amended, at the moment its correction is finalized. ⚠️ Read the enum's note: this column and `amendsEncounterId` are never bot …''']
  amendment_reason               text                 [null, note: '⚠️ PHI. Why the record was corrected — required by the service on amend, because "the record changed and nobody said why" is the failure an amendment …']
  cancelled_at                   timestamptz          [null]
  cancelled_by                   uuid                 [null]
  cancelled_reason               text                 [null, note: '⚠️ PHI.']
  created_at                     timestamptz          [not null, default: `now()`]
  updated_at                     timestamptz          [not null, note: 'auto-updated on write']
  deleted_at                     timestamptz          [null]

  indexes {
    (organization_id, branch_id, encounter_number) [unique]
    (organization_id, id) [unique, note: 'Composite-FK target for every CE-4 child, the sections below and the follow-up recommendations above (ADR-0004).']
    (organization_id, patient_id, started_at) [note: '''The chart: this patient's consultations, newest first.''']
    (organization_id, clinical_episode_id, started_at) [note: '"Show me this whole journey." One indexed equality, as on `appointments`.']
    (organization_id, doctor_profile_id, status) [note: '''"What is still open on my desk?" — the doctor's draft list.''']
    (organization_id, template_version_id) [note: 'Reporting: how many consultations used version v.']
  }

  Note: 'One consultation: the clinical record of one visit. ⚠️ `appointmentId` IS NULLABLE, AND THAT IS CD-1 RATHER THAN AN OVERSIGHT. A walk-in seen without a booking is an ordinary event in a clinic, and a required appointment would force the desk to invent a slot the patient never took just so the doctor …'
}

Table encounter_sections {
  id              uuid                    [pk, not null, default: `uuid()`]
  organization_id uuid                    [not null]
  branch_id       uuid                    [not null, note: 'Copied from the encounter so this is an ordinary member of the branch RLS loop rather than a child inheriting only the org half']
  encounter_id    uuid                    [not null]
  section_type    ConsultationSectionType [not null, note: '''Which component wrote it. A Postgres enum rather than free text: the set is closed by the engine anyway, and a typo'd section type would be a row no c …''']
  section_key     varchar(64)             [not null, note: '''The template section's `key`. Stable by contract — renaming one in a template orphans every answer already recorded under the old key, in every finali …''']
  data            jsonb                   [not null, default: '{}', note: '⚠️ PHI. The descriptor answers, keyed by `FieldDescriptor.key`.']
  display_order   integer                 [not null, default: 0, note: '''Copied from the section's `order` in the snapshot, so a read that does not parse the snapshot can still render in the right order.''']
  created_at      timestamptz             [not null, default: `now()`]
  updated_at      timestamptz             [not null, note: 'auto-updated on write']

  indexes {
    (organization_id, encounter_id, section_key) [unique, note: 'One row per section key per encounter — the autosave upserts on it.']
    (organization_id, encounter_id, display_order)
  }

  Note: 'The answers to a descriptor-driven section — HISTORY and EXAMINATION. ⚠️ ONLY THE DESCRIPTOR-DRIVEN SECTIONS LIVE HERE, AND THAT IS THE WHOLE LINE THE ARCHITECTURE DRAWS.'
}

Table encounter_symptoms {
  id              uuid                 [pk, not null, default: `uuid()`]
  organization_id uuid                 [not null]
  branch_id       uuid                 [not null]
  encounter_id    uuid                 [not null]
  item_id         uuid                 [null, note: 'A `SYMPTOM` row from the vocabulary. NULL when the clinician typed one.']
  custom_text     varchar(255)         [null, note: '''⚠️ PHI. The clinician's own words when the vocabulary has no word for it.''']
  duration_value  smallint             [null, note: 'How long it has been going on. ⚠️ Value and unit travel together or not at all — a CHECK, because "3" of nothing is not a duration.']
  duration_unit   ClinicalDurationUnit [null]
  severity        ClinicalSeverity     [null]
  frequency       varchar(120)         [null, note: '"Intermittent", "on waking", "after meals". Free text: the useful answers are endless and an enum would refuse the one the patient gave.']
  site            varchar(120)         [null, note: 'Where on the body. ⚠️ Free text until CE-6 — the coded version is a finding against a `visual_regions` row, and that table does not exist yet.']
  notes           text                 [null, note: '⚠️ PHI.']
  display_order   integer              [not null, default: 0]
  created_at      timestamptz          [not null, default: `now()`]
  updated_at      timestamptz          [not null, note: 'auto-updated on write']

  indexes {
    (organization_id, encounter_id, display_order)
    (organization_id, item_id)
  }

  Note: 'What the patient reports, coded (§6). ⚠️ `itemId` OR `customText`, EXACTLY ONE, AND A CHECK CONSTRAINT SAYS SO. §6 wants a clinician able to record a symptom the vocabulary has not learned yet, and forcing every free-text entry to create a master row pollutes a shared platform catalogue with one cli …'
}

Table encounter_diagnoses {
  id              uuid               [pk, not null, default: `uuid()`]
  organization_id uuid               [not null]
  branch_id       uuid               [not null]
  encounter_id    uuid               [not null]
  item_id         uuid               [null]
  custom_text     varchar(255)       [null, note: '⚠️ PHI. See `EncounterSymptom` — exactly one of the two, by CHECK.']
  role            DiagnosisRole      [not null, default: 'SECONDARY']
  certainty       DiagnosisCertainty [not null, default: 'PROVISIONAL']
  notes           text               [null, note: '⚠️ PHI.']
  display_order   integer            [not null, default: 0]
  created_at      timestamptz        [not null, default: `now()`]
  updated_at      timestamptz        [not null, note: 'auto-updated on write']

  indexes {
    (organization_id, id) [unique, note: 'Composite-FK target for `encounter_procedures.diagnosis_id` (ADR-0004).']
    (organization_id, encounter_id, display_order) [note: '''⚠️ AT MOST ONE PRIMARY DIAGNOSIS PER CONSULTATION is a partial unique index in the migration — Prisma cannot express `WHERE role = 'PRIMARY'`.''']
    (organization_id, item_id)
  }

  Note: 'What the clinician concluded. ⚠️ THE ROW A PROCEDURE HANGS OFF, WHICH IS WHY IT CARRIES `@@unique([organizationId, id])`. "This root canal was for that caries" is a real clinical link and it is a foreign key, not a note.'
}

Table encounter_procedures {
  id               uuid                     [pk, not null, default: `uuid()`]
  organization_id  uuid                     [not null]
  branch_id        uuid                     [not null]
  encounter_id     uuid                     [not null]
  item_id          uuid                     [null]
  diagnosis_id     uuid                     [null, note: 'What it treats. NULL is ordinary — not every procedure answers a diagnosis recorded at the same visit.']
  visual_region_id uuid                     [null, note: 'WHERE it was done — the tooth, the quadrant, the scalp zone (CE-6). ⚠️ A PLAIN FK, NOT COMPOSITE, so it needs a RESTRICTIVE `region_visible` policy: a …']
  performed_on     date                     [null, note: 'A DATE, not an instant: "when was this done" is a calendar question the clinic answers in its own timezone. ⚠️ Compare with `startOfCalendarDay`.']
  status           EncounterProcedureStatus [not null, default: 'PLANNED']
  notes            text                     [null, note: '⚠️ PHI.']
  display_order    integer                  [not null, default: 0]
  created_at       timestamptz              [not null, default: `now()`]
  updated_at       timestamptz              [not null, note: 'auto-updated on write']

  indexes {
    (organization_id, id) [unique, note: '⚠️ THE COMPOSITE-FK TARGET, ADDED BY PI-9 AND REQUIRED BY ADR-0004. `clinical_consumptions.encounter_procedure_id` references `(organization_id, id)` …']
    (organization_id, encounter_id, display_order)
    (organization_id, item_id, status) [note: 'PI-9 reads this: what procedures were performed, and therefore what stock they consumed.']
  }

  Note: 'What was done about it, or is planned. ⚠️ `itemId` IS NOT NULL HERE, UNLIKE SYMPTOMS AND DIAGNOSES. A procedure is what gets billed, consumed from stock (PI-9) and reported on; a free-text one is a line nothing downstream can price or count. The clinic adds the word to its own vocabulary first'
}

Table encounter_prescriptions {
  id                       uuid                    [pk, not null, default: `uuid()`]
  organization_id          uuid                    [not null]
  branch_id                uuid                    [not null]
  encounter_id             uuid                    [not null]
  product_id               uuid                    [not null]
  strength                 varchar(64)             [null, note: '''"500 mg", "5%". A snapshot of what was written, because a product's catalogue strength can be corrected and this prescription cannot.''']
  dose                     decimal(10, 3)          [null, note: 'How much per dose. ⚠️ Decimal, never a float — half a tablet is 0.5 and a float would make it 0.49999999999999994 on some row, some day.']
  dose_unit                varchar(32)             [null, note: '"tablet", "ml", "drop", "puff". A VarChar for the reason `animal_profiles.species` is one: the list is unbounded per form.']
  route                    MedicationRoute         [null]
  frequency                smallint                [null, note: '"TWICE per DAY" — a count and its period. Both or neither, by CHECK.']
  frequency_unit           MedicationFrequencyUnit [null]
  duration_value           smallint                [null, note: 'How long the course runs. Both or neither, by CHECK.']
  duration_unit            ClinicalDurationUnit    [null]
  food_relation            MedicationFoodRelation  [null]
  timing                   varchar(120)            [null, note: '''"Morning and night", "at bedtime". Free text beside the structured frequency, because a clinic's timing vocabulary is its own.''']
  quantity                 decimal(12, 3)          [null, note: 'Total to dispense. ⚠️ Decimal for the same reason `dose` is, and NULLABLE because a doctor prescribing an ointment "as needed" is not stating one.']
  start_date               date                    [null, note: '⚠️ DATES, NOT INSTANTS. "Start on Monday" is a calendar statement.']
  end_date                 date                    [null]
  repeats_authorised       boolean                 [null, note: '''⚠️ THE PRESCRIBER'S ENDORSEMENT THAT THIS MAY BE DISPENSED MORE THAN ONCE (PI-8, closing KNOWN_ISSUES #8).''']
  repeats_authorised_limit smallint                [null, note: 'How many repeats. ⚠️ NULL ALONGSIDE `repeatsAuthorised = true` RESOLVES `UNDETERMINED`, WHICH REFUSES, and that is deliberate rather than a gap: an en …']
  is_prn                   boolean                 [not null, default: false, note: '"As needed". ⚠️ NOT the same as a NULL frequency: PRN says the patient decides when, a NULL says the doctor did not write it down.']
  instructions             text                    [null, note: '⚠️ PHI. What the columns cannot say — "shake well", "stop if rash".']
  notes                    text                    [null, note: '⚠️ PHI. For the record rather than for the patient.']
  display_order            integer                 [not null, default: 0]
  created_at               timestamptz             [not null, default: `now()`]
  updated_at               timestamptz             [not null, note: 'auto-updated on write']

  indexes {
    (organization_id, encounter_id, display_order)
    (organization_id, product_id) [note: '''PI-7's read: what is outstanding against this product, and what was prescribed at this branch.''']
    (organization_id, branch_id, created_at)
    (organization_id, id) [unique, note: '''Composite-FK target, added in PI-7 so a dispense line can cite the prescribed line it answers without a bare id that could point at another tenant's r …''']
  }

  Note: 'What was prescribed. The row PI-7 dispenses against. ⚠️ `productId` IS A PLAIN FK INTO A POSSIBLY-PLATFORM ROW, exactly as `encounters.template_id` is and `batches.product_id` is. The composite FK is impossible'
}

Table encounter_investigations {
  id              uuid                  [pk, not null, default: `uuid()`]
  organization_id uuid                  [not null]
  branch_id       uuid                  [not null]
  encounter_id    uuid                  [not null]
  item_id         uuid                  [null, note: 'Not nullable in the migration — see `EncounterProcedure` for why an order is coded and a symptom need not be.']
  reason          text                  [null, note: '''⚠️ PHI. Why it was ordered, in the clinician's words.''']
  priority        InvestigationPriority [not null, default: 'ROUTINE']
  instructions    text                  [null, note: '⚠️ PHI. "Fasting", "left side only".']
  status          InvestigationStatus   [not null, default: 'ORDERED']
  display_order   integer               [not null, default: 0]
  created_at      timestamptz           [not null, default: `now()`]
  updated_at      timestamptz           [not null, note: 'auto-updated on write']

  indexes {
    (organization_id, encounter_id, display_order)
    (organization_id, status, created_at)
  }

  Note: '''What was ordered. ⚠️ NOT A LAB ORDER, BECAUSE THE LAB MODULE DOES NOT EXIST. This is the CONSULTATION's statement that something was asked for; when the lab ships, its own workflow references these rows rather than replacing them.'''
}

Table encounter_advice {
  id              uuid        [pk, not null, default: `uuid()`]
  organization_id uuid        [not null]
  branch_id       uuid        [not null]
  encounter_id    uuid        [not null]
  item_id         uuid        [null]
  custom_text     text        [null, note: '⚠️ PHI once tailored. Exactly one of the two, by CHECK — see the symptom.']
  is_edited       boolean     [not null, default: false, note: 'TRUE when the clinician changed the library text before giving it.']
  display_order   integer     [not null, default: 0]
  created_at      timestamptz [not null, default: `now()`]
  updated_at      timestamptz [not null, note: 'auto-updated on write']

  indexes {
    (organization_id, encounter_id, display_order)
  }

  Note: 'What the patient was told to do. ⚠️ `isEdited` IS NOT DECORATION. Advice is picked from a library and then tailored — "brushing technique" becomes "brushing technique, and stop using the hard brush".'
}

Table encounter_referrals {
  id                uuid            [pk, not null, default: `uuid()`]
  organization_id   uuid            [not null]
  branch_id         uuid            [not null]
  encounter_id      uuid            [not null]
  specialty_id      uuid            [null, note: '⚠️ A PLAIN FK INTO `specialties`, WHICH ALLOWS A NULL organization_id, so it needs `specialty_visible`']
  doctor_profile_id uuid            [null, note: '''A colleague in this organization. Composite-FK'd: a doctor profile is always org-scoped, so the constraint CAN be drawn here and therefore is.''']
  external_name     varchar(255)    [null, note: '⚠️ PHI-adjacent. A clinician outside this organization, by name.']
  reason            text            [null, note: '⚠️ PHI. Why they are being referred.']
  urgency           ReferralUrgency [not null, default: 'ROUTINE']
  notes             text            [null, note: '⚠️ PHI.']
  display_order     integer         [not null, default: 0]
  created_at        timestamptz     [not null, default: `now()`]
  updated_at        timestamptz     [not null, note: 'auto-updated on write']

  indexes {
    (organization_id, encounter_id, display_order)
  }

  Note: 'Who else the patient is being sent to. ⚠️ THREE WAYS TO NAME THE DESTINATION AND AT LEAST ONE IS REQUIRED, by CHECK. A referral to a specialty ("see a cardiologist"), to a named colleague in this organization, or to somebody outside it entirely are all ordinary, and a row naming none of the three is …'
}

Table encounter_attachments {
  id              uuid                    [pk, not null, default: `uuid()`]
  organization_id uuid                    [not null]
  branch_id       uuid                    [not null]
  encounter_id    uuid                    [not null]
  stored_file_id  uuid                    [not null]
  kind            EncounterAttachmentKind [not null, default: 'OTHER']
  caption         varchar(500)            [null, note: '⚠️ PHI. "Pre-operative, upper left quadrant."']
  display_order   integer                 [not null, default: 0]
  created_at      timestamptz             [not null, default: `now()`]
  updated_at      timestamptz             [not null, note: 'auto-updated on write']

  indexes {
    (organization_id, encounter_id, stored_file_id) [unique, note: 'One row per file per consultation — attaching the same photograph twice is a double-click, not a second attachment.']
    (organization_id, encounter_id, display_order)
  }

  Note: '''A file on the consultation — a photograph, a report, a consent. ⚠️ THE BYTES ARE IN `files` AND THE CLINICAL MEANING IS HERE, and the split is §27's. This row says a stored file belongs to this consultation and what it is clinically; `files` says where the bytes are and who uploaded them.'''
}

Table visual_maps {
  id              uuid              [pk, not null, default: `uuid()`]
  organization_id uuid              [null, note: 'NULL = platform row, visible to every tenant.']
  code            varchar(64)       [not null, note: '⚠️ FLAT, NOT A PATH — `HUMAN_DENTAL`, never `HUMAN-DEN-ADULT`. It is what a template names in its `mapCode` (CD-6), so it is also the one string that …']
  name            varchar(160)      [not null]
  description     text              [null]
  renderer        VisualMapRenderer [not null, default: 'SVG']
  asset_key       varchar(120)      [null, note: 'The raster asset an IMAGE_MAP is drawn over. NULL for an SVG map, which draws its regions and nothing else.']
  care_context_id uuid              [not null, note: 'The `CARE_CONTEXT` root this map belongs to (CD-3). A human dental chart and a veterinary one are different pictures of different mouths.']
  specialty_id    uuid              [null, note: 'The node it is especially for, anywhere below the care context. NULL means the map is offered across the care context']
  view_box        varchar(64)       [not null, note: '''The SVG coordinate space every region's geometry is expressed in. `"0 0 640 320"` — four numbers, validated by `@rcln/clinical`.''']
  is_active       boolean           [not null, default: true]
  created_at      timestamptz       [not null, default: `now()`]
  updated_at      timestamptz       [not null, note: 'auto-updated on write']
  deleted_at      timestamptz       [null]

  indexes {
    (organization_id, code) [unique, note: '⚠️ Rewritten NULLS NOT DISTINCT in the migration — without it the platform maps are not unique among themselves.']
    (organization_id, id) [unique, note: 'Composite-FK target for the regions, so a tenant can never bolt its own region onto a PLATFORM map (ADR-0004).']
    (organization_id, care_context_id, is_active)
    (organization_id, specialty_id)
  }

  Note: '''One chart: what it is a picture of, and how big its coordinate space is. ⚠️ PLATFORM-EXTENSIBLE WITH `specialties`' POLICY, NOT `files`'. Reproducing the NULL-permissive WITH CHECK would let any clinic publish a PLATFORM-WIDE map'''
}

Table visual_regions {
  id              uuid         [pk, not null, default: `uuid()`]
  organization_id uuid         [null, note: '''Mirrors the parent map's. NULL for a region of a platform map.''']
  map_id          uuid         [not null]
  code            varchar(64)  [not null]
  label           varchar(160) [not null]
  parent_id       uuid         [null, note: 'A grouping region — a quadrant, an arch, a side. NULL for a top-level one. ⚠️ `onDelete: Restrict`, NOT SetNull, for the reason the taxonomy records: …']
  display_order   integer      [not null, default: 0]
  metadata        jsonb        [null, note: '''The region's shape, in the map's `view_box` coordinates. ⚠️ PARSED BY `@rcln/clinical`'s `regions.ts` BEFORE ANYTHING DRAWS IT, and a document that is …''']
  created_at      timestamptz  [not null, default: `now()`]
  updated_at      timestamptz  [not null, note: 'auto-updated on write']

  indexes {
    (organization_id, map_id, code) [unique, note: '⚠️ NULLS NOT DISTINCT in the migration.']
    (organization_id, id) [unique, note: '''Composite-FK target for nothing yet — `clinical_findings.organization_id` is NOT NULL and a platform region's is NULL, so that pointer is a plain FK w …''']
    (organization_id, map_id, display_order)
    parent_id [note: 'Group walks recurse on `parent_id` — without this the recursive CTE seq-scans once per level.']
  }

  Note: 'One place on a map: a tooth, a quadrant, a scalp zone. ⚠️ `code` IS FDI FOR THE DENTAL MAP — `TOOTH_11` … `TOOTH_48` (CD-11). Not an index, and not a display notation. Universal and Palmer are RENDERINGS of the same stored codes, which is exactly what an index would have made impossible.'
}

Table clinical_findings {
  id               uuid             [pk, not null, default: `uuid()`]
  organization_id  uuid             [not null]
  branch_id        uuid             [not null]
  encounter_id     uuid             [not null]
  section_key      varchar(64)      [not null, note: 'The `TemplateSection.key` of the VISUAL_MAPPING section this was drawn on.']
  visual_region_id uuid             [not null, note: 'Where on the map. A plain FK — a platform region has no organization_id to compose with — so it needs a RESTRICTIVE `region_visible` policy.']
  finding_item_id  uuid             [not null, note: '''What was found: a `FINDING_TYPE` word. ⚠️ NOT NULL, unlike a symptom's or a diagnosis's item''']
  diagnosis_id     uuid             [null, note: 'What it was taken to mean, if the consultation committed to one. ⚠️ Restrict, AND SetNull IS NOT AVAILABLE']
  severity         ClinicalSeverity [null]
  notes            text             [null, note: '⚠️ PHI.']
  metadata         jsonb            [null, note: 'Per-finding qualifiers a map wants and no column should own — which surfaces of a tooth, which grade of mobility. ⚠️ A DOCUMENT, NOT IDS.']
  display_order    integer          [not null, default: 0]
  created_at       timestamptz      [not null, default: `now()`]
  updated_at       timestamptz      [not null, note: 'auto-updated on write']

  indexes {
    (organization_id, encounter_id, section_key, visual_region_id, finding_item_id) [unique, note: 'The same word twice on the same region of the same chart is a double click, not a second finding.']
    (organization_id, encounter_id, display_order)
    (organization_id, visual_region_id)
  }

  Note: 'What the clinician found, on which region, at which visit. ⚠️ ORG + BRANCH SCOPED AND PHI, LIKE THE EIGHT CE-4 TABLES AND FOR THE SAME REASONS. It carries its own `organization_id` AND `branch_id` rather than inheriting the org half through its encounter: a child of a branch-scoped parent that inher …'
}

// ===== consumption.prisma ==========================================

Table consumption_templates {
  id              uuid                      [pk, not null, default: `uuid()`]
  organization_id uuid                      [not null]
  item_id         uuid                      [not null, note: 'The procedure this is the template FOR. ⚠️ A PLAIN FK INTO A PLATFORM-EXTENSIBLE TABLE, so it needs a RESTRICTIVE `item_visible` policy']
  name            varchar(255)              [not null, note: 'What the clinic calls this version. Free text, not PHI.']
  version         integer                   [not null, default: 1, note: 'Monotonic within `(organization, item)`. Human-facing: "v3".']
  status          ConsumptionTemplateStatus [not null, default: 'DRAFT']
  effective_from  date                      [not null, note: '⚠️ DATES, NOT INSTANTS. "Which template was in force when this procedure was done" is a calendar question the clinic answers in its own timezone, the …']
  effective_to    date                      [null, note: 'NULL = still in force. ⚠️ At most ONE open-ended ACTIVE version per procedure, by partial unique index in the migration.']
  notes           text                      [null, note: 'Why this version exists. Not PHI — it is about a procedure.']
  created_at      timestamptz               [not null, default: `now()`]
  updated_at      timestamptz               [not null, note: 'auto-updated on write']
  updated_by      uuid                      [null]
  deleted_at      timestamptz               [null]

  indexes {
    (organization_id, item_id, version) [unique]
    (organization_id, id) [unique]
    (organization_id, item_id, effective_from) [note: '''The pre-fill's read: every version of one procedure's template, so the one in force on a date is a single index scan.''']
    (organization_id, status)
  }

  Note: 'What this procedure normally consumes. ⚠️ ORG-SCOPED, NOT BRANCH-SCOPED, AND IT HAS NO `branch_id` COLUMN AT ALL. "A root canal uses two pairs of gloves and 2 mL of anaesthetic" is a statement about how this ORGANIZATION practises, the same call `charge_policy_rules` makes about billability.'
}

Table consumption_template_lines {
  id              uuid           [pk, not null, default: `uuid()`]
  organization_id uuid           [not null]
  template_id     uuid           [not null]
  product_id      uuid           [not null, note: '⚠️ Plain FKs into platform-extensible tables — `product_visible` and `unit_visible`, both RESTRICTIVE, both in `enable-rls.sql` and in the migration.']
  quantity        decimal(18, 6) [not null, note: '''What the clinic thinks in — "2 pairs", "2 mL" — and the unit it says it in. ⚠️ NOT necessarily the product's base unit, which is the whole reason the …''']
  unit_id         uuid           [not null]
  is_optional     boolean        [not null, default: false, note: '"Usually, but not always." An optional line is pre-filled at zero rather than at its quantity, so a clinician adds it deliberately.']
  display_order   integer        [not null, default: 0, note: 'Sort within the template. Ties break by id so the order is total — the lesson KNOWN_ISSUES #1 cost on `stock_transfer_lines`.']
  note            text           [null]
  created_at      timestamptz    [not null, default: `now()`]
  updated_at      timestamptz    [not null, note: 'auto-updated on write']

  indexes {
    (organization_id, template_id, product_id) [unique, note: 'One line per product per version. A template that listed gloves twice pre-fills two rows for one thing and the clinician deletes one at random.']
    (organization_id, id) [unique]
    (organization_id, template_id, display_order)
    (organization_id, product_id)
  }

  Note: 'One product a procedure normally uses.'
}

Table clinical_consumptions {
  id                      uuid                    [pk, not null, default: `uuid()`]
  organization_id         uuid                    [not null]
  branch_id               uuid                    [not null, note: 'Where it happened. The RLS boundary and the branch whose shelves moved.']
  kind                    ClinicalConsumptionKind [not null, default: 'CONSUMPTION']
  anchor_kind             ConsumptionAnchorKind   [not null, note: '⚠️ ONE TYPED REFERENCE PER ANCHOR, NEVER A POLYMORPHIC PAIR. See the file header.']
  encounter_id            uuid                    [not null, note: 'NOT NULL for both built anchors: a procedure belongs to a consultation, so the encounter is known either way and every read filters on it.']
  encounter_procedure_id  uuid                    [null, note: 'Set when the anchor is a named procedure, NULL when the consumption is filed against the visit itself.']
  patient_id              uuid                    [not null, note: '⚠️ PHI, AND NOT NULLABLE — unlike `dispenses.patient_id`. There is no counter-sale equivalent here: consumption is anchored to a consultation, and a c …']
  location_id             uuid                    [not null, note: 'Which trolley, cabinet or room stock the material came off. Branch- qualified. ⚠️ NOT required to be a dispensing point']
  template_id             uuid                    [null, note: 'The version the panel pre-filled from, where one existed. NULL is ordinary — a procedure with no template records perfectly well.']
  recorded_by_id          uuid                    [not null]
  occurred_at             timestamptz             [not null, default: `now()`, note: '⚠️ WHEN IT WAS USED, not when it was keyed in. Every ledger leg carries this as its `occurred_at`, and the charge request as its `occurred_at`, which …']
  corrects_consumption_id uuid                    [null, note: 'The record this corrects. ⚠️ NOT NULL exactly when `kind` is not `CONSUMPTION`, by CHECK: a correction that cites nothing is a second consumption pret …']
  correction_reason       text                    [null, note: 'Why, on a correction. Required by CHECK on both correcting kinds.']
  notes                   text                    [null, note: '⚠️ PHI-capable. "Used the wider bur after the canal opened up."']
  amended_by_id           uuid                    [null, note: 'Set by `amendConsumption` while the encounter is still open. Its presence is what tells a reader that the quantities below are not the first ones reco …']
  amended_at              timestamptz             [null]
  created_at              timestamptz             [not null, default: `now()`]
  updated_at              timestamptz             [not null, note: 'auto-updated on write']

  indexes {
    (organization_id, id) [unique]
    (organization_id, branch_id, id) [unique]
    (organization_id, encounter_id) [note: '''The panel's read: everything consumed at this consultation.''']
    (organization_id, encounter_procedure_id)
    (organization_id, patient_id, occurred_at) [note: '"What has been used on this person" — a PHI read, one scan. | DESC on occurred_at']
    (organization_id, branch_id, occurred_at) [note: 'DESC on occurred_at']
    (organization_id, corrects_consumption_id)
  }

  Note: '''What one procedure, at one place, on one day, actually consumed. ⚠️ NO DRAFT, FOR THE REASON A DISPENSE HAS NONE. The material left the trolley and went into somebody's mouth once; a draft consumption would be stock that has physically gone with no ledger row saying so.'''
}

Table consumption_lines {
  id                     uuid           [pk, not null, default: `uuid()`]
  organization_id        uuid           [not null]
  branch_id              uuid           [not null]
  consumption_id         uuid           [not null]
  line_number            smallint       [not null]
  template_line_id       uuid           [null, note: 'The template line this answers, where the panel pre-filled it. NULL where the clinician added a product the template never listed']
  product_id             uuid           [not null, note: 'Plain FKs into platform-extensible tables — `product_visible`, `unit_visible`.']
  expected_quantity_base decimal(18, 6) [not null, note: '⚠️ WHAT THE TEMPLATE SAID, IN BASE UNITS, FROZEN AT THE MOMENT OF RECORDING. Zero where the clinician added the line themselves.']
  quantity_entered       decimal(18, 6) [not null, note: 'What the clinician typed, and the unit they thought in.']
  unit_id                uuid           [not null]
  quantity_base          decimal(18, 6) [not null, note: 'The same amount through the one `toBaseUnits` the ledger uses. Positive; the leg carries the sign and the sign is a property of the movement type.']
  is_override            boolean        [not null, default: false, note: 'Did somebody depart from what the template expected? ⚠️ DERIVED BY THE SERVICE FROM THE TWO NUMBERS DISAGREEING, NEVER TAKEN FROM THE CLIENT.']
  override_reason        text           [null, note: '⚠️ Required by CHECK whenever `is_override`, and gated on `consumption.override` at the route.']
  created_at             timestamptz    [not null, default: `now()`]
  updated_at             timestamptz    [not null, note: 'auto-updated on write']

  indexes {
    (organization_id, consumption_id, line_number) [unique]
    (organization_id, id) [unique]
    (organization_id, branch_id, id) [unique]
    (organization_id, consumption_id)
    (organization_id, product_id) [note: '''"How much of this product do procedures actually use" — PI-22's read.''']
    (organization_id, template_line_id)
  }

  Note: 'One product used, with what the template expected beside what was used. ⚠️ VARIANCE IS DERIVED AND NEVER STORED. `actual − expected` is arithmetic over two columns on this row;'
}

Table consumption_allocations {
  id                  uuid           [pk, not null, default: `uuid()`]
  organization_id     uuid           [not null]
  branch_id           uuid           [not null]
  consumption_line_id uuid           [not null]
  location_id         uuid           [not null]
  batch_id            uuid           [null]
  serial_id           uuid           [null]
  quantity_base       decimal(18, 6) [not null]
  is_override         boolean        [not null, default: false, note: 'Did a human reach past the FEFO plan for this lot? Recorded, not prevented, and the reason is required when it is true']
  override_reason     text           [null]
  created_at          timestamptz    [not null, default: `now()`]

  indexes {
    (organization_id, id) [unique]
    (organization_id, branch_id, id) [unique]
    (organization_id, consumption_line_id)
    (organization_id, batch_id) [note: 'Traceability: "which patients got this lot", asked from the batch side.']
    (organization_id, serial_id)
  }

  Note: 'Which physical lot the quantity on a line came out of. ⚠️ ITS OWN TABLE FOR THE REASON `dispense_allocations` IS ONE: a line routinely spans two lots, and a `batch_id` on the line would force the clinician to key two lines for one material — which then reads as two consumptions to every report.'
}

// ===== doctors.prisma ==============================================

Table specialties {
  id              uuid             [pk, not null, default: `uuid()`]
  organization_id uuid             [null, note: 'NULL = platform row, visible to every tenant.']
  parent_id       uuid             [null, note: 'Self-reference: a sub-specialty of another specialty. Collapses the old specialties / sub_specialties / specialization_map triple into one master.']
  code            varchar(64)      [not null]
  name            varchar(255)     [not null]
  type            TaxonomyNodeType [not null, default: 'SPECIALTY', note: '''Descriptive label only — see the enum. NOT the tree's shape.''']
  description     text             [null]
  display_order   integer          [not null, default: 0, note: 'Sort among siblings. Ties break by `name` so the order is total.']
  metadata        jsonb            [null, note: 'Free-form document: display labels per locale, external system codes (SNOMED CT, NUCC), regional applicability flags.']
  is_active       boolean          [not null, default: true]
  created_at      timestamptz      [not null, default: `now()`]
  updated_at      timestamptz      [not null, note: 'auto-updated on write']
  deleted_at      timestamptz      [null]

  indexes {
    (organization_id, code) [unique, note: '⚠️ Rewritten NULLS NOT DISTINCT in the migration — without it the platform rows (organization_id NULL) are not unique among themselves.']
    (organization_id, is_active)
    parent_id [note: 'Descendant walks recurse on `parent_id`. Without this the recursive CTE seq-scans the table once PER LEVEL.']
    (organization_id, type)
  }

  Note: 'Clinical specialties. Platform catalogue with per-tenant extension: `organizationId = NULL` is a platform row every clinic sees. WHY BOTH, RATHER THAN ONE OR THE OTHER Per-tenant only means every clinic re-types "Cardiology", and cross-clinic reporting plus the later `procedures.specialty_id` become …'
}

Table qualifications {
  id              uuid         [pk, not null, default: `uuid()`]
  organization_id uuid         [null]
  code            varchar(64)  [not null]
  name            varchar(255) [not null]
  is_active       boolean      [not null, default: true]
  created_at      timestamptz  [not null, default: `now()`]
  updated_at      timestamptz  [not null, note: 'auto-updated on write']
  deleted_at      timestamptz  [null]

  indexes {
    (organization_id, code) [unique, note: '⚠️ NULLS NOT DISTINCT in the migration, as above.']
  }

  Note: 'Medical qualifications (MBBS, MD, MS…). Same platform-plus-tenant shape and the same non-permissive WITH CHECK as `specialties`.'
}

Table doctor_profiles {
  id                      uuid         [pk, not null, default: `uuid()`]
  organization_id         uuid         [not null]
  user_id                 uuid         [not null]
  registration_number     varchar(64)  [null, note: 'Medical council registration. The number that makes a prescription legal.']
  registration_council    varchar(255) [null]
  registration_valid_till date         [null]
  experience_years        smallint     [null]
  bio                     text         [null]
  signature_file_id       uuid         [null]
  status                  DoctorStatus [not null, default: 'ACTIVE']
  created_at              timestamptz  [not null, default: `now()`]
  updated_at              timestamptz  [not null, note: 'auto-updated on write']
  deleted_at              timestamptz  [null]

  indexes {
    (organization_id, user_id) [unique]
    (organization_id, id) [unique, note: 'Composite-FK target: schedules, appointments and queue tokens reference (organization_id, id) so a cross-tenant row is unrepresentable.']
    (organization_id, registration_number) [unique, note: '⚠️ NULLS NOT DISTINCT in the migration — the column is nullable, and a council number appearing twice in one clinic is a data-entry error worth refusi …']
    (organization_id, status)
  }

  Note: 'The practitioner. One row per doctor PER ORGANIZATION. ⚠️ `userId` IS UNIQUE PER ORGANIZATION, NOT GLOBALLY. The design ERD draws `user_id UK`, which is wrong for this codebase: `users` is global and RLS-exempt — one login spans organizations'
}

Table doctor_specialties {
  id                uuid                 [pk, not null, default: `uuid()`]
  organization_id   uuid                 [not null]
  doctor_profile_id uuid                 [not null]
  specialty_id      uuid                 [not null]
  is_primary        boolean              [not null, default: false, note: 'At most one TRUE per doctor, enforced by the partial unique index `doctor_specialties_one_primary` from the doctors migration']
  proficiency       SpecialtyProficiency [null, note: 'Advisory display label. ⚠️ Never an authorization input — see the enum.']
  effective_from    date                 [null, note: 'When this classification began and ended. Both NULL is the ordinary case: "practises this, no dates recorded".']
  effective_to      date                 [null]
  is_active         boolean              [not null, default: true]
  created_at        timestamptz          [not null, default: `now()`]
  updated_at        timestamptz          [not null, note: 'auto-updated on write']

  indexes {
    (organization_id, doctor_profile_id, specialty_id) [unique]
    (organization_id, specialty_id)
  }

  Note: 'Which specialties a doctor practises. Org-scoped rather than parent-scoped because it points at TWO parents, one of which (`specialties`) may be a platform row — so scoping through `doctor_profiles` alone would leave the specialty side unconstrained.'
}

Table doctor_qualifications {
  id                 uuid         [pk, not null, default: `uuid()`]
  organization_id    uuid         [not null]
  doctor_profile_id  uuid         [not null]
  qualification_id   uuid         [not null]
  institute          varchar(255) [null]
  year_of_completion smallint     [null]
  created_at         timestamptz  [not null, default: `now()`]

  indexes {
    (organization_id, doctor_profile_id, qualification_id, institute) [unique, note: '`institute` is part of the key: the same degree from two institutions is two legitimate rows. ⚠️ NULLS NOT DISTINCT in the migration.']
  }

  Note: 'Which qualifications a doctor holds. Same two-parent shape as above.'
}

Table doctor_branch_settings {
  id                  uuid        [pk, not null, default: `uuid()`]
  organization_id     uuid        [not null]
  doctor_profile_id   uuid        [not null]
  branch_id           uuid        [not null]
  follow_up_free_days smallint    [null, note: '⚠️ `consultation_fee` AND `follow_up_fee` WERE HERE AND ARE NOW ON `fee_schedule_entries`, migrated by `fee_schedule_and_doctor_compensation`.']
  is_active           boolean     [not null, default: true]
  created_at          timestamptz [not null, default: `now()`]
  updated_at          timestamptz [not null, note: 'auto-updated on write']

  indexes {
    (organization_id, doctor_profile_id, branch_id) [unique]
    (organization_id, branch_id, is_active)
  }

  Note: 'What a doctor charges at one branch. ⚠️ DELIBERATELY NO `slotMinutes` AND NO `acceptsOnlineBooking`. Both were on the design ERD and both are removed. Slot duration has ONE authoritative chain'
}

Table fee_schedule_entries {
  id                uuid           [pk, not null, default: `uuid()`]
  organization_id   uuid           [not null]
  branch_id         uuid           [null, note: '''NULL = every branch. Composite-FK'd when present.''']
  doctor_profile_id uuid           [null, note: '''NULL = the clinic's default, which every doctor inherits.''']
  fee_type          varchar(64)    [not null, note: '`NEW`, `FOLLOW_UP`, `WALK_IN`, `TELECONSULT`, `PROCEDURE`, `RESCHEDULE`.']
  amount            decimal(14, 2) [not null, note: '''Currency is the organization's, as everywhere else in this schema.''']
  created_at        timestamptz    [not null, default: `now()`]
  updated_at        timestamptz    [not null, note: 'auto-updated on write']
  updated_by        uuid           [null]

  indexes {
    (organization_id, doctor_profile_id, branch_id, fee_type) [unique, note: '⚠️ NULLS NOT DISTINCT in the migration. Both scoping columns are nullable, and a plain unique index does not constrain NULLs']
    (organization_id, fee_type) [note: '''The resolver's read: every candidate row for one fee type, in one index.''']
  }

  Note: 'What an appointment costs: one row per (branch, doctor, kind of visit). ⚠️ BOTH `branch_id` AND `doctor_profile_id` ARE NULLABLE, AND NULL MEANS "ALL" ON EACH AXIS INDEPENDENTLY.'
}

Table doctor_compensation {
  id                uuid           [pk, not null, default: `uuid()`]
  organization_id   uuid           [not null]
  doctor_profile_id uuid           [not null]
  amount            decimal(14, 2) [null, note: '''Gross, in the organization's currency. Null means "not agreed yet", which is different from zero — an unpaid honorary consultant is a real thing.''']
  interval          PayoutInterval [null, note: 'Null alongside a null amount. Meaningless without one.']
  created_at        timestamptz    [not null, default: `now()`]
  updated_at        timestamptz    [not null, note: 'auto-updated on write']
  updated_by        uuid           [null]

  indexes {
    (organization_id, doctor_profile_id) [unique]
  }

  Note: 'What the clinic has agreed to pay a doctor. A RECORD, NOT A PAYROLL RUN. ⚠️ NOTHING COMPUTES ANYTHING FROM THIS. There are no payout periods, no payslips and no reconciliation against what the doctor actually billed'
}

Table doctor_schedules {
  id                uuid        [pk, not null, default: `uuid()`]
  organization_id   uuid        [not null]
  doctor_profile_id uuid        [not null]
  branch_id         uuid        [not null]
  day_of_week       smallint    [not null]
  start_time        time        [not null]
  end_time          time        [not null]
  slot_minutes      smallint    [null, note: 'NULL = fall back to the resolved `appointment.slot_minutes` setting. This is the ONLY per-block override, and the only column the engine reads.']
  max_patients      smallint    [null, note: 'Cap on bookings in this block. ⚠️ ADVISORY — no constraint enforces it, so two concurrent bookings into different free slots can exceed it by one.']
  valid_from        date        [not null]
  valid_to          date        [null]
  is_active         boolean     [not null, default: true]
  created_at        timestamptz [not null, default: `now()`]
  updated_at        timestamptz [not null, note: 'auto-updated on write']

  indexes {
    (organization_id, branch_id, day_of_week)
    (doctor_profile_id, day_of_week)
  }

  Note: '''A recurring block of working hours: this doctor, this branch, this weekday. ⚠️ `startTime`/`endTime` ARE WALL-CLOCK IN THE BRANCH'S TIMEZONE. Not UTC, not the org's zone, not the server's.'''
}

Table doctor_schedule_exceptions {
  id                uuid                    [pk, not null, default: `uuid()`]
  organization_id   uuid                    [not null]
  doctor_profile_id uuid                    [not null]
  branch_id         uuid                    [null, note: 'NULL = applies at every branch.']
  exception_type    ScheduleExceptionType   [not null]
  starts_at         timestamptz             [not null]
  ends_at           timestamptz             [not null]
  reason            varchar(255)            [null]
  status            ScheduleExceptionStatus [not null, default: 'REQUESTED']
  requested_by      uuid                    [null]
  decided_by        uuid                    [null]
  decided_at        timestamptz             [null]
  created_at        timestamptz             [not null, default: `now()`]
  updated_at        timestamptz             [not null, note: 'auto-updated on write']

  indexes {
    (organization_id, doctor_profile_id, starts_at)
    (organization_id, status, starts_at) [note: 'The approvals inbox.']
  }

  Note: 'A one-off departure from the recurring schedule: leave, a block, an extra shift. Stored as `timestamptz` rather than a date plus a time, because an exception is an absolute interval — "away from Friday 18:00 until Monday 09:00"'
}

// ===== identity.prisma =============================================

Table users {
  id                            uuid         [pk, not null, default: `uuid()`]
  email                         varchar(255) [unique, null]
  phone                         varchar(20)  [unique, null]
  password_hash                 varchar(255) [null]
  full_name                     varchar(255) [not null]
  avatar_file_id                uuid         [null]
  status                        UserStatus   [not null, default: 'INVITED']
  is_platform_admin             boolean      [not null, default: false, note: 'The seeded platform operator. Bypasses membership checks entirely and can enter any tenant — every such action is written to audit_logs.']
  mfa_enabled                   boolean      [not null, default: false]
  mfa_secret                    varchar(255) [null]
  locale                        varchar(10)  [not null, default: 'en']
  last_platform_organization_id uuid         [null, note: 'The clinic this platform admin last worked inside, so the console can offer it again on their next sign-in instead of making them find it.']
  email_verified_at             timestamptz  [null]
  phone_verified_at             timestamptz  [null]
  last_login_at                 timestamptz  [null]
  failed_login_attempts         smallint     [not null, default: 0]
  locked_until                  timestamptz  [null]
  created_at                    timestamptz  [not null, default: `now()`]
  updated_at                    timestamptz  [not null, note: 'auto-updated on write']
  deleted_at                    timestamptz  [null]

  indexes {
    status
    is_platform_admin
  }

  Note: 'ONE table for every human: super admin, doctor, receptionist, patient. Deliberately global (not org-scoped) so one person can hold memberships in several organizations with a single login. There is NO role column here — roles live on membership_roles, scoped per branch.'
}

Table user_identities {
  id           uuid         [pk, not null, default: `uuid()`]
  user_id      uuid         [not null]
  provider     varchar(32)  [not null]
  provider_uid varchar(255) [not null]
  created_at   timestamptz  [not null, default: `now()`]

  indexes {
    (provider, provider_uid) [unique]
    user_id
  }
}

Table sessions {
  id                      uuid         [pk, not null, default: `uuid()`]
  user_id                 uuid         [not null]
  active_organization_id  uuid         [null]
  active_branch_id        uuid         [null]
  impersonated_by_user_id uuid         [null]
  refresh_token_hash      varchar(255) [unique, not null, note: 'Opaque 256-bit token, hashed. Rotated on every refresh; presenting an already-rotated token revokes the whole family (theft signal).']
  previous_token_hash     varchar(255) [null]
  ip_address              inet         [null]
  user_agent              varchar(512) [null]
  expires_at              timestamptz  [not null]
  revoked_at              timestamptz  [null]
  created_at              timestamptz  [not null, default: `now()`]
  last_used_at            timestamptz  [null]

  indexes {
    (user_id, revoked_at)
    expires_at
  }

  Note: 'Where branch switching physically lives. Changing the active branch is an UPDATE here plus a re-issued access token — never a re-login.'
}

Table auth_tokens {
  id          uuid             [pk, not null, default: `uuid()`]
  user_id     uuid             [null]
  purpose     AuthTokenPurpose [not null]
  identifier  varchar(255)     [not null]
  code_hash   varchar(255)     [not null]
  attempts    smallint         [not null, default: 0]
  expires_at  timestamptz      [not null]
  consumed_at timestamptz      [null]
  created_at  timestamptz      [not null, default: `now()`]

  indexes {
    (identifier, purpose)
    expires_at
  }

  Note: 'OTP and one-shot links. Phone-first login is non-negotiable in Indian healthcare, so this carries attempt counting and hard expiry.'
}

// ===== inventory.prisma ============================================

Table inventory_locations {
  id                         uuid         [pk, not null, default: `uuid()`]
  organization_id            uuid         [not null]
  branch_id                  uuid         [not null]
  kind                       LocationKind [not null]
  code                       varchar(64)  [not null, note: '''The clinic's own code. Unique per branch, not per organization — two sites both calling their fridge `FRIDGE-1` is the ordinary case.''']
  name                       varchar(255) [not null]
  is_dispensing_point        boolean      [not null, default: false, note: 'Whether stock may be dispensed or consumed directly FROM here. A central warehouse usually cannot; a main pharmacy always can. UI and PI-7 read it;']
  requires_controlled_access boolean      [not null, default: false, note: 'A locked cabinet with a register. Descriptive here; PI-5 decides which products a jurisdiction REQUIRES it for.']
  storage_profile_id         uuid         [null, note: '''What this place can physically keep — the fridge's own range. Matched against a product's `storage_profile_id` when stock is received, so a vaccine in …''']
  is_active                  boolean      [not null, default: true]
  created_at                 timestamptz  [not null, default: `now()`]
  updated_at                 timestamptz  [not null, note: 'auto-updated on write']
  deleted_at                 timestamptz  [null]

  indexes {
    (organization_id, branch_id, code) [unique]
    (organization_id, id) [unique, note: 'The composite-FK target every child below references.']
    (organization_id, branch_id, id) [unique, note: '⚠️ THE BRANCH-QUALIFIED TARGET, AND IT IS WHAT MAKES A CROSS-BRANCH MOVEMENT UNREPRESENTABLE RATHER THAN MERELY REFUSED.']
    (organization_id, branch_id, is_active)
    (organization_id, branch_id, kind)
  }

  Note: 'A place stock is kept. `branch -> location -> area -> bin` (PI-ADR-012). ⚠️ A BRANCH HAS MANY LOCATIONS, AND ASSUMING ONE IS UNRECOVERABLE WITHOUT A MIGRATION UNDER LIVE STOCK.'
}

Table storage_areas {
  id              uuid         [pk, not null, default: `uuid()`]
  organization_id uuid         [not null]
  branch_id       uuid         [not null]
  location_id     uuid         [not null]
  code            varchar(64)  [not null]
  name            varchar(255) [not null]
  is_active       boolean      [not null, default: true]
  created_at      timestamptz  [not null, default: `now()`]
  updated_at      timestamptz  [not null, note: 'auto-updated on write']

  indexes {
    (organization_id, location_id, code) [unique]
    (organization_id, id) [unique]
    (organization_id, branch_id, location_id)
  }

  Note: 'A named part of a location — an aisle, a shelf, a fridge drawer. Areas and bins are NOT separately branch-scoped (PI-ADR-012): they inherit through the composite FK, exactly as invoice children do.'
}

Table storage_bins {
  id              uuid         [pk, not null, default: `uuid()`]
  organization_id uuid         [not null]
  branch_id       uuid         [not null]
  area_id         uuid         [not null]
  code            varchar(64)  [not null]
  label           varchar(255) [null]
  is_active       boolean      [not null, default: true]
  created_at      timestamptz  [not null, default: `now()`]
  updated_at      timestamptz  [not null, note: 'auto-updated on write']

  indexes {
    (organization_id, area_id, code) [unique]
    (organization_id, id) [unique, note: '⚠️ PRESENT SO PI-3 CAN COMPOSITE-FK TO A BIN WITHOUT A MIGRATION UNDER LIVE STOCK.']
    (organization_id, branch_id, area_id)
  }

  Note: 'The smallest addressable place. A shelf position, a tote, a drawer slot. Bins are addresses, not quantities: `stock_balances` is keyed by LOCATION, not by bin, because a bin is where a person walks to and a location is what the clinic reconciles.'
}

Table batches {
  id                uuid         [pk, not null, default: `uuid()`]
  organization_id   uuid         [not null]
  branch_id         uuid         [not null]
  product_id        uuid         [not null]
  lot_number        varchar(128) [not null, note: 'As printed on the pack. Case is preserved; comparison is exact, because a lot number is an identifier and `AB12` is not `ab12` to a regulator.']
  manufactured_on   date         [null, note: '''DATES, not instants. A batch is manufactured and expires on a DAY, in the manufacturer's calendar, in nobody's particular timezone.''']
  expires_on        date         [null]
  retest_on         date         [null, note: 'Some products are re-tested and re-dated rather than expiring outright — reagents and some APIs. Informational until PI-5 gives it a rule.']
  manufacturer_id   uuid         [null]
  unit_cost_base    bigint       [null, note: 'Cost per BASE UNIT in integer minor units (PI-ADR-010). Per base unit, not per pack: a supplier changing from strips of 10 to strips of 15 must not si …']
  currency          char(3)      [null, note: 'ISO 4217. Required whenever a cost is recorded — CHECKed in the migration, because a number with no currency is a number that will be added to a diffe …']
  status            BatchStatus  [not null, default: 'ACTIVE']
  quarantined_at    timestamptz  [null]
  quarantine_reason text         [null]
  recalled_at       timestamptz  [null]
  recall_reference  varchar(128) [null, note: '''The regulator's or manufacturer's own notice number, so a batch can be tied back to the announcement that caused it.''']
  received_at       timestamptz  [not null, default: `now()`, note: 'When this lot physically arrived. The FEFO tie-break: two batches expiring the same day go out oldest-received first.']
  notes             text         [null]
  created_at        timestamptz  [not null, default: `now()`]
  updated_at        timestamptz  [not null, note: 'auto-updated on write']

  indexes {
    (organization_id, branch_id, product_id, lot_number) [unique]
    (organization_id, id) [unique]
    (organization_id, branch_id, id) [unique, note: 'Branch-qualified, for the same reason as `inventory_locations`. A movement at branch A citing a lot held at branch B is now unrepresentable.']
    (organization_id, branch_id, product_id, expires_on) [note: 'FEFO allocation and the expiry sweep, which is the same query twice.']
    (organization_id, branch_id, expires_on)
    (organization_id, product_id)
  }

  Note: '''A lot of one product, received once, with one expiry and one cost. ⚠️ LOT UNIQUENESS IS TENANT- AND BRANCH-QUALIFIED, NEVER GLOBAL. A lot number is the MANUFACTURER's identifier, so two clinics stocking the same medicine hold the same lot number, and one hospital group receiving that lot at two site …'''
}

Table serials {
  id                  uuid         [pk, not null, default: `uuid()`]
  organization_id     uuid         [not null]
  branch_id           uuid         [not null]
  product_id          uuid         [not null]
  batch_id            uuid         [null]
  serial_number       varchar(128) [not null]
  status              SerialStatus [not null, default: 'IN_STOCK']
  current_location_id uuid         [null, note: 'Where it is right now. NULL once it has left the clinic.']
  assigned_patient_id uuid         [null, note: '⚠️ PHI. See the model comment.']
  assigned_at         timestamptz  [null]
  expires_on          date         [null, note: '''A device's own expiry, where it has one distinct from its batch's.''']
  notes               text         [null]
  created_at          timestamptz  [not null, default: `now()`]
  updated_at          timestamptz  [not null, note: 'auto-updated on write']

  indexes {
    (organization_id, product_id, serial_number) [unique, note: 'Serial numbers repeat across manufacturers, so the key is product-qualified as well as tenant-qualified.']
    (organization_id, id) [unique]
    (organization_id, branch_id, id) [unique, note: 'Branch-qualified, for the same reason as `inventory_locations`.']
    (organization_id, branch_id, status)
    (organization_id, batch_id)
    (organization_id, assigned_patient_id) [note: '"Which patient has device X" and "which devices does this patient have" — the recall question, from both ends.']
  }

  Note: 'One physically identifiable unit. An implant, a device, an instrument set. ⚠️ `assigned_patient_id` IS PHI. "Serial 7742 is in Mrs Rao" is a clinical fact about a named person, answerable by primary key, and it is why this table is branch-scoped rather than org-scoped: a device fitted at one site is …'
}

Table stock_ledger {
  id               uuid               [pk, not null, default: `uuid()`]
  organization_id  uuid               [not null]
  branch_id        uuid               [not null]
  product_id       uuid               [not null]
  batch_id         uuid               [null]
  serial_id        uuid               [null]
  tracking_mode    TrackingMode       [not null, note: 'Snapshot of `products.tracking_mode`. See the model comment.']
  movement_type    StockMovementType  [not null]
  quantity_base    decimal(18, 6)     [not null, note: '''SIGNED, in the product's base unit. ⚠️ The sign is derived from `movementType` and CHECKed; no caller ever chooses it. See the enum.''']
  quantity_entered decimal(18, 6)     [not null, note: 'What the user actually typed, and in what. Kept so a receipt of "2 boxes" still reads as "2 boxes" a year later, when the pack size has changed and `q …']
  unit_id          uuid               [not null]
  from_location_id uuid               [null, note: 'Which bucket the quantity left and which it entered. Both, one, or the other, paired with `movementType` by the direction CHECK.']
  to_location_id   uuid               [null]
  status_from      StockStatus        [null]
  status_to        StockStatus        [null]
  reason_code      varchar(64)        [null, note: 'Mandatory on `ADJUSTMENT` (CHECKed) and optional elsewhere. An adjustment with no reason is a number nobody can audit, and adjustments are precisely w …']
  reason_note      text               [null]
  reference_type   StockReferenceType [not null]
  reference_id     uuid               [null, note: 'The id in the referenced domain. Not a FK — see the model comment.']
  unit_cost_base   bigint             [null, note: 'Cost carried on the movement itself, so a valuation report never has to guess what the batch cost when this row was written.']
  currency         char(3)            [null]
  actor_user_id    uuid               [not null, note: 'Who did it. NOT NULL: a movement with no actor is a movement nobody can be asked about, and the expiry sweep supplies a real user rather than a fictio …']
  occurred_at      timestamptz        [not null, default: `now()`, note: 'When it HAPPENED, which is not always when it was recorded: a receipt entered on Monday for goods that arrived on Friday is ordinary.']
  recorded_at      timestamptz        [not null, default: `now()`, note: 'When the row was written. Immutable, and the two together are what make a backdated entry visible as one.']

  indexes {
    (organization_id, branch_id, product_id, occurred_at) [note: '''The ledger screen: one product's history at one branch, newest first. | DESC on occurred_at''']
    (organization_id, batch_id, occurred_at) [note: '''One batch's whole life. The recall query.''']
    (organization_id, reference_type, reference_id) [note: 'Traceability: "what did this goods receipt / this dispense do".']
    (organization_id, serial_id) [note: '''One device's history, end to end.''']
    (organization_id, branch_id, occurred_at) [note: 'The replay `verifyBalances()` runs, and the branch-wide ledger view. | DESC on occurred_at']
  }

  Note: 'EVERY movement of every quantity, for ever. The most important table in the programme (PI-ADR-004). ── APPEND-ONLY, ENFORCED TWICE ────────────────────────────────────────────── Exactly as `audit_logs` and `data_access_logs` already are in this repository: 1.'
}

Table stock_balances {
  id              uuid           [pk, not null, default: `uuid()`]
  organization_id uuid           [not null]
  branch_id       uuid           [not null]
  product_id      uuid           [not null]
  batch_id        uuid           [null]
  serial_id       uuid           [null]
  location_id     uuid           [not null]
  status          StockStatus    [not null]
  quantity        decimal(18, 6) [not null]
  updated_at      timestamptz    [not null, note: 'auto-updated on write']

  indexes {
    (organization_id, branch_id, product_id, batch_id, serial_id, location_id, status) [unique, note: '''The bucket key. ⚠️ Rewritten NULLS NOT DISTINCT in the migration: `batch_id` and `serial_id` are nullable, and under Postgres's default every untracke …''']
    (organization_id, branch_id, location_id, product_id, status) [note: '"What is on this shelf" — the stock-by-location screen.']
    (organization_id, product_id, status) [note: '"Where is this product" — across every location the caller can see.']
    (organization_id, batch_id)
  }

  Note: 'How much of what is where, in what condition. A CACHE (PI-ADR-004). ⚠️ NEVER AUTHORITATIVE, AND NOTHING IN THE APPLICATION WRITES IT. `rcln_app` holds no INSERT, UPDATE or DELETE here; the row is maintained by a SECURITY DEFINER trigger on `stock_ledger` and by nothing else.'
}

Table stock_reason_codes {
  id              uuid                 [pk, not null, default: `uuid()`]
  organization_id uuid                 [null, note: 'NULL = platform row, visible to every tenant.']
  code            varchar(64)          [not null, note: 'Uppercase, flat, and matched exactly against what a caller sends. Aggregated in reports, so free text would produce "Damaged", "damaged" and "DAMAGED …']
  label           varchar(200)         [not null, note: 'What a human picks from a list. Sentence case, and the only thing a screen shows.']
  direction       StockReasonDirection [not null, default: 'BOTH']
  requires_note   boolean              [not null, default: false, note: 'Whether citing this code forces a free-text note as well. `OTHER` is the code this exists for: a reason code that explains nothing unless somebody wri …']
  is_active       boolean              [not null, default: true, note: 'Retired rather than deleted. A code cited by ten thousand ledger rows is a code that must keep rendering; `is_active = false` stops it being OFFERED.']
  sort_order      smallint             [not null, default: 100, note: 'Presentation order in the picker. Ties break on `label`.']
  created_at      timestamptz          [not null, default: `now()`]
  updated_at      timestamptz          [not null, note: 'auto-updated on write']
  deleted_at      timestamptz          [null]

  indexes {
    (organization_id, code) [unique, note: '''⚠️ TENANT-QUALIFIED, NEVER A BARE `@@unique([code])`. A clinic naming its own code `DAMAGED` must not collide with the platform's, and two clinics mus …''']
    (organization_id, is_active, sort_order)
  }

  Note: 'The controlled vocabulary an adjustment must cite (PI-3.1). ⚠️ THE LEDGER STORES THE CODE AS A STRING AND NOT A FOREIGN KEY, DELIBERATELY. `stock_ledger.reason_code` is `VARCHAR(64)` and stays that way. A ledger row must outlive whatever explained it'
}

Table stock_transfers {
  id                  uuid                [pk, not null, default: `uuid()`]
  organization_id     uuid                [not null]
  transfer_number     varchar(64)         [null, note: 'Human-facing, issued from `number_sequences` on dispatch — never on create, because a draft that is abandoned must not burn a number in a series a sto …']
  from_branch_id      uuid                [not null]
  to_branch_id        uuid                [not null]
  from_location_id    uuid                [not null]
  to_location_id      uuid                [null, note: 'Where it lands. Nullable until receipt: the sender proposes a shelf and the RECEIVER decides, because the sender does not know which fridge has room.']
  from_location_name  varchar(255)        [not null, note: '⚠️ THE SHELF NAMES ARE SNAPSHOTTED, AND WITHOUT THEM THE RECEIVING BRANCH CANNOT READ ITS OWN DELIVERY NOTE.']
  to_location_name    varchar(255)        [null]
  status              StockTransferStatus [not null, default: 'DRAFT']
  notes               text                [null]
  created_by_id       uuid                [not null]
  dispatched_at       timestamptz         [null]
  dispatched_by_id    uuid                [null]
  received_at         timestamptz         [null, note: 'When the LAST line was received. A partially-received transfer has none.']
  received_by_id      uuid                [null]
  cancelled_at        timestamptz         [null]
  cancelled_by_id     uuid                [null]
  cancellation_reason text                [null, note: 'Why it was killed. CHECKed present whenever `cancelled_at` is — a transfer cancelled after dispatch has already moved stock twice and "why" is the onl …']
  created_at          timestamptz         [not null, default: `now()`]
  updated_at          timestamptz         [not null, note: 'auto-updated on write']

  indexes {
    (organization_id, transfer_number) [unique]
    (organization_id, id) [unique, note: 'The composite-FK target the lines reference.']
    (organization_id, to_branch_id, status) [note: '''"What is on its way to me" — the receiving branch's inbox, which is the screen this whole document exists to make possible.''']
    (organization_id, from_branch_id, status, created_at) [note: '''"What have I sent" — the sending branch's outbox. | DESC on created_at''']
  }

  Note: 'Stock moving from one place to another, as a DOCUMENT (PI-3.2, PI-3.3). ── WHY THE DOCUMENT HOLDS THE IN-TRANSIT QUANTITY ────────────────────────── branch A branch B AVAILABLE ──TRANSFER_OUT──▶ (this document) ──TRANSFER_IN──▶ AVAILABLE actor scoped to A actor scoped to B INVENTORY_ARCHITECTURE.md …'
}

Table stock_transfer_lines {
  id                     uuid           [pk, not null, default: `uuid()`]
  organization_id        uuid           [not null]
  transfer_id            uuid           [not null]
  product_id             uuid           [not null]
  batch_id               uuid           [null, note: '''The SENDING branch's lot. Required when the product is batch-tracked, which the ledger's tracking CHECK enforces on the leg rather than here.''']
  serial_id              uuid           [null]
  sent_quantity_base     decimal(18, 6) [not null, note: '''What the document says was sent, in the product's BASE UNIT. ⚠️ Not a quantity of stock — see the file header. Positive, CHECKed.''']
  received_quantity_base decimal(18, 6) [not null, default: 0, note: 'What the receiver signed for. Starts at zero and only ever grows, and a CHECK stops it exceeding what was sent']
  quantity_entered       decimal(18, 6) [not null, note: 'What the user actually typed, and in what — kept for the same reason the ledger keeps it: "2 boxes" must still read as "2 boxes" a year later.']
  unit_id                uuid           [not null]
  destination_batch_id   uuid           [null, note: '''The receiving branch's own lot row, created at receipt. See the model comment.''']
  lot_number             varchar(128)   [null, note: '⚠️ WITHOUT THESE THE RECEIVING BRANCH CANNOT CREATE ITS OWN LOT ROW, AND THE WHOLE INTER-BRANCH FLOW STOPS AT RECEIPT.']
  manufactured_on        date           [null]
  expires_on             date           [null]
  manufacturer_id        uuid           [null]
  unit_cost_base         bigint         [null]
  currency               char(3)        [null]
  notes                  text           [null]
  created_at             timestamptz    [not null, default: `now()`]
  updated_at             timestamptz    [not null, note: 'auto-updated on write']

  indexes {
    (organization_id, transfer_id, product_id, batch_id, serial_id) [unique, note: 'One line per (product, lot, serial) on a transfer. Sending the same lot twice on one document is a mistake with two plausible readings']
    (organization_id, transfer_id)
    (organization_id, product_id)
    (organization_id, batch_id)
  }

  Note: 'One product, one lot, one quantity, on one transfer. ⚠️ `batch_id` AND `destination_batch_id` ARE TWO DIFFERENT LOTS OF THE SAME PHYSICAL STOCK, AND THAT IS NOT A MODELLING MISTAKE. `batches` is BRANCH-scoped — `(organization_id, branch_id, id)` is its composite key and the whole file leans on it'
}

Table stock_reservations {
  id              uuid                   [pk, not null, default: `uuid()`]
  organization_id uuid                   [not null]
  branch_id       uuid                   [not null]
  product_id      uuid                   [not null]
  batch_id        uuid                   [null]
  serial_id       uuid                   [null]
  location_id     uuid                   [not null]
  quantity_base   decimal(18, 6)         [not null, note: '''In the product's BASE UNIT, positive, CHECKed. This is how much sits in the `RESERVED` bucket because of this row''']
  status          StockReservationStatus [not null, default: 'ACTIVE']
  reference_type  StockReferenceType     [not null, default: 'MANUAL', note: '''What it is being held FOR. The same non-FK pair as the ledger's, for the same reason: the domains that will fill it in do not exist yet.''']
  reference_id    uuid                   [null]
  expires_at      timestamptz            [not null, note: 'When the sweep gives it back. See the model comment.']
  notes           text                   [null]
  created_by_id   uuid                   [not null]
  released_at     timestamptz            [null, note: 'Set together with a terminal `status` — CHECKed, because a released reservation with no release time is one nobody can put on a timeline.']
  released_by_id  uuid                   [null, note: 'NULL when the SWEEP released it. That is how a screen tells "the pharmacist gave it back" from "it timed out", and the two mean different things.']
  created_at      timestamptz            [not null, default: `now()`]
  updated_at      timestamptz            [not null, note: 'auto-updated on write']

  indexes {
    (organization_id, status, expires_at) [note: '''The sweep's query: every ACTIVE reservation past its time. ⚠️ Deliberately NOT branch-qualified''']
    (organization_id, branch_id, product_id, status) [note: '"What is held at this shelf" — what allocation subtracts.']
    (organization_id, reference_type, reference_id) [note: '"What is held for this prescription" — the release path, from PI-7.']
  }

  Note: 'Stock spoken for and not yet gone (PI-3.4). `RESERVED` becomes real here. It was a `StockStatus` member with no workflow in PI-2, on purpose, so that this phase needed no enum migration. ⚠️ THE ROW IS THE PAPERWORK; THE `RESERVATION` MOVEMENT IS THE FACT.'
}

// ===== invoicing.prisma ============================================

Table invoices {
  id                               uuid                [pk, not null, default: `uuid()`]
  organization_id                  uuid                [not null]
  branch_id                        uuid                [not null, note: 'NOT NULL: the branch is the place of supply, the number series and the RLS boundary. An invoice with no branch could not be taxed or numbered.']
  invoice_number                   varchar(64)         [null, note: 'Null while DRAFT. See the header.']
  kind                             InvoiceKind         [not null, default: 'INVOICE', note: 'A charge, or a reversal of one (PI-8). See `InvoiceKind`.']
  credited_invoice_id              uuid                [null, note: '''The issued invoice this credit note reverses. Set iff `kind` is `CREDIT_NOTE`, by CHECK, and composite-FK'd so a clinic can never credit another clini …''']
  source_type                      InvoiceSourceType   [not null, note: '''What kind of thing this invoice bills for. The discriminator over the typed reference columns below — see the enum's header.''']
  appointment_id                   uuid                [null, note: '''The visit this invoice bills for. Set iff `sourceType` is APPOINTMENT, and composite-FK'd, so an invoice can never bill another clinic's appointment.''']
  patient_id                       uuid                [null, note: '''Null for a walk-in customer with no record — a supplier's rep buying a consumable, or a bill raised to a company.''']
  customer_name                    varchar(255)        [not null, note: '⚠️ THE CUSTOMER BLOCK IS A SNAPSHOT, NOT A JOIN, AND THAT IS NOT DENORMALISATION FOR SPEED. A patient marries and changes their surname;']
  customer_phone                   varchar(20)         [null]
  customer_email                   varchar(255)        [null]
  customer_address                 text                [null]
  customer_tax_id                  varchar(32)         [null, note: '''The customer's own GSTIN/VAT number, on the rare invoice raised to a business. Passed to the engine as UNVALIDATED — nothing checks it.''']
  practitioner_name                varchar(255)        [null, note: 'WHO PROVIDED THE CARE THIS INVOICE BILLS. A bill for a consultation that does not name the clinician is a receipt for an unattributed service: the pat …']
  practitioner_registration_number varchar(64)         [null, note: 'Their registration with their council, printed under the name where they hold one. Read from `doctor_profiles.registration_number` at billing time.']
  practitioner_profile_id          uuid                [null, note: 'WHO THIS INVOICE BELONGS TO, FOR QUERYING. The live link, where the two columns above are the printed document']
  supplied_at                      timestamptz         [not null, note: '⚠️ THE DATE OF SUPPLY, WHICH IS NOT `issued_at` AND NOT `now()`. It is what selects the effective-dated tax rule and the registration, so an invoice r …']
  issued_at                        timestamptz         [null, note: 'When it became a document. Null until then, and the pair with `invoice_number` — both are set by finalisation or neither is.']
  due_date                         date                [null]
  issuer_tax_registration_id       uuid                [null, note: '''Which of the clinic's registrations this was issued under. Composite-FK'd, so an invoice can never be raised under another tenant's GSTIN.''']
  issuer_tax_id                    varchar(64)         [null, note: 'The registration number as printed. Snapshotted beside the id because the row it came from can be corrected and this string may not change.']
  issuer_legal_name                varchar(255)        [null, note: 'The legal name the registration is held in, which is not always the name over the door. A GST invoice must print the registered name.']
  place_of_supply                  varchar(10)         [null, note: '''Where this supply was deemed to take place — `IN-KA`, `AE`. The BRANCH's jurisdiction, never the patient's address.''']
  tax_treatment                    TaxTreatment        [not null, default: 'NOT_REGISTERED', note: 'The document-level position, which is the worst of its lines: one UNRATED line makes the whole invoice unissuable.']
  currency                         char(3)             [not null, default: 'INR']
  subtotal                         decimal(14, 2)      [not null, default: 0, note: 'Σ line gross, before any discount. The order every column below is computed in is fixed in §0.5 of the implementation log and implemented once, in Pha …']
  line_discount_total              decimal(14, 2)      [not null, default: 0, note: 'Σ per-line discounts.']
  discount_type                    InvoiceDiscountType [null, note: 'The invoice-level discount AS ENTERED. Null means none.']
  discount_bps                     integer             [null, note: 'Set iff `discount_type` is PERCENTAGE. Basis points, so the input stays an integer. Enforced by CHECK']
  discount_fixed                   decimal(14, 2)      [null, note: 'Set iff `discount_type` is FIXED.']
  invoice_discount_total           decimal(14, 2)      [not null, default: 0, note: 'What the invoice-level discount came to once apportioned. ⚠️ APPORTIONED ACROSS THE LINES BEFORE TAX, NOT SUBTRACTED AFTER IT.']
  taxable_amount                   decimal(14, 2)      [not null, default: 0, note: 'Σ line taxable — what tax was actually computed on.']
  tax_total                        decimal(14, 2)      [not null, default: 0, note: 'Σ every `invoice_taxes` row. Rounded PER LINE, not per invoice: the two differ by up to (n−1) minor units, and per-line is what a GST invoice does and …']
  rounding_adjustment              decimal(14, 2)      [not null, default: 0, note: 'Cash rounding to the nearest note, where a clinic does that. Signed, and kept as its own column so `grand_total` never has to be explained.']
  grand_total                      decimal(14, 2)      [not null, default: 0]
  amount_paid                      decimal(14, 2)      [not null, default: 0, note: 'Settled so far. The balance is `grand_total − amount_paid` and is deliberately NOT a column: a stored balance is a third number that can disagree with …']
  status                           InvoiceStatus       [not null, default: 'DRAFT']
  notes                            text                [null, note: '⚠️ PHI-CAPABLE FREE TEXT, printed on the invoice. In `REDACTED_KEYS`.']
  cancellation_reason              text                [null, note: 'Why it was cancelled or voided. Same PHI treatment as `notes`.']
  created_by                       uuid                [null]
  issued_by                        uuid                [null, note: '''Who finalised it. The accountable act — a draft's editor is in audit_logs.''']
  cancelled_by                     uuid                [null]
  cancelled_at                     timestamptz         [null]
  voided_at                        timestamptz         [null]
  created_at                       timestamptz         [not null, default: `now()`]
  updated_at                       timestamptz         [not null, note: 'auto-updated on write']
  deleted_at                       timestamptz         [null, note: 'Soft delete for a DRAFT only. An issued invoice is never deleted by any path — it is VOIDed, which keeps the number and the trail.']

  indexes {
    (organization_id, invoice_number) [unique, note: '''⚠️ THE ONE UNIQUE IN THIS SCHEMA THAT WANTS NULLS **DISTINCT**, WHICH IS POSTGRES' DEFAULT''']
    (organization_id, id) [unique, note: 'Composite-FK target for items, taxes and documents (ADR-0004).']
    (organization_id, branch_id, status, created_at) [note: 'The invoice list: one branch, newest first, filtered by state.']
    (organization_id, patient_id, created_at) [note: '"What does this patient owe?" — and the ledger on the patient page.']
    (organization_id, appointment_id) [note: '"Has this appointment been billed?", asked once per row on the day board.']
    (organization_id, practitioner_profile_id) [note: '''A clinician's own list, and "what did Dr Rao bill this month". ⚠️ THIS LINE IS THE FIX FOR A DRIFT BUG, NOT A NEW INDEX.''']
    (organization_id, credited_invoice_id) [note: '"What has been credited against this invoice?" — asked once per credit note to check the running sum, and once per invoice detail render.']
  }

  Note: 'One patient invoice. ⚠️ `invoice_number` IS NULL UNTIL FINALISATION, AND THAT IS THE POINT. The number comes from `issueNumber()`, whose row lock is held to COMMIT, so it is taken as late as possible — at finalisation, not at creation. A draft the cashier abandons therefore burns no serial.'
}

Table invoice_items {
  id                       uuid                [pk, not null, default: `uuid()`]
  organization_id          uuid                [not null]
  branch_id                uuid                [not null]
  invoice_id               uuid                [not null]
  line_number              smallint            [not null, note: 'Print order, 1-based. Explicit rather than implied by `created_at`, because a cashier reorders lines and a reprint must match the original.']
  description              varchar(255)        [not null]
  item_code                varchar(32)         [null, note: 'The HSN/SAC code printed on the line. Presentation only — `tax_category` is what actually selects the rate, and the two are separate so a clinic can p …']
  credited_invoice_item_id uuid                [null, note: 'The line on the ORIGINAL invoice that this credit-note line reverses (PI-8, closing the per-line half of the credit ceiling).']
  tax_category             varchar(64)         [not null, note: '⚠️ THE KEY INTO `tax_rules`, MATCHED EXACTLY. There is no HSN prefix tree, deliberately: a prefix match that resolved `30049099` to the broader `3004` …']
  quantity                 decimal(14, 3)      [not null, default: 1, note: 'Decimal(14,3): half a tablet is real, and so is 0.5 hours of physiotherapy.']
  unit_price               decimal(14, 2)      [not null]
  gross_amount             decimal(14, 2)      [not null, note: 'round(unit_price × quantity). Stored rather than derived because every later column is computed from the ROUNDED value, and re-deriving it in a query …']
  discount_type            InvoiceDiscountType [null, note: '''The line's own discount, as entered. Same three-column shape and same CHECK as the invoice.''']
  discount_bps             integer             [null]
  discount_fixed           decimal(14, 2)      [null]
  discount_amount          decimal(14, 2)      [not null, default: 0]
  apportioned_discount     decimal(14, 2)      [not null, default: 0, note: '''This line's share of the INVOICE-level discount, pro-rata by taxable amount with the remainder distributed largest-first.''']
  taxable_amount           decimal(14, 2)      [not null, note: 'gross − discount − apportioned. What tax is computed on.']
  tax_amount               decimal(14, 2)      [not null, default: 0, note: '''Σ this line's `invoice_taxes` rows.''']
  line_total               decimal(14, 2)      [not null]
  tax_treatment            TaxTreatment        [not null, default: 'UNRATED', note: 'Why this line was taxed the way it was, per line and not per invoice: a bill can carry an EXEMPT consultation and a STANDARD-rated medicine.']
  tax_reason               varchar(255)        [null, note: '''The engine's own explanation, printed on the invoice where a jurisdiction requires one ("Healthcare services — exempt under Notification 12/2017").''']
  created_at               timestamptz         [not null, default: `now()`]
  updated_at               timestamptz         [not null, note: 'auto-updated on write']

  indexes {
    (organization_id, id) [unique, note: 'Composite-FK target so `invoice_taxes` can cite the line it priced.']
    (organization_id, invoice_id, line_number) [unique, note: 'Two lines cannot claim the same position on one document.']
    (organization_id, invoice_id)
    (organization_id, credited_invoice_item_id) [note: '"How much of this line has already been credited?" — summed per line across every live note, on every credit note raised.']
  }

  Note: 'One billable line. ⚠️ CARRIES ITS OWN `organization_id` AND `branch_id` RATHER THAN HANGING OFF THE INVOICE, and that is a security decision rather than a convenience. Its parent is BRANCH-scoped.'
}

Table invoice_taxes {
  id                  uuid           [pk, not null, default: `uuid()`]
  organization_id     uuid           [not null]
  branch_id           uuid           [not null]
  invoice_id          uuid           [not null, note: '''Denormalised from the item so the invoice's tax summary is one indexed read rather than a join through every line.''']
  invoice_item_id     uuid           [not null]
  tax_rule_id         uuid           [null, note: 'Which rule priced this line, for the auditor who asks why. ⚠️ EXACTLY ONE OF THE TWO IS SET, ENFORCED BY CHECK']
  tax_rule_default_id uuid           [null]
  name                varchar(32)    [not null, note: '`CGST`, `SGST`, `IGST`, `VAT`, `HST`, `PST`, `Consumption Tax`.']
  jurisdiction        varchar(10)    [null, note: 'Which authority it is owed to — `IN` for CGST, `IN-KA` for SGST. One supply carrying two lines to two governments is exactly what a GST split is, and …']
  rate_bps            integer        [not null, note: 'Basis points, snapshotted. 6% is 600.']
  taxable_amount      decimal(14, 2) [not null, note: '''What this rate was applied to. Equal to the item's `taxable_amount` for every rule this engine computes, and NOT redundant: a stacked provincial tax e …''']
  tax_amount          decimal(14, 2) [not null]
  treatment           TaxTreatment   [not null]
  created_at          timestamptz    [not null, default: `now()`]

  indexes {
    (organization_id, invoice_id)
    (organization_id, invoice_item_id)
  }

  Note: 'One PRINTED tax line on one invoice item. ⚠️ A RATE AND A LINE ARE NOT THE SAME THING, WHICH IS WHY THIS TABLE IS PER LINE AND NOT PER RATE. 12% in Karnataka prints as two rows of 6% owed to two different governments; the same 12% in Singapore prints as one;'
}

Table invoice_documents {
  id               uuid         [pk, not null, default: `uuid()`]
  organization_id  uuid         [not null]
  branch_id        uuid         [not null]
  invoice_id       uuid         [not null]
  file_id          uuid         [not null]
  document_type    DocumentType [not null]
  template_key     varchar(64)  [not null, note: 'Which template drew it, and which revision of that template. ⚠️ PROVENANCE, NOT A FEATURE FLAG. Nothing reads these back to choose a renderer']
  template_version smallint     [not null]
  generated_at     timestamptz  [not null, default: `now()`]
  generated_by     uuid         [null]
  superseded_at    timestamptz  [null, note: 'Set when a newer document of the same kind replaces this one — which can only happen for a render that FAILED.']
  created_at       timestamptz  [not null, default: `now()`]

  indexes {
    (organization_id, invoice_id) [note: '⚠️ THE "ONE CURRENT DOCUMENT PER TYPE" UNIQUE IS **NOT DECLARED HERE**, and that is deliberate. It is PARTIAL — `WHERE superseded_at IS NULL`']
    (organization_id, file_id)
  }

  Note: 'The join between an invoice and a file in `files`. A separate table rather than a `file_id` column on `invoices` because one invoice legitimately has several documents over its life — the invoice PDF, a credit note against it, a reprint after a FAILED render'
}

// ===== marketing.prisma ============================================

Table demo_requests {
  id           uuid              [pk, not null, default: `uuid()`]
  clinic_name  varchar(255)      [not null]
  contact_name varchar(255)      [not null]
  email        varchar(255)      [not null]
  phone        varchar(20)       [not null]
  city         varchar(100)      [null]
  branch_count integer           [null]
  specialty    varchar(120)      [null]
  message      text              [null]
  source       varchar(255)      [null, note: 'Referrer or campaign label. Must never carry anything identifying.']
  status       DemoRequestStatus [not null, default: 'NEW']
  handled_at   timestamptz       [null]
  notes        text              [null]
  created_at   timestamptz       [not null, default: `now()`]
  updated_at   timestamptz       [not null, note: 'auto-updated on write']

  indexes {
    (status, created_at)
    email
  }

  Note: 'A demo request from the public landing page at the apex domain. Deliberately NOT tenant-scoped, and this is the one model where that is the correct answer rather than an oversight: the person submitting it has no organization yet, so there is no `organization_id` to put on the row and no tenant cont …'
}

// ===== numbering.prisma ============================================

Table number_sequences {
  id              uuid               [pk, not null, default: `uuid()`]
  organization_id uuid               [not null]
  branch_id       uuid               [null, note: 'Null for an org-wide counter (UHID). Set for everything branch-local.']
  sequence_type   NumberSequenceType [not null]
  period_key      varchar(64)        [not null, default: '']
  prefix          varchar(64)        [not null, default: '', note: '⚠️ 64, NOT 16, BECAUSE AN INVOICE PREFIX CARRIES THE BRANCH CODE. `INV-2026-APP-MAIN-` is already 18 characters and `branches.code` may be 32 on its o …']
  padding         smallint           [not null, default: 6]
  last_number     bigint             [not null, default: 0]
  created_at      timestamptz        [not null, default: `now()`]
  updated_at      timestamptz        [not null, note: 'auto-updated on write']

  indexes {
    (organization_id, branch_id, sequence_type, period_key) [unique, note: '⚠️ Rewritten as NULLS NOT DISTINCT in the migration — `branchId` is null on every org-wide counter, and a plain unique index does not constrain nullab …']
  }

  Note: 'One counter per (organization, branch, type, period). The issuer for every human-facing document number: UHID, branch-local MRN, appointment number and the daily queue token.'
}

// ===== patients.prisma =============================================

Table patients {
  id               uuid            [pk, not null, default: `uuid()`]
  organization_id  uuid            [not null]
  uhid             varchar(32)     [not null, note: 'The org-wide hospital number. Issued, never typed.']
  user_id          uuid            [null, note: 'Set only when the patient signs up for the portal. Most never will, which is why `patients` is not a kind of `users`: the record must exist for an unc …']
  first_name       varchar(100)    [not null]
  last_name        varchar(100)    [null]
  date_of_birth    date            [null, note: '⚠️ NULLABLE, AND `approx_age_years` EXISTS FOR THE REASON. A walk-in who knows they are "about 60" is the common case in an Indian OPD.']
  approx_age_years smallint        [null, note: 'Age in whole years as stated, when no birth date is known. Never derived from `dateOfBirth` — one of the two is authoritative and the other is null.']
  subject_type     CareSubjectType [not null, default: 'HUMAN', note: 'Whether this record is a person or an animal (CE-1, CD-4). ⚠️ THE ONLY CODE THAT BRANCHES ON IT IS CARE-CONTEXT RESOLUTION in the consultation engine. …']
  gender           Gender          [not null, default: 'UNKNOWN']
  blood_group      BloodGroup      [not null, default: 'UNKNOWN']
  phone            varchar(20)     [null]
  email            varchar(255)    [null]
  abha_number      varchar(32)     [null, note: '''India's health account number. 14 digits, or the `user@abdm` address form.''']
  national_id      varchar(64)     [null, note: 'Aadhaar, passport, or whatever the clinic photocopied. Deliberately not validated per-country here — see the contract. ⚠️ STORED NORMALISED']
  national_id_type varchar(32)     [null, note: 'WHICH document `national_id` is: `AADHAAR`, `PAN`, `NHS_NUMBER`, `PASSPORT`. ⚠️ A VARCHAR, NOT A PRISMA ENUM, AND FOR THE SAME REASON `country_code` i …']
  marital_status   MaritalStatus   [not null, default: 'UNKNOWN']
  status           PatientStatus   [not null, default: 'ACTIVE']
  deceased_on      date            [null, note: 'Set with `status = DECEASED`. A date, because the time of death is a clinical record this table is not the place for.']
  merged_into_id   uuid            [null, note: '''The surviving record, when `status = MERGED`. Composite-FK'd to this same table so a merge can never point across tenants.''']
  created_at       timestamptz     [not null, default: `now()`]
  updated_at       timestamptz     [not null, note: 'auto-updated on write']
  deleted_at       timestamptz     [null, note: 'Erasure, not death and not a merge. See `PatientStatus`.']

  indexes {
    (organization_id, uhid) [unique]
    (organization_id, id) [unique, note: 'Composite-FK target. Registrations, appointments, encounters, invoices and everything else clinical references (organization_id, id) so a cross-tenant …']
    (organization_id, phone) [note: 'The duplicate check at the front desk: phone first, it is what people actually remember.']
    (organization_id, status)
    phone [name: "patients_phone_trgm_idx", note: '''The phone trigram index, DECLARED HERE rather than left hand-written. ⚠️ It backs `p.phone LIKE '%term%'` in the search, which the btree above cannot …''']
  }

  Note: 'One human being, once per organization. UHID is the number the clinic says out loud. It is org-wide, issued from the `UHID` counter with the `patient.uhid_prefix` setting as its prefix, and it never changes'
}

Table patient_registrations {
  id              uuid                      [pk, not null, default: `uuid()`]
  organization_id uuid                      [not null]
  patient_id      uuid                      [not null]
  branch_id       uuid                      [not null]
  mrn             varchar(32)               [not null, note: 'The branch-local medical record number. Issued, never typed.']
  registered_at   timestamptz               [not null, default: `now()`]
  registered_by   uuid                      [null, note: 'SetNull: the receptionist may leave; the registration stays.']
  status          PatientRegistrationStatus [not null, default: 'ACTIVE']
  created_at      timestamptz               [not null, default: `now()`]
  updated_at      timestamptz               [not null, note: 'auto-updated on write']

  indexes {
    (organization_id, patient_id, branch_id) [unique]
    (organization_id, branch_id, mrn) [unique]
    (organization_id, id) [unique, note: 'Composite-FK target: an appointment references the registration it was booked against.']
    (organization_id, branch_id, status)
  }

  Note: 'Which clinic a patient attends, and the branch-local record number. One row per (patient, branch). The MRN is per branch and issued from the `MRN` counter with `branch_id` set, so branch A and branch B both start at 1 and neither can collide with the other.'
}

Table patient_addresses {
  id              uuid         [pk, not null, default: `uuid()`]
  organization_id uuid         [not null]
  patient_id      uuid         [not null]
  address_type    AddressType  [not null, default: 'HOME']
  line1           varchar(255) [not null]
  line2           varchar(255) [null]
  city            varchar(100) [null]
  state           varchar(100) [null]
  pincode         varchar(10)  [null]
  country_code    char(2)      [not null, default: 'IN']
  is_primary      boolean      [not null, default: false, note: '⚠️ ADVISORY — no partial unique index enforces one primary per patient. The service demotes the previous primary in the same transaction.']
  created_at      timestamptz  [not null, default: `now()`]
  updated_at      timestamptz  [not null, note: 'auto-updated on write']

  indexes {
    (organization_id, patient_id)
  }

  Note: 'Where a patient lives. Org-scoped, because an address follows the person rather than the clinic they happened to register at.'
}

Table patient_contacts {
  id              uuid         [pk, not null, default: `uuid()`]
  organization_id uuid         [not null]
  patient_id      uuid         [not null]
  relation        varchar(64)  [not null]
  name            varchar(255) [not null]
  phone           varchar(20)  [not null]
  email           varchar(255) [null]
  is_emergency    boolean      [not null, default: false, note: 'Who is rung in an emergency.']
  is_guardian     boolean      [not null, default: false, note: '''Who may consent on the patient's behalf. A different question from `isEmergency` and frequently a different person: the neighbour with a car is not th …''']
  created_at      timestamptz  [not null, default: `now()`]
  updated_at      timestamptz  [not null, note: 'auto-updated on write']

  indexes {
    (organization_id, patient_id)
  }

  Note: 'Next of kin, guardian, the person to ring. `relation` is free text on purpose. A closed enum of family relations is a cultural assumption, and the field is displayed, never queried.'
}

Table patient_allergies {
  id              uuid            [pk, not null, default: `uuid()`]
  organization_id uuid            [not null]
  patient_id      uuid            [not null]
  allergen_type   AllergenType    [not null, default: 'DRUG']
  allergen_text   varchar(255)    [not null, note: '⚠️ PHI, and in `REDACTED_KEYS` — never let this reach an audit snapshot.']
  severity        AllergySeverity [not null, default: 'MODERATE']
  reaction        varchar(255)    [null]
  noted_on        date            [null]
  noted_by        uuid            [null]
  deleted_at      timestamptz     [null, note: 'Soft, because "this was recorded and later withdrawn" is itself clinically interesting']
  created_at      timestamptz     [not null, default: `now()`]
  updated_at      timestamptz     [not null, note: 'auto-updated on write']

  indexes {
    (organization_id, patient_id)
  }

  Note: 'What a patient reacts to. The table a prescription is checked against. ⚠️ NO `medicine_id` COLUMN YET, DELIBERATELY. The §6 ERD has one, and the `medicines` catalogue does not exist until Phase 5.'
}

Table patient_conditions {
  id              uuid                   [pk, not null, default: `uuid()`]
  organization_id uuid                   [not null]
  patient_id      uuid                   [not null]
  condition_text  varchar(255)           [not null, note: '⚠️ PHI, and in `REDACTED_KEYS`.']
  status          PatientConditionStatus [not null, default: 'ACTIVE']
  onset_date      date                   [null]
  resolved_date   date                   [null]
  note            text                   [null]
  noted_by        uuid                   [null]
  deleted_at      timestamptz            [null]
  created_at      timestamptz            [not null, default: `now()`]
  updated_at      timestamptz            [not null, note: 'auto-updated on write']

  indexes {
    (organization_id, patient_id)
  }

  Note: 'The problem list. `diagnosis_id` is absent for the same reason `medicine_id` is absent from allergies — see that model.'
}

Table patient_medications {
  id              uuid         [pk, not null, default: `uuid()`]
  organization_id uuid         [not null]
  patient_id      uuid         [not null]
  medicine_text   varchar(255) [not null, note: '⚠️ PHI, and in `REDACTED_KEYS`.']
  dosage          varchar(255) [null, note: '''"500mg twice daily after food" — one string, because it is transcribed off somebody else's prescription and structuring it would invent precision.''']
  started_on      date         [null]
  stopped_on      date         [null]
  is_ongoing      boolean      [not null, default: true]
  noted_by        uuid         [null]
  deleted_at      timestamptz  [null]
  created_at      timestamptz  [not null, default: `now()`]
  updated_at      timestamptz  [not null, note: 'auto-updated on write']

  indexes {
    (organization_id, patient_id)
  }

  Note: 'What the patient is taking, including what someone else prescribed. `is_ongoing` is stored rather than derived from `stopped_on IS NULL`: "still taking it" and "nobody has asked since" are different answers, and only the first one is safe to hand a prescriber.'
}

// ===== pharmacy.prisma =============================================

Table prescription_fulfilments {
  id              uuid                         [pk, not null, default: `uuid()`]
  organization_id uuid                         [not null]
  branch_id       uuid                         [not null, note: '''⚠️ THE BRANCH THAT IS DISPENSING, WHICH NEED NOT BE THE ONE THAT PRESCRIBED. A group's patient may take a prescription written at the main site to the …''']
  encounter_id    uuid                         [not null]
  status          PrescriptionFulfilmentStatus [not null, default: 'VERIFIED']
  verified_by_id  uuid                         [null]
  verified_at     timestamptz                  [null]
  notes           text                         [null, note: '''⚠️ PHI. A pharmacist's note about this person's prescription — "rang the prescriber about the dose". Free text, and treated as clinical.''']
  cancelled_by_id uuid                         [null]
  cancelled_at    timestamptz                  [null]
  created_at      timestamptz                  [not null, default: `now()`]
  updated_at      timestamptz                  [not null, note: 'auto-updated on write']

  indexes {
    (organization_id, encounter_id) [unique, note: 'One dispensary state per consultation. ⚠️ Org-qualified, never bare — a `@@unique([encounterId])` on a tenant table is the mistake CLAUDE.md names.']
    (organization_id, id) [unique]
    (organization_id, branch_id, status, created_at) [note: 'The queue: what is outstanding at this counter, oldest first.']
  }

  Note: '''Pharmacy's workflow state over one consultation's prescription. ⚠️ ONE ROW PER ENCOUNTER, NOT PER PRESCRIBED LINE. "The prescription" that a patient carries to the counter is the whole medication list a consultation produced; a pharmacist verifies the sheet, not each drug in isolation.'''
}

Table dispenses {
  id              uuid           [pk, not null, default: `uuid()`]
  organization_id uuid           [not null]
  branch_id       uuid           [not null]
  dispense_number varchar(64)    [not null, note: 'Issued from `number_sequences` (`DISPENSE`, per branch, never resets) INSIDE the posting transaction, so a refusal burns no number.']
  kind            DispenseKind   [not null]
  status          DispenseStatus [not null, default: 'DISPENSED']
  encounter_id    uuid           [null, note: 'The consultation whose prescription this supplies. NULL for a counter sale.']
  patient_id      uuid           [null, note: '⚠️ PHI, AND NULLABLE FOR A REASON THAT IS NOT LAZINESS. A counter sale is frequently to somebody who is not a patient of this clinic and never becomes …']
  location_id     uuid           [not null, note: 'Which dispensing point it went out of. Branch-qualified.']
  dispensed_by_id uuid           [not null]
  dispensed_at    timestamptz    [not null, default: `now()`, note: '⚠️ WHEN IT WAS HANDED OVER. Distinct from `created_at`, and it is what every ledger leg carries as its `occurred_at`.']
  notes           text           [null, note: '⚠️ PHI. Anything the counter recorded about this supply.']
  created_at      timestamptz    [not null, default: `now()`]
  updated_at      timestamptz    [not null, note: 'auto-updated on write']

  indexes {
    (organization_id, dispense_number) [unique]
    (organization_id, id) [unique]
    (organization_id, branch_id, id) [unique]
    (organization_id, branch_id, dispensed_at) [note: 'DESC on dispensed_at']
    (organization_id, encounter_id)
    (organization_id, patient_id, dispensed_at) [note: '"What has this person been given" — a PHI read, and the index that makes it answerable in one scan. | DESC on dispensed_at']
  }

  Note: 'One supply of one or more products to one person, at one counter, at one moment. The record of an irreversible physical act. ⚠️ APPEND-ONLY IN SPIRIT AND MUTABLE IN EXACTLY ONE COLUMN. `status` moves as returns come back, and nothing else on a posted dispense may be rewritten'
}

Table dispense_lines {
  id                         uuid           [pk, not null, default: `uuid()`]
  organization_id            uuid           [not null]
  branch_id                  uuid           [not null]
  dispense_id                uuid           [not null]
  line_number                smallint       [not null]
  encounter_prescription_id  uuid           [null, note: 'The prescribed line this answers. NULL on a counter sale, and NULL where a pharmacist supplies something the prescription did not list']
  product_id                 uuid           [not null, note: 'What was actually handed over.']
  substituted_for_product_id uuid           [null, note: 'What the prescriber wrote, where that is a DIFFERENT product. ⚠️ TWO INDEPENDENT QUESTIONS, AND CONFLATING THEM IS THE CLASSIC ERROR OF THIS DOMAIN.']
  substitution_reason        text           [null, note: 'Why. ⚠️ CHECKed present whenever a substitution was made.']
  quantity_entered           decimal(18, 6) [not null, note: 'What the person typed, and the unit they thought in.']
  unit_id                    uuid           [not null]
  quantity_base              decimal(18, 6) [not null, note: '''The same amount in the product's base unit, converted through the one `toBaseUnits` the ledger uses. ⚠️ Positive here;''']
  returned_quantity_base     decimal(18, 6) [not null, default: 0, note: 'How much of this line has come back. Maintained by the return service and CHECKed at or below `quantity_base`.']
  regulatory_decision_id     uuid           [not null, note: '⚠️ THE SNAPSHOT THAT PERMITTED THIS, AND IT IS NOT NULLABLE (PI-ADR-008). Every supplied line cites the decision made at the moment it was supplied.']
  label_instructions         text           [null, note: '⚠️ PHI. What goes on the label the patient reads — "one tablet twice a day after food".']
  created_at                 timestamptz    [not null, default: `now()`]
  updated_at                 timestamptz    [not null, note: 'auto-updated on write']

  indexes {
    (organization_id, dispense_id, line_number) [unique]
    (organization_id, id) [unique]
    (organization_id, branch_id, id) [unique]
    (organization_id, dispense_id)
    (organization_id, product_id)
    (organization_id, encounter_prescription_id) [note: '"How much of this prescribed line has been supplied" — the fulfilment arithmetic, and the reason PI-7 needed no column on the clinical record.']
  }

  Note: 'One product supplied on one dispense.'
}

Table dispense_allocations {
  id               uuid           [pk, not null, default: `uuid()`]
  organization_id  uuid           [not null]
  branch_id        uuid           [not null]
  dispense_line_id uuid           [not null]
  location_id      uuid           [not null]
  batch_id         uuid           [null]
  serial_id        uuid           [null]
  quantity_base    decimal(18, 6) [not null]
  is_override      boolean        [not null, default: false, note: 'Did a human overrule the FEFO plan for this lot? ⚠️ RECORDED, NOT PREVENTED, AND THE REASON IS REQUIRED WHEN IT IS TRUE.']
  override_reason  text           [null]
  created_at       timestamptz    [not null, default: `now()`]

  indexes {
    (organization_id, id) [unique]
    (organization_id, branch_id, id) [unique]
    (organization_id, dispense_line_id)
    (organization_id, batch_id) [note: '''Traceability: "which patients got this lot" is asked from the batch side, and PI-10's recall walks exactly this index.''']
    (organization_id, serial_id)
  }

  Note: 'Which physical lot the quantity on a line came out of. ⚠️ ITS OWN TABLE RATHER THAN COLUMNS ON THE LINE, BECAUSE ONE LINE ROUTINELY SPANS TWO LOTS. Thirty tablets where the oldest lot has eighteen left is an ordinary FEFO outcome, and a `batch_id` on the line would force the pharmacist to key two li …'
}

Table dispense_returns {
  id                     uuid                      [pk, not null, default: `uuid()`]
  organization_id        uuid                      [not null]
  branch_id              uuid                      [not null]
  dispense_id            uuid                      [not null]
  disposition            DispenseReturnDisposition [not null, default: 'QUARANTINED', note: 'Where it goes back to. See `DispenseReturnDisposition` — quarantine is the default and the engine is asked before anything is restocked.']
  location_id            uuid                      [not null, note: 'Which shelf received it. Branch-qualified.']
  reason                 text                      [not null, note: '⚠️ PHI-adjacent: why a named person brought a medicine back.']
  returned_at            timestamptz               [not null, default: `now()`]
  received_by_id         uuid                      [not null]
  regulatory_decision_id uuid                      [null, note: 'The decision that decided the disposition. Nullable, because a return of a product with no regulatory profile in an unconfigured jurisdiction is the o …']
  created_at             timestamptz               [not null, default: `now()`]
  updated_at             timestamptz               [not null, note: 'auto-updated on write']

  indexes {
    (organization_id, id) [unique]
    (organization_id, branch_id, id) [unique]
    (organization_id, dispense_id)
    (organization_id, branch_id, returned_at) [note: 'DESC on returned_at']
  }

  Note: 'Something came back. ⚠️ A RETURN NEVER EDITS THE DISPENSE IT CITES. It is a `RETURN` ledger movement plus this record, the same discipline the invoice engine applies with a credit note — and financially it becomes one, in PI-8, through the existing engine rather than by touching an invoice here.'
}

Table dispense_return_lines {
  id                     uuid           [pk, not null, default: `uuid()`]
  organization_id        uuid           [not null]
  branch_id              uuid           [not null]
  dispense_return_id     uuid           [not null]
  dispense_line_id       uuid           [not null]
  dispense_allocation_id uuid           [null, note: 'The allocation it came out of, so the lot it goes back INTO is the lot it came OUT of rather than whichever one is oldest.']
  quantity_base          decimal(18, 6) [not null]
  created_at             timestamptz    [not null, default: `now()`]

  indexes {
    (organization_id, id) [unique]
    (organization_id, dispense_return_id)
    (organization_id, dispense_line_id)
  }

  Note: '''One lot's worth of one line, coming back.'''
}

// ===== procurement.prisma ==========================================

Table suppliers {
  id                 uuid           [pk, not null, default: `uuid()`]
  organization_id    uuid           [not null]
  code               varchar(64)    [not null, note: '''The clinic's own code for them. Uppercase, matched exactly, and tenant-qualified — never a bare `@@unique([code])`.''']
  name               varchar(255)   [not null, note: 'The name over the door, and what every screen shows.']
  legal_name         varchar(255)   [null, note: 'The name on the contract, when it differs. A purchase order and a tax return want this one; a picker wants `name`.']
  status             SupplierStatus [not null, default: 'ACTIVE']
  contact_person     varchar(255)   [null]
  email              varchar(320)   [null]
  phone              varchar(32)    [null]
  website            varchar(255)   [null]
  address_line1      varchar(255)   [null]
  address_line2      varchar(255)   [null]
  city               varchar(128)   [null]
  region_code        varchar(10)    [null, note: 'ISO 3166-2 subdivision without the country prefix, the same vocabulary `issuer_tax_registrations` uses.']
  postal_code        varchar(20)    [null]
  country_code       char(2)        [null, note: 'ISO 3166-1 alpha-2. Where they invoice from.']
  default_currency   char(3)        [null, note: 'ISO 4217. What they quote in, and what a new purchase order defaults to. ⚠️ A DEFAULT, NOT A CONSTRAINT.']
  payment_terms_days smallint       [null, note: 'Days from invoice to payment, as agreed. Recorded for the buyer; no payment workflow reads it, because paying suppliers is not in this programme.']
  lead_time_days     smallint       [null, note: 'Typical days from order to delivery, across everything they sell. A per-product figure on `supplier_products` overrides it.']
  notes              text           [null]
  created_at         timestamptz    [not null, default: `now()`]
  updated_at         timestamptz    [not null, note: 'auto-updated on write']
  deleted_at         timestamptz    [null]

  indexes {
    (organization_id, code) [unique]
    (organization_id, id) [unique, note: 'The composite-FK target every child references.']
    (organization_id, status, name)
  }

  Note: 'A vendor. ORG-SCOPED: one contract, one price book, every branch. See the file header for why there is no `branch_id` here and what that costs. ⚠️ NOTHING CONFIDENTIAL TO ONE BRANCH MAY BE ADDED TO THIS TABLE.'
}

Table supplier_tax_identifiers {
  id                  uuid         [pk, not null, default: `uuid()`]
  organization_id     uuid         [not null]
  supplier_id         uuid         [not null]
  country_code        char(2)      [not null, note: 'ISO 3166-1 alpha-2.']
  region_code         varchar(10)  [null, note: 'ISO 3166-2 subdivision without the country prefix. NULL = country-wide.']
  scheme              TaxScheme    [not null]
  registration_number varchar(64)  [not null, note: 'Their number, exactly as printed. Case preserved, compared exactly — it is an identifier, and `29ABCDE1234F1Z5` is not `29abcde1234f1z5` to a registry …']
  legal_name          varchar(255) [null, note: 'The name the registration is held in, which is not always the trading name.']
  effective_from      date         [not null, note: 'When it took effect, and when it lapsed. Kept rather than deleted so a three-year-old purchase order stays explicable.']
  effective_to        date         [null]
  created_at          timestamptz  [not null, default: `now()`]
  updated_at          timestamptz  [not null, note: 'auto-updated on write']

  indexes {
    (organization_id, supplier_id, country_code, scheme, registration_number) [unique, note: 'You cannot record the same registration twice. Everything else — how many a supplier holds, in which states']
    (organization_id, id) [unique]
    (organization_id, supplier_id)
  }

  Note: '''The supplier's GSTIN / VAT number / TIN, per jurisdiction. ⚠️ THIS DOES **NOT** FEED `@rcln/tax`, AND THE DISTINCTION IS THE WHOLE REASON IT IS A SEPARATE TABLE FROM `issuer_tax_registrations`. That table answers "may THIS CLINIC charge its patient?" and prices SALES.'''
}

Table supplier_products {
  id                    uuid           [pk, not null, default: `uuid()`]
  organization_id       uuid           [not null]
  supplier_id           uuid           [not null]
  product_id            uuid           [not null]
  supplier_sku          varchar(128)   [not null, note: 'Their catalogue number. What goes on the purchase order and what their invoice will quote back.']
  supplier_product_name varchar(255)   [null, note: 'What THEY call it, when that differs from what the clinic calls it. Kept for matching an invoice line by eye, which is how it is actually done.']
  pack_unit_id          uuid           [not null, note: 'The word for one of their packs — BOX, CASE, VIAL. See the model comment: presentation only, never arithmetic.']
  quantity_per_pack     decimal(18, 6) [not null, note: 'Base units in one pack. THE conversion. Positive, CHECKed.']
  price_per_pack_minor  bigint         [not null, note: 'What one pack costs, in integer minor units. Per PACK, because that is what the supplier quotes;']
  currency              char(3)        [not null, note: 'ISO 4217. Required beside any price — a number with no currency is a number that will be added to a different one.']
  price_effective_from  date           [not null, note: '''When this price applies from, and until. A supplier's new price list does not rewrite what last quarter's orders cost.''']
  price_effective_to    date           [null]
  lead_time_days        smallint       [null, note: '''Days from order to delivery for THIS item. Overrides the supplier's blanket figure.''']
  minimum_order_packs   decimal(18, 6) [null, note: '''The smallest order they will accept, in PACKS. Warned about, not enforced — a supplier's minimum is their commercial policy and a clinic ordering less …''']
  is_preferred          boolean        [not null, default: false, note: 'The one to offer first when several suppliers sell the same product. At most one per (product) is enforced in the service, not in a partial index, bec …']
  is_active             boolean        [not null, default: true]
  notes                 text           [null]
  created_at            timestamptz    [not null, default: `now()`]
  updated_at            timestamptz    [not null, note: 'auto-updated on write']
  deleted_at            timestamptz    [null]

  indexes {
    (organization_id, supplier_id, product_id, supplier_sku) [unique, note: 'One row per (supplier, product, their SKU). A supplier legitimately sells the same product under two SKUs — a 10-pack and a 100-pack']
    (organization_id, id) [unique]
    (organization_id, product_id, is_active) [note: '''"Who sells this, and for how much" — the buyer's question, from the product.''']
    (organization_id, supplier_id, is_active)
  }

  Note: 'What one supplier sells one product AS. The translation layer (PI-4.2). ⚠️ WITHOUT THIS TABLE EVERY PURCHASE ORDER LINE RE-ENTERS A UNIT CONVERSION BY HAND, AND EVERY ONE OF THEM IS A CHANCE TO ORDER TEN TIMES TOO MANY. A supplier sells `AMOX-500-BOX10x10` in cases of 5 boxes at ₹412 per box;'
}

Table purchase_requisitions {
  id                 uuid                      [pk, not null, default: `uuid()`]
  organization_id    uuid                      [not null]
  branch_id          uuid                      [not null]
  requisition_number varchar(64)               [null, note: 'Issued from `number_sequences` on SUBMIT, never on create — a draft that is abandoned must not burn a number in a series somebody reads as a sequence. …']
  status             PurchaseRequisitionStatus [not null, default: 'DRAFT']
  required_by        date                      [null, note: '''When the branch needs it by. A DATE, not an instant: "we need it by the 14th" is a fact about a day in the clinic's calendar.''']
  notes              text                      [null]
  created_by_id      uuid                      [not null]
  submitted_at       timestamptz               [null]
  submitted_by_id    uuid                      [null]
  approved_at        timestamptz               [null]
  approved_by_id     uuid                      [null]
  rejected_at        timestamptz               [null]
  rejected_by_id     uuid                      [null]
  rejection_reason   text                      [null, note: 'CHECKed present whenever `rejected_at` is. A refusal with no reason is a refusal the requester cannot act on, and they will simply raise it again.']
  cancelled_at       timestamptz               [null]
  cancelled_by_id    uuid                      [null]
  created_at         timestamptz               [not null, default: `now()`]
  updated_at         timestamptz               [not null, note: 'auto-updated on write']

  indexes {
    (organization_id, requisition_number) [unique]
    (organization_id, id) [unique, note: 'The composite-FK targets the lines and the purchase orders reference.']
    (organization_id, branch_id, id) [unique]
    (organization_id, status, created_at) [note: '"What is waiting for me to approve" — the whole reason the state exists. | DESC on created_at']
    (organization_id, branch_id, status)
  }

  Note: 'A branch asking the organization to buy something (PI-4.3). ⚠️ THE APPROVAL SPLIT IS THE ENTIRE POINT OF THIS TABLE, AND IT IS ENFORCED IN THREE PLACES BECAUSE IT IS A SEGREGATION-OF-DUTY CONTROL RATHER THAN A VALIDATION.'
}

Table purchase_requisition_lines {
  id                    uuid           [pk, not null, default: `uuid()`]
  organization_id       uuid           [not null]
  branch_id             uuid           [not null]
  requisition_id        uuid           [not null]
  line_number           smallint       [not null, note: '''Where this line sits on the document, 1-based. ⚠️ WITHOUT IT A DOCUMENT'S LINES RENDER IN AN ARBITRARY ORDER, AND `created_at` CANNOT SUBSTITUTE.''']
  product_id            uuid           [not null]
  quantity_base         decimal(18, 6) [not null, note: '''What is being asked for, in the product's BASE UNIT, positive and CHECKed. Resolved by the same `toBaseUnits` the ledger uses, so the requisition, the …''']
  quantity_entered      decimal(18, 6) [not null, note: 'What the requester actually typed, and in what. Kept for the same reason the ledger keeps it: "2 boxes" must still read as "2 boxes" a year later.']
  unit_id               uuid           [not null]
  suggested_supplier_id uuid           [null, note: 'Who the requester thinks we should buy it from. ADVICE — the buyer decides, and the PO records what actually happened.']
  notes                 text           [null]
  created_at            timestamptz    [not null, default: `now()`]
  updated_at            timestamptz    [not null, note: 'auto-updated on write']

  indexes {
    (organization_id, requisition_id, product_id) [unique, note: 'One line per product. Asking for the same thing twice on one document has two plausible readings — the sum, or a duplicate']
    (organization_id, requisition_id, line_number) [unique]
    (organization_id, id) [unique]
    (organization_id, requisition_id)
    (organization_id, product_id)
  }

  Note: 'One product on a requisition. Carries `organization_id` AND `branch_id` itself rather than inheriting through a parent predicate — the call the invoice children made, not the one `appointment_status_history` made.'
}

Table purchase_orders {
  id                     uuid                [pk, not null, default: `uuid()`]
  organization_id        uuid                [not null]
  branch_id              uuid                [not null]
  order_number           varchar(64)         [null, note: 'Issued from `number_sequences` at ISSUE, never at create. A supplier quotes this number back on their invoice, so a gap in the series is a gap somebod …']
  supplier_id            uuid                [not null]
  requisition_id         uuid                [null, note: 'The requisition this came from, when it came from one. Buying without a requisition is ordinary — a standing monthly order does not need one']
  status                 PurchaseOrderStatus [not null, default: 'DRAFT']
  supplier_name          varchar(255)        [not null]
  supplier_tax_number    varchar(64)         [null]
  currency               char(3)             [not null, note: 'ISO 4217. THE currency of this commitment — every `*_minor` column below is in it, and a receipt against this order in a different currency is recorde …']
  expected_date          date                [null, note: 'When the supplier said it would arrive. A DATE.']
  deliver_to_location_id uuid                [null, note: 'Where it should be delivered. Branch-qualified, so an order at branch A naming a shelf at branch B is unrepresentable rather than merely refused']
  subtotal_minor         bigint              [not null, default: 0, note: 'The sum of the lines. Stored rather than re-derived, exactly as invoice totals are: a document states a total, and a total that is recomputed on every …']
  tax_amount_minor       bigint              [not null, default: 0, note: 'What the supplier charged in tax. ⚠️ RECORDED, NEVER CALCULATED. Nothing in this programme computes input tax and nothing calls `@rcln/tax`, which pri …']
  total_minor            bigint              [not null, default: 0]
  terms                  text                [null, note: '''The buyer's terms, free text, printed on the order.''']
  notes                  text                [null]
  created_by_id          uuid                [not null]
  issued_at              timestamptz         [null]
  issued_by_id           uuid                [null]
  closed_at              timestamptz         [null, note: 'When the buyer decided nothing more is coming. See `PurchaseOrderStatus`.']
  closed_by_id           uuid                [null]
  closure_reason         text                [null]
  cancelled_at           timestamptz         [null]
  cancelled_by_id        uuid                [null]
  cancellation_reason    text                [null]
  created_at             timestamptz         [not null, default: `now()`]
  updated_at             timestamptz         [not null, note: 'auto-updated on write']

  indexes {
    (organization_id, order_number) [unique]
    (organization_id, id) [unique]
    (organization_id, branch_id, id) [unique]
    (organization_id, branch_id, status, created_at) [note: '''"What are we waiting for" — the buyer's screen. | DESC on created_at''']
    (organization_id, supplier_id, status) [note: '''"What have we ordered from them" — the supplier's screen.''']
  }

  Note: '''The organization committing to buy (PI-4.4). ⚠️ THE SUPPLIER'S NAME AND TAX NUMBER ARE SNAPSHOTTED, AND THE REASON IS **NOT** THE ONE PI-3 LEARNED THE HARD WAY. `suppliers` is org-scoped, so a branch CAN read it'''
}

Table purchase_order_lines {
  id                     uuid           [pk, not null, default: `uuid()`]
  organization_id        uuid           [not null]
  branch_id              uuid           [not null]
  purchase_order_id      uuid           [not null]
  line_number            smallint       [not null, note: '''Where this line sits on the document, 1-based. ⚠️ WITHOUT IT A DOCUMENT'S LINES RENDER IN AN ARBITRARY ORDER, AND `created_at` CANNOT SUBSTITUTE.''']
  product_id             uuid           [not null]
  supplier_product_id    uuid           [null, note: '''The supplier's catalogue row this was priced from, when it was. Nullable: a buyer ordering something the price book has never carried is ordinary, and …''']
  ordered_quantity_base  decimal(18, 6) [not null, note: '''What was ordered, in the product's BASE UNIT. Positive, CHECKed.''']
  quantity_entered       decimal(18, 6) [not null, note: '''What the buyer typed, and in what — "5 BOX". See the ledger's identical pair.''']
  unit_id                uuid           [not null]
  received_quantity_base decimal(18, 6) [not null, default: 0, note: 'What has been signed for against this line, in base units, accumulated across every receipt. Starts at zero and only ever grows.']
  unit_cost_base         bigint         [not null, note: 'Cost per BASE UNIT, in integer minor units (PI-ADR-010). THE canonical cost figure, and what `batches.unit_cost_base` is set from at receipt.']
  price_per_pack_minor   bigint         [null, note: 'What the supplier quoted, as quoted: a price per pack and how many base units that pack holds. The money equivalent of `quantity_entered`']
  pack_quantity_base     decimal(18, 6) [null]
  line_subtotal_minor    bigint         [not null, default: 0, note: '''As recorded on the supplier's paperwork. Nothing computes these.''']
  tax_rate_bps           integer        [null, note: 'Basis points, for the record only — 18% is 1800. ⚠️ It is not applied to anything; `tax_amount_minor` is what the supplier charged.']
  tax_amount_minor       bigint         [not null, default: 0]
  line_total_minor       bigint         [not null, default: 0]
  notes                  text           [null]
  created_at             timestamptz    [not null, default: `now()`]
  updated_at             timestamptz    [not null, note: 'auto-updated on write']

  indexes {
    (organization_id, purchase_order_id, product_id) [unique, note: 'One line per product, for the reason the requisition gives.']
    (organization_id, purchase_order_id, line_number) [unique]
    (organization_id, id) [unique]
    (organization_id, purchase_order_id)
    (organization_id, product_id)
  }

  Note: 'One product on a purchase order. ⚠️ `received_quantity_base` HAS NO `<= ordered` CHECK, AND THAT IS THE ONE PLACE THIS FILE DIVERGES FROM `stock_transfer_lines` ON PURPOSE. A transfer can refuse over-receipt absolutely, because more arriving than was sent is a data-entry error by definition'
}

Table goods_receipts {
  id                      uuid               [pk, not null, default: `uuid()`]
  organization_id         uuid               [not null]
  branch_id               uuid               [not null]
  receipt_number          varchar(64)        [null, note: 'Issued from `number_sequences` at POST, never at create.']
  supplier_id             uuid               [not null]
  purchase_order_id       uuid               [null, note: 'The order this delivers against, when there is one. A donation, an opening stock load and a sample all arrive without a PO.']
  status                  GoodsReceiptStatus [not null, default: 'DRAFT']
  supplier_name           varchar(255)       [not null, note: '''Snapshotted for the reason the purchase order's is. See that model.''']
  supplier_invoice_number varchar(64)        [null, note: 'Their invoice, as the number and date printed on the paper that came with the boxes. This is what an accountant reconciles against.']
  supplier_invoice_date   date               [null]
  location_id             uuid               [not null, note: 'Where it lands. Branch-qualified, so a receipt at branch A cannot name a shelf at branch B. Required — a delivery with no shelf has nowhere to go.']
  received_at             timestamptz        [not null, default: `now()`, note: 'When the goods PHYSICALLY ARRIVED, which is not when this was keyed in: a receipt entered on Monday for a Friday delivery is ordinary, and the ledger …']
  currency                char(3)            [not null, note: 'ISO 4217. What this delivery was invoiced in.']
  freight_minor           bigint             [not null, default: 0, note: 'Freight, duty and handling, in integer minor units. Apportioned across the lines PRO-RATA BY VALUE and the apportionment is STORED on each line, never …']
  duty_minor              bigint             [not null, default: 0]
  handling_minor          bigint             [not null, default: 0]
  goods_value_minor       bigint             [not null, default: 0, note: '''The sum of the lines' goods value, then tax as the supplier charged it, then the whole document. All recorded (PI-ADR-006).''']
  tax_amount_minor        bigint             [not null, default: 0]
  total_minor             bigint             [not null, default: 0]
  quality_hold_required   boolean            [not null, default: false, note: 'What the inspection policy WAS when this was posted. See the model comment — a snapshot, not a live read.']
  notes                   text               [null]
  created_by_id           uuid               [not null]
  posted_at               timestamptz        [null]
  posted_by_id            uuid               [null]
  cancelled_at            timestamptz        [null]
  cancelled_by_id         uuid               [null]
  cancellation_reason     text               [null]
  created_at              timestamptz        [not null, default: `now()`]
  updated_at              timestamptz        [not null, note: 'auto-updated on write']

  indexes {
    (organization_id, receipt_number) [unique]
    (organization_id, id) [unique]
    (organization_id, branch_id, id) [unique]
    (organization_id, branch_id, status, received_at) [note: 'DESC on received_at']
    (organization_id, supplier_id, received_at) [note: 'DESC on received_at']
    (organization_id, purchase_order_id)
  }

  Note: 'What actually turned up (PI-4.5). THE most consequential document here. ── THIS IS WHERE THE TRUTH ENTERS, AND WHERE IT IS HARDEST TO CORRECT ────── Everything downstream is downstream of this row.'
}

Table goods_receipt_lines {
  id                     uuid                      [pk, not null, default: `uuid()`]
  organization_id        uuid                      [not null]
  branch_id              uuid                      [not null]
  goods_receipt_id       uuid                      [not null]
  line_number            smallint                  [not null, note: '''Where this line sits on the document, 1-based. ⚠️ WITHOUT IT A DOCUMENT'S LINES RENDER IN AN ARBITRARY ORDER, AND `created_at` CANNOT SUBSTITUTE.''']
  purchase_order_line_id uuid                      [null, note: '''The order line this satisfies, when the receipt has an order. Nullable for the same reason the header's `purchase_order_id` is.''']
  product_id             uuid                      [not null]
  batch_id               uuid                      [null, note: 'The lot row, created at POST. See the model comment.']
  serial_id              uuid                      [null, note: 'The serial row, created at POST.']
  received_quantity_base decimal(18, 6)            [not null, note: '''What was counted in, in the product's BASE UNIT. Positive, CHECKed.''']
  quantity_entered       decimal(18, 6)            [not null, note: 'What the receiver typed, and in what.']
  unit_id                uuid                      [not null]
  rejected_quantity_base decimal(18, 6)            [not null, default: 0, note: 'How much of the received quantity was refused at inspection. ⚠️ NOT SUBTRACTED FROM `received_quantity_base`: it arrived, it is on the premises, and i …']
  lot_number             varchar(128)              [null, note: '''Required when the product is batch-tracked, which the ledger's tracking CHECK enforces on the leg. Case preserved, compared exactly.''']
  manufactured_on        date                      [null]
  expires_on             date                      [null, note: 'Required when the product is expiry-controlled — refused in the service with a sentence, because a pack with no expiry recorded is a pack the sweep ca …']
  retest_on              date                      [null]
  manufacturer_id        uuid                      [null, note: '''May legitimately differ from the product's default: contract manufacture and repackaging are why `batches` has this column and not a join.''']
  serial_number          varchar(128)              [null, note: 'As printed, for a serial-tracked line. Turned into a `serials` row at post.']
  unit_cost_base         bigint                    [not null, note: 'Cost per BASE UNIT in integer minor units. What `batches.unit_cost_base` is set from, and what the moving average is rolled into.']
  currency               char(3)                   [not null]
  landed_cost_minor      bigint                    [not null, default: 0, note: '''This line's share of the header's freight, duty and handling, apportioned pro-rata by value. ⚠️ STORED, NOT RE-DERIVED.''']
  line_subtotal_minor    bigint                    [not null, default: 0]
  tax_rate_bps           integer                   [null]
  tax_amount_minor       bigint                    [not null, default: 0]
  line_total_minor       bigint                    [not null, default: 0]
  quality_status         GoodsReceiptQualityStatus [not null, default: 'NOT_REQUIRED']
  quality_decided_at     timestamptz               [null]
  quality_decided_by_id  uuid                      [null]
  quality_notes          text                      [null, note: 'CHECKed present whenever the status is `REJECTED`. "We refused it" without "because" is not a record anybody can act on.']
  notes                  text                      [null]
  created_at             timestamptz               [not null, default: `now()`]
  updated_at             timestamptz               [not null, note: 'auto-updated on write']

  indexes {
    (organization_id, goods_receipt_id, product_id, lot_number, serial_number) [unique, note: 'One line per (product, lot, serial). ⚠️ Rewritten NULLS NOT DISTINCT in the migration']
    (organization_id, goods_receipt_id, line_number) [unique]
    (organization_id, id) [unique]
    (organization_id, goods_receipt_id)
    (organization_id, product_id)
    (organization_id, purchase_order_line_id)
    (organization_id, branch_id, quality_status) [note: '"What is waiting for inspection" — the quality screen.']
  }

  Note: 'One product, one lot, one serial, on one delivery. ⚠️ A SERIAL-TRACKED PRODUCT GETS **ONE LINE PER SERIAL**, QUANTITY ONE, AND THAT IS WHY THERE IS NO `goods_receipt_line_serials` TABLE. A serial IS one physical device; `recordMovementIn` takes exactly one `serialId`;'
}

Table purchase_returns {
  id                          uuid                 [pk, not null, default: `uuid()`]
  organization_id             uuid                 [not null]
  branch_id                   uuid                 [not null]
  return_number               varchar(64)          [null, note: 'Issued from `number_sequences` when it is SENT, never at create.']
  supplier_id                 uuid                 [not null]
  goods_receipt_id            uuid                 [null, note: 'The delivery this is going back against. Nullable — a clinic returning stock it can no longer tie to a specific delivery is ordinary after a few years …']
  status                      PurchaseReturnStatus [not null, default: 'DRAFT']
  supplier_name               varchar(255)         [not null]
  reason                      text                 [not null, note: 'Why it is going back. NOT NULL: a return with no reason is a return the supplier will refuse and nobody can explain a year later.']
  location_id                 uuid                 [not null, note: 'Where it leaves from. Branch-qualified.']
  currency                    char(3)              [not null]
  total_minor                 bigint               [not null, default: 0]
  supplier_credit_note_number varchar(64)          [null, note: 'Their credit note, once they issue one. Recorded, not reconciled.']
  notes                       text                 [null]
  created_by_id               uuid                 [not null]
  sent_at                     timestamptz          [null]
  sent_by_id                  uuid                 [null]
  cancelled_at                timestamptz          [null]
  cancelled_by_id             uuid                 [null]
  cancellation_reason         text                 [null]
  created_at                  timestamptz          [not null, default: `now()`]
  updated_at                  timestamptz          [not null, note: 'auto-updated on write']

  indexes {
    (organization_id, return_number) [unique]
    (organization_id, id) [unique]
    (organization_id, branch_id, id) [unique]
    (organization_id, branch_id, status, created_at) [note: 'DESC on created_at']
    (organization_id, supplier_id)
  }

  Note: 'Stock going back to the supplier (PI-4.7). ⚠️ A RETURN IS A `PURCHASE_RETURN`-SIGNED MOVEMENT CITING THE RECEIPT, NEVER A DELETION OF IT. The goods arrived; the ledger recorded that they arrived; and a correction is a compensating movement with a reason (PI-ADR-004 rule 3).'
}

Table purchase_return_lines {
  id                    uuid           [pk, not null, default: `uuid()`]
  organization_id       uuid           [not null]
  branch_id             uuid           [not null]
  purchase_return_id    uuid           [not null]
  line_number           smallint       [not null, note: '''Where this line sits on the document, 1-based. ⚠️ WITHOUT IT A DOCUMENT'S LINES RENDER IN AN ARBITRARY ORDER, AND `created_at` CANNOT SUBSTITUTE.''']
  goods_receipt_line_id uuid           [null, note: 'The receipt line this is going back against, when it is known. This is the traceability join: "which delivery did the stock we returned come from".']
  product_id            uuid           [not null]
  batch_id              uuid           [null]
  serial_id             uuid           [null]
  quantity_base         decimal(18, 6) [not null, note: '''In the product's BASE UNIT, positive, CHECKed.''']
  quantity_entered      decimal(18, 6) [not null]
  unit_id               uuid           [not null]
  status_from           StockStatus    [not null, note: '''Which bucket the stock leaves. ⚠️ REQUIRED, NO DEFAULT — see the header's model comment.''']
  unit_cost_base        bigint         [null, note: 'What it was valued at, for the credit the clinic expects.']
  currency              char(3)        [null]
  line_total_minor      bigint         [not null, default: 0]
  notes                 text           [null]
  created_at            timestamptz    [not null, default: `now()`]
  updated_at            timestamptz    [not null, note: 'auto-updated on write']

  indexes {
    (organization_id, purchase_return_id, product_id, batch_id, serial_id) [unique, note: 'One line per (product, lot, serial). NULLS NOT DISTINCT in the migration.']
    (organization_id, purchase_return_id, line_number) [unique]
    (organization_id, id) [unique]
    (organization_id, purchase_return_id)
    (organization_id, product_id)
    (organization_id, goods_receipt_line_id)
  }

  Note: 'One lot going back.'
}

Table product_cost_averages {
  id                   uuid           [pk, not null, default: `uuid()`]
  organization_id      uuid           [not null]
  branch_id            uuid           [not null]
  product_id           uuid           [not null]
  currency             char(3)        [not null, note: 'ISO 4217. Part of the key — see the model comment.']
  valued_quantity_base decimal(18, 6) [not null, note: 'The denominator. ⚠️ NOT A STOCK QUANTITY. Non-negative, CHECKed.']
  valued_cost_minor    bigint         [not null, note: 'The numerator: total value received, in integer minor units, landed cost included. Non-negative, CHECKed.']
  receipt_count        integer        [not null, default: 0, note: 'How many receipts have rolled into it. Diagnostic — it is what tells a support engineer whether an average is one delivery or two hundred.']
  last_receipt_at      timestamptz    [null]
  created_at           timestamptz    [not null, default: `now()`]
  updated_at           timestamptz    [not null, note: 'auto-updated on write']

  indexes {
    (organization_id, branch_id, product_id, currency) [unique, note: 'The upsert arbiter. `currency` is NOT NULL, so no NULLS NOT DISTINCT rewrite is needed here.']
    (organization_id, branch_id, product_id)
  }

  Note: 'The moving average cost of one product at one branch, in one currency (PI-4.8). ⚠️ THIS TABLE HOLDS A QUANTITY AND IS **NOT** A SOURCE OF QUANTITY TRUTH. It is the single most misreadable row in the programme, so: `valued_quantity_ base` is the DENOMINATOR OF AN AVERAGE'
}

// ===== products.prisma =============================================

Table units_of_measure {
  id              uuid         [pk, not null, default: `uuid()`]
  organization_id uuid         [null, note: 'NULL = platform row, visible to every tenant.']
  code            varchar(32)  [not null, note: 'Stable machine key. `TAB`, `ML`, `MG`, `STRIP`. Uppercase, no path.']
  name            varchar(128) [not null]
  symbol          varchar(16)  [not null, note: 'What a picker shows beside a quantity. `mL`, not `MILLILITRE`.']
  unit_class      UnitClass    [not null]
  is_base         boolean      [not null, default: false, note: 'The canonical unit of this class. See the warning above.']
  is_active       boolean      [not null, default: true]
  created_at      timestamptz  [not null, default: `now()`]
  updated_at      timestamptz  [not null, note: 'auto-updated on write']

  indexes {
    (organization_id, code) [unique, note: '⚠️ Rewritten NULLS NOT DISTINCT in the migration — without it the platform rows (organization_id NULL) are not unique among themselves.']
    (organization_id, id) [unique, note: '''The composite-FK target. Nothing references a unit compositely today; it is here so PI-2's ledger can, without a migration under data.''']
    (organization_id, unit_class, is_active)
  }

  Note: 'A unit of measure. Platform catalogue with per-tenant extension. `isBase` marks the canonical unit of its class — the one every conversion in that class resolves through, so `strip -> tablet` and `box -> tablet` need two rows in `unit_conversions` rather than four.'
}

Table unit_conversions {
  id              uuid        [pk, not null, default: `uuid()`]
  organization_id uuid        [null]
  from_unit_id    uuid        [not null]
  to_unit_id      uuid        [not null]
  numerator       bigint      [not null, note: 'Both > 0, CHECKed in the migration. A zero denominator is a division by zero at every call site; a zero numerator silently annihilates a quantity.']
  denominator     bigint      [not null, default: 1]
  created_at      timestamptz [not null, default: `now()`]
  updated_at      timestamptz [not null, note: 'auto-updated on write']

  indexes {
    (organization_id, from_unit_id, to_unit_id) [unique]
    (organization_id, from_unit_id)
    (organization_id, to_unit_id)
  }

  Note: '`from` × numerator / denominator = `to`. An exact rational, never a float. WHY TWO INTEGERS AND NOT ONE `factor` 1 strip = 10 tablets is exact either way. 1 fluid ounce = 29.5735 mL is not, and neither is a third of a gram.'
}

Table product_categories {
  id              uuid         [pk, not null, default: `uuid()`]
  organization_id uuid         [null]
  parent_id       uuid         [null]
  code            varchar(64)  [not null]
  name            varchar(255) [not null]
  description     text         [null]
  display_order   integer      [not null, default: 0, note: 'Sort among siblings. Ties break by `name` so the order is total.']
  is_active       boolean      [not null, default: true]
  created_at      timestamptz  [not null, default: `now()`]
  updated_at      timestamptz  [not null, note: 'auto-updated on write']
  deleted_at      timestamptz  [null]

  indexes {
    (organization_id, code) [unique]
    (organization_id, id) [unique]
    (organization_id, is_active)
    parent_id [note: 'Descendant walks recurse on `parent_id`. Without this the recursive CTE seq-scans the table once PER LEVEL.']
  }

  Note: 'The product classification tree. Platform catalogue with tenant extension. ⚠️ `parent_id` IS THE HIERARCHY AND THE ONLY THING THAT IS — the same shape `specialties` uses, and reused rather than reinvented on purpose.'
}

Table manufacturers {
  id              uuid         [pk, not null, default: `uuid()`]
  organization_id uuid         [null]
  code            varchar(64)  [not null]
  name            varchar(255) [not null]
  country_code    char(2)      [null, note: 'ISO 3166-1 alpha-2, matching every other country column in this schema.']
  licence_number  varchar(128) [null, note: 'The manufacturing licence the regulator issued. Free text because ten countries format it ten ways; PI-5 gives it a jurisdiction and a shape.']
  gs1_prefix      varchar(16)  [null, note: 'GS1 company prefix, where they have one. Lets a scanned GTIN be attributed to a maker even when the product itself is unknown.']
  is_active       boolean      [not null, default: true]
  created_at      timestamptz  [not null, default: `now()`]
  updated_at      timestamptz  [not null, note: 'auto-updated on write']
  deleted_at      timestamptz  [null]

  indexes {
    (organization_id, code) [unique]
    (organization_id, id) [unique]
    (organization_id, is_active)
    (organization_id, country_code)
  }

  Note: '''Who makes it. Referenced by products and, from PI-2, by batches — a batch's manufacturer may legitimately differ from the product's when a product is contract-manufactured or repackaged.'''
}

Table active_ingredients {
  id              uuid         [pk, not null, default: `uuid()`]
  organization_id uuid         [null]
  code            varchar(64)  [not null]
  name            varchar(255) [not null]
  inn_name        varchar(255) [null]
  synonyms        jsonb        [null, note: 'Alternative spellings and local names, for search. A document of strings — ⚠️ NEVER foreign keys (ADR-0006).']
  description     text         [null]
  is_active       boolean      [not null, default: true]
  created_at      timestamptz  [not null, default: `now()`]
  updated_at      timestamptz  [not null, note: 'auto-updated on write']
  deleted_at      timestamptz  [null]

  indexes {
    (organization_id, code) [unique]
    (organization_id, id) [unique]
    (organization_id, is_active)
  }

  Note: 'A pharmacologically active substance. The bottom of the generic/brand triangle. `innName` is the International Nonproprietary Name — the one identifier that is the same substance in every country, which is what makes a cross-border catalogue joinable at all.'
}

Table compositions {
  id              uuid         [pk, not null, default: `uuid()`]
  organization_id uuid         [null]
  code            varchar(64)  [not null]
  name            varchar(500) [not null, note: '"Amoxicillin 500 mg + Clavulanic acid 125 mg tablet".']
  dosage_form     DosageForm   [null, note: 'The form the composition is expressed in. Two products with the same ingredients in different forms are not equivalent.']
  is_active       boolean      [not null, default: true]
  created_at      timestamptz  [not null, default: `now()`]
  updated_at      timestamptz  [not null, note: 'auto-updated on write']
  deleted_at      timestamptz  [null]

  indexes {
    (organization_id, code) [unique]
    (organization_id, id) [unique]
    (organization_id, is_active)
  }

  Note: 'A NAMED SET of ingredients at strengths. The middle of the triangle. ⚠️ THIS IS WHAT MAKES SUBSTITUTION ANSWERABLE AT ALL. Many products — every brand and every generic'
}

Table composition_ingredients {
  id               uuid           [pk, not null, default: `uuid()`]
  organization_id  uuid           [null]
  composition_id   uuid           [not null]
  ingredient_id    uuid           [not null]
  strength         decimal(14, 6) [not null, note: '500 in "500 mg". Decimal because micrograms and IU both occur and both need fractions; ⚠️ never a float (PI-ADR-010).']
  strength_unit_id uuid           [not null, note: 'The unit that strength is expressed in — mg, mL, IU, %. A plain FK into a possibly-platform row, so it carries a RESTRICTIVE visibility policy.']
  per_quantity     decimal(14, 6) [null, note: '"per 5 mL", "per tablet". Presentation only: the denominator of a concentration, printed on a label and never computed with here.']
  display_order    integer        [not null, default: 0]
  created_at       timestamptz    [not null, default: `now()`]
  updated_at       timestamptz    [not null, note: 'auto-updated on write']

  indexes {
    (organization_id, composition_id, ingredient_id) [unique]
    (organization_id, ingredient_id)
  }

  Note: 'One ingredient at one strength inside a composition. ⚠️ A MEDICINE IS NEVER ONE INGREDIENT, and the strength lives HERE rather than on the composition for exactly that reason. Co-amoxiclav is two substances at two strengths;'
}

Table storage_requirement_profiles {
  id                         uuid             [pk, not null, default: `uuid()`]
  organization_id            uuid             [null]
  code                       varchar(64)      [not null]
  name                       varchar(255)     [not null]
  min_temperature_c          decimal(5, 2)    [null]
  max_temperature_c          decimal(5, 2)    [null]
  min_humidity_pct           integer          [null]
  max_humidity_pct           integer          [null]
  light_sensitivity          LightSensitivity [not null, default: 'NONE']
  requires_controlled_access boolean          [not null, default: false, note: 'A locked cabinet, a signed register. Descriptive here; PI-5 decides which products a jurisdiction REQUIRES it for.']
  hazard_class               varchar(64)      [null, note: 'UN/GHS class where one applies — a cytotoxic or a flammable reagent.']
  handling_notes             text             [null]
  is_active                  boolean          [not null, default: true]
  created_at                 timestamptz      [not null, default: `now()`]
  updated_at                 timestamptz      [not null, note: 'auto-updated on write']

  indexes {
    (organization_id, code) [unique]
    (organization_id, id) [unique]
    (organization_id, is_active)
  }

  Note: 'How a product must be kept. Referenced by products, and from PI-2 by inventory locations so a fridge can be matched against what it may hold. Temperatures are `Decimal(5,2)` in Celsius: 2.00–8.00 for a vaccine fridge, -20.00 for a freezer. ⚠️ Not a float'
}

Table products {
  id                      uuid               [pk, not null, default: `uuid()`]
  organization_id         uuid               [null, note: 'NULL = platform row, visible to every tenant.']
  type                    ProductType        [not null]
  status                  ProductStatus      [not null, default: 'DRAFT']
  code                    varchar(64)        [not null, note: '''The clinic's own code. Distinct from `product_identifiers`, which holds externally-issued namespaces — this one is always ours.''']
  name                    varchar(500)       [not null, note: 'What it is called on a shelf and in a picker.']
  brand_name              varchar(255)       [null, note: 'The proprietary name, when there is one. NULL for a generic and for everything that is not a medicine.']
  generic_name            varchar(255)       [null, note: 'The non-proprietary name, denormalised for search. ⚠️ NOT the source of truth for equivalence — `composition_id` is.']
  description             text               [null]
  category_id             uuid               [null]
  manufacturer_id         uuid               [null]
  composition_id          uuid               [null, note: 'NULL for anything that is not a medicinal product. See `Composition`.']
  storage_profile_id      uuid               [null]
  base_unit_id            uuid               [not null]
  tracking_mode           TrackingMode       [not null, default: 'NONE']
  is_expiry_controlled    boolean            [not null, default: false, note: 'Orthogonal to `trackingMode` on purpose — see the enum.']
  default_shelf_life_days integer            [null, note: 'Shelf life from manufacture, when the clinic knows it and the supplier does not print it.']
  reorder_level_base      decimal(18, 6)     [null, note: '''Reorder defaults, in BASE UNITS. Per-branch overrides are PI-2's business; these are the product's own starting point.''']
  reorder_quantity_base   decimal(18, 6)     [null]
  is_stock_item           boolean            [not null, default: true, note: 'Whether this product is stocked at all. A consultation fee is a product to billing and never to inventory;']
  allocation_strategy     AllocationStrategy [null, note: 'How this product is picked when several lots could satisfy a demand. ⚠️ NULL MEANS FEFO, AND NULL IS NOT THE SAME AS `FEFO`.']
  metadata                jsonb              [null, note: 'Free-form document: external system codes, display labels per locale, supplier hints. ⚠️ A DOCUMENT, NEVER FOREIGN KEYS (ADR-0006).']
  created_at              timestamptz        [not null, default: `now()`]
  updated_at              timestamptz        [not null, note: 'auto-updated on write']
  deleted_at              timestamptz        [null]

  indexes {
    (organization_id, code) [unique]
    (organization_id, id) [unique, note: 'The composite-FK target every child in this file references.']
    (organization_id, status, type)
    (organization_id, category_id)
    (organization_id, composition_id)
    (organization_id, manufacturer_id)
    (organization_id, name) [note: '''The list screen's default ordering, and the prefix of its search.''']
  }

  Note: 'The root entity. "Amoxicillin 500 mg capsule, Brand A, by Manufacturer M". ⚠️ NO QUANTITY, NO LOCATION, NO PRICE. See the file header. `baseUnitId` is the denomination every quantity in the programme resolves to. A pack of 10 strips of 10 tablets is 100 in base units, and the ledger stores 100'
}

Table product_packagings {
  id                  uuid           [pk, not null, default: `uuid()`]
  organization_id     uuid           [null]
  product_id          uuid           [not null]
  level               integer        [not null, note: '0 = base. Unique per product, so the chain is total and unambiguous.']
  unit_id             uuid           [not null]
  quantity_of_child   decimal(18, 6) [not null, note: 'How many of level-1 fit in one of these. Always 1 at level 0. > 0, CHECKed.']
  is_default_purchase boolean        [not null, default: false, note: 'The level a purchase order is written in by default.']
  is_default_sale     boolean        [not null, default: false, note: 'The level a dispense or a sale is written in by default.']
  barcode             varchar(128)   [null]
  created_at          timestamptz    [not null, default: `now()`]
  updated_at          timestamptz    [not null, note: 'auto-updated on write']

  indexes {
    (organization_id, product_id, level) [unique]
    (organization_id, product_id)
  }

  Note: 'One level of a packaging hierarchy: `box(10) -> strip(10) -> tablet`. `level` 0 is the base unit itself and `quantityOfChild` is how many of the NEXT LEVEL DOWN one of these contains.'
}

Table product_identifiers {
  id              uuid                  [pk, not null, default: `uuid()`]
  organization_id uuid                  [null]
  product_id      uuid                  [not null]
  type            ProductIdentifierType [not null]
  value           varchar(128)          [not null]
  country_code    char(2)               [null, note: 'NULL = valid everywhere. A GTIN usually is; a national code never is.']
  effective_from  date                  [not null, default: `now()`, note: '''A DATE, not an instant: an identifier is assigned on a day, in nobody's particular timezone.''']
  effective_to    date                  [null]
  is_primary      boolean               [not null, default: false]
  created_at      timestamptz           [not null, default: `now()`]
  updated_at      timestamptz           [not null, note: 'auto-updated on write']

  indexes {
    (organization_id, type, value, country_code) [unique, note: '⚠️ Rewritten NULLS NOT DISTINCT in the migration: both organization_id and country_code are nullable, and a plain unique index does not constrain null …']
    (organization_id, type, value) [note: 'The barcode lookup, which becomes the hottest read in the programme at PI-23. Index-only for the common case.']
    (organization_id, product_id)
  }

  Note: 'An externally-issued identifier for a product, effective-dated. ⚠️ UNIQUENESS IS TENANT-, TYPE- AND COUNTRY-QUALIFIED. NEVER a bare `@@unique([value])`: the same digits are a GTIN for one product and a national code for another, repackagers reuse GTINs, and two countries assign the same national cod …'
}

Table product_tax_classifications {
  id              uuid        [pk, not null, default: `uuid()`]
  organization_id uuid        [null]
  product_id      uuid        [not null]
  country_code    char(2)     [not null]
  region_code     varchar(16) [null, note: 'State or province. NULL = the whole country. A region row BEATS a country row for the same date — resolved in the service, tested there.']
  tax_category    varchar(64) [not null, note: 'The exact-match key into `tax_rules`. Never a rate.']
  item_code       varchar(32) [null, note: 'HSN / SAC / commodity code. Printed, never looked up.']
  effective_from  date        [not null]
  effective_to    date        [null]
  created_at      timestamptz [not null, default: `now()`]
  updated_at      timestamptz [not null, note: 'auto-updated on write']

  indexes {
    (organization_id, product_id, country_code, region_code, effective_from) [unique, note: 'One classification per product, per jurisdiction, per start date. Rewritten NULLS NOT DISTINCT in the migration']
    (organization_id, product_id, country_code)
  }

  Note: 'What tax category a product falls into, in one jurisdiction, on a date. ⚠️ THIS PROGRAMME WRITES NO TAX LOGIC (PI-ADR-006). This table resolves a `tax_category` STRING and stops. That string keys `tax_rules` by exact match, and `@rcln/tax`'
}

Table medicine_details {
  id                               uuid                [pk, not null, default: `uuid()`]
  organization_id                  uuid                [null]
  product_id                       uuid                [not null]
  dosage_form                      DosageForm          [null]
  route                            AdministrationRoute [null]
  release_type                     ReleaseType         [null]
  is_narrow_therapeutic_index      boolean             [not null, default: false, note: 'Drugs where a small change in blood concentration matters clinically — warfarin, levothyroxine, ciclosporin.']
  prescription_classification_hint varchar(64)         [null, note: 'What a clinic believes about prescription status, pending PI-5. See above.']
  label_instructions               text                [null, note: 'Storage and handling text printed on a dispensing label.']
  default_course_days              integer             [null, note: 'Days a course of this normally runs. A data-entry default for prescribing.']
  created_at                       timestamptz         [not null, default: `now()`]
  updated_at                       timestamptz         [not null, note: 'auto-updated on write']

  indexes {
    (organization_id, product_id) [unique]
  }

  Note: 'Medicine-specific attributes. 1:1 with a product, and absent for everything that is not a medicine (PI-ADR-001). ⚠️ `prescriptionClassificationHint` IS A HINT AND IS NOT THE ANSWER.'
}

// ===== recall.prisma ===============================================

Table recalls {
  id               uuid                 [pk, not null, default: `uuid()`]
  organization_id  uuid                 [not null]
  reference        varchar(64)          [not null, note: '''The clinic's own number for it — `REC-2026-0004`. Unique per organization, never globally: it is this clinic's filing reference.''']
  product_id       uuid                 [not null, note: '⚠️ A PLAIN FK INTO A POSSIBLY-PLATFORM ROW, so it carries a RESTRICTIVE `product_visible` policy.']
  title            varchar(255)         [not null]
  classification   RecallClassification [not null, default: 'UNCLASSIFIED']
  source           RecallSource         [not null]
  notice_reference varchar(128)         [null, note: '''The regulator's or manufacturer's own notice number, so the clinic's file can be tied back to the announcement.''']
  notice_on        date                 [null, note: '''A DATE, not an instant. A notice is issued on a DAY in the issuer's calendar, which is the same call `batches.expires_on` makes.''']
  reason           text                 [not null, note: 'Why. Required — a recall with no stated reason is un-auditable, and the CHECK in the migration insists it is not blank.']
  status           RecallStatus         [not null, default: 'DRAFT']
  raised_by_id     uuid                 [not null]
  executed_at      timestamptz          [null]
  executed_by_id   uuid                 [null]
  closed_at        timestamptz          [null]
  closed_by_id     uuid                 [null]
  outcome_note     text                 [null, note: 'Why it was closed or cancelled. One column for both, because the question is the same one — "how did this end"']
  notes            text                 [null]
  created_at       timestamptz          [not null, default: `now()`]
  updated_at       timestamptz          [not null, note: 'auto-updated on write']

  indexes {
    (organization_id, reference) [unique]
    (organization_id, id) [unique, note: 'The composite-FK target `recall_batches` references.']
    (organization_id, status, created_at) [note: 'DESC on created_at']
    (organization_id, product_id)
  }

  Note: 'A recall notice, and the piece of work it starts. ⚠️ ONE PRODUCT PER RECALL, AND THAT IS A MODELLING DECISION RATHER THAN A LIMITATION. A notice names a product and lists its lots;'
}

Table recall_batches {
  id                 uuid              [pk, not null, default: `uuid()`]
  organization_id    uuid              [not null]
  branch_id          uuid              [not null, note: '⚠️ DENORMALISED FROM THE BATCH so this table can be an ordinary member of the branch RLS loop rather than needing a hand-written parent predicate.']
  recall_id          uuid              [not null]
  batch_id           uuid              [not null]
  lot_number         varchar(128)      [not null, note: 'As printed on the pack, snapshotted. See the model comment.']
  status             RecallBatchStatus [not null, default: 'PENDING']
  quantity_held_base decimal(18, 6)    [null, note: '''What actually moved into the RECALLED bucket when this was executed, in the product's BASE UNIT. ⚠️ A RECORD OF A MOVEMENT, NEVER A BALANCE''']
  held_at            timestamptz       [null]
  released_at        timestamptz       [null]
  outcome_note       text              [null, note: 'Why this lot came out of the recall, or where it went. Required by CHECK whenever the row is RELEASED or DISPOSED.']
  created_at         timestamptz       [not null, default: `now()`]
  updated_at         timestamptz       [not null, note: 'auto-updated on write']

  indexes {
    (organization_id, recall_id, batch_id) [unique, note: '⚠️ ONE ROW PER LOT PER RECALL. Without it the same lot is added twice and executed twice, and the second execution moves a quantity that is already in …']
    (organization_id, id) [unique]
    (organization_id, recall_id)
    (organization_id, batch_id) [note: '"Is this lot under recall" — asked from the STOCK side, by a lot screen.']
    (organization_id, branch_id, status)
  }

  Note: 'One lot inside one recall. ⚠️ THE LOT NUMBER IS SNAPSHOTTED BESIDE THE FOREIGN KEY, and that is not duplication. A recall is read years later, and it is read as a DOCUMENT: what the notice named has to stay legible even if the batch row is eventually purged under a retention policy, exactly as `stoc …'
}

// ===== regulatory.prisma ===========================================

Table jurisdictions {
  id           uuid         [pk, not null, default: `uuid()`]
  country_code char(2)      [not null, note: 'ISO 3166-1 alpha-2.']
  region_code  varchar(16)  [null, note: 'ISO 3166-2 subdivision without the prefix. NULL = the whole country.']
  name         varchar(255) [not null, note: '"India", "Karnataka". What a picker shows.']
  is_active    boolean      [not null, default: true]
  created_at   timestamptz  [not null, default: `now()`]
  updated_at   timestamptz  [not null, note: 'auto-updated on write']

  indexes {
    (country_code, region_code) [unique, note: '⚠️ Rewritten NULLS NOT DISTINCT in the migration — `region_code` is nullable and the country-wide row is the common case, so without it the table does …']
    (country_code, is_active)
  }

  Note: 'A country, or a sub-national division of one. ⚠️ `(IN, NULL)` AND `(IN, KA)` ARE TWO ROWS, AND THE COUNTRY ROW IS NOT THE PARENT OF THE REGION ROW IN ANY FK SENSE. Resolution walks from the most specific to the least — a Karnataka branch consults the `IN-KA` pack and then the `IN` pack'
}

Table regulatory_authorities {
  id              uuid         [pk, not null, default: `uuid()`]
  jurisdiction_id uuid         [not null]
  code            varchar(64)  [not null, note: 'Stable machine key. `CDSCO`, `MHRA`, `FDA`. Uppercase, no path.']
  name            varchar(255) [not null]
  website_url     varchar(500) [null]
  remit           text         [null, note: 'What this authority is responsible for, in a sentence. Shown beside the name so an operator can tell two regulators of one country apart.']
  is_active       boolean      [not null, default: true]
  created_at      timestamptz  [not null, default: `now()`]
  updated_at      timestamptz  [not null, note: 'auto-updated on write']

  indexes {
    code [unique]
    (jurisdiction_id, is_active)
  }

  Note: '''Who issues the rules. A national medicines regulator, a state drugs controller, a professional council. One jurisdiction has several — India has CDSCO and each state's drugs control department, and a rule cites the one that published it.'''
}

Table regulatory_sources {
  id                 uuid                   [pk, not null, default: `uuid()`]
  jurisdiction_id    uuid                   [not null]
  authority_id       uuid                   [not null]
  title              varchar(500)           [not null, note: '''The document's own title, as published.''']
  document_reference varchar(255)           [null, note: 'The citation a lawyer would use — an act, a rule number, a schedule.']
  source_url         varchar(1000)          [null, note: '''Where it was read. ⚠️ The regulator's own domain, or a note in `notes` saying why not.''']
  version            varchar(64)            [null, note: 'The version or amendment the citation refers to.']
  published_on       date                   [null, note: 'When the authority published it.']
  effective_from     date                   [null, note: 'When it took legal effect, where that differs from publication.']
  retrieved_at       timestamptz            [null, note: '⚠️ AN INSTANT, NOT A DATE — this is a thing somebody DID, and invariant 6 governs it. It is what a staleness report reads.']
  review_status      RegulatorySourceStatus [not null, default: 'UNVERIFIED']
  notes              text                   [null]
  created_at         timestamptz            [not null, default: `now()`]
  updated_at         timestamptz            [not null, note: 'auto-updated on write']

  indexes {
    (jurisdiction_id, review_status)
    authority_id
  }

  Note: 'One authoritative document. The registry a rule must cite to exist. ⚠️ `regulatory_rules.source_id` IS NOT NULL. A rule with no source cannot be inserted, and that is the single most important constraint in this file.'
}

Table regulatory_rule_packs {
  id                  uuid             [pk, not null, default: `uuid()`]
  jurisdiction_id     uuid             [not null]
  authority_id        uuid             [not null]
  version             varchar(32)      [not null, note: 'Semantic, monotonic per jurisdiction. `1.0.0`.']
  name                varchar(255)     [not null]
  description         text             [null]
  maturity            RulePackMaturity [not null, default: 'ARCHITECTURE_SUPPORTED']
  effective_from      date             [not null]
  effective_to        date             [null]
  last_reviewed_at    timestamptz      [null, note: 'When the pack was last looked at by a person. Drives the staleness report; an instant, not a date.']
  reviewed_by         varchar(255)     [null, note: '''⚠️ THE NAME OF A HUMAN, WRITTEN BY THAT HUMAN'S OWN ACTION, and NOT a user id. Whoever signs a jurisdiction off is a qualified person''']
  reviewed_by_user_id uuid             [null]
  reviewed_at         timestamptz      [null]
  review_notes        text             [null, note: 'What the reviewer said. Kept because "approved" with no reasoning is not a review anybody can stand behind later.']
  created_at          timestamptz      [not null, default: `now()`]
  updated_at          timestamptz      [not null, note: 'auto-updated on write']

  indexes {
    (jurisdiction_id, version) [unique]
    (jurisdiction_id, maturity)
    (jurisdiction_id, effective_from)
  }

  Note: 'One jurisdiction, one version, a set of typed rules. ⚠️ A PACK IS NEVER EDITED INTO A NEW VERSION. A change is a NEW pack row with a new `version` and a new `effective_from`, and the old one gets an `effective_to`.'
}

Table regulatory_rules {
  id                        uuid                 [pk, not null, default: `uuid()`]
  pack_id                   uuid                 [not null]
  rule_type                 RegulatoryRuleType   [not null]
  code                      varchar(64)          [not null, note: '''Stable machine key, unique within the pack. Cited in a decision's reasons and in the test that pins this rule's behaviour.''']
  statement                 text                 [not null, note: 'One sentence a human can read, printed verbatim in a refusal. ⚠️ It ends up in front of a pharmacist at a counter, so it says what to DO, not what fai …']
  status                    RegulatoryRuleStatus [not null, default: 'DRAFT']
  applies_to_product_type   ProductType          [null, note: 'A whole class of product. NULL = not narrowed by type.']
  applies_to_category_id    uuid                 [null, note: '⚠️ A PLATFORM CATEGORY ONLY, ENFORCED BY A TRIGGER IN THE MIGRATION. `product_categories` is platform-EXTENSIBLE, so this plain FK could otherwise nam …']
  applies_to_classification varchar(64)          [null, note: 'The classification string a `product_regulatory_profiles` row asserts — "SCHEDULE_H", "POM", "GSL".']
  parameters                jsonb                [not null, note: '''The rule's own parameters. A DOCUMENT, never foreign keys.''']
  source_id                 uuid                 [not null]
  version                   integer              [not null, default: 1, note: 'Monotonic per `(pack, code)`. A change is a new row, never an edit.']
  effective_from            date                 [not null]
  effective_to              date                 [null]
  created_at                timestamptz          [not null, default: `now()`]
  updated_at                timestamptz          [not null, note: 'auto-updated on write']

  indexes {
    (pack_id, code, version) [unique]
    (pack_id, rule_type, status)
    (pack_id, effective_from)
  }

  Note: '''One typed, effective-dated, source-cited statement of law. ⚠️ WHICH PRODUCTS A RULE APPLIES TO IS EXPRESSED IN TYPED COLUMNS, NEVER AS AN ID INSIDE `parameters` (ADR-0006). The JSONB holds the rule's own PARAMETERS — a maximum quantity, a validity period, a list of prescriber classes'''
}

Table product_regulatory_profiles {
  id                       uuid                      [pk, not null, default: `uuid()`]
  organization_id          uuid                      [null, note: 'NULL = platform row, visible to every tenant.']
  product_id               uuid                      [not null]
  jurisdiction_id          uuid                      [not null, note: '⚠️ A ROW IN `jurisdictions`, NOT A COUNTRY STRING, and it is the one place this domain diverges from `product_tax_classifications`.']
  registration_number      varchar(128)              [null]
  registration_status      ProductRegistrationStatus [not null, default: 'UNKNOWN']
  classification           varchar(64)               [null, note: '''The authority's own words for what this is — `SCHEDULE_H`, `POM`, `GSL`. Matched EXACTLY against `regulatory_rules.applies_to_classification`.''']
  controlled_schedule      varchar(64)               [null, note: 'The controlled schedule, where the jurisdiction has one. What that schedule OBLIGES is `CONTROLLED_SCHEDULE` rules, never this string.']
  prescription_requirement PrescriptionRequirement   [not null, default: 'UNKNOWN']
  online_sale_position     OnlineSalePosition        [not null, default: 'UNKNOWN']
  dispensing_notes         text                      [null, note: 'Anything the clinic must know that is not one of the columns above — cold chain on import, a witnessed disposal. Text, and never parsed.']
  effective_from           date                      [not null]
  effective_to             date                      [null]
  created_at               timestamptz               [not null, default: `now()`]
  updated_at               timestamptz               [not null, note: 'auto-updated on write']

  indexes {
    (organization_id, product_id, jurisdiction_id, effective_from) [unique, note: 'One profile per product, per jurisdiction, per start date. ⚠️ Rewritten NULLS NOT DISTINCT in the migration']
    (organization_id, product_id)
    (organization_id, jurisdiction_id)
  }

  Note: 'What a product IS, in one jurisdiction, on a date. Tenant data, platform-extensible in the same shape as the rest of the catalogue. ⚠️ A PRODUCT DOES NOT HAVE ONE REGULATORY NATURE.'
}

Table regulatory_decisions {
  id                   uuid                      [pk, not null, default: `uuid()`]
  organization_id      uuid                      [not null]
  branch_id            uuid                      [not null]
  product_id           uuid                      [not null]
  transaction          RegulatoryTransactionType [not null]
  outcome              RegulatoryDecisionOutcome [not null]
  country_code         char(2)                   [not null, note: 'The jurisdiction the decision was made UNDER, as codes rather than as a FK to `jurisdictions`: a snapshot that could be re-pointed is not one.']
  region_code          varchar(8)                [null]
  lowest_pack_maturity RulePackMaturity          [null, note: 'The weakest maturity of any pack that contributed, and NULL when none did — which is the ordinary state of an unconfigured jurisdiction, and the reaso …']
  was_enforced         boolean                   [not null, default: false, note: 'Was the platform allowed to ACT on this answer? See `services/regulatory/enforcement.ts`']
  quantity_base        decimal(18, 6)            [not null, note: 'The quantity asked about, in base units, and the instant asked about.']
  evaluated_at         timestamptz               [not null]
  pack_versions        jsonb                     [not null, note: 'The pack ids and versions that contributed. A document (see the model note).']
  reasons              jsonb                     [not null, note: 'One entry per rule that had something to say, with its verbatim sentence.']
  conditions           jsonb                     [not null, note: 'Obligations the transaction had to satisfy. ⚠️ An obligation, never a warning']
  actor_user_id        uuid                      [not null]
  created_at           timestamptz               [not null, default: `now()`]

  indexes {
    (organization_id, id) [unique]
    (organization_id, branch_id, evaluated_at) [note: 'DESC on evaluated_at']
    (organization_id, product_id, evaluated_at) [note: 'DESC on evaluated_at']
    (organization_id, outcome)
  }

  Note: 'One evaluation, as it stood when a transaction relied on it. ⚠️ THIS IS A SNAPSHOT AND NOT A CACHE. Nothing ever re-evaluates a row here and nothing may rewrite one.'
}

// ===== scheduling.prisma ===========================================

Table appointments {
  id                      uuid                 [pk, not null, default: `uuid()`]
  organization_id         uuid                 [not null]
  branch_id               uuid                 [not null]
  patient_id              uuid                 [not null]
  patient_registration_id uuid                 [not null, note: '''The branch-local attendance row this booking was made against. Composite- FK'd, so a booking can never cite a registration at a different branch.''']
  doctor_profile_id       uuid                 [not null]
  appointment_number      varchar(32)          [not null, note: 'Branch-local, issued from the `APPOINTMENT` counter. Said out loud on the phone, so it is issued rather than typed.']
  scheduled_start         timestamptz          [not null]
  scheduled_end           timestamptz          [not null]
  visit_type              AppointmentVisitType [not null, default: 'NEW']
  source                  AppointmentSource    [not null, default: 'FRONT_DESK']
  status                  AppointmentStatus    [not null, default: 'BOOKED']
  parent_appointment_id   uuid                 [null, note: '''The visit this one follows up on. Composite-FK'd to (organization_id, id), so a follow-up can never cite a parent in another tenant.''']
  clinical_episode_id     uuid                 [not null, note: 'The treatment journey this booking belongs to (CE-1, CD-13). ⚠️ A DIFFERENT QUESTION FROM `parentAppointmentId`, AND CONFLATING THE TWO IS THE MISTAKE …']
  reason                  text                 [null, note: '⚠️ PHI, AND IN `REDACTED_KEYS`. "Chest pain since Tuesday" is a clinical statement typed at the front desk. It never reaches an audit row.']
  checked_in_at           timestamptz          [null]
  started_at              timestamptz          [null]
  completed_at            timestamptz          [null]
  booked_by               uuid                 [null, note: 'SetNull: the receptionist may leave; the booking stays.']
  cancelled_by            uuid                 [null]
  cancellation_reason     text                 [null, note: '⚠️ PHI by the same reasoning as `reason`.']
  booked_fee              decimal(14, 2)       [null, note: 'What this visit will be billed at, RESOLVED AND FROZEN WHEN IT WAS BOOKED. ⚠️ THE PRICE THE PATIENT WAS QUOTED, NOT THE PRICE IN FORCE TODAY.']
  created_at              timestamptz          [not null, default: `now()`]
  updated_at              timestamptz          [not null, note: 'auto-updated on write']
  deleted_at              timestamptz          [null]

  indexes {
    (organization_id, branch_id, appointment_number) [unique]
    (organization_id, id) [unique, note: 'Composite-FK target: encounters, invoices and queue tokens will reference (organization_id, id) so a cross-tenant child is unrepresentable (ADR-0004).']
    (organization_id, branch_id, scheduled_start) [note: 'The day board: one branch, one day, in time order.']
    (organization_id, doctor_profile_id, scheduled_start) [note: '"What does my afternoon look like?" — and the read the engine does on every availability request.']
    (organization_id, patient_id, scheduled_start) [note: '"When was this patient last here?"']
    (organization_id, parent_appointment_id) [note: '"What follows this visit?" — walked in both directions when the diagnosis page assembles the cumulative prescription for a chain.']
    (organization_id, clinical_episode_id, scheduled_start) [note: '"Show me this whole treatment journey, in order." One indexed equality where walking the chain would be a recursive CTE per render.']
  }

  Note: '''One booked slot: this patient, this doctor, this branch, this instant. ⚠️ `scheduledStart`/`scheduledEnd` ARE ABSOLUTE INSTANTS, unlike `doctor_schedules.start_time`, which is wall-clock in the branch's zone.'''
}

Table appointment_reschedules {
  id                     uuid                [pk, not null, default: `uuid()`]
  organization_id        uuid                [not null]
  branch_id              uuid                [not null, note: 'Copied from the appointment, so this row is an ordinary member of the branch RLS loop rather than inheriting only the org half through a parent.']
  appointment_id         uuid                [not null]
  from_start             timestamptz         [not null, note: 'Where the visit was, and where it went. Both instants, both UTC.']
  to_start               timestamptz         [not null]
  from_doctor_profile_id uuid                [not null, note: 'Who was going to see the patient, and who will now. Equal on an ordinary move; different when the swap is what re-resolved the fee.']
  to_doctor_profile_id   uuid                [not null]
  initiated_by           RescheduleInitiator [not null]
  reason                 text                [null, note: '⚠️ PHI. See the model note.']
  charge_amount          decimal(14, 2)      [not null, default: 0, note: 'What the move cost. Always 0 for a CLINIC move.']
  created_at             timestamptz         [not null, default: `now()`]
  created_by             uuid                [null]

  indexes {
    (organization_id, appointment_id, created_at) [note: 'The billing read: every move of one appointment, oldest first.']
  }

  Note: '''One move of one appointment: who asked, why, and what it cost. ⚠️ A TABLE AND NOT A COUNTER, BECAUSE A REASON IS WANTED PER MOVE. A patient who moves an appointment three times is billed three times and has given three explanations, and "why do patients keep moving Dr Tejas's slots?" is a question a …'''
}

Table appointment_vitals {
  id                   uuid          [pk, not null, default: `uuid()`]
  organization_id      uuid          [not null]
  branch_id            uuid          [not null]
  appointment_id       uuid          [not null]
  patient_id           uuid          [not null, note: 'Denormalised from the appointment so the patient timeline ("show me every BP this year") does not have to join through every visit to find them.']
  height_cm            decimal(5, 1) [null, note: 'Centimetres. Decimal because paediatric heights are recorded to the mm.']
  weight_kg            decimal(5, 1) [null, note: 'Kilograms, to 100g — the resolution of a clinic scale.']
  temperature_c        decimal(4, 2) [null, note: '⚠️ NOT STORED. BMI is derived from the two above and would go stale the moment either is corrected. Computed at read time. Degrees Celsius.']
  pulse_bpm            smallint      [null]
  respiratory_rate_bpm smallint      [null]
  systolic_mm_hg       smallint      [null, note: 'The two halves of the blood pressure, apart rather than as "120/80". They are independently trended and independently out of range.']
  diastolic_mm_hg      smallint      [null]
  spo2_percent         smallint      [null, note: 'Oxygen saturation, whole percent.']
  blood_glucose_mg_dl  decimal(5, 1) [null, note: 'mg/dL — the unit Indian clinics report in. Decimal, not float.']
  notes                text          [null, note: '⚠️ PHI. Free text — "patient was distressed, repeated after 10 min".']
  recorded_at          timestamptz   [not null, default: `now()`, note: 'When the observation was taken, which is not when the row was written. The front desk types up a paper slip an hour later often enough that inferring …']
  recorded_by          uuid          [null, note: 'SetNull: the nurse may leave; the reading stays.']
  revision_of_id       uuid          [null, note: '⚠️ SET ON A SUPERSEDED VERSION, NULL ON A LIVE READING, AND EVERY QUERY THAT RENDERS A CHART MUST FILTER ON IT.']
  superseded_at        timestamptz   [null, note: 'When this version stopped being the current one. Null on a live reading.']
  superseded_by        uuid          [null, note: 'Who amended it — NOT who took the observation, which stays in `recordedBy`.']
  created_at           timestamptz   [not null, default: `now()`]
  updated_at           timestamptz   [not null, note: 'auto-updated on write']
  deleted_at           timestamptz   [null]

  indexes {
    (organization_id, id) [unique, note: 'Composite-FK target, so a later child (an observation flag, say) is cross-tenant-unrepresentable by construction (ADR-0004).']
    (organization_id, appointment_id, recorded_at) [note: '''The visit's readings, oldest first — how the diagnosis page renders them.''']
    (organization_id, patient_id, recorded_at) [note: 'The trend: every reading for one person, newest first.']
    (organization_id, revision_of_id, superseded_at) [note: '''One reading's earlier versions, oldest first.''']
  }

  Note: 'A set of observations taken for one appointment: the numbers the front desk or the nurse writes down before the doctor is handed the patient. ⚠️ PHI, ALL OF IT. A blood pressure attached to a named person is a clinical record.'
}

Table appointment_status_history {
  id              uuid              [pk, not null, default: `uuid()`]
  organization_id uuid              [not null]
  appointment_id  uuid              [not null]
  from_status     AppointmentStatus [null, note: 'Null only for the row recording the booking itself.']
  to_status       AppointmentStatus [not null]
  changed_by      uuid              [null]
  note            text              [null, note: '⚠️ PHI. Free text a clinician typed. Never audited, never exported.']
  changed_at      timestamptz       [not null, default: `now()`]

  indexes {
    (organization_id, appointment_id, changed_at)
  }

  Note: 'Every status change, in order. Append-only by construction — nothing updates a row here, and the service writes one inside the same transaction as the change it records. WHY A TABLE AND NOT `audit_logs` The clinical questions'
}

// ===== settings-files-audit.prisma =================================

Table setting_definitions {
  key                varchar(128)    [pk, not null]
  module             varchar(64)     [not null]
  data_type          SettingDataType [not null]
  default_value      jsonb           [not null]
  allowed_scopes     jsonb           [not null]
  is_tenant_editable boolean         [not null, default: true]
  description        varchar(512)    [null, note: 'The short human name. What the settings screen puts on the row.']
  help_text          varchar(1024)   [null, note: 'What the setting is for, and what changing it does. Prose, one or two sentences, written for whoever runs the clinic rather than for us.']
  allowed_values     jsonb           [null, note: 'A closed set of choices: `[{ "value": …, "label": … }]`. Null means "any value of `data_type`".']

  indexes {
    module
  }

  Note: 'Adding a new setting is an INSERT here — no migration, no new column. This is a PLATFORM CATALOGUE, not tenant data: no organization_id, no RLS policy, EXEMPT in check-rls.ts. Every clinic reads the same twelve rows.'
}

Table setting_values {
  id          uuid             [pk, not null, default: `uuid()`]
  setting_key varchar(128)     [not null]
  scope_type  SettingScopeType [not null]
  scope_id    uuid             [null, note: 'null only when scopeType = PLATFORM']
  value       jsonb            [not null]
  updated_by  uuid             [null]
  updated_at  timestamptz      [not null, note: 'auto-updated on write']

  indexes {
    (setting_key, scope_type, scope_id) [unique]
    (scope_type, scope_id)
  }

  Note: 'Resolution, most specific wins: USER/PATIENT -> BRANCH -> ORGANIZATION -> PLATFORM -> definition default.'
}

Table files {
  id               uuid           [pk, not null, default: `uuid()`]
  organization_id  uuid           [null]
  branch_id        uuid           [null]
  document_type    DocumentType   [not null, default: 'UPLOAD']
  status           DocumentStatus [not null, default: 'READY']
  storage_provider varchar(16)    [not null, default: 'local', note: 'Which `StorageProvider` implementation holds the bytes — `local` or `s3`. A string rather than an enum: it names an implementation in a package, not a …']
  storage_key      varchar(512)   [unique, not null]
  original_name    varchar(255)   [not null]
  mime_type        varchar(128)   [not null]
  size_bytes       bigint         [not null, default: 0, note: 'Zero until the bytes land. Nullable would be more honest and would also mean every reader handles a null it can do nothing with.']
  checksum         varchar(128)   [null, note: 'Lowercase hex SHA-256, computed by the provider over what it actually wrote — never supplied by the caller. Null until READY.']
  version          smallint       [not null, default: 1, note: '''Bumped when a FAILED document is regenerated. An issued invoice's PDF is immutable (§23), so this only ever moves for a document that never successful …''']
  failure_reason   varchar(500)   [null, note: 'Why rendering failed, for an operator reading logs. ⚠️ Never returned to a client and never allowed to carry PHI — see `document.service.ts`.']
  uploaded_by      uuid           [null]
  uploaded_at      timestamptz    [not null, default: `now()`]
  deleted_at       timestamptz    [null]

  indexes {
    (organization_id, id) [unique, note: 'The composite-FK target (ADR-0004) so a document can be referenced from a tenant table without the reference being able to cross tenants.']
    (organization_id, branch_id)
    (organization_id, document_type, status) [note: '''Finding a tenant's documents of one kind — the invoice list's join, and the sweep that retries FAILED renders.''']
  }

  Note: 'Every document the platform stores, generated or uploaded: the one table `DocumentService` writes to (§31). ⚠️ THE BYTES ARE NOT IN HERE, AND MUST NOT BE (§27). This row is metadata plus a `storage_key`.'
}

Table audit_logs {
  id                      uuid         [pk, not null, default: `uuid()`]
  organization_id         uuid         [null]
  branch_id               uuid         [null]
  actor_user_id           uuid         [null]
  impersonated_by_user_id uuid         [null]
  action                  AuditAction  [not null]
  entity_type             varchar(64)  [not null]
  entity_id               uuid         [null]
  before_data             jsonb        [null]
  after_data              jsonb        [null]
  ip_address              inet         [null]
  user_agent              varchar(512) [null]
  occurred_at             timestamptz  [not null, default: `now()`]

  indexes {
    (organization_id, entity_type, entity_id, occurred_at)
    (actor_user_id, occurred_at)
  }

  Note: 'Written on every mutation by Prisma middleware. Partition by month once this grows — retrofitting partitioning onto a large table is painful.'
}

Table data_access_logs {
  id                      uuid               [pk, not null, default: `uuid()`]
  organization_id         uuid               [not null]
  branch_id               uuid               [null]
  actor_user_id           uuid               [null]
  impersonated_by_user_id uuid               [null]
  patient_id              uuid               [null, note: 'Null when the read resolved no single patient — a search, or a list.']
  access_type             DataAccessType     [not null]
  resource                DataAccessResource [not null]
  resource_id             uuid               [null]
  result_count            integer            [not null, default: 1, note: 'How many records came back. 1 for a detail view.']
  query_hash              char(64)           [null, note: 'SHA-256 of the normalised search term. NEVER the term.']
  route                   varchar(128)       [null, note: 'The matched route pattern, never the URL. See the warning above.']
  ip_address              inet               [null]
  user_agent              varchar(512)       [null]
  occurred_at             timestamptz        [not null, default: `now()`]

  indexes {
    (organization_id, patient_id, occurred_at) [note: '"Who has looked at this patient?" — the subject-access question.']
    (organization_id, actor_user_id, occurred_at) [note: '"What has this member of staff been reading?" — the misuse question.']
  }

  Note: 'Who looked at whose record. The read-side counterpart to `audit_logs`. WHY THIS IS A SEPARATE TABLE AND NOT AN `AuditAction.READ` `audit_logs` answers "what changed", and the per-record history screen already reads it by `(entity_type, entity_id)`.'
}

// ===== subscriptions.prisma ========================================

Table plans {
  id         uuid         [pk, not null, default: `uuid()`]
  code       varchar(64)  [unique, not null]
  name       varchar(255) [not null]
  tagline    varchar(255) [null]
  trial_days smallint     [not null, default: 14]
  is_public  boolean      [not null, default: true]
  sort_order integer      [not null, default: 0]
  created_at timestamptz  [not null, default: `now()`]
  updated_at timestamptz  [not null, note: 'auto-updated on write']
}

Table plan_prices {
  id               uuid            [pk, not null, default: `uuid()`]
  plan_id          uuid            [not null]
  currency         char(3)         [not null, default: 'INR']
  billing_interval BillingInterval [not null]
  amount           decimal(14, 2)  [not null]
  tax_behavior     TaxBehavior     [not null, default: 'EXCLUSIVE', note: 'Whether `amount` already includes tax. See `TaxBehavior`.']
  is_active        boolean         [not null, default: true]

  indexes {
    (plan_id, currency, billing_interval) [unique]
  }
}

Table plan_features {
  id          uuid             [pk, not null, default: `uuid()`]
  plan_id     uuid             [not null]
  feature_key varchar(64)      [not null]
  value_type  FeatureValueType [not null]
  int_value   integer          [null]
  bool_value  boolean          [null]

  indexes {
    (plan_id, feature_key) [unique]
  }

  Note: 'Entitlements. Runtime resolution order: subscription_feature_overrides -> plan_features -> hard default in code.'
}

Table subscriptions {
  id                      uuid               [pk, not null, default: `uuid()`]
  organization_id         uuid               [not null]
  plan_id                 uuid               [not null]
  plan_price_id           uuid               [not null]
  status                  SubscriptionStatus [not null, default: 'TRIALING']
  currency                char(3)            [not null, default: 'INR', note: 'The currency this subscription is billed in, fixed at subscribe time. Denormalised from `plan_prices` on purpose.']
  trial_ends_at           timestamptz        [null]
  current_period_start    timestamptz        [not null]
  current_period_end      timestamptz        [not null]
  cancel_at               timestamptz        [null, note: 'When a scheduled cancellation takes effect. Always `current_period_end` for a cancel-at-period-end; `now()` for an immediate one.']
  canceled_at             timestamptz        [null]
  cancel_at_period_end    boolean            [not null, default: false, note: 'Set the moment the customer asks to cancel; the subscription keeps running and keeps its entitlements until `cancel_at`.']
  cancel_reason           varchar(500)       [null, note: 'Free text from the cancellation form. Never a patient-identifying string.']
  auto_renew              boolean            [not null, default: false, note: 'Whether the renewal engine may debit the mandate unattended. NOT derivable from `mandate_id IS NOT NULL`: a clinic may hold a live mandate and still c …']
  seat_quantity           integer            [not null, default: 1]
  provider                varchar(32)        [null, note: 'The provider that holds the money relationship, once there is one.']
  mandate_id              uuid               [null]
  grace_period_end        timestamptz        [null, note: 'How long access survives a failed renewal. Null outside dunning.']
  dunning_attempts        smallint           [not null, default: 0]
  last_renewal_attempt_at timestamptz        [null]
  started_at              timestamptz        [null, note: 'First successful payment. Null for a subscription still in trial.']
  ended_at                timestamptz        [null]
  created_at              timestamptz        [not null, default: `now()`]
  updated_at              timestamptz        [not null, note: 'auto-updated on write']

  indexes {
    (organization_id, id) [unique]
    (organization_id, status)
    current_period_end
    (status, current_period_end)
  }

  Note: '''What a clinic is paying for, and where it is in the cycle. ⚠️ THE BILLING CLOCK IS OURS, NOT THE PROVIDER'S (ADR-0013). `current_period_end` is the authority on when the next charge happens, and the worker's due-sweep reads it.'''
}

Table subscription_feature_overrides {
  id              uuid         [pk, not null, default: `uuid()`]
  subscription_id uuid         [not null]
  feature_key     varchar(64)  [not null]
  int_value       integer      [null]
  bool_value      boolean      [null]
  reason          varchar(255) [null]
  created_at      timestamptz  [not null, default: `now()`]

  indexes {
    (subscription_id, feature_key) [unique]
  }
}

Table subscription_invoices {
  id              uuid                      [pk, not null, default: `uuid()`]
  organization_id uuid                      [not null]
  subscription_id uuid                      [not null]
  invoice_number  varchar(64)               [unique, not null]
  period_start    date                      [not null]
  period_end      date                      [not null]
  currency        char(3)                   [not null, default: 'INR']
  subtotal        decimal(14, 2)            [not null]
  tax_amount      decimal(14, 2)            [not null, default: 0]
  total           decimal(14, 2)            [not null]
  place_of_supply varchar(10)               [null, note: '''Where this supply was deemed to take place — `IN-KA`, `IE`, `US-CA`. For digital services it is the CUSTOMER's location, not ours, in every regime tha …''']
  tax_treatment   TaxTreatment              [not null, default: 'NOT_REGISTERED', note: 'Why it was taxed the way it was. See `TaxTreatment`.']
  supplier_tax_id varchar(64)               [null, note: 'OUR registration number for that place of supply, as printed. Snapshotted because registrations lapse and change, and a reissued invoice must say what …']
  customer_tax_id varchar(64)               [null, note: 'THEIR identifier, as it stood when the invoice was issued. Both numbers are a legal requirement on a GST invoice and on an EU reverse-charge one.']
  amount_paid     decimal(14, 2)            [not null, default: 0, note: 'Settled so far. A partial payment is a real state — a proration credit can cover part of an upgrade and leave a smaller balance to collect.']
  status          SubscriptionInvoiceStatus [not null, default: 'DRAFT']
  due_date        date                      [null]
  paid_at         timestamptz               [null]
  voided_at       timestamptz               [null]
  attempt_count   smallint                  [not null, default: 0, note: 'How many times collection has been attempted. Drives the dunning schedule.']
  created_at      timestamptz               [not null, default: `now()`]
  updated_at      timestamptz               [not null, note: 'auto-updated on write']

  indexes {
    (organization_id, id) [unique]
    (organization_id, status)
    (subscription_id, created_at)
  }

  Note: 'What was owed for one period. Immutable once issued, in the accounting sense: a mistake is corrected with an adjustment line or a VOID, never by editing the totals of an invoice a customer has already been shown.'
}

Table subscription_invoice_lines {
  id                      uuid            [pk, not null, default: `uuid()`]
  subscription_invoice_id uuid            [not null]
  kind                    InvoiceLineKind [not null, default: 'SUBSCRIPTION', note: 'A prorated upgrade puts a credit and a charge on one invoice. Without this the customer sees two lines of arithmetic and has to work out which is whic …']
  description             varchar(255)    [not null]
  quantity                decimal(14, 3)  [not null, default: 1]
  unit_amount             decimal(14, 2)  [not null]
  line_total              decimal(14, 2)  [not null]
  period_start            date            [null, note: 'The stretch of time this line covers, where it covers one. Null for tax.']
  period_end              date            [null]
  tax_rate_bps            integer         [null, note: 'On a TAX line: the rate applied, in basis points. 18% is 1800. ⚠️ SNAPSHOTTED, NEVER LOOKED UP AGAIN. Rates change by statute.']
  tax_name                varchar(32)     [null, note: '''What the customer's jurisdiction calls it: CGST, SGST, IGST, VAT. Printed as-is, because "Tax" on an Indian invoice is not compliant.''']
  tax_jurisdiction        varchar(10)     [null, note: 'Which authority this line is owed to — `IN-KA`, `IE`. One supply can carry two lines to two authorities; that is exactly what CGST + SGST is.']

  indexes {
    subscription_invoice_id
  }
}

Table subscription_payments {
  id                      uuid           [pk, not null, default: `uuid()`]
  subscription_invoice_id uuid           [not null]
  payment_intent_id       uuid           [null, note: 'The attempt this settles. Null only for a payment recorded by hand.']
  amount                  decimal(14, 2) [not null]
  currency                char(3)        [not null, default: 'INR']
  method                  varchar(32)    [null]
  instrument_label        varchar(32)    [null, note: '''Last four digits, or a UPI handle's domain. NEVER a full instrument.''']
  gateway                 varchar(32)    [null]
  gateway_payment_id      varchar(128)   [null]
  status                  PaymentStatus  [not null, default: 'PENDING']
  failure_code            varchar(64)    [null]
  failure_message         varchar(500)   [null]
  refunded_amount         decimal(14, 2) [not null, default: 0]
  paid_at                 timestamptz    [null]
  created_at              timestamptz    [not null, default: `now()`]

  indexes {
    (gateway, gateway_payment_id) [unique]
    subscription_invoice_id
  }

  Note: 'Money that actually arrived (or did not). One row per attempt, never updated in place from FAILED to SUCCESS — a retry is a new attempt, and collapsing the two loses the fact that the first card was declined.'
}

Table payment_mandates {
  id                  uuid           [pk, not null, default: `uuid()`]
  organization_id     uuid           [not null]
  provider            varchar(32)    [not null]
  provider_mandate_id varchar(128)   [null, note: '''The provider's identifier. Null until the provider has accepted it.''']
  status              MandateStatus  [not null, default: 'PENDING']
  currency            char(3)        [not null]
  max_amount          decimal(14, 2) [not null]
  method              varchar(32)    [null]
  instrument_label    varchar(32)    [null]
  activated_at        timestamptz    [null]
  revoked_at          timestamptz    [null]
  expires_at          timestamptz    [null]
  created_at          timestamptz    [not null, default: `now()`]
  updated_at          timestamptz    [not null, note: 'auto-updated on write']

  indexes {
    (organization_id, id) [unique]
    (provider, provider_mandate_id) [unique]
    (organization_id, status)
  }

  Note: '''A standing authorisation to debit this clinic without anyone present. WHAT IS AND IS NOT STORED HERE The provider's id for the mandate, its ceiling, and a four-digit tail for the customer to recognise it by.'''
}

Table payment_intents {
  id                      uuid                [pk, not null, default: `uuid()`]
  organization_id         uuid                [not null]
  subscription_id         uuid                [null]
  subscription_invoice_id uuid                [null]
  mandate_id              uuid                [null, note: 'Set when this is an off-session debit rather than a hosted checkout.']
  provider                varchar(32)         [not null]
  provider_charge_id      varchar(128)        [null]
  purpose                 PaymentPurpose      [not null]
  status                  PaymentIntentStatus [not null, default: 'CREATED']
  amount                  decimal(14, 2)      [not null]
  currency                char(3)             [not null]
  description             varchar(255)        [not null]
  redirect_url            text                [null, note: 'Where the customer was sent, and where they come back to. Both are URLs on our own hosts; neither carries anything secret, because a browser holds it.']
  return_url              text                [null]
  method                  varchar(32)         [null]
  instrument_label        varchar(32)         [null]
  failure_code            varchar(64)         [null]
  failure_message         varchar(500)        [null]
  settled_at              timestamptz         [null]
  expires_at              timestamptz         [null]
  created_at              timestamptz         [not null, default: `now()`]
  updated_at              timestamptz         [not null, note: 'auto-updated on write']

  indexes {
    (organization_id, id) [unique]
    (provider, provider_charge_id) [unique]
    (organization_id, status)
    subscription_id
  }

  Note: 'One attempt to move money, and the row every webhook is matched back to. WHY THE ROW EXISTS BEFORE THE PROVIDER IS CALLED Its id IS the idempotency key sent to the provider. Creating it first means a call that times out can be retried with the same reference'
}

Table subscription_changes {
  id                      uuid                   [pk, not null, default: `uuid()`]
  organization_id         uuid                   [not null]
  subscription_id         uuid                   [not null]
  change_type             SubscriptionChangeType [not null]
  from_plan_id            uuid                   [null]
  from_plan_price_id      uuid                   [null]
  to_plan_id              uuid                   [null]
  to_plan_price_id        uuid                   [null]
  currency                char(3)                [not null]
  proration_credit        decimal(14, 2)         [not null, default: 0, note: 'Unused time on the old plan, as a positive number.']
  proration_charge        decimal(14, 2)         [not null, default: 0, note: 'Remaining time on the new plan, as a positive number.']
  amount_due              decimal(14, 2)         [not null, default: 0, note: 'charge - credit, floored at zero. We do not refund a downgrade because there is no downgrade (ADR-0014);']
  subscription_invoice_id uuid                   [null]
  effective_at            timestamptz            [not null]
  actor_user_id           uuid                   [null, note: 'Who asked. Null for a change the renewal engine made on its own.']
  reason                  varchar(500)           [null]
  created_at              timestamptz            [not null, default: `now()`]

  indexes {
    (organization_id, subscription_id, created_at)
  }

  Note: '''The commercial history of a subscription: what changed, what it cost, and who asked for it. SEPARATE FROM `audit_logs` ON PURPOSE. That table records that a row's columns changed, which answers a security question. This one answers a billing question — "why was I charged ₹1,832 on the 14th?"'''
}

Table payment_webhook_events {
  id                uuid                    [pk, not null, default: `uuid()`]
  provider          varchar(32)             [not null]
  provider_event_id varchar(255)            [not null, note: '''The provider's own event id, or a hash of the signed bytes when it sends none. See `WebhookEvent.id` in @rcln/payments.''']
  event_type        varchar(64)             [not null]
  reference         varchar(128)            [null, note: 'Our `payment_intents` / `payment_mandates` id, once resolved.']
  organization_id   uuid                    [null, note: 'Resolved after the fact, for the console. Not a scoping column.']
  status            WebhookProcessingStatus [not null, default: 'RECEIVED']
  attempts          smallint                [not null, default: 0]
  error             varchar(1000)           [null]
  payload           jsonb                   [not null, note: '''The provider's payload as received. Retained for reconciliation and the support desk; it contains billing contact details and never patient data.''']
  received_at       timestamptz             [not null, default: `now()`]
  processed_at      timestamptz             [null]

  indexes {
    (provider, provider_event_id) [unique]
    (status, received_at)
    reference
  }

  Note: 'Every webhook delivery we have ever accepted, and what we did with it. ⚠️ DELIBERATELY NOT TENANT-SCOPED, AND THAT IS THE POINT A webhook arrives on a public endpoint with no host, no session and no tenant.'
}

Table usage_counters {
  id              uuid           [pk, not null, default: `uuid()`]
  organization_id uuid           [not null]
  feature_key     varchar(64)    [not null]
  period_start    date           [not null]
  used_value      decimal(14, 2) [not null, default: 0]
  updated_at      timestamptz    [not null, note: 'auto-updated on write']

  indexes {
    (organization_id, feature_key, period_start) [unique]
  }

  Note: 'Enforces plan limits (max_branches, max_users) at write time.'
}

// ===== tax.prisma ==================================================

Table tax_registrations {
  id                  uuid        [pk, not null, default: `uuid()`]
  country_code        char(2)     [not null]
  region_code         varchar(10) [null, note: 'ISO 3166-2 subdivision, without the country prefix. NULL = country-wide.']
  scheme              TaxScheme   [not null]
  registration_number varchar(64) [not null, note: 'Our number in that jurisdiction, printed on every invoice it covers.']
  standard_rate_bps   integer     [not null, note: 'The rate to charge, in basis points, for the digital-services category we sell in. 18% GST is 1800.']
  effective_from      date        [not null, note: 'When this registration took effect. A supply before it is not taxable by us even though the row exists, which matters for the first invoices after reg …']
  effective_to        date        [null, note: 'When it lapsed, if it has. Kept rather than deleted so historical invoices remain explicable.']
  created_at          timestamptz [not null, default: `now()`]
  updated_at          timestamptz [not null, note: 'auto-updated on write']
  deleted_at          timestamptz [null]

  indexes {
    (country_code, region_code, scheme) [unique, note: '`region_code` is nullable, so this needs NULLS NOT DISTINCT to actually constrain the country-wide rows']
    country_code
  }

  Note: 'Where rcln itself is registered to collect tax. ⚠️ THIS TABLE IS THE AUTHORITY ON WHETHER TAX MAY BE CHARGED AT ALL, AND THAT IS A LEGAL QUESTION RATHER THAN AN ARITHMETIC ONE.'
}

Table issuer_tax_registrations {
  id                  uuid         [pk, not null, default: `uuid()`]
  organization_id     uuid         [not null]
  country_code        char(2)      [not null]
  region_code         varchar(10)  [null, note: 'ISO 3166-2 subdivision, without the country prefix. NULL = country-wide.']
  scheme              TaxScheme    [not null]
  registration_number varchar(64)  [not null, note: '''The clinic's number in that jurisdiction, printed on every invoice it covers. Snapshotted onto the invoice at issue, never re-read afterwards.''']
  legal_name          varchar(255) [null, note: 'The name the registration is held in, which is not always the name over the door. A GST invoice must print the registered legal name.']
  effective_from      date         [not null, note: 'When this registration took effect. A supply before it is not taxable by the clinic even though the row exists.']
  effective_to        date         [null, note: 'When it lapsed, if it has. Kept rather than deleted so historical invoices remain explicable.']
  created_at          timestamptz  [not null, default: `now()`]
  updated_at          timestamptz  [not null, note: 'auto-updated on write']
  deleted_at          timestamptz  [null]

  indexes {
    (organization_id, country_code, scheme, registration_number) [unique, note: '⚠️ THE NUMBER, NOT THE JURISDICTION, IS WHAT CANNOT REPEAT. This used to be (organization, country, region, scheme), which read as "one registration p …']
    (organization_id, id) [unique, note: '''Composite-FK target: `invoices` and `issuer_tax_registration_branches` reference (organization_id, id) so neither can point at another tenant's regist …''']
    (organization_id, country_code)
  }

  Note: '''Where a CLINIC is registered to collect tax. The tenant-scoped twin of `tax_registrations`. ⚠️ THIS IS NOT `tax_registrations` AND MUST NEVER BE MERGED WITH IT. That table holds rcln's own numbers and answers "may WE charge this clinic for its subscription?".'''
}

Table issuer_tax_registration_branches {
  id                  uuid        [pk, not null, default: `uuid()`]
  organization_id     uuid        [not null]
  tax_registration_id uuid        [not null]
  branch_id           uuid        [not null]
  created_at          timestamptz [not null, default: `now()`]
  updated_at          timestamptz [not null, note: 'auto-updated on write']
  deleted_at          timestamptz [null]

  indexes {
    (organization_id, tax_registration_id, branch_id) [unique]
    (organization_id, branch_id)
    (organization_id, tax_registration_id)
  }

  Note: 'WHICH BRANCHES A REGISTRATION COVERS. Stated by the clinic, never inferred. ⚠️ THIS TABLE EXISTS BECAUSE COVERAGE IS A BUSINESS FACT AND ADDRESSES ARE NOT EVIDENCE OF IT.'
}

Table tax_rules {
  id                 uuid         [pk, not null, default: `uuid()`]
  organization_id    uuid         [not null]
  country_code       char(2)      [not null]
  region_code        varchar(10)  [null, note: 'ISO 3166-2 subdivision, without the country prefix. NULL = country-wide, which is what almost every GST rate is']
  scheme             TaxScheme    [not null]
  tax_category       varchar(64)  [not null, note: '''The item key. An HSN/SAC code (`999312`, `3004`) or a clinic's own category (`CONSULTATION`). Matched EXACTLY against the item's category''']
  description        varchar(255) [null, note: '''What a human calls it on the rate-configuration screen. Never printed on an invoice — the invoice prints the tax LINE's name (`CGST`), not this.''']
  rate_bps           integer      [not null, note: 'Basis points. 5% is 500. Must be 0 when `treatment` is not STANDARD.']
  treatment          TaxTreatment [not null, default: 'STANDARD']
  line_name          varchar(32)  [not null, note: '⚠️ WHAT THE AUTHORITY CALLS THIS TAX, PRINTED VERBATIM ON THE INVOICE. `GST`, `VAT`, `HST`, `PST`, `QST`, `Sales Tax`.']
  regional_line_name varchar(32)  [null, note: '''The state half's name when `split` is INTRA_STATE_HALVES. NULL derives it from `line_name` (`GST` -> `SGST`), which is right for a state and wrong for …''']
  split              TaxSplit     [not null, default: 'NONE']
  stacks             boolean      [not null, default: false, note: 'Whether this rule applies IN ADDITION to the country-wide rule for the same category, rather than instead of it.']
  effective_from     date         [not null]
  effective_to       date         [null]
  created_at         timestamptz  [not null, default: `now()`]
  updated_at         timestamptz  [not null, note: 'auto-updated on write']
  deleted_at         timestamptz  [null]

  indexes {
    (organization_id, country_code, region_code, scheme, tax_category, effective_from) [unique, note: '⚠️ Needs NULLS NOT DISTINCT, same as the registration above — appended by hand. It stops two rules for one category starting on the same day;']
    (organization_id, id) [unique, note: 'Composite-FK target, so `invoice_taxes` can cite the rule that priced it.']
    (organization_id, tax_category, effective_from) [note: '''The engine's read: every rule for one category, effective-dated.''']
  }

  Note: 'What ONE KIND OF THING is taxed at, here, on this date. ⚠️ THE REASON A RATE CANNOT LIVE ON THE REGISTRATION. `tax_registrations.standard_rate_bps` is one rate per place, which is honest when you sell one product.'
}

Table tax_rule_defaults {
  id                 uuid         [pk, not null, default: `uuid()`]
  country_code       char(2)      [not null]
  region_code        varchar(10)  [null, note: 'ISO 3166-2 subdivision, without the country prefix. NULL = country-wide, which is what almost every published rate is.']
  scheme             TaxScheme    [not null]
  tax_category       varchar(64)  [not null]
  description        varchar(255) [null, note: 'What a human calls it in the platform console. Never printed on an invoice.']
  rate_bps           integer      [not null]
  treatment          TaxTreatment [not null, default: 'STANDARD']
  line_name          varchar(32)  [not null]
  regional_line_name varchar(32)  [null]
  split              TaxSplit     [not null, default: 'NONE']
  stacks             boolean      [not null, default: false]
  source_note        varchar(500) [null, note: '⚠️ WHERE THIS FIGURE CAME FROM, IN WORDS A HUMAN CAN CHECK. A rate with no provenance is a rate nobody can verify, and this table is the one place a w …']
  effective_from     date         [not null]
  effective_to       date         [null]
  created_at         timestamptz  [not null, default: `now()`]
  updated_at         timestamptz  [not null, note: 'auto-updated on write']
  deleted_at         timestamptz  [null]

  indexes {
    (country_code, region_code, scheme, tax_category, effective_from) [unique, note: '⚠️ NULLS NOT DISTINCT, appended by hand — country-wide is the common case here, so without it the table does not constrain its own primary shape.']
    (country_code, tax_category, effective_from)
  }

  Note: '''The rate cards rcln maintains, which every clinic inherits until it says otherwise. The platform-owned twin of `tax_rules`. ⚠️ THE DEFAULTS ARE INHERITED, NEVER COPIED INTO A TENANT. The obvious implementation — seed a clinic's `tax_rules` from this table at registration'''
}

// ===== tenancy.prisma ==============================================

Table organizations {
  id            uuid               [pk, not null, default: `uuid()`]
  slug          varchar(63)        [unique, not null, note: 'Subdomain label. `alpha` -> alpha.xyz.com']
  legal_name    varchar(255)       [not null]
  display_name  varchar(255)       [not null]
  org_type      OrganizationType   [not null, default: 'CLINIC']
  status        OrganizationStatus [not null, default: 'PENDING']
  currency      char(3)            [not null, default: 'INR']
  timezone      varchar(64)        [not null, default: 'Asia/Kolkata']
  country_code  char(2)            [not null, default: 'IN']
  region_code   varchar(10)        [null, note: 'Sub-national jurisdiction, where tax depends on one. `KA` for Karnataka, `CA` for California — the part after the country in ISO 3166-2.']
  tax_id        varchar(32)        [null, note: '''The clinic's own tax identifier, whatever its country calls it — a GSTIN in India, a TRN in the UAE, a VAT number in Ireland, an ABN in Australia.''']
  tax_id_status TaxIdStatus        [not null, default: 'NOT_PROVIDED', note: 'Whether that identifier has been checked against the issuing authority. It decides the TREATMENT, not just data quality: an EU business with a VIES-va …']
  owner_user_id uuid               [null]
  onboarded_at  timestamptz        [null]
  created_at    timestamptz        [not null, default: `now()`]
  updated_at    timestamptz        [not null, note: 'auto-updated on write']
  deleted_at    timestamptz        [null]

  indexes {
    (id, slug) [unique]
    status
    deleted_at
  }

  Note: 'The tenant. A single-location clinic and a 3-branch hospital are the same shape: one organization, one or three branches.'
}

Table organization_domains {
  id                    uuid         [pk, not null, default: `uuid()`]
  organization_id       uuid         [not null]
  domain                varchar(255) [unique, not null]
  is_primary            boolean      [not null, default: false]
  is_platform_subdomain boolean      [not null, default: true]
  verified_at           timestamptz  [null]
  created_at            timestamptz  [not null, default: `now()`]

  indexes {
    organization_id
  }

  Note: 'Every host the tenant is reachable on. The platform subdomain is created at registration; custom domains (portal.pmcs.com) are verified later.'
}

Table branches {
  id              uuid         [pk, not null, default: `uuid()`]
  organization_id uuid         [not null]
  code            varchar(32)  [not null]
  name            varchar(255) [not null]
  branch_type     BranchType   [not null, default: 'CLINIC']
  timezone        varchar(64)  [not null, default: 'Asia/Kolkata']
  phone           varchar(20)  [null]
  email           varchar(255) [null]
  address_line1   varchar(255) [null]
  address_line2   varchar(255) [null]
  city            varchar(100) [null]
  state           varchar(100) [null, note: 'The state as it is printed on an address — "Karnataka". Free text, for humans. `regionCode` is what the tax engine reads;']
  pincode         varchar(10)  [null]
  country_code    char(2)      [not null, default: 'IN', note: '⚠️ WHERE A PATIENT INVOICE RAISED HERE IS DEEMED TO BE SUPPLIED. A clinical service is performed at a place, so the place of supply is the BRANCH']
  region_code     varchar(10)  [null, note: 'ISO 3166-2 subdivision without the country prefix — `KA`, never `IN-KA`. NULL means the country-wide registration applies.']
  tax_id          varchar(32)  [null, note: '⚠️ DEPRECATED AND UNREACHABLE. NOT THE INVOICING AUTHORITY, AND NEVER WAS. `issuer_tax_registrations` plus `issuer_tax_registration_branches` decide w …']
  is_primary      boolean      [not null, default: false]
  status          BranchStatus [not null, default: 'ACTIVE']
  created_at      timestamptz  [not null, default: `now()`]
  updated_at      timestamptz  [not null, note: 'auto-updated on write']
  deleted_at      timestamptz  [null]

  indexes {
    (organization_id, code) [unique]
    (organization_id, id) [unique, note: 'Composite-FK target: children reference (organization_id, id) so a row can never point at a branch belonging to a different tenant.']
    (organization_id, status)
  }

  Note: 'A physical location. PMCS branch A / B / C are three rows here.'
}

Table branch_operating_hours {
  id           uuid     [pk, not null, default: `uuid()`]
  branch_id    uuid     [not null]
  day_of_week  smallint [not null]
  opens_at     time     [not null]
  closes_at    time     [not null]
  is_closed    boolean  [not null, default: false]
  slot_minutes smallint [not null, default: 15]

  indexes {
    (branch_id, day_of_week) [unique]
  }
}

Table branch_closures {
  id           uuid         [pk, not null, default: `uuid()`]
  branch_id    uuid         [not null]
  closure_date date         [not null]
  reason       varchar(255) [null]

  indexes {
    (branch_id, closure_date) [unique]
  }
}

// ---------------------------------------------------------------------------
// RELATIONSHIPS
//   ">"  many-to-one   ·   "-"  one-to-one
// ---------------------------------------------------------------------------

// memberships
Ref: memberships.(organization_id, last_branch_id) > branches.(organization_id, id) [delete: no action, update: no action]  // MembershipLastBranch
Ref: memberships.organization_id > organizations.id [delete: cascade]
Ref: memberships.user_id > users.id [delete: cascade]

// roles
Ref: roles.organization_id > organizations.id [delete: cascade]

// role_permissions
Ref: role_permissions.permission_id > permissions.id [delete: cascade]
Ref: role_permissions.role_id > roles.id [delete: cascade]

// membership_roles
Ref: membership_roles.(organization_id, branch_id) > branches.(organization_id, id) [delete: cascade]
Ref: membership_roles.membership_id > memberships.id [delete: cascade]
Ref: membership_roles.role_id > roles.id [delete: cascade]

// membership_permission_overrides
Ref: membership_permission_overrides.(organization_id, branch_id) > branches.(organization_id, id) [delete: cascade]
Ref: membership_permission_overrides.membership_id > memberships.id [delete: cascade]
Ref: membership_permission_overrides.permission_id > permissions.id [delete: cascade]

// invitations
Ref: invitations.designation_id > designations.id [delete: set null]
Ref: invitations.organization_id > organizations.id [delete: cascade]
Ref: invitations.role_id > roles.id [delete: cascade]
Ref: invitations.invited_by > users.id  // InvitedBy

// invitation_branches
Ref: invitation_branches.branch_id > branches.id [delete: cascade]
Ref: invitation_branches.invitation_id > invitations.id [delete: cascade]

// designations
Ref: designations.organization_id > organizations.id [delete: cascade]

// role_designations
Ref: role_designations.designation_id > designations.id [delete: cascade]
Ref: role_designations.organization_id > organizations.id [delete: cascade]
Ref: role_designations.role_id > roles.id [delete: cascade]

// staff_profiles
Ref: staff_profiles.designation_id > designations.id [delete: set null]
Ref: staff_profiles.membership_id - memberships.id [delete: cascade]

// membership_professional_registrations
Ref: membership_professional_registrations.membership_id > memberships.id [delete: cascade]

// charge_policy_rules
Ref: charge_policy_rules.organization_id > organizations.id [delete: cascade]
Ref: charge_policy_rules.product_id > products.id [delete: restrict]  // ChargePolicyRuleProduct
Ref: charge_policy_rules.product_category_id > product_categories.id [delete: restrict]  // ChargePolicyRuleCategory
Ref: charge_policy_rules.updated_by > users.id [delete: set null]  // ChargePolicyRuleUpdatedBy

// product_prices
Ref: product_prices.(organization_id, branch_id) > branches.(organization_id, id) [delete: cascade]
Ref: product_prices.organization_id > organizations.id [delete: cascade]
Ref: product_prices.product_id > products.id [delete: restrict]  // ProductPriceProduct
Ref: product_prices.unit_id > units_of_measure.id [delete: restrict]  // ProductPriceUnit
Ref: product_prices.updated_by > users.id [delete: set null]  // ProductPriceUpdatedBy

// charge_requests
Ref: charge_requests.(organization_id, branch_id) > branches.(organization_id, id) [delete: cascade]
Ref: charge_requests.(organization_id, policy_rule_id) > charge_policy_rules.(organization_id, id) [delete: restrict, update: no action]
Ref: charge_requests.(organization_id, consumption_line_id) > consumption_lines.(organization_id, id) [delete: cascade]
Ref: charge_requests.(organization_id, dispense_line_id) > dispense_lines.(organization_id, id) [delete: cascade]
Ref: charge_requests.(organization_id, dispense_return_line_id) > dispense_return_lines.(organization_id, id) [delete: cascade]
Ref: charge_requests.(organization_id, invoice_id) > invoices.(organization_id, id) [delete: restrict]
Ref: charge_requests.organization_id > organizations.id [delete: cascade]
Ref: charge_requests.(organization_id, patient_id) > patients.(organization_id, id) [delete: restrict]
Ref: charge_requests.product_id > products.id [delete: restrict]  // ChargeRequestProduct
Ref: charge_requests.unit_id > units_of_measure.id [delete: restrict]  // ChargeRequestUnit
Ref: charge_requests.decided_by_id > users.id [delete: set null]  // ChargeRequestDecidedBy

// clinical_master_items
Ref: clinical_master_items.parent_id > clinical_master_items.id [delete: restrict]  // ClinicalMasterParent
Ref: clinical_master_items.organization_id > organizations.id [delete: cascade]

// clinical_master_codings
Ref: clinical_master_codings.(organization_id, item_id) > clinical_master_items.(organization_id, id) [delete: cascade]
Ref: clinical_master_codings.organization_id > organizations.id [delete: cascade]

// clinical_master_scopes
Ref: clinical_master_scopes.(organization_id, item_id) > clinical_master_items.(organization_id, id) [delete: cascade]
Ref: clinical_master_scopes.organization_id > organizations.id [delete: cascade]
Ref: clinical_master_scopes.specialty_id > specialties.id [delete: restrict]

// product_clinical_scopes
Ref: product_clinical_scopes.organization_id > organizations.id [delete: cascade]
Ref: product_clinical_scopes.(organization_id, product_id) > products.(organization_id, id) [delete: cascade]
Ref: product_clinical_scopes.specialty_id > specialties.id [delete: restrict]

// clinical_episodes
Ref: clinical_episodes.organization_id > organizations.id [delete: cascade]
Ref: clinical_episodes.(organization_id, patient_id) > patients.(organization_id, id) [delete: cascade]
Ref: clinical_episodes.primary_specialty_id > specialties.id [delete: restrict]
Ref: clinical_episodes.opened_by > users.id [delete: set null]  // EpisodeOpenedBy
Ref: clinical_episodes.closed_by > users.id [delete: set null]  // EpisodeClosedBy

// animal_profiles
Ref: animal_profiles.organization_id > organizations.id [delete: cascade]
Ref: animal_profiles.(organization_id, patient_id) - patients.(organization_id, id) [delete: cascade]

// encounter_follow_up_recommendations
Ref: encounter_follow_up_recommendations.(organization_id, appointment_id) > appointments.(organization_id, id) [delete: cascade]  // RecommendationSource
Ref: encounter_follow_up_recommendations.(organization_id, fulfilled_by_appointment_id) > appointments.(organization_id, id) [delete: restrict, update: no action]  // RecommendationFulfilment
Ref: encounter_follow_up_recommendations.(organization_id, branch_id) > branches.(organization_id, id) [delete: cascade]
Ref: encounter_follow_up_recommendations.(organization_id, encounter_id) > encounters.(organization_id, id) [delete: cascade]
Ref: encounter_follow_up_recommendations.organization_id > organizations.id [delete: cascade]
Ref: encounter_follow_up_recommendations.(organization_id, patient_id) > patients.(organization_id, id) [delete: cascade]
Ref: encounter_follow_up_recommendations.cancelled_by > users.id [delete: set null]  // RecommendationCancelledBy

// consultation_templates
Ref: consultation_templates.organization_id > organizations.id [delete: cascade]
Ref: consultation_templates.care_context_id > specialties.id [delete: restrict]  // TemplateCareContext
Ref: consultation_templates.specialty_id > specialties.id [delete: restrict]  // TemplateSpecialty

// consultation_template_versions
Ref: consultation_template_versions.(organization_id, template_id) > consultation_templates.(organization_id, id) [delete: cascade]
Ref: consultation_template_versions.organization_id > organizations.id [delete: cascade]
Ref: consultation_template_versions.published_by > users.id [delete: set null]  // TemplateVersionPublishedBy

// encounters
Ref: encounters.(organization_id, appointment_id) > appointments.(organization_id, id) [delete: restrict, update: no action]
Ref: encounters.(organization_id, branch_id) > branches.(organization_id, id) [delete: cascade]
Ref: encounters.(organization_id, clinical_episode_id) > clinical_episodes.(organization_id, id) [delete: restrict]
Ref: encounters.template_id > consultation_templates.id [delete: restrict]
Ref: encounters.template_version_id > consultation_template_versions.id [delete: restrict]
Ref: encounters.(organization_id, doctor_profile_id) > doctor_profiles.(organization_id, id) [delete: restrict]
Ref: encounters.(organization_id, amends_encounter_id) > encounters.(organization_id, id) [delete: restrict, update: no action]  // EncounterAmendment
Ref: encounters.organization_id > organizations.id [delete: cascade]
Ref: encounters.(organization_id, patient_id) > patients.(organization_id, id) [delete: cascade]
Ref: encounters.finalized_by > users.id [delete: restrict]  // EncounterFinalizedBy
Ref: encounters.cancelled_by > users.id [delete: set null]  // EncounterCancelledBy

// encounter_sections
Ref: encounter_sections.(organization_id, branch_id) > branches.(organization_id, id) [delete: cascade]
Ref: encounter_sections.(organization_id, encounter_id) > encounters.(organization_id, id) [delete: cascade]
Ref: encounter_sections.organization_id > organizations.id [delete: cascade]

// encounter_symptoms
Ref: encounter_symptoms.(organization_id, branch_id) > branches.(organization_id, id) [delete: cascade]
Ref: encounter_symptoms.item_id > clinical_master_items.id [delete: restrict]  // SymptomItem
Ref: encounter_symptoms.(organization_id, encounter_id) > encounters.(organization_id, id) [delete: cascade]
Ref: encounter_symptoms.organization_id > organizations.id [delete: cascade]

// encounter_diagnoses
Ref: encounter_diagnoses.(organization_id, branch_id) > branches.(organization_id, id) [delete: cascade]
Ref: encounter_diagnoses.item_id > clinical_master_items.id [delete: restrict]  // DiagnosisItem
Ref: encounter_diagnoses.(organization_id, encounter_id) > encounters.(organization_id, id) [delete: cascade]
Ref: encounter_diagnoses.organization_id > organizations.id [delete: cascade]

// encounter_procedures
Ref: encounter_procedures.(organization_id, branch_id) > branches.(organization_id, id) [delete: cascade]
Ref: encounter_procedures.item_id > clinical_master_items.id [delete: restrict]  // ProcedureItem
Ref: encounter_procedures.(organization_id, encounter_id) > encounters.(organization_id, id) [delete: cascade]
Ref: encounter_procedures.(organization_id, diagnosis_id) > encounter_diagnoses.(organization_id, id) [delete: restrict, update: no action]
Ref: encounter_procedures.organization_id > organizations.id [delete: cascade]
Ref: encounter_procedures.visual_region_id > visual_regions.id [delete: restrict]  // ProcedureRegion

// encounter_prescriptions
Ref: encounter_prescriptions.(organization_id, branch_id) > branches.(organization_id, id) [delete: cascade]
Ref: encounter_prescriptions.(organization_id, encounter_id) > encounters.(organization_id, id) [delete: cascade]
Ref: encounter_prescriptions.organization_id > organizations.id [delete: cascade]
Ref: encounter_prescriptions.product_id > products.id [delete: restrict]

// encounter_investigations
Ref: encounter_investigations.(organization_id, branch_id) > branches.(organization_id, id) [delete: cascade]
Ref: encounter_investigations.item_id > clinical_master_items.id [delete: restrict]  // InvestigationItem
Ref: encounter_investigations.(organization_id, encounter_id) > encounters.(organization_id, id) [delete: cascade]
Ref: encounter_investigations.organization_id > organizations.id [delete: cascade]

// encounter_advice
Ref: encounter_advice.(organization_id, branch_id) > branches.(organization_id, id) [delete: cascade]
Ref: encounter_advice.item_id > clinical_master_items.id [delete: restrict]  // AdviceItem
Ref: encounter_advice.(organization_id, encounter_id) > encounters.(organization_id, id) [delete: cascade]
Ref: encounter_advice.organization_id > organizations.id [delete: cascade]

// encounter_referrals
Ref: encounter_referrals.(organization_id, branch_id) > branches.(organization_id, id) [delete: cascade]
Ref: encounter_referrals.(organization_id, doctor_profile_id) > doctor_profiles.(organization_id, id) [delete: restrict, update: no action]  // ReferralDoctor
Ref: encounter_referrals.(organization_id, encounter_id) > encounters.(organization_id, id) [delete: cascade]
Ref: encounter_referrals.organization_id > organizations.id [delete: cascade]
Ref: encounter_referrals.specialty_id > specialties.id [delete: restrict]  // ReferralSpecialty

// encounter_attachments
Ref: encounter_attachments.(organization_id, branch_id) > branches.(organization_id, id) [delete: cascade]
Ref: encounter_attachments.(organization_id, encounter_id) > encounters.(organization_id, id) [delete: cascade]
Ref: encounter_attachments.organization_id > organizations.id [delete: cascade]
Ref: encounter_attachments.(organization_id, stored_file_id) > files.(organization_id, id) [delete: restrict, update: no action]

// visual_maps
Ref: visual_maps.organization_id > organizations.id [delete: cascade]
Ref: visual_maps.care_context_id > specialties.id [delete: restrict]  // VisualMapCareContext
Ref: visual_maps.specialty_id > specialties.id [delete: restrict]  // VisualMapSpecialty

// visual_regions
Ref: visual_regions.organization_id > organizations.id [delete: cascade]
Ref: visual_regions.(organization_id, map_id) > visual_maps.(organization_id, id) [delete: cascade]
Ref: visual_regions.parent_id > visual_regions.id [delete: restrict]  // VisualRegionParent

// clinical_findings
Ref: clinical_findings.(organization_id, branch_id) > branches.(organization_id, id) [delete: cascade]
Ref: clinical_findings.finding_item_id > clinical_master_items.id [delete: restrict]  // FindingItem
Ref: clinical_findings.(organization_id, encounter_id) > encounters.(organization_id, id) [delete: cascade]
Ref: clinical_findings.(organization_id, diagnosis_id) > encounter_diagnoses.(organization_id, id) [delete: restrict, update: no action]
Ref: clinical_findings.organization_id > organizations.id [delete: cascade]
Ref: clinical_findings.visual_region_id > visual_regions.id [delete: restrict]

// consumption_templates
Ref: consumption_templates.item_id > clinical_master_items.id [delete: restrict]  // ConsumptionTemplateItem
Ref: consumption_templates.organization_id > organizations.id [delete: cascade]
Ref: consumption_templates.updated_by > users.id [delete: set null]  // ConsumptionTemplateUpdatedBy

// consumption_template_lines
Ref: consumption_template_lines.(organization_id, template_id) > consumption_templates.(organization_id, id) [delete: cascade]
Ref: consumption_template_lines.organization_id > organizations.id [delete: cascade]
Ref: consumption_template_lines.product_id > products.id [delete: restrict]  // ConsumptionTemplateLineProduct
Ref: consumption_template_lines.unit_id > units_of_measure.id [delete: restrict]  // ConsumptionTemplateLineUnit

// clinical_consumptions
Ref: clinical_consumptions.(organization_id, branch_id) > branches.(organization_id, id) [delete: cascade]
Ref: clinical_consumptions.(organization_id, corrects_consumption_id) > clinical_consumptions.(organization_id, id) [delete: restrict, update: no action]  // ConsumptionCorrects
Ref: clinical_consumptions.(organization_id, template_id) > consumption_templates.(organization_id, id) [delete: restrict]
Ref: clinical_consumptions.(organization_id, encounter_id) > encounters.(organization_id, id) [delete: restrict]
Ref: clinical_consumptions.(organization_id, encounter_procedure_id) > encounter_procedures.(organization_id, id) [delete: restrict]
Ref: clinical_consumptions.(organization_id, branch_id, location_id) > inventory_locations.(organization_id, branch_id, id) [delete: restrict]  // ConsumptionLocation
Ref: clinical_consumptions.organization_id > organizations.id [delete: cascade]
Ref: clinical_consumptions.(organization_id, patient_id) > patients.(organization_id, id) [delete: restrict]
Ref: clinical_consumptions.recorded_by_id > users.id [delete: restrict]  // ConsumptionRecordedBy
Ref: clinical_consumptions.amended_by_id > users.id [delete: restrict]  // ConsumptionAmendedBy

// consumption_lines
Ref: consumption_lines.(organization_id, branch_id) > branches.(organization_id, id) [delete: cascade]
Ref: consumption_lines.(organization_id, consumption_id) > clinical_consumptions.(organization_id, id) [delete: cascade]
Ref: consumption_lines.(organization_id, template_line_id) > consumption_template_lines.(organization_id, id) [delete: restrict]
Ref: consumption_lines.organization_id > organizations.id [delete: cascade]
Ref: consumption_lines.product_id > products.id [delete: restrict]  // ConsumptionLineProduct
Ref: consumption_lines.unit_id > units_of_measure.id [delete: restrict]  // ConsumptionLineUnit

// consumption_allocations
Ref: consumption_allocations.(organization_id, branch_id, batch_id) > batches.(organization_id, branch_id, id) [delete: restrict]  // ConsumptionAllocationBatch
Ref: consumption_allocations.(organization_id, branch_id) > branches.(organization_id, id) [delete: cascade]
Ref: consumption_allocations.(organization_id, consumption_line_id) > consumption_lines.(organization_id, id) [delete: cascade]
Ref: consumption_allocations.(organization_id, branch_id, location_id) > inventory_locations.(organization_id, branch_id, id) [delete: restrict]  // ConsumptionAllocationLocation
Ref: consumption_allocations.organization_id > organizations.id [delete: cascade]
Ref: consumption_allocations.(organization_id, branch_id, serial_id) > serials.(organization_id, branch_id, id) [delete: restrict]  // ConsumptionAllocationSerial

// specialties
Ref: specialties.organization_id > organizations.id [delete: cascade]
Ref: specialties.parent_id > specialties.id [delete: restrict]  // SpecialtyParent

// qualifications
Ref: qualifications.organization_id > organizations.id [delete: cascade]

// doctor_profiles
Ref: doctor_profiles.organization_id > organizations.id [delete: cascade]
Ref: doctor_profiles.user_id > users.id [delete: cascade]

// doctor_specialties
Ref: doctor_specialties.doctor_profile_id > doctor_profiles.id [delete: cascade]
Ref: doctor_specialties.organization_id > organizations.id [delete: cascade]
Ref: doctor_specialties.specialty_id > specialties.id [delete: restrict]

// doctor_qualifications
Ref: doctor_qualifications.doctor_profile_id > doctor_profiles.id [delete: cascade]
Ref: doctor_qualifications.organization_id > organizations.id [delete: cascade]
Ref: doctor_qualifications.qualification_id > qualifications.id [delete: restrict]

// doctor_branch_settings
Ref: doctor_branch_settings.branch_id > branches.id [delete: cascade]
Ref: doctor_branch_settings.doctor_profile_id > doctor_profiles.id [delete: cascade]
Ref: doctor_branch_settings.organization_id > organizations.id [delete: cascade]

// fee_schedule_entries
Ref: fee_schedule_entries.(organization_id, branch_id) > branches.(organization_id, id) [delete: cascade]
Ref: fee_schedule_entries.(organization_id, doctor_profile_id) > doctor_profiles.(organization_id, id) [delete: cascade]
Ref: fee_schedule_entries.organization_id > organizations.id [delete: cascade]

// doctor_compensation
Ref: doctor_compensation.(organization_id, doctor_profile_id) - doctor_profiles.(organization_id, id) [delete: cascade]
Ref: doctor_compensation.organization_id > organizations.id [delete: cascade]

// doctor_schedules
Ref: doctor_schedules.branch_id > branches.id [delete: cascade]
Ref: doctor_schedules.doctor_profile_id > doctor_profiles.id [delete: cascade]
Ref: doctor_schedules.organization_id > organizations.id [delete: cascade]

// doctor_schedule_exceptions
Ref: doctor_schedule_exceptions.branch_id > branches.id [delete: cascade]
Ref: doctor_schedule_exceptions.doctor_profile_id > doctor_profiles.id [delete: cascade]
Ref: doctor_schedule_exceptions.organization_id > organizations.id [delete: cascade]

// users
Ref: users.last_platform_organization_id > organizations.id [delete: set null]  // PlatformAdminLastOrganization

// user_identities
Ref: user_identities.user_id > users.id [delete: cascade]

// sessions
Ref: sessions.active_branch_id > branches.id [delete: set null]
Ref: sessions.user_id > users.id [delete: cascade]

// auth_tokens
Ref: auth_tokens.user_id > users.id [delete: cascade]

// inventory_locations
Ref: inventory_locations.(organization_id, branch_id) > branches.(organization_id, id) [delete: cascade]
Ref: inventory_locations.organization_id > organizations.id [delete: cascade]
Ref: inventory_locations.storage_profile_id > storage_requirement_profiles.id [delete: restrict]

// storage_areas
Ref: storage_areas.(organization_id, branch_id) > branches.(organization_id, id) [delete: cascade]
Ref: storage_areas.(organization_id, branch_id, location_id) > inventory_locations.(organization_id, branch_id, id) [delete: cascade]
Ref: storage_areas.organization_id > organizations.id [delete: cascade]

// storage_bins
Ref: storage_bins.(organization_id, branch_id) > branches.(organization_id, id) [delete: cascade]
Ref: storage_bins.organization_id > organizations.id [delete: cascade]
Ref: storage_bins.(organization_id, area_id) > storage_areas.(organization_id, id) [delete: cascade]

// batches
Ref: batches.(organization_id, branch_id) > branches.(organization_id, id) [delete: cascade]
Ref: batches.manufacturer_id > manufacturers.id [delete: restrict]
Ref: batches.organization_id > organizations.id [delete: cascade]
Ref: batches.product_id > products.id [delete: restrict]

// serials
Ref: serials.(organization_id, branch_id, batch_id) > batches.(organization_id, branch_id, id) [delete: restrict]
Ref: serials.(organization_id, branch_id) > branches.(organization_id, id) [delete: cascade]
Ref: serials.(organization_id, branch_id, current_location_id) > inventory_locations.(organization_id, branch_id, id) [delete: restrict]
Ref: serials.organization_id > organizations.id [delete: cascade]
Ref: serials.(organization_id, assigned_patient_id) > patients.(organization_id, id) [delete: restrict]
Ref: serials.product_id > products.id [delete: restrict]

// stock_ledger
Ref: stock_ledger.(organization_id, branch_id, batch_id) > batches.(organization_id, branch_id, id) [delete: restrict]
Ref: stock_ledger.(organization_id, branch_id) > branches.(organization_id, id) [delete: cascade]
Ref: stock_ledger.(organization_id, branch_id, from_location_id) > inventory_locations.(organization_id, branch_id, id) [delete: restrict]  // MovementFromLocation
Ref: stock_ledger.(organization_id, branch_id, to_location_id) > inventory_locations.(organization_id, branch_id, id) [delete: restrict]  // MovementToLocation
Ref: stock_ledger.organization_id > organizations.id [delete: cascade]
Ref: stock_ledger.product_id > products.id [delete: restrict]
Ref: stock_ledger.(organization_id, branch_id, serial_id) > serials.(organization_id, branch_id, id) [delete: restrict]
Ref: stock_ledger.unit_id > units_of_measure.id [delete: restrict]
Ref: stock_ledger.actor_user_id > users.id [delete: restrict]

// stock_balances
Ref: stock_balances.(organization_id, branch_id, batch_id) > batches.(organization_id, branch_id, id) [delete: restrict]
Ref: stock_balances.(organization_id, branch_id) > branches.(organization_id, id) [delete: cascade]
Ref: stock_balances.(organization_id, branch_id, location_id) > inventory_locations.(organization_id, branch_id, id) [delete: restrict]
Ref: stock_balances.organization_id > organizations.id [delete: cascade]
Ref: stock_balances.product_id > products.id [delete: restrict]
Ref: stock_balances.(organization_id, branch_id, serial_id) > serials.(organization_id, branch_id, id) [delete: restrict]

// stock_reason_codes
Ref: stock_reason_codes.organization_id > organizations.id [delete: cascade]

// stock_transfers
Ref: stock_transfers.(organization_id, from_branch_id) > branches.(organization_id, id) [delete: cascade]  // TransferFromBranch
Ref: stock_transfers.(organization_id, to_branch_id) > branches.(organization_id, id) [delete: cascade]  // TransferToBranch
Ref: stock_transfers.(organization_id, from_branch_id, from_location_id) > inventory_locations.(organization_id, branch_id, id) [delete: restrict]  // TransferFromLocation
Ref: stock_transfers.(organization_id, to_branch_id, to_location_id) > inventory_locations.(organization_id, branch_id, id) [delete: restrict]  // TransferToLocation
Ref: stock_transfers.organization_id > organizations.id [delete: cascade]
Ref: stock_transfers.created_by_id > users.id [delete: restrict]  // TransferCreatedBy
Ref: stock_transfers.dispatched_by_id > users.id [delete: restrict]  // TransferDispatchedBy
Ref: stock_transfers.received_by_id > users.id [delete: restrict]  // TransferReceivedBy
Ref: stock_transfers.cancelled_by_id > users.id [delete: restrict]  // TransferCancelledBy

// stock_transfer_lines
Ref: stock_transfer_lines.(organization_id, batch_id) > batches.(organization_id, id) [delete: restrict]  // TransferLineSourceBatch
Ref: stock_transfer_lines.(organization_id, destination_batch_id) > batches.(organization_id, id) [delete: restrict]  // TransferLineDestinationBatch
Ref: stock_transfer_lines.manufacturer_id > manufacturers.id [delete: restrict]  // TransferLineManufacturer
Ref: stock_transfer_lines.organization_id > organizations.id [delete: cascade]
Ref: stock_transfer_lines.product_id > products.id [delete: restrict]
Ref: stock_transfer_lines.(organization_id, serial_id) > serials.(organization_id, id) [delete: restrict]  // TransferLineSerial
Ref: stock_transfer_lines.(organization_id, transfer_id) > stock_transfers.(organization_id, id) [delete: cascade]
Ref: stock_transfer_lines.unit_id > units_of_measure.id [delete: restrict]  // TransferLineUnit

// stock_reservations
Ref: stock_reservations.(organization_id, branch_id, batch_id) > batches.(organization_id, branch_id, id) [delete: restrict]
Ref: stock_reservations.(organization_id, branch_id) > branches.(organization_id, id) [delete: cascade]
Ref: stock_reservations.(organization_id, branch_id, location_id) > inventory_locations.(organization_id, branch_id, id) [delete: restrict]
Ref: stock_reservations.organization_id > organizations.id [delete: cascade]
Ref: stock_reservations.product_id > products.id [delete: restrict]
Ref: stock_reservations.(organization_id, branch_id, serial_id) > serials.(organization_id, branch_id, id) [delete: restrict]
Ref: stock_reservations.created_by_id > users.id [delete: restrict]  // ReservationCreatedBy
Ref: stock_reservations.released_by_id > users.id [delete: restrict]  // ReservationReleasedBy

// invoices
Ref: invoices.(organization_id, appointment_id) > appointments.(organization_id, id) [delete: restrict, update: no action]
Ref: invoices.(organization_id, branch_id) > branches.(organization_id, id) [delete: cascade]
Ref: invoices.(organization_id, practitioner_profile_id) > doctor_profiles.(organization_id, id) [delete: restrict, update: no action]  // InvoicePractitioner
Ref: invoices.(organization_id, credited_invoice_id) > invoices.(organization_id, id) [delete: restrict, update: no action]  // InvoiceCreditNote
Ref: invoices.(organization_id, issuer_tax_registration_id) > issuer_tax_registrations.(organization_id, id) [delete: restrict, update: no action]
Ref: invoices.organization_id > organizations.id [delete: cascade]
Ref: invoices.(organization_id, patient_id) > patients.(organization_id, id) [delete: restrict]
Ref: invoices.created_by > users.id [delete: set null]  // InvoiceCreatedBy
Ref: invoices.issued_by > users.id [delete: set null]  // InvoiceIssuedBy
Ref: invoices.cancelled_by > users.id [delete: set null]  // InvoiceCancelledBy

// invoice_items
Ref: invoice_items.(organization_id, branch_id) > branches.(organization_id, id) [delete: cascade]
Ref: invoice_items.(organization_id, invoice_id) > invoices.(organization_id, id) [delete: cascade]
Ref: invoice_items.(organization_id, credited_invoice_item_id) > invoice_items.(organization_id, id) [delete: restrict, update: no action]  // InvoiceItemCredit
Ref: invoice_items.organization_id > organizations.id [delete: cascade]

// invoice_taxes
Ref: invoice_taxes.(organization_id, branch_id) > branches.(organization_id, id) [delete: cascade]
Ref: invoice_taxes.(organization_id, invoice_id) > invoices.(organization_id, id) [delete: cascade]
Ref: invoice_taxes.(organization_id, invoice_item_id) > invoice_items.(organization_id, id) [delete: cascade, update: no action]
Ref: invoice_taxes.organization_id > organizations.id [delete: cascade]
Ref: invoice_taxes.(organization_id, tax_rule_id) > tax_rules.(organization_id, id) [delete: restrict, update: no action]
Ref: invoice_taxes.tax_rule_default_id > tax_rule_defaults.id [delete: restrict]

// invoice_documents
Ref: invoice_documents.(organization_id, branch_id) > branches.(organization_id, id) [delete: cascade]
Ref: invoice_documents.(organization_id, invoice_id) > invoices.(organization_id, id) [delete: cascade]
Ref: invoice_documents.organization_id > organizations.id [delete: cascade]
Ref: invoice_documents.file_id > files.id [delete: restrict]
Ref: invoice_documents.generated_by > users.id [delete: set null]  // InvoiceDocumentGeneratedBy

// number_sequences
Ref: number_sequences.organization_id > organizations.id [delete: cascade]

// patients
Ref: patients.organization_id > organizations.id [delete: cascade]
Ref: patients.(organization_id, merged_into_id) > patients.(organization_id, id) [delete: restrict]  // PatientMerge
Ref: patients.user_id > users.id [delete: set null]

// patient_registrations
Ref: patient_registrations.(organization_id, branch_id) > branches.(organization_id, id) [delete: cascade]
Ref: patient_registrations.organization_id > organizations.id [delete: cascade]
Ref: patient_registrations.(organization_id, patient_id) > patients.(organization_id, id) [delete: cascade]
Ref: patient_registrations.registered_by > users.id [delete: set null]  // PatientRegisteredBy

// patient_addresses
Ref: patient_addresses.organization_id > organizations.id [delete: cascade]
Ref: patient_addresses.(organization_id, patient_id) > patients.(organization_id, id) [delete: cascade]

// patient_contacts
Ref: patient_contacts.organization_id > organizations.id [delete: cascade]
Ref: patient_contacts.(organization_id, patient_id) > patients.(organization_id, id) [delete: cascade]

// patient_allergies
Ref: patient_allergies.organization_id > organizations.id [delete: cascade]
Ref: patient_allergies.(organization_id, patient_id) > patients.(organization_id, id) [delete: cascade]
Ref: patient_allergies.noted_by > users.id [delete: set null]  // AllergyNotedBy

// patient_conditions
Ref: patient_conditions.organization_id > organizations.id [delete: cascade]
Ref: patient_conditions.(organization_id, patient_id) > patients.(organization_id, id) [delete: cascade]
Ref: patient_conditions.noted_by > users.id [delete: set null]  // ConditionNotedBy

// patient_medications
Ref: patient_medications.organization_id > organizations.id [delete: cascade]
Ref: patient_medications.(organization_id, patient_id) > patients.(organization_id, id) [delete: cascade]
Ref: patient_medications.noted_by > users.id [delete: set null]  // MedicationNotedBy

// prescription_fulfilments
Ref: prescription_fulfilments.(organization_id, branch_id) > branches.(organization_id, id) [delete: cascade]
Ref: prescription_fulfilments.(organization_id, encounter_id) - encounters.(organization_id, id) [delete: cascade]
Ref: prescription_fulfilments.organization_id > organizations.id [delete: cascade]
Ref: prescription_fulfilments.verified_by_id > users.id [delete: restrict]  // PrescriptionFulfilmentVerifiedBy
Ref: prescription_fulfilments.cancelled_by_id > users.id [delete: restrict]  // PrescriptionFulfilmentCancelledBy

// dispenses
Ref: dispenses.(organization_id, branch_id) > branches.(organization_id, id) [delete: cascade]
Ref: dispenses.(organization_id, encounter_id) > encounters.(organization_id, id) [delete: restrict]
Ref: dispenses.(organization_id, branch_id, location_id) > inventory_locations.(organization_id, branch_id, id) [delete: restrict]  // DispenseLocation
Ref: dispenses.organization_id > organizations.id [delete: cascade]
Ref: dispenses.(organization_id, patient_id) > patients.(organization_id, id) [delete: restrict]
Ref: dispenses.dispensed_by_id > users.id [delete: restrict]  // DispenseDispensedBy

// dispense_lines
Ref: dispense_lines.(organization_id, branch_id) > branches.(organization_id, id) [delete: cascade]
Ref: dispense_lines.(organization_id, dispense_id) > dispenses.(organization_id, id) [delete: cascade]
Ref: dispense_lines.(organization_id, encounter_prescription_id) > encounter_prescriptions.(organization_id, id) [delete: restrict]
Ref: dispense_lines.organization_id > organizations.id [delete: cascade]
Ref: dispense_lines.product_id > products.id [delete: restrict]  // DispenseLineProduct
Ref: dispense_lines.substituted_for_product_id > products.id [delete: restrict]  // DispenseLineSubstitutedFor
Ref: dispense_lines.(organization_id, regulatory_decision_id) > regulatory_decisions.(organization_id, id) [delete: restrict]
Ref: dispense_lines.unit_id > units_of_measure.id [delete: restrict]  // DispenseLineUnit

// dispense_allocations
Ref: dispense_allocations.(organization_id, branch_id, batch_id) > batches.(organization_id, branch_id, id) [delete: restrict]  // DispenseAllocationBatch
Ref: dispense_allocations.(organization_id, branch_id) > branches.(organization_id, id) [delete: cascade]
Ref: dispense_allocations.(organization_id, dispense_line_id) > dispense_lines.(organization_id, id) [delete: cascade]
Ref: dispense_allocations.(organization_id, branch_id, location_id) > inventory_locations.(organization_id, branch_id, id) [delete: restrict]  // DispenseAllocationLocation
Ref: dispense_allocations.organization_id > organizations.id [delete: cascade]
Ref: dispense_allocations.(organization_id, branch_id, serial_id) > serials.(organization_id, branch_id, id) [delete: restrict]  // DispenseAllocationSerial

// dispense_returns
Ref: dispense_returns.(organization_id, branch_id) > branches.(organization_id, id) [delete: cascade]
Ref: dispense_returns.(organization_id, dispense_id) > dispenses.(organization_id, id) [delete: restrict]
Ref: dispense_returns.(organization_id, branch_id, location_id) > inventory_locations.(organization_id, branch_id, id) [delete: restrict]  // DispenseReturnLocation
Ref: dispense_returns.organization_id > organizations.id [delete: cascade]
Ref: dispense_returns.(organization_id, regulatory_decision_id) > regulatory_decisions.(organization_id, id) [delete: restrict]
Ref: dispense_returns.received_by_id > users.id [delete: restrict]  // DispenseReturnReceivedBy

// dispense_return_lines
Ref: dispense_return_lines.(organization_id, branch_id) > branches.(organization_id, id) [delete: cascade]
Ref: dispense_return_lines.(organization_id, dispense_allocation_id) > dispense_allocations.(organization_id, id) [delete: restrict]
Ref: dispense_return_lines.(organization_id, dispense_line_id) > dispense_lines.(organization_id, id) [delete: restrict]
Ref: dispense_return_lines.(organization_id, dispense_return_id) > dispense_returns.(organization_id, id) [delete: cascade]
Ref: dispense_return_lines.organization_id > organizations.id [delete: cascade]

// suppliers
Ref: suppliers.organization_id > organizations.id [delete: cascade]

// supplier_tax_identifiers
Ref: supplier_tax_identifiers.organization_id > organizations.id [delete: cascade]
Ref: supplier_tax_identifiers.(organization_id, supplier_id) > suppliers.(organization_id, id) [delete: cascade]

// supplier_products
Ref: supplier_products.organization_id > organizations.id [delete: cascade]
Ref: supplier_products.product_id > products.id [delete: restrict]
Ref: supplier_products.(organization_id, supplier_id) > suppliers.(organization_id, id) [delete: cascade]
Ref: supplier_products.pack_unit_id > units_of_measure.id [delete: restrict]  // SupplierProductPackUnit

// purchase_requisitions
Ref: purchase_requisitions.(organization_id, branch_id) > branches.(organization_id, id) [delete: cascade]
Ref: purchase_requisitions.organization_id > organizations.id [delete: cascade]
Ref: purchase_requisitions.created_by_id > users.id [delete: restrict]  // RequisitionCreatedBy
Ref: purchase_requisitions.submitted_by_id > users.id [delete: restrict]  // RequisitionSubmittedBy
Ref: purchase_requisitions.approved_by_id > users.id [delete: restrict]  // RequisitionApprovedBy
Ref: purchase_requisitions.rejected_by_id > users.id [delete: restrict]  // RequisitionRejectedBy
Ref: purchase_requisitions.cancelled_by_id > users.id [delete: restrict]  // RequisitionCancelledBy

// purchase_requisition_lines
Ref: purchase_requisition_lines.(organization_id, branch_id) > branches.(organization_id, id) [delete: cascade]
Ref: purchase_requisition_lines.organization_id > organizations.id [delete: cascade]
Ref: purchase_requisition_lines.product_id > products.id [delete: restrict]
Ref: purchase_requisition_lines.(organization_id, requisition_id) > purchase_requisitions.(organization_id, id) [delete: cascade]
Ref: purchase_requisition_lines.(organization_id, suggested_supplier_id) > suppliers.(organization_id, id) [delete: restrict]
Ref: purchase_requisition_lines.unit_id > units_of_measure.id [delete: restrict]  // RequisitionLineUnit

// purchase_orders
Ref: purchase_orders.(organization_id, branch_id) > branches.(organization_id, id) [delete: cascade]
Ref: purchase_orders.(organization_id, branch_id, deliver_to_location_id) > inventory_locations.(organization_id, branch_id, id) [delete: restrict]  // PurchaseOrderDeliverTo
Ref: purchase_orders.organization_id > organizations.id [delete: cascade]
Ref: purchase_orders.(organization_id, requisition_id) > purchase_requisitions.(organization_id, id) [delete: restrict]
Ref: purchase_orders.(organization_id, supplier_id) > suppliers.(organization_id, id) [delete: restrict]
Ref: purchase_orders.created_by_id > users.id [delete: restrict]  // PurchaseOrderCreatedBy
Ref: purchase_orders.issued_by_id > users.id [delete: restrict]  // PurchaseOrderIssuedBy
Ref: purchase_orders.closed_by_id > users.id [delete: restrict]  // PurchaseOrderClosedBy
Ref: purchase_orders.cancelled_by_id > users.id [delete: restrict]  // PurchaseOrderCancelledBy

// purchase_order_lines
Ref: purchase_order_lines.(organization_id, branch_id) > branches.(organization_id, id) [delete: cascade]
Ref: purchase_order_lines.organization_id > organizations.id [delete: cascade]
Ref: purchase_order_lines.product_id > products.id [delete: restrict]
Ref: purchase_order_lines.(organization_id, purchase_order_id) > purchase_orders.(organization_id, id) [delete: cascade]
Ref: purchase_order_lines.(organization_id, supplier_product_id) > supplier_products.(organization_id, id) [delete: restrict]
Ref: purchase_order_lines.unit_id > units_of_measure.id [delete: restrict]  // PurchaseOrderLineUnit

// goods_receipts
Ref: goods_receipts.(organization_id, branch_id) > branches.(organization_id, id) [delete: cascade]
Ref: goods_receipts.(organization_id, branch_id, location_id) > inventory_locations.(organization_id, branch_id, id) [delete: restrict]  // GoodsReceiptLocation
Ref: goods_receipts.organization_id > organizations.id [delete: cascade]
Ref: goods_receipts.(organization_id, purchase_order_id) > purchase_orders.(organization_id, id) [delete: restrict]
Ref: goods_receipts.(organization_id, supplier_id) > suppliers.(organization_id, id) [delete: restrict]
Ref: goods_receipts.created_by_id > users.id [delete: restrict]  // GoodsReceiptCreatedBy
Ref: goods_receipts.posted_by_id > users.id [delete: restrict]  // GoodsReceiptPostedBy
Ref: goods_receipts.cancelled_by_id > users.id [delete: restrict]  // GoodsReceiptCancelledBy

// goods_receipt_lines
Ref: goods_receipt_lines.(organization_id, branch_id, batch_id) > batches.(organization_id, branch_id, id) [delete: restrict]  // GoodsReceiptLineBatch
Ref: goods_receipt_lines.(organization_id, branch_id) > branches.(organization_id, id) [delete: cascade]
Ref: goods_receipt_lines.(organization_id, goods_receipt_id) > goods_receipts.(organization_id, id) [delete: cascade]
Ref: goods_receipt_lines.manufacturer_id > manufacturers.id [delete: restrict]  // GoodsReceiptLineManufacturer
Ref: goods_receipt_lines.organization_id > organizations.id [delete: cascade]
Ref: goods_receipt_lines.product_id > products.id [delete: restrict]
Ref: goods_receipt_lines.(organization_id, purchase_order_line_id) > purchase_order_lines.(organization_id, id) [delete: restrict]
Ref: goods_receipt_lines.(organization_id, branch_id, serial_id) > serials.(organization_id, branch_id, id) [delete: restrict]  // GoodsReceiptLineSerial
Ref: goods_receipt_lines.unit_id > units_of_measure.id [delete: restrict]  // GoodsReceiptLineUnit
Ref: goods_receipt_lines.quality_decided_by_id > users.id [delete: restrict]  // GoodsReceiptLineQualityDecidedBy

// purchase_returns
Ref: purchase_returns.(organization_id, branch_id) > branches.(organization_id, id) [delete: cascade]
Ref: purchase_returns.(organization_id, goods_receipt_id) > goods_receipts.(organization_id, id) [delete: restrict]
Ref: purchase_returns.(organization_id, branch_id, location_id) > inventory_locations.(organization_id, branch_id, id) [delete: restrict]  // PurchaseReturnLocation
Ref: purchase_returns.organization_id > organizations.id [delete: cascade]
Ref: purchase_returns.(organization_id, supplier_id) > suppliers.(organization_id, id) [delete: restrict]
Ref: purchase_returns.created_by_id > users.id [delete: restrict]  // PurchaseReturnCreatedBy
Ref: purchase_returns.sent_by_id > users.id [delete: restrict]  // PurchaseReturnSentBy
Ref: purchase_returns.cancelled_by_id > users.id [delete: restrict]  // PurchaseReturnCancelledBy

// purchase_return_lines
Ref: purchase_return_lines.(organization_id, branch_id, batch_id) > batches.(organization_id, branch_id, id) [delete: restrict]  // PurchaseReturnLineBatch
Ref: purchase_return_lines.(organization_id, branch_id) > branches.(organization_id, id) [delete: cascade]
Ref: purchase_return_lines.(organization_id, goods_receipt_line_id) > goods_receipt_lines.(organization_id, id) [delete: restrict]
Ref: purchase_return_lines.organization_id > organizations.id [delete: cascade]
Ref: purchase_return_lines.product_id > products.id [delete: restrict]
Ref: purchase_return_lines.(organization_id, purchase_return_id) > purchase_returns.(organization_id, id) [delete: cascade]
Ref: purchase_return_lines.(organization_id, branch_id, serial_id) > serials.(organization_id, branch_id, id) [delete: restrict]  // PurchaseReturnLineSerial
Ref: purchase_return_lines.unit_id > units_of_measure.id [delete: restrict]  // PurchaseReturnLineUnit

// product_cost_averages
Ref: product_cost_averages.(organization_id, branch_id) > branches.(organization_id, id) [delete: cascade]
Ref: product_cost_averages.organization_id > organizations.id [delete: cascade]
Ref: product_cost_averages.product_id > products.id [delete: restrict]

// units_of_measure
Ref: units_of_measure.organization_id > organizations.id [delete: cascade]

// unit_conversions
Ref: unit_conversions.organization_id > organizations.id [delete: cascade]
Ref: unit_conversions.from_unit_id > units_of_measure.id [delete: restrict]  // ConversionFromUnit
Ref: unit_conversions.to_unit_id > units_of_measure.id [delete: restrict]  // ConversionToUnit

// product_categories
Ref: product_categories.organization_id > organizations.id [delete: cascade]
Ref: product_categories.parent_id > product_categories.id [delete: restrict]  // ProductCategoryParent

// manufacturers
Ref: manufacturers.organization_id > organizations.id [delete: cascade]

// active_ingredients
Ref: active_ingredients.organization_id > organizations.id [delete: cascade]

// compositions
Ref: compositions.organization_id > organizations.id [delete: cascade]

// composition_ingredients
Ref: composition_ingredients.ingredient_id > active_ingredients.id [delete: restrict]
Ref: composition_ingredients.(organization_id, composition_id) > compositions.(organization_id, id) [delete: cascade]
Ref: composition_ingredients.organization_id > organizations.id [delete: cascade]
Ref: composition_ingredients.strength_unit_id > units_of_measure.id [delete: restrict]  // IngredientStrengthUnit

// storage_requirement_profiles
Ref: storage_requirement_profiles.organization_id > organizations.id [delete: cascade]

// products
Ref: products.composition_id > compositions.id [delete: restrict]
Ref: products.manufacturer_id > manufacturers.id [delete: restrict]
Ref: products.organization_id > organizations.id [delete: cascade]
Ref: products.category_id > product_categories.id [delete: restrict]
Ref: products.storage_profile_id > storage_requirement_profiles.id [delete: restrict]
Ref: products.base_unit_id > units_of_measure.id [delete: restrict]  // ProductBaseUnit

// product_packagings
Ref: product_packagings.organization_id > organizations.id [delete: cascade]
Ref: product_packagings.(organization_id, product_id) > products.(organization_id, id) [delete: cascade]
Ref: product_packagings.unit_id > units_of_measure.id [delete: restrict]

// product_identifiers
Ref: product_identifiers.organization_id > organizations.id [delete: cascade]
Ref: product_identifiers.(organization_id, product_id) > products.(organization_id, id) [delete: cascade]

// product_tax_classifications
Ref: product_tax_classifications.organization_id > organizations.id [delete: cascade]
Ref: product_tax_classifications.(organization_id, product_id) > products.(organization_id, id) [delete: cascade]

// medicine_details
Ref: medicine_details.organization_id > organizations.id [delete: cascade]
Ref: medicine_details.(organization_id, product_id) - products.(organization_id, id) [delete: cascade]

// recalls
Ref: recalls.organization_id > organizations.id [delete: cascade]
Ref: recalls.product_id > products.id [delete: restrict]  // RecallProduct
Ref: recalls.raised_by_id > users.id [delete: restrict]  // RecallRaisedBy
Ref: recalls.executed_by_id > users.id [delete: restrict]  // RecallExecutedBy
Ref: recalls.closed_by_id > users.id [delete: restrict]  // RecallClosedBy

// recall_batches
Ref: recall_batches.(organization_id, branch_id, batch_id) > batches.(organization_id, branch_id, id) [delete: restrict]  // RecallBatchBatch
Ref: recall_batches.(organization_id, branch_id) > branches.(organization_id, id) [delete: cascade]
Ref: recall_batches.organization_id > organizations.id [delete: cascade]
Ref: recall_batches.(organization_id, recall_id) > recalls.(organization_id, id) [delete: cascade]

// regulatory_authorities
Ref: regulatory_authorities.jurisdiction_id > jurisdictions.id [delete: restrict]

// regulatory_sources
Ref: regulatory_sources.jurisdiction_id > jurisdictions.id [delete: restrict]
Ref: regulatory_sources.authority_id > regulatory_authorities.id [delete: restrict]

// regulatory_rule_packs
Ref: regulatory_rule_packs.jurisdiction_id > jurisdictions.id [delete: restrict]
Ref: regulatory_rule_packs.authority_id > regulatory_authorities.id [delete: restrict]
Ref: regulatory_rule_packs.reviewed_by_user_id > users.id [delete: set null]  // RulePackReviewer

// regulatory_rules
Ref: regulatory_rules.applies_to_category_id > product_categories.id [delete: restrict]  // RegulatoryRuleCategory
Ref: regulatory_rules.pack_id > regulatory_rule_packs.id [delete: cascade]
Ref: regulatory_rules.source_id > regulatory_sources.id [delete: restrict]

// product_regulatory_profiles
Ref: product_regulatory_profiles.jurisdiction_id > jurisdictions.id [delete: restrict]
Ref: product_regulatory_profiles.organization_id > organizations.id [delete: cascade]
Ref: product_regulatory_profiles.(organization_id, product_id) > products.(organization_id, id) [delete: cascade]

// regulatory_decisions
Ref: regulatory_decisions.(organization_id, branch_id) > branches.(organization_id, id) [delete: cascade]
Ref: regulatory_decisions.organization_id > organizations.id [delete: cascade]
Ref: regulatory_decisions.product_id > products.id [delete: restrict]
Ref: regulatory_decisions.actor_user_id > users.id [delete: restrict]  // RegulatoryDecisionActor

// appointments
Ref: appointments.(organization_id, parent_appointment_id) > appointments.(organization_id, id) [delete: restrict, update: no action]  // AppointmentFollowUp
Ref: appointments.(organization_id, branch_id) > branches.(organization_id, id) [delete: cascade]
Ref: appointments.(organization_id, clinical_episode_id) > clinical_episodes.(organization_id, id) [delete: restrict]
Ref: appointments.(organization_id, doctor_profile_id) > doctor_profiles.(organization_id, id) [delete: restrict]
Ref: appointments.organization_id > organizations.id [delete: cascade]
Ref: appointments.(organization_id, patient_id) > patients.(organization_id, id) [delete: cascade]
Ref: appointments.(organization_id, patient_registration_id) > patient_registrations.(organization_id, id) [delete: cascade]
Ref: appointments.booked_by > users.id [delete: set null]  // AppointmentBookedBy
Ref: appointments.cancelled_by > users.id [delete: set null]  // AppointmentCancelledBy

// appointment_reschedules
Ref: appointment_reschedules.(organization_id, appointment_id) > appointments.(organization_id, id) [delete: cascade]
Ref: appointment_reschedules.(organization_id, branch_id) > branches.(organization_id, id) [delete: cascade]
Ref: appointment_reschedules.organization_id > organizations.id [delete: cascade]

// appointment_vitals
Ref: appointment_vitals.(organization_id, appointment_id) > appointments.(organization_id, id) [delete: cascade]
Ref: appointment_vitals.(organization_id, revision_of_id) > appointment_vitals.(organization_id, id) [delete: cascade]  // VitalRevisions
Ref: appointment_vitals.(organization_id, branch_id) > branches.(organization_id, id) [delete: cascade]
Ref: appointment_vitals.organization_id > organizations.id [delete: cascade]
Ref: appointment_vitals.(organization_id, patient_id) > patients.(organization_id, id) [delete: cascade]
Ref: appointment_vitals.recorded_by > users.id [delete: set null]  // VitalRecordedBy
Ref: appointment_vitals.superseded_by > users.id [delete: set null]  // VitalSupersededBy

// appointment_status_history
Ref: appointment_status_history.(organization_id, appointment_id) > appointments.(organization_id, id) [delete: cascade]
Ref: appointment_status_history.organization_id > organizations.id [delete: cascade]
Ref: appointment_status_history.changed_by > users.id [delete: set null]  // AppointmentStatusChangedBy

// setting_values
Ref: setting_values.setting_key > setting_definitions.key [delete: cascade]

// files
Ref: files.organization_id > organizations.id [delete: cascade]
Ref: files.uploaded_by > users.id [delete: set null]

// audit_logs
Ref: audit_logs.organization_id > organizations.id [delete: cascade]
Ref: audit_logs.actor_user_id > users.id [delete: set null]

// data_access_logs
Ref: data_access_logs.organization_id > organizations.id [delete: cascade]
Ref: data_access_logs.actor_user_id > users.id [delete: set null]

// plan_prices
Ref: plan_prices.plan_id > plans.id [delete: cascade]

// plan_features
Ref: plan_features.plan_id > plans.id [delete: cascade]

// subscriptions
Ref: subscriptions.organization_id > organizations.id [delete: cascade]
Ref: subscriptions.(organization_id, mandate_id) > payment_mandates.(organization_id, id) [delete: no action, update: no action]
Ref: subscriptions.plan_id > plans.id
Ref: subscriptions.plan_price_id > plan_prices.id

// subscription_feature_overrides
Ref: subscription_feature_overrides.subscription_id > subscriptions.id [delete: cascade]

// subscription_invoices
Ref: subscription_invoices.organization_id > organizations.id [delete: cascade]
Ref: subscription_invoices.subscription_id > subscriptions.id [delete: cascade]

// subscription_invoice_lines
Ref: subscription_invoice_lines.subscription_invoice_id > subscription_invoices.id [delete: cascade]

// subscription_payments
Ref: subscription_payments.payment_intent_id > payment_intents.id [delete: set null]
Ref: subscription_payments.subscription_invoice_id > subscription_invoices.id [delete: cascade]

// payment_mandates
Ref: payment_mandates.organization_id > organizations.id [delete: cascade]

// payment_intents
Ref: payment_intents.organization_id > organizations.id [delete: cascade]
Ref: payment_intents.(organization_id, mandate_id) > payment_mandates.(organization_id, id) [delete: no action, update: no action]
Ref: payment_intents.(organization_id, subscription_id) > subscriptions.(organization_id, id) [delete: cascade]
Ref: payment_intents.(organization_id, subscription_invoice_id) > subscription_invoices.(organization_id, id) [delete: cascade]

// subscription_changes
Ref: subscription_changes.organization_id > organizations.id [delete: cascade]
Ref: subscription_changes.(organization_id, subscription_id) > subscriptions.(organization_id, id) [delete: cascade]
Ref: subscription_changes.(organization_id, subscription_invoice_id) > subscription_invoices.(organization_id, id) [delete: no action, update: no action]

// usage_counters
Ref: usage_counters.organization_id > organizations.id [delete: cascade]

// issuer_tax_registrations
Ref: issuer_tax_registrations.organization_id > organizations.id [delete: cascade]

// issuer_tax_registration_branches
Ref: issuer_tax_registration_branches.(organization_id, branch_id) > branches.(organization_id, id) [delete: cascade]
Ref: issuer_tax_registration_branches.(organization_id, tax_registration_id) > issuer_tax_registrations.(organization_id, id) [delete: cascade]
Ref: issuer_tax_registration_branches.organization_id > organizations.id [delete: cascade]

// tax_rules
Ref: tax_rules.organization_id > organizations.id [delete: cascade]

// organizations
Ref: organizations.owner_user_id > users.id [delete: set null]  // OrganizationOwner

// organization_domains
Ref: organization_domains.organization_id > organizations.id [delete: cascade]

// branches
Ref: branches.organization_id > organizations.id [delete: cascade]

// branch_operating_hours
Ref: branch_operating_hours.branch_id > branches.id [delete: cascade]

// branch_closures
Ref: branch_closures.branch_id > branches.id [delete: cascade]

// ---------------------------------------------------------------------------
// TABLE GROUPS (one per schema file / domain)
// ---------------------------------------------------------------------------

TableGroup access_control {
  memberships
  roles
  permissions
  role_permissions
  membership_roles
  membership_permission_overrides
  invitations
  invitation_branches
  designations
  role_designations
  staff_profiles
  membership_professional_registrations
}

TableGroup charging {
  charge_policy_rules
  product_prices
  charge_requests
}

TableGroup clinical {
  clinical_master_items
  clinical_master_codings
  clinical_master_scopes
  product_clinical_scopes
  clinical_episodes
  animal_profiles
  encounter_follow_up_recommendations
  consultation_templates
  consultation_template_versions
  encounters
  encounter_sections
  encounter_symptoms
  encounter_diagnoses
  encounter_procedures
  encounter_prescriptions
  encounter_investigations
  encounter_advice
  encounter_referrals
  encounter_attachments
  visual_maps
  visual_regions
  clinical_findings
}

TableGroup consumption {
  consumption_templates
  consumption_template_lines
  clinical_consumptions
  consumption_lines
  consumption_allocations
}

TableGroup doctors {
  specialties
  qualifications
  doctor_profiles
  doctor_specialties
  doctor_qualifications
  doctor_branch_settings
  fee_schedule_entries
  doctor_compensation
  doctor_schedules
  doctor_schedule_exceptions
}

TableGroup identity {
  users
  user_identities
  sessions
  auth_tokens
}

TableGroup inventory {
  inventory_locations
  storage_areas
  storage_bins
  batches
  serials
  stock_ledger
  stock_balances
  stock_reason_codes
  stock_transfers
  stock_transfer_lines
  stock_reservations
}

TableGroup invoicing {
  invoices
  invoice_items
  invoice_taxes
  invoice_documents
}

TableGroup marketing {
  demo_requests
}

TableGroup numbering {
  number_sequences
}

TableGroup patients {
  patients
  patient_registrations
  patient_addresses
  patient_contacts
  patient_allergies
  patient_conditions
  patient_medications
}

TableGroup pharmacy {
  prescription_fulfilments
  dispenses
  dispense_lines
  dispense_allocations
  dispense_returns
  dispense_return_lines
}

TableGroup procurement {
  suppliers
  supplier_tax_identifiers
  supplier_products
  purchase_requisitions
  purchase_requisition_lines
  purchase_orders
  purchase_order_lines
  goods_receipts
  goods_receipt_lines
  purchase_returns
  purchase_return_lines
  product_cost_averages
}

TableGroup products {
  units_of_measure
  unit_conversions
  product_categories
  manufacturers
  active_ingredients
  compositions
  composition_ingredients
  storage_requirement_profiles
  products
  product_packagings
  product_identifiers
  product_tax_classifications
  medicine_details
}

TableGroup recall {
  recalls
  recall_batches
}

TableGroup regulatory {
  jurisdictions
  regulatory_authorities
  regulatory_sources
  regulatory_rule_packs
  regulatory_rules
  product_regulatory_profiles
  regulatory_decisions
}

TableGroup scheduling {
  appointments
  appointment_reschedules
  appointment_vitals
  appointment_status_history
}

TableGroup settings_files_audit {
  setting_definitions
  setting_values
  files
  audit_logs
  data_access_logs
}

TableGroup subscriptions {
  plans
  plan_prices
  plan_features
  subscriptions
  subscription_feature_overrides
  subscription_invoices
  subscription_invoice_lines
  subscription_payments
  payment_mandates
  payment_intents
  subscription_changes
  payment_webhook_events
  usage_counters
}

TableGroup tax {
  tax_registrations
  issuer_tax_registrations
  issuer_tax_registration_branches
  tax_rules
  tax_rule_defaults
}

TableGroup tenancy {
  organizations
  organization_domains
  branches
  branch_operating_hours
  branch_closures
}
