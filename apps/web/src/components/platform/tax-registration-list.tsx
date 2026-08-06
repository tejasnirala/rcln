'use client';

import { useActionState, useRef, useState } from 'react';
import type { TaxRegistrationSummary } from '@rcln/contracts';
import {
  removeTaxRegistration,
  saveTaxRegistration,
  type TaxFormState,
} from '@/app/(platform)/platform/taxes/actions';
import { Alert, useOutcomeFocus } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Input, Select } from '@/components/ui/field';
import { cn } from '@/lib/cn';
import { COUNTRIES, countryInfo, regionsFor } from '@/lib/locale-options';

/**
 * Where rcln collects tax, and the one screen that changes it.
 *
 * ⚠️ WHAT THIS SCREEN EDITS IS A LEGAL ASSERTION, NOT A SETTING.
 *   A row here says we hold a registration with a revenue authority. From the
 *   moment it is saved, every clinic whose place of supply it covers is charged
 *   — and tax collected without a registration cannot be remitted, because
 *   there is nobody to remit it to. The copy says this out loud rather than
 *   burying it, because the person using it is the only check.
 *
 * COUNTRY-WIDE AND REGION-SPECIFIC READ AS ONE HIERARCHY
 *   A country-wide registration is listed first with its regions indented under
 *   it, because that is exactly how the engine resolves them: the region wins
 *   for a clinic in that region, the country-wide row covers everyone else. A
 *   flat list would hide the one relationship that decides what gets charged.
 *
 * Expand-in-place, like every other list in this console — no modal.
 */

const INITIAL: TaxFormState = { status: 'idle' };

const SCHEMES = [
  { value: 'GST', label: 'GST', note: 'India, Australia, Singapore' },
  { value: 'VAT', label: 'VAT', note: 'EU, UK, Gulf states' },
  { value: 'SALES_TAX', label: 'Sales tax', note: 'United States' },
] as const;

export function TaxRegistrationList({
  registrations,
}: {
  registrations: TaxRegistrationSummary[];
}) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);

  /*
   * Grouped by country so a registration's scope is visible at a glance. Within
   * a country the country-wide row sorts first — the API already orders by
   * region with nulls first, and this preserves that rather than re-sorting.
   */
  const byCountry = new Map<string, TaxRegistrationSummary[]>();
  for (const registration of registrations) {
    const list = byCountry.get(registration.countryCode) ?? [];
    list.push(registration);
    byCountry.set(registration.countryCode, list);
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-muted text-[0.8125rem] leading-relaxed">
          {registrations.length === 0
            ? 'No registrations. Nothing is being taxed anywhere.'
            : `${String(registrations.length)} registration${registrations.length === 1 ? '' : 's'}.`}
        </p>
        <Button
          size="sm"
          variant={adding ? 'ghost' : 'primary'}
          onClick={() => {
            setAdding((open) => !open);
            setEditingId(null);
          }}
        >
          {adding ? 'Cancel' : 'Add a registration'}
        </Button>
      </div>

      {adding ? (
        <div className="border-drape bg-card rounded-lg border p-6">
          <h2 className="font-display text-ink text-lg">Add a registration</h2>
          <RegistrationForm id={null} onDone={() => setAdding(false)} />
        </div>
      ) : null}

      {registrations.length === 0 && !adding ? (
        <div className="border-rule bg-card rounded-lg border p-8 text-center">
          <p className="text-ink text-[0.9375rem]">Nothing is being taxed.</p>
          <p className="text-muted mx-auto mt-2 max-w-md text-[0.8125rem] leading-relaxed">
            Every invoice says so, and records why. Add a registration when rcln is actually
            registered with that authority — not before.
          </p>
        </div>
      ) : null}

      {[...byCountry.entries()].map(([country, rows]) => (
        <section key={country} aria-label={country} className="space-y-2">
          <h2 className="text-muted font-mono text-[0.8125rem] font-medium tracking-wide">
            {country}
          </h2>

          <ul className="space-y-2">
            {rows.map((registration) => (
              <li
                key={registration.id}
                className={cn(
                  'border-rule bg-card rounded-lg border p-5',
                  // Indented when it narrows the country above it, so the
                  // hierarchy the engine actually uses is the one on screen.
                  registration.regionCode && 'sm:ml-6'
                )}
              >
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <p className="text-ink font-mono text-[0.9375rem]">
                      {registration.placeOfSupply}
                      <span className="text-muted ml-2 font-sans text-[0.8125rem]">
                        {registration.regionCode ? 'this region only' : 'whole country'}
                      </span>
                    </p>
                    <p className="text-muted mt-1 text-[0.8125rem]">
                      {registration.scheme.replace('_', ' ')} at{' '}
                      <span className="text-ink font-mono">
                        {formatRate(registration.standardRateBps)}
                      </span>{' '}
                      · <span className="font-mono">{registration.registrationNumber}</span>
                    </p>
                    <p className="text-muted mt-1 text-[0.8125rem]">
                      From {registration.effectiveFrom}
                      {registration.effectiveTo ? ` until ${registration.effectiveTo}` : ''}
                      {!registration.isLive ? (
                        <span className="text-signal ml-2">
                          Not applying today
                          <span className="sr-only">
                            {' '}
                            — outside its effective dates, so nothing is charged here
                          </span>
                        </span>
                      ) : null}
                    </p>
                  </div>

                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={() => {
                      setEditingId((open) => (open === registration.id ? null : registration.id));
                      setAdding(false);
                    }}
                    aria-expanded={editingId === registration.id}
                  >
                    {editingId === registration.id ? 'Close' : 'Edit'}
                  </Button>
                </div>

                {editingId === registration.id ? (
                  <div className="border-rule mt-5 border-t pt-5">
                    <RegistrationForm
                      id={registration.id}
                      registration={registration}
                      onDone={() => setEditingId(null)}
                    />
                  </div>
                ) : null}
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}

function RegistrationForm({
  id,
  registration,
  onDone,
}: {
  id: string | null;
  registration?: TaxRegistrationSummary;
  onDone: () => void;
}) {
  const [state, action, pending] = useActionState(saveTaxRegistration.bind(null, id), INITIAL);
  const [removeState, remove, removing] = useActionState(
    removeTaxRegistration.bind(null, id ?? ''),
    INITIAL
  );

  const formRef = useRef<HTMLFormElement>(null);
  // Moves focus to the first invalid field, or to the alert. Same contract as
  // every other form in the console.
  useOutcomeFocus(state.status, formRef);

  // Server-echoed values first, then the row being edited. See the signup form:
  // React 19 resets a form after its action runs, so a rejected save would
  // otherwise empty every field.
  const initial = (key: string, fallback: string | number | null | undefined): string =>
    state.values?.[key] ?? (fallback === null || fallback === undefined ? '' : String(fallback));

  const err = (key: string): string[] | undefined => state.fieldErrors?.[key];

  /*
   * Country and region are selects from the same table signup and clinic
   * settings use, so a registration can only ever name a place a clinic can
   * actually be in. They were free text, which let `In` and `IN` coexist as
   * different jurisdictions and quietly stop matching anybody.
   *
   * Choosing a country PREFILLS the scheme and rate rather than setting them:
   * `tax` in the country table is what a registration here ordinarily looks
   * like, and the operator is confirming it against a certificate. Silently
   * overwriting a rate they had already typed would be the wrong kind of help.
   */
  const [countryCode, setCountryCode] = useState(registration?.countryCode ?? 'IN');
  const [regionCode, setRegionCode] = useState(registration?.regionCode ?? '');
  const [scheme, setScheme] = useState(registration?.scheme ?? 'GST');
  const [ratePercent, setRatePercent] = useState(
    registration ? String(registration.standardRateBps / 100) : '18'
  );

  const regions = regionsFor(countryCode);

  if (state.status === 'saved') {
    return (
      <div className="space-y-3">
        <Alert tone="info">{state.message}</Alert>
        <Button size="sm" variant="ghost" onClick={onDone}>
          Close
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <form ref={formRef} action={action} className="grid gap-5 sm:grid-cols-2">
        <Select
          name="countryCode"
          label="Country"
          errors={err('countryCode')}
          value={countryCode}
          onChange={(event) => {
            const next = event.target.value;
            setCountryCode(next);
            // The previous country's subdivisions are gone from the list.
            setRegionCode('');
            const tax = countryInfo(next)?.tax;
            if (tax) {
              setScheme(tax.scheme);
              setRatePercent(String(tax.standardRateBps / 100));
            }
          }}
          options={COUNTRIES.map((option) => ({ value: option.code, label: option.name }))}
        />

        <Select
          name="regionCode"
          label="Region"
          hint={
            regions.length > 0
              ? 'Leave on “whole country” unless this registration is for one state only.'
              : 'This country registers nationally — there is no region to choose.'
          }
          errors={err('regionCode')}
          value={regionCode}
          disabled={regions.length === 0}
          onChange={(event) => setRegionCode(event.target.value)}
          options={[
            { value: '', label: 'Whole country' },
            ...regions.map((region) => ({ value: region.code, label: region.name })),
          ]}
        />

        <Select
          name="scheme"
          label="Tax"
          errors={err('scheme')}
          required
          value={scheme}
          onChange={(event) => setScheme(event.target.value as typeof scheme)}
          options={SCHEMES.map((option) => ({
            value: option.value,
            label: `${option.label} — ${option.note}`,
          }))}
        />

        <Input
          name="ratePercent"
          label="Rate"
          hint="A percentage. 18 for Indian GST, 23 for Irish VAT."
          errors={err('ratePercent')}
          required
          inputMode="decimal"
          value={ratePercent}
          onChange={(event) => setRatePercent(event.target.value)}
          className="font-mono"
          placeholder="18"
        />

        <Input
          name="registrationNumber"
          label="Our registration number"
          hint="Printed on every invoice this covers. GSTIN, VAT number, state permit."
          errors={err('registrationNumber')}
          required
          defaultValue={initial('registrationNumber', registration?.registrationNumber)}
          className="font-mono"
          placeholder="29AABCU9603R1ZM"
        />

        <Input
          name="effectiveFrom"
          label="Registered from"
          hint="Supplies before this date are not taxed by us."
          errors={err('effectiveFrom')}
          type="date"
          required
          defaultValue={initial('effectiveFrom', registration?.effectiveFrom)}
        />

        <Input
          name="effectiveTo"
          label="Until"
          hint="Leave blank while the registration is live. Set it to stop collecting from a date without losing the history."
          errors={err('effectiveTo')}
          type="date"
          defaultValue={initial('effectiveTo', registration?.effectiveTo)}
        />

        <div className="sm:col-span-2">
          {state.status === 'error' && state.message ? (
            <Alert tone="error" className="mb-4">
              {state.message}
            </Alert>
          ) : null}

          {countryInfo(countryCode)?.tax === null ? (
            <Alert tone="info" className="mb-4">
              We do not suggest a rate for this country. US sales tax combines state, county and
              city rates and varies by what is sold — the tax engine will not compute it either, so
              a registration here records the fact without charging anything.
            </Alert>
          ) : null}

          <p className="text-muted mb-4 text-[0.8125rem] leading-relaxed">
            Saving this starts charging on the next checkout in that place. Only add a registration
            rcln actually holds — tax collected without one cannot be remitted to anybody.
          </p>

          <div className="flex flex-wrap gap-2">
            <Button type="submit" size="sm" disabled={pending}>
              {pending ? 'Saving…' : id ? 'Save changes' : 'Add registration'}
            </Button>
            <Button type="button" size="sm" variant="ghost" onClick={onDone}>
              Cancel
            </Button>
          </div>
        </div>
      </form>

      {id ? (
        <form action={remove} className="border-rule border-t pt-4">
          <p className="text-muted text-[0.8125rem] leading-relaxed">
            Removing it stops all collection there immediately. Prefer an end date if you simply
            deregistered — invoices already issued keep this number, and a return may need it.
          </p>
          {removeState.status === 'error' && removeState.message ? (
            <Alert tone="error" className="mt-3">
              {removeState.message}
            </Alert>
          ) : null}
          <Button type="submit" size="sm" variant="secondary" className="mt-3" disabled={removing}>
            {removing ? 'Removing…' : 'Remove registration'}
          </Button>
        </form>
      ) : null}
    </div>
  );
}

/** `1800` -> `18%`. Display only. */
function formatRate(bps: number): string {
  const percent = bps / 100;
  return `${Number.isInteger(percent) ? String(percent) : percent.toFixed(2)}%`;
}
