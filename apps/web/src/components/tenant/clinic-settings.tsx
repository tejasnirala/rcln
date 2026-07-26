'use client';

import { useActionState, useMemo, useRef } from 'react';
import type { OrganizationProfile, SettingItem } from '@rcln/contracts';
import { Field, inputClass } from '@/components/ui/field';
import { Button } from '@/components/ui/button';
import { Alert, useOutcomeFocus } from '@/components/ui/alert';
import { moduleLabel } from '@/lib/permission-labels';
import { CURRENCIES, TIMEZONES, withCurrent } from '@/lib/locale-options';
import {
  resetSetting,
  saveOrganization,
  saveSetting,
  type SettingsFormState,
} from '@/app/(tenant)/t/[slug]/(app)/settings/actions';

const IDLE: SettingsFormState = { status: 'idle' };

/** The string form a value goes back into a form field as. */
function toInput(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'boolean') return String(value);
  if (typeof value === 'number') return String(value);
  return JSON.stringify(value);
}

/**
 * How a value is written down for a human.
 *
 * A setting with a closed set is shown by its LABEL, everywhere — the row, the
 * provenance line, all of it. Nobody administering a clinic reads `4` as April
 * or `FEFO` as "the batch expiring soonest", and a screen that shows the stored
 * form is making the reader do the translation the catalogue already did.
 *
 * Booleans read as words for the same reason. Everything else is JSON, which is
 * what it is.
 */
function display(value: unknown, setting?: SettingItem): string {
  const choice = setting?.choices?.find((c) => JSON.stringify(c.value) === JSON.stringify(value));
  if (choice) return choice.label;
  if (typeof value === 'boolean') return value ? 'On' : 'Off';
  if (typeof value === 'string') return value;
  return JSON.stringify(value);
}

/**
 * The inheritance line — the signature of this screen.
 *
 * Sibling of the branches week strip, the roles module strip and the staff
 * access ladder: the thing that is normally hidden behind an edit button is on
 * the row instead. What is specific here is WHICH thing. A settings value on its
 * own is not confusing; where it came from is. Three states look identical in
 * every settings screen ever built — this clinic decided it, rcln decided it,
 * nobody decided it — and they have completely different consequences when
 * something behaves unexpectedly.
 *
 * So every row states its provenance, and says what clearing would restore
 * before you clear it. The branch note is the other half: a setting branches may
 * also set is a DEFAULT, not a rule, and a clinic with three branches needs to
 * know which of the two it is looking at.
 */
function Provenance({ setting }: { setting: SettingItem }) {
  const branchable = setting.allowedScopes.includes('BRANCH');

  return (
    <p className="text-muted mt-1.5 text-[0.8125rem] leading-relaxed">
      {setting.isOverridden ? (
        <>
          <span className="text-ink">Set for this clinic.</span> Clearing it restores{' '}
          <span className="text-ink">{display(setting.inheritedValue, setting)}</span>
          {setting.inheritedFrom === 'PLATFORM' ? ', which rcln sets' : ', the rcln default'}.
        </>
      ) : (
        <>
          {setting.inheritedFrom === 'PLATFORM'
            ? 'Set by rcln for every clinic.'
            : 'The rcln default. Nobody here has changed it.'}
        </>
      )}
      {branchable ? ' Each branch can still set its own.' : null}
    </p>
  );
}

/**
 * One setting, editable in place.
 *
 * No modal and no expand-in-place here, unlike the other four screens: a setting
 * IS its value, so hiding the input behind a disclosure would put a click in
 * front of the only thing on the row. Twelve small inputs is what a settings
 * screen looks like.
 */
function SettingRow({
  slug,
  setting,
  canEdit,
}: {
  slug: string;
  setting: SettingItem;
  canEdit: boolean;
}) {
  const [state, action, pending] = useActionState(
    saveSetting.bind(null, slug, setting.key, setting.dataType),
    IDLE
  );
  const formRef = useRef<HTMLFormElement>(null);
  useOutcomeFocus(state.status, formRef);

  const inputId = `setting-${setting.key}`;
  const editable = canEdit && setting.editable;
  /*
   * Twelve fields all labelled "Value" are twelve identical rows to anyone
   * navigating by form control. The visible label stays short because the
   * heading beside it already names the setting; the accessible name carries
   * both. It still CONTAINS the visible text, which WCAG 2.5.3 requires.
   */
  const inputLabel = `${setting.description ?? setting.key} — value`;

  return (
    <li className="border-rule bg-card rounded-lg border p-5">
      <div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-3">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-ink text-[0.9375rem] font-medium">
              {setting.description ?? setting.key}
            </h3>
            {setting.isOverridden ? (
              <span className="bg-drape-tint text-drape-deep rounded-xs px-2 py-0.5 text-[0.6875rem] font-medium">
                Yours
              </span>
            ) : null}
          </div>
          {/* A setting key is an identifier, so it is set in mono like one. */}
          <code className="text-muted text-[0.75rem]">{setting.key}</code>

          {/* What it is for, before what it currently is. Comes from the
              catalogue, so the API and the screen explain it the same way. */}
          {setting.helpText ? (
            <p className="text-ink mt-2 max-w-prose text-[0.8125rem] leading-relaxed">
              {setting.helpText}
            </p>
          ) : null}

          <Provenance setting={setting} />
        </div>

        {/*
         * The reset form is a SIBLING of the save form, never a child.
         * A nested <form> is invalid HTML — the parser drops the inner one, so
         * "Use the default" would silently submit the save action instead. The
         * two are laid out together and are two separate submissions.
         */}
        <div className="flex shrink-0 flex-col gap-2">
          <form ref={formRef} action={action} noValidate className="flex flex-col gap-2">
            <Field
              name={inputId}
              label="Value"
              errors={state.fieldErrors?.['value']}
              {...(setting.dataType === 'JSON' ? { hint: 'JSON, e.g. [90, 30]' } : {})}
            >
              {/*
               * A closed set is a select, and the options come from the same
               * column the API validates against — so the screen cannot offer a
               * value that will be refused, and adding a choice is an INSERT
               * rather than a change here.
               *
               * The option's `value` is the JSON form, which is exactly what the
               * action parses back by `dataType`: "4" becomes the number 4 for an
               * INT, "SMS" stays a string. One encoding, both directions.
               */}
              {setting.choices ? (
                <select
                  id={inputId}
                  name="value"
                  aria-label={inputLabel}
                  className={`${inputClass} sm:w-56`}
                  defaultValue={toInput(setting.value)}
                  disabled={!editable}
                >
                  {setting.choices.map((choice) => (
                    <option key={toInput(choice.value)} value={toInput(choice.value)}>
                      {choice.label}
                    </option>
                  ))}
                </select>
              ) : setting.dataType === 'BOOL' ? (
                <select
                  id={inputId}
                  name="value"
                  aria-label={inputLabel}
                  className={`${inputClass} sm:w-44`}
                  defaultValue={toInput(setting.value)}
                  disabled={!editable}
                >
                  <option value="true">On</option>
                  <option value="false">Off</option>
                </select>
              ) : (
                <input
                  id={inputId}
                  name="value"
                  aria-label={inputLabel}
                  type={
                    setting.dataType === 'INT' || setting.dataType === 'DECIMAL' ? 'number' : 'text'
                  }
                  step={setting.dataType === 'DECIMAL' ? 'any' : undefined}
                  className={`${inputClass} sm:w-44 ${setting.dataType === 'JSON' ? 'font-mono' : ''}`}
                  defaultValue={toInput(setting.value)}
                  disabled={!editable}
                  autoComplete="off"
                />
              )}
            </Field>

            {editable ? (
              <Button size="sm" type="submit" disabled={pending}>
                {pending ? 'Saving…' : 'Save'}
              </Button>
            ) : (
              <p className="text-muted text-[0.8125rem]">
                {setting.editable ? 'You cannot change this.' : 'rcln manages this one.'}
                {/* Disabling alone must not carry the meaning (WCAG 1.4.1). */}
                <span className="sr-only"> This field is read-only.</span>
              </p>
            )}

            {state.status === 'error' ? <Alert tone="error">{state.message}</Alert> : null}
          </form>

          {editable && setting.isOverridden ? (
            <ResetButton slug={slug} settingKey={setting.key} />
          ) : null}
        </div>
      </div>
    </li>
  );
}

function ResetButton({ slug, settingKey }: { slug: string; settingKey: string }) {
  const [state, action, pending] = useActionState(resetSetting.bind(null, slug, settingKey), IDLE);

  return (
    <form action={action}>
      {/* Names the outcome, not the mechanism: what you get is the default back. */}
      <Button size="sm" variant="secondary" type="submit" disabled={pending}>
        {pending ? 'Clearing…' : 'Use the default'}
      </Button>
      {state.status === 'error' ? (
        <Alert tone="error" className="mt-2">
          {state.message}
        </Alert>
      ) : null}
    </form>
  );
}

function OrganizationForm({
  slug,
  organization,
  canEdit,
}: {
  slug: string;
  organization: OrganizationProfile;
  canEdit: boolean;
}) {
  const [state, action, pending] = useActionState(saveOrganization.bind(null, slug), IDLE);
  const formRef = useRef<HTMLFormElement>(null);
  useOutcomeFocus(state.status, formRef);

  const err = (name: string): string[] | undefined => state.fieldErrors?.[name];

  return (
    <form ref={formRef} action={action} noValidate>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field
          name="legalName"
          label="Registered name"
          hint="As it appears on invoices and filings"
          errors={err('legalName')}
        >
          <input
            id="legalName"
            name="legalName"
            className={inputClass}
            defaultValue={organization.legalName}
            disabled={!canEdit}
            required
            autoComplete="organization"
          />
        </Field>
        <Field
          name="displayName"
          label="Name patients see"
          hint="As it appears on portal"
          errors={err('displayName')}
        >
          <input
            id="displayName"
            name="displayName"
            className={inputClass}
            defaultValue={organization.displayName}
            disabled={!canEdit}
            required
            autoComplete="off"
          />
        </Field>
        <Field
          name="gstNumber"
          label="GSTIN"
          hint="Leave empty if this clinic is not registered"
          errors={err('gstNumber')}
        >
          <input
            id="gstNumber"
            name="gstNumber"
            className={`${inputClass} font-mono`}
            defaultValue={organization.gstNumber ?? ''}
            disabled={!canEdit}
            autoComplete="off"
          />
        </Field>
        {/*
         * Both are selects, and both include whatever the clinic is currently
         * set to even when that is off the list — a select cannot render a
         * value it has no option for, so without `withCurrent` a clinic on
         * Asia/Tokyo would be moved to Asia/Kolkata by a save it made to fix
         * its GSTIN. The lists are the convenient choices; the contract
         * validates against the platform's full set.
         */}
        <Field
          name="timezone"
          label="Time zone"
          hint="Appointment times and report dates are read in this zone"
          errors={err('timezone')}
        >
          <select
            id="timezone"
            name="timezone"
            className={inputClass}
            defaultValue={organization.timezone}
            disabled={!canEdit}
            required
          >
            {withCurrent(TIMEZONES, organization.timezone).map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </Field>
        <Field
          name="currency"
          label="Currency"
          hint="What invoices and price lists are denominated in"
          errors={err('currency')}
        >
          <select
            id="currency"
            name="currency"
            className={inputClass}
            defaultValue={organization.currency}
            disabled={!canEdit}
            required
          >
            {withCurrent(CURRENCIES, organization.currency).map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </Field>
      </div>

      {state.status !== 'idle' ? (
        <Alert tone={state.status === 'error' ? 'error' : 'info'} className="mt-5">
          {state.message}
        </Alert>
      ) : null}

      {canEdit ? (
        <div className="mt-5">
          <Button type="submit" disabled={pending}>
            {pending ? 'Saving…' : 'Save changes'}
          </Button>
        </div>
      ) : null}
    </form>
  );
}

/**
 * What this clinic is, and how it behaves.
 *
 * Two sections because they answer two different questions and are two different
 * permissions — someone who may fix a GSTIN has no business changing the session
 * timeout, and the API enforces that split, so the screen shows it.
 *
 * Settings are grouped by module, the same taxonomy the roles screen counts by:
 * every setting key is `module.name`, so the grouping carries information rather
 * than tidying the page.
 */
export function ClinicSettings({
  slug,
  organization,
  settings,
  canEditOrganization,
  canEditSettings,
}: {
  slug: string;
  organization: OrganizationProfile | null;
  settings: SettingItem[] | null;
  canEditOrganization: boolean;
  canEditSettings: boolean;
}) {
  const groups = useMemo(() => {
    const byModule = new Map<string, SettingItem[]>();
    for (const setting of settings ?? []) {
      const bucket = byModule.get(setting.module);
      if (bucket) bucket.push(setting);
      else byModule.set(setting.module, [setting]);
    }
    return [...byModule].sort((a, b) => a[0].localeCompare(b[0]));
  }, [settings]);

  return (
    <>
      <div>
        <p className="eyebrow text-drape">This clinic</p>
        <h1 className="font-display mt-2 text-3xl tracking-tight">
          {organization?.displayName ?? 'Clinic'}
        </h1>
        <p className="text-muted mt-2 max-w-xl text-[0.9375rem] leading-relaxed">
          {organization ? (
            <>
              Reachable at <span className="font-mono">{organization.slug}</span>. The address is
              fixed — moving it would sign everyone out and break every link.
            </>
          ) : (
            'Your clinic’s details are not visible to you.'
          )}
        </p>
      </div>

      {organization ? (
        <section
          className="border-rule bg-card mt-8 rounded-lg border p-5"
          aria-labelledby="details-heading"
        >
          <h2 id="details-heading" className="eyebrow text-muted">
            Details
          </h2>
          <div className="mt-4">
            <OrganizationForm
              slug={slug}
              organization={organization}
              canEdit={canEditOrganization}
            />
          </div>
        </section>
      ) : null}

      <section className="border-rule mt-10 border-t pt-8" aria-labelledby="defaults-heading">
        <h2 id="defaults-heading" className="eyebrow text-muted">
          Defaults
        </h2>
        <p className="text-muted mt-2 max-w-xl text-[0.9375rem] leading-relaxed">
          How this clinic behaves when nothing more specific applies. Every row says where its value
          came from, so a surprise is traceable to whoever set it.
        </p>

        {settings === null ? (
          <Alert tone="error" className="mt-4">
            You do not have access to this clinic&rsquo;s defaults.
          </Alert>
        ) : (
          groups.map(([module, items]) => (
            <div key={module} className="mt-6">
              <h3 className="eyebrow text-drape">{moduleLabel(module)}</h3>
              <ul className="mt-3 grid gap-4">
                {items.map((setting) => (
                  <SettingRow
                    key={setting.key}
                    slug={slug}
                    setting={setting}
                    canEdit={canEditSettings}
                  />
                ))}
              </ul>
            </div>
          ))
        )}
      </section>
    </>
  );
}
