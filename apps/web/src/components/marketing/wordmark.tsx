import { cn } from '@/lib/cn';

/**
 * The mark is the journey rail compressed to 20px: a record (the rounded
 * rectangle) with the live token entering it at the left. Same idea as the
 * hero, at logo scale.
 */
export function Wordmark({ className }: { className?: string }) {
  return (
    <span className={cn('inline-flex items-center gap-2.5', className)}>
      <svg
        width="22"
        height="22"
        viewBox="0 0 22 22"
        fill="none"
        aria-hidden="true"
        className="shrink-0"
      >
        <rect
          x="4.5"
          y="3.5"
          width="14"
          height="15"
          rx="2.5"
          stroke="currentColor"
          strokeWidth="1.6"
        />
        <path d="M8.5 8.5h6M8.5 12h6M8.5 15.5h3.5" stroke="currentColor" strokeWidth="1.6" />
        <circle cx="2.6" cy="11" r="2.6" fill="var(--color-signal)" />
      </svg>
      <span className="text-[1.0625rem] font-semibold tracking-[-0.02em] lowercase">rcln</span>
    </span>
  );
}
