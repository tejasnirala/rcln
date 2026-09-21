/**
 * The animal behind an `ANIMAL` patient record, and the one calculation the
 * platform does with it (PI-11).
 *
 * ⚠️ ITS OWN FILE, AND NOT BECAUSE `patient.service.ts` IS LONG. Everything here
 *   is refused outright for a human record, which is a guard no other patient
 *   service has to carry, and the dose calculator reaches into `@rcln/clinical`
 *   rather than into Prisma. Folding it into the identity service would mean
 *   every future reader of `createPatient` steps over a veterinary branch.
 *
 * ⚠️ EVERYTHING BELOW IS STILL PHI, AND THE RULES DO NOT SOFTEN BECAUSE THE
 *   PATIENT IS A DOG. `guardian_name` and `guardian_phone` name a PERSON — the
 *   owner — and a species plus a breed plus a phone number identifies a
 *   household. So: `recordDataAccess` on every read that discloses a row,
 *   nothing into `recordAudit` except through the allow-list snapshot below, and
 *   ids only in logs.
 *
 * ── WHY THE WRITE IS A PUT AND NOT A PATCH ──────────────────────────────────
 * The profile is replaced wholesale. A clinic clearing a weight sends an object
 * without one, and `animalProfileData` maps every absent key to NULL — see its
 * comment. A partial update would let a stale weight survive an edit that meant
 * to remove it, and a stale weight is the exact hazard `weight_recorded_on` and
 * `weightIsStale` were added to make visible.
 */
import { withTenant, type TenantContext, type TxClient } from '@rcln/db';
import { weightBasedDose } from '@rcln/clinical';
import type {
  AnimalProfileRequest,
  DoseCalculationRequest,
  DoseCalculationResponse,
  PatientDetail,
} from '@rcln/contracts';
import { ConflictError, NotFoundError, ValidationError } from '../../utils/errors.js';
import { recordAudit } from '../audit/audit.service.js';
import { recordDataAccess } from '../audit/data-access.service.js';
import { decimalToString } from '../product/values.js';
import {
  animalProfileData,
  getPatient,
  resolveWeightStaleDays,
  weightIsStale,
  type PatientActionOptions,
} from './patient.service.js';

/**
 * The animal's own row, re-read and re-asserted.
 *
 * ⚠️ THE SUBJECT-TYPE CHECK IS THE POINT OF THIS FUNCTION, NOT THE LOOKUP. A
 *   profile hanging off a human record is not untidy — `animal_profiles` is a
 *   LEFT join the DISPENSING path reads a species out of, and a row under a
 *   human patient would feed a species to a `SPECIES_RESTRICTION` rule about a
 *   person. Nothing in the database prevents it: the FK constrains the tenant
 *   and the parent, and says nothing about what kind of patient the parent is.
 *
 * `NotFoundError` for a patient RLS did not return, which is a patient at
 * another clinic — never a 403, per the middleware rules.
 */
async function assertAnimalPatient(tx: TxClient, patientId: string): Promise<void> {
  const patient = await tx.patient.findFirst({
    where: { id: patientId, deletedAt: null },
    select: { subjectType: true, status: true },
  });
  if (!patient) throw new NotFoundError('Patient');
  if (patient.subjectType !== 'ANIMAL') {
    throw new ValidationError('That record is a person, so it has no animal profile.');
  }
  if (patient.status === 'MERGED') {
    throw new ConflictError('That record has been merged into another one and is read-only.');
  }
}

/**
 * The owner, when the clinic named one as a contact row.
 *
 * ⚠️ THE COMPOSITE FK CONSTRAINS THE TENANT, NOT THE PARENT, AND THIS IS THE
 *   HALF IT CANNOT DO. `(organization_id, guardian_contact_id)` makes ANOTHER
 *   CLINIC'S contact unrepresentable — a cross-tenant owner cannot be written at
 *   all (ADR-0004). What it happily accepts is a contact belonging to a
 *   DIFFERENT animal at this same clinic, which would put one household's phone
 *   number on another household's pet, and is exactly the sort of thing a recall
 *   notice is posted from.
 */
async function assertContactBelongsToPatient(
  tx: TxClient,
  patientId: string,
  contactId: string
): Promise<void> {
  const contact = await tx.patientContact.findFirst({
    where: { id: contactId, patientId },
    select: { id: true },
  });
  if (!contact) {
    throw new ValidationError('That contact is not on this record.');
  }
}

/**
 * ⚠️ THE ALLOW-LIST. The only thing from this file that may reach `audit_logs`.
 *
 * Species and breed are absent, and that is not over-caution: "Golden Retriever,
 * 34 kg, owner on 98450 67890" in a mutation trail read by compliance staff is
 * an identifiable household, and the trail's job is to say WHAT CHANGED, which
 * the booleans do. The weight is present as a NUMBER OF KILOGRAMS because
 * "somebody changed this animal's weight from 34 to 3.4 the day before it was
 * dosed" is precisely the change this trail exists to show, and a weight alone
 * identifies nobody.
 *
 * ⚠️ NEVER `{ ...row }`. `REDACTED_KEYS` in audit.service.ts is the backstop for
 * the day somebody does — a backstop, not a permission.
 */
function snapshot(profile: {
  weightKg: unknown;
  weightRecordedOn: Date | null;
  species: string | null;
  breed: string | null;
  guardianContactId: string | null;
  guardianName: string | null;
}): Record<string, unknown> {
  return {
    weightKg: decimalToString(profile.weightKg as { toString(): string } | null),
    weightRecordedOn: profile.weightRecordedOn?.toISOString().slice(0, 10) ?? null,
    hasSpecies: profile.species !== null,
    hasBreed: profile.breed !== null,
    /* WHICH form the owner is recorded in, never who they are. */
    guardianForm:
      profile.guardianContactId !== null
        ? 'CONTACT'
        : profile.guardianName !== null
          ? 'TEXT'
          : 'NONE',
  };
}

/**
 * Replace an animal's profile, creating it if this is the first time.
 *
 * Returns the whole patient rather than the profile alone, matching every other
 * write on this record — `addContact` and `addAddress` do the same, so a screen
 * re-renders from one response instead of stitching two together.
 */
export async function setAnimalProfile(
  ctx: TenantContext,
  patientId: string,
  input: AnimalProfileRequest,
  options: PatientActionOptions = {}
): Promise<PatientDetail> {
  await withTenant(ctx, async (tx) => {
    await assertAnimalPatient(tx, patientId);
    if (input.guardianContactId !== undefined) {
      await assertContactBelongsToPatient(tx, patientId, input.guardianContactId);
    }

    const before = await tx.animalProfile.findFirst({
      where: { patientId },
      select: {
        id: true,
        species: true,
        breed: true,
        weightKg: true,
        weightRecordedOn: true,
        guardianContactId: true,
        guardianName: true,
      },
    });

    /*
     * ⚠️ THE SAME MAPPER THE REGISTRATION PATH USES, IMPORTED RATHER THAN
     *   REWRITTEN. Its every-absent-key-becomes-NULL behaviour is what makes
     *   this a PUT, and a second copy here would be one edit away from being a
     *   PATCH on one path and a PUT on the other.
     */
    const data = animalProfileData(input);

    /*
     * ⚠️ NOT `tx.animalProfile.upsert`. The unique key is the COMPOSITE
     *   (organization_id, patient_id), and Prisma's nested/upsert input treats
     *   `organizationId` as owned by the `organization` relation and refuses it
     *   as a scalar — the same composite FK that makes a cross-tenant child
     *   unrepresentable (ADR-0004). Two statements in one transaction, exactly
     *   as `createPatientRow` writes its address and contacts.
     */
    const after =
      before === null
        ? await tx.animalProfile.create({
            data: { organizationId: ctx.organizationId, patientId, ...data },
            select: {
              id: true,
              species: true,
              breed: true,
              weightKg: true,
              weightRecordedOn: true,
              guardianContactId: true,
              guardianName: true,
            },
          })
        : await tx.animalProfile.update({
            where: { organizationId_patientId: { organizationId: ctx.organizationId, patientId } },
            data,
            select: {
              id: true,
              species: true,
              breed: true,
              weightKg: true,
              weightRecordedOn: true,
              guardianContactId: true,
              guardianName: true,
            },
          });

    await recordAudit(tx, ctx, {
      action: before === null ? 'CREATE' : 'UPDATE',
      entityType: 'animal_profile',
      entityId: after.id,
      ...(before === null ? {} : { before: snapshot(before) }),
      after: snapshot(after),
      ...options,
    });
  });

  /*
   * Re-read through the identity service so the caller gets the same shape every
   * other patient write returns — and so the disclosure is logged by the one
   * function that logs it, rather than by a second copy of that logic here.
   */
  return getPatient(ctx, patientId, options);
}

/**
 * "How much of this do I give?" — weight × rate, held to whatever ceilings the
 * clinician read off the label.
 *
 * ⚠️ THE WEIGHT COMES OFF THE RECORD AND NEVER OFF THE REQUEST, AND THAT IS THE
 *   ONLY REASON THIS IS AN ENDPOINT. The arithmetic is a multiplication anybody
 *   could do at the counter; what they cannot do at the counter is notice that
 *   the weight they are working from was taken seven months ago. The response
 *   carries `weightRecordedOn` and `weightIsStale` for exactly that, and this
 *   function refuses outright when there is no weight at all rather than
 *   answering from a number the caller supplied.
 *
 * ⚠️ IT AUTHORISES NOTHING AND WRITES NO CLINICAL RECORD. A dose becomes part of
 *   the chart when a doctor signs a prescription — `clinical.prescription.sign`,
 *   DOCTOR's alone (invariant 7). This is a calculator that files a disclosure
 *   log and nothing else.
 */
export async function calculateDose(
  ctx: TenantContext,
  patientId: string,
  input: DoseCalculationRequest,
  options: PatientActionOptions = {}
): Promise<DoseCalculationResponse> {
  const { profile, staleAfterDays } = await withTenant(ctx, async (tx) => {
    await assertAnimalPatient(tx, patientId);

    const row = await tx.animalProfile.findFirst({
      where: { patientId },
      select: { weightKg: true, weightRecordedOn: true },
    });
    if (row === null || row.weightKg === null) {
      throw new ValidationError(
        'Record a weight for this animal before calculating a dose from it.'
      );
    }

    /*
     * ⚠️ LOGGED AS A `PATIENT` READ RATHER THAN GETTING ITS OWN
     *   `DataAccessResource` MEMBER, AND THAT IS A CONSIDERED CHOICE. Every
     *   member added to that enum earns its place by being a question a
     *   disclosure review asks separately — `RECALL_TRACE` is "who read a list
     *   of names", `VITALS` is "who read what we measured". "Who calculated a
     *   dose" discloses the animal's weight and nothing the patient record does
     *   not already carry, and it is answerable by looking at the same rows.
     */
    const visible = await tx.patientRegistration.findFirst({
      where: { patientId },
      select: { branchId: true },
    });
    await recordDataAccess(tx, ctx, {
      accessType: 'VIEW',
      resource: 'PATIENT',
      patientId,
      resourceId: patientId,
      branchId: visible?.branchId ?? null,
      ...options,
    });

    return {
      profile: row,
      staleAfterDays: await resolveWeightStaleDays(tx, ctx, visible?.branchId),
    };
  });

  /* The shared serialiser, so the dose is computed from exactly the string the
   * patient record shows — a second conversion here is a second rounding. */
  const weightKg = decimalToString(profile.weightKg) as string;
  const dose = weightBasedDose({
    weightKg,
    dosePerKg: input.dosePerKg,
    ...(input.dosesPerDay !== undefined ? { dosesPerDay: input.dosesPerDay } : {}),
    ...(input.maxSingleDose !== undefined ? { maxSingleDose: input.maxSingleDose } : {}),
    ...(input.maxDailyDose !== undefined ? { maxDailyDose: input.maxDailyDose } : {}),
  });
  if (!dose.ok) {
    /*
     * The package refuses rather than throwing, so a broken input becomes a 422
     * naming what was wrong instead of a 500. Everything it can refuse is
     * already refused by the contract — this is the belt to that brace, and it
     * is what keeps the two from drifting silently apart.
     */
    throw new ValidationError(dose.problem);
  }

  const recordedOn = profile.weightRecordedOn;
  return {
    weightKg,
    weightRecordedOn: recordedOn?.toISOString().slice(0, 10) ?? null,
    /*
     * ⚠️ THE SHARED RULE, NOT A SECOND COPY (PI-11 review). This was an inlined
     *   duplicate that had already drifted from the chart's — it omitted the
     *   null-weight guard — and two answers to a safety flag on one record is
     *   worse than either of them.
     */
    weightIsStale: weightIsStale(recordedOn, profile.weightKg, staleAfterDays),
    unit: input.unit,
    singleDose: dose.value.singleDose,
    dailyDose: dose.value.dailyDose,
    cappedBy: dose.value.cappedBy,
    exact: dose.value.exact,
  };
}
