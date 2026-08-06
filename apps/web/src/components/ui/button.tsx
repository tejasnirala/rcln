import { cn } from '@/lib/cn';

/**
 * The one button.
 *
 * Extracted from the three places that had grown identical copies of the same
 * class string (login-form, platform-login, demo-request-list). Nothing here is
 * new: the variants are exactly what those files were already doing, named.
 *
 * `danger` is the only addition, for destructive actions like retiring a branch.
 * It is `signal` — which the palette reserves for "live right now" — because
 * that is also the colour the existing error alerts use, and inventing a second
 * warm hue for one button would weaken both.
 */

type Variant = 'primary' | 'secondary' | 'danger' | 'ghost';

const VARIANTS: Record<Variant, string> = {
  primary: 'bg-drape text-paper hover:bg-drape-deep',
  secondary: 'border-rule bg-card text-ink hover:bg-drape-tint/40 border',
  danger: 'border-signal/30 bg-signal-tint text-signal hover:bg-signal-tint/70 border',
  ghost: 'text-drape hover:bg-drape-tint/50',
};

const SIZES = {
  // py-3 clears the 24px minimum target from WCAG 2.5.8 on its own.
  md: 'px-5 py-3 text-[0.9375rem]',
  sm: 'px-3 py-2 text-[0.8125rem]',
} as const;

export function Button({
  variant = 'primary',
  size = 'md',
  fullWidth,
  className,
  type = 'button',
  ...props
}: React.ComponentProps<'button'> & {
  variant?: Variant;
  size?: keyof typeof SIZES;
  fullWidth?: boolean;
}) {
  // `ComponentProps<'button'>` rather than `ButtonHTMLAttributes` so `ref` is
  // among the props. React 19 passes a ref to a function component like any
  // other prop, so it already reached the element through the spread below —
  // only the type was missing, and callers that need to move focus after a state
  // change (the checkout card does) could not say so.
  return (
    <button
      // Explicit, because a bare <button> inside a <form> submits it, and most
      // of the buttons on a CRUD screen are toggles that must not.
      type={type}
      className={cn(
        'inline-flex items-center justify-center rounded-md font-medium transition-colors duration-150 disabled:opacity-60',
        VARIANTS[variant],
        SIZES[size],
        fullWidth && 'w-full',
        className
      )}
      {...props}
    />
  );
}
