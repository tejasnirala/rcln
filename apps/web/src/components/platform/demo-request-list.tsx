'use client';

import { useActionState, useEffect, useRef, useState } from 'react';
import { provisionClinic, type ProvisionState } from '@/app/(platform)/platform/actions';
import { cn } from '@/lib/cn';
import { Input, Select, type SelectOption } from '@/components/ui/field';

/**
 * The lead pipeline, and the one action that can be taken on it.
 *
 * These rows are contact details for real people who filled in a form. They are
 * not PHI, but they are not decoration either — the list shows what is needed to
 * decide and to call, and nothing is copied anywhere else.
 */

export interface DemoRequest {
  id: string;
  clinicName: string;
  contactName: string;
  email: string;
  phone: string;
  city: string | null;
  branchCount: number | null;
  specialty: string | null;
  message: string | null;
  status: string;
  createdAt: string;
}

const INITIAL: ProvisionState = { status: 'idle' };

/** The plans a clinic can be provisioned onto. Codes are the API's. */
const PLAN_CODES: SelectOption[] = [
  { value: 'STARTER', label: 'Starter' },
  { value: 'GROWTH', label: 'Growth' },
  { value: 'ENTERPRISE', label: 'Enterprise' },
];

const STATUS_LABEL: Record<string, string> = {
  NEW: 'New',
  CONTACTED: 'Contacted',
  CONVERTED: 'Converted',
  SPAM: 'Spam',
};

export function DemoRequestList({ requests }: { requests: DemoRequest[] }) {
  const [openId, setOpenId] = useState<string | null>(null);

  if (requests.length === 0) {
    return (
      <div className="border-rule bg-card rounded-lg border p-8 text-center">
        <p className="text-ink text-[0.9375rem]">No demo requests yet.</p>
        <p className="text-muted mt-2 text-[0.8125rem]">
          They arrive here from the form on the marketing site.
        </p>
      </div>
    );
  }

  return (
    <ul className="grid gap-3">
      {requests.map((request) => {
        const open = openId === request.id;
        const converted = request.status === 'CONVERTED';

        return (
          <li key={request.id} className="border-rule bg-card rounded-lg border">
            <div className="flex flex-wrap items-start gap-x-6 gap-y-2 p-5">
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                  <h3 className="text-ink text-[0.9375rem] font-medium">{request.clinicName}</h3>
                  <span
                    className={cn(
                      'rounded-sm px-1.5 py-0.5 font-mono text-[0.6875rem]',
                      converted ? 'bg-drape-tint text-drape-deep' : 'bg-paper text-muted'
                    )}
                  >
                    {STATUS_LABEL[request.status] ?? request.status}
                  </span>
                </div>

                <p className="text-muted mt-1 text-[0.8125rem]">
                  {request.contactName}
                  {request.city ? ` · ${request.city}` : ''}
                  {request.branchCount ? ` · ${request.branchCount} branches` : ''}
                  {request.specialty ? ` · ${request.specialty}` : ''}
                </p>

                <p className="text-muted mt-1 font-mono text-[0.75rem]">
                  {request.email} · {request.phone}
                </p>

                {request.message ? (
                  <p className="text-muted border-rule mt-3 border-l-2 pl-3 text-[0.8125rem] leading-relaxed">
                    {request.message}
                  </p>
                ) : null}
              </div>

              <button
                type="button"
                onClick={() => setOpenId(open ? null : request.id)}
                aria-expanded={open}
                className={cn(
                  'shrink-0 rounded-md px-4 py-2.5 text-[0.875rem] font-medium transition-colors',
                  converted
                    ? 'border-rule text-muted border'
                    : 'bg-drape text-paper hover:bg-drape-deep'
                )}
              >
                {open ? 'Cancel' : converted ? 'Provision again' : 'Provision clinic'}
              </button>
            </div>

            {open ? (
              <div className="border-rule border-t p-5">
                <ProvisionForm request={request} onDone={() => setOpenId(null)} />
              </div>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}

/** `Sunrise Clinic` -> `sunrise-clinic`, as a starting suggestion only. */
function suggestSlug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-')
    .slice(0, 63);
}

function ProvisionForm({ request, onDone }: { request: DemoRequest; onDone: () => void }) {
  const [state, action, pending] = useActionState(provisionClinic, INITIAL);
  const doneRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (state.status === 'provisioned') doneRef.current?.focus();
  }, [state.status]);

  if (state.status === 'provisioned') {
    return (
      <div
        ref={doneRef}
        tabIndex={-1}
        role="status"
        aria-live="polite"
        className="border-drape bg-drape-tint/40 rounded-md border p-4"
      >
        <p className="text-drape-deep text-[0.875rem]">
          Provisioned. The clinic lives at{' '}
          <span className="font-mono">
            {state.slug}.{process.env['NEXT_PUBLIC_ROOT_DOMAIN'] ?? 'lvh.me'}
          </span>
          .
        </p>
        <p className="text-muted mt-2 text-[0.8125rem]">
          Send the owner their address and the password you set. They can change it once inside.
        </p>
        <button
          type="button"
          onClick={onDone}
          className="text-drape hover:text-drape-deep mt-3 py-1 text-[0.8125rem] underline underline-offset-2"
        >
          Close
        </button>
      </div>
    );
  }

  const err = (key: string): string[] | undefined => state.fieldErrors?.[key];

  return (
    <form action={action} noValidate>
      <input type="hidden" name="demoRequestId" value={request.id} />

      <div className="grid gap-4 sm:grid-cols-2">
        <Input
          id={`displayName-${request.id}`}
          name="displayName"
          label="Clinic name"
          errors={err('organization.displayName')}
          defaultValue={request.clinicName}
        />

        <Input
          id={`legalName-${request.id}`}
          name="legalName"
          label="Registered name"
          errors={err('organization.legalName')}
          defaultValue={request.clinicName}
        />

        <Input
          id={`slug-${request.id}`}
          name="slug"
          label="Subdomain"
          hint="Confirm with the clinic before provisioning — it does not change later."
          errors={err('organization.slug')}
          defaultValue={suggestSlug(request.clinicName)}
          className="font-mono"
        />

        <Input
          id={`branchName-${request.id}`}
          name="branchName"
          label="First location"
          errors={err('branch.name')}
          defaultValue={request.clinicName}
        />

        <Input
          id={`fullName-${request.id}`}
          name="fullName"
          label="Owner name"
          errors={err('owner.fullName')}
          defaultValue={request.contactName}
        />

        <Input
          id={`email-${request.id}`}
          name="email"
          label="Owner email"
          errors={err('owner.email')}
          type="email"
          defaultValue={request.email}
        />

        <Input
          id={`phone-${request.id}`}
          name="phone"
          label="Owner mobile"
          errors={err('owner.phone')}
          type="tel"
          defaultValue={request.phone}
          className="font-mono"
        />

        <Input
          id={`password-${request.id}`}
          name="password"
          label="Temporary password"
          hint="At least 12 characters, an uppercase letter and a digit. Send it to them separately."
          errors={err('owner.password')}
          type="text"
          autoComplete="off"
          className="font-mono"
        />

        <Input
          id={`city-${request.id}`}
          name="city"
          label="City"
          errors={err('branch.city')}
          defaultValue={request.city ?? ''}
        />

        <Select id={`planCode-${request.id}`} name="planCode" label="Plan" options={PLAN_CODES} />
      </div>

      {state.status === 'error' && state.message ? (
        <p
          role="alert"
          tabIndex={-1}
          className="ring-signal/25 bg-signal-tint text-signal mt-5 rounded-md px-4 py-3 text-[0.8125rem] ring-1"
        >
          {state.message}
        </p>
      ) : null}

      <button
        type="submit"
        disabled={pending}
        className="bg-drape text-paper hover:bg-drape-deep mt-5 inline-flex items-center justify-center rounded-md px-5 py-3 text-[0.9375rem] font-medium transition-colors disabled:opacity-60"
      >
        {pending ? 'Provisioning…' : 'Provision clinic'}
      </button>
    </form>
  );
}
