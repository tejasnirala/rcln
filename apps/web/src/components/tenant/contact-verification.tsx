'use client';

import { useActionState, useRef } from 'react';
import { Field, inputClass } from '@/components/ui/field';
import { Button } from '@/components/ui/button';
import { Alert, useOutcomeFocus } from '@/components/ui/alert';
import {
  confirmVerificationCode,
  sendVerificationCode,
  type VerifyChannel,
  type VerifyFormState,
} from '@/app/(tenant)/t/[slug]/(app)/verify/actions';

const IDLE: VerifyFormState = { status: 'idle' };

/**
 * Your own contact details, and what each one is used for.
 *
 * TWO ROWS, AND EACH SAYS WHAT IT UNLOCKS
 *   The structure follows the branches week strip and the staff access ladder:
 *   the state is on the row, not behind an edit button. What is specific here is
 *   the second line. The two channels do genuinely different jobs at a clinic —
 *   email is the route a password reset and an invitation take, and a phone
 *   number is what lets you sign in when you are on a ward without a password.
 *   "Unverified" alone does not tell anyone why they should care; naming the
 *   thing they lose does, and it is true rather than decorative.
 *
 * The state word does the work, never the colour on its own (WCAG 1.4.1), and
 * the code field expands in place — no modal, like every other screen here.
 */

interface Channel {
  channel: VerifyChannel;
  label: string;
  /** The address or number itself, or null when the account has none. */
  destination: string | null;
  verified: boolean;
}

export function ContactVerification({
  slug,
  channels,
  masterCode,
}: {
  slug: string;
  channels: Channel[];
  /** The development master code, or null. Never set in production. */
  masterCode?: string | null;
}) {
  const outstanding = channels.filter((c) => !c.verified && c.destination).length;

  return (
    <>
      <div>
        <p className="eyebrow text-drape">Your account</p>
        <h1 className="font-display mt-2 text-3xl tracking-tight">Contact details</h1>
        <p className="text-muted mt-2 max-w-xl text-[0.9375rem] leading-relaxed">
          {outstanding === 0
            ? 'Both of these are confirmed. Nothing here needs your attention.'
            : 'Confirm these so the clinic can reach you and you can get back in if you are locked out. We send a short code to each one.'}
        </p>
      </div>

      {/*
        Development only, and it says so in as many words. No sender is wired
        yet, so without this the code is only in the API log. Styled as a plain
        dashed note rather than an Alert — it is not an outcome of anything the
        person just did, and dressing it as one would teach them to ignore the
        component that reports failures.
      */}
      {masterCode && outstanding > 0 ? (
        <p className="border-rule text-muted mt-6 rounded-md border border-dashed px-4 py-3 text-[0.8125rem] leading-relaxed">
          <span className="text-ink font-medium">Development build.</span> Email and SMS are not
          delivered yet, so the code <code className="text-ink">{masterCode}</code> confirms either
          of these. It will not sign anyone in, and it does not exist in production.
        </p>
      ) : null}

      <ul className="mt-8 grid gap-4">
        {channels.map((channel) => (
          <ChannelRow key={channel.channel} slug={slug} {...channel} />
        ))}
      </ul>
    </>
  );
}

const PURPOSE: Record<VerifyChannel, string> = {
  email: 'Password resets, invitations and clinic notices go here.',
  phone: 'Lets you sign in with a code instead of a password.',
};

function ChannelRow({ slug, channel, label, destination, verified }: Channel & { slug: string }) {
  const [sendState, send, sending] = useActionState(
    sendVerificationCode.bind(null, channel, slug),
    IDLE
  );
  const [confirmState, confirm, confirming] = useActionState(
    confirmVerificationCode.bind(null, channel, slug),
    IDLE
  );

  const formRef = useRef<HTMLFormElement>(null);
  useOutcomeFocus(confirmState.status, formRef);

  // The code field appears only once a code is actually on its way. Showing it
  // before that would invite someone to type a code that does not exist yet.
  const awaitingCode = sendState.status === 'sent' && confirmState.status !== 'verified';
  const codeError = confirmState.fieldErrors?.['code'];

  return (
    <li className="border-rule bg-card rounded-lg border p-5">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-muted eyebrow">{label}</span>
            <StateChip verified={verified} />
          </div>
          {destination ? (
            // An address or a number is an identifier, so it is set in mono —
            // the same treatment the invitations screen gives an email.
            <p className="text-ink mt-1.5 font-mono text-[0.9375rem] break-all">{destination}</p>
          ) : (
            <p className="text-muted mt-1.5 text-[0.9375rem]">Not set</p>
          )}
          <p className="text-muted mt-1 text-[0.8125rem]">{PURPOSE[channel]}</p>
        </div>

        {destination && !verified ? (
          <form action={send} className="shrink-0">
            <Button
              size="sm"
              variant={awaitingCode ? 'secondary' : 'primary'}
              type="submit"
              disabled={sending || confirming}
            >
              {sending ? 'Sending…' : awaitingCode ? 'Send another code' : 'Send a code'}
            </Button>
          </form>
        ) : null}
      </div>

      {sendState.status === 'error' ? (
        <Alert tone="error" className="mt-4">
          {sendState.message}
        </Alert>
      ) : null}

      {awaitingCode ? (
        <form ref={formRef} action={confirm} className="border-rule mt-4 border-t pt-4" noValidate>
          {sendState.message ? (
            <p className="text-muted text-[0.8125rem]">{sendState.message}</p>
          ) : null}

          <div className="mt-3 flex flex-wrap items-end gap-3">
            <Field name={`code-${channel}`} label="Code" errors={codeError}>
              <input
                id={`code-${channel}`}
                name="code"
                // `numeric` brings up the digit keypad on a phone without
                // rejecting a paste, which `type="number"` does.
                inputMode="numeric"
                autoComplete="one-time-code"
                maxLength={8}
                required
                aria-invalid={codeError ? true : undefined}
                aria-describedby={codeError ? `code-${channel}-error` : undefined}
                className={`${inputClass} w-40 font-mono tracking-[0.3em]`}
              />
            </Field>
            <Button type="submit" disabled={confirming} className="mb-[1px]">
              {confirming ? 'Confirming…' : 'Confirm code'}
            </Button>
          </div>

          {confirmState.status === 'error' ? (
            <Alert tone="error" className="mt-3">
              {confirmState.message}
            </Alert>
          ) : null}
        </form>
      ) : null}

      {confirmState.status === 'verified' || (sendState.status === 'verified' && !verified) ? (
        <Alert tone="info" className="mt-4">
          {confirmState.message ?? sendState.message}
        </Alert>
      ) : null}
    </li>
  );
}

function StateChip({ verified }: { verified: boolean }) {
  return (
    <span
      className={`rounded-xs px-2 py-0.5 text-[0.6875rem] font-medium ${
        verified ? 'bg-drape-tint text-drape-deep' : 'bg-signal-tint text-signal'
      }`}
    >
      {/* The word carries the meaning; the tint only reinforces it. */}
      {verified ? 'Confirmed' : 'Not confirmed'}
    </span>
  );
}
