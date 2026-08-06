'use client';

import { useActionState, useCallback, useEffect, useRef, useState } from 'react';
import type { BranchDetail, OperatingHour } from '@rcln/contracts';
import { Input, Select, type SelectOption } from '@/components/ui/field';
import { Button } from '@/components/ui/button';
import { RecordHistory } from '@/components/tenant/record-history';
import { Alert, useOutcomeFocus } from '@/components/ui/alert';
import {
  createBranch,
  removeBranch,
  saveOperatingHours,
  updateBranch,
  type BranchFormState,
} from '@/app/(tenant)/t/[slug]/(app)/branches/actions';

const IDLE: BranchFormState = { status: 'idle' };

/** What kind of place this is. The API enum, named the way a clinic says it. */
const BRANCH_TYPES: SelectOption[] = [
  { value: 'CLINIC', label: 'Clinic' },
  { value: 'HOSPITAL', label: 'Hospital' },
  { value: 'LAB', label: 'Lab' },
  { value: 'PHARMACY', label: 'Pharmacy' },
];

/** "Open/Paused/Closed", not ACTIVE/INACTIVE/CLOSED — nobody pauses a branch by
 *  setting it inactive. */
const BRANCH_STATUSES: SelectOption[] = [
  { value: 'ACTIVE', label: 'Open' },
  { value: 'INACTIVE', label: 'Paused' },
  { value: 'CLOSED', label: 'Closed' },
];

/** Appointment slot lengths, in minutes. */
const SLOT_LENGTHS: SelectOption[] = [10, 15, 20, 30, 45, 60].map((minutes) => ({
  value: String(minutes),
  label: `${String(minutes)} min`,
}));

/**
 * Sunday first, matching `dayOfWeek` 0–6 in the contract, which in turn matches
 * Postgres `extract(dow)`. Not a display preference — renumbering here would
 * silently shift every stored day.
 */
const DAYS = [
  { short: 'Sun', full: 'Sunday' },
  { short: 'Mon', full: 'Monday' },
  { short: 'Tue', full: 'Tuesday' },
  { short: 'Wed', full: 'Wednesday' },
  { short: 'Thu', full: 'Thursday' },
  { short: 'Fri', full: 'Friday' },
  { short: 'Sat', full: 'Saturday' },
] as const;

function hourFor(hours: OperatingHour[], day: number): OperatingHour | undefined {
  return hours.find((h) => h.dayOfWeek === day);
}

/**
 * The week strip — the one thing this screen is built around.
 *
 * A branch is its opening hours to whoever answers the phone: "are we open on
 * Tuesday" is the question actually being asked of this screen. Putting the week
 * behind an edit button and leading with an address table would bury it, so the
 * whole week is on the row, always, and editing is the secondary act.
 *
 * The week is a real sequence, so its order carries information — which is what
 * earns the seven-cell layout rather than it being decoration.
 *
 * Closed days are marked with a dash AND the word, never colour alone
 * (WCAG 1.4.1, and apps/web/AGENTS.md lists it as a rule already got wrong once).
 */
function WeekStrip({ hours }: { hours: OperatingHour[] }) {
  if (hours.length === 0) {
    return (
      <p className="text-muted mt-4 text-[0.8125rem]">
        No opening hours set. This branch will not offer bookable slots.
      </p>
    );
  }

  return (
    <ul className="mt-4 grid grid-cols-7 gap-px overflow-hidden rounded-md border border-[color:var(--color-rule)] bg-[color:var(--color-rule)]">
      {DAYS.map((day, index) => {
        const hour = hourFor(hours, index);
        const closed = !hour || hour.isClosed;

        return (
          <li key={day.full} className="bg-card px-1.5 py-2 text-center">
            <p className="eyebrow text-muted" aria-hidden="true">
              {day.short}
            </p>
            <span className="sr-only">{day.full}: </span>
            {closed ? (
              <p className="text-muted mt-1 font-mono text-[0.75rem]">
                <span aria-hidden="true">—</span>
                <span className="sr-only">Closed</span>
              </p>
            ) : (
              <p className="text-ink mt-1 font-mono text-[0.6875rem] leading-tight">
                {hour.opensAt}
                <br />
                {hour.closesAt}
              </p>
            )}
          </li>
        );
      })}
    </ul>
  );
}

function StatusChip({ branch }: { branch: BranchDetail }) {
  if (branch.isPrimary) {
    return (
      <span className="bg-drape-tint text-drape-deep rounded-xs px-2 py-0.5 text-[0.6875rem] font-medium">
        Primary
      </span>
    );
  }
  if (branch.status === 'ACTIVE') return null;
  return (
    <span className="bg-signal-tint text-signal rounded-xs px-2 py-0.5 text-[0.6875rem] font-medium">
      {branch.status === 'INACTIVE' ? 'Paused' : 'Closed'}
    </span>
  );
}

export function BranchList({
  slug,
  branches,
  canReadHistory,
}: {
  slug: string;
  branches: BranchDetail[];
  canReadHistory: boolean;
}) {
  const [adding, setAdding] = useState(false);
  // Stable, so CreateForm's "collapse once saved" effect does not re-fire on
  // every parent render.
  const closeCreate = useCallback(() => setAdding(false), []);

  return (
    <>
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="eyebrow text-drape">Locations</p>
          <h1 className="font-display mt-2 text-3xl tracking-tight">Branches</h1>
          <p className="text-muted mt-2 max-w-xl text-[0.9375rem] leading-relaxed">
            Every place this clinic operates from. Opening hours here decide which slots can be
            booked.
          </p>
        </div>
        <Button onClick={() => setAdding((open) => !open)} aria-expanded={adding}>
          {adding ? 'Cancel' : 'Add a branch'}
        </Button>
      </div>

      {adding ? (
        <div className="border-drape bg-drape-tint/40 mt-6 rounded-lg border p-5">
          <CreateForm slug={slug} onDone={closeCreate} />
        </div>
      ) : null}

      <ul className="mt-8 grid gap-4">
        {branches.map((branch) => (
          <BranchCard key={branch.id} slug={slug} branch={branch} canReadHistory={canReadHistory} />
        ))}
      </ul>
    </>
  );
}

/**
 * A branch, with its editors expanded in place.
 *
 * No modal: the codebase has never had one, and the platform console already
 * established expand-in-place for row-level actions. A second pattern for the
 * same job is worse than this one being imperfect.
 */
function BranchCard({
  slug,
  branch,
  canReadHistory,
}: {
  slug: string;
  branch: BranchDetail;
  canReadHistory: boolean;
}) {
  const [panel, setPanel] = useState<'none' | 'details' | 'hours'>('none');
  const toggle = (next: 'details' | 'hours') => setPanel((p) => (p === next ? 'none' : next));

  return (
    <li className="border-rule bg-card rounded-lg border p-5">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-ink text-[1.0625rem] font-medium">{branch.name}</h2>
            {/* A code is system-generated, so it is set in mono. */}
            <code className="text-muted text-[0.75rem]">{branch.code}</code>
            <StatusChip branch={branch} />
          </div>
          <p className="text-muted mt-1 text-[0.8125rem]">
            {[branch.addressLine1, branch.city, branch.state, branch.pincode]
              .filter(Boolean)
              .join(', ') || 'No address on file'}
          </p>
        </div>

        <div className="flex shrink-0 items-center gap-2">
          {/* A reference rather than an action, so it is a quiet link beside the
              buttons rather than a third one competing with them. */}
          {canReadHistory ? (
            <RecordHistory
              slug={slug}
              entityType="branch"
              entityId={branch.id}
              label={branch.name}
            />
          ) : null}
          <Button
            size="sm"
            variant="secondary"
            onClick={() => toggle('hours')}
            aria-expanded={panel === 'hours'}
          >
            {panel === 'hours' ? 'Close' : 'Opening hours'}
          </Button>
          <Button
            size="sm"
            variant="secondary"
            onClick={() => toggle('details')}
            aria-expanded={panel === 'details'}
          >
            {panel === 'details' ? 'Close' : 'Edit'}
          </Button>
        </div>
      </div>

      <WeekStrip hours={branch.operatingHours} />

      {panel === 'details' ? (
        <div className="border-rule mt-5 border-t pt-5">
          <EditForm slug={slug} branch={branch} onDone={() => setPanel('none')} />
        </div>
      ) : null}

      {panel === 'hours' ? (
        <div className="border-rule mt-5 border-t pt-5">
          <HoursForm slug={slug} branch={branch} />
        </div>
      ) : null}
    </li>
  );
}

function CreateForm({ slug, onDone }: { slug: string; onDone: () => void }) {
  const [state, action, pending] = useActionState(createBranch.bind(null, slug), IDLE);
  const formRef = useRef<HTMLFormElement>(null);
  useOutcomeFocus(state.status, formRef);

  // Collapse the form once the branch exists. In an effect, not in render:
  // calling a parent's setState during render is what produces the
  // "Cannot update a component while rendering a different component" warning.
  useEffect(() => {
    if (state.status === 'saved') onDone();
  }, [state.status, onDone]);

  const err = (name: string): string[] | undefined => state.fieldErrors?.[name];

  return (
    <form ref={formRef} action={action} noValidate>
      <h2 className="text-ink text-[0.9375rem] font-medium">Add a branch</h2>

      <div className="mt-4 grid gap-4 sm:grid-cols-2">
        <Input name="name" label="Branch name" errors={err('name')} required autoComplete="off" />
        <Input
          name="code"
          label="Short code"
          hint="Used on invoices and reports. Letters and numbers, no spaces."
          errors={err('code')}
          className="font-mono uppercase"
          required
          autoComplete="off"
        />
        <Select
          name="branchType"
          label="Type"
          errors={err('branchType')}
          defaultValue="CLINIC"
          options={BRANCH_TYPES}
        />
        <Input
          name="phone"
          label="Phone"
          hint="Optional"
          errors={err('phone')}
          type="tel"
          autoComplete="off"
        />
        <Input
          name="addressLine1"
          label="Address"
          hint="Optional"
          errors={err('addressLine1')}
          autoComplete="off"
        />
        <Input name="city" label="City" hint="Optional" errors={err('city')} autoComplete="off" />
      </div>

      {state.status === 'error' ? (
        <Alert tone="error" className="mt-5">
          {state.message}
        </Alert>
      ) : null}

      <div className="mt-5 flex gap-2">
        <Button type="submit" disabled={pending}>
          {pending ? 'Adding…' : 'Add branch'}
        </Button>
        <Button variant="ghost" onClick={onDone}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

function EditForm({
  slug,
  branch,
  onDone,
}: {
  slug: string;
  branch: BranchDetail;
  onDone: () => void;
}) {
  const [state, action, pending] = useActionState(updateBranch.bind(null, slug, branch.id), IDLE);
  const formRef = useRef<HTMLFormElement>(null);
  useOutcomeFocus(state.status, formRef);

  const err = (name: string): string[] | undefined => state.fieldErrors?.[name];

  return (
    <form ref={formRef} action={action} noValidate>
      <div className="grid gap-4 sm:grid-cols-2">
        <Input
          id={`name-${branch.id}`}
          name="name"
          label="Branch name"
          errors={err('name')}
          defaultValue={branch.name}
          required
        />
        <Select
          id={`status-${branch.id}`}
          name="status"
          label="Status"
          errors={err('status')}
          defaultValue={branch.status}
          options={BRANCH_STATUSES}
        />
        <Input
          id={`phone-${branch.id}`}
          name="phone"
          label="Phone"
          errors={err('phone')}
          type="tel"
          defaultValue={branch.phone ?? ''}
        />
        <Input
          id={`addressLine1-${branch.id}`}
          name="addressLine1"
          label="Address"
          errors={err('addressLine1')}
          defaultValue={branch.addressLine1 ?? ''}
        />
        <Input
          id={`city-${branch.id}`}
          name="city"
          label="City"
          errors={err('city')}
          defaultValue={branch.city ?? ''}
        />
        <Input
          id={`pincode-${branch.id}`}
          name="pincode"
          label="PIN code"
          errors={err('pincode')}
          className="font-mono"
          defaultValue={branch.pincode ?? ''}
        />
      </div>

      {state.status !== 'idle' && state.message ? (
        <Alert tone={state.status === 'error' ? 'error' : 'info'} className="mt-5">
          {state.message}
        </Alert>
      ) : null}

      <div className="mt-5 flex flex-wrap items-center gap-2">
        <Button type="submit" disabled={pending}>
          {pending ? 'Saving…' : 'Save changes'}
        </Button>
        <Button variant="ghost" onClick={onDone}>
          Cancel
        </Button>
        {/* The primary branch cannot be retired; the API refuses it either way,
            but offering the button would be a promise the product does not keep. */}
        {branch.isPrimary ? null : <RemoveButton slug={slug} branch={branch} />}
      </div>
    </form>
  );
}

function RemoveButton({ slug, branch }: { slug: string; branch: BranchDetail }) {
  const [confirming, setConfirming] = useState(false);
  const [state, action, pending] = useActionState(removeBranch.bind(null, slug, branch.id), IDLE);

  if (!confirming) {
    return (
      <Button variant="ghost" className="text-signal ml-auto" onClick={() => setConfirming(true)}>
        Retire this branch
      </Button>
    );
  }

  return (
    <span className="ml-auto flex items-center gap-2">
      <span className="text-muted text-[0.8125rem]">Retire {branch.name}?</span>
      {/* A nested <form> is invalid HTML, so this posts via formAction on the
          button instead of wrapping the row in a second form element. */}
      <Button size="sm" variant="danger" formAction={action} type="submit" disabled={pending}>
        {pending ? 'Retiring…' : 'Yes, retire'}
      </Button>
      <Button size="sm" variant="ghost" onClick={() => setConfirming(false)}>
        Keep it
      </Button>
      {state.status === 'error' ? (
        <Alert tone="error" className="w-full">
          {state.message}
        </Alert>
      ) : null}
    </span>
  );
}

/**
 * The week, editable.
 *
 * Posts all seven days every time, because the endpoint replaces the set rather
 * than patching it — a day left out is a day the branch stops opening. Rendering
 * all seven makes that the obvious reading of the form rather than a surprise.
 */
function HoursForm({ slug, branch }: { slug: string; branch: BranchDetail }) {
  const [state, action, pending] = useActionState(
    saveOperatingHours.bind(null, slug, branch.id),
    IDLE
  );
  const formRef = useRef<HTMLFormElement>(null);
  useOutcomeFocus(state.status, formRef);

  return (
    <form ref={formRef} action={action} noValidate>
      <h3 className="text-ink text-[0.9375rem] font-medium">Opening hours</h3>
      <p className="text-muted mt-1 text-[0.8125rem]">
        Clear a day to close it. Slot length decides how appointment times are offered.
      </p>

      <div className="mt-4 grid gap-2">
        {DAYS.map((day, index) => {
          const hour = hourFor(branch.operatingHours, index);
          const open = hour ? !hour.isClosed : false;

          return (
            <div
              key={day.full}
              className="grid grid-cols-[7rem_1fr] items-center gap-3 sm:grid-cols-[8rem_auto_auto_auto]"
            >
              <label className="flex items-center gap-2 text-[0.875rem]">
                <input
                  type="checkbox"
                  name={`open-${String(index)}`}
                  defaultChecked={open}
                  className="accent-drape h-4 w-4"
                />
                {day.full}
              </label>

              <label className="text-muted flex items-center gap-2 text-[0.75rem]">
                <span className="sr-only">{day.full} opens at</span>
                <span aria-hidden="true">from</span>
                <Input
                  type="time"
                  name={`opensAt-${String(index)}`}
                  defaultValue={hour?.opensAt ?? '09:00'}
                  className="font-mono"
                />
              </label>

              <label className="text-muted flex items-center gap-2 text-[0.75rem]">
                <span className="sr-only">{day.full} closes at</span>
                <span aria-hidden="true">to</span>
                <Input
                  type="time"
                  name={`closesAt-${String(index)}`}
                  defaultValue={hour?.closesAt ?? '17:00'}
                  className="font-mono"
                />
              </label>

              <label className="text-muted flex items-center gap-2 text-[0.75rem]">
                <span className="sr-only">{day.full} slot length in minutes</span>
                <span aria-hidden="true">slots</span>
                <Select
                  name={`slotMinutes-${String(index)}`}
                  defaultValue={String(hour?.slotMinutes ?? 15)}
                  className="font-mono"
                  options={SLOT_LENGTHS}
                />
              </label>
            </div>
          );
        })}
      </div>

      {state.status !== 'idle' && state.message ? (
        <Alert tone={state.status === 'error' ? 'error' : 'info'} className="mt-5">
          {state.message}
        </Alert>
      ) : null}

      <Button type="submit" className="mt-5" disabled={pending}>
        {pending ? 'Saving…' : 'Save opening hours'}
      </Button>
    </form>
  );
}
