'use client';

import { useState, useTransition } from 'react';
import Link from 'next/link';
import type { FollowUpRecallEntry, FollowUpRecallStatusValue, TimeFormat } from '@rcln/contracts';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/field';
import { FollowUpForm } from '@/components/tenant/follow-up-form';
import { formatClinicDate } from '@/lib/format';
import { declineRecall } from '@/app/(tenant)/t/[slug]/(app)/recall/actions';

/**
 * Who was told to come back and hasn't (CD-13, CE-5).
 *
 * The endpoint has existed since CE-4 and nothing called it. This is the screen
 * the front desk works: somebody reads the list, rings the patient, and either
 * books them or records that they declined.
 *
 * ⚠️ IT IS A LIST OF NAMED PEOPLE UNDER ONGOING TREATMENT, and opening it writes
 *   a `data_access_logs` row. That is the point of the screen — the desk cannot
 *   telephone a uuid — and it is why there is no "everything" tab, no export and
 *   no patient in the URL.
 *
 * ⚠️ THE STRUCTURE IS URGENCY, AND IT IS REAL RATHER THAN DECORATIVE. Overdue,
 *   due, and coming up are three different jobs at the desk: chase, ring, and
 *   leave alone for now. They are the API's own windows, not a grouping invented
 *   here, so a row cannot appear under the wrong heading.
 *
 * Quiet and conventional, per apps/web/AGENTS.md: this is a worklist somebody
 * goes down the middle of with a telephone in their hand.
 */

/** The five windows, in the order the desk works them. */
const TABS: { status: FollowUpRecallStatusValue; label: string; blurb: string }[] = [
  { status: 'OVERDUE', label: 'Overdue', blurb: 'More than a week past due. Chase these first.' },
  { status: 'DUE', label: 'Due now', blurb: 'Due today or earlier, and not yet booked.' },
  { status: 'UPCOMING', label: 'Coming up', blurb: 'Due soon. Ring ahead if the diary is tight.' },
  { status: 'FULFILLED', label: 'Booked', blurb: 'The patient came back, or is booked to.' },
  { status: 'CANCELLED', label: 'Declined', blurb: 'Recorded as declined, or the plan changed.' },
];

const TYPE_WORDS: Record<string, string> = {
  ROUTINE: 'Routine review',
  PROCEDURE_REVIEW: 'Procedure review',
  LAB_REVIEW: 'Results review',
  POST_OPERATIVE: 'Post-operative check',
  OTHER: 'Follow-up',
};

const UNIT_WORDS: Record<string, string> = {
  DAYS: 'days',
  WEEKS: 'weeks',
  MONTHS: 'months',
};

/** "in 15 days", "on 4 September" — whichever half the doctor actually gave. */
function askedFor(row: FollowUpRecallEntry, timezone: string): string {
  if (row.recommendedDate !== null) {
    return `a visit on ${formatClinicDate(`${row.recommendedDate}T12:00:00Z`, timezone)}`;
  }
  if (row.intervalValue !== null && row.intervalUnit !== null) {
    return `a visit in ${row.intervalValue} ${UNIT_WORDS[row.intervalUnit] ?? row.intervalUnit}`;
  }
  return 'a follow-up';
}

export function RecallList({
  slug,
  status,
  items,
  total,
  page,
  timezone,
  timeFormat,
  today,
  canBook,
  canDecline,
}: {
  slug: string;
  status: FollowUpRecallStatusValue;
  items: FollowUpRecallEntry[];
  total: number;
  page: number;
  /** The active branch's zone. Every date below renders in it (invariant 6). */
  timezone: string;
  timeFormat: TimeFormat;
  /** Today in the branch's zone, from the server. Never `new Date()`. */
  today: string;
  canBook: boolean;
  canDecline: boolean;
}) {
  const tab = TABS.find((entry) => entry.status === status) ?? TABS[1];

  return (
    <div>
      <header>
        <h1 className="font-display text-3xl tracking-tight">Recall</h1>
        <p className="text-muted mt-2 text-[0.9375rem]">
          Patients a doctor asked to come back, and whether they have.
        </p>
      </header>

      <nav aria-label="Recall window" className="border-rule mt-5 flex flex-wrap gap-1 border-b">
        {TABS.map((entry) => {
          const current = entry.status === status;
          return (
            <Link
              key={entry.status}
              href={`/recall?status=${entry.status}`}
              aria-current={current ? 'page' : undefined}
              className={[
                'rounded-t-md px-3 py-2 text-[0.875rem] transition-colors',
                current
                  ? 'border-drape text-ink -mb-px border-b-2 font-medium'
                  : 'text-muted hover:text-ink hover:bg-drape-tint/40',
              ].join(' ')}
            >
              {entry.label}
            </Link>
          );
        })}
      </nav>

      <p className="text-muted mt-3 text-[0.8125rem]">{tab?.blurb}</p>

      {items.length === 0 ? (
        <Alert tone="info" className="mt-5">
          Nothing in this window. Recalls appear here when a doctor records a follow-up plan at the
          end of a consultation.
        </Alert>
      ) : (
        <>
          <ul className="mt-5 space-y-3">
            {items.map((row) => (
              <RecallRow
                key={row.id}
                slug={slug}
                row={row}
                timezone={timezone}
                timeFormat={timeFormat}
                today={today}
                canBook={canBook}
                canDecline={canDecline}
              />
            ))}
          </ul>

          {/*
            Page links rather than a control, so the list is linkable and the
            back button works. The window is safe in a URL; nobody is named by it.
          */}
          <nav aria-label="Pages" className="mt-5 flex items-center gap-4">
            {page > 1 ? (
              <Link
                href={`/recall?status=${status}&page=${page - 1}`}
                className="text-[0.875rem] underline underline-offset-2"
              >
                ← Previous
              </Link>
            ) : null}
            <span className="text-muted text-[0.8125rem] tabular-nums">
              {items.length} of {total}
            </span>
            {page * 25 < total ? (
              <Link
                href={`/recall?status=${status}&page=${page + 1}`}
                className="text-[0.875rem] underline underline-offset-2"
              >
                Next →
              </Link>
            ) : null}
          </nav>
        </>
      )}
    </div>
  );
}

/**
 * One person to ring.
 *
 * ⚠️ THE TWO ACTIONS ARE THE TWO OUTCOMES OF THE CALL AND NOTHING ELSE. Booking
 *   fulfils the recommendation; declining records that the patient said no.
 *   There is deliberately no "edit" — the plan is the doctor's, and changing it
 *   is an amendment to the consultation (CD-2), not a row on a worklist.
 */
function RecallRow({
  slug,
  row,
  timezone,
  timeFormat,
  today,
  canBook,
  canDecline,
}: {
  slug: string;
  row: FollowUpRecallEntry;
  timezone: string;
  timeFormat: TimeFormat;
  today: string;
  canBook: boolean;
  canDecline: boolean;
}) {
  const [open, setOpen] = useState<'none' | 'book' | 'decline'>('none');
  const [reason, setReason] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const outstanding = row.fulfilledByAppointmentId === null && row.cancelledAt === null;

  return (
    <li className="border-rule bg-card rounded-lg border p-4">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <p className="text-[0.9375rem] font-medium">{row.patientName}</p>
          <p className="text-muted mt-1 text-[0.8125rem]">
            {TYPE_WORDS[row.followUpType] ?? 'Follow-up'} · {askedFor(row, timezone)}
          </p>
          {row.reason === null ? null : <p className="mt-1 text-[0.8125rem]">{row.reason}</p>}
          {row.patientPhone === null ? (
            <p className="text-muted mt-1 text-[0.8125rem]">No telephone number on the record.</p>
          ) : (
            /* A real `tel:` link: the desk is holding a handset, and on a mobile
               this is the difference between one tap and reading digits aloud. */
            <a
              href={`tel:${row.patientPhone}`}
              className="mt-1 inline-block font-mono text-[0.8125rem] underline underline-offset-2"
            >
              {row.patientPhone}
            </a>
          )}
        </div>

        <div className="text-right">
          <p className="eyebrow text-drape">Due</p>
          <p className="mt-1 font-mono text-[0.875rem] tabular-nums">
            {row.dueOn === null ? '—' : formatClinicDate(`${row.dueOn}T12:00:00Z`, timezone)}
          </p>
          {/* Status in words. Never colour alone (WCAG 1.4.1). */}
          <p className="text-muted mt-1 text-[0.75rem]">
            {row.fulfilledByAppointmentId !== null
              ? 'Booked'
              : row.cancelledAt !== null
                ? 'Declined'
                : 'Not booked'}
          </p>
        </div>
      </div>

      {row.cancelledReason === null ? null : (
        <p className="text-muted mt-2 text-[0.8125rem]">Declined: {row.cancelledReason}</p>
      )}

      <div className="mt-3 flex flex-wrap items-center gap-3">
        <Link
          href={`/appointments/${row.sourceAppointmentId}`}
          className="text-[0.8125rem] underline underline-offset-2"
        >
          The visit this came from
        </Link>
        {row.fulfilledByAppointmentId === null ? null : (
          <Link
            href={`/appointments/${row.fulfilledByAppointmentId}`}
            className="text-[0.8125rem] underline underline-offset-2"
          >
            The booking that fulfilled it
          </Link>
        )}

        {outstanding && canBook ? (
          <Button
            variant="secondary"
            size="sm"
            aria-expanded={open === 'book'}
            onClick={() => setOpen(open === 'book' ? 'none' : 'book')}
          >
            {open === 'book' ? 'Close' : 'Book the follow-up'}
          </Button>
        ) : null}

        {outstanding && canDecline ? (
          <Button
            variant="ghost"
            size="sm"
            aria-expanded={open === 'decline'}
            onClick={() => setOpen(open === 'decline' ? 'none' : 'decline')}
          >
            {open === 'decline' ? 'Close' : 'Record a decline'}
          </Button>
        ) : null}
      </div>

      {open === 'book' ? (
        <div className="border-rule mt-3 border-t pt-3">
          <FollowUpForm
            slug={slug}
            sourceAppointmentId={row.sourceAppointmentId}
            branchId={row.branchId}
            /*
             * ⚠️ THE FORM DOES NOT SEND A DOCTOR AND THE API READS ONE OFF THE
             *   PARENT. What it needs here is only whose diary to SHOW, and a
             *   follow-up is normally with whoever saw them — which the source
             *   appointment carries. The page resolves it once for the list.
             */
            doctorProfileId={row.doctorProfileId}
            doctorName={row.doctorName}
            timezone={timezone}
            timeFormat={timeFormat}
            today={today}
            fulfilsRecommendationId={row.id}
            recommendedFor={askedFor(row, timezone)}
          />
        </div>
      ) : null}

      {open === 'decline' ? (
        <div className="border-rule mt-3 border-t pt-3">
          <Input
            name={`decline-${row.id}`}
            label="What the patient said"
            hint="Optional, and it stays on the recall rather than on the clinical record."
            value={reason}
            onChange={(event) => setReason(event.target.value)}
          />
          {problem === null ? null : (
            <Alert tone="error" className="mt-2">
              {problem}
            </Alert>
          )}
          <div className="mt-3 flex items-center gap-3">
            <Button
              variant="secondary"
              size="sm"
              disabled={pending}
              onClick={() =>
                startTransition(async () => {
                  const result = await declineRecall(slug, row.id, reason);
                  setProblem(result.status === 'error' ? (result.message ?? null) : null);
                  if (result.status === 'done') setOpen('none');
                })
              }
            >
              {pending ? 'Recording…' : 'Record the decline'}
            </Button>
            <span className="text-muted text-[0.8125rem]">
              This does not change what the doctor wrote.
            </span>
          </div>
        </div>
      ) : null}
    </li>
  );
}
