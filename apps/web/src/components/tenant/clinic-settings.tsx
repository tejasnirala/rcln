'use client';

import { useActionState, useMemo, useRef, useState } from 'react';
import type { OrganizationProfile, RolePairings, SettingItem } from '@rcln/contracts';
import { Input, Select, type SelectOption } from '@/components/ui/field';
import { Button } from '@/components/ui/button';
import { RecordHistory } from '@/components/tenant/record-history';
import { RoleTitles } from '@/components/tenant/role-titles';
import { Alert, useOutcomeFocus } from '@/components/ui/alert';
import { cn } from '@/lib/cn';
import { moduleLabel } from '@/lib/permission-labels';
import { CURRENCIES, TIMEZONES, withCurrent } from '@/lib/locale-options';
import { COUNTRIES, countryInfo, defaultTimezoneFor, regionsFor } from '@rcln/contracts';
import {
  resetSetting,
  saveOrganization,
  saveSetting,
  type SettingsFormState,
} from '@/app/(tenant)/t/[slug]/(app)/settings/actions';

const IDLE: SettingsFormState = { status: 'idle' };

/** A BOOL setting, in the words the row already uses to display it. */
const BOOL_CHOICES: SelectOption[] = [
  { value: 'true', label: 'On' },
  { value: 'false', label: 'Off' },
];

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
            {/*
             * A closed set is a select, and the options come from the same
             * column the API validates against — so the screen cannot offer a
             * value that will be refused, and adding a choice is an INSERT
             * rather than a change here.
             *
             * The option's `value` is the JSON form, which is exactly what the
             * action parses back by `dataType`: "4" becomes the number 4 for an
             * INT, "SMS" stays a string. One encoding, both directions.
             *
             * All three shapes are one field with one id, so whichever renders
             * carries the same label, the same error and the same wiring.
             */}
            {setting.choices ? (
              <Select
                id={inputId}
                name="value"
                label="Value"
                aria-label={inputLabel}
                errors={state.fieldErrors?.['value']}
                className="sm:w-56"
                defaultValue={toInput(setting.value)}
                disabled={!editable}
                options={setting.choices.map((choice) => ({
                  value: toInput(choice.value),
                  label: choice.label,
                }))}
              />
            ) : setting.dataType === 'BOOL' ? (
              <Select
                id={inputId}
                name="value"
                label="Value"
                aria-label={inputLabel}
                errors={state.fieldErrors?.['value']}
                className="sm:w-44"
                defaultValue={toInput(setting.value)}
                disabled={!editable}
                options={BOOL_CHOICES}
              />
            ) : (
              <Input
                id={inputId}
                name="value"
                label="Value"
                aria-label={inputLabel}
                errors={state.fieldErrors?.['value']}
                {...(setting.dataType === 'JSON' ? { hint: 'JSON, e.g. [90, 30]' } : {})}
                type={
                  setting.dataType === 'INT' || setting.dataType === 'DECIMAL' ? 'number' : 'text'
                }
                {...(setting.dataType === 'DECIMAL' ? { step: 'any' } : {})}
                className={cn('sm:w-44', setting.dataType === 'JSON' && 'font-mono')}
                defaultValue={toInput(setting.value)}
                disabled={!editable}
                autoComplete="off"
              />
            )}

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
  /*
   * Controlled, because country drives the other three. They start from the
   * clinic's stored values, so opening the screen and saving changes nothing.
   */
  const [countryCode, setCountryCode] = useState(organization.countryCode);
  const [regionCode, setRegionCode] = useState(organization.regionCode ?? '');
  const [timezone, setTimezone] = useState(organization.timezone);
  const [currency, setCurrency] = useState(organization.currency);

  const [state, action, pending] = useActionState(saveOrganization.bind(null, slug), IDLE);
  const formRef = useRef<HTMLFormElement>(null);
  useOutcomeFocus(state.status, formRef);

  const err = (name: string): string[] | undefined => state.fieldErrors?.[name];

  return (
    <form ref={formRef} action={action} noValidate>
      <div className="grid gap-4 sm:grid-cols-2">
        <Input
          name="legalName"
          label="Registered name"
          hint="As it appears on invoices and filings"
          errors={err('legalName')}
          defaultValue={organization.legalName}
          disabled={!canEdit}
          required
          autoComplete="organization"
        />
        <Input
          name="displayName"
          label="Name patients see"
          hint="As it appears on portal"
          errors={err('displayName')}
          defaultValue={organization.displayName}
          disabled={!canEdit}
          required
          autoComplete="off"
        />
        <Input
          name="gstNumber"
          label="GSTIN"
          hint="Leave empty if this clinic is not registered"
          errors={err('gstNumber')}
          className="font-mono"
          defaultValue={organization.gstNumber ?? ''}
          disabled={!canEdit}
          autoComplete="off"
        />
        {/*
          Country and region, from the same table signup and the platform tax
          console read. Changing the country re-derives the time zone and the
          currency below — the same behaviour as signup, so a clinic that moves
          does not have to know which three fields are connected.

          ⚠️ IT CHANGES THE TAX ON FUTURE INVOICES AND NOTHING ELSE. Place of
            supply, both tax numbers and every rate are snapshotted onto each
            invoice when it is raised, so this edit cannot rewrite an issued one.
        */}
        {/* Unnamed on purpose — submitted by the hidden input below. */}
        <Select
          id="countryCode"
          label="Country"
          hint="Where this clinic operates. It decides the tax on your subscription."
          errors={err('countryCode')}
          value={countryCode}
          disabled={!canEdit}
          onChange={(event) => {
            const next = event.target.value;
            setCountryCode(next);
            setRegionCode('');
            setTimezone(defaultTimezoneFor(next));
            setCurrency(countryInfo(next)?.currency ?? currency);
          }}
          options={COUNTRIES.map((option) => ({ value: option.code, label: option.name }))}
        />

        {regionsFor(countryCode).length > 0 ? (
          /* Unnamed on purpose — submitted by the hidden input below. */
          <Select
            id="regionCode"
            label="State"
            hint="Where this clinic is registered. It decides whether GST is charged as CGST and SGST, or as IGST."
            errors={err('regionCode')}
            value={regionCode}
            disabled={!canEdit}
            onChange={(event) => setRegionCode(event.target.value)}
            options={[
              { value: '', label: 'Not set — charged as IGST' },
              ...regionsFor(countryCode).map((region) => ({
                value: region.code,
                label: region.name,
              })),
            ]}
          />
        ) : null}

        {/*
         * Both are selects, and both include whatever the clinic is currently
         * set to even when that is off the list — a select cannot render a
         * value it has no option for, so without `withCurrent` a clinic on
         * Asia/Tokyo would be moved to Asia/Kolkata by a save it made to fix
         * its GSTIN. The lists are the convenient choices; the contract
         * validates against the platform's full set.
         */}
        {/* Unnamed on purpose — submitted by the hidden input below. */}
        <Select
          id="timezone"
          label="Time zone"
          hint="Appointment times and report dates are read in this zone"
          errors={err('timezone')}
          value={timezone}
          onChange={(event) => setTimezone(event.target.value)}
          disabled={!canEdit}
          required
          options={withCurrent(TIMEZONES, timezone)}
        />
        {/* Unnamed on purpose — submitted by the hidden input below. */}
        <Select
          id="currency"
          label="Currency"
          hint="What invoices and price lists are denominated in"
          errors={err('currency')}
          value={currency}
          onChange={(event) => setCurrency(event.target.value)}
          disabled={!canEdit}
          required
          options={withCurrent(CURRENCIES, currency)}
        />
      </div>

      {/*
        ⚠️ THE FOUR SELECTS ABOVE SUBMIT THROUGH THESE, WHICH IS WHY NONE OF THEM
          CARRIES A `name`.

          React 19 resets the form once the action returns. `form.reset()` puts a
          control back to its DEFAULT, and for a <select> that is the `selected`
          ATTRIBUTE on its options — which React never writes, because it drives
          selection through the DOM property. So a rejected save snaps every
          select back to its first option while React state, and the screen,
          still show what was picked; the next save then writes the reverted
          values with nothing on screen to say so. Registration lost a clinic's
          country exactly this way. Hidden inputs are immune — React writes their
          `value` attribute, so a reset restores the value they already had.

          Only when `canEdit`: a disabled control is not submitted, and these
          stand in for controls that are disabled without it.
      */}
      {canEdit ? (
        <>
          <input type="hidden" name="countryCode" value={countryCode} />
          <input type="hidden" name="regionCode" value={regionCode} />
          <input type="hidden" name="timezone" value={timezone} />
          <input type="hidden" name="currency" value={currency} />
        </>
      ) : null}

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
  rolePairings,
  canEditOrganization,
  canEditSettings,
  canReadHistory,
}: {
  slug: string;
  organization: OrganizationProfile | null;
  settings: SettingItem[] | null;
  /** Null when the caller may not manage titles — the section is then absent. */
  rolePairings: RolePairings[] | null;
  canEditOrganization: boolean;
  canEditSettings: boolean;
  canReadHistory: boolean;
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
          <div className="flex flex-wrap items-baseline justify-between gap-3">
            <h2 id="details-heading" className="eyebrow text-muted">
              Details
            </h2>
            {/* The richest trail in the product: the clinic's own particulars are
                what get corrected most, and "who changed our GST number" is the
                question this screen gets asked. */}
            {canReadHistory ? (
              <RecordHistory
                slug={slug}
                entityType="organization"
                entityId={organization.id}
                label={organization.displayName}
              />
            ) : null}
          </div>
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

      {/*
        Clinic-wide, not per branch — a role means the same thing everywhere the
        clinic operates, and the copy says so rather than leaving someone to
        wonder why the branch switcher does not affect it.
      */}
      {rolePairings !== null ? (
        <section className="border-rule mt-10 border-t pt-8" aria-labelledby="titles-heading">
          <h2 id="titles-heading" className="eyebrow text-muted">
            Roles and titles
          </h2>
          <p className="text-muted mt-2 max-w-xl text-[0.9375rem] leading-relaxed">
            Which job titles each role can be given when you invite someone. A receptionist should
            not be a radiologist, and this is what stops it. Applies across every branch.
          </p>
          <RoleTitles slug={slug} roles={rolePairings} />
        </section>
      ) : null}
    </>
  );
}
