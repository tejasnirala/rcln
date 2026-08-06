'use client';

import { useActionState, useCallback, useEffect, useRef, useState } from 'react';
import type { InvitationSummary } from '@rcln/contracts';
import { Input, Select } from '@/components/ui/field';
import { Button } from '@/components/ui/button';
import { Alert, useOutcomeFocus } from '@/components/ui/alert';
import {
  inviteMember,
  resendInvitation,
  revokeInvitation,
  type InviteFormState,
} from '@/app/(tenant)/t/[slug]/(app)/invitations/actions';

const IDLE: InviteFormState = { status: 'idle' };

interface RoleOption {
  id: string;
  code: string;
  name: string;
  scopeLevel: 'ORGANIZATION' | 'BRANCH';
}

interface BranchOption {
  id: string;
  name: string;
  code: string;
}

/**
 * How long is left, in the words someone would use.
 *
 * The status word carries the meaning on its own; this is the detail underneath
 * it. Colour never carries it alone (WCAG 1.4.1, and apps/web/AGENTS.md lists it
 * as a rule already got wrong once here).
 */
function countdown(daysLeft: number): string {
  if (daysLeft <= 0) return 'expires today';
  if (daysLeft === 1) return '1 day left';
  return `${String(daysLeft)} days left`;
}

const STATUS_LABEL: Record<InvitationSummary['status'], string> = {
  PENDING: 'Waiting',
  ACCEPTED: 'Joined',
  REVOKED: 'Cancelled',
  EXPIRED: 'Expired',
};

function StatusChip({ status }: { status: InvitationSummary['status'] }) {
  const tone =
    status === 'PENDING'
      ? 'bg-signal-tint text-signal'
      : status === 'ACCEPTED'
        ? 'bg-drape-tint text-drape-deep'
        : 'bg-paper text-muted';

  return (
    <span className={`rounded-xs px-2 py-0.5 text-[0.6875rem] font-medium ${tone}`}>
      {STATUS_LABEL[status]}
    </span>
  );
}

/**
 * Who is on their way in.
 *
 * The screen is built around one question — who is still outstanding, and how
 * long have they got — so waiting invitations sit above the line and everything
 * settled sits below it, with the countdown on the row rather than behind a
 * detail view. That split is the structure: it encodes "needs a decision" versus
 * "already decided", which is the only distinction an administrator acts on.
 *
 * No modal. The branches screen and the platform console both expand in place,
 * and a third pattern for the same job would be worse than this one being plain.
 */
export function InvitationList({
  slug,
  roles,
  branches,
  invitations,
}: {
  slug: string;
  roles: RoleOption[];
  branches: BranchOption[];
  invitations: InvitationSummary[];
}) {
  const [inviting, setInviting] = useState(false);
  // Stable, so InviteForm's "collapse once sent" effect does not re-fire on
  // every parent render.
  const closeInvite = useCallback(() => setInviting(false), []);

  const waiting = invitations.filter((i) => i.status === 'PENDING');
  const settled = invitations.filter((i) => i.status !== 'PENDING');

  return (
    <>
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="eyebrow text-drape">Access</p>
          <h1 className="font-display mt-2 text-3xl tracking-tight">Invitations</h1>
          <p className="text-muted mt-2 max-w-xl text-[0.9375rem] leading-relaxed">
            Everyone you have asked to join this clinic. A link expires seven days after it is sent,
            and can only be used once.
          </p>
        </div>
        <Button onClick={() => setInviting((open) => !open)} aria-expanded={inviting}>
          {inviting ? 'Cancel' : 'Invite someone'}
        </Button>
      </div>

      {inviting ? (
        <div className="border-drape bg-drape-tint/40 mt-6 rounded-lg border p-5">
          <InviteForm slug={slug} roles={roles} branches={branches} onDone={closeInvite} />
        </div>
      ) : null}

      <section className="mt-8" aria-labelledby="waiting-heading">
        <h2 id="waiting-heading" className="eyebrow text-muted">
          Waiting to join
        </h2>
        {waiting.length === 0 ? (
          <p className="text-muted mt-3 text-[0.875rem]">
            Nobody is waiting. Invite a colleague to give them access to this clinic.
          </p>
        ) : (
          <ul className="mt-3 grid gap-4">
            {waiting.map((invitation) => (
              <InvitationCard key={invitation.id} slug={slug} invitation={invitation} />
            ))}
          </ul>
        )}
      </section>

      {settled.length > 0 ? (
        <section className="border-rule mt-10 border-t pt-8" aria-labelledby="settled-heading">
          <h2 id="settled-heading" className="eyebrow text-muted">
            Already settled
          </h2>
          <ul className="mt-3 grid gap-4">
            {settled.map((invitation) => (
              <InvitationCard key={invitation.id} slug={slug} invitation={invitation} />
            ))}
          </ul>
        </section>
      ) : null}
    </>
  );
}

function InvitationCard({ slug, invitation }: { slug: string; invitation: InvitationSummary }) {
  const pending = invitation.status === 'PENDING';

  return (
    <li className="border-rule bg-card rounded-lg border p-5">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            {/* An address is an identifier, so it is set in mono like a code. */}
            <span className="text-ink font-mono text-[0.9375rem] break-all">
              {invitation.email}
            </span>
            <StatusChip status={invitation.status} />
          </div>
          <p className="text-muted mt-1 text-[0.8125rem]">
            {invitation.roleName}
            {' · '}
            {invitation.branches.length === 0
              ? 'every branch'
              : invitation.branches.map((b) => b.name).join(', ')}
          </p>
          <p className="text-muted mt-1 text-[0.8125rem]">
            Invited by {invitation.invitedByName}
            {pending ? (
              <>
                {' · '}
                <span className="text-signal font-mono">{countdown(invitation.daysLeft)}</span>
              </>
            ) : null}
          </p>
        </div>

        {pending ? (
          <div className="flex shrink-0 flex-wrap gap-2">
            <ResendButton slug={slug} invitation={invitation} />
            <RevokeButton slug={slug} invitation={invitation} />
          </div>
        ) : null}
      </div>
    </li>
  );
}

function ResendButton({ slug, invitation }: { slug: string; invitation: InvitationSummary }) {
  const [state, action, pending] = useActionState(
    resendInvitation.bind(null, slug, invitation.id),
    IDLE
  );

  return (
    <form action={action} className="contents">
      <Button size="sm" variant="secondary" type="submit" disabled={pending}>
        {pending ? 'Sending…' : 'Send a new link'}
      </Button>
      {state.status !== 'idle' && state.message ? (
        <Alert
          tone={state.status === 'error' ? 'error' : 'info'}
          className="mt-2 w-full basis-full"
        >
          {state.message}
        </Alert>
      ) : null}
    </form>
  );
}

function RevokeButton({ slug, invitation }: { slug: string; invitation: InvitationSummary }) {
  const [confirming, setConfirming] = useState(false);
  const [state, action, pending] = useActionState(
    revokeInvitation.bind(null, slug, invitation.id),
    IDLE
  );

  if (!confirming) {
    return (
      <Button size="sm" variant="ghost" className="text-signal" onClick={() => setConfirming(true)}>
        Cancel invitation
      </Button>
    );
  }

  return (
    <form action={action} className="flex flex-wrap items-center gap-2">
      <label className="text-muted text-[0.75rem]">
        <span className="sr-only">Why this invitation is being cancelled</span>
        <Input
          name="reason"
          placeholder="Reason (optional)"
          className="w-44 py-1.5 text-[0.8125rem]"
        />
      </label>
      <Button size="sm" variant="danger" type="submit" disabled={pending}>
        {pending ? 'Cancelling…' : 'Cancel it'}
      </Button>
      <Button size="sm" variant="ghost" onClick={() => setConfirming(false)}>
        Keep it
      </Button>
      {state.status === 'error' ? (
        <Alert tone="error" className="w-full basis-full">
          {state.message}
        </Alert>
      ) : null}
    </form>
  );
}

function InviteForm({
  slug,
  roles,
  branches,
  onDone,
}: {
  slug: string;
  roles: RoleOption[];
  branches: BranchOption[];
  onDone: () => void;
}) {
  const [state, action, pending] = useActionState(inviteMember.bind(null, slug), IDLE);
  const formRef = useRef<HTMLFormElement>(null);
  useOutcomeFocus(state.status, formRef);

  const [roleId, setRoleId] = useState(roles[0]?.id ?? '');
  const selected = roles.find((role) => role.id === roleId);
  // An organization-level role covers every branch by definition, so offering a
  // branch list next to it would be a choice the API is going to refuse.
  const branchScoped = selected?.scopeLevel === 'BRANCH';

  // Collapse once sent. In an effect, not in render: calling a parent's
  // setState during render produces the "Cannot update a component while
  // rendering a different component" warning.
  useEffect(() => {
    if (state.status === 'saved') onDone();
  }, [state.status, onDone]);

  const err = (name: string): string[] | undefined => state.fieldErrors?.[name];

  return (
    <form ref={formRef} action={action} noValidate>
      <h2 className="text-ink text-[0.9375rem] font-medium">Invite someone</h2>
      <p className="text-muted mt-1 text-[0.8125rem] leading-relaxed">
        They get a link by email. It works once, expires in seven days, and lets them set a password
        if they do not already have an rcln account.
      </p>

      <div className="mt-4 grid gap-4 sm:grid-cols-2">
        <Input
          name="email"
          label="Email address"
          errors={err('email')}
          type="email"
          className="font-mono"
          required
          autoComplete="off"
        />
        <Select
          name="roleId"
          label="Role"
          errors={err('roleId')}
          value={roleId}
          onChange={(event) => setRoleId(event.target.value)}
          options={roles.map((role) => ({ value: role.id, label: role.name }))}
        />
      </div>

      {branchScoped && branches.length > 0 ? (
        <fieldset className="mt-4">
          <legend className="text-ink text-sm font-medium">Branches</legend>
          <p className="text-muted mt-1 text-[0.8125rem]">
            Leave every box clear to give access to all branches, including ones you open later.
          </p>
          <div className="mt-2 flex flex-wrap gap-x-5 gap-y-2">
            {branches.map((branch) => (
              <label key={branch.id} className="flex items-center gap-2 py-1 text-[0.875rem]">
                <input
                  type="checkbox"
                  name="branchIds"
                  value={branch.id}
                  className="accent-drape h-4 w-4"
                />
                {branch.name}
                <code className="text-muted text-[0.75rem]">{branch.code}</code>
              </label>
            ))}
          </div>
        </fieldset>
      ) : null}

      {state.status === 'error' ? (
        <Alert tone="error" className="mt-5">
          {state.message}
        </Alert>
      ) : null}

      <div className="mt-5 flex gap-2">
        <Button type="submit" disabled={pending}>
          {pending ? 'Sending…' : 'Send invitation'}
        </Button>
        <Button variant="ghost" onClick={onDone}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
