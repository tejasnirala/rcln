'use client';

import { useEffect } from 'react';
import { cn } from '@/lib/cn';

/**
 * The outcome of an action, announced.
 *
 * Lifted verbatim from login-form.tsx, which had the only copy. An error that is
 * on screen but unlinked from the live region does not exist to a screen reader
 * (apps/web/AGENTS.md), so the role is chosen by tone rather than left to the
 * caller: `alert` interrupts, `status` waits its turn.
 */
export function Alert({
  tone,
  children,
  className,
}: {
  tone: 'error' | 'info';
  children: React.ReactNode;
  className?: string;
}) {
  if (!children) return null;

  const isError = tone === 'error';
  return (
    <p
      role={isError ? 'alert' : 'status'}
      aria-live="polite"
      // Focusable so useOutcomeFocus can move the user here on submit.
      tabIndex={-1}
      className={cn(
        'rounded-md px-4 py-3 text-[0.8125rem] leading-relaxed ring-1',
        isError
          ? 'ring-signal/25 bg-signal-tint text-signal'
          : 'ring-drape/25 bg-drape-tint/50 text-drape-deep',
        className
      )}
    >
      {children}
    </p>
  );
}

/**
 * After a submit, put the user where the answer is.
 *
 * The first field at fault if there is one, otherwise the message itself. Both
 * login-form.tsx and platform-login.tsx had grown their own copy of this; new
 * forms should import it rather than write a third.
 */
export function useOutcomeFocus(status: string, ref: React.RefObject<HTMLElement | null>): void {
  useEffect(() => {
    if (status === 'idle') return;
    const target =
      ref.current?.querySelector<HTMLElement>('[aria-invalid="true"]') ??
      ref.current?.querySelector<HTMLElement>('[role="alert"], [role="status"]');
    target?.focus();
  }, [status, ref]);
}
