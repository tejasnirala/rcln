'use client';

import { useState } from 'react';
import { availableSlug } from '@rcln/contracts';
// No `inputClass` here: this input sits inside a bordered group with the domain
// suffix beside it, so the border lives on the wrapper instead.
import { describedBy, Field } from '@/components/ui/field';

/**
 * The apex domain cannot sign anybody in.
 *
 * A session cookie is scoped to the exact subdomain so that a session at
 * alpha.rcln.com is useless at beta.rcln.com (.kb/Architecture/architecture.md §3). There is
 * therefore no such thing as "logged in at rcln.com" — this screen's only job is
 * to work out which clinic you mean and hand you to its own address.
 *
 * Redirect is a full page navigation, not the Next router: the destination is a
 * different origin.
 */

const ROOT_DOMAIN = process.env['NEXT_PUBLIC_ROOT_DOMAIN'] ?? 'lvh.me';

export function ClinicFinder() {
  const [slug, setSlug] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [leaving, setLeaving] = useState(false);

  function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();

    // People paste the whole address. Take what we can recognise rather than
    // telling them off for it.
    const cleaned = slug
      .trim()
      .toLowerCase()
      .replace(/^https?:\/\//, '')
      .replace(new RegExp(`\\.${ROOT_DOMAIN.replace('.', '\\.')}.*$`), '')
      .replace(/\/.*$/, '');

    const parsed = availableSlug.safeParse(cleaned);
    if (!parsed.success) {
      setError(
        cleaned.length === 0
          ? 'Enter your clinic’s address.'
          : (parsed.error.issues[0]?.message ?? 'That is not a valid clinic address.')
      );
      return;
    }

    setError(null);
    setLeaving(true);

    // Keep the current port so this works on lvh.me:3000 in development and on
    // the bare domain in production.
    const { protocol, port } = window.location;
    window.location.assign(
      `${protocol}//${parsed.data}.${ROOT_DOMAIN}${port ? `:${port}` : ''}/login`
    );
  }

  return (
    <form
      onSubmit={onSubmit}
      className="border-rule bg-card rounded-lg border p-6 sm:p-8"
      noValidate
    >
      <Field
        name="slug"
        label="Your clinic’s address"
        hint="The name in front of the domain. Your team was given it when the clinic was set up."
        errors={error ? [error] : undefined}
      >
        <div className="border-rule focus-within:border-drape flex items-stretch overflow-hidden rounded-md border transition-colors">
          <input
            id="slug"
            name="slug"
            value={slug}
            onChange={(event) => {
              setSlug(event.target.value);
              if (error) setError(null);
            }}
            autoComplete="organization"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            placeholder="sunrise"
            aria-invalid={Boolean(error)}
            aria-describedby={describedBy('slug', true, Boolean(error))}
            className="text-ink placeholder:text-muted min-w-0 flex-1 bg-card px-3.5 py-2.5 text-[0.9375rem] focus:outline-none"
          />
          <span
            aria-hidden="true"
            className="border-rule bg-paper text-muted flex items-center border-l px-3 font-mono text-[0.8125rem] whitespace-nowrap"
          >
            .{ROOT_DOMAIN}
          </span>
        </div>
      </Field>

      <button
        type="submit"
        disabled={leaving}
        className="bg-drape text-paper hover:bg-drape-deep mt-6 inline-flex w-full items-center justify-center rounded-md px-5 py-3 text-[0.9375rem] font-medium transition-colors duration-150 disabled:opacity-60"
      >
        {leaving ? 'Taking you there…' : 'Continue'}
      </button>

      <p className="text-muted mt-5 text-[0.8125rem] leading-relaxed">
        Not sure of the address? Whoever set up the clinic can tell you — it is in the invitation
        email they sent you.
      </p>
    </form>
  );
}
