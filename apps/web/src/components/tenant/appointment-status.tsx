import { cn } from '@/lib/cn';
import { statusChipClass, statusWord } from '@/lib/appointment-words';

/**
 * One appointment's status, as a word in a coloured chip.
 *
 * ⚠️ NO `'use client'`, AND THAT IS WHY IT IS USEFUL. It holds no state and no
 *   handler, so it renders inside the day board (a Client Component) and inside
 *   the consultation page and the episode timeline (Server Components) without
 *   either of them shipping it twice or reaching for a second copy.
 *
 * ⚠️ THE WORD IS ALWAYS RENDERED. The chip is not a colour with a tooltip; it is
 *   a word that happens to be tinted (WCAG 1.4.1). Removing the text to save
 *   space is the exact regression `appointment-words.ts` documents.
 *
 * ⚠️ `status` IS A STRING AND NOT `AppointmentStatusValue`, WHICH IS A CONCESSION
 *   TO TWO CONTRACTS RATHER THAN LAZINESS. `clinicalEpisodeDetail.appointments[].status`
 *   and `visitHistory.appointmentStatus` are both declared `z.string()`, so the
 *   alternative here is an `as` cast at those call sites — which silences the
 *   check without making the value any more certain. An unrecognised status
 *   prints as itself in the neutral chip; see `statusChipClass`.
 */
export function AppointmentStatusChip({
  status,
  className,
}: {
  status: string;
  className?: string;
}) {
  return (
    <span
      className={cn(
        /* 0.6875rem in a 2px-padded box still clears the 24px target rule's
           sibling concern — this is not interactive, so only contrast binds. */
        'inline-flex items-center rounded-full border px-2 py-0.5 text-[0.6875rem] font-medium whitespace-nowrap',
        statusChipClass(status),
        className
      )}
    >
      {statusWord(status)}
    </span>
  );
}

/**
 * Why a booking was called off, where there is room for a sentence.
 *
 * ⚠️ RENDERS NOTHING UNLESS THE VISIT WAS CANCELLED AND SOMEBODY SAID WHY.
 *   `cancellationReason` is null on every other status, and an empty "Reason:"
 *   label under a live booking would read as a gap in the record. The cancel
 *   form makes the reason required, so in practice a cancelled row always has
 *   one — but the API does not promise it, and a screen that assumes it would
 *   print "Cancelled ·" with nothing after it.
 */
export function CancellationReason({
  status,
  reason,
  className,
}: {
  status: string;
  reason: string | null;
  className?: string;
}) {
  if (status !== 'CANCELLED' || reason === null || reason.trim() === '') return null;

  return (
    <p className={cn('text-danger text-[0.8125rem]', className)}>
      <span className="sr-only">Cancelled because: </span>
      <span aria-hidden="true" className="font-medium">
        Cancelled ·{' '}
      </span>
      {reason}
    </p>
  );
}
