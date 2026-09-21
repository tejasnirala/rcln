'use client';

import { useRef, useState, type ReactNode } from 'react';
import { Alert, useOutcomeFocus } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { CatalogueNav } from '@/components/tenant/catalogue-nav';
import type { MasterFormState } from '@/app/(tenant)/t/[slug]/(app)/products/masters-actions';

/**
 * The shell the four flat master screens share: manufacturers, ingredients,
 * categories and storage requirements.
 *
 * ⚠️ THE ONE THING EVERY ROW ON EVERY ONE OF THESE SCREENS HAS TO SAY IS WHO OWNS
 *   IT, AND THAT IS WHAT THIS FILE EXISTS TO MAKE UNMISSABLE. Each of these lists
 *   is two catalogues rendered as one: the rows rcln ships to every clinic
 *   (`isOwn: false`) and the rows this clinic added. A platform row cannot be
 *   changed — `assertMutable` refuses it, and underneath that Postgres refuses
 *   the UPDATE because the row's `organization_id` is NULL. So a platform row is
 *   drawn with the tag and NO EDIT CONTROL at all, rather than an edit control
 *   that fails on submit. "Add your own instead" is a sentence somebody should
 *   read before typing, not after.
 *
 * ⚠️ THE TAG IS A WORD, NEVER ONLY A DIMMING (WCAG 1.4.1). "Platform" and the
 *   clinic's own rows differ in what you may DO with them, which no shade
 *   conveys.
 *
 * ⚠️ ADD IS A DISCLOSURE ON THE LIST, NOT A `/new` PAGE, AND THAT IS A DELIBERATE
 *   DEPARTURE FROM `/products/new` AND `/procurement/suppliers/new`. Those create
 *   one substantial record at a time. These are four-field rows keyed in a batch
 *   during setup — twenty manufacturers off the back of a supplier statement —
 *   and a page load between each is the whole reason this was faster to do
 *   through the API. The form stays open after a successful save for the same
 *   reason.
 *
 * ⚠️ NOTHING HERE DELETES, because the API exposes no DELETE and should not: a
 *   row removed under a product that names it is a foreign key pointing at
 *   nothing. Retiring one is the Active checkbox, and the service refuses while
 *   anything still names it — and says how many.
 *
 * NO PHI on any screen that uses this.
 */

interface ScreenProps {
  title: string;
  /** One sentence: what this list is, in the clinic's words. */
  blurb: string;
  /** The label on the disclosure button, e.g. "Add a manufacturer". */
  addLabel: string;
  /** Rendered inside the add form. Field names must match the action. */
  addFields: ReactNode;
  addState: MasterFormState;
  addAction: (payload: FormData) => void;
  addPending: boolean;
  canManage: boolean;
  children: ReactNode;
}

export function CatalogueMasterScreen({
  title,
  blurb,
  addLabel,
  addFields,
  addState,
  addAction,
  addPending,
  canManage,
  children,
}: ScreenProps) {
  const [adding, setAdding] = useState(false);
  const formRef = useRef<HTMLFormElement>(null);
  useOutcomeFocus(addState.status, formRef);

  return (
    <div className="space-y-8">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="font-display text-ink text-[1.75rem] leading-tight tracking-tight">
            {title}
          </h1>
          <p className="text-muted mt-1 max-w-2xl text-[0.875rem]">{blurb}</p>
        </div>
        {canManage ? (
          <Button
            type="button"
            variant={adding ? 'secondary' : 'primary'}
            onClick={() => setAdding((open) => !open)}
            aria-expanded={adding}
          >
            {adding ? 'Close' : addLabel}
          </Button>
        ) : null}
      </header>

      <CatalogueNav />

      {adding && canManage ? (
        <form
          ref={formRef}
          action={addAction}
          className="border-rule bg-card space-y-4 rounded-md border p-4"
        >
          <h2 className="text-ink border-rule border-b pb-2 text-[0.9375rem] font-medium">
            {addLabel}
          </h2>

          {addState.status === 'error' && addState.message ? (
            <Alert tone="error">{addState.message}</Alert>
          ) : null}
          {addState.status === 'saved' ? <Alert tone="success">Added.</Alert> : null}

          {addFields}

          <div className="flex items-center gap-3">
            <Button type="submit" disabled={addPending}>
              {addPending ? 'Saving…' : 'Save'}
            </Button>
            <button
              type="button"
              onClick={() => setAdding(false)}
              className="text-muted hover:text-drape px-2 py-2 text-[0.875rem]"
            >
              Cancel
            </button>
          </div>
        </form>
      ) : null}

      {children}
    </div>
  );
}

interface RowProps {
  /** What the row is called. The primary line. */
  name: string;
  /** The stable code, rendered monospaced because it is keyed and compared. */
  code: string;
  /** One line of the facts worth seeing without opening anything. */
  detail: string;
  isOwn: boolean;
  isActive: boolean;
  canManage: boolean;
  /** The edit form's fields and its save state. Omitted for a platform row. */
  editState?: MasterFormState;
  editAction?: (payload: FormData) => void;
  editPending?: boolean;
  editFields?: ReactNode;
}

export function CatalogueMasterRow({
  name,
  code,
  detail,
  isOwn,
  isActive,
  canManage,
  editState,
  editAction,
  editPending,
  editFields,
}: RowProps) {
  const [editing, setEditing] = useState(false);
  const formRef = useRef<HTMLFormElement>(null);
  useOutcomeFocus(editState?.status ?? 'idle', formRef);

  const editable = canManage && isOwn && editAction !== undefined;

  return (
    <li className="border-rule bg-card rounded-md border p-4">
      <div className="flex flex-wrap items-start gap-x-4 gap-y-2">
        <div className="min-w-56 flex-1">
          <p className="text-ink text-[1rem] font-medium">
            {name}
            {isActive ? null : (
              <span className="text-muted ml-2 text-[0.8125rem] font-normal">· Retired</span>
            )}
          </p>
          <p className="text-muted mt-0.5 text-[0.8125rem]">
            <span className="font-mono">{code}</span>
            {detail ? ` · ${detail}` : ''}
          </p>
        </div>

        <span className="border-rule text-muted rounded-full border px-3 py-1 text-[0.75rem]">
          {isOwn ? 'This clinic' : 'Platform'}
        </span>

        {editable ? (
          <Button
            type="button"
            variant="secondary"
            onClick={() => setEditing((open) => !open)}
            aria-expanded={editing}
          >
            {editing ? 'Close' : 'Edit'}
          </Button>
        ) : null}
      </div>

      {/*
       * ⚠️ THE PLATFORM ROW SAYS WHY IT HAS NO EDIT BUTTON, RATHER THAN JUST NOT
       *   HAVING ONE. A list where some rows are editable and some are not, with
       *   nothing explaining which, reads as a permission problem — and the next
       *   thing that happens is somebody asking an administrator for a code they
       *   already hold.
       */}
      {canManage && !isOwn ? (
        <p className="text-muted mt-2 text-[0.8125rem]">
          Part of the platform catalogue, so it cannot be changed here. Add your own if this one is
          not right.
        </p>
      ) : null}

      {editing && editable ? (
        <form
          ref={formRef}
          action={editAction}
          className="border-rule mt-4 space-y-4 border-t pt-4"
        >
          {editState?.status === 'error' && editState.message ? (
            <Alert tone="error">{editState.message}</Alert>
          ) : null}
          {editState?.status === 'saved' ? <Alert tone="success">Saved.</Alert> : null}

          {editFields}

          <div className="flex items-center gap-3">
            <Button type="submit" disabled={editPending}>
              {editPending ? 'Saving…' : 'Save changes'}
            </Button>
            <button
              type="button"
              onClick={() => setEditing(false)}
              className="text-muted hover:text-drape px-2 py-2 text-[0.875rem]"
            >
              Cancel
            </button>
          </div>
        </form>
      ) : null}
    </li>
  );
}

/** What a list says when the clinic has not added anything yet. */
export function CatalogueMasterEmpty({ children }: { children: ReactNode }) {
  return (
    <div className="border-rule bg-card rounded-md border p-10 text-center">
      <p className="text-ink text-[0.9375rem]">Nothing here yet.</p>
      <p className="text-muted mx-auto mt-2 max-w-md text-[0.875rem]">{children}</p>
    </div>
  );
}

/**
 * The shared "in use" checkbox every edit form ends with.
 *
 * ⚠️ THE HINT SAYS RETIRING CAN BE REFUSED, BECAUSE IT CAN. Every one of these
 *   services counts what still names the row and throws a sentence with the
 *   number in it rather than orphaning a foreign key. Somebody who reads
 *   "retire" as "hide it from the picker" and gets a refusal has been misled by
 *   the label, and the refusal arrives after the click instead of before it.
 */
export function ActiveCheckbox({
  defaultChecked,
  noun,
}: {
  defaultChecked: boolean;
  noun: string;
}) {
  return (
    <label className="text-ink flex items-start gap-2 py-1 text-[0.875rem]">
      <input
        type="checkbox"
        name="isActive"
        defaultChecked={defaultChecked}
        className="mt-0.5 h-4 w-4"
      />
      <span>
        In use
        <span className="text-muted mt-0.5 block text-[0.8125rem]">
          Clear this to stop offering the {noun} on new records. It is refused while anything still
          names it, and the refusal says how many.
        </span>
      </span>
    </label>
  );
}
