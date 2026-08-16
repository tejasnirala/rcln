import Link from 'next/link';
import type { EncounterPrescription, PreviousVisit, TimeFormat } from '@rcln/contracts';
import { formatClinicDate, formatClinicDateTime } from '@/lib/format';

/**
 * What happened last time (CE-5, §37, FOLLOW_UP_ARCHITECTURE §4).
 *
 * The panel a doctor reads while writing this consultation. Everything on it is
 * data that already exists — the previous visit's diagnoses, prescriptions,
 * investigations, advice and the follow-up they were given — so there is no
 * specialty branch anywhere in this file (§33) and no guessing.
 *
 * ⚠️ READ-ONLY, AND THE STORAGE MODEL IS WHAT ENFORCES IT. A finalized
 *   consultation is immutable (CD-2), so nothing on the current screen could
 *   write to it even if this component grew a form. It is rendered as a summary
 *   with a link to the full record, which is the shape §4 asks for.
 *
 * ⚠️ IT SAYS HOW THIS VISIT WAS FOUND, AND THE THREE SENTENCES ARE DIFFERENT ON
 *   PURPOSE. `PARENT_APPOINTMENT` is a fact the database enforces;
 *   `SAME_EPISODE` is a strong inference; `MOST_RECENT` is a convenience.
 *   Wording all three as "last visit" would tell a doctor that an unrelated
 *   visit from March is what this follow-up follows — a clinical claim nothing
 *   here has a basis for.
 *
 * ⚠️ A `<details>`, CLOSED FOR AN UNRELATED VISIT AND OPEN FOR A REAL FOLLOW-UP.
 *   The panel sits above a form somebody is about to type in; when it is
 *   genuinely the visit being followed up it is the first thing they want, and
 *   when it is "the last time we saw them, about something else" it is context
 *   they can open if they want it. A native `<details>` keeps the keyboard and
 *   screen-reader behaviour without a line of state.
 */

const SOURCE_WORDS: Record<PreviousVisit['source'], string> = {
  PARENT_APPOINTMENT: 'The visit this follow-up was booked from',
  SAME_EPISODE: 'The previous visit on this treatment journey',
  MOST_RECENT: 'The last consultation for this patient — a different journey',
};

const ROUTE_WORDS: Record<string, string> = {
  ORAL: 'by mouth',
  TOPICAL: 'applied',
  INTRAVENOUS: 'IV',
  INTRAMUSCULAR: 'IM',
  SUBCUTANEOUS: 'subcut',
  INHALATION: 'inhaled',
  OPHTHALMIC: 'in the eye',
  OTIC: 'in the ear',
  NASAL: 'nasal',
  RECTAL: 'rectal',
  VAGINAL: 'vaginal',
  SUBLINGUAL: 'under the tongue',
  TRANSDERMAL: 'patch',
  OTHER: '',
};

const UNIT_WORDS: Record<string, string> = {
  DAYS: 'days',
  WEEKS: 'weeks',
  MONTHS: 'months',
};

export function PreviousVisitSummary({
  previous,
  timeFormat,
}: {
  previous: PreviousVisit;
  timeFormat: TimeFormat;
}) {
  const { encounter, content } = previous;

  const when =
    previous.scheduledStart !== null
      ? formatClinicDateTime(previous.scheduledStart, previous.timezone, timeFormat)
      : formatClinicDateTime(encounter.startedAt, previous.timezone, timeFormat);

  return (
    <details
      open={previous.source !== 'MOST_RECENT'}
      className="border-rule bg-card mt-4 rounded-lg border p-5"
    >
      <summary className="cursor-pointer list-none">
        <span className="eyebrow text-drape">Last time</span>
        <span className="mt-1 block text-[0.9375rem]">
          {when} · {previous.doctorName}
        </span>
        <span className="text-muted mt-1 block text-[0.8125rem]">
          {SOURCE_WORDS[previous.source]}
        </span>
      </summary>

      <div className="mt-4 space-y-4">
        {encounter.chiefComplaint === null ? null : (
          <Block label="What they came in with">
            <p className="text-[0.9375rem] whitespace-pre-line">{encounter.chiefComplaint}</p>
          </Block>
        )}

        {content.diagnoses.length === 0 ? null : (
          <Block label="Diagnosis">
            <ul className="space-y-1">
              {content.diagnoses.map((row) => (
                <li key={row.id} className="text-[0.9375rem]">
                  {row.item?.name ?? row.customText}
                  {/* The role in words rather than by position — a list whose
                      first entry silently means "primary" is colour alone. */}
                  <span className="text-muted text-[0.8125rem]">
                    {row.role === 'PRIMARY' ? ' · primary' : ''}
                  </span>
                </li>
              ))}
            </ul>
          </Block>
        )}

        {/*
          What was marked on a chart last time (CE-6).

          ⚠️ AS WORDS AND NOT AS A PICTURE. The panel sits beside the
          consultation being written and its job is "what did we find on 36 last
          time" — a second odontogram here would compete with the live one for
          the reader's eye and for the width of the column. The chart itself is
          one click away on the record.
        */}
        {content.findings.length === 0 ? null : (
          <Block label="Found on the chart">
            <ul className="space-y-1">
              {content.findings.map((row) => (
                <li key={row.id} className="text-[0.9375rem]">
                  {row.region.label} — {row.item.name}
                  {row.severity === null ? null : (
                    <span className="text-muted text-[0.8125rem]">
                      {' '}
                      · {row.severity.toLowerCase()}
                    </span>
                  )}
                </li>
              ))}
            </ul>
          </Block>
        )}

        {content.prescriptions.length === 0 ? null : (
          <Block label="Prescribed">
            <ul className="space-y-1">
              {content.prescriptions.map((row) => (
                <li key={row.id} className="text-[0.9375rem]">
                  {row.product?.name ?? '—'}
                  <span className="text-muted text-[0.8125rem]"> {dosage(row)}</span>
                </li>
              ))}
            </ul>
          </Block>
        )}

        {content.investigations.length === 0 ? null : (
          <Block label="Ordered">
            <ul className="space-y-1">
              {content.investigations.map((row) => (
                <li key={row.id} className="text-[0.9375rem]">
                  {row.item?.name ?? '—'}
                </li>
              ))}
            </ul>
          </Block>
        )}

        {content.advice.length === 0 ? null : (
          <Block label="Advice given">
            <ul className="space-y-1">
              {content.advice.map((row) => (
                <li key={row.id} className="text-[0.9375rem]">
                  {row.item?.name ?? row.customText}
                </li>
              ))}
            </ul>
          </Block>
        )}

        {content.followUp === null ? null : (
          <Block label="What they were told">
            <p className="text-[0.9375rem]">
              {!content.followUp.isRequired
                ? 'No follow-up needed.'
                : content.followUp.recommendedDate !== null
                  ? `Come back on ${formatClinicDate(`${content.followUp.recommendedDate}T12:00:00Z`, previous.timezone)}.`
                  : content.followUp.intervalValue !== null &&
                      content.followUp.intervalUnit !== null
                    ? `Come back in ${content.followUp.intervalValue} ${UNIT_WORDS[content.followUp.intervalUnit] ?? content.followUp.intervalUnit}.`
                    : 'A follow-up was recommended.'}
            </p>
            {content.followUp.reason === null ? null : (
              <p className="text-muted mt-1 text-[0.8125rem]">{content.followUp.reason}</p>
            )}
          </Block>
        )}

        <div className="flex flex-wrap gap-4">
          <Link
            href={`/consultations/${encounter.id}`}
            className="text-[0.8125rem] underline underline-offset-2"
          >
            Read the full record
          </Link>
          <Link
            href={`/episodes/${previous.clinicalEpisodeId}`}
            className="text-muted text-[0.8125rem] underline underline-offset-2"
          >
            The whole journey ({previous.episodeCode})
          </Link>
        </div>
      </div>
    </details>
  );
}

function Block({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <h3 className="eyebrow text-drape">{label}</h3>
      <div className="mt-2">{children}</div>
    </div>
  );
}

/** "5 mg · twice daily · 30 days · by mouth" — whichever parts were recorded. */
function dosage(row: EncounterPrescription): string {
  const parts: string[] = [];
  if (row.dose !== null) {
    parts.push(`${row.dose}${row.doseUnit === null ? '' : ` ${row.doseUnit.toLowerCase()}`}`);
  }
  if (row.frequency !== null && row.frequencyUnit !== null) {
    parts.push(`${row.frequency}× per ${row.frequencyUnit.toLowerCase()}`);
  }
  if (row.durationValue !== null && row.durationUnit !== null) {
    parts.push(`${row.durationValue} ${row.durationUnit.toLowerCase()}`);
  }
  if (row.route !== null && ROUTE_WORDS[row.route] !== undefined && ROUTE_WORDS[row.route] !== '') {
    parts.push(ROUTE_WORDS[row.route] as string);
  }
  return parts.length === 0 ? '' : `· ${parts.join(' · ')}`;
}
