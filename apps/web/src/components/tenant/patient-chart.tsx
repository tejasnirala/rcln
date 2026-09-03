'use client';

import Link from 'next/link';
import { useActionState, useCallback, useEffect, useRef, useState } from 'react';
import { splitE164 } from '@rcln/contracts';
import type {
  AnimalProfileDetail,
  PatientAllergyDetail,
  PatientConditionDetail,
  PatientDetail,
  PatientHistoryResponse,
  PatientMedicationDetail,
} from '@rcln/contracts';
import { Field, Input, Select, describedBy, type SelectOption } from '@/components/ui/field';
import { PhoneInput } from '@/components/ui/phone-input';
import { NationalIdInput } from '@/components/tenant/national-id-input';
import { Button } from '@/components/ui/button';
import { Alert, useOutcomeFocus } from '@/components/ui/alert';
import { RecordHistory } from '@/components/tenant/record-history';
import { type BranchChoice } from '@/components/tenant/patient-search';
import { BLOOD_GROUPS, GENDERS, MARITAL_STATUSES, ageLine } from '@/lib/patient-words';
import {
  addAllergy,
  addCondition,
  addMedication,
  calculateDose,
  registerAtBranch,
  removeAllergy,
  removeCondition,
  saveAnimalProfile,
  stopMedication,
  updatePatient,
  type DoseState,
  type PatientFormState,
} from '@/app/(tenant)/t/[slug]/(app)/patients/actions';

const IDLE: PatientFormState = { status: 'idle' };
const DOSE_IDLE: DoseState = { status: 'idle' };

const BLOOD_WORDS: Record<string, string> = {
  A_POSITIVE: 'A+',
  A_NEGATIVE: 'A−',
  B_POSITIVE: 'B+',
  B_NEGATIVE: 'B−',
  AB_POSITIVE: 'AB+',
  AB_NEGATIVE: 'AB−',
  O_POSITIVE: 'O+',
  O_NEGATIVE: 'O−',
  UNKNOWN: 'Not known',
};

const SEVERITIES: SelectOption[] = [
  { value: 'SEVERE', label: 'Severe' },
  { value: 'MODERATE', label: 'Moderate' },
  { value: 'MILD', label: 'Mild' },
];

const ALLERGEN_TYPES: SelectOption[] = [
  { value: 'DRUG', label: 'Medicine' },
  { value: 'FOOD', label: 'Food' },
  { value: 'ENVIRONMENT', label: 'Environment' },
  { value: 'OTHER', label: 'Something else' },
];

const CONDITION_STATUSES: SelectOption[] = [
  { value: 'ACTIVE', label: 'Active' },
  { value: 'CHRONIC', label: 'Long-term' },
  { value: 'RESOLVED', label: 'Resolved' },
];

const SEVERITY_WORDS: Record<string, string> = {
  SEVERE: 'Severe',
  MODERATE: 'Moderate',
  MILD: 'Mild',
};

/**
 * One patient's record.
 *
 * ⚠️ THE ALLERGY BAND IS THE ONE PIECE OF EMPHASIS ON THIS SCREEN, AND IT IS
 *   DELIBERATE. Everything else here is the same quiet card the rest of the app
 *   uses. Allergies get a full-width band directly under the identity strip,
 *   above every other panel, because it is the one fact on this page that is
 *   dangerous to miss and the one a prescriber must see without scrolling or
 *   expanding anything.
 *
 *   The band never carries its meaning in colour alone (WCAG 1.4.1, and
 *   apps/web/AGENTS.md lists it as a rule already got wrong once): severity is
 *   spelled out in words next to every allergen, and "No allergies recorded" is
 *   stated rather than left as an absence — a blank space reads as "none",
 *   and "nobody has asked" is a different and more dangerous answer.
 */
export function PatientChart({
  slug,
  patient,
  history,
  branches,
  countryCode,
  canReadHistory,
  canUpdate,
  canCreate,
  canWriteHistory,
  canReadAudit,
  canReadVisitHistory,
}: {
  slug: string;
  patient: PatientDetail;
  history: PatientHistoryResponse | null;
  branches: BranchChoice[];
  /**
   * The CLINIC's country, off the session. Decides which identity documents the
   * edit form offers — the same list the registration desk was given, and not
   * something the front desk could otherwise learn, because `GET /organization`
   * is behind a permission they do not hold.
   */
  countryCode: string;
  canReadHistory: boolean;
  canUpdate: boolean;
  canCreate: boolean;
  canWriteHistory: boolean;
  canReadAudit: boolean;
  /** `clinical.encounter.read` — the consultations, which is a wider read. */
  canReadVisitHistory: boolean;
}) {
  const [panel, setPanel] = useState<
    'none' | 'edit' | 'branch' | 'allergy' | 'condition' | 'medicine' | 'animal'
  >('none');

  /*
   * ⚠️ THE SAVE HAS TO SAY SOMETHING AFTER THE FORM CLOSES. Collapsing the panel
   *   is the right answer to "it worked", but on its own it is ambiguous: a
   *   marital status or an ID type changes nothing visible on the strip above,
   *   so the screen would look identical whether the write landed or the panel
   *   had simply been dismissed. The banner is the difference, and it is cleared
   *   the moment anything else is opened.
   */
  const [saved, setSaved] = useState(false);

  const toggle = (next: Exclude<typeof panel, 'none'>) => {
    setSaved(false);
    setPanel((current) => (current === next ? 'none' : next));
  };

  /*
   * Stable, because `EditForm` closes itself from an effect keyed on this — a
   * fresh arrow every render would re-run that effect on every render.
   */
  const closeEdit = useCallback(() => {
    setPanel('none');
  }, []);
  const finishEdit = useCallback(() => {
    setPanel('none');
    setSaved(true);
  }, []);

  const elsewhere = branches.filter(
    (branch) => !patient.registrations.some((r) => r.branchId === branch.id)
  );

  return (
    <>
      <Link
        href={`/patients`}
        className="text-drape focus-visible:outline-drape text-[0.8125rem] underline underline-offset-2 focus-visible:outline-2 focus-visible:outline-offset-2"
      >
        ← Back to patients
      </Link>

      <IdentityStrip patient={patient} />

      {canReadHistory ? (
        <AllergyBand allergies={history?.allergies ?? []} />
      ) : (
        <p className="border-rule text-muted mt-4 rounded-lg border border-dashed px-5 py-3 text-[0.8125rem]">
          Allergies and clinical history are not shown here — that needs the medical history
          permission.
        </p>
      )}

      <div className="mt-6 flex flex-wrap gap-2">
        {canUpdate ? (
          <Button
            variant="secondary"
            onClick={() => toggle('edit')}
            aria-expanded={panel === 'edit'}
          >
            Edit details
          </Button>
        ) : null}
        {canCreate && elsewhere.length > 0 ? (
          <Button
            variant="secondary"
            onClick={() => toggle('branch')}
            aria-expanded={panel === 'branch'}
          >
            Register at another clinic
          </Button>
        ) : null}
        {patient.subjectType === 'ANIMAL' && canUpdate ? (
          <Button
            variant="secondary"
            onClick={() => toggle('animal')}
            aria-expanded={panel === 'animal'}
          >
            {patient.animalProfile === null ? 'Add animal details' : 'Edit animal details'}
          </Button>
        ) : null}
        {/*
          ⚠️ A LINK RATHER THAN A PANEL, AND THAT IS AN AUDIT DECISION (CE-5).
            The visit history is the most concentrated PHI read on the platform —
            every journey, every visit, every diagnosis — and reading it writes a
            `data_access_logs` row. Rendering it inline would mean every
            receptionist opening a record to check a telephone number logged a
            read of the whole clinical history, which buries the reads that
            matter under the ones that do not.

          ⚠️ AND IT IS BEHIND `clinical.encounter.read`, NOT
            `patient.medical_history.read`. The panels below are a DIFFERENT
            record: allergies, conditions and long-term medications, which are
            true of the person between visits. This is the sequence of
            consultations. A doctor holds both; holding one has never implied
            the other.
        */}
        {canReadVisitHistory ? (
          <Link
            href={`/patients/${patient.id}/visit-history`}
            className="border-rule bg-card text-ink hover:bg-drape-tint/40 active:bg-drape-tint/70 inline-flex items-center justify-center rounded-md border px-5 py-3 text-[0.9375rem] font-medium transition-colors"
          >
            Visit history
          </Link>
        ) : null}
        {canReadAudit ? (
          <RecordHistory
            slug={slug}
            entityType="patient"
            entityId={patient.id}
            label={patient.uhid}
          />
        ) : null}
      </div>

      {saved ? (
        <Alert tone="success" className="mt-4">
          Record updated.
        </Alert>
      ) : null}

      {panel === 'edit' ? (
        <Card className="mt-4">
          <EditForm
            slug={slug}
            patient={patient}
            countryCode={countryCode}
            onSaved={finishEdit}
            onCancel={closeEdit}
          />
        </Card>
      ) : null}

      {panel === 'animal' ? (
        <Card className="mt-4">
          <AnimalForm slug={slug} patient={patient} />
        </Card>
      ) : null}

      {panel === 'branch' ? (
        <Card className="mt-4">
          <BranchForm slug={slug} patientId={patient.id} branches={elsewhere} />
        </Card>
      ) : null}

      <div className="mt-8 grid gap-4 lg:grid-cols-2">
        <RegistrationsPanel patient={patient} />
        <ContactsPanel patient={patient} />
        {/*
          The dose calculator sits with the record panels and not with the
          clinical history, because it READS the record rather than adding to
          it — nothing it does becomes part of the chart. It needs
          `patient.medical_history.read` all the same: what comes back is a
          therapeutic quantity, and the receptionist who may register the animal
          has no business being handed one.
        */}
        {patient.subjectType === 'ANIMAL' && canReadHistory ? (
          <DoseCalculator
            slug={slug}
            patientId={patient.id}
            profile={patient.animalProfile}
            className="lg:col-span-2"
          />
        ) : null}
      </div>

      {canReadHistory && history ? (
        <div className="mt-4 grid gap-4 lg:grid-cols-2">
          <ConditionsPanel
            slug={slug}
            patientId={patient.id}
            conditions={history.conditions}
            canWrite={canWriteHistory}
            open={panel === 'condition'}
            onToggle={() => toggle('condition')}
          />
          <MedicationsPanel
            slug={slug}
            patientId={patient.id}
            medications={history.medications}
            canWrite={canWriteHistory}
            open={panel === 'medicine'}
            onToggle={() => toggle('medicine')}
          />
          {canWriteHistory ? (
            <Card className="lg:col-span-2">
              <PanelHeading
                title="Allergies"
                note="Shown at the top of this record and checked against every prescription."
                action={
                  <Button variant="secondary" size="sm" onClick={() => toggle('allergy')}>
                    Record an allergy
                  </Button>
                }
              />
              {panel === 'allergy' ? (
                <div className="mt-4">
                  <AllergyForm slug={slug} patientId={patient.id} />
                </div>
              ) : null}
              <AllergyRows
                slug={slug}
                patientId={patient.id}
                allergies={history.allergies}
                canWrite
              />
            </Card>
          ) : null}
        </div>
      ) : null}
    </>
  );
}

function Card({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <section className={`border-rule bg-card rounded-lg border p-5 ${className ?? ''}`}>
      {children}
    </section>
  );
}

function PanelHeading({
  title,
  note,
  action,
}: {
  title: string;
  note?: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div>
        <h2 className="eyebrow text-drape">{title}</h2>
        {note ? <p className="text-muted mt-1 text-[0.8125rem]">{note}</p> : null}
      </div>
      {action}
    </div>
  );
}

/**
 * Who this is, in the order a person at a counter needs it.
 *
 * The two numbers are set in mono and given their own block on the right,
 * because a UHID is what gets read back down a phone and written on a file
 * cover — the same treatment the search results give them, so one carries over
 * from the other.
 */
function IdentityStrip({ patient }: { patient: PatientDetail }) {
  return (
    <header className="border-rule bg-card mt-4 flex flex-wrap items-start justify-between gap-6 rounded-lg border p-5">
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="font-display text-3xl tracking-tight">{patient.fullName}</h1>
          {patient.status !== 'ACTIVE' ? (
            <span className="bg-signal-tint text-signal rounded-xs px-2 py-0.5 text-[0.6875rem] font-medium">
              {patient.status === 'DECEASED' ? 'Deceased' : patient.status.toLowerCase()}
            </span>
          ) : null}
        </div>

        {/*
          ⚠️ AN ANIMAL DOES NOT GET A BLOOD GROUP LINE, AND THAT IS NOT TIDINESS.
            `BLOOD_WORDS` renders `UNKNOWN` as "Not known", which on a dog reads
            as a gap in the record somebody ought to fill in — when in fact the
            ABO/Rh groups this enum carries are human ones and there is nothing
            to fill in. Species and breed are what identify the animal in front
            of you, so they take the same line.
        */}
        <p className="text-muted mt-2 text-[0.9375rem]">
          {ageLine(patient)}
          {patient.subjectType === 'ANIMAL'
            ? animalLine(patient.animalProfile)
            : ` · Blood group ${BLOOD_WORDS[patient.bloodGroup] ?? 'Not known'}`}
        </p>

        {patient.subjectType === 'ANIMAL' ? <WeightLine profile={patient.animalProfile} /> : null}

        <dl className="text-muted mt-3 flex flex-wrap gap-x-6 gap-y-1 text-[0.8125rem]">
          {patient.phone !== null ? (
            <div className="flex gap-1.5">
              <dt>Phone</dt>
              <dd className="text-ink">{patient.phone}</dd>
            </div>
          ) : null}
          {patient.addresses[0] ? (
            <div className="flex gap-1.5">
              <dt>Address</dt>
              <dd className="text-ink">
                {[patient.addresses[0].line1, patient.addresses[0].city].filter(Boolean).join(', ')}
              </dd>
            </div>
          ) : null}
          {patient.abhaNumber !== null ? (
            <div className="flex gap-1.5">
              <dt>ABHA</dt>
              <dd className="text-ink font-mono">{patient.abhaNumber}</dd>
            </div>
          ) : null}
        </dl>
      </div>

      <div className="text-right">
        <p className="eyebrow">Hospital no.</p>
        <p className="text-ink font-mono text-[1.0625rem]">{patient.uhid}</p>
        {patient.registrations.map((registration) => (
          <p key={registration.id} className="text-muted mt-2 font-mono text-[0.75rem]">
            {registration.mrn}
            <span className="block font-sans">{registration.branchName}</span>
          </p>
        ))}
      </div>
    </header>
  );
}

/**
 * The one loud thing on this page.
 *
 * Above every panel, full width, and stated in words whichever way the answer
 * goes: an empty allergy list and an unasked question look identical on screen
 * and are not the same fact.
 */
/**
 * " · Dog · Indie", or " · Species not recorded".
 *
 * Stated rather than omitted, for the reason `AllergyBand` states "None
 * recorded": a blank space reads as "there is nothing to say", and on this
 * particular field there usually is.
 */
function animalLine(profile: AnimalProfileDetail | null): string {
  if (profile === null || profile.species === null) return ' · Species not recorded';
  return profile.breed === null
    ? ` · ${profile.species}`
    : ` · ${profile.species} · ${profile.breed}`;
}

/**
 * The recorded weight, and how old it is.
 *
 * ⚠️ THIS IS THE ONE PIECE OF EMPHASIS AN ANIMAL RECORD ADDS, AND IT SITS WHERE
 *   IT DOES FOR THE REASON THE ALLERGY BAND DOES. Everything else on this screen
 *   is a quiet card. A weight is not dangerous; a weight somebody is about to
 *   calculate a dose from, taken seven months ago, is — and it is dangerous
 *   precisely because it looks exactly like a current one.
 *
 * ⚠️ AND IT NEVER CARRIES ITS MEANING IN COLOUR ALONE (WCAG 1.4.1, and
 *   apps/web/AGENTS.md lists it as a rule already got wrong once). "Weigh again
 *   before dosing" is written out beside the number; the tint is the second
 *   signal, not the only one.
 */
function WeightLine({ profile }: { profile: AnimalProfileDetail | null }) {
  if (profile === null || profile.weightKg === null) {
    return <p className="text-muted mt-1 text-[0.8125rem]">No weight recorded.</p>;
  }

  const weight = `${profile.weightKg} kg`;
  if (!profile.weightIsStale) {
    return (
      <p className="text-muted mt-1 text-[0.8125rem]">
        <span className="text-ink font-medium">{weight}</span>
        {profile.weightRecordedOn !== null ? ` · weighed ${profile.weightRecordedOn}` : ''}
      </p>
    );
  }

  return (
    <p className="border-signal/40 bg-signal-tint text-signal mt-2 inline-block rounded-md border px-3 py-1.5 text-[0.8125rem]">
      <span className="font-medium">{weight}</span>
      {profile.weightRecordedOn !== null
        ? ` · weighed ${profile.weightRecordedOn}`
        : ' · no date recorded'}
      <span className="block">Weigh again before dosing.</span>
    </p>
  );
}

function AllergyBand({ allergies }: { allergies: PatientAllergyDetail[] }) {
  if (allergies.length === 0) {
    return (
      <p className="border-rule bg-card text-muted mt-4 rounded-lg border px-5 py-3 text-[0.8125rem]">
        <span className="eyebrow text-drape">Allergies</span>{' '}
        <span className="ml-2">None recorded. Ask before prescribing.</span>
      </p>
    );
  }

  return (
    <section
      // `alert` rather than `region`: this is the one thing on the page a
      // clinician must be told, not something they navigate to.
      role="alert"
      className="border-signal/40 bg-signal-tint mt-4 rounded-lg border px-5 py-4"
    >
      <h2 className="eyebrow text-signal">
        Allergies · {allergies.length === 1 ? '1 recorded' : `${String(allergies.length)} recorded`}
      </h2>
      <ul className="mt-2 flex flex-wrap gap-x-8 gap-y-2">
        {allergies.map((allergy) => (
          <li key={allergy.id}>
            <p className="text-signal text-[1.0625rem] font-medium">{allergy.allergenText}</p>
            <p className="text-signal/80 text-[0.75rem]">
              {SEVERITY_WORDS[allergy.severity] ?? allergy.severity}
              {allergy.reaction !== null ? ` · ${allergy.reaction}` : ''}
            </p>
          </li>
        ))}
      </ul>
    </section>
  );
}

function RegistrationsPanel({ patient }: { patient: PatientDetail }) {
  return (
    <Card>
      <PanelHeading title="Registered at" note="One record number per clinic." />
      <ul className="mt-3 grid gap-2">
        {patient.registrations.map((registration) => (
          <li key={registration.id} className="flex items-baseline justify-between gap-4">
            <span className="text-ink text-[0.875rem]">{registration.branchName}</span>
            <span className="text-muted font-mono text-[0.8125rem]">{registration.mrn}</span>
          </li>
        ))}
        {patient.registrations.length === 0 ? (
          <li className="text-muted text-[0.8125rem]">
            Registered at a clinic you do not have access to.
          </li>
        ) : null}
      </ul>
    </Card>
  );
}

function ContactsPanel({ patient }: { patient: PatientDetail }) {
  return (
    <Card>
      <PanelHeading title="Who to ring" />
      {patient.contacts.length === 0 ? (
        <p className="text-muted mt-3 text-[0.8125rem]">
          Nobody recorded. Worth asking at the next visit.
        </p>
      ) : (
        <ul className="mt-3 grid gap-3">
          {patient.contacts.map((contact) => (
            <li key={contact.id}>
              <p className="text-ink text-[0.875rem]">
                {contact.name}
                <span className="text-muted"> · {contact.relation}</span>
              </p>
              <p className="text-muted text-[0.8125rem]">
                {contact.phone}
                {contact.isEmergency ? ' · emergency' : ''}
                {contact.isGuardian ? ' · may consent' : ''}
              </p>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

function ConditionsPanel({
  slug,
  patientId,
  conditions,
  canWrite,
  open,
  onToggle,
}: {
  slug: string;
  patientId: string;
  conditions: PatientConditionDetail[];
  canWrite: boolean;
  open: boolean;
  onToggle: () => void;
}) {
  return (
    <Card>
      <PanelHeading
        title="Problems"
        action={
          canWrite ? (
            <Button variant="secondary" size="sm" onClick={onToggle} aria-expanded={open}>
              Add
            </Button>
          ) : null
        }
      />

      {open ? (
        <div className="mt-4">
          <ConditionForm slug={slug} patientId={patientId} />
        </div>
      ) : null}

      {conditions.length === 0 ? (
        <p className="text-muted mt-3 text-[0.8125rem]">Nothing recorded.</p>
      ) : (
        <ul className="mt-3 grid gap-2">
          {conditions.map((condition) => (
            <li key={condition.id} className="flex items-baseline justify-between gap-3">
              <div>
                <p className="text-ink text-[0.875rem]">{condition.conditionText}</p>
                <p className="text-muted text-[0.75rem]">
                  {condition.status === 'CHRONIC' ? 'Long-term' : condition.status.toLowerCase()}
                  {condition.onsetDate !== null ? ` · since ${condition.onsetDate}` : ''}
                  {condition.notedByName !== null ? ` · ${condition.notedByName}` : ''}
                </p>
              </div>
              {canWrite ? (
                <form action={removeCondition.bind(null, slug, patientId, condition.id)}>
                  <Button type="submit" variant="ghost" size="sm">
                    Withdraw
                  </Button>
                </form>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

function MedicationsPanel({
  slug,
  patientId,
  medications,
  canWrite,
  open,
  onToggle,
}: {
  slug: string;
  patientId: string;
  medications: PatientMedicationDetail[];
  canWrite: boolean;
  open: boolean;
  onToggle: () => void;
}) {
  return (
    <Card>
      <PanelHeading
        title="Medicines"
        note="Including anything prescribed elsewhere."
        action={
          canWrite ? (
            <Button variant="secondary" size="sm" onClick={onToggle} aria-expanded={open}>
              Add
            </Button>
          ) : null
        }
      />

      {open ? (
        <div className="mt-4">
          <MedicationForm slug={slug} patientId={patientId} />
        </div>
      ) : null}

      {medications.length === 0 ? (
        <p className="text-muted mt-3 text-[0.8125rem]">Nothing recorded.</p>
      ) : (
        <ul className="mt-3 grid gap-2">
          {medications.map((medication) => (
            <li key={medication.id} className="flex items-baseline justify-between gap-3">
              <div>
                <p className="text-ink text-[0.875rem]">
                  {medication.medicineText}
                  {medication.dosage !== null ? (
                    <span className="text-muted"> · {medication.dosage}</span>
                  ) : null}
                </p>
                <p className="text-muted text-[0.75rem]">
                  {medication.isOngoing
                    ? 'Still taking'
                    : `Stopped${medication.stoppedOn !== null ? ` ${medication.stoppedOn}` : ''}`}
                </p>
              </div>
              {canWrite && medication.isOngoing ? (
                <form action={stopMedication.bind(null, slug, patientId, medication.id)}>
                  <Button type="submit" variant="ghost" size="sm">
                    Stop
                  </Button>
                </form>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

function AllergyRows({
  slug,
  patientId,
  allergies,
  canWrite,
}: {
  slug: string;
  patientId: string;
  allergies: PatientAllergyDetail[];
  canWrite: boolean;
}) {
  if (allergies.length === 0) {
    return <p className="text-muted mt-3 text-[0.8125rem]">Nothing recorded.</p>;
  }

  return (
    <ul className="mt-3 grid gap-2">
      {allergies.map((allergy) => (
        <li key={allergy.id} className="flex items-baseline justify-between gap-3">
          <div>
            <p className="text-ink text-[0.875rem]">
              {allergy.allergenText}
              <span className="text-muted">
                {' '}
                · {SEVERITY_WORDS[allergy.severity] ?? allergy.severity}
              </span>
            </p>
            <p className="text-muted text-[0.75rem]">
              {allergy.reaction ?? 'Reaction not recorded'}
              {allergy.notedByName !== null ? ` · ${allergy.notedByName}` : ''}
            </p>
          </div>
          {canWrite ? (
            <form action={removeAllergy.bind(null, slug, patientId, allergy.id)}>
              <Button type="submit" variant="ghost" size="sm">
                Withdraw
              </Button>
            </form>
          ) : null}
        </li>
      ))}
    </ul>
  );
}

// ---------------------------------------------------------------------------
// Forms
// ---------------------------------------------------------------------------

/**
 * Correcting the identity half of a record — every field the update contract
 * accepts, which is every field on `patients` that is not issued by the system
 * or moved by a call of its own.
 *
 * ⚠️ WHAT IS DELIBERATELY NOT HERE, so the absences read as decisions:
 *   - `uhid` and the branch record numbers are issued, never typed.
 *   - `branchId` is a REGISTRATION, not an edit — "Register at another clinic"
 *     above, because a patient attends a second branch rather than moving.
 *   - `subjectType` is refused by the contract: a record registered as the
 *     wrong kind is a merge, not an edit.
 *   - `status` is refused for the same reason — DECEASED and MERGED each carry
 *     a second field that has to move with them.
 *   - Addresses and contacts are their own rows with their own endpoints.
 *
 * ⚠️ AN EMPTY BOX MEANS "UNCHANGED", NOT "CLEAR IT". `updatePatientRequest` is
 *   `.partial()` over optional strings with no nulls in it, so the action omits
 *   whatever was left blank and the stored value stands. Deleting a phone
 *   number is not something this form can express today, and pretending
 *   otherwise — submitting `''` — would be refused by `contactPhone` as a
 *   validation error about a field the user had just emptied on purpose.
 */
function EditForm({
  slug,
  patient,
  countryCode,
  onSaved,
  onCancel,
}: {
  slug: string;
  patient: PatientDetail;
  countryCode: string;
  /** Collapse the panel and say so. Must be stable — see the effect below. */
  onSaved: () => void;
  onCancel: () => void;
}) {
  const [state, action, pending] = useActionState(updatePatient.bind(null, slug, patient.id), IDLE);
  const isAnimal = patient.subjectType === 'ANIMAL';

  /*
   * On a failed submit, put the user on the first field at fault — or on the
   * message when the failure names no field (apps/web/AGENTS.md). Eleven fields
   * is exactly the form where an error scrolled off the top goes unread.
   */
  const formRef = useRef<HTMLFormElement>(null);
  useOutcomeFocus(state.status, formRef);

  /*
   * Close the panel once the write has landed. In an EFFECT and not in render:
   * calling a parent's setState while rendering a child is what produces
   * "Cannot update a component while rendering a different component". The same
   * arrangement `branch-list.tsx` and `doctor-create-form.tsx` use.
   */
  useEffect(() => {
    if (state.status === 'saved') onSaved();
  }, [state.status, onSaved]);

  /*
   * The date of birth is controlled so the approximate age can disappear the
   * moment one is typed — the same arrangement as the registration form, and
   * for the same reason: the contract refuses the pair, mirroring the
   * `patients_age_single_source` CHECK. UNMOUNTED rather than disabled, because
   * an unmounted input submits nothing on every browser.
   */
  const [dob, setDob] = useState(patient.dateOfBirth ?? '');

  /*
   * The stored number is E.164; the control wants it split back into a calling
   * code and national digits. An unmatched code keeps its digits and falls back
   * to the clinic's country rather than blanking the field.
   */
  const stored = splitE164(patient.phone);
  const [phoneCountry, setPhoneCountry] = useState(stored.countryCode ?? countryCode);
  const [phone, setPhone] = useState(stored.national);

  const err = (field: string): string[] | undefined => state.fieldErrors?.[field];

  return (
    <form ref={formRef} action={action} className="grid gap-4">
      {state.status === 'error' && state.message ? (
        <Alert tone="error">{state.message}</Alert>
      ) : null}

      <div className="grid gap-4 sm:grid-cols-2">
        <Input
          name="firstName"
          label={isAnimal ? 'Name' : 'First name'}
          defaultValue={patient.firstName}
          autoComplete="off"
          {...(err('firstName') ? { errors: err('firstName') } : {})}
        />
        <Input
          name="lastName"
          label={isAnimal ? 'Household name' : 'Last name'}
          defaultValue={patient.lastName ?? ''}
          autoComplete="off"
          {...(err('lastName') ? { errors: err('lastName') } : {})}
        />

        <Input
          name="dateOfBirth"
          label="Date of birth"
          type="date"
          value={dob}
          onChange={(event) => setDob(event.target.value)}
          // Nobody is born tomorrow. Stops a typo becoming a negative age.
          max={new Date().toISOString().slice(0, 10)}
          {...(patient.ageIsApproximate ? { hint: 'Replaces the estimated age.' } : {})}
          {...(err('dateOfBirth') ? { errors: err('dateOfBirth') } : {})}
        />
        {dob === '' ? (
          <Input
            name="approxAgeYears"
            label="…or age in years"
            type="number"
            inputMode="numeric"
            min={0}
            max={130}
            defaultValue={patient.approxAgeYears ?? ''}
            hint="Only if the date of birth is not known."
            {...(err('approxAgeYears') ? { errors: err('approxAgeYears') } : {})}
          />
        ) : (
          <div aria-hidden="true" />
        )}

        <Select name="gender" label="Sex" options={GENDERS} defaultValue={patient.gender} />

        {/*
          ⚠️ NO BLOOD GROUP AND NO MARITAL STATUS ON AN ANIMAL, for the reason
            `IdentityStrip` gives above: `bloodGroupValues` is the human ABO/Rh
            taxonomy, and neither question has an answer about a dog. Offering
            them reads as a gap in the record somebody ought to fill in.
        */}
        {isAnimal ? null : (
          <>
            <Select
              name="bloodGroup"
              label="Blood group"
              options={BLOOD_GROUPS}
              defaultValue={patient.bloodGroup}
            />
            <Select
              name="maritalStatus"
              label="Marital status"
              options={MARITAL_STATUSES}
              defaultValue={patient.maritalStatus}
            />
          </>
        )}

        {/*
         * One control, not two fields — see PhoneInput. The calling code is
         * selectable because a patient may be a visitor, and it starts on
         * whatever the stored number actually says rather than on the clinic's
         * own country.
         */}
        <Field name="phone" label="Phone" {...(err('phone') ? { errors: err('phone') } : {})}>
          <PhoneInput
            id="phone"
            name="phone"
            countryCode={phoneCountry}
            national={phone}
            onCountryChange={setPhoneCountry}
            onNationalChange={setPhone}
            autoComplete="off"
            invalid={Boolean(err('phone'))}
            describedBy={describedBy('phone', false, Boolean(err('phone')))}
          />
        </Field>
        <Input
          name="email"
          label="Email"
          type="email"
          defaultValue={patient.email ?? ''}
          autoComplete="off"
          {...(err('email') ? { errors: err('email') } : {})}
        />

        <Input
          name="abhaNumber"
          label="ABHA number"
          defaultValue={patient.abhaNumber ?? ''}
          autoComplete="off"
          className="font-mono"
          hint="14 digits, or an address like someone@abdm. One per person."
          {...(err('abhaNumber') ? { errors: err('abhaNumber') } : {})}
        />
        {/*
         * The document list is the CLINIC's country, not the patient's — the
         * same list the registration desk was offered, so a record edited here
         * cannot acquire a type that screen could never have produced. It always
         * ends with Passport and "Something else".
         */}
        <NationalIdInput
          countryCode={countryCode}
          typeName="nationalIdType"
          valueName="nationalId"
          defaultType={patient.nationalIdType}
          defaultValue={patient.nationalId}
          {...(err('nationalId') ? { errors: err('nationalId') } : {})}
        />
      </div>

      <div className="border-rule flex flex-wrap gap-3 border-t pt-5">
        <Button type="submit" disabled={pending}>
          {pending ? 'Saving…' : 'Save changes'}
        </Button>
        {/*
          Nothing is kept: the panel unmounts, so reopening it reads the stored
          record again rather than whatever was half-typed. That is the point of
          a cancel — "leave the record as it is" — and it is why there is no
          confirmation on it.
        */}
        <Button type="button" variant="ghost" onClick={onCancel} disabled={pending}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

function BranchForm({
  slug,
  patientId,
  branches,
}: {
  slug: string;
  patientId: string;
  branches: BranchChoice[];
}) {
  const [state, action, pending] = useActionState(
    registerAtBranch.bind(null, slug, patientId),
    IDLE
  );

  return (
    <form action={action} className="grid gap-4">
      {state.status === 'error' && state.message ? (
        <Alert tone="error">{state.message}</Alert>
      ) : null}

      <Select
        name="branchId"
        label="Clinic"
        required
        options={branches.map((b) => ({ value: b.id, label: b.name }))}
        hint="They keep this hospital number and get a new record number."
      />

      <div>
        <Button type="submit" disabled={pending}>
          {pending ? 'Registering…' : 'Register here too'}
        </Button>
      </div>
    </form>
  );
}

/**
 * Species, breed, weight and owner.
 *
 * ⚠️ EVERY FIELD IS RENDERED AND PRE-FILLED, INCLUDING THE ONES THAT ARE EMPTY,
 *   BECAUSE THE ENDPOINT IS A `PUT`. It replaces the profile, so a field left
 *   out of the form would be a field cleared on save. Rendering this as "add
 *   what is missing" would quietly delete what is already there.
 *
 * ⚠️ THE WEIGHT AND ITS DATE ARE ONE ANSWER AND ARE PRESENTED AS ONE. The
 *   contract refuses either without the other, and the date defaults to nothing
 *   rather than to today: pre-filling today's date would let somebody save a
 *   three-month-old weight stamped as taken this morning, which is exactly the
 *   fact the stale-weight signal exists to surface.
 */
function AnimalForm({ slug, patient }: { slug: string; patient: PatientDetail }) {
  const [state, action, pending] = useActionState(
    saveAnimalProfile.bind(null, slug, patient.id),
    IDLE
  );
  const profile = patient.animalProfile;

  return (
    <form action={action} className="grid gap-4">
      {state.status === 'error' && state.message ? (
        <Alert tone="error">{state.message}</Alert>
      ) : null}

      <div className="grid gap-4 sm:grid-cols-2">
        <Input
          name="species"
          label="Species"
          defaultValue={profile?.species ?? ''}
          hint="Whatever you call it — dog, cat, tortoise."
          {...(state.fieldErrors?.['species'] ? { errors: state.fieldErrors['species'] } : {})}
        />
        <Input
          name="breed"
          label="Breed"
          defaultValue={profile?.breed ?? ''}
          {...(state.fieldErrors?.['breed'] ? { errors: state.fieldErrors['breed'] } : {})}
        />
        <Input
          name="weightKg"
          label="Weight in kg"
          inputMode="decimal"
          defaultValue={profile?.weightKg ?? ''}
          hint="Doses are calculated from this."
          {...(state.fieldErrors?.['weightKg'] ? { errors: state.fieldErrors['weightKg'] } : {})}
        />
        <Input
          name="weightRecordedOn"
          label="Weighed on"
          type="date"
          defaultValue={profile?.weightRecordedOn ?? ''}
          hint="The day it went on the scales, not today."
          {...(state.fieldErrors?.['weightRecordedOn']
            ? { errors: state.fieldErrors['weightRecordedOn'] }
            : {})}
        />
      </div>

      {/*
        The owner is one form or the other. A contact already on this record is
        the better answer — it is one owner, kept in one place — so it is offered
        first, and the free-text pair below it is for the walk-in whose owner is
        not on the record yet. Choosing a contact makes the typed fields ignored;
        the hint says so rather than leaving somebody to discover it.
      */}
      {patient.contacts.length > 0 ? (
        <Select
          name="guardianContactId"
          label="Owner"
          placeholder="Not one of the contacts below"
          defaultValue={profile?.guardianContactId ?? ''}
          options={patient.contacts.map((contact) => ({
            value: contact.id,
            label: `${contact.name} · ${contact.relation}`,
          }))}
          hint="Someone already on this record. Picking one here ignores the typed name."
          {...(state.fieldErrors?.['guardianContactId']
            ? { errors: state.fieldErrors['guardianContactId'] }
            : {})}
        />
      ) : null}

      <div className="grid gap-4 sm:grid-cols-2">
        <Input
          name="guardianName"
          label="Owner’s name"
          defaultValue={profile?.guardianContactId === null ? (profile.guardianName ?? '') : ''}
          {...(state.fieldErrors?.['guardianName']
            ? { errors: state.fieldErrors['guardianName'] }
            : {})}
        />
        <Input
          name="guardianPhone"
          label="Owner’s phone"
          type="tel"
          defaultValue={profile?.guardianContactId === null ? (profile.guardianPhone ?? '') : ''}
          {...(state.fieldErrors?.['guardianPhone']
            ? { errors: state.fieldErrors['guardianPhone'] }
            : {})}
        />
      </div>

      <div>
        <Button type="submit" disabled={pending}>
          {pending ? 'Saving…' : 'Save animal details'}
        </Button>
      </div>
    </form>
  );
}

/**
 * "How much do I give?"
 *
 * ⚠️ THERE IS NO WEIGHT FIELD, AND ITS ABSENCE IS THE ENTIRE POINT OF THE PANEL.
 *   The server reads the weight off the record, so the answer cannot be computed
 *   from a number somebody retyped — and the panel states which weight it used
 *   and when it was taken, above the answer rather than below it.
 *
 * ⚠️ NOTHING HERE IS A RECOMMENDATION. Every figure typed in comes from a
 *   clinician reading a label; this multiplies them. The copy says "Calculate",
 *   never "Suggested dose", because the second would claim an authority the
 *   platform does not have and has no formulary behind.
 */
function DoseCalculator({
  slug,
  patientId,
  profile,
  className,
}: {
  slug: string;
  patientId: string;
  profile: AnimalProfileDetail | null;
  className?: string;
}) {
  const [state, action, pending] = useActionState(
    calculateDose.bind(null, slug, patientId),
    DOSE_IDLE
  );

  return (
    <Card className={className}>
      <PanelHeading
        title="Dose calculator"
        note="Multiplies the weight on this record by a rate you enter. It records nothing."
      />

      {profile === null || profile.weightKg === null ? (
        <p className="text-muted mt-4 text-[0.8125rem]">
          Record a weight for this animal before calculating a dose from it.
        </p>
      ) : (
        <form action={action} className="mt-4 grid gap-4">
          {state.status === 'error' && state.message ? (
            <Alert tone="error">{state.message}</Alert>
          ) : null}

          <p className="text-muted text-[0.8125rem]">
            Using <span className="text-ink font-medium">{profile.weightKg} kg</span>
            {profile.weightRecordedOn !== null
              ? `, weighed ${profile.weightRecordedOn}`
              : ', with no date recorded'}
            .
          </p>

          {/*
            ⚠️ BOTH CEILINGS ARE OFFERED, and the single-dose one is not
              decorative: it is the more commonly printed limit on a veterinary
              label, and without the input `cappedBy: 'SINGLE'` was a state the
              answer below could describe and this form could never produce
              (PI-11 review).
          */}
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            <Input
              name="dosePerKg"
              label="Per kg"
              required
              inputMode="decimal"
              {...(state.fieldErrors?.['dosePerKg']
                ? { errors: state.fieldErrors['dosePerKg'] }
                : {})}
            />
            <Input
              name="unit"
              label="Unit"
              required
              defaultValue="mg"
              hint="Echoed back. Nothing is converted."
              {...(state.fieldErrors?.['unit'] ? { errors: state.fieldErrors['unit'] } : {})}
            />
            <Input
              name="dosesPerDay"
              label="Doses a day"
              type="number"
              min={1}
              max={24}
              {...(state.fieldErrors?.['dosesPerDay']
                ? { errors: state.fieldErrors['dosesPerDay'] }
                : {})}
            />
            <Input
              name="maxSingleDose"
              label="Single-dose maximum"
              inputMode="decimal"
              hint="From the label, if it states one."
              {...(state.fieldErrors?.['maxSingleDose']
                ? { errors: state.fieldErrors['maxSingleDose'] }
                : {})}
            />
            <Input
              name="maxDailyDose"
              label="Daily maximum"
              inputMode="decimal"
              hint="Needs the doses a day."
              {...(state.fieldErrors?.['maxDailyDose']
                ? { errors: state.fieldErrors['maxDailyDose'] }
                : {})}
            />
          </div>

          <div>
            <Button type="submit" disabled={pending}>
              {pending ? 'Calculating…' : 'Calculate'}
            </Button>
          </div>

          {state.status === 'done' && state.dose ? <DoseAnswer dose={state.dose} /> : null}
        </form>
      )}
    </Card>
  );
}

/**
 * The answer.
 *
 * ⚠️ A CAP IS PART OF THE ANSWER AND IS PRINTED WITH IT, NOT UNDER IT. When a
 *   ceiling bound, `singleDose` IS the capped figure — a screen that showed the
 *   uncapped number with a footnote would be showing a dose the label prohibits.
 *   The sentence names which ceiling, so somebody can go back to the right line
 *   of the label.
 */
function DoseAnswer({ dose }: { dose: NonNullable<DoseState['dose']> }) {
  return (
    <div className="border-rule bg-drape-tint/30 rounded-md border px-4 py-3" aria-live="polite">
      <p className="text-ink text-[1.25rem] font-medium">
        {dose.singleDose} {dose.unit}
        <span className="text-muted text-[0.8125rem] font-normal"> each dose</span>
      </p>
      {dose.dailyDose !== null ? (
        <p className="text-muted text-[0.8125rem]">
          {dose.dailyDose} {dose.unit} a day in total
        </p>
      ) : null}
      {dose.cappedBy !== null ? (
        <p className="text-signal mt-1 text-[0.8125rem]">
          Held to the {dose.cappedBy === 'DAILY' ? 'daily' : 'single-dose'} maximum you entered.
        </p>
      ) : null}
      {!dose.exact ? (
        <p className="text-muted mt-1 text-[0.75rem]">Rounded down to three decimal places.</p>
      ) : null}
      {dose.weightIsStale ? (
        <p className="text-signal mt-1 text-[0.8125rem]">
          This weight is old. Weigh the animal again before giving this.
        </p>
      ) : null}
    </div>
  );
}

function AllergyForm({ slug, patientId }: { slug: string; patientId: string }) {
  const [state, action, pending] = useActionState(addAllergy.bind(null, slug, patientId), IDLE);

  return (
    <form action={action} className="grid gap-4">
      {state.status === 'error' && state.message ? (
        <Alert tone="error">{state.message}</Alert>
      ) : null}

      <div className="grid gap-4 sm:grid-cols-2">
        <Input
          name="allergenText"
          label="What they react to"
          required
          placeholder="Penicillin"
          autoComplete="off"
        />
        <Select name="allergenType" label="Kind" options={ALLERGEN_TYPES} defaultValue="DRUG" />
        <Select name="severity" label="How badly" options={SEVERITIES} defaultValue="MODERATE" />
        <Input name="reaction" label="What happens" placeholder="Rash" autoComplete="off" />
      </div>

      <div>
        <Button type="submit" disabled={pending}>
          {pending ? 'Recording…' : 'Record allergy'}
        </Button>
      </div>
    </form>
  );
}

function ConditionForm({ slug, patientId }: { slug: string; patientId: string }) {
  const [state, action, pending] = useActionState(addCondition.bind(null, slug, patientId), IDLE);

  return (
    <form action={action} className="grid gap-4">
      {state.status === 'error' && state.message ? (
        <Alert tone="error">{state.message}</Alert>
      ) : null}

      <div className="grid gap-4 sm:grid-cols-2">
        <Input
          name="conditionText"
          label="Condition"
          required
          placeholder="Type 2 diabetes"
          autoComplete="off"
        />
        <Select name="status" label="Status" options={CONDITION_STATUSES} defaultValue="ACTIVE" />
        <Input name="onsetDate" label="Since" type="date" />
      </div>

      <div>
        <Button type="submit" disabled={pending}>
          {pending ? 'Recording…' : 'Record condition'}
        </Button>
      </div>
    </form>
  );
}

function MedicationForm({ slug, patientId }: { slug: string; patientId: string }) {
  const [state, action, pending] = useActionState(addMedication.bind(null, slug, patientId), IDLE);

  return (
    <form action={action} className="grid gap-4">
      {state.status === 'error' && state.message ? (
        <Alert tone="error">{state.message}</Alert>
      ) : null}

      <div className="grid gap-4 sm:grid-cols-3">
        <Input
          name="medicineText"
          label="Medicine"
          required
          placeholder="Metformin 500mg"
          autoComplete="off"
        />
        <Input
          name="dosage"
          label="How they take it"
          placeholder="Twice daily after food"
          autoComplete="off"
        />
        <Input name="startedOn" label="Started" type="date" />
      </div>

      <div>
        <Button type="submit" disabled={pending}>
          {pending ? 'Recording…' : 'Record medicine'}
        </Button>
      </div>
    </form>
  );
}
