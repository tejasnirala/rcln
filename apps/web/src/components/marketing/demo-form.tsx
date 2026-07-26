'use client';

import { useActionState, useEffect, useRef } from 'react';
import { bookDemo, type DemoFormState } from '@/app/(marketing)/actions';
import { track } from '@/lib/analytics';
import { cn } from '@/lib/cn';
import { describedBy, Field, inputClass } from '@/components/ui/field';

const INITIAL: DemoFormState = { status: 'idle' };

export function DemoForm() {
  const [state, action, pending] = useActionState(bookDemo, INITIAL);

  // Read on mount, not during render — Date.now() is impure and a re-render
  // would silently move the baseline. 0 means "not mounted yet", in which case
  // the timing check is skipped rather than sent a nonsense value.
  const renderedAt = useRef(0);
  useEffect(() => {
    renderedAt.current = Date.now();
  }, []);

  const formRef = useRef<HTMLFormElement>(null);
  const confirmationRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (state.status === 'booked') track('demo_request_submitted');
    if (state.status === 'error') track('demo_request_failed');
  }, [state.status]);

  // Send focus where the outcome is. On failure that is the first field at
  // fault — otherwise a keyboard user is left at the submit button with an
  // error they have no way to find.
  useEffect(() => {
    if (state.status === 'booked') {
      confirmationRef.current?.focus();
      return;
    }
    if (state.status !== 'error') return;

    const firstInvalid = formRef.current?.querySelector<HTMLElement>('[aria-invalid="true"]');
    (firstInvalid ?? formRef.current?.querySelector<HTMLElement>('[role="alert"]'))?.focus();
  }, [state]);

  if (state.status === 'booked') {
    return (
      <div
        ref={confirmationRef}
        tabIndex={-1}
        // The form it replaced is gone, so this has to announce itself.
        role="status"
        aria-live="polite"
        className="border-drape bg-drape-tint/40 rounded-lg border p-6 sm:p-8"
      >
        <p className="eyebrow text-drape">Demo booked</p>
        <h3 className="font-display mt-3 text-2xl">We have it. Someone will call.</h3>
        <p className="text-muted mt-3 text-[0.9375rem] leading-relaxed">
          Expect a call or a WhatsApp message within two working days, on the number you gave us.
          Nothing else happens to your details in the meantime.
        </p>
      </div>
    );
  }

  return (
    <form
      ref={formRef}
      action={(formData) => {
        if (renderedAt.current > 0) {
          formData.set('elapsedMs', String(Date.now() - renderedAt.current));
        }
        return action(formData);
      }}
      className="border-rule bg-card rounded-lg border p-6 sm:p-8"
      noValidate
    >
      <div className="grid gap-5 sm:grid-cols-2">
        <Field name="clinicName" label="Clinic name" errors={state.fieldErrors?.['clinicName']}>
          <input
            id="clinicName"
            name="clinicName"
            required
            autoComplete="organization"
            className={inputClass}
            placeholder="Sunrise Clinic"
            aria-invalid={Boolean(state.fieldErrors?.['clinicName'])}
            aria-describedby={describedBy(
              'clinicName',
              false,
              Boolean(state.fieldErrors?.['clinicName'])
            )}
          />
        </Field>

        <Field name="contactName" label="Your name" errors={state.fieldErrors?.['contactName']}>
          <input
            id="contactName"
            name="contactName"
            required
            autoComplete="name"
            className={inputClass}
            placeholder="Who should we ask for?"
            aria-invalid={Boolean(state.fieldErrors?.['contactName'])}
            aria-describedby={describedBy(
              'contactName',
              false,
              Boolean(state.fieldErrors?.['contactName'])
            )}
          />
        </Field>

        <Field name="email" label="Email" errors={state.fieldErrors?.['email']}>
          <input
            id="email"
            name="email"
            type="email"
            required
            autoComplete="email"
            className={inputClass}
            placeholder="you@clinic.in"
            aria-invalid={Boolean(state.fieldErrors?.['email'])}
            aria-describedby={describedBy('email', false, Boolean(state.fieldErrors?.['email']))}
          />
        </Field>

        {/* No hint here: the placeholder already demonstrates the format, and a
            hint on one field of a two-column row pushes its input off the
            baseline its neighbour sits on. */}
        <Field name="phone" label="Phone" errors={state.fieldErrors?.['phone']}>
          <input
            id="phone"
            name="phone"
            type="tel"
            required
            autoComplete="tel"
            className={cn(inputClass, 'font-mono')}
            placeholder="+919876543210"
            aria-invalid={Boolean(state.fieldErrors?.['phone'])}
            aria-describedby={describedBy('phone', false, Boolean(state.fieldErrors?.['phone']))}
          />
        </Field>

        <Field name="city" label="City" errors={state.fieldErrors?.['city']}>
          <input
            id="city"
            name="city"
            autoComplete="address-level2"
            className={inputClass}
            placeholder="Pune"
            aria-invalid={Boolean(state.fieldErrors?.['city'])}
            aria-describedby={describedBy('city', false, Boolean(state.fieldErrors?.['city']))}
          />
        </Field>

        <Field
          name="branchCount"
          label="How many branches?"
          errors={state.fieldErrors?.['branchCount']}
        >
          <input
            id="branchCount"
            name="branchCount"
            type="number"
            min={1}
            max={500}
            inputMode="numeric"
            className={cn(inputClass, 'font-mono tabular-nums')}
            placeholder="1"
            aria-invalid={Boolean(state.fieldErrors?.['branchCount'])}
            aria-describedby={describedBy(
              'branchCount',
              false,
              Boolean(state.fieldErrors?.['branchCount'])
            )}
          />
        </Field>
      </div>

      <div className="mt-5">
        <Field
          name="message"
          label="Anything we should know?"
          hint="How the day runs, what you use now, what keeps breaking. Please leave patient details out."
          errors={state.fieldErrors?.['message']}
        >
          <textarea
            id="message"
            name="message"
            rows={4}
            maxLength={2000}
            className={cn(inputClass, 'resize-y')}
            placeholder="Two doctors, one pharmacy counter, billing in a register."
            aria-invalid={Boolean(state.fieldErrors?.['message'])}
            aria-describedby={describedBy('message', true, Boolean(state.fieldErrors?.['message']))}
          />
        </Field>
      </div>

      {/*
       * Bot trap. `inert` — not `aria-hidden` — because aria-hidden wrapped
       * around a focusable input is itself an accessibility violation: the
       * element stays in the tab order while claiming not to exist. `inert`
       * removes it from both the accessibility tree and the focus order, so a
       * keyboard or screen-reader user can never land in it, while a script
       * filling every input on the page still trips it.
       */}
      <div inert className="absolute -left-[9999px] h-0 w-0 overflow-hidden">
        <label htmlFor="website">Website</label>
        <input id="website" name="website" tabIndex={-1} autoComplete="off" />
      </div>
      {/* Empty without JS, which the action then omits rather than sending a
          value the schema would reject. */}
      <input type="hidden" name="elapsedMs" defaultValue="" />

      {state.status === 'error' && state.message ? (
        <p
          role="alert"
          tabIndex={-1}
          className="ring-signal/25 bg-signal-tint text-signal mt-6 rounded-md px-4 py-3 text-[0.8125rem] ring-1"
        >
          {state.message}
        </p>
      ) : null}

      <div className="mt-7 flex flex-wrap items-center gap-4">
        <button
          type="submit"
          disabled={pending}
          className="bg-drape text-paper hover:bg-drape-deep inline-flex items-center justify-center rounded-md px-5 py-3 text-[0.9375rem] font-medium transition-colors duration-150 disabled:opacity-60"
        >
          {pending ? 'Booking…' : 'Book a demo'}
        </button>
        <p className="text-muted text-[0.8125rem]">
          We use this to contact you about rcln. Nothing else.
        </p>
      </div>
    </form>
  );
}
