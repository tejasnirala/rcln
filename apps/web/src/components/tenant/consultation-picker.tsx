'use client';

import { useEffect, useId, useState, useTransition } from 'react';
import { Select } from '@/components/ui/field';
import { Alert } from '@/components/ui/alert';
import {
  consultationsForPatient,
  type ConsultationSearchState,
} from '@/app/(tenant)/t/[slug]/(app)/lookup-actions';
import { formatClinicDate } from '@/lib/format';

/**
 * Choose the consultation an order fills the prescription for.
 *
 * ⚠️ THIS WAS A FREE-TEXT BOX ASKING FOR A UUID (KNOWN_ISSUES #33, the last half
 *   of #25). Its hint said "copy its id from the prescription queue" — which
 *   named the database's concern rather than the user's, and made the field
 *   unusable by the person taking the call. PI-23 fixed the patient half and
 *   could not fix this one, because nothing in the API listed a patient's
 *   consultations without also returning their diagnoses.
 *
 * ⚠️ A LIST, NOT A SEARCH, AND THAT IS THE DIFFERENCE FROM THE OTHER PICKERS.
 *   One patient has a handful of recent consultations, not a catalogue — so the
 *   right control is the ten most recent, loaded once the patient is known.
 *   There is nothing to type.
 *
 * ⚠️ NO PATIENT MEANS NO REQUEST. The list is a disclosure about a named person
 *   and the API logs it, so it is not fetched speculatively.
 */
interface Props {
  slug: string;
  name: string;
  /** Empty until a patient has been chosen. */
  patientId: string;
  /** The branch's zone, so a date reads as the clinic's day. */
  timeZone: string;
  errors?: string[];
  className?: string;
}

const IDLE: ConsultationSearchState = { status: 'idle' };

export function ConsultationPicker({ slug, name, patientId, timeZone, errors, className }: Props) {
  const fieldId = useId();
  /*
   * ⚠️ THE RESULT CARRIES THE PATIENT IT IS FOR, rather than being cleared when
   *   the patient changes. Clearing would mean a synchronous `setState` inside
   *   the effect, which cascades a render and which the lint rule rejects — and
   *   the reason behind the rule is real: between choosing a new patient and the
   *   fetch returning, a bare `state` still holds the PREVIOUS patient's
   *   consultations. Pairing them makes stale data unrepresentable instead of
   *   merely unlikely, which matters when the data names somebody's care.
   */
  const [loaded, setLoaded] = useState<{ forPatient: string; state: ConsultationSearchState }>({
    forPatient: '',
    state: IDLE,
  });
  const [, startTransition] = useTransition();

  useEffect(() => {
    if (patientId === '') return;
    /*
     * An effect because the trigger is a PROP changing, not an event: the
     * patient is chosen in a sibling component. This is the "synchronise with
     * something outside React" case an effect is actually for.
     */
    startTransition(async () => {
      const next = await consultationsForPatient(slug, patientId);
      setLoaded({ forPatient: patientId, state: next });
    });
  }, [slug, patientId]);

  /* Anything belonging to a different patient is not this patient's answer. */
  const state: ConsultationSearchState = loaded.forPatient === patientId ? loaded.state : IDLE;

  if (patientId === '') {
    return (
      <div className={className}>
        <p className="text-ink text-sm font-medium">Consultation</p>
        <p className="border-rule bg-paper text-muted mt-2 rounded-md border px-3.5 py-2.5 text-[0.9375rem]">
          Choose the patient first.
        </p>
        {/* Present but empty, so the field exists in the FormData and its own
            error lands under its own name. */}
        <input type="hidden" name={name} value="" />
      </div>
    );
  }

  if (state.status === 'error') {
    return (
      <div className={className}>
        <Alert tone="error">{state.message}</Alert>
        <input type="hidden" name={name} value="" />
      </div>
    );
  }

  const consultations = state.status === 'done' ? state.consultations : [];

  return (
    <div className={className}>
      <Select
        id={fieldId}
        label="Consultation"
        name={name}
        errors={errors}
        hint={
          consultations.length === 0 && state.status === 'done'
            ? 'This patient has no signed consultation. An order can still be taken without one.'
            : 'Optional. The signed consultation whose prescription this fills.'
        }
        options={[
          { value: '', label: 'None — this order is not against a prescription' },
          ...consultations.map((consultation) => ({
            value: consultation.id,
            /* Date, doctor and item count — what tells two consultations on one
             * day apart, without saying what was found. */
            label: `${formatClinicDate(consultation.occurredAt, timeZone)} · ${
              consultation.doctorName ?? 'Doctor not recorded'
            } · ${String(consultation.prescribedItemCount)} item${
              consultation.prescribedItemCount === 1 ? '' : 's'
            }`,
          })),
        ]}
      />
    </div>
  );
}
