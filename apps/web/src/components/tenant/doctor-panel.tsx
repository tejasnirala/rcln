import { cn } from '@/lib/cn';

/**
 * One section of a doctor's profile.
 *
 * ⚠️ THE `action` SLOT IS WHY THIS IS A SHARED COMPONENT RATHER THAN MARKUP
 *   REPEATED IN EACH PANEL. Editing a doctor used to live in one "Change this
 *   doctor" box holding three buttons, which put every control a long way from
 *   the thing it changed — you pressed "Working hours" at the top of the page and
 *   the hours themselves were four panels below. Each section now carries its own
 *   control in its own heading, so the button that edits the qualifications is
 *   the one sitting next to the qualifications.
 *
 * No `'use client'`: this is markup with a slot. The sections that need state put
 * a client component INTO the slot rather than making the whole panel one, which
 * keeps the read-only profile — and the doctor's own `/profile` screen — free of
 * the editing bundle.
 */
export function DoctorPanel({
  title,
  note,
  action,
  children,
  className,
}: {
  title: string;
  note?: string;
  /** The section's own edit control, if the reader holds the code for it. */
  action?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <section className={cn('border-rule bg-card mt-4 rounded-lg border p-5', className)}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="eyebrow text-drape">{title}</h2>
          {note ? <p className="text-muted mt-1 text-[0.8125rem]">{note}</p> : null}
        </div>
        {action ?? null}
      </div>
      {children}
    </section>
  );
}

export function PanelEmpty({ children }: { children: React.ReactNode }) {
  return <p className="text-muted mt-3 text-[0.8125rem]">{children}</p>;
}
