'use client';

import { useActionState, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Alert, useOutcomeFocus } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/field';
import { cancelBooking } from '@/app/(tenant)/t/[slug]/(app)/appointments/actions';

/**
 * Call off a visit, from the visit's own page.
 *
 * ⚠️ THIS EXISTS BECAUSE THE DAY BOARD WAS THE ONLY PLACE THAT OFFERED IT, and
 *   the one moment a clinician most needs it is the one moment they are not on
 *   the board. Opening the consultation is what moves a booking to IN_PROGRESS
 *   — "With the doctor" — so by the time the patient says they have to leave,
 *   the person with them is on this page and the control was two navigations
 *   away. The API has always permitted it: `TRANSITIONS` in
 *   `appointment.service.ts` reads `IN_PROGRESS: ['COMPLETED', 'CANCELLED']`.
 *
 * ⚠️ IT CANCELS THE BOOKING, NOT THE CONSULTATION, and those are different acts
 *   on different records (CD-1). A draft consultation is abandoned from the
 *   consultation itself, which is `clinical.encounter.create`; this ends the
 *   VISIT and is `appointment.cancel`, which the front desk holds and which
 *   says nothing about the clinical record. A finalized consultation is
 *   immutable either way (CD-2) — cancelling the booking does not unwrite it.
 *
 * ⚠️ AND IT IS THE SAME ACTION THE BOARD CALLS. `cancelBooking` posts to
 *   `POST /appointments/:id/cancel`, so the reason, the audit row and the
 *   status trail are identical whichever screen ended the visit. A second
 *   cancel path here would be a second answer to what cancelling means.
 */
export function VisitCancel({ slug, appointmentId }: { slug: string; appointmentId: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [state, action, pending] = useActionState(cancelBooking.bind(null, slug, appointmentId), {
    status: 'idle' as const,
  });
  const form = useRef<HTMLFormElement>(null);
  /* On a failed submit, move focus to what went wrong — apps/web/AGENTS.md,
     and the same hook every other form on a tenant screen uses. */
  useOutcomeFocus(state.status, form);

  /*
   * ⚠️ NO `setOpen(false)` HERE, DELIBERATELY. Closing the panel from inside an
   *   effect is a synchronous setState that cascades a render — and it is
   *   redundant: a cancelled booking is one of the three terminal states, so
   *   `canCancelVisit` on the page goes false and this whole section unmounts.
   *   The refresh is the only thing that has to happen.
   */
  useEffect(() => {
    if (state.status === 'booked') router.refresh();
  }, [state.status, router]);

  return (
    <section className="border-rule bg-card mt-4 rounded-lg border p-5">
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <div>
          <h2 className="eyebrow text-drape">End this visit</h2>
          <p className="text-muted mt-2 text-[0.8125rem]">
            Records that the appointment was called off, with a reason. It does not delete anything
            already written up.
          </p>
        </div>
        <Button
          size="sm"
          variant="secondary"
          aria-expanded={open}
          onClick={() => setOpen((was) => !was)}
        >
          {open ? 'Keep the visit' : 'Cancel the visit'}
        </Button>
      </div>

      {open ? (
        <form ref={form} action={action} className="mt-3 flex flex-col gap-2">
          {/* The same question the day board asks, worded the same way — one
              action should not change its name between two screens. */}
          <Input
            name="reason"
            label="Why is it being cancelled?"
            hint="The patient may ask. Recorded against the booking."
            errors={state.fieldErrors?.['reason']}
            required
          />
          {state.message !== undefined ? <Alert tone="error">{state.message}</Alert> : null}
          <div className="flex gap-2">
            <Button type="submit" size="sm" disabled={pending}>
              {pending ? 'Cancelling…' : 'Cancel the booking'}
            </Button>
            <Button type="button" size="sm" variant="secondary" onClick={() => setOpen(false)}>
              Keep it
            </Button>
          </div>
        </form>
      ) : null}
    </section>
  );
}
