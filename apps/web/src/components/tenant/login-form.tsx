'use client';

import { useActionState, useEffect, useRef, useState } from 'react';
import { otpSignIn, signIn, type LoginFormState } from '@/app/(tenant)/t/[slug]/actions';
import { cn } from '@/lib/cn';
import { hardNavigate } from '@/lib/hard-navigate';
import { describedBy, Field, inputClass } from '@/components/ui/field';

const INITIAL: LoginFormState = { status: 'idle' };

type Method = 'password' | 'code';

/**
 * Two ways in, because Indian healthcare needs both: a doctor or an owner has
 * an email and a password, and a receptionist often has neither — the phone is
 * the identity the clinic already holds for them.
 */
export function LoginForm({ slug }: { slug: string }) {
  const [method, setMethod] = useState<Method>('password');

  return (
    <div className="border-rule bg-card rounded-lg border p-6 sm:p-8">
      <div
        role="tablist"
        aria-label="How to sign in"
        className="border-rule mb-6 flex gap-1 border-b"
      >
        {(
          [
            ['password', 'Password'],
            ['code', 'Code by SMS'],
          ] as const
        ).map(([value, label]) => (
          <button
            key={value}
            role="tab"
            type="button"
            aria-selected={method === value}
            onClick={() => setMethod(value)}
            className={cn(
              '-mb-px border-b-2 px-3 py-2.5 text-[0.875rem] font-medium transition-colors',
              method === value
                ? 'border-drape text-ink'
                : 'text-muted hover:text-ink border-transparent'
            )}
          >
            {label}
          </button>
        ))}
      </div>

      {method === 'password' ? <PasswordForm slug={slug} /> : <CodeForm slug={slug} />}
    </div>
  );
}

/**
 * Sign-in succeeded: leave the router and let the browser fetch the page.
 *
 * The Server Action deliberately does not redirect. `/` on this host is the
 * clinic home only after proxy.ts rewrites it, and a redirect out of an action
 * is resolved against the route tree instead — which lands on the public
 * landing page. See lib/hard-navigate.ts for the full account.
 */
function useSignedInNavigation(state: LoginFormState): void {
  useEffect(() => {
    if (state.status === 'signed-in') hardNavigate('/');
  }, [state.status]);
}

/** Focus the outcome: the first field at fault, or the message. */
function useOutcomeFocus(
  state: LoginFormState,
  ref: React.RefObject<HTMLFormElement | null>
): void {
  useEffect(() => {
    if (state.status === 'idle') return;
    const target =
      ref.current?.querySelector<HTMLElement>('[aria-invalid="true"]') ??
      ref.current?.querySelector<HTMLElement>('[role="alert"], [role="status"]');
    target?.focus();
  }, [state, ref]);
}

/**
 * The signed-in state, for the case where the effect cannot run.
 *
 * `useSignedInNavigation` handles this in a browser with JavaScript. Without it
 * the action still succeeded and the cookies are set, so the page must not just
 * sit there looking like nothing happened — a plain link finishes the job, and
 * being a real link it goes through the proxy exactly as the scripted path does.
 */
function ContinueLink({ state }: { state: LoginFormState }) {
  if (state.status !== 'signed-in') return null;

  return (
    <p role="status" tabIndex={-1} className="mt-6 text-[0.875rem]">
      {/*
       * A plain <a>, deliberately — `<Link>` is what the rule wants and what
       * this must not be. A client-side navigation to `/` resolves against the
       * route tree and lands on the marketing page; only a document load runs
       * proxy.ts and reaches the clinic. That is the whole bug this fixes.
       */}
      {/* eslint-disable-next-line @next/next/no-html-link-for-pages */}
      <a href="/" className="text-drape hover:text-drape-deep underline underline-offset-2">
        Continue to your clinic
      </a>
    </p>
  );
}

function Alert({ state }: { state: LoginFormState }) {
  if (state.status === 'idle' || !state.message) return null;

  const isError = state.status === 'error';
  return (
    <p
      role={isError ? 'alert' : 'status'}
      aria-live="polite"
      tabIndex={-1}
      className={cn(
        'mt-6 rounded-md px-4 py-3 text-[0.8125rem] leading-relaxed ring-1',
        isError
          ? 'ring-signal/25 bg-signal-tint text-signal'
          : 'ring-drape/25 bg-drape-tint/50 text-drape-deep'
      )}
    >
      {state.message}
    </p>
  );
}

const submitClass =
  'bg-drape text-paper hover:bg-drape-deep mt-6 inline-flex w-full items-center justify-center rounded-md px-5 py-3 text-[0.9375rem] font-medium transition-colors duration-150 disabled:opacity-60';

function PasswordForm({ slug }: { slug: string }) {
  // The slug is bound server-side so the browser cannot swap it for another
  // clinic's — a Server Action is a public POST endpoint, not just a form
  // handler.
  const [state, formAction, pending] = useActionState(signIn.bind(null, slug), INITIAL);
  const formRef = useRef<HTMLFormElement>(null);
  useSignedInNavigation(state);
  useOutcomeFocus(state, formRef);

  return (
    <form ref={formRef} action={formAction} noValidate>
      <div className="grid gap-5">
        <Field name="identifier" label="Email or phone" errors={state.fieldErrors?.['identifier']}>
          <input
            id="identifier"
            name="identifier"
            required
            autoComplete="username"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            className={inputClass}
            placeholder="you@clinic.in"
            aria-invalid={Boolean(state.fieldErrors?.['identifier'])}
            aria-describedby={describedBy(
              'identifier',
              false,
              Boolean(state.fieldErrors?.['identifier'])
            )}
          />
        </Field>

        <Field name="password" label="Password" errors={state.fieldErrors?.['password']}>
          <input
            id="password"
            name="password"
            type="password"
            required
            autoComplete="current-password"
            className={inputClass}
            aria-invalid={Boolean(state.fieldErrors?.['password'])}
            aria-describedby={describedBy(
              'password',
              false,
              Boolean(state.fieldErrors?.['password'])
            )}
          />
        </Field>
      </div>

      <Alert state={state} />
      <ContinueLink state={state} />

      <button type="submit" disabled={pending} className={submitClass}>
        {pending ? 'Signing in…' : 'Log in'}
      </button>
    </form>
  );
}

/**
 * One action, two steps.
 *
 * The obvious build is two `useActionState` hooks and a `sent` boolean synced
 * from the first one's result — but that means a setState inside an effect,
 * which cascades renders and is exactly what React's lint rule forbids.
 *
 * Driving both steps through a single action makes the step DERIVED: the server
 * says `otp-sent`, so the code field is what renders. Nothing to keep in sync,
 * and no state that can disagree with the server about where the user is.
 */
function CodeForm({ slug }: { slug: string }) {
  const [phone, setPhone] = useState('');
  const [state, formAction, pending] = useActionState(otpSignIn.bind(null, slug), INITIAL);

  const formRef = useRef<HTMLFormElement>(null);
  useSignedInNavigation(state);
  useOutcomeFocus(state, formRef);

  const sent = state.status === 'otp-sent';

  return (
    <form ref={formRef} action={formAction} noValidate>
      <Field
        name="phone"
        label="Mobile number"
        hint={
          sent
            ? 'We sent a six-digit code here. It expires in five minutes.'
            : 'We will send a six-digit code to this number.'
        }
        errors={state.fieldErrors?.['phone']}
      >
        <input
          id="phone"
          name="phone"
          type="tel"
          required
          autoComplete="tel"
          value={phone}
          onChange={(event) => setPhone(event.target.value)}
          readOnly={sent}
          className={cn(inputClass, 'font-mono', sent && 'bg-paper')}
          placeholder="+919876543210"
          aria-invalid={Boolean(state.fieldErrors?.['phone'])}
          aria-describedby={describedBy('phone', true, Boolean(state.fieldErrors?.['phone']))}
        />
      </Field>

      {sent ? (
        <div className="mt-5">
          <Field name="code" label="Your code" errors={state.fieldErrors?.['code']}>
            <input
              id="code"
              name="code"
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={8}
              required
              autoFocus
              className={cn(inputClass, 'font-mono tracking-[0.3em] tabular-nums')}
              placeholder="123456"
              aria-invalid={Boolean(state.fieldErrors?.['code'])}
              aria-describedby={describedBy('code', false, Boolean(state.fieldErrors?.['code']))}
            />
          </Field>
        </div>
      ) : null}

      <Alert state={state} />
      <ContinueLink state={state} />

      <button type="submit" disabled={pending} className={submitClass}>
        {pending ? (sent ? 'Checking…' : 'Sending…') : sent ? 'Sign in' : 'Send code'}
      </button>
    </form>
  );
}
