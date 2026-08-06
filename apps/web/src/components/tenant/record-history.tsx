'use client';

import { useRef, useState, useTransition } from 'react';
import type { AuditEntry, AuditHistoryResponse } from '@rcln/contracts';
import { readRecordHistory } from '@/app/(tenant)/t/[slug]/(app)/history-actions';
import { Alert } from '@/components/ui/alert';

/**
 * What has happened to one record: who changed it, what moved, and when.
 *
 * ONE COMPONENT, EVERY SCREEN. A branch row, a staff member, a role, the clinic's
 * own settings — the trail has the same shape for all of them because
 * `recordAudit` writes the same shape for all of them. Anything that starts
 * writing audit rows gets a history panel by passing two props, which is the point:
 * a per-screen history is a per-screen chance to render it differently.
 *
 * WHY A NATIVE `<dialog>`
 *   Focus trapping, Escape to close, returning focus to the trigger, and inertness
 *   of the page behind it are all things the platform does correctly and that
 *   hand-rolled panels get wrong. `showModal()` gives all four. The only thing
 *   added here is the sheet geometry — full height, pinned right — because a
 *   centred box is the wrong shape for a list that can be long.
 *
 *   This is the one modal in the product, and it earns the exception to the
 *   expand-in-place convention: history is a reference you consult beside what you
 *   are doing, not a step in doing it. Expanding a row would push the record you
 *   are comparing against off the screen.
 *
 * FETCHED ON OPEN, NOT WITH THE PAGE. A list of twenty branches would otherwise
 * cost twenty audit queries to render a button nobody pressed.
 *
 * NOTHING HERE IS DELETABLE, and there is no control suggesting otherwise.
 * `audit_logs` is append-only at the database — `rcln_app` holds no UPDATE or
 * DELETE, and a trigger refuses both regardless. See the `audit_immutability`
 * migration.
 */

export function RecordHistory({
  slug,
  entityType,
  entityId,
  /** What this record is called, for the panel's heading. Never a patient name. */
  label,
}: {
  slug: string;
  entityType: string;
  entityId: string;
  label: string;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [state, setState] = useState<
    | { status: 'idle' }
    | { status: 'ok'; history: AuditHistoryResponse }
    | { status: 'error'; message: string }
  >({ status: 'idle' });
  const [pending, startTransition] = useTransition();

  const open = (): void => {
    dialog.current?.showModal();

    // Re-read every time it is opened. A record's history changes as the record
    // does, and a cached trail is a trail that quietly omits the edit just made.
    startTransition(async () => {
      setState(await readRecordHistory(slug, entityType, entityId));
    });
  };

  return (
    <>
      <button
        type="button"
        onClick={open}
        // py-1 keeps the target above the 24px minimum (apps/web/AGENTS.md).
        className="text-muted hover:text-drape py-1 text-[0.8125rem] underline-offset-2 hover:underline"
      >
        History
      </button>

      <HistoryDialog ref={dialog} label={label}>
        {pending && state.status === 'idle' ? (
          <p className="text-muted text-[0.8125rem]" role="status">
            Loading…
          </p>
        ) : null}

        {state.status === 'error' ? <Alert tone="error">{state.message}</Alert> : null}

        {state.status === 'ok' ? <Trail history={state.history} /> : null}
      </HistoryDialog>
    </>
  );
}

function HistoryDialog({
  ref,
  label,
  children,
}: {
  ref: React.RefObject<HTMLDialogElement | null>;
  label: string;
  children: React.ReactNode;
}) {
  /*
   * A click on the backdrop closes it. `<dialog>` gives Escape for free but not
   * this, and the backdrop is the target everybody reaches for first.
   *
   * The test is on the dialog element itself rather than on a wrapper: the
   * backdrop is not a node, so a click on it lands on the dialog, while a click
   * anywhere inside lands on a descendant.
   */
  const onClick = (event: React.MouseEvent<HTMLDialogElement>): void => {
    if (event.target === ref.current) ref.current?.close();
  };

  return (
    <dialog
      ref={ref}
      onClick={onClick}
      aria-labelledby="record-history-title"
      /*
       * `open:flex` rather than `flex`: a `<dialog>` is `display: none` until
       * opened, and a flex utility would override that and leave it on screen.
       * `backdrop:` styles the ::backdrop pseudo-element.
       */
      className="open:flex bg-card text-ink ml-auto h-dvh max-h-dvh w-full max-w-md flex-col p-0 shadow-2xl backdrop:bg-ink/40"
    >
      <div className="border-rule flex items-start gap-4 border-b p-5">
        <div className="min-w-0">
          <p className="eyebrow text-drape">History</p>
          <h2
            id="record-history-title"
            className="font-display mt-1 truncate text-xl tracking-tight"
          >
            {label}
          </h2>
        </div>
        <button
          type="button"
          onClick={() => ref.current?.close()}
          className="text-muted hover:text-ink ml-auto shrink-0 px-2 py-1 text-[0.8125rem] underline underline-offset-2"
        >
          Close
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-5">{children}</div>
    </dialog>
  );
}

function Trail({ history }: { history: AuditHistoryResponse }) {
  if (history.entries.length === 0) {
    return (
      <p className="text-muted text-[0.875rem] leading-relaxed">
        Nothing recorded yet. Every change from here on is listed here, with who made it and when.
      </p>
    );
  }

  return (
    <>
      <ol className="grid gap-5">
        {history.entries.map((entry) => (
          <li key={entry.id}>
            <Entry entry={entry} />
          </li>
        ))}
      </ol>

      {history.truncated ? (
        <p className="border-rule text-muted mt-5 border-t pt-4 text-[0.75rem]">
          Older entries exist beyond this page.
        </p>
      ) : null}
    </>
  );
}

/** Past tense, because every one of these has already happened. */
const ACTION_LABEL: Record<AuditEntry['action'], string> = {
  CREATE: 'Created',
  UPDATE: 'Changed',
  DELETE: 'Removed',
  LOGIN: 'Signed in',
  LOGOUT: 'Signed out',
  EXPORT: 'Exported',
  SWITCH_BRANCH: 'Switched branch',
  IMPERSONATE: 'Opened by rcln staff',
  PERMISSION_CHANGE: 'Access changed',
};

function Entry({ entry }: { entry: AuditEntry }) {
  return (
    <article>
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
        <h3 className="text-ink text-[0.875rem] font-medium">{ACTION_LABEL[entry.action]}</h3>
        <p className="text-muted text-[0.8125rem]">
          {/* "by nobody" is wrong; the actor is genuinely unknown once the account
              is gone, and the row is kept precisely so the change is not lost. */}
          by {entry.actor?.fullName ?? 'a deleted account'}
          {entry.onBehalfOf ? (
            <>
              {' · '}
              <span className="text-signal">as rcln staff ({entry.onBehalfOf.fullName})</span>
            </>
          ) : null}
        </p>
      </div>

      {/* Absolute, in the reader's own zone. `suppressHydrationWarning` because the
          server renders it in the container's — the reader's clock is correct. */}
      <p className="text-muted mt-0.5 font-mono text-[0.75rem]">
        <time dateTime={entry.occurredAt} suppressHydrationWarning>
          {new Date(entry.occurredAt).toLocaleString([], {
            day: 'numeric',
            month: 'short',
            year: 'numeric',
            hour: '2-digit',
            minute: '2-digit',
          })}
        </time>
      </p>

      {entry.changes.length > 0 ? (
        <dl className="border-rule mt-2 grid gap-1.5 border-l pl-3">
          {entry.changes.map((change) => (
            <div key={change.field} className="grid gap-0.5">
              <dt className="text-muted text-[0.75rem]">{fieldLabel(change.field)}</dt>
              <dd className="text-ink flex flex-wrap items-baseline gap-1.5 font-mono text-[0.75rem]">
                {'before' in change ? (
                  <span className="text-muted line-through">{format(change.before)}</span>
                ) : null}
                {'before' in change && 'after' in change ? (
                  <span aria-hidden="true" className="text-muted">
                    →
                  </span>
                ) : null}
                {'after' in change ? <span>{format(change.after)}</span> : null}
                {/* Strikethrough and an arrow are not readable as "was, is" to a
                    screen reader (WCAG 1.4.1). */}
                <span className="sr-only">
                  {'before' in change && 'after' in change
                    ? `was ${format(change.before)}, now ${format(change.after)}`
                    : 'before' in change
                      ? `was ${format(change.before)}, now unset`
                      : `set to ${format(change.after)}`}
                </span>
              </dd>
            </div>
          ))}
        </dl>
      ) : null}
    </article>
  );
}

/** `displayName` -> "display name". The API stores the column as it is written. */
function fieldLabel(field: string): string {
  return field
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/_/g, ' ')
    .toLowerCase();
}

/**
 * A stored value, as one line of text.
 *
 * Audit values are ids, codes and configuration — `recordAudit` redacts
 * credentials and CONVENTIONS.md forbids putting a name on the row — so there is
 * no formatting to do beyond making an object readable and an absence visible.
 */
function format(value: unknown): string {
  if (value === null || value === undefined) return 'not set';
  if (value === '') return 'empty';
  if (typeof value === 'boolean') return value ? 'yes' : 'no';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}
