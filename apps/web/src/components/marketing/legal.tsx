import type { ReactNode } from 'react';

/**
 * Long-form legal chrome.
 *
 * Deliberately the quietest surface in the product. AGENTS.md reserves boldness
 * for the marketing shell and onboarding; a privacy policy's job is to be read
 * and understood, so this is a single narrow column, generous leading, and
 * nothing that competes with the words.
 *
 * Measure is capped near 68 characters — the point past which the eye starts
 * losing its place on the return sweep, and these documents are long.
 */

/**
 * A fact only the business can supply.
 *
 * Rendered loudly on purpose. These documents are unpublishable until every one
 * of these is replaced, and a quiet inline blank is exactly how a placeholder
 * reaches production. Grep for `Placeholder` to find them all.
 */
export function Placeholder({ children }: { children: ReactNode }) {
  return (
    <mark className="bg-signal-tint text-signal rounded-xs px-1 py-0.5 font-mono text-[0.8125em] font-medium">
      [{children}]
    </mark>
  );
}

export function LegalDoc({
  title,
  updated,
  summary,
  children,
}: {
  title: string;
  /** ISO date. Rendered as-is; these documents are versioned by date. */
  updated: string;
  summary: string;
  children: ReactNode;
}) {
  return (
    <div className="px-gutter mx-auto max-w-6xl py-16 sm:py-24">
      <div className="mx-auto max-w-[68ch]">
        <p className="eyebrow text-drape">Legal</p>
        <h1 className="font-display mt-3 text-3xl tracking-tight sm:text-4xl">{title}</h1>
        <p className="text-muted mt-2 font-mono text-[0.8125rem]">Last updated {updated}</p>

        <p className="text-ink mt-6 text-lg leading-relaxed">{summary}</p>

        <DraftNotice />

        <div className="mt-12">{children}</div>
      </div>
    </div>
  );
}

/**
 * The banner that has to come off before launch.
 *
 * A healthcare privacy policy that has not been through a lawyer is a liability,
 * not a formality — and an unreviewed one that looks finished is worse than an
 * obviously unfinished one, because nobody goes back to it.
 */
function DraftNotice() {
  return (
    <div
      role="note"
      className="ring-signal/25 bg-signal-tint mt-8 rounded-md px-5 py-4 text-[0.875rem] leading-relaxed ring-1"
    >
      <p className="text-signal font-medium">Draft — not yet in force</p>
      <p className="text-ink mt-1.5">
        This document has not been reviewed by counsel and contains unfilled placeholders. It does
        not bind anyone and must not be relied on. Remove this notice only after an Indian
        data-protection and healthcare lawyer has signed it off.
      </p>
    </div>
  );
}

export function Clause({
  id,
  n,
  title,
  children,
}: {
  id: string;
  /** Clause number. These get cited in email and in disputes, so they are stable. */
  n: string;
  title: string;
  children: ReactNode;
}) {
  return (
    <section
      id={id}
      className="scroll-mt-24 border-rule mt-10 border-t pt-10 first:mt-0 first:border-0 first:pt-0"
    >
      <h2 className="font-display text-xl tracking-tight">
        <span className="text-muted mr-2 font-mono text-[0.75em]">{n}</span>
        <a href={`#${id}`} className="hover:text-drape transition-colors">
          {title}
        </a>
      </h2>
      <div className="mt-4 space-y-4 text-[0.9375rem] leading-relaxed">{children}</div>
    </section>
  );
}

/** A defined term. Capitalised terms are load-bearing in a contract. */
export function Term({ children }: { children: ReactNode }) {
  return <strong className="text-ink font-medium">{children}</strong>;
}

/**
 * Genuinely tabular data — three or more columns that need comparing down a
 * column. For key/value pairs use `DefinitionList`: a table whose header cells
 * are blank announces empty column headers to a screen reader on every row.
 */
export function Table({ head, rows }: { head: string[]; rows: ReactNode[][] }) {
  return (
    // Wide content scrolls inside its own container rather than pushing the page.
    <div className="border-rule mt-2 overflow-x-auto rounded-md border">
      <table className="w-full min-w-[34rem] border-collapse text-left text-[0.875rem]">
        <thead>
          <tr className="border-rule bg-paper border-b">
            {/* Keyed by position, not by content: two columns can legitimately
                carry the same heading, and React silently drops the duplicate. */}
            {head.map((h, i) => (
              <th key={i} scope="col" className="text-ink px-4 py-2.5 font-medium">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-rule divide-y">
          {rows.map((row, i) => (
            <tr key={i}>
              {row.map((cell, j) => (
                <td key={j} className="text-muted px-4 py-2.5 align-top">
                  {cell}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/**
 * Term-and-meaning pairs: "Governing law — the laws of India", and the like.
 *
 * These were briefly a two-column `Table` with an empty header row, which is
 * what a definition list looks like if you reach for a table first. A `<dl>`
 * says what the relationship actually is, and drops the blank `<th>` cells that
 * a screen reader would otherwise announce against every row.
 */
export function DefinitionList({ items }: { items: { term: ReactNode; detail: ReactNode }[] }) {
  return (
    <dl className="border-rule mt-2 divide-y divide-[color:var(--color-rule)] rounded-md border">
      {items.map((item, i) => (
        <div key={i} className="grid gap-1 px-4 py-3 sm:grid-cols-[13rem_1fr] sm:gap-4">
          <dt className="text-ink text-[0.875rem] font-medium">{item.term}</dt>
          <dd className="text-muted text-[0.875rem] leading-relaxed">{item.detail}</dd>
        </div>
      ))}
    </dl>
  );
}

export function List({ items }: { items: ReactNode[] }) {
  return (
    <ul className="ml-1 space-y-2">
      {items.map((item, i) => (
        <li key={i} className="flex gap-3">
          <span
            aria-hidden="true"
            className="text-drape mt-[0.45em] h-1 w-1 shrink-0 rounded-full bg-current"
          />
          <span>{item}</span>
        </li>
      ))}
    </ul>
  );
}
