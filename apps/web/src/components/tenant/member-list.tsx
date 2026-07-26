'use client';

import { useActionState, useCallback, useMemo, useState } from 'react';
import type { MemberDetail, MemberListResponse } from '@rcln/contracts';
import { Field, inputClass } from '@/components/ui/field';
import { Button } from '@/components/ui/button';
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
}: {
  slug: string;
  members: MemberDetail[];
  roles: RoleOption[];
  branches: BranchOption[];
  grantableCodes: string[];
  canAssignOrgWide: boolean;
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
}: {
  slug: string;
  member: MemberDetail;
  roles: RoleOption[];
  branches: BranchOption[];
  grantableCodes: string[];
  canAssignOrgWide: boolean;
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

        <div className="flex shrink-0 flex-wrap gap-2">
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
  name,
  branches,
  canAssignOrgWide,
}: {
  name: string;
  branches: BranchOption[];
  canAssignOrgWide: boolean;
}) {
  return (
    <select id={name} name="branchId" className={inputClass} defaultValue="">
      {canAssignOrgWide ? <option value="">Every branch</option> : null}
      {branches.map((branch) => (
        <option key={branch.id} value={branch.id}>
          {branch.name} ({branch.code})
        </option>
      ))}
    </select>
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
        <Field name={`roleId-${member.id}`} label="Role" errors={state.fieldErrors?.['roleId']}>
          <select
            id={`roleId-${member.id}`}
            name="roleId"
            className={inputClass}
            value={roleId}
            onChange={(event) => setRoleId(event.target.value)}
          >
            {roles.map((role) => (
              <option key={role.id} value={role.id}>
                {role.name}
              </option>
            ))}
          </select>
        </Field>

        {perBranch ? (
          <Field name={`branchId-${member.id}`} label="Where">
            <BranchChoice
              name={`branchId-${member.id}`}
              branches={branches}
              canAssignOrgWide={canAssignOrgWide}
            />
          </Field>
        ) : (
          <p className="text-muted text-[0.8125rem]">
            {selected?.name} covers the whole clinic, so there is no branch to choose.
          </p>
        )}
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
        <Field
          name={`permissionCode-${member.id}`}
          label="Permission"
          errors={state.fieldErrors?.['permissionCode']}
        >
          <select
            id={`permissionCode-${member.id}`}
            name="permissionCode"
            className={inputClass}
            defaultValue=""
          >
            <option value="" disabled>
              Choose a permission
            </option>
            {groups.map(([module, codes]) => (
              <optgroup key={module} label={moduleLabel(module)}>
                {codes.map((code) => (
                  <option key={code} value={code}>
                    {actionLabel(code)}
                  </option>
                ))}
              </optgroup>
            ))}
          </select>
        </Field>

        <div className="grid gap-3 sm:grid-cols-2">
          <Field name={`effect-${member.id}`} label="Allow or block">
            <select
              id={`effect-${member.id}`}
              name="effect"
              className={inputClass}
              defaultValue="DENY"
            >
              <option value="DENY">Block it</option>
              <option value="GRANT">Allow it</option>
            </select>
          </Field>
          <Field name={`exception-branch-${member.id}`} label="Where">
            <BranchChoice
              name={`exception-branch-${member.id}`}
              branches={branches}
              canAssignOrgWide={canAssignOrgWide}
            />
          </Field>
        </div>

        <Field
          name={`reason-${member.id}`}
          label="Why"
          hint="Recorded in the audit trail. The only record of why this exception exists."
        >
          <input
            id={`reason-${member.id}`}
            name="reason"
            className={inputClass}
            autoComplete="off"
          />
        </Field>
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
        <Field name={`employeeCode-${member.id}`} label="Employee code">
          <input
            id={`employeeCode-${member.id}`}
            name="employeeCode"
            className={`${inputClass} font-mono`}
            defaultValue={member.employeeCode ?? ''}
            autoComplete="off"
          />
        </Field>
        <Field name={`designation-${member.id}`} label="Designation">
          <input
            id={`designation-${member.id}`}
            name="designation"
            className={inputClass}
            defaultValue={member.designation ?? ''}
            autoComplete="off"
          />
        </Field>
        <Field name={`department-${member.id}`} label="Department">
          <input
            id={`department-${member.id}`}
            name="department"
            className={inputClass}
            defaultValue={member.department ?? ''}
            autoComplete="off"
          />
        </Field>
        <Field name={`joinedOn-${member.id}`} label="Joined on">
          <input
            id={`joinedOn-${member.id}`}
            name="joinedOn"
            type="date"
            className={inputClass}
            defaultValue={member.joinedOn ?? ''}
          />
        </Field>
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
        <input
          name="reason"
          placeholder="Reason (optional)"
          className={`${inputClass} w-44 py-1.5 text-[0.8125rem]`}
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
