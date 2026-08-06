'use client';

import { useActionState, useState } from 'react';
import type { PlatformOrganizationSummary } from '@rcln/contracts';
import {
  startImpersonation,
  type ImpersonateState,
} from '@/app/(platform)/platform/organizations/actions';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/field';
import { ScopeSwitcher } from '@/components/shell/scope-switcher';
import { EnterClinic } from './enter-clinic';

/**
 * The clinic segment of the scope chain, for someone whose account belongs to no
 * clinic at all.
 *
 * WHY THIS IS THE SAME CONTROL A DOCTOR USES TO CHANGE BRANCH
 *   Because it is the same kind of act. A super admin has one more level of scope
 *   than an owner does, not a different kind of scope, so the header renders it as
 *   one more segment in the same chain (components/shell/scope-switcher.tsx). The
 *   alternative — a bespoke clinic picker — would have been a second dropdown to
 *   keep in step with the first for no gain.
 *
 * WHAT IT DOES NOT DO: SWITCH SILENTLY
 *   Changing branch is a re-issued token. Walking into a clinic is a session in
 *   somebody else's system of record, so it asks why first (ADR-0012) — which is
 *   what the popover's confirm step is for. The reason is not a formality: the
 *   clinic can read it in their own audit trail.
 *
 * PRE-SELECTED, NOT PRE-ENTERED
 *   `currentId` is the clinic this admin last asked for, remembered on
 *   `users.last_platform_organization_id`, so the header opens on the clinic they
 *   were working in. It does not resume that session. Signing in is not a stated
 *   reason, and an audit row saying somebody entered a clinic because their
 *   browser remembered it is worse than no shortcut at all.
 */

const INITIAL: ImpersonateState = { status: 'idle' };

export function ClinicSwitcher({
  organizations,
  lastOrganizationId,
}: {
  organizations: PlatformOrganizationSummary[];
  lastOrganizationId: string | null;
}) {
  /*
   * Which clinic the open form belongs to. The action is bound to an organization
   * id, so it is re-bound whenever the choice changes — `useActionState` is keyed
   * on nothing, and a stale binding would post the reason for one clinic against
   * another.
   */
  const [target, setTarget] = useState<string | null>(null);

  return (
    <ScopeSwitcher
      label="Clinic"
      placeholder="Choose a clinic"
      currentId={lastOrganizationId}
      options={organizations.map((organization) => ({
        id: organization.id,
        name: organization.displayName,
        detail:
          organization.status === 'ACTIVE'
            ? organization.slug
            : `${organization.slug} · ${organization.status.toLowerCase()}`,
      }))}
      onSwitch={() => {
        // Never reached: `confirm` is supplied, so a pick opens the reason step.
      }}
      confirm={(option, cancel) => (
        <EnterClinicForm
          key={option.id}
          organizationId={option.id}
          organizationName={option.name}
          onCancel={() => {
            setTarget(null);
            cancel();
          }}
          onOpen={() => setTarget(option.id)}
          active={target === option.id}
        />
      )}
    />
  );
}

/**
 * The reason, and then the handoff.
 *
 * Keyed by organization id in the parent, so choosing a different clinic gets a
 * fresh action state rather than the previous clinic's error still on screen.
 */
function EnterClinicForm({
  organizationId,
  organizationName,
  onCancel,
  onOpen,
  active,
}: {
  organizationId: string;
  organizationName: string;
  onCancel: () => void;
  onOpen: () => void;
  active: boolean;
}) {
  const [state, formAction, pending] = useActionState(
    startImpersonation.bind(null, organizationId),
    INITIAL
  );

  if (state.status === 'ready' && state.grant) {
    return <EnterClinic grant={state.grant} />;
  }

  const fieldId = `switch-reason-${organizationId}`;
  const errors = state.fieldErrors?.['reason'];

  return (
    <form action={formAction} onSubmit={onOpen} className="grid gap-3">
      <p className="text-muted text-[0.8125rem] leading-relaxed">
        You will be signed in to {organizationName} as rcln staff, with full read and write access.
        This reason lands in their audit trail with your name.
      </p>

      <Input
        id={fieldId}
        name="reason"
        label="Why are you going in?"
        hint="The clinic can read this. Name the ticket or the problem."
        errors={errors}
        type="text"
        required
        minLength={10}
        maxLength={500}
        autoComplete="off"
        placeholder="Investigating the empty revenue report they reported on 24 July"
      />

      {state.status === 'error' ? <Alert tone="error">{state.message}</Alert> : null}

      <div className="flex items-center gap-3">
        <Button type="submit" size="sm" disabled={pending && active}>
          {pending && active ? 'Opening…' : 'Enter this clinic'}
        </Button>
        <Button type="button" size="sm" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
