'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { drawableRegions, parseVisualMap } from '@rcln/clinical';
import type {
  ConsultationSectionConfig,
  EncounterContent,
  EncounterDetail,
  SaveEncounterDraftRequest,
} from '@rcln/contracts';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Input, Select, Textarea } from '@/components/ui/field';
import { cn } from '@/lib/cn';
import { FieldRenderer, type FieldValue } from '@/components/tenant/field-renderer';
import {
  AdviceSection,
  AttachmentsSection,
  DiagnosisSection,
  FollowUpSection,
  InvestigationSection,
  PrescriptionSection,
  ProcedureSection,
  ReferralSection,
  SymptomsSection,
} from '@/components/tenant/consultation-content';
import { VisualMappingSection } from '@/components/tenant/visual-mapping';
import {
  addContentRow,
  amendConsultation,
  cancelConsultation,
  finalizeConsultation,
  removeContentRow,
  saveConsultation,
  setFollowUp,
  updateContentRow,
  type ConsultationState,
  type ContentCollection,
  type ContentResult,
} from '@/app/(tenant)/t/[slug]/(app)/appointments/consultation-actions';

/** The clinical content and the verbs over it, handed to every CE-4 section. */
interface ContentHandlers {
  encounterId: string;
  content: EncounterContent;
  add: (collection: ContentCollection, body: Record<string, unknown>) => Promise<ContentResult>;
  edit: (
    collection: ContentCollection,
    rowId: string,
    body: Record<string, unknown>
  ) => Promise<ContentResult>;
  remove: (collection: ContentCollection, rowId: string) => Promise<ContentResult>;
  setFollowUp: (body: Parameters<typeof setFollowUp>[2]) => void;
}

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
 * ⚠️ NAMED, NOT BLANK. A clinic that configured a section and sees an empty
 *   space assumes the configuration is broken; a line saying what the section is
 *   and when it arrives is the honest answer.
 *
 * ⚠️ CE-6 EMPTIED IT. Every member of `ConsultationSectionType` now has a real
 *   component over a real table — `VISUAL_MAPPING` was the last entry, and
 *   `clinical_findings` is what closed it. The table stays because deleting an
 *   entry as each component lands is the intended mechanism, and because the
 *   fallback below is what a section type added to the engine and forgotten here
 *   should render: a sentence, rather than a blank space that reads as broken.
 */
const PENDING_SECTIONS: Record<string, string> = {};

/**
 * Every place the consultation's charts offer, as options.
 *
 * ⚠️ THE MAP'S NAME IS PREFIXED ONLY WHEN THERE IS MORE THAN ONE CHART. A
 *   dentist picking "36" does not need to be told it is on the odontogram; a
 *   dermatology consultation charting front and back does, because "R arm"
 *   appears on both.
 *
 * ⚠️ AND A MAP THAT WILL NOT PARSE CONTRIBUTES NOTHING RATHER THAN THROWING. The
 *   chart section says so on screen already (CE-6); a picker that took the whole
 *   consultation down with it would turn a bad configuration row into a doctor
 *   who cannot record a procedure at all.
 */
function regionChoices(
  sections: readonly ConsultationSectionConfig[]
): readonly { value: string; label: string }[] {
  const maps = new Map<string, NonNullable<ConsultationSectionConfig['map']>>();
  for (const section of sections) {
    if (section.map !== undefined) maps.set(section.map.id, section.map);
  }
  if (maps.size === 0) return [];

  const choices: { value: string; label: string }[] = [];
  for (const map of maps.values()) {
    const parsed = parseVisualMap({ code: map.code, viewBox: map.viewBox, regions: map.regions });
    if (!parsed.ok) continue;
    for (const region of drawableRegions(parsed.value)) {
      choices.push({
        value: region.id,
        label: maps.size === 1 ? region.label : `${map.name} · ${region.label}`,
      });
    }
  }
  return choices;
}

export function ConsultationEngine({
  slug,
  timeZone,
  appointmentId,
  encounter,
  canWrite,
  canFinalize,
  canAmend,
}: {
  slug: string;
  /**
   * The branch's zone, for the DATETIME controls (CE-8).
   *
   * ⚠️ THE BRANCH'S, NOT THE BROWSER'S AND NOT THE CONTAINER'S. A DATETIME
   *   answer is stored as an instant and typed as a wall clock, and the zone is
   *   the only thing that connects the two — see `lib/format.ts`.
   */
  timeZone: string;
  /**
   * The visit this consultation belongs to.
   *
   * ⚠️ NULL FOR A WALK-IN (CD-1) AND ON THE READ-ONLY RECORD SCREEN (CE-5),
   *   where a consultation is opened by its own id rather than through a
   *   booking. It is only ever used to revalidate the visit's page after a
   *   transition, and the three transitions are already behind `canWrite` /
   *   `canFinalize` / `canAmend` — all false on that screen. The guards below
   *   are belt and braces: a permission prop is a statement about the caller,
   *   and this is a statement about the route.
   */
  appointmentId: string | null;
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
  /*
   * ⚠️ THE CLINICAL CONTENT IS ITS OWN STATE, BESIDE `draft` AND NOT INSIDE IT
   *   (CE-4). `draft` is a DOCUMENT the autosave debounces; content is ROWS with
   *   server-issued ids that are written the moment they are added. Folding them
   *   together would either debounce a row creation — which loses the id the
   *   next edit needs — or fire the document save on every row change.
   */
  const [content, setContent] = useState<EncounterContent>(encounter.content);
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

  /*
   * ⚠️ THE PLACES THIS CONSULTATION CAN POINT AT — every drawn region of every
   *   chart the template resolved, and nothing when it resolved none (CE-7).
   *   `encounter_procedures.visual_region_id` has had a column, a contract and a
   *   service since CE-6 and no way to fill it in; this is that way, and it is
   *   deliberately derived from the CONFIGURATION rather than from a lookup of
   *   its own. A screen that fetched "all regions" would offer a dentist the
   *   scalp zones.
   *
   * ⚠️ AND THE LIST IS THE DRAWN REGIONS, NOT ALL OF THEM. A quadrant groups and
   *   is not a place a root canal happens — the same filter the chart draws
   *   with, through the same parser, because a second reading of a geometry
   *   document is a second answer to "is this region a place".
   */
  const chartRegions = useMemo(() => regionChoices(sections), [sections]);

  /*
   * ⚠️ ONE HANDLER PER VERB, SHARED BY EVERY CONTENT SECTION, AND EACH SWAPS THE
   *   WHOLE CONTENT FOR WHAT CAME BACK. One of these writes legitimately changes
   *   a row in a DIFFERENT list — removing a diagnosis unlinks every procedure
   *   citing it — so merging per-row would get that case wrong, quietly, in a
   *   way that renders as "this procedure treats nothing".
   *
   * ⚠️ AND A FAILURE IS SHOWN RATHER THAN SWALLOWED. The API's sentence names
   *   what happened — "this consultation already has a primary diagnosis" — and
   *   replacing it with "could not be saved" sends the clinician to support with
   *   nothing to say.
   */
  const applyContent = useCallback((result: ContentResult) => {
    if (result.ok) {
      setContent(result.content);
      setProblem(null);
    } else {
      setProblem(result.message);
    }
  }, []);

  const contentHandlers = useMemo(
    () => ({
      encounterId: encounter.id,
      content,
      add: async (collection: ContentCollection, body: Record<string, unknown>) => {
        const result = await addContentRow(slug, encounter.id, collection, body);
        applyContent(result);
        return result;
      },
      edit: async (collection: ContentCollection, rowId: string, body: Record<string, unknown>) => {
        const result = await updateContentRow(slug, encounter.id, collection, rowId, body);
        applyContent(result);
        return result;
      },
      remove: async (collection: ContentCollection, rowId: string) => {
        const result = await removeContentRow(slug, encounter.id, collection, rowId);
        applyContent(result);
        return result;
      },
      setFollowUp: (body: Parameters<typeof setFollowUp>[2]) => {
        void setFollowUp(slug, encounter.id, body).then(applyContent);
      },
    }),
    [slug, encounter.id, content, applyContent]
  );

  const sign = async () => {
    if (appointmentId === null) return;
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
    if (appointmentId === null) return;
    setBusy(true);
    setProblem(null);
    const result = await amendConsultation(slug, appointmentId, encounter.id, amendReason);
    if (!result.ok) setProblem(result.message);
    else setAmending(false);
    setBusy(false);
  };

  const abandon = async () => {
    if (appointmentId === null) return;
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
                timeZone={timeZone}
                content={contentHandlers}
                chartRegions={chartRegions}
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
  timeZone,
  content,
  chartRegions,
}: {
  section: ConsultationSectionConfig;
  draft: Draft;
  edit: (change: (previous: Draft) => Draft) => void;
  setSectionField: (sectionKey: string, fieldKey: string, value: FieldValue) => void;
  readOnly: boolean;
  slug: string;
  /** The branch's zone, for the DATETIME controls. */
  timeZone: string;
  /** The clinical content and the three verbs over it (CE-4). */
  content: ContentHandlers | null;
  /** Every place this consultation's charts offer. Empty when it has none. */
  chartRegions: readonly { value: string; label: string }[];
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

  /*
   * ⚠️ THE FIRST-CLASS SECTIONS ARE ONE COMPONENT EACH, CHOSEN FROM A CLOSED
   *   TABLE, AND THEY DO NOT TOUCH `draft` (CE-4). Their content is ROWS on the
   *   server with server-issued ids, not fields of the autosaved document — so
   *   they write immediately through their own actions and hand the whole
   *   content back, and the engine swaps its copy for it. That is why `content`
   *   is passed down rather than lifted into `draft`: a row is not a keystroke.
   */
  if (content !== null) {
    const shared = {
      slug,
      encounterId: content.encounterId,
      content: content.content,
      readOnly,
      ...(section.scopeIds[0] !== undefined ? { scopeId: section.scopeIds[0] } : {}),
      add: content.add,
      edit: content.edit,
      remove: content.remove,
    };

    switch (section.type) {
      /*
       * ⚠️ THE ONLY SECTION THAT NEEDS ITS OWN KEY (CE-6). VISUAL_MAPPING
       *   repeats — an ENT consultation charts a left ear and a right ear — so a
       *   finding hangs off the SECTION rather than off the encounter alone, and
       *   two charts on one template would otherwise show each other's marks.
       */
      case 'VISUAL_MAPPING':
        return (
          <VisualMappingSection
            {...shared}
            sectionKey={section.key}
            {...(section.map !== undefined ? { map: section.map } : {})}
            {...(section.mapCode !== undefined ? { mapCode: section.mapCode } : {})}
          />
        );
      case 'SYMPTOMS':
        return <SymptomsSection {...shared} />;
      case 'DIAGNOSIS':
        return <DiagnosisSection {...shared} />;
      case 'PROCEDURE':
        return <ProcedureSection {...shared} chartRegions={chartRegions} />;
      case 'PRESCRIPTION':
        return <PrescriptionSection {...shared} />;
      case 'INVESTIGATION':
        return <InvestigationSection {...shared} />;
      case 'ADVICE':
        return <AdviceSection {...shared} />;
      case 'REFERRAL':
        return <ReferralSection {...shared} />;
      case 'ATTACHMENTS':
        return <AttachmentsSection {...shared} />;
      case 'FOLLOW_UP':
        return (
          <FollowUpSection
            followUp={content.content.followUp}
            readOnly={readOnly}
            onSet={content.setFollowUp}
          />
        );
      default:
        break;
    }
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
            timeZone={timeZone}
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
