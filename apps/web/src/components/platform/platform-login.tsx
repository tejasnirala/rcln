'use client';

import { useActionState, useEffect, useRef } from 'react';
import { platformSignIn, type PlatformLoginState } from '@/app/(platform)/platform/actions';
import { hardNavigate } from '@/lib/hard-navigate';
import { Input } from '@/components/ui/field';

const INITIAL: PlatformLoginState = { status: 'idle' };

export function PlatformLogin() {
  const [state, action, pending] = useActionState(platformSignIn, INITIAL);
  const formRef = useRef<HTMLFormElement>(null);

  // The action returns rather than redirecting; `/` on the admin host is the
  // console only after the proxy rewrite. See lib/hard-navigate.ts.
  useEffect(() => {
    if (state.status === 'signed-in') hardNavigate('/');
  }, [state.status]);

  useEffect(() => {
    if (state.status === 'idle') return;
    const target =
      formRef.current?.querySelector<HTMLElement>('[aria-invalid="true"]') ??
      formRef.current?.querySelector<HTMLElement>('[role="alert"]');
    target?.focus();
  }, [state]);

  return (
    <form
      ref={formRef}
      action={action}
      className="border-rule bg-card rounded-lg border p-6 sm:p-8"
      noValidate
    >
      <div className="grid gap-5">
        <Input
          name="identifier"
          label="Email"
          errors={state.fieldErrors?.['identifier']}
          required
          autoComplete="username"
          autoCapitalize="none"
          spellCheck={false}
        />

        <Input
          name="password"
          label="Password"
          errors={state.fieldErrors?.['password']}
          type="password"
          required
          autoComplete="current-password"
        />
      </div>

      {state.status === 'error' && state.message ? (
        <p
          role="alert"
          tabIndex={-1}
          className="ring-signal/25 bg-signal-tint text-signal mt-6 rounded-md px-4 py-3 text-[0.8125rem] ring-1"
        >
          {state.message}
        </p>
      ) : null}

      <button
        type="submit"
        disabled={pending}
        className="bg-drape text-paper hover:bg-drape-deep mt-6 inline-flex w-full items-center justify-center rounded-md px-5 py-3 text-[0.9375rem] font-medium transition-colors duration-150 disabled:opacity-60"
      >
        {pending ? 'Signing in…' : 'Sign in'}
      </button>
    </form>
  );
}
