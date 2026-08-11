'use client';

import { useEffect } from 'react';
import { CircleAlert, CircleCheck, Info, TriangleAlert } from 'lucide-react';
import { cn } from '@/lib/cn';

/**
 * The outcome of an action, announced.
 *
 * Lifted verbatim from login-form.tsx, which had the only copy. An error that is
 * on screen but unlinked from the live region does not exist to a screen reader
 * (apps/web/AGENTS.md), so the role is chosen by tone rather than left to the
 * caller: `alert` interrupts, `status` waits its turn.
 *
 * ⚠️ THE THREE OUTCOME TONES DO NOT MOVE WITH THE ACCENT, AND `info` DOES.
 *   That is the split, not an oversight. Success, warning and error are facts
 *   about what happened and are drawn from the fixed status ramp in theme.css —
 *   a clinic that chose the orange accent has not decided that a declined
 *   payment is orange. `info` is a note rather than an outcome, so it is drawn
 *   in the accent, which is also what keeps the three dozen existing `tone="info"`
 *   call sites looking exactly as they did before the theme existed.
 *
 *   Error used to be `signal` — the live-state orange. It is `danger` now,
 *   because under a warm accent the old colour made a failure and a primary
 *   button the same hue, and `signal` still has a job: the thing happening now.
 *
 * Every tone carries a glyph and a word for a screen reader as well as a colour
 * (WCAG 1.4.1). Neither the colour nor the icon is load-bearing on its own.
 */
const TONES = {
  error: {
    className: 'ring-danger/30 bg-danger-tint text-danger',
    Icon: CircleAlert,
    word: 'Error',
  },
  warning: {
    className: 'ring-warning/30 bg-warning-tint text-warning',
    Icon: TriangleAlert,
    word: 'Warning',
  },
  success: {
    className: 'ring-success/30 bg-success-tint text-success',
    Icon: CircleCheck,
    word: 'Done',
  },
  info: {
    className: 'ring-drape/25 bg-drape-tint/50 text-drape-deep',
    Icon: Info,
    word: 'Note',
  },
} as const;

export function Alert({
  tone,
  children,
  className,
}: {
  tone: keyof typeof TONES;
  children: React.ReactNode;
  className?: string;
}) {
  if (!children) return null;

  const { className: toneClass, Icon, word } = TONES[tone];

  return (
    <p
      role={tone === 'error' ? 'alert' : 'status'}
      aria-live="polite"
      // Focusable so useOutcomeFocus can move the user here on submit.
      tabIndex={-1}
      className={cn(
        'flex items-start gap-2 rounded-md px-4 py-3 text-[0.8125rem] leading-relaxed ring-1',
        toneClass,
        className
      )}
    >
      {/* `mt-px` sits the glyph on the first line's cap height rather than its
          box, which is half a pixel off on a 13px line. */}
      <Icon className="mt-px size-4 shrink-0" aria-hidden="true" />
      <span>
        <span className="sr-only">{word}: </span>
        {children}
      </span>
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
