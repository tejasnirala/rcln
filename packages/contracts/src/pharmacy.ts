/**
 * Pharmacy: the queue, the counter, and what went out of it (PI-7).
 *
 * `products.ts` says what a thing IS, `inventory.ts` says where it is,
 * `procurement.ts` says how it got there — and this is what happens when it
 * leaves, into somebody's hand.
 *
 * ── WHAT THIS SURFACE DELIBERATELY CANNOT DO ────────────────────────────────
 * There is no field below through which a caller could:
 *
 *   write or amend a prescription      invariant 7 — the dispensary READS the
 *                                      clinical record and writes only beside it
 *   state a price, a rate or a tax     PI-ADR-005/006 — pharmacy owns no money;
 *                                      billing arrives in PI-8 through a charge
 *                                      request, never an invoice line written here
 *   state a signed or base quantity    the server converts through the one
 *                                      `toBaseUnits` the ledger uses, and the
 *                                      SIGN is a property of `DISPENSING`
 *   assert its own regulatory answer   the client never sends a decision back;
 *                                      the service asks the engine at the moment
 *                                      of acting and snapshots what it said
 *   assert that repeats were endorsed  read off the prescription, not ticked at
 *                                      the counter (see `@rcln/regulatory`'s
 *                                      `PresentedPrescription`)
 *
 * ── PHI IS EVERYWHERE ON THIS SURFACE, WHICH IS WHY IT IS MARKED ────────────
 * A queue row names a patient. A prescription detail is clinical content. A
 * dispense says which medicine a named person was given on which day. Every
 * READ of these shapes writes a `data_access_logs` row — one per request, never
 * per result row — and that row carries ids, enums and counts and NEVER a
 * patient name or a medicine name.
 *
 * ⚠️ AND NOTHING HERE MAY BE PUT IN A URL QUERY PARAMETER, A COOKIE OR
 *   `localStorage` BY A CLIENT. The list filters below take ids, which is why
 *   there is a `patientId` filter and no `patientName` one.
 */
import { z } from 'zod';
import { uuid } from './common.js';
import { decimalString } from './products.js';
import { positiveQuantity } from './inventory.js';
import { rulePackMaturity } from './regulatory.js';

// ---------------------------------------------------------------------------
// Vocabulary — mirrors the Prisma enums in pharmacy.prisma
// ---------------------------------------------------------------------------

export const prescriptionFulfilmentStatus = z.enum([
  'NEW',
  'VERIFIED',
  'PARTIALLY_DISPENSED',
  'COMPLETED',
  'CANCELLED',
]);

/**
 * ⚠️ `ONLINE` IS THE THIRD CHANNEL AND NOT A THIRD ANSWER TO "WAS THERE A
 *   PRESCRIPTION" (PI-12). Whether one was presented is `encounterId` being
 *   null or not, on every kind. See the enum comment in `pharmacy.prisma`.
 */
export const dispenseKind = z.enum(['PRESCRIPTION', 'COUNTER_SALE', 'ONLINE']);

export const dispenseStatus = z.enum(['DISPENSED', 'PARTIALLY_RETURNED', 'RETURNED']);

export const dispenseReturnDisposition = z.enum(['RESTOCKED', 'QUARANTINED']);

/** The page shape every list response below shares. */
const listMeta = z.object({
  page: z.number().int(),
  limit: z.number().int(),
  total: z.number().int(),
  totalPages: z.number().int(),
});

const documentPage = {
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
};

// ---------------------------------------------------------------------------
// What the counter is told about the law
// ---------------------------------------------------------------------------

/**
 * The regulatory answer, as a PHARMACIST reads it.
 *
 * ⚠️ DELIBERATELY NARROWER THAN `RegulatoryDecisionResponse`, AND THE MISSING
 *   FIELDS ARE THE POINT. There is no rule id here, no pack id and no pack
 *   version, because FRONTEND_ARCHITECTURE.md says the dispensing workspace must
 *   never show engine internals: a warning reads "Schedule H — pharmacist
 *   verification required", not "rule REG-IN-0042 v3 returned DENY". The
 *   internals are on the regulatory screens, for the person whose job they are,
 *   and the full decision is snapshotted in `regulatory_decisions` regardless of
 *   what any screen renders.
 *
 * ⚠️ `messages` ARE THE RULES' OWN SENTENCES, VERBATIM. `regulatory_rules
 *   .statement` is written to be read by the person who is refused and says what
 *   to DO; a summary composed here would lose that and drift from what the
 *   regulatory console shows for the same rule.
 */
export const dispenseRegulatorySummary = z.object({
  outcome: z.enum(['PERMITTED', 'PERMITTED_WITH_CONDITIONS', 'REFUSED', 'UNDETERMINED']),
  /** One per rule that did not simply permit. Rendered verbatim. */
  messages: z.array(z.string()),
  /**
   * ⚠️ AN OBLIGATION, NEVER A WARNING. `PERMITTED_WITH_CONDITIONS` means the
   *   supply is lawful ONLY if these are done — a screen that renders them as
   *   advisory text has produced an unlawful dispense with a clean audit trail.
   */
  conditions: z.array(z.object({ kind: z.string(), detail: z.string() })),
  /**
   * The weakest maturity of any pack that contributed, or null when none did
   * (PI-ADR-009). What the "nobody has reviewed these rules" banner reads.
   */
  lowestPackMaturity: rulePackMaturity.nullable(),
  /**
   * Did this answer actually gate the act? Only a `PRODUCTION_ENABLED` pack
   * enforces — see `services/regulatory/enforcement.ts`. A screen that implies a
   * refusal stopped something when it did not is lying in the safe-looking
   * direction.
   */
  wasEnforced: z.boolean(),
});

// ---------------------------------------------------------------------------
// The queue (PI-7.1)
// ---------------------------------------------------------------------------

export const prescriptionQueueQuery = z.object({
  ...documentPage,
  /** Which counter is asking. Defaults to the branch the request is acting on. */
  branchId: uuid.optional(),
  status: prescriptionFulfilmentStatus.optional(),
  patientId: uuid.optional(),
  /**
   * ⚠️ AN ID, NOT A NAME, AND THERE IS NO FREE-TEXT PATIENT SEARCH ON THIS
   *   SURFACE. Searching for a person by name belongs on the patient search
   *   endpoint, which logs a SEARCH access with a hashed term and is never
   *   deduplicated — repeatedly looking somebody up is itself the signal.
   */
  encounterId: uuid.optional(),
  /** Consultations from this day onward, in the branch's own reckoning. */
  from: z.iso.date().optional(),
  to: z.iso.date().optional(),
});

export const prescriptionQueueItem = z.object({
  encounterId: uuid,
  encounterNumber: z.string().nullable(),
  branchId: uuid,
  branchName: z.string(),
  /** When the consultation happened. The queue sorts oldest-first on it. */
  startedAt: z.iso.datetime(),
  /** When the doctor SIGNED it. ⚠️ A draft consultation is not a prescription. */
  finalizedAt: z.iso.datetime().nullable(),
  /** ⚠️ PHI. The counter has to call somebody's name. */
  patientId: uuid,
  patientName: z.string(),
  patientUhid: z.string(),
  prescriberName: z.string().nullable(),
  status: prescriptionFulfilmentStatus,
  verifiedAt: z.iso.datetime().nullable(),
  /** How many prescribed lines, and how many are fully supplied. */
  itemCount: z.number().int(),
  completedItemCount: z.number().int(),
});

export const prescriptionQueueResponse = z.object({
  items: z.array(prescriptionQueueItem),
  meta: listMeta,
});

/**
 * One prescribed line, as the dispensary sees it.
 *
 * ⚠️ READ-ONLY, AND EVERY FIELD IS THE PRESCRIBER'S. Nothing on this shape has a
 *   write path anywhere in pharmacy. `dispensedQuantityBase` is the one number
 *   the dispensary contributed and it is DERIVED from `dispense_lines` rather
 *   than stored on the clinical row — pharmacy does not write a column on a
 *   prescription, not even a progress one.
 */
export const pharmacyPrescriptionItem = z.object({
  id: uuid,
  productId: uuid,
  productName: z.string(),
  /** Whether it is stocked at all. An advice-only item is not dispensable. */
  isStockItem: z.boolean(),
  /**
   * ⚠️ THE ID AS WELL AS THE SYMBOL, BECAUSE THE WORKSPACE COUNTS IN BASE UNITS
   *   AND HAS TO SAY SO ON THE WAY BACK. A supply line names the unit its
   *   quantity was entered in; a screen that had only the symbol would have to
   *   look the unit up by name, which is how two units called "tab" become one.
   */
  baseUnitId: uuid,
  baseUnitSymbol: z.string(),
  strength: z.string().nullable(),
  dose: decimalString.nullable(),
  doseUnit: z.string().nullable(),
  route: z.string().nullable(),
  frequency: z.number().int().nullable(),
  frequencyUnit: z.string().nullable(),
  durationValue: z.number().int().nullable(),
  durationUnit: z.string().nullable(),
  foodRelation: z.string().nullable(),
  timing: z.string().nullable(),
  isPrn: z.boolean(),
  /** ⚠️ PHI. What the prescriber wrote for the patient to read. */
  instructions: z.string().nullable(),
  /** What was prescribed, in the product's base unit. Null when not stated. */
  quantityBase: decimalString.nullable(),
  /** What has already gone out against it, net of returns. */
  dispensedQuantityBase: decimalString,
  /** `quantity - dispensed`, floored at zero. Null when no quantity was stated. */
  outstandingQuantityBase: decimalString.nullable(),
  /** How much is on the shelf at this branch, AVAILABLE and unexpired. */
  availableQuantityBase: decimalString,
});

export const pharmacyPrescriptionDetail = z.object({
  encounterId: uuid,
  encounterNumber: z.string().nullable(),
  branchId: uuid,
  branchName: z.string(),
  startedAt: z.iso.datetime(),
  finalizedAt: z.iso.datetime().nullable(),
  /**
   * ⚠️ A DRAFT CONSULTATION IS NOT A PRESCRIPTION. `FINALIZED` is the doctor
   *   having signed it; `AMENDED` means a later consultation supersedes this one
   *   and dispensing against it would supply what was corrected.
   */
  encounterStatus: z.enum(['DRAFT', 'FINALIZED', 'AMENDED', 'CANCELLED']),
  /** Is it dispensable at all? False for a draft, an amended or a cancelled one. */
  isDispensable: z.boolean(),
  /** ⚠️ PHI, all four. */
  patientId: uuid,
  patientName: z.string(),
  patientUhid: z.string(),
  patientAgeYears: z.number().int().nullable(),
  patientSubjectType: z.enum(['HUMAN', 'ANIMAL']),
  /**
   * The animal's species, when there is one (PI-11).
   *
   * ⚠️ NULL FOR EVERY HUMAN, AND ALSO NULL FOR AN ANIMAL WITH NO PROFILE ROW —
   *   the two are not distinguishable here and do not need to be, because the
   *   screen renders `patientSubjectType` for the first distinction and this
   *   only refines it. Reading "Dog" beside a name is the difference between a
   *   pharmacist checking a veterinary label and not knowing there is one to
   *   check.
   */
  patientSpecies: z.string().nullable(),
  prescriberName: z.string().nullable(),
  prescriberRegistrationNumber: z.string().nullable(),
  /**
   * Is the caller the prescriber of this prescription?
   *
   * ⚠️ SERVER-DERIVED, AND IT IS A REGULATORY FACT RATHER THAN A COURTESY. Some
   *   jurisdictions exempt a practitioner dispensing to their own patients from
   *   the registered-pharmacist requirement; the engine is told this, and the
   *   client is only shown it.
   */
  callerIsPrescriber: z.boolean(),
  status: prescriptionFulfilmentStatus,
  verifiedAt: z.iso.datetime().nullable(),
  verifiedByName: z.string().nullable(),
  /** ⚠️ PHI. The pharmacist's own note. */
  fulfilmentNotes: z.string().nullable(),
  items: z.array(pharmacyPrescriptionItem),
});

export const verifyPrescriptionRequest = z.object({
  branchId: uuid.optional(),
  /** ⚠️ PHI. "Rang the prescriber about the dose." */
  notes: z.string().trim().max(2000).nullish(),
});

export const cancelPrescriptionFulfilmentRequest = z.object({
  branchId: uuid.optional(),
  /**
   * ⚠️ THIS CANCELS THE DISPENSARY'S INTENTION TO SUPPLY, NOT THE PRESCRIPTION.
   *   A prescription is withdrawn by the prescriber, in the clinical record, and
   *   pharmacy has no path to that and should not.
   */
  reason: z.string().trim().min(4).max(2000),
});

// ---------------------------------------------------------------------------
// Substitution (PI-7.4)
// ---------------------------------------------------------------------------

export const substitutionQuery = z.object({
  branchId: uuid.optional(),
  /** The prescribed line being substituted FOR. */
  encounterPrescriptionId: uuid.optional(),
  /** How much is needed, in base units. Used to say whether a candidate covers it. */
  quantityBase: decimalString.optional(),
});

/**
 * One product that could stand in for another.
 *
 * ⚠️ TWO INDEPENDENT QUESTIONS, ANSWERED BY TWO DIFFERENT THINGS, AND THE WHOLE
 *   REASON THIS SHAPE CARRIES A DECISION. "Is it equivalent?" is the composition
 *   triangle — same `composition_id`, in stock, not expired. "May I substitute
 *   it?" is `@rcln/regulatory`, per jurisdiction and sometimes per prescriber
 *   instruction. A product being equivalent does not make it substitutable, and
 *   in the absence of a rule the answer is DO NOT (PI-ADR-007).
 */
export const substitutionCandidate = z.object({
  productId: uuid,
  productName: z.string(),
  manufacturerName: z.string().nullable(),
  strength: z.string().nullable(),
  /**
   * The unit a supply of THIS product is counted in.
   *
   * ⚠️ THE ID AS WELL AS THE SYMBOL, ADDED IN PI-8 SO THE WORKSPACE CAN ACTUALLY
   *   SUPPLY A SUBSTITUTE. A dispense line states the unit its quantity is in,
   *   and sending the PRESCRIBED product's unit for a different product is a
   *   conversion against the wrong graph — the ledger refuses it, but only after
   *   the engine has been asked about a quantity nobody meant. The symbol alone
   *   is for reading; the id is what the request needs.
   */
  baseUnitId: uuid,
  baseUnitSymbol: z.string(),
  availableQuantityBase: decimalString,
  /** Does the shelf hold enough of it for what is needed? */
  coversRequirement: z.boolean(),
  /** ⚠️ Narrow-therapeutic-index products are where substitution goes wrong. */
  isNarrowTherapeuticIndex: z.boolean(),
  decision: dispenseRegulatorySummary,
});

export const substitutionResponse = z.object({
  prescribedProductId: uuid,
  prescribedProductName: z.string(),
  compositionId: uuid.nullable(),
  candidates: z.array(substitutionCandidate),
});

// ---------------------------------------------------------------------------
// Dispensing (PI-7.5)
// ---------------------------------------------------------------------------

/**
 * One lot the pharmacist chose, or overruled the plan to choose.
 *
 * ⚠️ OPTIONAL AS A WHOLE. Omit `allocations` on a line and the server plans it
 *   FEFO through `planStockAllocation`, which is what the workspace shows before
 *   anybody presses the button. Send them and the server honours them — and
 *   requires a reason for any that departs from the plan, because "why did it
 *   give out the lot expiring next week instead of the one expiring tomorrow" is
 *   a question that gets asked.
 */
export const dispenseAllocationRequest = z.object({
  locationId: uuid,
  batchId: uuid.nullish(),
  serialId: uuid.nullish(),
  /** In the product's BASE unit. The allocations must sum to the line quantity. */
  quantityBase: positiveQuantity,
  isOverride: z.boolean().default(false),
  overrideReason: z.string().trim().max(2000).nullish(),
});

export const dispenseLineRequest = z
  .object({
    /** The prescribed line this answers. Absent on a counter sale. */
    encounterPrescriptionId: uuid.nullish(),
    productId: uuid,
    /** What the person typed, in the unit they thought in. Never a base quantity. */
    quantity: positiveQuantity,
    unitId: uuid,
    /** Set when this is NOT what the prescriber wrote. */
    substitutedForProductId: uuid.nullish(),
    substitutionReason: z.string().trim().max(2000).nullish(),
    /** ⚠️ PHI. What goes on the label. Defaults to the prescription's own words. */
    labelInstructions: z.string().trim().max(2000).nullish(),
    allocations: z.array(dispenseAllocationRequest).max(50).optional(),
  })
  .refine(
    (line) => line.substitutedForProductId == null || (line.substitutionReason ?? '').length > 0,
    'a substitution has to say why — the CHECK constraint refuses one that does not'
  )
  .refine(
    (line) => line.substitutedForProductId !== line.productId,
    'a product cannot be substituted for itself'
  );

export const createDispenseRequest = z
  .object({
    branchId: uuid,
    /** The dispensing point it goes out of. */
    locationId: uuid,
    kind: dispenseKind.default('PRESCRIPTION'),
    /** Required on the prescription path, refused on the counter path. */
    encounterId: uuid.nullish(),
    /**
     * ⚠️ REQUIRED WHENEVER A PRESCRIPTION IS PRESENTED, AND THE SERVICE DERIVES
     *   IT FROM THE ENCOUNTER RATHER THAN TRUSTING IT. Sent only on the counter
     *   path, where a walk-in may or may not be a patient of this clinic.
     */
    patientId: uuid.nullish(),
    /** When it was handed over. Defaults to now; every ledger leg carries it. */
    dispensedAt: z.iso.datetime().optional(),
    /** ⚠️ PHI. */
    notes: z.string().trim().max(2000).nullish(),
    lines: z.array(dispenseLineRequest).min(1).max(100),
  })
  .refine(
    (body) => body.kind !== 'COUNTER_SALE' || body.encounterId == null,
    'a counter sale has no consultation behind it — send the prescription path instead'
  )
  .refine(
    (body) => body.kind !== 'PRESCRIPTION' || body.encounterId != null,
    'a dispense against a prescription has to say which consultation wrote it'
  )
  /**
   * ⚠️ `ONLINE` IS REFUSED ON THIS ENDPOINT, AND THIS REFINEMENT IS A SECURITY
   *   CONTROL RATHER THAN TIDINESS (PI-12, found by the security review).
   *
   *   `dispenseKind` was widened to carry `ONLINE` because the COLUMN needs the
   *   member — a packed parcel writes a `dispenses` row of that kind. Widening
   *   the shared enum silently widened this REQUEST too, and `createDispense`
   *   maps `kind: 'ONLINE'` to transaction `ONLINE_DISPENSE` with no
   *   `RemoteSupply` beside it. The result was a second, ungated door to a
   *   remote supply:
   *
   *     - `assertRemoteSupplyIsOpen` never runs — it lives in
   *       `confirmOnlineOrder` and nowhere else, so the clinic's own
   *       remote-supply gate is skipped entirely;
   *     - the ENGINE's gate does fire and refuses, and refusing changes nothing,
   *       because no pack is `PRODUCTION_ENABLED` — which is the whole reason
   *       the service-level gate exists;
   *     - no destination is supplied, so every destination-scoped rule sits out;
   *     - and the supply leaves no `online_orders` row, so nothing records where
   *       the parcel went.
   *
   *   A remote supply is only ever constructed SERVER-SIDE, by `packOnlineOrder`
   *   calling `createDispenseWithin` directly. Nothing may post one.
   */
  .refine(
    (body) => body.kind !== 'ONLINE',
    'a delivery is dispensed by packing its order, not by posting a dispense — see POST /v1/online-orders/{orderId}/pack'
  );

export const dispenseAllocationDetail = z.object({
  id: uuid,
  locationId: uuid,
  locationName: z.string(),
  batchId: uuid.nullable(),
  lotNumber: z.string().nullable(),
  expiresOn: z.iso.date().nullable(),
  serialId: uuid.nullable(),
  serialNumber: z.string().nullable(),
  quantityBase: decimalString,
  isOverride: z.boolean(),
  overrideReason: z.string().nullable(),
});

export const dispenseLineDetail = z.object({
  id: uuid,
  lineNumber: z.number().int(),
  encounterPrescriptionId: uuid.nullable(),
  productId: uuid,
  productName: z.string(),
  substitutedForProductId: uuid.nullable(),
  substitutedForProductName: z.string().nullable(),
  substitutionReason: z.string().nullable(),
  quantityEntered: decimalString,
  unitId: uuid,
  unitSymbol: z.string(),
  quantityBase: decimalString,
  baseUnitSymbol: z.string(),
  returnedQuantityBase: decimalString,
  /** ⚠️ PHI. */
  labelInstructions: z.string().nullable(),
  /** The snapshot that permitted this line, as the counter reads it. */
  decision: dispenseRegulatorySummary,
  allocations: z.array(dispenseAllocationDetail),
});

export const dispenseSummary = z.object({
  id: uuid,
  dispenseNumber: z.string(),
  branchId: uuid,
  branchName: z.string(),
  kind: dispenseKind,
  status: dispenseStatus,
  encounterId: uuid.nullable(),
  /** ⚠️ PHI, and null on a counter sale to somebody who is not a patient. */
  patientId: uuid.nullable(),
  patientName: z.string().nullable(),
  patientUhid: z.string().nullable(),
  locationId: uuid,
  locationName: z.string(),
  dispensedAt: z.iso.datetime(),
  dispensedByName: z.string(),
  lineCount: z.number().int(),
  /** Did any line come back with something the law required of it? */
  hasConditions: z.boolean(),
});

export const dispenseDetail = dispenseSummary.extend({
  /** ⚠️ PHI. */
  notes: z.string().nullable(),
  lines: z.array(dispenseLineDetail),
  returns: z.array(
    z.object({
      id: uuid,
      returnedAt: z.iso.datetime(),
      receivedByName: z.string(),
      disposition: dispenseReturnDisposition,
      reason: z.string(),
      lines: z.array(
        z.object({
          id: uuid,
          dispenseLineId: uuid,
          productName: z.string(),
          quantityBase: decimalString,
        })
      ),
    })
  ),
  createdAt: z.iso.datetime(),
});

export const dispenseQuery = z.object({
  ...documentPage,
  branchId: uuid.optional(),
  kind: dispenseKind.optional(),
  status: dispenseStatus.optional(),
  patientId: uuid.optional(),
  encounterId: uuid.optional(),
  productId: uuid.optional(),
  from: z.iso.date().optional(),
  to: z.iso.date().optional(),
});

export const dispenseListResponse = z.object({
  dispenses: z.array(dispenseSummary),
  meta: listMeta,
});

// ---------------------------------------------------------------------------
// Returns (PI-7.6)
// ---------------------------------------------------------------------------

export const createDispenseReturnRequest = z.object({
  /**
   * Where it is being put. Optional: it defaults to the counter it went out of,
   * which is the ordinary case and the one a rushed screen would get wrong.
   */
  locationId: uuid.nullish(),
  /** ⚠️ PHI-adjacent. Why a named person brought a medicine back. */
  reason: z.string().trim().min(4).max(2000),
  /**
   * Is the clinic ASKING for this to go back into sellable stock?
   *
   * ⚠️ FALSE BY DEFAULT, AND THE ENGINE MAY STILL SAY NO. Restocking a dispensed
   *   medicine is a regulatory AND a clinic-policy decision, and many
   *   jurisdictions forbid it outright: once it has left the counter nobody can
   *   attest to how it was stored. So both have to agree — a request with no
   *   permission quarantines, and a permission with no request quarantines too.
   *   The stock is accepted back either way; what is being decided is where it
   *   goes.
   */
  requestRestock: z.boolean().default(false),
  lines: z
    .array(
      z.object({
        dispenseLineId: uuid,
        /**
         * ⚠️ NAME THE ALLOCATION IT CAME OUT OF WHERE YOU CAN. Stock returned to
         *   the wrong lot makes a recall miss the units it went looking for. The
         *   service infers it when a line has exactly one allocation.
         */
        dispenseAllocationId: uuid.nullish(),
        quantityBase: positiveQuantity,
      })
    )
    .min(1)
    .max(100),
});

export const dispenseReturnDetail = z.object({
  id: uuid,
  dispenseId: uuid,
  dispenseNumber: z.string(),
  branchId: uuid,
  disposition: dispenseReturnDisposition,
  /**
   * Why it went where it went, in the law's own words. Empty when no rule spoke
   * — and the default is still quarantine.
   */
  dispositionMessages: z.array(z.string()),
  locationId: uuid,
  locationName: z.string(),
  reason: z.string(),
  returnedAt: z.iso.datetime(),
  receivedByName: z.string(),
  lines: z.array(
    z.object({
      id: uuid,
      dispenseLineId: uuid,
      dispenseAllocationId: uuid.nullable(),
      productId: uuid,
      productName: z.string(),
      quantityBase: decimalString,
      baseUnitSymbol: z.string(),
    })
  ),
});

// ---------------------------------------------------------------------------
// The dashboard (PI-7.7)
// ---------------------------------------------------------------------------

export const pharmacyDashboardQuery = z.object({ branchId: uuid.optional() });

/**
 * Counts only.
 *
 * ⚠️ NOT ONE PATIENT NAME AND NOT ONE MEDICINE NAME ON THIS SHAPE, WHICH IS WHY
 *   IT IS COUNTS. A dashboard is the screen most likely to be left open on a
 *   counter in a waiting room, and "waiting: Mrs Rao — methadone" is a
 *   disclosure to everybody standing in the queue behind her.
 */
export const pharmacyDashboardResponse = z.object({
  branchId: uuid,
  branchName: z.string(),
  /** Prescriptions with nothing dispensed against them yet. */
  awaitingVerification: z.number().int(),
  verifiedAwaitingSupply: z.number().int(),
  partiallyDispensed: z.number().int(),
  dispensedToday: z.number().int(),
  returnsToday: z.number().int(),
  /** Lots expiring inside 30 days, and lots that are not dispensable at all. */
  expiringSoonBatches: z.number().int(),
  quarantinedBatches: z.number().int(),
  recalledBatches: z.number().int(),
});

// ---------------------------------------------------------------------------
// Inferred types
// ---------------------------------------------------------------------------

export type PrescriptionFulfilmentStatus = z.infer<typeof prescriptionFulfilmentStatus>;
export type DispenseKind = z.infer<typeof dispenseKind>;
export type DispenseStatus = z.infer<typeof dispenseStatus>;
export type DispenseReturnDisposition = z.infer<typeof dispenseReturnDisposition>;
export type DispenseRegulatorySummary = z.infer<typeof dispenseRegulatorySummary>;

export type PrescriptionQueueQuery = z.infer<typeof prescriptionQueueQuery>;
export type PrescriptionQueueItem = z.infer<typeof prescriptionQueueItem>;
export type PrescriptionQueueResponse = z.infer<typeof prescriptionQueueResponse>;
export type PharmacyPrescriptionItem = z.infer<typeof pharmacyPrescriptionItem>;
export type PharmacyPrescriptionDetail = z.infer<typeof pharmacyPrescriptionDetail>;
export type VerifyPrescriptionRequest = z.infer<typeof verifyPrescriptionRequest>;
export type CancelPrescriptionFulfilmentRequest = z.infer<
  typeof cancelPrescriptionFulfilmentRequest
>;

export type SubstitutionQuery = z.infer<typeof substitutionQuery>;
export type SubstitutionCandidate = z.infer<typeof substitutionCandidate>;
export type SubstitutionResponse = z.infer<typeof substitutionResponse>;

export type DispenseAllocationRequest = z.infer<typeof dispenseAllocationRequest>;
export type DispenseLineRequest = z.infer<typeof dispenseLineRequest>;
export type CreateDispenseRequest = z.infer<typeof createDispenseRequest>;
export type DispenseAllocationDetail = z.infer<typeof dispenseAllocationDetail>;
export type DispenseLineDetail = z.infer<typeof dispenseLineDetail>;
export type DispenseSummary = z.infer<typeof dispenseSummary>;
export type DispenseDetail = z.infer<typeof dispenseDetail>;
export type DispenseQuery = z.infer<typeof dispenseQuery>;
export type DispenseListResponse = z.infer<typeof dispenseListResponse>;

export type CreateDispenseReturnRequest = z.infer<typeof createDispenseReturnRequest>;
export type DispenseReturnDetail = z.infer<typeof dispenseReturnDetail>;

export type PharmacyDashboardQuery = z.infer<typeof pharmacyDashboardQuery>;
export type PharmacyDashboardResponse = z.infer<typeof pharmacyDashboardResponse>;
