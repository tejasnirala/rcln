'use client';

import Link from 'next/link';
import { cn } from '@/lib/cn';
import { track, type AnalyticsEvent } from '@/lib/analytics';

const VARIANTS = {
  primary: 'bg-drape text-paper hover:bg-drape-deep',
  secondary: 'bg-card text-ink ring-1 ring-rule hover:bg-drape-tint hover:ring-drape/30',
  onInk: 'bg-paper text-ink hover:bg-drape-tint',
  quiet: 'text-ink hover:text-drape',
} as const;

/**
 * A call to action keeps its name for the whole flow: the button that says
 * "Book a demo" leads to a form whose submit says "Book a demo" and a
 * confirmation that says "Demo booked".
 */
export function Cta({
  href,
  variant = 'primary',
  event,
  className,
  children,
}: {
  href: string;
  variant?: keyof typeof VARIANTS;
  event?: AnalyticsEvent;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <Link
      href={href}
      onClick={event ? () => track(event) : undefined}
      className={cn(
        'inline-flex items-center justify-center rounded-md text-[0.9375rem] font-medium transition-colors duration-150',
        variant === 'quiet' ? 'px-1 py-1' : 'px-5 py-3',
        VARIANTS[variant],
        className
      )}
    >
      {children}
    </Link>
  );
}
