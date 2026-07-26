'use client';

import { useActionState, useEffect, useRef, useState } from 'react';
import type { ImpersonationGrant, PlatformOrganizationSummary } from '@rcln/contracts';
import {
  startImpersonation,
  type ImpersonateState,
} from '@/app/(platform)/platform/organizations/actions';
import { cn } from '@/lib/cn';
import { Alert, useOutcomeFocus } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { describedBy, Field, inputClass } from '@/components/ui/field';

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
            <time dateTime={organization.createdAt}>
              {new Date(organization.createdAt).toLocaleDateString('en-IN', {
                day: 'numeric',
                month: 'short',
                year: 'numeric',
              })}
            </time>
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
                and write access for thirty minutes. Every change you make is recorded in this
                clinic&rsquo;s audit trail under your name, alongside the reason below.
              </p>

              <Field
                name={`reason-${organization.id}`}
                label="Why are you going in?"
                hint="The clinic can read this. Name the ticket or the problem."
                errors={state.fieldErrors?.['reason']}
              >
                <input
                  id={`reason-${organization.id}`}
                  name="reason"
                  type="text"
                  required
                  minLength={10}
                  maxLength={500}
                  autoComplete="off"
                  placeholder="Investigating the empty revenue report they reported on 24 July"
                  aria-invalid={state.fieldErrors?.['reason'] ? true : undefined}
                  aria-describedby={describedBy(
                    `reason-${organization.id}`,
                    true,
                    Boolean(state.fieldErrors?.['reason'])
                  )}
                  className={inputClass}
                />
              </Field>

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

/**
 * The handoff, and the only part of this feature that is genuinely unusual.
 *
 * The ticket has to reach the CLINIC's host, because that is the only host that
 * can be given a session cookie for the clinic — cookies here are host-only by
 * design (lib/session.ts). So the browser posts it there itself.
 *
 * A real form POST, not `fetch`: the response is a redirect that must land in
 * the address bar, and the Set-Cookie on it must stick to that host. It is a
 * Route Handler on the other end rather than a Server Action, because Next
 * blocks cross-origin Server Action requests and is right to.
 *
 * The target host is derived from the one in the address bar rather than
 * rebuilt from an environment variable, so the dev port comes along for free and
 * the two can never disagree about which domain this deployment is on.
 */
function EnterClinic({ grant }: { grant: ImpersonationGrant }) {
  const form = useRef<HTMLFormElement>(null);

  useEffect(() => {
    const element = form.current;
    if (!element) return;

    /*
     * The DOM is the external system here, which is what an effect is for — and
     * why the target is written onto the form rather than held in state. Reading
     * `window.location` during a render would be impure, and a `setState` in an
     * effect body is a cascading render (react-hooks/set-state-in-effect).
     *
     * `admin.lvh.me:3000` -> `northwind.lvh.me:3000`.
     */
    const host = window.location.host.replace(/^[^.]+\./, `${grant.organizationSlug}.`);
    element.action = `${window.location.protocol}//${host}/impersonate`;
    element.submit();
  }, [grant.organizationSlug]);

  return (
    <form ref={form} method="POST" className="grid gap-3">
      <input type="hidden" name="handoffToken" value={grant.handoffToken} />
      <p role="status" aria-live="polite" className="text-ink text-[0.8125rem]">
        Opening {grant.organizationName}…
      </p>
      {/* Visible and usable if the automatic submit is blocked or JavaScript is
          slow. Not a fallback nobody can reach: it is the same submit. */}
      <div>
        <Button type="submit" size="sm" variant="secondary">
          Continue to {grant.organizationSlug}
        </Button>
      </div>
    </form>
  );
}
