'use client';

import { useActionState, useEffect, useRef, useState } from 'react';
import {
  addressLabels,
  countryInfo,
  COUNTRIES,
  defaultTimezoneFor,
  dialFormatFor,
  hasTimezoneChoice,
  isValidPostalCode,
  isValidTaxId,
  normalizePostalCode,
  postalFormatFor,
  regionsFor,
  registerOrganizationRequest,
  taxIdFormatFor,
  timezoneLabel,
  toE164,
} from '@rcln/contracts';
import {
  checkSlug,
  lookupPostalCode,
  registerClinic,
  type SignupFormState,
} from '@/app/(marketing)/signup/actions';
import { track } from '@/lib/analytics';
import { cn } from '@/lib/cn';
import {
  Field,
  FieldError,
  Input,
  Select,
  describedBy,
  type SelectOption,
} from '@/components/ui/field';
import { PhoneInput } from '@/components/ui/phone-input';

/**
 * Clinic registration, in four steps.
 *
 * WHY MULTI-STEP AND NOT ONE LONG FORM
 *   Fourteen fields in one column reads as work. Split into four named moves it
 *   reads as a process with an end, and each step can carry the one sentence of
 *   context that step actually needs.
 *
 * WHY THE STEPS STAY MOUNTED
 *   Every field lives in one <form> the whole time; inactive steps carry the
 *   `hidden` attribute. That means the final submit already holds every value
 *   with no duplicated state to keep in sync, and `hidden` removes those fields
 *   from both the tab order and the accessibility tree — so a keyboard user can
 *   never land in a step they cannot see. (`display: none` via a class would
 *   not reliably do the second thing.)
 *
 * ⚠️ THE COUNTRY IS THE FIRST QUESTION ON STEP 3, AND EVERYTHING UNDER IT IS A
 *   FUNCTION OF IT. What the postcode is called and what shape it is, whether
 *   there is a second address level and what it is called, the calling code on
 *   the reception number, which tax registration to ask for — none of those
 *   have an answer until the country does. Asking for a "PIN code" and a
 *   "GSTIN" before the country was chosen is how the earlier version of this
 *   form silently assumed India.
 *
 * The numbered rail is not decoration: registration genuinely is a sequence —
 * the clinic has to exist before it has an address, and the address before
 * there is anyone to own it.
 */

const ROOT_DOMAIN = process.env['NEXT_PUBLIC_ROOT_DOMAIN'] ?? 'lvh.me';

const INITIAL: SignupFormState = { status: 'idle' };

/** What kind of practice this is, in the words a practice uses for itself. */
const ORG_TYPES: SelectOption[] = [
  { value: 'CLINIC', label: 'Clinic' },
  { value: 'HOSPITAL', label: 'Hospital' },
  { value: 'CHAIN', label: 'Multi-branch group' },
  { value: 'LAB', label: 'Diagnostic lab' },
];

const STEPS = [
  { id: 'clinic', label: 'Clinic' },
  { id: 'address', label: 'Address' },
  { id: 'branch', label: 'First location' },
  { id: 'account', label: 'Your account' },
] as const;

/** Which schema each step's fields belong to, for validating before advancing. */
const shape = registerOrganizationRequest.shape;

type Errors = Record<string, string[]>;

/**
 * Form field name -> the contract paths an error for it can arrive under.
 *
 * The form is flat and the contract is nested, so something has to translate.
 * Doing it through one table rather than at each call site is what lets both
 * "show me this field's error" and "the customer just edited this field, drop
 * its stale error" be written once — and it is why `branchName`, whose error
 * can arrive as either `branch.name` from the server or `branch.branchName`
 * from the local parse, is handled in one place instead of at every use.
 */
const ERROR_KEYS: Record<string, readonly string[]> = {
  displayName: ['organization.displayName'],
  legalName: ['organization.legalName'],
  orgType: ['organization.orgType'],
  taxId: ['organization.taxId'],
  slug: ['organization.slug'],
  countryCode: ['organization.countryCode'],
  regionCode: ['organization.regionCode'],
  timezone: ['organization.timezone'],
  branchName: ['branch.branchName', 'branch.name'],
  addressLine1: ['branch.addressLine1'],
  city: ['branch.city'],
  state: ['branch.state'],
  pincode: ['branch.pincode'],
  branchPhone: ['branch.phone'],
  fullName: ['owner.fullName'],
  email: ['owner.email'],
  phone: ['owner.phone'],
  password: ['owner.password'],
  acceptedTerms: ['acceptedTerms'],
};

function issuesToErrors(
  issues: { path: PropertyKey[]; message: string }[],
  prefix: string
): Errors {
  const errors: Errors = {};
  for (const issue of issues) {
    const key = `${prefix}${issue.path.map(String).join('.')}`;
    (errors[key] ??= []).push(issue.message);
  }
  return errors;
}

/**
 * Which step a server-side field error belongs to.
 *
 * The contract is nested and the steps are a UI concept, so the mapping has to
 * live somewhere; here, next to the steps it names, rather than in the action.
 * Anything unrecognised lands on the last step, which is where the submit button
 * is — an error the customer can see beats an error on a step they cannot reach.
 */
function stepForError(key: string): number {
  if (key === 'organization.slug') return 1;
  // The country and everything derived from it moved onto the location step,
  // where the fields it governs are.
  if (
    key === 'organization.countryCode' ||
    key === 'organization.regionCode' ||
    key === 'organization.timezone' ||
    key === 'organization.taxId'
  ) {
    return 2;
  }
  if (key.startsWith('organization.')) return 0;
  if (key.startsWith('branch.')) return 2;
  return 3;
}

export function SignupForm() {
  const [state, action, pending] = useActionState(registerClinic, INITIAL);
  const [step, setStep] = useState(0);
  const [localErrors, setLocalErrors] = useState<Errors>({});

  /**
   * Server errors the customer has since edited away.
   *
   * ⚠️ WITHOUT THIS, A SERVER ERROR IS PERMANENT. `state.fieldErrors` only
   *   changes when the action runs again, so after one rejected submit every
   *   field it named kept its red message for the rest of the session — the
   *   customer fixed the password, watched the "at least 12 characters" line
   *   stay put under it, and had no way to tell whether they had fixed
   *   anything. On the account step, where a first submit fails most often,
   *   that read as "every field is wrong the moment the step opens".
   */
  const [dismissed, setDismissed] = useState<ReadonlySet<string>>(new Set());

  /*
   * Jump to the first step that has a server error.
   *
   * Without this the customer sits on the last step reading "Check the
   * highlighted fields" with every highlighted field two steps behind them —
   * which, combined with the form reset this component now defends against, was
   * the whole of "I cannot sign up".
   *
   * Adjusted DURING RENDER rather than in an effect: React supports exactly this
   * for state derived from a change in props, it re-renders before painting so
   * there is no flash of the wrong step, and it avoids the setState-in-an-effect
   * cascade the slug checker's comment below is also written to avoid.
   */
  const [seenErrors, setSeenErrors] = useState(state.fieldErrors);
  if (state.fieldErrors !== seenErrors) {
    setSeenErrors(state.fieldErrors);
    // A fresh answer from the server outranks anything dismissed against the
    // previous one, or the customer would never see the second rejection.
    setDismissed(new Set());
    const keys = Object.keys(state.fieldErrors ?? {});
    if (keys.length > 0) setStep(Math.min(...keys.map(stepForError)));
  }

  const [orgType, setOrgType] = useState('CLINIC');

  /*
   * Country drives the whole of step 3, so it is state rather than an
   * uncontrolled input: it decides the address labels, the postcode format, the
   * calling code, which tax registration is asked for, the time zone and the
   * billing currency.
   *
   * The zone is a DEFAULT, not a lock — several of these countries have more
   * than one — so it is its own state that country picks up.
   */
  const [countryCode, setCountryCode] = useState('IN');
  const [timezone, setTimezone] = useState(defaultTimezoneFor('IN'));

  /*
   * The one place-below-country answer, held in two forms because it is used
   * two ways: `regionCode` is the ISO subdivision the tax engine needs, and
   * `regionName` is what goes in the branch's address. For a country that
   * registers tax per subdivision they are two views of one select; for one
   * that does not, there is no code and the name is free text.
   */
  const [regionCode, setRegionCode] = useState(state.values?.['regionCode'] ?? '');
  const [regionName, setRegionName] = useState(state.values?.['state'] ?? '');
  const [city, setCity] = useState(state.values?.['city'] ?? '');
  const [postalCode, setPostalCode] = useState(state.values?.['pincode'] ?? '');
  const [taxId, setTaxId] = useState(state.values?.['taxId'] ?? '');

  /** National digits only. `PhoneInput` submits the E.164 form. */
  const [branchPhone, setBranchPhone] = useState('');
  const [ownerPhoneCountry, setOwnerPhoneCountry] = useState('IN');
  const [ownerPhone, setOwnerPhone] = useState('');

  const country = countryInfo(countryCode);
  // Only countries with more than one zone get asked. See `CountryInfo`.
  const choosable = hasTimezoneChoice(countryCode);
  // Empty for countries with no sub-national tax registration — the field is
  // then a free-text one under this country's own label rather than a select.
  const regions = regionsFor(countryCode);
  const labels = addressLabels(countryCode);
  const postalFormat = postalFormatFor(countryCode);
  const taxFormat = taxIdFormatFor(countryCode);

  const [slug, setSlug] = useState('');

  /**
   * The availability answer, tagged with the value it was an answer FOR.
   *
   * Storing the slug alongside the result is what lets "are we still checking?"
   * be derived rather than synchronised: a result whose `slug` no longer matches
   * the input is simply stale and ignored. The obvious alternative — clearing
   * the state from an effect whenever the input changes — is a setState inside
   * an effect body, which cascades renders and is what the React lint rule is
   * there to prevent.
   */
  const [checked, setChecked] = useState<{
    slug: string;
    available: boolean;
    message?: string;
  } | null>(null);

  const slugTooShort = slug.length < 3;
  const answer = checked?.slug === slug ? checked : null;
  const checking = !slugTooShort && answer === null;

  const formRef = useRef<HTMLFormElement>(null);
  const headingRef = useRef<HTMLParagraphElement>(null);

  /**
   * What the postcode lookup last wrote, so a second lookup may replace it and
   * anything the customer typed themselves is left alone.
   *
   * A ref rather than state: nothing renders from it, and it must be readable
   * inside the lookup's callback without that callback becoming stale.
   */
  const autofilled = useRef<{ city: string; regionName: string; regionCode: string } | null>(null);

  // Server errors take precedence — they are the authoritative answer — except
  // where the customer has since edited the field they were about.
  const errors: Errors = { ...localErrors, ...(state.fieldErrors ?? {}) };

  function errorFor(field: string): string[] | undefined {
    for (const key of ERROR_KEYS[field] ?? [field]) {
      if (!dismissed.has(key) && errors[key]) return errors[key];
    }
    return undefined;
  }

  /** The customer has changed this field, so its outstanding error is stale. */
  function clearError(field: string): void {
    const keys = ERROR_KEYS[field] ?? [field];
    // Nothing to clear on the overwhelming majority of keystrokes; bail before
    // allocating a new Set and re-rendering the whole form for each one.
    if (!keys.some((key) => key in errors && !dismissed.has(key))) return;

    setDismissed((previous) => new Set([...previous, ...keys]));
    setLocalErrors((previous) => {
      if (!keys.some((key) => key in previous)) return previous;
      const next = { ...previous };
      for (const key of keys) delete next[key];
      return next;
    });
  }

  useEffect(() => {
    if (state.status === 'registered') track('signup_completed');
    if (state.status === 'error') track('signup_failed');
  }, [state.status]);

  /**
   * On a failed submit, move focus to the first field at fault. Without this a
   * keyboard user is left on the submit button with an error they cannot find.
   */
  useEffect(() => {
    if (state.status !== 'error') return;
    const firstInvalid = formRef.current?.querySelector<HTMLElement>(
      'section:not([hidden]) [aria-invalid="true"]'
    );
    (firstInvalid ?? formRef.current?.querySelector<HTMLElement>('[role="alert"]'))?.focus();
  }, [state]);

  /**
   * Debounced availability check.
   *
   * No setState in the effect body — only inside the timeout callback, once an
   * answer actually exists. The "checking" and "cleared" states are derived
   * above from whether `checked` still matches the current input.
   */
  useEffect(() => {
    if (slug.length < 3) return;

    const timer = setTimeout(() => {
      void checkSlug(slug).then((result) => {
        setChecked({
          slug,
          available: result.available,
          ...(result.message ? { message: result.message } : {}),
        });
      });
    }, 400);

    return () => clearTimeout(timer);
  }, [slug]);

  /**
   * Fill in the city and the region from the postcode.
   *
   * A CONVENIENCE, NEVER A CORRECTION. Both fields stay editable, and this only
   * writes over a value it wrote itself — `autofilled` is what tells the two
   * apart. Someone who types their own city and then corrects a typo in the
   * postcode keeps their city; someone who mistypes the postcode and fixes it
   * gets the right city rather than the first one.
   *
   * Coverage is partial by nature (see `lookupPostalCode`), so "no answer" is
   * the ordinary case for several countries and is silent by design — there is
   * nothing here for the customer to act on.
   */
  useEffect(() => {
    const normalized = normalizePostalCode(countryCode, postalCode);
    if (!normalized || !isValidPostalCode(countryCode, normalized)) return;

    let cancelled = false;
    const timer = setTimeout(() => {
      void lookupPostalCode(countryCode, normalized).then((found) => {
        if (cancelled || !found) return;

        setCity((current) =>
          !current || current === autofilled.current?.city ? (found.city ?? current) : current
        );
        setRegionName((current) =>
          !current || current === autofilled.current?.regionName
            ? (found.region ?? current)
            : current
        );
        setRegionCode((current) =>
          !current || current === autofilled.current?.regionCode
            ? (found.regionCode ?? current)
            : current
        );

        autofilled.current = {
          city: found.city ?? '',
          regionName: found.region ?? '',
          regionCode: found.regionCode ?? '',
        };
      });
    }, 500);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [countryCode, postalCode]);

  function values(names: string[]): Record<string, unknown> {
    const form = formRef.current;
    if (!form) return {};

    const data = new FormData(form);
    const out: Record<string, unknown> = {};
    for (const name of names) {
      const raw = String(data.get(name) ?? '').trim();
      if (raw) out[name] = raw;
    }
    return out;
  }

  /** Validate the current step in isolation, then advance. */
  function advance(): void {
    let next: Errors = {};

    if (step === 0) {
      const parsed = shape.organization
        .pick({ legalName: true, displayName: true, orgType: true })
        .safeParse({ ...values(['legalName', 'displayName']), orgType });
      if (!parsed.success) next = issuesToErrors(parsed.error.issues, 'organization.');
    }

    if (step === 1) {
      const parsed = shape.organization.pick({ slug: true }).safeParse({ slug });
      if (!parsed.success) {
        next = issuesToErrors(parsed.error.issues, 'organization.');
      } else if (answer?.available === false) {
        next = { 'organization.slug': [answer.message ?? 'That address is taken.'] };
      }
    }

    if (step === 2) {
      const parsed = shape.branch.safeParse({
        name: values(['branchName'])['branchName'],
        code: 'MAIN',
        ...values(['addressLine1']),
        ...(city ? { city } : {}),
        ...(regionName ? { state: regionName } : {}),
        ...(postalCode ? { pincode: normalizePostalCode(countryCode, postalCode) } : {}),
        ...(branchPhone ? { phone: toE164(countryCode, branchPhone) } : {}),
      });
      if (!parsed.success) {
        // The form field is `branchName`; the contract calls it `branch.name`.
        next = issuesToErrors(parsed.error.issues, 'branch.');
        if (next['branch.name']) {
          next['branch.branchName'] = next['branch.name'];
        }
      }

      /*
       * The country-dependent checks. They cannot come from `shape.branch`
       * alone — the contract validates these two against `organization.
       * countryCode` in a refinement across the whole payload, which a
       * per-step parse of one sub-object can never reach. Repeated here so the
       * customer is told on the step rather than after the final submit.
       */
      if (!isValidPostalCode(countryCode, postalCode)) {
        next['branch.pincode'] = [
          postalFormat
            ? `That does not look like a ${labels.postalCode.toLowerCase()} for ${country?.name ?? 'this country'}. For example, ${postalFormat.example}.`
            : `${country?.name ?? 'This country'} does not use postcodes.`,
        ];
      }

      if (branchPhone) {
        const dial = dialFormatFor(countryCode);
        const length = branchPhone.length;
        if (length < dial.minDigits || length > dial.maxDigits) {
          next['branch.phone'] = [
            dial.minDigits === dial.maxDigits
              ? `A ${country?.name ?? ''} number has ${dial.minDigits} digits after ${dial.code}.`
              : `A ${country?.name ?? ''} number has ${dial.minDigits}–${dial.maxDigits} digits after ${dial.code}.`,
          ];
        }
      }

      if (!isValidTaxId(countryCode, taxId)) {
        next['organization.taxId'] = [
          `That does not look like a ${taxFormat?.label ?? 'tax registration number'}. For example, ${taxFormat?.example ?? ''}.`,
        ];
      }

      if (regions.length > 0 && !regionCode) {
        next['organization.regionCode'] = [
          `Choose the ${(labels.region ?? 'region').toLowerCase()}.`,
        ];
      }
    }

    setLocalErrors(next);
    // Anything dismissed applied to the answer we have just replaced.
    setDismissed(new Set());

    if (Object.keys(next).length > 0) {
      const first = formRef.current?.querySelector<HTMLElement>(
        'section:not([hidden]) [aria-invalid="true"]'
      );
      first?.focus();
      return;
    }

    setStep((current) => Math.min(current + 1, STEPS.length - 1));
    // Announce the new step to a screen reader and put focus at its start.
    requestAnimationFrame(() => headingRef.current?.focus());
  }

  if (state.status === 'registered' && state.loginUrl) {
    return <Registered loginUrl={state.loginUrl} slug={state.slug ?? ''} />;
  }

  const current = STEPS[step] as (typeof STEPS)[number];
  const isLast = step === STEPS.length - 1;

  return (
    <form
      ref={formRef}
      action={action}
      /*
       * One handler for every uncontrolled field on the form: the moment a
       * field is edited, the error standing under it is about a value that no
       * longer exists. Controlled fields call `clearError` from their own
       * onChange, because they have one already.
       */
      onInput={(event) => {
        const target = event.target as Partial<HTMLInputElement>;
        if (target.name) clearError(target.name);
      }}
      className="border-rule bg-card rounded-lg border p-6 sm:p-8"
      noValidate
    >
      <ol className="border-rule -mx-6 mb-7 flex flex-wrap gap-x-5 gap-y-2 border-b px-6 pb-5 sm:-mx-8 sm:px-8">
        {STEPS.map((s, index) => {
          const done = index < step;
          const active = index === step;
          return (
            <li key={s.id} className="flex items-center gap-2">
              <span
                aria-hidden="true"
                className={cn(
                  'font-mono text-[0.6875rem] tabular-nums',
                  active ? 'text-signal' : done ? 'text-drape' : 'text-muted'
                )}
              >
                {String(index + 1).padStart(2, '0')}
              </span>
              <span
                className={cn(
                  'text-[0.8125rem]',
                  active ? 'text-ink font-medium' : done ? 'text-drape' : 'text-muted'
                )}
              >
                {s.label}
              </span>
              {/* Colour alone must not carry meaning (WCAG 1.4.1). */}
              {done ? <span className="sr-only">completed</span> : null}
              {active ? <span className="sr-only">current step</span> : null}
            </li>
          );
        })}
      </ol>

      <p
        ref={headingRef}
        tabIndex={-1}
        aria-live="polite"
        className="eyebrow text-drape mb-1 focus:outline-none"
      >
        Step {step + 1} of {STEPS.length} · {current.label}
      </p>

      {/* ---------------------------------------------------------------- */}
      <section hidden={step !== 0} aria-label="Clinic">
        <h2 className="font-display mb-5 text-2xl">What is the clinic called?</h2>

        <div className="grid gap-5">
          <Input
            name="displayName"
            label="Clinic name"
            hint="What patients and your team will see."
            errors={errorFor('displayName')}
            defaultValue={state.values?.['displayName'] ?? ''}
            autoComplete="organization"
            placeholder="Sunrise Clinic"
          />

          <Input
            name="legalName"
            label="Registered name"
            /*
             * No longer "as it appears on your GST registration" — the country
             * is not chosen yet at this point in the form, and a clinic in
             * Ireland or the UAE has no GST registration to read it off.
             */
            hint="The entity's name as registered. It goes on invoices."
            errors={errorFor('legalName')}
            defaultValue={state.values?.['legalName'] ?? ''}
            placeholder="Sunrise Healthcare Pvt Ltd"
          />

          {/* Unnamed on purpose — submitted by the hidden input at the foot. */}
          <Select
            id="orgType"
            label="What kind of practice?"
            value={orgType}
            onChange={(event) => setOrgType(event.target.value)}
            options={ORG_TYPES}
          />
        </div>
      </section>

      {/* --- the signature step: claiming the address -------------------- */}
      <section hidden={step !== 1} aria-label="Address">
        <h2 className="font-display mb-2 text-2xl">Pick your address.</h2>
        <p className="text-muted mb-6 text-[0.9375rem] leading-relaxed">
          This is where your clinic lives. Your team signs in here, and it does not change later.
        </p>

        <Field
          name="slug"
          label="Your clinic’s address"
          hint="Lowercase letters, digits and hyphens."
          errors={errorFor('slug')}
        >
          <div className="border-rule focus-within:border-drape flex items-stretch overflow-hidden rounded-md border transition-colors">
            <input
              id="slug"
              name="slug"
              value={slug}
              onChange={(event) => {
                setSlug(event.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ''));
                setLocalErrors({});
              }}
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              className="text-ink placeholder:text-muted bg-card min-w-0 flex-1 px-3.5 py-2.5 font-mono text-[0.9375rem] focus:outline-none"
              placeholder="sunrise"
              aria-invalid={Boolean(errorFor('slug'))}
              aria-describedby={describedBy('slug', true, Boolean(errorFor('slug')))}
            />
            <span
              aria-hidden="true"
              className="border-rule bg-paper text-muted flex items-center border-l px-3 font-mono text-[0.8125rem] whitespace-nowrap"
            >
              .{ROOT_DOMAIN}
            </span>
          </div>
        </Field>

        {/* Availability. aria-live so it is announced, and never colour alone. */}
        <p aria-live="polite" className="mt-2 text-[0.8125rem]">
          {slugTooShort ? (
            <span className="text-muted">Three characters or more.</span>
          ) : checking ? (
            <span className="text-muted">Checking…</span>
          ) : answer?.available ? (
            <span className="text-drape">
              <span className="font-mono">
                {slug}.{ROOT_DOMAIN}
              </span>{' '}
              is available.
            </span>
          ) : answer ? (
            <span className="text-signal">{answer.message ?? 'That address is taken.'}</span>
          ) : null}
        </p>
      </section>

      {/* ---------------------------------------------------------------- */}
      {/*
        ONE SECTION, NOT TWO. Where the clinic is and where it bills from were
        previously separate blocks with the country in the second one, so the
        form asked for a PIN code and a state above the field that decides what
        those words mean. The country is now the first question here and the
        rest of the step is derived from it.
      */}
      <section hidden={step !== 2} aria-label="First location">
        <h2 className="font-display mb-2 text-2xl">Where do you see patients?</h2>
        <p className="text-muted mb-6 text-[0.9375rem] leading-relaxed">
          Your first location. The country also sets the tax on your subscription and the currency
          you are billed in.
        </p>

        <div className="grid gap-5 sm:grid-cols-2">
          {/* Unnamed on purpose — submitted by the hidden input at the foot. */}
          <Select
            id="countryCode"
            label="Country"
            errors={errorFor('countryCode')}
            fieldClassName="sm:col-span-2"
            value={countryCode}
            onChange={(event) => {
              const next = event.target.value;
              setCountryCode(next);
              /*
               * Always reset the zone to the new country's default, rather
               * than preserving a choice made for the previous one.
               *
               * A zone carried over from another country is simply wrong —
               * America/Denver on an Irish clinic is not a preference worth
               * respecting — and for a single-zone country there is no
               * choice to preserve in the first place.
               */
              setTimezone(defaultTimezoneFor(next));
              /*
               * Everything below this field was entered in the previous
               * country's format and cannot be right in this one: a six
               * digit PIN code is not an Eircode, a Maharashtra is not a
               * county, and a GSTIN is not a VAT number. Clearing beats
               * leaving values that will fail validation for reasons the
               * customer cannot see.
               */
              setRegionCode('');
              setRegionName('');
              setCity('');
              setPostalCode('');
              setTaxId('');
              setBranchPhone('');
              autofilled.current = null;
              setLocalErrors({});
            }}
            options={COUNTRIES.map((option) => ({ value: option.code, label: option.name }))}
          />

          <Input
            name="branchName"
            label="Location name"
            errors={errorFor('branchName')}
            fieldClassName="sm:col-span-2"
            defaultValue={state.values?.['branchName'] ?? ''}
            placeholder="Sunrise Clinic, Kothrud"
          />

          <Input
            name="addressLine1"
            label={labels.addressLine1}
            errors={errorFor('addressLine1')}
            fieldClassName="sm:col-span-2"
            defaultValue={state.values?.['addressLine1'] ?? ''}
            autoComplete="address-line1"
            placeholder="12 Paud Road"
          />

          {/*
            Rendered only where the country has postcodes at all — the UAE has
            none, and an empty box under a blank label is a question nobody can
            answer.
          */}
          {postalFormat ? (
            <Input
              name="pincode"
              label={labels.postalCode}
              hint="We will fill in the rest of the address where we can."
              errors={errorFor('pincode')}
              value={postalCode}
              onChange={(event) => {
                setPostalCode(
                  postalFormat.numeric
                    ? event.target.value.replace(/\D/g, '')
                    : event.target.value.toUpperCase()
                );
                clearError('pincode');
              }}
              {...(postalFormat.numeric ? { inputMode: 'numeric' as const } : {})}
              autoComplete="postal-code"
              autoCapitalize="characters"
              className={cn('font-mono', postalFormat.numeric && 'tabular-nums')}
              placeholder={postalFormat.example}
            />
          ) : null}

          <Input
            name="city"
            label={labels.city}
            errors={errorFor('city')}
            value={city}
            onChange={(event) => {
              setCity(event.target.value);
              clearError('city');
            }}
            autoComplete="address-level2"
            placeholder="Pune"
          />

          {/*
            Three cases, and they are genuinely different questions.
              · a country that registers tax per subdivision -> a select, whose
                value is the ISO code the tax engine needs;
              · a country with an address-level region and no such registration
                -> free text under that country's own word for it;
              · a city-state -> nothing at all.
          */}
          {labels.region === null ? null : regions.length > 0 ? (
            /* Unnamed on purpose — submitted by the hidden input at the foot. */
            <Select
              id="regionCode"
              label={labels.region}
              hint={`Where this clinic is registered. It decides how ${country?.tax?.scheme ?? 'tax'} is split on your invoices.`}
              errors={errorFor('regionCode') ?? errorFor('state')}
              value={regionCode}
              onChange={(event) => {
                const code = event.target.value;
                setRegionCode(code);
                // The branch address wants the name, the tax engine wants the
                // code. One choice, written to both.
                setRegionName(regions.find((r) => r.code === code)?.name ?? '');
                clearError('regionCode');
                clearError('state');
              }}
              options={[
                { value: '', label: `Select ${labels.region.toLowerCase()}` },
                ...regions.map((region) => ({ value: region.code, label: region.name })),
              ]}
            />
          ) : (
            <Input
              name="state"
              label={labels.region}
              errors={errorFor('state')}
              value={regionName}
              onChange={(event) => {
                setRegionName(event.target.value);
                clearError('state');
              }}
              autoComplete="address-level1"
            />
          )}

          <Field
            name="branchPhone"
            label="Reception phone"
            hint={`${dialFormatFor(countryCode).code} is set by the country above.`}
            errors={errorFor('branchPhone')}
          >
            <PhoneInput
              id="branchPhone"
              name="branchPhone"
              countryCode={countryCode}
              national={branchPhone}
              onNationalChange={(digits) => {
                setBranchPhone(digits);
                clearError('branchPhone');
              }}
              autoComplete="tel-national"
              invalid={Boolean(errorFor('branchPhone'))}
              describedBy={describedBy('branchPhone', true, Boolean(errorFor('branchPhone')))}
            />
          </Field>

          {/*
            Asked under this country's own name for it, and not asked at all
            where there is no single national registration to ask for — see the
            United States in the country table.
          */}
          {taxFormat ? (
            <Input
              name="taxId"
              label={taxFormat.label}
              hint={`Optional — ${taxFormat.hint} You can add it later from settings.`}
              errors={errorFor('taxId')}
              value={taxId}
              onChange={(event) => {
                setTaxId(event.target.value.toUpperCase());
                clearError('taxId');
              }}
              autoCapitalize="characters"
              spellCheck={false}
              className="font-mono"
              placeholder={taxFormat.example}
            />
          ) : null}

          {/*
            Derived, shown, and not asked. Both follow from the country: the
            server derives the currency against the prices the plan actually
            publishes, so an input here could disagree with what checkout
            charges. `aria-live` because both change when the country does, and
            a change nobody announces is a change a screen reader user does not
            get.
          */}
          <div
            aria-live="polite"
            className="border-rule bg-paper text-muted rounded-md border px-4 py-3 text-[0.8125rem] leading-relaxed sm:col-span-2"
          >
            {choosable ? (
              /*
                The one derived value that is still a question. Australia has
                seven zones and the United States seven; picking the first would
                put a Perth clinic's appointment book three hours out. Countries
                with a single zone — every other one in the list — are told, not
                asked.
              */
              /* Unnamed on purpose — submitted by the hidden input at the foot. */
              <Select
                id="timezone"
                label="Time zone"
                hint={`${country?.name ?? 'This country'} has several. Pick the one this clinic operates in.`}
                value={timezone}
                onChange={(event) => setTimezone(event.target.value)}
                options={(country?.timezones ?? []).map((zone) => ({
                  value: zone,
                  label: timezoneLabel(zone),
                }))}
              />
            ) : (
              <p>
                Time zone <span className="text-ink font-mono">{timezoneLabel(timezone)}</span> —
                the only zone in {country?.name ?? 'this country'}. Change it later in settings if
                you need to.
              </p>
            )}
            <p className={choosable ? 'mt-3' : 'mt-1.5'}>
              Billed in <span className="text-ink font-mono">{country?.currency ?? 'INR'}</span>.
              Set from your country — we confirm it against published prices when you subscribe.
            </p>
          </div>
        </div>
      </section>

      <section hidden={step !== 3} aria-label="Your account">
        <h2 className="font-display mb-2 text-2xl">Your account.</h2>
        <p className="text-muted mb-6 text-[0.9375rem] leading-relaxed">
          You will be the owner — full access, and the only one who can add other owners.
        </p>

        <div className="grid gap-5 sm:grid-cols-2">
          <Input
            name="fullName"
            label="Your name"
            errors={errorFor('fullName')}
            fieldClassName="sm:col-span-2"
            defaultValue={state.values?.['fullName'] ?? ''}
            autoComplete="name"
            placeholder="Dr A. Deshpande"
          />

          <Input
            name="email"
            label="Email"
            errors={errorFor('email')}
            defaultValue={state.values?.['email'] ?? ''}
            type="email"
            autoComplete="email"
            placeholder="you@clinic.in"
          />

          {/*
            The same one-control phone field as the clinic's reception number,
            with the calling code selectable — an owner's own mobile is often
            not in the country the clinic bills from.
          */}
          <Field
            name="phone"
            label="Mobile"
            hint="You can sign in with a code sent here."
            errors={errorFor('phone')}
          >
            <PhoneInput
              id="phone"
              name="phone"
              countryCode={ownerPhoneCountry}
              national={ownerPhone}
              onCountryChange={(code) => {
                setOwnerPhoneCountry(code);
                clearError('phone');
              }}
              onNationalChange={(digits) => {
                setOwnerPhone(digits);
                clearError('phone');
              }}
              autoComplete="tel-national"
              invalid={Boolean(errorFor('phone'))}
              describedBy={describedBy('phone', true, Boolean(errorFor('phone')))}
            />
          </Field>

          <Input
            name="password"
            label="Password"
            hint="At least 12 characters, with an uppercase letter and a digit."
            errors={errorFor('password')}
            fieldClassName="sm:col-span-2"
            type="password"
            autoComplete="new-password"
          />
        </div>

        <div className="mt-6 flex items-start gap-3">
          <input
            id="acceptedTerms"
            name="acceptedTerms"
            type="checkbox"
            className="accent-drape mt-0.5 h-5 w-5 shrink-0"
            aria-invalid={Boolean(errorFor('acceptedTerms'))}
            aria-describedby={describedBy(
              'acceptedTerms',
              false,
              Boolean(errorFor('acceptedTerms'))
            )}
          />
          <label htmlFor="acceptedTerms" className="text-ink text-[0.8125rem] leading-relaxed">
            I agree to the{' '}
            <a href="/legal/terms" className="text-drape underline underline-offset-2">
              terms of service
            </a>{' '}
            and the{' '}
            <a href="/legal/privacy" className="text-drape underline underline-offset-2">
              privacy policy
            </a>
            .
          </label>
        </div>
        {errorFor('acceptedTerms')?.[0] ? (
          <FieldError name="acceptedTerms" message={errorFor('acceptedTerms')?.[0] ?? ''} />
        ) : null}

        <p className="text-muted mt-5 text-[0.8125rem] leading-relaxed">
          Your 14-day trial starts now. No card, and nothing renews on its own.
        </p>
      </section>

      {/* Carried on every step so the final submit has them. */}
      <input type="hidden" name="branchCode" value="MAIN" />
      <input type="hidden" name="planCode" value="STARTER" />

      {/*
        ⚠️ EVERY <select> ON THIS FORM SUBMITS THROUGH ONE OF THESE, NOT THROUGH
          ITSELF. The selects above deliberately carry no `name`.

          Same cause as the `values` echo in the action — React 19 resets the
          form after a form action runs — but a different symptom, and a silent
          one. `form.reset()` restores a control to its DEFAULT: for an <input>
          that is the `value` attribute, which React keeps in sync, so text
          fields come back unchanged. For a <select> the default is the
          `selected` ATTRIBUTE on its options, which React never writes — it
          drives selection through the DOM property. So a reset snaps every
          select back to its first option while React state, and therefore
          everything on screen, still shows what the customer chose.

          The result was a clinic that picked Ireland, submitted once, hit any
          validation error, resubmitted, and was registered in India — with the
          time zone it chose, because that one was already a hidden input. The
          form never once displayed the value it sent.

          Hidden inputs are immune: React writes their `value` attribute, so
          resetting one restores the value it already had.
      */}
      <input type="hidden" name="orgType" value={orgType} />
      <input type="hidden" name="countryCode" value={countryCode} />
      <input type="hidden" name="regionCode" value={regionCode} />
      <input type="hidden" name="timezone" value={timezone} />
      {/*
        The region select writes the branch address's `state` too, so this is
        the same choice reaching the two places that need it. For a country with
        no region select the visible text input carries its own name and this
        renders nothing.
      */}
      {regions.length > 0 ? <input type="hidden" name="state" value={regionName} /> : null}

      {state.status === 'error' && state.message ? (
        <p
          role="alert"
          tabIndex={-1}
          className="ring-signal/25 bg-signal-tint text-signal mt-6 rounded-md px-4 py-3 text-[0.8125rem] leading-relaxed ring-1"
        >
          {state.message}
        </p>
      ) : null}

      <div className="mt-7 flex flex-wrap items-center gap-3">
        {step > 0 ? (
          <button
            type="button"
            onClick={() => {
              setLocalErrors({});
              setStep((current) => Math.max(current - 1, 0));
            }}
            className="text-drape hover:text-drape-deep border-rule rounded-md border px-4 py-3 text-[0.9375rem] font-medium transition-colors"
          >
            Back
          </button>
        ) : null}

        {isLast ? (
          <button
            type="submit"
            disabled={pending}
            className="bg-drape text-paper hover:bg-drape-deep inline-flex items-center justify-center rounded-md px-5 py-3 text-[0.9375rem] font-medium transition-colors duration-150 disabled:opacity-60"
          >
            {pending ? 'Creating your clinic…' : 'Create clinic'}
          </button>
        ) : (
          <button
            type="button"
            onClick={advance}
            className="bg-drape text-paper hover:bg-drape-deep inline-flex items-center justify-center rounded-md px-5 py-3 text-[0.9375rem] font-medium transition-colors duration-150"
          >
            Continue
          </button>
        )}
      </div>
    </form>
  );
}

/**
 * Success replaces the form.
 *
 * The clinic is on its own subdomain and the session cookie is host-only, so
 * getting there is a full page navigation to another origin — never the Next
 * router. Rendered as a link as well as an automatic hop, so it still works if
 * the redirect is blocked.
 */
function Registered({ loginUrl, slug }: { loginUrl: string; slug: string }) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    ref.current?.focus();
    const timer = setTimeout(() => window.location.assign(loginUrl), 1500);
    return () => clearTimeout(timer);
  }, [loginUrl]);

  return (
    <div
      ref={ref}
      tabIndex={-1}
      role="status"
      aria-live="polite"
      className="border-drape bg-drape-tint/40 rounded-lg border p-6 sm:p-8"
    >
      <p className="eyebrow text-drape">Clinic created</p>
      <h2 className="font-display mt-3 text-2xl">
        {slug ? `${slug} is yours.` : 'Your clinic is ready.'}
      </h2>
      <p className="text-muted mt-3 text-[0.9375rem] leading-relaxed">
        Taking you to your clinic to sign in. Your 14-day trial has started.
      </p>
      <a
        href={loginUrl}
        className="bg-drape text-paper hover:bg-drape-deep mt-6 inline-flex items-center justify-center rounded-md px-5 py-3 text-[0.9375rem] font-medium transition-colors"
      >
        Go to your clinic
      </a>
    </div>
  );
}
