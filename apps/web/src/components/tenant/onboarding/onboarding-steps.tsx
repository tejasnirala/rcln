'use client';

import { useState } from 'react';
import Link from 'next/link';
import {
  CLINIC_MODULES,
  COUNTRIES,
  regionsFor,
  taxIdFormatFor,
  type OnboardingState,
  type OnboardingStep,
} from '@rcln/contracts';
import { Field, Input, Select } from '@/components/ui/field';
import { Alert } from '@/components/ui/alert';
import { TIMEZONES, withCurrent } from '@/lib/locale-options';
import { cn } from '@/lib/cn';

/**
 * The seven step forms.
 *
 * Every one of them is an uncontrolled form over the wizard's single `<form>` —
 * the wizard owns submission, the pending flag and the outcome, and these own
 * only their fields. That is why none of them has an action or a submit button:
 * a step that could submit itself would be a second way to save.
 *
 * ⚠️ THE DESIGN DIRECTION IS INHERITED. Controls come from `components/ui/field`
 *   and nothing else, colours from the `--rcln-*` tokens through `bg-card`,
 *   `text-ink`, `border-rule`. See the wizard's header.
 */

export interface StepProps {
  state: OnboardingState;
  pending: boolean;
  errorsFor: (field: string) => string[] | undefined;
  onBack: (step: OnboardingStep) => void;
}

/** A checkable row — used by the care-context and module steps. */
function CheckRow({
  name,
  value,
  label,
  blurb,
  defaultChecked,
  disabled,
  note,
}: {
  name: string;
  value: string;
  label: string;
  blurb?: string;
  defaultChecked?: boolean;
  disabled?: boolean;
  note?: string;
}) {
  return (
    <label
      className={cn(
        'border-rule flex cursor-pointer items-start gap-3 rounded-md border p-4 transition-colors',
        disabled ? 'cursor-not-allowed opacity-60' : 'hover:bg-drape-tint/30'
      )}
    >
      <input
        type="checkbox"
        name={name}
        value={value}
        defaultChecked={defaultChecked}
        disabled={disabled}
        className="accent-drape mt-0.5 size-4 shrink-0"
      />
      <span className="min-w-0">
        <span className="text-ink block text-[0.9375rem]">{label}</span>
        {blurb ? <span className="text-muted block text-[0.8125rem]">{blurb}</span> : null}
        {note ? <span className="text-signal block text-[0.8125rem]">{note}</span> : null}
      </span>
    </label>
  );
}

// -- 1. who you are ----------------------------------------------------------

export function IdentityStep({ state, errorsFor }: StepProps) {
  const [country, setCountry] = useState(state.identity.countryCode);
  const regions = regionsFor(country);

  return (
    <div className="space-y-5">
      <Input
        name="displayName"
        label="What patients call you"
        hint="The name over the door. It appears on the app and on your bills."
        defaultValue={state.identity.displayName}
        errors={errorsFor('displayName')}
        required
      />
      <Input
        name="legalName"
        label="Registered name"
        hint="How the business is constituted. Often the same; often not."
        defaultValue={state.identity.legalName}
        errors={errorsFor('legalName')}
        required
      />

      <div className="grid gap-5 sm:grid-cols-2">
        <Select
          name="orgType"
          label="What the business is"
          defaultValue={state.identity.orgType}
          errors={errorsFor('orgType')}
          options={[
            { value: 'CLINIC', label: 'A clinic' },
            { value: 'HOSPITAL', label: 'A hospital' },
            { value: 'CHAIN', label: 'A group with several sites' },
            { value: 'LAB', label: 'A laboratory' },
          ]}
        />
        <Select
          name="facilityKind"
          label="What this site is"
          hint="Your other sites are set up individually."
          defaultValue={state.identity.facilityKind}
          errors={errorsFor('facilityKind')}
          options={[
            { value: 'CLINIC', label: 'A clinic' },
            { value: 'HOSPITAL', label: 'A hospital' },
            { value: 'LAB', label: 'A laboratory' },
            { value: 'PHARMACY', label: 'A pharmacy counter' },
          ]}
        />
      </div>

      <div className="grid gap-5 sm:grid-cols-2">
        <Select
          name="countryCode"
          label="Country"
          value={country}
          onChange={(event) => {
            setCountry(event.target.value);
          }}
          errors={errorsFor('countryCode')}
          options={COUNTRIES.map((c) => ({ value: c.code, label: c.name }))}
        />
        {/*
         * ⚠️ THE STATE IS NOT COSMETIC IN INDIA. A supply from a Karnataka
         *   registration to a Karnataka patient is CGST+SGST and to a Kerala one
         *   it is IGST — same rate, different taxes, different returns. Blank is
         *   permitted and forces the inter-state treatment, which is the safe
         *   direction, so the hint says so rather than making it required.
         */}
        {regions.length > 0 ? (
          <Select
            name="regionCode"
            label="State"
            hint="Leave blank if you are not sure. It decides how tax is split."
            defaultValue={state.identity.regionCode ?? ''}
            errors={errorsFor('regionCode')}
            placeholder="Not set"
            options={regions.map((r) => ({ value: r.code, label: r.name }))}
          />
        ) : null}
      </div>
    </div>
  );
}

// -- 2. who you treat --------------------------------------------------------

export function CareContextStep({ state, errorsFor }: StepProps) {
  const chosen = new Set(state.profile.careContextIds);
  const [count, setCount] = useState(chosen.size || 1);

  return (
    <div className="space-y-5">
      <div
        className="space-y-3"
        onChange={(event) => {
          // Counting from the DOM rather than mirroring seven checkboxes into
          // state: the note below is the only thing that depends on it.
          const form = (event.target as HTMLElement).closest('form');
          setCount(form?.querySelectorAll('input[name="careContextIds"]:checked').length ?? 0);
        }}
      >
        {state.careContextOptions.map((option) => (
          <CheckRow
            key={option.id}
            name="careContextIds"
            value={option.id}
            label={option.name}
            {...(option.description ? { blurb: option.description } : {})}
            defaultChecked={chosen.has(option.id)}
          />
        ))}
      </div>

      {errorsFor('careContextIds')?.length ? (
        <Alert tone="error">{errorsFor('careContextIds')?.join(' ')}</Alert>
      ) : null}

      {/*
       * ⚠️ THE CONSEQUENCE, SAID OUT LOUD, AND THIS IS THE POINT OF THE WHOLE
       *   FEATURE. A clinic ticking one box is telling us its front desk should
       *   never be asked "person or animal?" again — and a setting screen that
       *   silently acquired a default nobody chose is exactly what people
       *   distrust. Saying it here is cheaper than explaining it later.
       */}
      <Alert tone="info">
        {count === 1
          ? 'Because you treat one kind of patient, new records will be created as that automatically — nobody will be asked.'
          : count === 0
            ? 'Pick at least one.'
            : 'Because you treat more than one kind of patient, your staff will be asked which when they register somebody.'}
      </Alert>
    </div>
  );
}

// -- 3. what you run ---------------------------------------------------------

export function ModuleStep({ state, errorsFor }: StepProps) {
  const chosen = new Set(state.profile.modules);
  const entitled = new Set(state.entitledModules);

  return (
    <div className="space-y-5">
      <div className="space-y-3">
        {CLINIC_MODULES.map((module) => {
          const available = entitled.has(module.key);
          return (
            <CheckRow
              key={module.key}
              name="modules"
              value={module.key}
              label={module.label}
              blurb={module.blurb}
              defaultChecked={chosen.has(module.key)}
              disabled={!available}
              {...(available ? {} : { note: 'Not on your plan' })}
            />
          );
        })}
      </div>

      {errorsFor('modules')?.length ? (
        <Alert tone="error">{errorsFor('modules')?.join(' ')}</Alert>
      ) : null}

      {/*
       * ⚠️ SAYS WHAT THIS DOES *NOT* DO. Somebody setting up a clinic will
       *   reasonably read a list of tick boxes as an access control. It is not
       *   one, and a person who believes it is will use it as one.
       */}
      <p className="text-muted max-w-prose text-[0.8125rem]">
        This decides what appears in your menu. It does not decide who is allowed to do what — that
        is Roles, and you can set it up once your team is in.
      </p>
    </div>
  );
}

// -- 4. when you're open -----------------------------------------------------

const DAYS = [
  { day: 1, name: 'Monday' },
  { day: 2, name: 'Tuesday' },
  { day: 3, name: 'Wednesday' },
  { day: 4, name: 'Thursday' },
  { day: 5, name: 'Friday' },
  { day: 6, name: 'Saturday' },
  { day: 0, name: 'Sunday' },
] as const;

export function LocaleStep({ state, errorsFor }: StepProps) {
  const [branchId, setBranchId] = useState(state.branches[0]?.id ?? '');
  const branch = state.branches.find((b) => b.id === branchId) ?? state.branches[0];

  if (!branch) {
    return <Alert tone="warning">This clinic has no active branch to set hours for.</Alert>;
  }

  const hoursFor = (day: number) => branch.operatingHours.find((h) => h.dayOfWeek === day);

  return (
    <div className="space-y-6">
      {state.branches.length > 1 ? (
        <Select
          name="branchSelector"
          label="Which site"
          hint="Each site keeps its own hours and time zone. Come back for the others."
          value={branchId}
          onChange={(event) => {
            setBranchId(event.target.value);
          }}
          options={state.branches.map((b) => ({
            value: b.id,
            label: b.isPrimary ? `${b.name} (main)` : b.name,
          }))}
        />
      ) : null}
      <input type="hidden" name="branchId" value={branch.id} />

      <div className="grid gap-5 sm:grid-cols-3">
        <Select
          name="timezone"
          label="Time zone"
          hint="Every time in the app is shown in this."
          defaultValue={branch.timezone}
          errors={errorsFor('timezone')}
          options={withCurrent(TIMEZONES, branch.timezone)}
          key={`tz-${branch.id}`}
        />
        <Select
          name="timeFormat"
          label="Clock"
          defaultValue={branch.timeFormat}
          errors={errorsFor('timeFormat')}
          options={[
            { value: '12H', label: '4:40 pm' },
            { value: '24H', label: '16:40' },
          ]}
          key={`tf-${branch.id}`}
        />
        <Input
          name="slotMinutes"
          type="number"
          min={5}
          max={240}
          label="Appointment length"
          hint="In minutes."
          defaultValue={branch.slotMinutes}
          errors={errorsFor('slotMinutes')}
          key={`sm-${branch.id}`}
        />
      </div>

      <Field name="operatingHours" label="Opening hours" errors={errorsFor('operatingHours')}>
        <div className="border-rule divide-rule divide-y rounded-md border">
          {DAYS.map(({ day, name }) => {
            const hours = hoursFor(day);
            return (
              <div key={`${branch.id}-${String(day)}`} className="flex items-center gap-3 p-3">
                <span className="text-ink w-24 shrink-0 text-[0.9375rem]">{name}</span>
                <input
                  type="time"
                  name={`open-${String(day)}`}
                  defaultValue={hours?.opensAt ?? '09:00'}
                  aria-label={`${name} opens at`}
                  className="border-rule bg-card text-ink rounded border px-2 py-1 text-[0.875rem]"
                />
                <span className="text-muted text-[0.8125rem]">to</span>
                <input
                  type="time"
                  name={`close-${String(day)}`}
                  defaultValue={hours?.closesAt ?? '18:00'}
                  aria-label={`${name} closes at`}
                  className="border-rule bg-card text-ink rounded border px-2 py-1 text-[0.875rem]"
                />
                <label className="text-muted ml-auto flex items-center gap-2 text-[0.8125rem]">
                  <input
                    type="checkbox"
                    name={`closed-${String(day)}`}
                    defaultChecked={hours?.isClosed ?? day === 0}
                    className="accent-drape size-4"
                  />
                  Closed
                </label>
              </div>
            );
          })}
        </div>
      </Field>
    </div>
  );
}

// -- 5. how you bill ---------------------------------------------------------

export function TaxStep({ state, errorsFor }: StepProps) {
  const country = state.identity.countryCode;
  const format = taxIdFormatFor(country);

  return (
    <div className="space-y-6">
      <div className="grid gap-5 sm:grid-cols-2">
        <Input
          name="invoicePrefix"
          label="Invoice numbers start with"
          hint="INV becomes INV-000123."
          defaultValue={state.billing.invoicePrefix}
          errors={errorsFor('invoicePrefix')}
        />
        <Select
          name="financialYearStartMonth"
          label="Your financial year starts in"
          defaultValue={String(state.billing.financialYearStartMonth)}
          errors={errorsFor('financialYearStartMonth')}
          options={[
            'January',
            'February',
            'March',
            'April',
            'May',
            'June',
            'July',
            'August',
            'September',
            'October',
            'November',
            'December',
          ].map((label, index) => ({ value: String(index + 1), label }))}
        />
        <Input
          name="defaultTaxPercent"
          type="number"
          min={0}
          max={100}
          step="0.01"
          label="Default tax rate"
          hint="Used only where an item has none of its own. Most clinical services are exempt."
          defaultValue={String(state.billing.defaultTaxPercent)}
          errors={errorsFor('defaultTaxPercent')}
        />
        <Select
          name="cashRoundingMinor"
          label="Round cash totals"
          hint="Moves the total only. Tax is worked out first and never rounded away."
          defaultValue={String(state.billing.cashRoundingMinor)}
          errors={errorsFor('cashRoundingMinor')}
          options={[
            { value: '1', label: 'No rounding' },
            { value: '100', label: 'To the whole unit' },
          ]}
        />
      </div>

      <div className="border-rule border-t pt-6">
        <h2 className="text-ink text-[1.0625rem] font-medium">
          The number you print on patient bills
        </h2>
        {/*
         * ⚠️ THE ONE PIECE OF COPY ON THIS SCREEN THAT HAS TO BE EXACT. A clinic
         *   holds two tax numbers in the general case: this one, which it issues
         *   invoices UNDER, and the one rcln bills the clinic under. They are
         *   often the same and are not the same field, and a screen that does not
         *   say so collects one number twice and is wrong once — discovered when
         *   a patient's invoice is refused as defective.
         */}
        <p className="text-muted mt-1 max-w-prose text-[0.8125rem]">
          This is the registration you issue invoices under, not the one we bill you under. Skip it
          if you have applied and not received it — you can finish setup without it.
        </p>

        {state.billing.hasTaxRegistration ? (
          <Alert tone="success" className="mt-4">
            You already have a registration on file. Add another only if you hold more than one.
          </Alert>
        ) : null}

        <div className="mt-5 grid gap-5 sm:grid-cols-2">
          <Input
            name="registrationNumber"
            label={format?.label ?? 'Tax registration number'}
            {...(format?.example ? { hint: `Like ${format.example}.` } : {})}
            errors={errorsFor('taxRegistration.registrationNumber')}
          />
          <Input
            name="effectiveFrom"
            type="date"
            label="In force since"
            hint="Bills dated before this are not taxed under it."
            errors={errorsFor('taxRegistration.effectiveFrom')}
          />
          <Input
            name="registrationLegalName"
            label="The name it is held in"
            hint="Leave blank if it is your registered name above."
            errors={errorsFor('taxRegistration.legalName')}
            fieldClassName="sm:col-span-2"
          />
        </div>

        {/* Carried so the registration is created against the same jurisdiction
            step 1 established, rather than asking for it twice. */}
        <input type="hidden" name="countryCode" value={country} />
        <input type="hidden" name="regionCode" value={state.identity.regionCode ?? ''} />
        <input type="hidden" name="scheme" value={country === 'IN' ? 'GST' : 'VAT'} />
      </div>
    </div>
  );
}

// -- 6. who works here -------------------------------------------------------

export function StaffStep({ state, errorsFor }: StepProps) {
  const [rows, setRows] = useState(1);
  const roles = state.invitableRoles;

  return (
    <div className="space-y-5">
      {state.pendingInvitationCount > 0 ? (
        <Alert tone="info">
          {state.pendingInvitationCount} invitation
          {state.pendingInvitationCount === 1 ? ' is' : 's are'} already waiting to be accepted.
          Only add people who are not on that list.
        </Alert>
      ) : null}

      <div className="space-y-3">
        {Array.from({ length: rows }, (_, index) => (
          <div key={index} className="grid gap-3 sm:grid-cols-[1fr_14rem]">
            <Input
              name="email"
              type="email"
              label={index === 0 ? 'Their work email' : undefined}
              placeholder="name@clinic.example"
              errors={index === 0 ? errorsFor('invitations.0.email') : undefined}
            />
            <Select
              name="roleId"
              label={index === 0 ? 'What they do' : undefined}
              options={roles.map((role) => ({ value: role.id, label: role.name }))}
              errors={index === 0 ? errorsFor('invitations.0.roleId') : undefined}
            />
          </div>
        ))}
      </div>

      {/* Every invitation is scoped to the main site; a group moves people
          between branches from Staff, which is the screen built for it. */}
      <input type="hidden" name="branchIds" value={state.branches[0]?.id ?? ''} />

      <button
        type="button"
        onClick={() => {
          setRows((n) => n + 1);
        }}
        className="text-drape hover:bg-drape-tint/50 rounded px-2 py-1 text-[0.9375rem]"
      >
        Add another
      </button>

      <p className="text-muted max-w-prose text-[0.8125rem]">
        Leave this blank if it is just you for now. You can invite people any time from Staff.
      </p>
    </div>
  );
}

// -- 7. check and finish -----------------------------------------------------

export function ReviewStep({ state, onBack, slug }: StepProps & { slug: string }) {
  const contexts = state.careContextOptions.filter((option) =>
    state.profile.careContextIds.includes(option.id)
  );

  const rows: { step: OnboardingStep; label: string; value: string; empty?: boolean }[] = [
    {
      step: 'IDENTITY',
      label: 'You are',
      value: state.identity.displayName || 'Not answered yet',
      empty: !state.identity.displayName,
    },
    {
      step: 'CARE_CONTEXTS',
      label: 'You treat',
      value: contexts.length > 0 ? contexts.map((c) => c.name).join(' and ') : 'Not answered yet',
      empty: contexts.length === 0,
    },
    {
      step: 'MODULES',
      label: 'You run',
      value:
        state.profile.modules.length > 0
          ? state.profile.modules
              .map((m) => CLINIC_MODULES.find((c) => c.key === m)?.label ?? m)
              .join(', ')
          : 'Not answered yet',
      empty: state.profile.modules.length === 0,
    },
    {
      step: 'LOCALE_HOURS',
      label: 'You open',
      value: state.branches[0]
        ? `${state.branches[0].timezone}, ${state.branches[0].operatingHours.filter((h) => !h.isClosed).length} days a week`
        : 'Not answered yet',
      empty: !state.branches[0],
    },
    {
      step: 'TAX_BILLING',
      label: 'You bill',
      value: state.billing.hasTaxRegistration
        ? `Invoices as ${state.billing.invoicePrefix}-000001, tax registration on file`
        : `Invoices as ${state.billing.invoicePrefix}-000001, no tax registration yet`,
    },
    {
      step: 'STAFF',
      label: 'Your team',
      value:
        state.pendingInvitationCount > 0
          ? `${String(state.pendingInvitationCount)} invitation(s) outstanding`
          : 'Just you, for now',
    },
  ];

  return (
    <div className="space-y-6">
      <dl className="border-rule divide-rule divide-y rounded-md border">
        {rows.map((row) => (
          <div key={row.step} className="flex items-baseline gap-4 p-4">
            <dt className="text-muted w-28 shrink-0 text-[0.8125rem]">{row.label}</dt>
            <dd
              className={cn(
                'min-w-0 flex-1 text-[0.9375rem]',
                row.empty ? 'text-muted' : 'text-ink'
              )}
            >
              {row.value}
            </dd>
            <button
              type="button"
              onClick={() => {
                onBack(row.step);
              }}
              className="text-drape hover:bg-drape-tint/50 shrink-0 rounded px-2 py-1 text-[0.8125rem]"
            >
              Change
            </button>
          </div>
        ))}
      </dl>

      {/*
       * ⚠️ FINISHING IS NOT GATED ON ANSWERING EVERYTHING, AND THE SCREEN SAYS
       *   SO. A clinic with no tax registration and nobody to invite has
       *   genuinely finished. Refusing to let them out until they invent an
       *   answer is how a setup flow becomes something people work around.
       */}
      <p className="text-muted max-w-prose text-[0.8125rem]">
        Anything you skipped can be filled in later — all of this lives in{' '}
        <Link href="/settings" className="text-drape underline underline-offset-2">
          Clinic settings
        </Link>
        . Finishing just stops us asking. (Clinic: {slug}.)
      </p>
    </div>
  );
}
