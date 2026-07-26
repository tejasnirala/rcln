import { cn } from '@/lib/cn';

const TONES = {
  paper: 'bg-paper text-ink',
  card: 'bg-card text-ink',
  // `on-ink` re-points the focus ring to the bright accent; the default one is
  // only 3.1:1 against this background.
  ink: 'bg-ink text-paper on-ink',
} as const;

/**
 * The single owner of vertical rhythm and horizontal gutter on this page.
 *
 * Nothing rendered inside a Section sets its own section-level padding — that
 * is how sibling rules end up cancelling each other out and why the spacing
 * looks almost right everywhere and wrong in two places.
 */
export function Section({
  id,
  tone = 'paper',
  className,
  children,
}: {
  id?: string;
  tone?: keyof typeof TONES;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <section id={id} className={cn('py-section', TONES[tone], className)}>
      <div className="mx-auto w-full max-w-6xl px-gutter">{children}</div>
    </section>
  );
}

/**
 * A section's opening. `eyebrow` is set in mono because it is a label the
 * interface applies, not prose someone wrote.
 */
export function SectionHead({
  eyebrow,
  title,
  lead,
  tone = 'paper',
  className,
}: {
  eyebrow: string;
  title: React.ReactNode;
  lead?: React.ReactNode;
  tone?: keyof typeof TONES;
  className?: string;
}) {
  const onInk = tone === 'ink';

  return (
    <div className={cn('max-w-2xl', className)}>
      <p className={cn('eyebrow', onInk && 'text-drape-tint/70')}>{eyebrow}</p>
      <h2 className="font-display text-title mt-4 text-balance">{title}</h2>
      {lead ? (
        <p
          className={cn('text-lead mt-5 text-pretty', onInk ? 'text-drape-tint/80' : 'text-muted')}
        >
          {lead}
        </p>
      ) : null}
    </div>
  );
}
