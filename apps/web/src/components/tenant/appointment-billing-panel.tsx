'use client';

import { useState, useTransition } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import type {
  AppointmentBilling,
  AppointmentInvoiceLink,
  ConsultationCharge,
} from '@rcln/contracts';
import { formatMoney, fromMajor, money } from '@rcln/payments/money';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/field';
import { StatusPill } from '@/components/tenant/invoice-list';
import { raiseAppointmentInvoice } from '@/app/(tenant)/t/[slug]/(app)/appointments/actions';

/**
 * Billing, on the consultation screen.
 *
 * ⚠️ THE WHOLE POINT IS THAT NOBODY RETYPES THE FEE. The charge below comes off
 *   the doctor's rate card at this branch, and the date of supply is the day of
 *   the VISIT rather than today — which is what selects the effective-dated tax
 *   rule, so a bill raised in April for a March consultation is taxed as March
 *   was. A cashier who types this invoice by hand instead gets none of that.
 *
 * ⚠️ "IS THIS VISIT BILLED?" IS A QUESTION ABOUT THE LIVE INVOICE, NOT ABOUT
 *   WHETHER ONE EXISTS. `invoices.appointment_id` is deliberately not unique: a
 *   visit billed, voided and re-billed has two rows, and the void keeps its
 *   reference or the correction cannot be explained. So the panel shows the live
 *   invoice as the answer and the history underneath as the account — a screen
 *   that hid the history is a screen where a voided invoice looks like it never
 *   happened.
 */
export function AppointmentBillingPanel({
  slug,
  billing,
  canRaise,
}: {
  slug: string;
  billing: AppointmentBilling;
  canRaise: boolean;
}) {
  /*
   * ⚠️ OFF THE RESPONSE, NOT OFF THE SESSION. It is the organization's currency —
   *   what `unitPriceMinor` on the rate card is denominated in — and the endpoint
   *   that resolved the fee is the thing that knows it. Reading it from anywhere
   *   else here would be a second opinion about the currency of a figure this
   *   panel did not compute.
   */
  const currency = billing.currency;
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [message, setMessage] = useState<string | null>(null);
  /** Only opened when the rate card could not price the visit. */
  const [override, setOverride] = useState('');
  const [asking, setAsking] = useState(false);

  const live = billing.liveInvoice;
  /* The live invoice is in `history` too; showing it twice would read as two. */
  const past = billing.history.filter((entry) => entry.invoiceId !== live?.invoiceId);

  function raise(): void {
    setMessage(null);

    let unitPriceMinor: number | undefined;
    if (billing.charge === null) {
      /*
       * ⚠️ AN UNPRICED VISIT REFUSES RATHER THAN BILLING ZERO, WHICH IS WHY THIS
       *   BOX IS REQUIRED HERE AND ABSENT OTHERWISE. A draft at zero from a rate
       *   card nobody filled in is a bill that looks settled.
       */
      try {
        unitPriceMinor = fromMajor(override, currency).amountMinor;
      } catch {
        setMessage(`Enter the fee in ${currency} — the rate card has none for this visit.`);
        return;
      }
    }

    startTransition(async () => {
      const outcome = await raiseAppointmentInvoice(slug, billing.appointmentId, {
        ...(unitPriceMinor === undefined ? {} : { unitPriceMinor }),
      });

      if (outcome.status === 'error') {
        setMessage(outcome.message);
        return;
      }

      setAsking(false);
      /*
       * Straight to the draft. Raising the bill and handing it over are one act
       * at a counter — the next thing the cashier does is check it and press
       * Issue, and that is the invoice screen. `revalidatePath` in the action has
       * already refreshed this page for when they come back.
       */
      router.push(`/invoices/${outcome.invoiceId}`);
    });
  }

  return (
    <section className="border-rule bg-card mt-4 rounded-lg border p-5">
      <h2 className="eyebrow text-drape">Billing</h2>

      {message === null ? null : (
        <div className="mt-3">
          <Alert tone="error">{message}</Alert>
        </div>
      )}

      {live === null ? (
        <div className="mt-3 space-y-4">
          <Charge charge={billing.charge} currency={currency} billing={billing} />

          {billing.billable && canRaise ? (
            asking ? (
              <div className="border-signal/30 bg-signal-tint rounded-md border p-4">
                <p className="text-ink text-[0.9375rem] font-medium">
                  Raise the bill for this visit?
                </p>
                <p className="text-ink-soft mt-1 max-w-prose text-[0.8125rem]">
                  It opens a draft you can check and change before anything is issued. Nothing is
                  handed to the patient until you issue it.
                </p>
                {billing.charge === null ? (
                  <div className="mt-3 max-w-xs">
                    <Input
                      name="unitPriceMinor"
                      label={`Fee (${currency})`}
                      hint="The fee schedule has no price for this visit."
                      inputMode="decimal"
                      className="text-right font-mono"
                      value={override}
                      onChange={(event) => setOverride(event.target.value)}
                    />
                  </div>
                ) : null}
                <div className="mt-4 flex flex-wrap gap-3">
                  <Button size="sm" disabled={pending} onClick={raise}>
                    {pending ? 'Raising…' : 'Raise the invoice'}
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={pending}
                    onClick={() => setAsking(false)}
                  >
                    Not now
                  </Button>
                </div>
              </div>
            ) : (
              <Button size="sm" onClick={() => setAsking(true)}>
                Raise the invoice
              </Button>
            )
          ) : (
            <p className="text-muted text-[0.8125rem]">{whyNot(billing, canRaise)}</p>
          )}
        </div>
      ) : (
        <div className="mt-3 space-y-3">
          <InvoiceLine link={live} label="Billed on" />
          <p className="text-muted text-[0.8125rem]">
            {/*
             * Cancelling or voiding that invoice makes the visit billable again —
             * said here because the alternative is a cashier who thinks a
             * mistaken bill has locked the visit for good.
             */}
            To bill this visit differently, cancel or void that invoice first. The visit becomes
            billable again, and a voided invoice keeps its number on the record.
          </p>
        </div>
      )}

      {past.length === 0 ? null : (
        <div className="border-rule mt-5 border-t pt-4">
          <h3 className="text-muted text-xs tracking-wide uppercase">
            Earlier bills for this visit
          </h3>
          <ul className="mt-3 space-y-2">
            {past.map((entry) => (
              <li key={entry.invoiceId}>
                <InvoiceLine link={entry} />
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}

/**
 * What the rate card proposes.
 *
 * ⚠️ `FOLLOW_UP_FREE` IS A CHARGE OF ZERO AND NOT AN ABSENT ONE, AND THE SCREEN
 *   HAS TO KEEP THEM APART. "We waive a review inside seven days" is an answer
 *   the clinic gave; a doctor whose rate card was never filled in is a different
 *   fact and reads as a missing fee. Collapsing them would make a policy and a
 *   gap look identical on the screen where the cashier decides.
 */
function Charge({
  charge,
  currency,
  billing,
}: {
  charge: ConsultationCharge | null;
  currency: string;
  billing: AppointmentBilling;
}) {
  if (charge === null) {
    return (
      <p className="text-ink text-[0.9375rem]">
        {billing.unpricedReason === 'NO_RATE_CARD'
          ? 'This clinic has no fees set, so there is nothing to bill from. Set them on the Clinic screen, or enter the fee below.'
          : 'There is no fee set for this kind of visit. Enter it below, or add it to the fee schedule.'}
        {/*
          The move charge stands on its own: it is for moving the slot, not for
          the consultation, so it is billed even when the visit itself is not
          priced. Saying it here stops it looking like a stray line on the draft.
        */}
        {billing.rescheduleCount > 0 ? (
          <>
            {' '}
            {billing.rescheduleCount === 1
              ? 'One move the patient asked for'
              : `${billing.rescheduleCount} moves the patient asked for`}{' '}
            will still be billed, at{' '}
            <span className="font-mono">
              {formatMoney(money(billing.rescheduleChargeMinor, currency))}
            </span>
            .
          </>
        ) : null}
      </p>
    );
  }

  return (
    <div>
      <p className="text-ink text-[0.9375rem]">
        {charge.description}
        {' · '}
        <span className="font-mono">{formatMoney(money(charge.unitPriceMinor, currency))}</span>
      </p>
      {/*
        ⚠️ A SEPARATE LINE, AND SEPARATE ON THE BILL TOO. A patient charged 600
          has to be able to see it was 200 three times, and the charge applies on
          top of a free follow-up because it is for moving the slot rather than
          for the consultation.
      */}
      {billing.rescheduleCount > 0 ? (
        <p className="text-ink mt-1 text-[0.9375rem]">
          Rescheduling ·{' '}
          <span className="font-mono">
            {formatMoney(money(billing.rescheduleChargeMinor, currency))}
          </span>
          <span className="text-muted text-[0.8125rem]">
            {' · '}
            {billing.rescheduleCount === 1
              ? 'one move the patient asked for'
              : `${billing.rescheduleCount} moves the patient asked for`}
          </span>
        </p>
      ) : null}
      {charge.basis === 'FOLLOW_UP_FREE' ? (
        <p className="text-muted mt-1 text-[0.8125rem]">
          A review within {charge.freeFollowUpDays} days of the first visit, which this clinic does
          not charge for. The bill is raised at zero so there is a document for it.
        </p>
      ) : null}
      <p className="text-muted mt-1 text-[0.8125rem]">
        {/*
         * ⚠️ SAID OUT LOUD, BECAUSE IT IS THE MOST CONSEQUENTIAL THING THIS
         *   PANEL DECIDES. The date of supply is the visit's day, not today, and
         *   it selects the tax rule and the registration the invoice is issued
         *   under.
         */}
        Tax is worked out as at {billing.suppliedOn}, the day of the visit.
      </p>
    </div>
  );
}

function InvoiceLine({ link, label }: { link: AppointmentInvoiceLink; label?: string }) {
  return (
    <p className="flex flex-wrap items-center gap-2 text-[0.9375rem]">
      {label ? <span className="text-muted text-[0.8125rem]">{label}</span> : null}
      <Link
        href={`/invoices/${link.invoiceId}`}
        className="text-drape font-mono hover:underline focus-visible:underline"
      >
        {/* A draft has no number by construction. */}
        {link.invoiceNumber ?? 'Draft'}
      </Link>
      <StatusPill status={link.status} />
      <span className="text-ink font-mono">
        {formatMoney(money(link.grandTotalMinor, link.currency))}
      </span>
    </p>
  );
}

/**
 * Why the button is not there.
 *
 * Each of these is a different fact and the cashier's next move differs for
 * every one of them, so none of them is "you cannot bill this visit".
 */
function whyNot(billing: AppointmentBilling, canRaise: boolean): string {
  if (!canRaise) return 'You can see what this visit costs, but not raise the bill for it.';

  switch (billing.blockedReason) {
    case 'APPOINTMENT_CANCELLED':
      return 'This visit was cancelled, so there is nothing to bill.';
    case 'APPOINTMENT_NO_SHOW':
      /*
       * ⚠️ A NO-SHOW IS BLOCKED HERE AND A NO-SHOW FEE IS A REAL THING. Those are
       *   not in tension: a missed appointment is not a consultation, so this
       *   door must not quietly bill an absent patient the consultation fee. A
       *   clinic that charges for the miss raises that bill at the amount it
       *   decided on.
       */
      return 'Nobody attended, so there is no consultation to bill. A clinic that charges for a missed appointment raises that bill from the invoices screen.';
    case 'ALREADY_BILLED':
      return 'This visit is already on an invoice.';
    default:
      return 'This visit cannot be billed from here.';
  }
}
