'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  ConsultationSectionConfig,
  EncounterDetail,
  SaveEncounterDraftRequest,
} from '@rcln/contracts';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Input, Select, Textarea } from '@/components/ui/field';
import { cn } from '@/lib/cn';
import { FieldRenderer, type FieldValue } from '@/components/tenant/field-renderer';
import {
  amendConsultation,
  cancelConsultation,
  finalizeConsultation,
  saveConsultation,
  type ConsultationState,
} from '@/app/(tenant)/t/[slug]/(app)/appointments/consultation-actions';

/**
 * The consultation, rendered from its configuration.
 *
 * ⚠️ ONE COMPONENT PER SECTION TYPE, CHOSEN FROM A CLOSED TABLE, AND NOTHING
 *   ELSE (ARCHITECTURE.md). This is deliberately NOT "JSON controls the
 *   frontend": the template decides WHICH sections appear, in what order,
 *   labelled how and over which vocabulary — it cannot invent a section this
 *   file has no component for, and it cannot reshape one it has.
 *
 * ⚠️ AND THERE IS NO SPECIALTY ANYWHERE IN THIS FILE (§33). No dentistry branch,
 *   no hair-and-scalp branch, no `if` on a classification. The server resolved
 *   the template; this renders what it was handed. That is the whole reason
 *   adding a specialty is a configuration row rather than a screen — and the day
 *   a component starts branching on one, the next specialty costs a rewrite.
 *
 * ⚠️ WHAT IT RENDERS IS THE ENCOUNTER'S OWN FROZEN SNAPSHOT (§29), which the
 *   server sends as `configuration`. A template edited next year changes nothing
 *   about a consultation signed today.
 *
 * Quiet and conventional, per apps/web/AGENTS.md: this is a dense form filled in
 * with a patient in the room. The one structural device is the numbered spine
 * down the left — and it earns its place, because a consultation genuinely IS a
 * sequence: complaint, then what is already known, then what is found, then what
 * it means. The numbers are the order the clinician works in, not decoration.
 */

const AUTOSAVE_DELAY_MS = 1200;

type SectionAnswers = Record<string, Record<string, FieldValue>>;

interface Draft {
  chiefComplaint: string;
  durationValue: string;
  durationUnit: string;
  onset: string;
  clinicalNotes: string;
  sections: SectionAnswers;
}

function draftFrom(encounter: EncounterDetail): Draft {
  const sections: SectionAnswers = {};
  for (const answer of encounter.answers) {
    sections[answer.key] = answer.data as Record<string, FieldValue>;
  }
  return {
    chiefComplaint: encounter.chiefComplaint ?? '',
    durationValue:
      encounter.chiefComplaintDurationValue === null
        ? ''
        : String(encounter.chiefComplaintDurationValue),
    durationUnit: encounter.chiefComplaintDurationUnit ?? '',
    onset: encounter.onset ?? '',
    clinicalNotes: encounter.clinicalNotes ?? '',
    sections,
  };
}

const DURATION_UNITS = [
  { value: 'HOURS', label: 'hours' },
  { value: 'DAYS', label: 'days' },
  { value: 'WEEKS', label: 'weeks' },
  { value: 'MONTHS', label: 'months' },
  { value: 'YEARS', label: 'years' },
];

const ONSETS = [
  { value: 'SUDDEN', label: 'Sudden' },
  { value: 'GRADUAL', label: 'Gradual' },
  { value: 'UNKNOWN', label: 'Not known' },
];

/**
 * The sections whose components land in a later phase.
 *
 * ⚠️ NAMED, NOT BLANK. A clinic that configured a prescription section and sees
 *   an empty space assumes the configuration is broken; a line saying what the
 *   section is and when it arrives is the honest answer. Every one of these is a
 *   FIRST-CLASS section with its own table — they are not missing renderers, they
 *   are unbuilt features.
 */
const PENDING_SECTIONS: Record<string, string> = {
  SYMPTOMS: 'Coded symptoms arrive with the clinical content tables.',
  DIAGNOSIS: 'Diagnoses arrive with the clinical content tables.',
  PROCEDURE: 'Procedures arrive with the clinical content tables.',
  PRESCRIPTION: 'Prescribing arrives with the clinical content tables.',
  INVESTIGATION: 'Investigation orders arrive with the clinical content tables.',
  ADVICE: 'Advice arrives with the clinical content tables.',
  REFERRAL: 'Referrals arrive with the clinical content tables.',
  ATTACHMENTS: 'Attachments arrive with the clinical content tables.',
  FOLLOW_UP: 'Follow-up recommendations arrive with the clinical content tables.',
  VISUAL_MAPPING: 'The chart arrives with the visual mapping engine.',
};

export function ConsultationEngine({
  slug,
  appointmentId,
  encounter,
  canWrite,
  canFinalize,
  canAmend,
}: {
  slug: string;
  appointmentId: string;
  encounter: EncounterDetail;
  /** `clinical.encounter.create` — writing the consultation up. */
  canWrite: boolean;
  /** `clinical.encounter.close` — signing it. */
  canFinalize: boolean;
  /** `clinical.encounter.amend` — restating a signed one. */
  canAmend: boolean;
}) {
  const [draft, setDraft] = useState<Draft>(() => draftFrom(encounter));
  const [save, setSave] = useState<ConsultationState>({ status: 'idle' });
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [amending, setAmending] = useState(false);
  const [amendReason, setAmendReason] = useState('');

  const readOnly = encounter.status !== 'DRAFT' || !canWrite;

  /*
   * ⚠️ THE FIRST RENDER MUST NOT SAVE. `dirty` starts false and is set by an
   *   edit, so mounting the screen — which happens on every refresh — writes
   *   nothing and leaves `updated_at` alone.
   */
  const dirty = useRef(false);

  /*
   * ⚠️ THE DRAFT IS PASSED IN RATHER THAN READ FROM A REF. A ref written during
   *   render is the React 19 rule this used to break, and the state is already
   *   in hand at both call sites — the debounce effect closes over the render
   *   that scheduled it, and the sign button reads the current one.
   */
  const flush = useCallback(
    async (current: Draft) => {
      const patch: SaveEncounterDraftRequest = {
        chiefComplaint: current.chiefComplaint === '' ? null : current.chiefComplaint,
        chiefComplaintDurationValue:
          current.durationValue === '' ? null : Number(current.durationValue),
        chiefComplaintDurationUnit:
          current.durationUnit === ''
            ? null
            : (current.durationUnit as NonNullable<
                SaveEncounterDraftRequest['chiefComplaintDurationUnit']
              >),
        onset:
          current.onset === ''
            ? null
            : (current.onset as NonNullable<SaveEncounterDraftRequest['onset']>),
        clinicalNotes: current.clinicalNotes === '' ? null : current.clinicalNotes,
        sections: Object.entries(current.sections).map(([key, data]) => ({ key, data })),
      };

      setSave({ status: 'saving' });
      const result = await saveConsultation(slug, encounter.id, patch);
      setSave(result);
    },
    [slug, encounter.id]
  );

  /*
   * ⚠️ DEBOUNCED, AND THE ACTION DELIBERATELY DOES NOT REVALIDATE. Revalidating
   *   per keystroke re-renders this component from the server, re-mounts the
   *   inputs, throws the caret to the end and loses what was typed during the
   *   round trip (ARCHITECTURE.md). The saved-at line below is the whole of the
   *   feedback, and it is enough.
   */
  useEffect(() => {
    if (readOnly || !dirty.current) return;
    const timer = setTimeout(() => void flush(draft), AUTOSAVE_DELAY_MS);
    return () => clearTimeout(timer);
  }, [draft, flush, readOnly]);

  const edit = useCallback((change: (previous: Draft) => Draft) => {
    dirty.current = true;
    setDraft(change);
  }, []);

  const setSectionField = useCallback(
    (sectionKey: string, fieldKey: string, value: FieldValue) => {
      edit((previous) => {
        const section = { ...(previous.sections[sectionKey] ?? {}) };
        /*
         * ⚠️ AN EMPTY ANSWER IS REMOVED, NOT STORED AS "". The engine treats an
         *   empty string as blank when it checks a required field, so a stored
         *   one would be a key that renders as answered on every later read and
         *   still fails at signing.
         */
        if (value === undefined || value === '') delete section[fieldKey];
        else section[fieldKey] = value;
        return { ...previous, sections: { ...previous.sections, [sectionKey]: section } };
      });
    },
    [edit]
  );

  const sections = useMemo(
    () => [...encounter.configuration].sort((a, b) => a.order - b.order),
    [encounter.configuration]
  );

  const sign = async () => {
    setBusy(true);
    setProblem(null);
    /* Save first: the button is pressed inside the debounce window often
       enough that finalizing the unsaved draft would be the ordinary case. */
    if (dirty.current) await flush(draft);
    const result = await finalizeConsultation(slug, appointmentId, encounter.id);
    if (!result.ok) setProblem(result.message);
    setBusy(false);
  };

  const amend = async () => {
    setBusy(true);
    setProblem(null);
    const result = await amendConsultation(slug, appointmentId, encounter.id, amendReason);
    if (!result.ok) setProblem(result.message);
    else setAmending(false);
    setBusy(false);
  };

  const abandon = async () => {
    setBusy(true);
    setProblem(null);
    const result = await cancelConsultation(slug, appointmentId, encounter.id, undefined);
    if (!result.ok) setProblem(result.message);
    setBusy(false);
  };

  return (
    <section className="mt-4">
      <header className="border-rule bg-card flex flex-wrap items-baseline justify-between gap-4 rounded-lg border p-5">
        <div>
          <h2 className="font-display text-xl tracking-tight">Consultation</h2>
          <p className="text-muted mt-1 text-[0.8125rem]">{STATUS_WORDS[encounter.status]}</p>
        </div>
        {encounter.encounterNumber === null ? null : (
          <p className="font-mono text-[0.8125rem]">{encounter.encounterNumber}</p>
        )}
      </header>

      {encounter.amendsEncounterId === null ? null : (
        <Alert tone="info" className="mt-4">
          This is an amendment. The record it corrects stays exactly as it was signed.
          {encounter.amendmentReason === null ? null : ` Reason: ${encounter.amendmentReason}`}
        </Alert>
      )}

      {encounter.status === 'AMENDED' ? (
        <Alert tone="info" className="mt-4">
          This record has been amended. A later consultation supersedes it; both are kept.
        </Alert>
      ) : null}

      {problem === null ? null : (
        <Alert tone="error" className="mt-4">
          {problem}
        </Alert>
      )}

      {/*
        The spine. Each section is numbered by its place in the consultation,
        which is a real sequence and not a decoration — see the file header.
      */}
      <ol className="mt-4 space-y-4">
        {sections.map((section, index) => (
          <li
            key={section.key}
            className="border-rule bg-card relative rounded-lg border p-5 pl-14"
          >
            <span
              aria-hidden
              className="border-rule bg-paper text-drape absolute top-5 left-5 flex size-6 items-center justify-center rounded-full border font-mono text-[0.6875rem]"
            >
              {index + 1}
            </span>
            <h3 className="eyebrow text-drape">{section.label}</h3>
            <div className="mt-4">
              <SectionBody
                section={section}
                draft={draft}
                edit={edit}
                setSectionField={setSectionField}
                readOnly={readOnly}
                slug={slug}
              />
            </div>
          </li>
        ))}
      </ol>

      <footer className="mt-4 flex flex-wrap items-center justify-between gap-4">
        <p className="text-muted text-[0.8125rem]" aria-live="polite">
          {readOnly
            ? ' '
            : save.status === 'saving'
              ? 'Saving…'
              : save.status === 'saved'
                ? 'Saved'
                : save.status === 'error'
                  ? (save.message ?? 'Not saved')
                  : ' '}
        </p>

        <div className="flex flex-wrap gap-3">
          {encounter.status === 'DRAFT' && canWrite ? (
            <Button variant="ghost" onClick={() => void abandon()} disabled={busy}>
              Discard this draft
            </Button>
          ) : null}
          {encounter.status === 'DRAFT' && canFinalize ? (
            <Button onClick={() => void sign()} disabled={busy}>
              Sign the record
            </Button>
          ) : null}
          {encounter.status === 'FINALIZED' && canAmend ? (
            <Button variant="secondary" onClick={() => setAmending(true)} disabled={busy}>
              Amend
            </Button>
          ) : null}
        </div>
      </footer>

      {amending ? (
        <div className="border-rule bg-card mt-4 rounded-lg border p-5">
          <Textarea
            name="amendment-reason"
            label="Why is this record being amended?"
            hint="Recorded on the amendment and readable beside both versions."
            rows={3}
            value={amendReason}
            onChange={(event) => setAmendReason(event.target.value)}
          />
          <div className="mt-4 flex gap-3">
            <Button onClick={() => void amend()} disabled={busy || amendReason.trim().length < 3}>
              Start the amendment
            </Button>
            <Button variant="ghost" onClick={() => setAmending(false)} disabled={busy}>
              Keep the record as it is
            </Button>
          </div>
        </div>
      ) : null}
    </section>
  );
}

/**
 * The registry: one component per section type.
 *
 * ⚠️ EXHAUSTIVE, WITH NO DEFAULT BRANCH THAT RENDERS A TEXT BOX. A section type
 *   this file does not know is a configuration the engine refused long before
 *   the browser saw it; falling back would turn a rejected template into a
 *   silently wrong form.
 */
function SectionBody({
  section,
  draft,
  edit,
  setSectionField,
  readOnly,
  slug,
}: {
  section: ConsultationSectionConfig;
  draft: Draft;
  edit: (change: (previous: Draft) => Draft) => void;
  setSectionField: (sectionKey: string, fieldKey: string, value: FieldValue) => void;
  readOnly: boolean;
  slug: string;
}) {
  if (section.type === 'CHIEF_COMPLAINT') {
    return (
      <div className="grid gap-4 sm:grid-cols-2">
        <Textarea
          name="chief-complaint"
          label="In the patient’s words"
          hint="What brought them in. Free text on purpose — the coded version is the symptom list."
          rows={3}
          className="sm:col-span-2"
          disabled={readOnly}
          value={draft.chiefComplaint}
          onChange={(event) =>
            edit((previous) => ({ ...previous, chiefComplaint: event.target.value }))
          }
        />
        <div className="grid grid-cols-2 gap-3">
          <Input
            name="duration-value"
            label="Going on for"
            type="number"
            min={1}
            disabled={readOnly}
            value={draft.durationValue}
            onChange={(event) =>
              edit((previous) => ({ ...previous, durationValue: event.target.value }))
            }
          />
          <Select
            name="duration-unit"
            label="Unit"
            placeholder="—"
            options={DURATION_UNITS}
            disabled={readOnly}
            value={draft.durationUnit}
            onChange={(event) =>
              edit((previous) => ({ ...previous, durationUnit: event.target.value }))
            }
          />
        </div>
        <Select
          name="onset"
          label="How it started"
          placeholder="Not recorded"
          options={ONSETS}
          disabled={readOnly}
          value={draft.onset}
          onChange={(event) => edit((previous) => ({ ...previous, onset: event.target.value }))}
        />
      </div>
    );
  }

  if (section.type === 'CLINICAL_NOTES') {
    return (
      <Textarea
        name="clinical-notes"
        label="Notes"
        hint="The narrative every specialty wants and no template can structure away."
        rows={6}
        disabled={readOnly}
        value={draft.clinicalNotes}
        onChange={(event) =>
          edit((previous) => ({ ...previous, clinicalNotes: event.target.value }))
        }
      />
    );
  }

  if (section.type === 'HISTORY' || section.type === 'EXAMINATION') {
    const fields = section.fields ?? [];
    if (fields.length === 0) {
      /* The parser refuses a descriptor-driven section with no fields, so this
         is unreachable through the API — it is here so the screen says
         something true if a snapshot ever predates that rule. */
      return <p className="text-muted text-[0.9375rem]">This section has no fields configured.</p>;
    }
    const answers = draft.sections[section.key] ?? {};
    return (
      <div className={cn('grid gap-4', fields.length > 1 ? 'sm:grid-cols-2' : null)}>
        {fields.map((field) => (
          <FieldRenderer
            key={field.key}
            field={field}
            sectionKey={section.key}
            slug={slug}
            value={answers[field.key]}
            disabled={readOnly}
            {...(section.scopeIds[0] !== undefined ? { scopeId: section.scopeIds[0] } : {})}
            onChange={(value) => setSectionField(section.key, field.key, value)}
          />
        ))}
      </div>
    );
  }

  return (
    <p className="text-muted text-[0.9375rem]">
      {PENDING_SECTIONS[section.type] ?? 'This section is configured and has no editor yet.'}
    </p>
  );
}

const STATUS_WORDS: Record<string, string> = {
  DRAFT: 'Being written',
  FINALIZED: 'Signed',
  AMENDED: 'Superseded by an amendment',
  CANCELLED: 'Abandoned',
};
