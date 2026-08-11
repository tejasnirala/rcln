'use client';

import { useActionState, useRef, useState } from 'react';
import type { PlatformOrganizationSummary } from '@rcln/contracts';
import {
  startImpersonation,
  type ImpersonateState,
} from '@/app/(platform)/platform/organizations/actions';
import { cn } from '@/lib/cn';
import { formatDate } from '@/lib/format';
import { Alert, useOutcomeFocus } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/field';
import { EnterClinic } from './enter-clinic';

/**
 * Every clinic on the platform, and the one thing that can be done to one from
 * here: walk into it.
 *
 * Expand-in-place, like every other list in the product — no modal. What the
 * disclosure hides is not a detail view but a decision: opening it is the moment
 * you commit to writing your name into somebody else's audit trail, and the
 * reason field is the first thing under it rather than the last.
 */

const INITIAL: ImpersonateState = { status: 'idle' };

export function OrganizationList({
  organizations,
}: {
  organizations: PlatformOrganizationSummary[];
}) {
  const [openId, setOpenId] = useState<string | null>(null);

  if (organizations.length === 0) {
    return (
      <div className="border-rule bg-card rounded-lg border p-8 text-center">
        <p className="text-ink text-[0.9375rem]">No clinics yet.</p>
        <p className="text-muted mt-2 text-[0.8125rem]">
          They appear here when someone signs up, or when you provision one from a demo request.
        </p>
      </div>
    );
  }

  return (
    <ul className="grid gap-3">
      {organizations.map((org) => (
        <OrganizationRow
          key={org.id}
          organization={org}
          open={openId === org.id}
          onToggle={() => setOpenId((current) => (current === org.id ? null : org.id))}
        />
      ))}
    </ul>
  );
}

function OrganizationRow({
  organization,
  open,
  onToggle,
}: {
  organization: PlatformOrganizationSummary;
  open: boolean;
  onToggle: () => void;
}) {
  const [state, formAction, pending] = useActionState(
    startImpersonation.bind(null, organization.id),
    INITIAL
  );
  const region = useRef<HTMLDivElement>(null);
  useOutcomeFocus(state.status, region);

  const active = organization.status === 'ACTIVE';

  return (
    <li className="border-rule bg-card rounded-lg border">
      <div className="flex flex-wrap items-start gap-x-6 gap-y-2 p-5">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <h3 className="text-ink text-[0.9375rem] font-medium">{organization.displayName}</h3>
            {/* A subdomain is an identifier the system generated, so it is set
                in mono like every other one (globals.css). */}
            <span className="text-muted font-mono text-[0.75rem]">{organization.slug}</span>
            <span
              className={cn(
                'rounded-sm px-1.5 py-0.5 font-mono text-[0.6875rem]',
                active ? 'bg-drape-tint text-drape-deep' : 'bg-signal-tint text-signal'
              )}
            >
              {organization.status.toLowerCase()}
            </span>
          </div>

          <p className="text-muted mt-1 text-[0.8125rem]">
            {organization.legalName}
            {' · '}
            {organization.orgType.toLowerCase().replace(/_/g, ' ')}
            {' · joined '}
            {/*
              ⚠️ UTC, LIKE EVERY OTHER DATE IN THE PLATFORM CONSOLE. The locale
                was already pinned; the ZONE was not, so this rendered in the
                container's zone on the server and the operator's in the browser
                — a hydration mismatch, and a clinic that signed up at 23:40 IST
                on the 9th read as having joined on the 8th. `formatDate` is the
                rule (see lib/format.ts): a console read by staff in several
                countries needs one answer, not each reader's own.
            */}
            <time dateTime={organization.createdAt}>{formatDate(organization.createdAt)}</time>
          </p>
        </div>

        <Button
          variant={open ? 'secondary' : 'ghost'}
          size="sm"
          aria-expanded={open}
          aria-controls={`enter-${organization.id}`}
          onClick={onToggle}
        >
          {open ? 'Cancel' : 'Enter this clinic'}
        </Button>
      </div>

      {open ? (
        <div
          id={`enter-${organization.id}`}
          ref={region}
          className="border-rule bg-paper border-t p-5"
        >
          {state.status === 'ready' && state.grant ? (
            <EnterClinic grant={state.grant} />
          ) : (
            <form action={formAction} className="grid max-w-xl gap-4">
              <p className="text-ink text-[0.8125rem] leading-relaxed">
                You will be signed in to {organization.displayName} as rcln staff, with full read
                and write access. Every change you make is recorded in this clinic&rsquo;s audit
                trail under your name, alongside the reason below.
              </p>

              <Input
                id={`reason-${organization.id}`}
                name="reason"
                label="Why are you going in?"
                hint="The clinic can read this. Name the ticket or the problem."
                errors={state.fieldErrors?.['reason']}
                type="text"
                required
                minLength={10}
                maxLength={500}
                autoComplete="off"
                placeholder="Investigating the empty revenue report they reported on 24 July"
              />

              {state.status === 'error' ? <Alert tone="error">{state.message}</Alert> : null}

              <div>
                <Button type="submit" disabled={pending}>
                  {pending ? 'Opening…' : 'Enter this clinic'}
                </Button>
              </div>
            </form>
          )}
        </div>
      ) : null}
    </li>
  );
}
