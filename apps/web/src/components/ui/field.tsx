/**
 * The form primitives every screen uses. Extracted from the demo form so the
 * accessibility wiring — label association, hint and error ids, the described-by
 * plumbing — is written once and inherited, rather than re-derived (and got
 * subtly wrong) on each new form.
 *
 * Accessibility rules these encode are recorded in apps/web/AGENTS.md.
 */

/**
 * The ids a field's hint and error are published under, so the input can point
 * at them with aria-describedby. Without this the error is on screen and a
 * screen reader never reads it.
 */
export function describedBy(name: string, hint: boolean, invalid: boolean): string | undefined {
  const ids = [hint ? `${name}-hint` : null, invalid ? `${name}-error` : null].filter(Boolean);
  return ids.length > 0 ? ids.join(' ') : undefined;
}

export function Field({
  name,
  label,
  hint,
  errors,
  action,
  children,
}: {
  name: string;
  label: string;
  hint?: string;
  errors?: string[];
  /** Optional control rendered opposite the label, e.g. a "Forgot password" link. */
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div>
      <div className="flex items-baseline justify-between gap-3">
        <label htmlFor={name} className="text-ink block text-sm font-medium">
          {label}
        </label>
        {action}
      </div>
      {hint ? (
        <p id={`${name}-hint`} className="text-muted mt-1 text-[0.8125rem]">
          {hint}
        </p>
      ) : null}
      <div className="mt-2">{children}</div>
      {errors?.length ? (
        <p id={`${name}-error`} className="text-signal mt-1.5 text-[0.8125rem]">
          {errors[0]}
        </p>
      ) : null}
    </div>
  );
}

// Placeholders carry the expected format, so they are held to the same 4.5:1
// as any other text. At 60% opacity this was 2.4:1.
export const inputClass =
  'w-full rounded-md border border-rule bg-card px-3.5 py-2.5 text-[0.9375rem] text-ink placeholder:text-muted transition-colors focus:border-drape focus:outline-none';
