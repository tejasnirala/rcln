'use client';

import { useActionState, useState } from 'react';
import Link from 'next/link';
import type { PharmacyPrescriptionDetail } from '@rcln/contracts';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/field';
import {
  cancelFulfilmentAction,
  IDLE_FORM,
  verifyPrescriptionAction,
  type PharmacyFormState,
} from '@/app/(tenant)/t/[slug]/(app)/pharmacy/actions';

/**
 * One prescription, read-only, with the two things a dispensary may do about it.
 *
 * ⚠️ NOTHING ON THIS SCREEN EDITS THE PRESCRIPTION, AND THERE IS NO CONTROL THAT
 *   COULD (invariant 7). A pharmacist who needs a dose changed rings the
 *   prescriber; that is a workflow, and pretending it is a form field would put
 *   the dispensary inside the clinical record.
 *
 * ⚠️ "CHECK" AND "STAND DOWN" ARE THE TWO ACTS, AND THEY ARE NAMED FOR WHAT THEY
 *   DO. Standing down says this dispensary is not going to supply it; it does not
 *   withdraw the prescription, and the copy says so where somebody is about to
 *   press it.
 *
 * ⚠️ PHI. All of it.
 */
interface Props {
  slug: string;
  prescription: PharmacyPrescriptionDetail;
  canVerify: boolean;
  canDispense: boolean;
}

const STATUS_LABEL: Record<string, string> = {
  NEW: 'Not looked at',
  VERIFIED: 'Checked',
  PARTIALLY_DISPENSED: 'Part supplied',
  COMPLETED: 'Finished',
  CANCELLED: 'Stood down',
};

export function PharmacyPrescription({ slug, prescription, canVerify, canDispense }: Props) {
  const [standingDown, setStandingDown] = useState(false);

  const [verifyState, verify, verifying] = useActionState<PharmacyFormState, FormData>(
    (previous, form) => verifyPrescriptionAction(slug, prescription.encounterId, previous, form),
    IDLE_FORM
  );
  const [cancelState, cancel, cancelling] = useActionState<PharmacyFormState, FormData>(
    (previous, form) => cancelFulfilmentAction(slug, prescription.encounterId, previous, form),
    IDLE_FORM
  );

  return (
    <div className="space-y-8">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="font-display text-ink text-[1.75rem] leading-tight tracking-tight">
            {prescription.patientName}
          </h1>
          <p className="text-muted mt-1 text-[0.875rem]">
            {prescription.patientUhid}
            {prescription.patientAgeYears !== null
              ? ` · ${prescription.patientAgeYears} years`
              : ''}
            {prescription.patientSubjectType === 'ANIMAL' ? ' · animal patient' : ''} ·{' '}
            {prescription.branchName}
          </p>
          <p className="text-muted mt-1 text-[0.875rem]">
            Prescribed by {prescription.prescriberName ?? 'a clinician at this clinic'}
            {prescription.prescriberRegistrationNumber
              ? ` (${prescription.prescriberRegistrationNumber})`
              : ''}
            {prescription.encounterNumber ? ` · ${prescription.encounterNumber}` : ''}
          </p>
        </div>
        <div className="flex items-center gap-3">
          <span className="border-rule text-muted rounded-full border px-3 py-1 text-[0.8125rem]">
            {STATUS_LABEL[prescription.status] ?? prescription.status}
          </span>
          {canDispense && prescription.isDispensable ? (
            <Link
              href={`/pharmacy/prescriptions/${prescription.encounterId}/dispense`}
              className="bg-drape text-paper hover:bg-drape-deep inline-flex items-center justify-center rounded-md px-5 py-3 text-[0.9375rem] font-medium transition-colors duration-150"
            >
              Dispense
            </Link>
          ) : null}
        </div>
      </header>

      {!prescription.isDispensable ? (
        <Alert tone="warning">
          {prescription.encounterStatus === 'DRAFT'
            ? 'The doctor has not signed this consultation yet, so there is no prescription to supply against.'
            : 'A later consultation supersedes this one, or it was cancelled. Ask the prescriber for a current prescription.'}
        </Alert>
      ) : null}

      {prescription.callerIsPrescriber ? (
        <Alert tone="info">
          You wrote this prescription. Some jurisdictions treat a practitioner dispensing to their
          own patients differently, and the rules are applied accordingly when you supply.
        </Alert>
      ) : null}

      <section className="space-y-2">
        <h2 className="text-ink text-[1.125rem] font-medium">What was prescribed</h2>
        <ul className="space-y-2">
          {prescription.items.map((item) => (
            <li key={item.id} className="border-rule bg-card rounded-md border p-4">
              <div className="flex flex-wrap items-start justify-between gap-4">
                <div>
                  <p className="text-ink text-[1rem] font-medium">
                    {item.productName}
                    {item.strength ? ` · ${item.strength}` : ''}
                  </p>
                  <p className="text-muted text-[0.875rem]">
                    {[
                      item.dose && item.doseUnit ? `${item.dose} ${item.doseUnit}` : null,
                      item.route,
                      item.frequency && item.frequencyUnit
                        ? `${item.frequency}× per ${item.frequencyUnit.toLowerCase()}`
                        : null,
                      item.durationValue && item.durationUnit
                        ? `for ${item.durationValue} ${item.durationUnit.toLowerCase()}`
                        : null,
                      item.foodRelation,
                      item.timing,
                      item.isPrn ? 'as needed' : null,
                    ]
                      .filter(Boolean)
                      .join(' · ')}
                  </p>
                  {item.instructions ? (
                    <p className="text-muted mt-1 text-[0.875rem] italic">“{item.instructions}”</p>
                  ) : null}
                  {/*
                    Offered on every line rather than only on the short ones: a
                    pharmacist asks "what else is there" for reasons a stock level
                    does not know about — a patient's own brand, a shortage
                    somewhere else, a formulation they cannot swallow.
                  */}
                  <Link
                    href={`/pharmacy/prescriptions/${prescription.encounterId}/substitutions/${item.productId}`}
                    className="text-muted hover:text-ink mt-2 inline-block text-[0.875rem] underline underline-offset-4"
                  >
                    What else is equivalent?
                  </Link>
                </div>
                <dl className="text-[0.875rem] tabular-nums">
                  <div className="flex gap-2">
                    <dt className="text-muted">Prescribed</dt>
                    <dd className="text-ink">
                      {item.quantityBase ?? 'not stated'}{' '}
                      {item.quantityBase ? item.baseUnitSymbol : ''}
                    </dd>
                  </div>
                  <div className="flex gap-2">
                    <dt className="text-muted">Supplied</dt>
                    <dd className="text-ink">
                      {item.dispensedQuantityBase} {item.baseUnitSymbol}
                    </dd>
                  </div>
                  <div className="flex gap-2">
                    <dt className="text-muted">On the shelf</dt>
                    <dd
                      className={
                        Number(item.availableQuantityBase) > 0 ? 'text-ink' : 'text-signal'
                      }
                    >
                      {item.availableQuantityBase} {item.baseUnitSymbol}
                    </dd>
                  </div>
                </dl>
              </div>
            </li>
          ))}
        </ul>
      </section>

      {canVerify && prescription.isDispensable ? (
        <section className="border-rule bg-card space-y-4 rounded-md border p-4">
          <h2 className="text-ink text-[1.125rem] font-medium">Check this prescription</h2>
          {verifyState.status === 'error' ? (
            <Alert tone="error">{verifyState.message}</Alert>
          ) : null}
          {verifyState.status === 'saved' ? (
            <Alert tone="success">Checked. It is ready to hand over.</Alert>
          ) : null}
          <form action={verify} className="flex flex-wrap items-end gap-3">
            <input type="hidden" name="branchId" value={prescription.branchId} />
            <Input
              label="Anything worth recording"
              name="notes"
              fieldClassName="min-w-64 flex-1"
              defaultValue={prescription.fulfilmentNotes ?? ''}
              placeholder="Rang the prescriber about the dose"
            />
            <Button type="submit" variant="secondary" disabled={verifying}>
              {verifying ? 'Recording…' : 'Mark as checked'}
            </Button>
          </form>

          {standingDown ? (
            <form action={cancel} className="border-rule space-y-3 border-t pt-4">
              <input type="hidden" name="branchId" value={prescription.branchId} />
              <p className="text-muted text-[0.875rem]">
                This says the dispensary is not supplying it. It does not withdraw the prescription
                — only the prescriber can do that.
              </p>
              {cancelState.status === 'error' ? (
                <Alert tone="error">{cancelState.message}</Alert>
              ) : null}
              <div className="flex flex-wrap items-end gap-3">
                <Input
                  label="Why"
                  name="reason"
                  fieldClassName="min-w-64 flex-1"
                  required
                  minLength={4}
                  placeholder="Patient took it elsewhere"
                />
                <Button type="submit" variant="secondary" disabled={cancelling}>
                  {cancelling ? 'Standing down…' : 'Stand it down'}
                </Button>
              </div>
            </form>
          ) : (
            <button
              type="button"
              onClick={() => setStandingDown(true)}
              className="text-muted hover:text-ink text-[0.875rem] underline underline-offset-4"
            >
              Not supplying this?
            </button>
          )}
        </section>
      ) : null}
    </div>
  );
}
