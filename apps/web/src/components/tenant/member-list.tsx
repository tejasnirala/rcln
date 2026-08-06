'use client';

import { useActionState, useCallback, useMemo, useState } from 'react';
import type { MemberDetail, MemberListResponse } from '@rcln/contracts';
import { Input, Select, type SelectOption } from '@/components/ui/field';
import { Button } from '@/components/ui/button';
import { RecordHistory } from '@/components/tenant/record-history';
import { Alert } from '@/components/ui/alert';
import { actionLabel, moduleLabel, moduleOf } from '@/lib/permission-labels';
import {
  clearException,
  giveRole,
  restoreMember,
  saveDetails,
  saveException,
  suspendMember,
  takeRoleAway,
  type MemberFormState,
} from '@/app/(tenant)/t/[slug]/(app)/members/actions';

const IDLE: MemberFormState = { status: 'idle' };

/** Named as the act, not the enum: you block a permission, you do not DENY it. */
const EFFECTS: SelectOption[] = [
  { value: 'DENY', label: 'Block it' },
  { value: 'GRANT', label: 'Allow it' },
];

type RoleOption = MemberListResponse['roles'][number];
type BranchOption = MemberListResponse['branches'][number];

const STATUS_LABEL: Record<MemberDetail['status'], string> = {
  ACTIVE: 'Active',
  INVITED: 'Not joined yet',
  SUSPENDED: 'Suspended',
};

function StatusChip({ status }: { status: MemberDetail['status'] }) {
  if (status === 'ACTIVE') return null;

  const tone = status === 'SUSPENDED' ? 'bg-signal-tint text-signal' : 'bg-paper text-muted';
  return (
    <span className={`rounded-xs px-2 py-0.5 text-[0.6875rem] font-medium ${tone}`}>
      {STATUS_LABEL[status]}
    </span>
  );
}

/** "every branch" is a real answer, not a missing one, so it is spelled out. */
function whereItApplies(branchName: string | null): string {
  return branchName ?? 'every branch';
}

/**
 * The access ladder — the one thing this screen is built around.
 *
 * Access here is resolved in a fixed order: a role grants, an exception
 * overrules it, and a block beats an allow. That order is the only genuinely
 * confusing thing about the model, and a flat list of chips hides it — you
 * cannot tell from "Receptionist, blocked: refunds" which one wins.
 *
 * So the row is built in resolution order and the exceptions hang off the roles
 * they overrule, indented under a rule. The structure states the rule, which is
 * why the indent is information rather than decoration.
 *
 * A block is marked with a word and a sign, never colour alone (WCAG 1.4.1, and
 * apps/web/AGENTS.md lists it as a rule already got wrong once here).
 */
function AccessLadder({
  member,
  slug,
  editable,
}: {
  member: MemberDetail;
  slug: string;
  editable: boolean;
}) {
  return (
    <div className="mt-4">
      <p className="eyebrow text-muted">Roles</p>
      {member.roles.length === 0 ? (
        <p className="text-muted mt-2 text-[0.8125rem]">
          No roles. They can sign in and see nothing until you give them one.
        </p>
      ) : (
        <ul className="mt-2 grid gap-1.5">
          {member.roles.map((assignment) => (
            <li key={assignment.id} className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <span className="text-ink text-[0.875rem]">{assignment.roleName}</span>
              <span className="text-muted text-[0.8125rem]">
                at {whereItApplies(assignment.branchName)}
              </span>
              <code className="text-muted text-[0.6875rem]">{assignment.roleCode}</code>
              {editable ? (
                <RemoveRoleButton slug={slug} member={member} assignmentId={assignment.id} />
              ) : null}
            </li>
          ))}
        </ul>
      )}

      {member.overrides.length > 0 ? (
        <div className="border-rule mt-3 border-l-2 pl-4">
          <p className="eyebrow text-muted">Exceptions to those roles</p>
          <ul className="mt-2 grid gap-1.5">
            {member.overrides.map((override) => {
              const blocked = override.effect === 'DENY';
              return (
                <li key={override.id} className="flex flex-wrap items-center gap-x-2 gap-y-1">
                  <span
                    aria-hidden="true"
                    className={`font-mono text-[0.875rem] ${blocked ? 'text-signal' : 'text-drape'}`}
                  >
                    {blocked ? '−' : '+'}
                  </span>
                  <span
                    className={`text-[0.875rem] ${blocked ? 'text-signal' : 'text-drape-deep'}`}
                  >
                    {blocked ? 'Blocked' : 'Allowed'}
                  </span>
                  <span className="text-ink text-[0.8125rem]">
                    {moduleLabel(moduleOf(override.permissionCode))}:{' '}
                    {actionLabel(override.permissionCode)}
                  </span>
                  <span className="text-muted text-[0.8125rem]">
                    at {whereItApplies(override.branchName)}
                  </span>
                  {override.reason ? (
                    <span className="text-muted text-[0.8125rem]">— {override.reason}</span>
                  ) : null}
                  {editable ? (
                    <ClearExceptionButton slug={slug} member={member} overrideId={override.id} />
                  ) : null}
                </li>
              );
            })}
          </ul>
        </div>
      ) : null}
    </div>
  );
}

/**
 * Everyone who works at this clinic.
 *
 * Split by whether they can currently do anything: someone suspended or still
 * sitting on an invitation is a different kind of row from someone working
 * today, and that is the only distinction an administrator acts on. Same
 * structure as the invitations screen, deliberately — a third arrangement for
 * the same job would be worse than this one being plain.
 */
export function MemberList({
  slug,
  members,
  roles,
  branches,
  grantableCodes,
  canAssignOrgWide,
  canReadHistory,
}: {
  slug: string;
  members: MemberDetail[];
  roles: RoleOption[];
  branches: BranchOption[];
  grantableCodes: string[];
  canAssignOrgWide: boolean;
  canReadHistory: boolean;
}) {
  const working = members.filter((member) => member.status === 'ACTIVE');
  const inactive = members.filter((member) => member.status !== 'ACTIVE');

  return (
    <>
      <div className="max-w-xl">
        <p className="eyebrow text-drape">Access</p>
        <h1 className="font-display mt-2 text-3xl tracking-tight">Staff</h1>
        <p className="text-muted mt-2 text-[0.9375rem] leading-relaxed">
          Everyone with access to this clinic, and what each of them may do. Give access by role;
          use an exception when one person needs something their role does not cover.
        </p>
      </div>

      <section className="mt-8" aria-labelledby="working-heading">
        <h2 id="working-heading" className="eyebrow text-muted">
          Working here
        </h2>
        {working.length === 0 ? (
          <p className="text-muted mt-3 text-[0.875rem]">
            Nobody yet. Invite a colleague from the invitations screen.
          </p>
        ) : (
          <ul className="mt-3 grid gap-4">
            {working.map((member) => (
              <MemberCard
                key={member.id}
                slug={slug}
                member={member}
                roles={roles}
                branches={branches}
                grantableCodes={grantableCodes}
                canAssignOrgWide={canAssignOrgWide}
                canReadHistory={canReadHistory}
              />
            ))}
          </ul>
        )}
      </section>

      {inactive.length > 0 ? (
        <section className="border-rule mt-10 border-t pt-8" aria-labelledby="inactive-heading">
          <h2 id="inactive-heading" className="eyebrow text-muted">
            Not working here right now
          </h2>
          <ul className="mt-3 grid gap-4">
            {inactive.map((member) => (
              <MemberCard
                key={member.id}
                slug={slug}
                member={member}
                roles={roles}
                branches={branches}
                grantableCodes={grantableCodes}
                canAssignOrgWide={canAssignOrgWide}
                canReadHistory={canReadHistory}
              />
            ))}
          </ul>
        </section>
      ) : null}
    </>
  );
}

function MemberCard({
  slug,
  member,
  roles,
  branches,
  grantableCodes,
  canAssignOrgWide,
  canReadHistory,
}: {
  slug: string;
  member: MemberDetail;
  roles: RoleOption[];
  branches: BranchOption[];
  grantableCodes: string[];
  canAssignOrgWide: boolean;
  canReadHistory: boolean;
}) {
  const [panel, setPanel] = useState<'access' | 'details' | null>(null);
  const toggle = useCallback(
    (which: 'access' | 'details') => setPanel((open) => (open === which ? null : which)),
    []
  );

  // The API refuses any change to the caller's own access, so the controls that
  // would be refused are not offered. The record fields are not access, and stay.
  const editable = !member.isSelf;

  const employment = [member.designation, member.department, member.employeeCode]
    .filter(Boolean)
    .join(' · ');

  return (
    <li className="border-rule bg-card rounded-lg border p-5">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-ink text-[0.9375rem] font-medium">{member.fullName}</h3>
            <StatusChip status={member.status} />
            {member.isSelf ? (
              <span className="bg-drape-tint text-drape-deep rounded-xs px-2 py-0.5 text-[0.6875rem] font-medium">
                You
              </span>
            ) : null}
          </div>
          {/* An address is an identifier, so it is set in mono like a code. */}
          <p className="text-muted mt-1 font-mono text-[0.8125rem] break-all">{member.email}</p>
          {employment ? <p className="text-muted mt-1 text-[0.8125rem]">{employment}</p> : null}
        </div>

        <div className="flex shrink-0 flex-wrap items-center gap-2">
          {/* `membership`, not `user`: the audit rows for someone's access are
              written against their membership in THIS clinic, which is what a
              membership is (ADR-0001). Their user record is not this clinic's. */}
          {canReadHistory ? (
            <RecordHistory
              slug={slug}
              entityType="membership"
              entityId={member.id}
              label={member.fullName}
            />
          ) : null}
          {editable ? (
            <Button
              size="sm"
              variant="secondary"
              onClick={() => toggle('access')}
              aria-expanded={panel === 'access'}
            >
              {panel === 'access' ? 'Close' : 'Change access'}
            </Button>
          ) : null}
          <Button
            size="sm"
            variant="secondary"
            onClick={() => toggle('details')}
            aria-expanded={panel === 'details'}
          >
            {panel === 'details' ? 'Close' : 'Details'}
          </Button>
          {editable && member.status !== 'INVITED' ? (
            member.status === 'SUSPENDED' ? (
              <RestoreButton slug={slug} member={member} />
            ) : (
              <SuspendButton slug={slug} member={member} />
            )
          ) : null}
        </div>
      </div>

      <AccessLadder member={member} slug={slug} editable={editable && panel === 'access'} />

      {member.isSelf ? (
        <p className="text-muted mt-3 text-[0.8125rem]">
          You cannot change your own access. Ask another administrator at this clinic.
        </p>
      ) : null}

      {panel === 'access' ? (
        <div className="border-rule mt-5 grid gap-6 border-t pt-5 lg:grid-cols-2">
          <GiveRoleForm
            slug={slug}
            member={member}
            roles={roles}
            branches={branches}
            canAssignOrgWide={canAssignOrgWide}
          />
          <ExceptionForm
            slug={slug}
            member={member}
            branches={branches}
            grantableCodes={grantableCodes}
            canAssignOrgWide={canAssignOrgWide}
          />
        </div>
      ) : null}

      {panel === 'details' ? (
        <div className="border-rule mt-5 border-t pt-5">
          <DetailsForm slug={slug} member={member} />
        </div>
      ) : null}
    </li>
  );
}

/**
 * "Every branch" is offered only to someone whose own reach is the whole clinic.
 *
 * An org-wide grant covers branches that do not exist yet, so it is strictly
 * larger than ticking every branch you can see. The API refuses it from a
 * narrower caller; the form does not offer it, so nobody picks an option that is
 * going to be rejected.
 */
function BranchChoice({
  id,
  label,
  hint,
  branches,
  canAssignOrgWide,
  disabled,
}: {
  id: string;
  label: string;
  hint?: string;
  branches: BranchOption[];
  canAssignOrgWide: boolean;
  /** The chosen role is clinic-wide, so there is nothing to pick. */
  disabled?: boolean;
}) {
  if (disabled) {
    return (
      <Select
        id={id}
        label={label}
        {...(hint === undefined ? {} : { hint })}
        options={[{ value: 'every', label: 'Every branch' }]}
        defaultValue="every"
        disabled
      />
    );
  }

  return (
    <Select
      id={id}
      name="branchId"
      label={label}
      {...(hint === undefined ? {} : { hint })}
      defaultValue=""
      options={[
        ...(canAssignOrgWide ? [{ value: '', label: 'Every branch' }] : []),
        ...branches.map((branch) => ({
          value: branch.id,
          label: `${branch.name} (${branch.code})`,
        })),
      ]}
    />
  );
}

function GiveRoleForm({
  slug,
  member,
  roles,
  branches,
  canAssignOrgWide,
}: {
  slug: string;
  member: MemberDetail;
  roles: RoleOption[];
  branches: BranchOption[];
  canAssignOrgWide: boolean;
}) {
  const [state, action, pending] = useActionState(giveRole.bind(null, slug, member.id), IDLE);
  const [roleId, setRoleId] = useState(roles[0]?.id ?? '');

  const selected = roles.find((role) => role.id === roleId);
  // A clinic-wide role covers every branch by definition, so offering a branch
  // next to it would be a choice the API is going to refuse.
  const perBranch = selected?.scopeLevel === 'BRANCH';

  return (
    <form action={action} noValidate>
      <h4 className="text-ink text-[0.9375rem] font-medium">Give a role</h4>
      <p className="text-muted mt-1 text-[0.8125rem] leading-relaxed">
        Takes effect on their next request — they do not need to sign in again.
      </p>

      <div className="mt-3 grid gap-3">
        <Select
          id={`roleId-${member.id}`}
          name="roleId"
          label="Role"
          errors={state.fieldErrors?.['roleId']}
          value={roleId}
          onChange={(event) => setRoleId(event.target.value)}
          options={roles.map((role) => ({ value: role.id, label: role.name }))}
        />

        {/*
         * "Where" is ALWAYS on screen, even when the chosen role makes it
         * unavailable.
         *
         * It used to be rendered only for a branch-scoped role, replaced by a line
         * of prose otherwise — and the select defaults to the first role
         * alphabetically, which is `Accountant`, which is clinic-wide. So opening
         * this panel showed no branch control at all and a sentence saying there
         * was no branch to choose. The per-branch assignment worked; nothing on
         * screen suggested it existed.
         *
         * Showing the field disabled states the rule instead of hiding it: some
         * roles are clinic-wide, the rest are given per branch. A disabled control
         * submits nothing, so the API still receives no `branchId` for a
         * clinic-wide role — which it rejects outright (see `assignRole`).
         */}
        <BranchChoice
          id={`branchId-${member.id}`}
          label="Where"
          hint={
            perBranch
              ? 'One branch at a time. Give the same role again to add another.'
              : `${selected?.name ?? 'This role'} covers every branch, so there is nothing to choose.`
          }
          branches={branches}
          canAssignOrgWide={canAssignOrgWide}
          disabled={!perBranch}
        />
      </div>

      {state.status === 'error' ? (
        <Alert tone="error" className="mt-3">
          {state.message}
        </Alert>
      ) : null}

      <div className="mt-3">
        <Button size="sm" type="submit" disabled={pending}>
          {pending ? 'Giving…' : 'Give role'}
        </Button>
      </div>
    </form>
  );
}

function ExceptionForm({
  slug,
  member,
  branches,
  grantableCodes,
  canAssignOrgWide,
}: {
  slug: string;
  member: MemberDetail;
  branches: BranchOption[];
  grantableCodes: string[];
  canAssignOrgWide: boolean;
}) {
  const [state, action, pending] = useActionState(saveException.bind(null, slug, member.id), IDLE);

  // Grouped by module so a list of eighty codes is navigable. Sorted by the
  // label a person reads, not by the code.
  const groups = useMemo(() => {
    const byModule = new Map<string, string[]>();
    for (const code of [...grantableCodes].sort()) {
      const bucket = byModule.get(moduleOf(code));
      if (bucket) bucket.push(code);
      else byModule.set(moduleOf(code), [code]);
    }
    return [...byModule];
  }, [grantableCodes]);

  return (
    <form action={action} noValidate>
      <h4 className="text-ink text-[0.9375rem] font-medium">Add an exception</h4>
      <p className="text-muted mt-1 text-[0.8125rem] leading-relaxed">
        One permission, for this person only. A block always wins, whatever their roles say.
      </p>

      <div className="mt-3 grid gap-3">
        <Select
          id={`permissionCode-${member.id}`}
          name="permissionCode"
          label="Permission"
          errors={state.fieldErrors?.['permissionCode']}
          defaultValue=""
          placeholder="Choose a permission"
          options={groups.map(([module, codes]) => ({
            label: moduleLabel(module),
            options: codes.map((code) => ({ value: code, label: actionLabel(code) })),
          }))}
        />

        <div className="grid gap-3 sm:grid-cols-2">
          <Select
            id={`effect-${member.id}`}
            name="effect"
            label="Allow or block"
            defaultValue="DENY"
            options={EFFECTS}
          />
          <BranchChoice
            id={`exception-branch-${member.id}`}
            label="Where"
            branches={branches}
            canAssignOrgWide={canAssignOrgWide}
          />
        </div>

        <Input
          id={`reason-${member.id}`}
          name="reason"
          label="Why"
          hint="Recorded in the audit trail. The only record of why this exception exists."
          autoComplete="off"
        />
      </div>

      {state.status === 'error' ? (
        <Alert tone="error" className="mt-3">
          {state.message}
        </Alert>
      ) : null}

      <div className="mt-3">
        <Button size="sm" type="submit" disabled={pending}>
          {pending ? 'Saving…' : 'Save exception'}
        </Button>
      </div>
    </form>
  );
}

function DetailsForm({ slug, member }: { slug: string; member: MemberDetail }) {
  const [state, action, pending] = useActionState(saveDetails.bind(null, slug, member.id), IDLE);

  return (
    <form action={action} noValidate>
      <h4 className="text-ink text-[0.9375rem] font-medium">Employment record</h4>
      <p className="text-muted mt-1 text-[0.8125rem] leading-relaxed">
        Grants nothing. An empty box clears the field.
      </p>

      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        <Input
          id={`employeeCode-${member.id}`}
          name="employeeCode"
          label="Employee code"
          className="font-mono"
          defaultValue={member.employeeCode ?? ''}
          autoComplete="off"
        />
        <Input
          id={`designation-${member.id}`}
          name="designation"
          label="Designation"
          defaultValue={member.designation ?? ''}
          autoComplete="off"
        />
        <Input
          id={`department-${member.id}`}
          name="department"
          label="Department"
          defaultValue={member.department ?? ''}
          autoComplete="off"
        />
        <Input
          id={`joinedOn-${member.id}`}
          name="joinedOn"
          label="Joined on"
          type="date"
          defaultValue={member.joinedOn ?? ''}
        />
      </div>

      {state.status !== 'idle' && state.message ? (
        <Alert tone={state.status === 'error' ? 'error' : 'info'} className="mt-3">
          {state.message}
        </Alert>
      ) : null}

      <div className="mt-3">
        <Button size="sm" type="submit" disabled={pending}>
          {pending ? 'Saving…' : 'Save details'}
        </Button>
      </div>
    </form>
  );
}

function RemoveRoleButton({
  slug,
  member,
  assignmentId,
}: {
  slug: string;
  member: MemberDetail;
  assignmentId: string;
}) {
  const [state, action, pending] = useActionState(
    takeRoleAway.bind(null, slug, member.id, assignmentId),
    IDLE
  );

  return (
    <form action={action} className="contents">
      <Button size="sm" variant="ghost" className="text-signal" type="submit" disabled={pending}>
        {pending ? 'Removing…' : 'Remove'}
      </Button>
      {state.status === 'error' ? (
        <Alert tone="error" className="mt-1 w-full basis-full">
          {state.message}
        </Alert>
      ) : null}
    </form>
  );
}

function ClearExceptionButton({
  slug,
  member,
  overrideId,
}: {
  slug: string;
  member: MemberDetail;
  overrideId: string;
}) {
  const [state, action, pending] = useActionState(
    clearException.bind(null, slug, member.id, overrideId),
    IDLE
  );

  return (
    <form action={action} className="contents">
      <Button size="sm" variant="ghost" type="submit" disabled={pending}>
        {pending ? 'Removing…' : 'Remove'}
      </Button>
      {state.status === 'error' ? (
        <Alert tone="error" className="mt-1 w-full basis-full">
          {state.message}
        </Alert>
      ) : null}
    </form>
  );
}

function SuspendButton({ slug, member }: { slug: string; member: MemberDetail }) {
  const [confirming, setConfirming] = useState(false);
  const [state, action, pending] = useActionState(suspendMember.bind(null, slug, member.id), IDLE);

  if (!confirming) {
    return (
      <Button size="sm" variant="ghost" className="text-signal" onClick={() => setConfirming(true)}>
        Suspend access
      </Button>
    );
  }

  return (
    <form action={action} className="flex flex-wrap items-center gap-2">
      <label className="text-muted text-[0.75rem]">
        <span className="sr-only">Why this person is being suspended</span>
        <Input
          name="reason"
          placeholder="Reason (optional)"
          className="w-44 py-1.5 text-[0.8125rem]"
        />
      </label>
      <Button size="sm" variant="danger" type="submit" disabled={pending}>
        {pending ? 'Suspending…' : 'Suspend'}
      </Button>
      <Button size="sm" variant="ghost" onClick={() => setConfirming(false)}>
        Keep access
      </Button>
      {state.status === 'error' ? (
        <Alert tone="error" className="w-full basis-full">
          {state.message}
        </Alert>
      ) : null}
    </form>
  );
}

function RestoreButton({ slug, member }: { slug: string; member: MemberDetail }) {
  const [state, action, pending] = useActionState(restoreMember.bind(null, slug, member.id), IDLE);

  return (
    <form action={action} className="contents">
      <Button size="sm" variant="secondary" type="submit" disabled={pending}>
        {pending ? 'Restoring…' : 'Restore access'}
      </Button>
      {state.status === 'error' ? (
        <Alert tone="error" className="mt-2 w-full basis-full">
          {state.message}
        </Alert>
      ) : null}
    </form>
  );
}
