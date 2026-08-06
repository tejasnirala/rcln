'use client';

import { useState } from 'react';
import { cn } from '@/lib/cn';

/**
 * A password field you can read back.
 *
 * WHY IT EXISTS
 *   A password box is the one field that gives no feedback at all — the whole
 *   point of the masking. On a phone keyboard, with a 14-character password
 *   containing a symbol, "it says my password is wrong" and "I typed it wrong"
 *   are indistinguishable, and the only recovery is to clear the field and try
 *   again blind. NIST 800-63B says to allow the entry to be seen for exactly
 *   this reason. It matters most on the two screens that create a password —
 *   signup and accepting an invitation — where a typo is not a failed login but
 *   an account nobody can get into.
 *
 * ⚠️ THIS IS A SEPARATE FILE SO field.tsx CAN STAY SERVER-IMPORTABLE. The
 *   toggle needs state, and a `'use client'` on field.tsx would drag `Field`,
 *   `Input`, `Select` and every screen that renders one across the client
 *   boundary. It also deliberately does NOT import from field.tsx: `Input`
 *   passes the finished `className` down, so there is no import cycle between
 *   the two modules.
 *
 * WHAT IT DOES NOT DO
 *   It does not reveal by default, does not remember the choice between fields
 *   or across renders, and does not keep the password visible after submit. A
 *   password on screen is a password over someone's shoulder; the visible state
 *   lasts exactly as long as the person asked for it.
 */
export function PasswordControl({
  className,
  disabled,
  ...rest
}: React.ComponentPropsWithoutRef<'input'>) {
  const [visible, setVisible] = useState(false);

  return (
    <div className="relative">
      {/* `type` last: the caller's `type="password"` is what routed us here,
          and it is this component's to own from that point on. */}
      <input
        {...rest}
        disabled={disabled ?? false}
        className={className}
        type={visible ? 'text' : 'password'}
      />

      {/*
       * ⚠️ `type="button"`. Inside a <form> a button with no type is a SUBMIT
       *   button, so revealing the password would post the form — on the login
       *   screen, against a half-typed password.
       *
       * The label says what the button DOES, and changes when what it does
       * changes. No `aria-pressed`: with both, a screen reader announces the
       * state twice and they disagree about which way round it reads.
       *
       * 44px wide and the full height of the field: WCAG 2.5.8 asks for 24×24
       * and a thumb on a phone wants more. It sits in the `pr-11` that `Input`
       * reserves, so it cannot overlap the text being typed.
       */}
      {disabled ? null : (
        <button
          type="button"
          onClick={() => setVisible((shown) => !shown)}
          aria-label={visible ? 'Hide password' : 'Show password'}
          className={cn(
            'absolute inset-y-0 right-0 flex w-11 items-center justify-center',
            'text-muted hover:text-ink rounded-md transition-colors',
            // The ring is 3px outside the button, which would sit off the
            // field's right edge. Inset it so it lands on the control.
            'focus-visible:outline-offset-[-3px]'
          )}
        >
          {visible ? <EyeOffIcon /> : <EyeIcon />}
        </button>
      )}
    </div>
  );
}

/** Currently hidden — this shows it. */
function EyeIcon() {
  return (
    <svg
      viewBox="0 0 20 20"
      aria-hidden="true"
      className="h-[1.125rem] w-[1.125rem] fill-none stroke-current"
      strokeWidth="1.5"
    >
      <path d="M1.5 10S4.6 4.5 10 4.5 18.5 10 18.5 10 15.4 15.5 10 15.5 1.5 10 1.5 10Z" />
      <circle cx="10" cy="10" r="2.75" />
    </svg>
  );
}

/** Currently visible — this hides it. Same eye, struck through. */
function EyeOffIcon() {
  return (
    <svg
      viewBox="0 0 20 20"
      aria-hidden="true"
      className="h-[1.125rem] w-[1.125rem] fill-none stroke-current"
      strokeWidth="1.5"
      strokeLinecap="round"
    >
      <path d="M7.9 5A8.4 8.4 0 0 1 10 4.75c5.4 0 8.5 5.25 8.5 5.25a15.6 15.6 0 0 1-2.66 3.2M4.2 6.4A15.4 15.4 0 0 0 1.5 10s3.1 5.25 8.5 5.25c1.32 0 2.5-.28 3.53-.72" />
      <path d="M8.23 8.34A2.75 2.75 0 0 0 10 12.75c.72 0 1.38-.28 1.87-.73" />
      <path d="m3 3 14 14" />
    </svg>
  );
}
