'use client';

import Link from 'next/link';
import { useActionState, useState } from 'react';
import type {
  PatientAllergyDetail,
  PatientConditionDetail,
  PatientDetail,
  PatientHistoryResponse,
  PatientMedicationDetail,
} from '@rcln/contracts';
import { Input, Select, type SelectOption } from '@/components/ui/field';
import { Button } from '@/components/ui/button';
import { Alert } from '@/components/ui/alert';
import { RecordHistory } from '@/components/tenant/record-history';
import { type BranchChoice } from '@/components/tenant/patient-search';
import { ageLine } from '@/lib/patient-words';
import {
  addAllergy,
  addCondition,
  addMedication,
  registerAtBranch,
  removeAllergy,
  removeCondition,
  stopMedication,
  updatePatient,
  type PatientFormState,
} from '@/app/(tenant)/t/[slug]/(app)/patients/actions';

const IDLE: PatientFormState = { status: 'idle' };

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
  canReadHistory,
  canUpdate,
  canCreate,
  canWriteHistory,
  canReadAudit,
}: {
  slug: string;
  patient: PatientDetail;
  history: PatientHistoryResponse | null;
  branches: BranchChoice[];
  canReadHistory: boolean;
  canUpdate: boolean;
  canCreate: boolean;
  canWriteHistory: boolean;
  canReadAudit: boolean;
}) {
  const [panel, setPanel] = useState<
    'none' | 'edit' | 'branch' | 'allergy' | 'condition' | 'medicine'
  >('none');
  const toggle = (next: Exclude<typeof panel, 'none'>) =>
    setPanel((current) => (current === next ? 'none' : next));

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
        {canReadAudit ? (
          <RecordHistory
            slug={slug}
            entityType="patient"
            entityId={patient.id}
            label={patient.uhid}
          />
        ) : null}
      </div>

      {panel === 'edit' ? (
        <Card className="mt-4">
          <EditForm slug={slug} patient={patient} />
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

        <p className="text-muted mt-2 text-[0.9375rem]">
          {ageLine(patient)}
          {' · Blood group '}
          {BLOOD_WORDS[patient.bloodGroup] ?? 'Not known'}
        </p>

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

function EditForm({ slug, patient }: { slug: string; patient: PatientDetail }) {
  const [state, action, pending] = useActionState(updatePatient.bind(null, slug, patient.id), IDLE);

  return (
    <form action={action} className="grid gap-4">
      {state.status === 'error' && state.message ? (
        <Alert tone="error">{state.message}</Alert>
      ) : null}

      <div className="grid gap-4 sm:grid-cols-2">
        <Input name="firstName" label="First name" defaultValue={patient.firstName} />
        <Input name="lastName" label="Last name" defaultValue={patient.lastName ?? ''} />
        <Input name="phone" label="Phone" type="tel" defaultValue={patient.phone ?? ''} />
        <Input name="email" label="Email" type="email" defaultValue={patient.email ?? ''} />
        <Input
          name="dateOfBirth"
          label="Date of birth"
          type="date"
          defaultValue={patient.dateOfBirth ?? ''}
          hint={patient.ageIsApproximate ? 'Replaces the estimated age.' : undefined}
        />
      </div>

      <div>
        <Button type="submit" disabled={pending}>
          {pending ? 'Saving…' : 'Save changes'}
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
