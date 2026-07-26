'use client';

import { useActionState, useEffect, useRef, useState } from 'react';
import { registerOrganizationRequest } from '@rcln/contracts';
import { checkSlug, registerClinic, type SignupFormState } from '@/app/(marketing)/signup/actions';
import { track } from '@/lib/analytics';
import { cn } from '@/lib/cn';
import { describedBy, Field, inputClass } from '@/components/ui/field';

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
 * The numbered rail is not decoration: registration genuinely is a sequence —
 * the clinic has to exist before it has an address, and the address before
 * there is anyone to own it.
 */

const ROOT_DOMAIN = process.env['NEXT_PUBLIC_ROOT_DOMAIN'] ?? 'lvh.me';

const INITIAL: SignupFormState = { status: 'idle' };

const STEPS = [
  { id: 'clinic', label: 'Clinic' },
  { id: 'address', label: 'Address' },
  { id: 'branch', label: 'First location' },
  { id: 'account', label: 'Your account' },
] as const;

/** Which schema each step's fields belong to, for validating before advancing. */
const shape = registerOrganizationRequest.shape;

type Errors = Record<string, string[]>;

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

export function SignupForm() {
  const [state, action, pending] = useActionState(registerClinic, INITIAL);
  const [step, setStep] = useState(0);
  const [localErrors, setLocalErrors] = useState<Errors>({});

  const [orgType, setOrgType] = useState('CLINIC');
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

  // Server errors take precedence — they are the authoritative answer.
  const errors: Errors = { ...localErrors, ...(state.fieldErrors ?? {}) };
  const errorFor = (name: string): string[] | undefined => errors[name];

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
        .pick({ legalName: true, displayName: true, orgType: true, gstNumber: true })
        .safeParse({ ...values(['legalName', 'displayName', 'gstNumber']), orgType: orgType });
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
        ...values(['branchName', 'addressLine1', 'city', 'state', 'pincode', 'branchPhone']),
        name: values(['branchName'])['branchName'],
        code: 'MAIN',
        ...(values(['branchPhone'])['branchPhone']
          ? { phone: values(['branchPhone'])['branchPhone'] }
          : {}),
      });
      if (!parsed.success) {
        // The form field is `branchName`; the contract calls it `branch.name`.
        next = issuesToErrors(parsed.error.issues, 'branch.');
        if (next['branch.name']) {
          next['branch.branchName'] = next['branch.name'];
        }
      }
    }

    setLocalErrors(next);

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
          <Field
            name="displayName"
            label="Clinic name"
            hint="What patients and your team will see."
            errors={errorFor('organization.displayName')}
          >
            <input
              id="displayName"
              name="displayName"
              autoComplete="organization"
              className={inputClass}
              placeholder="Sunrise Clinic"
              aria-invalid={Boolean(errorFor('organization.displayName'))}
              aria-describedby={describedBy(
                'displayName',
                true,
                Boolean(errorFor('organization.displayName'))
              )}
            />
          </Field>

          <Field
            name="legalName"
            label="Registered name"
            hint="As it appears on your GST registration. It goes on invoices."
            errors={errorFor('organization.legalName')}
          >
            <input
              id="legalName"
              name="legalName"
              className={inputClass}
              placeholder="Sunrise Healthcare Pvt Ltd"
              aria-invalid={Boolean(errorFor('organization.legalName'))}
              aria-describedby={describedBy(
                'legalName',
                true,
                Boolean(errorFor('organization.legalName'))
              )}
            />
          </Field>

          <Field name="orgType" label="What kind of practice?">
            <select
              id="orgType"
              name="orgType"
              value={orgType}
              onChange={(event) => setOrgType(event.target.value)}
              className={inputClass}
            >
              <option value="CLINIC">Clinic</option>
              <option value="HOSPITAL">Hospital</option>
              <option value="CHAIN">Multi-branch group</option>
              <option value="LAB">Diagnostic lab</option>
            </select>
          </Field>

          <Field
            name="gstNumber"
            label="GSTIN"
            hint="Optional. You can add it later from settings."
            errors={errorFor('organization.gstNumber')}
          >
            <input
              id="gstNumber"
              name="gstNumber"
              className={cn(inputClass, 'font-mono uppercase')}
              placeholder="27AAAAA0000A1Z5"
              aria-invalid={Boolean(errorFor('organization.gstNumber'))}
              aria-describedby={describedBy(
                'gstNumber',
                true,
                Boolean(errorFor('organization.gstNumber'))
              )}
            />
          </Field>
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
          errors={errorFor('organization.slug')}
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
              aria-invalid={Boolean(errorFor('organization.slug'))}
              aria-describedby={describedBy('slug', true, Boolean(errorFor('organization.slug')))}
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
      <section hidden={step !== 2} aria-label="First location">
        <h2 className="font-display mb-2 text-2xl">Where do you see patients?</h2>
        <p className="text-muted mb-6 text-[0.9375rem] leading-relaxed">
          Your first location. Add the rest once you are in.
        </p>

        <div className="grid gap-5 sm:grid-cols-2">
          <div className="sm:col-span-2">
            <Field
              name="branchName"
              label="Location name"
              errors={errorFor('branch.branchName') ?? errorFor('branch.name')}
            >
              <input
                id="branchName"
                name="branchName"
                className={inputClass}
                placeholder="Sunrise Clinic, Kothrud"
                aria-invalid={Boolean(errorFor('branch.branchName') ?? errorFor('branch.name'))}
                aria-describedby={describedBy(
                  'branchName',
                  false,
                  Boolean(errorFor('branch.branchName') ?? errorFor('branch.name'))
                )}
              />
            </Field>
          </div>

          <div className="sm:col-span-2">
            <Field
              name="addressLine1"
              label="Street address"
              errors={errorFor('branch.addressLine1')}
            >
              <input
                id="addressLine1"
                name="addressLine1"
                autoComplete="address-line1"
                className={inputClass}
                placeholder="12 Paud Road"
                aria-invalid={Boolean(errorFor('branch.addressLine1'))}
                aria-describedby={describedBy(
                  'addressLine1',
                  false,
                  Boolean(errorFor('branch.addressLine1'))
                )}
              />
            </Field>
          </div>

          <Field name="city" label="City" errors={errorFor('branch.city')}>
            <input
              id="city"
              name="city"
              autoComplete="address-level2"
              className={inputClass}
              placeholder="Pune"
              aria-invalid={Boolean(errorFor('branch.city'))}
              aria-describedby={describedBy('city', false, Boolean(errorFor('branch.city')))}
            />
          </Field>

          <Field name="state" label="State" errors={errorFor('branch.state')}>
            <input
              id="state"
              name="state"
              autoComplete="address-level1"
              className={inputClass}
              placeholder="Maharashtra"
              aria-invalid={Boolean(errorFor('branch.state'))}
              aria-describedby={describedBy('state', false, Boolean(errorFor('branch.state')))}
            />
          </Field>

          <Field name="pincode" label="PIN code" errors={errorFor('branch.pincode')}>
            <input
              id="pincode"
              name="pincode"
              inputMode="numeric"
              autoComplete="postal-code"
              className={cn(inputClass, 'font-mono tabular-nums')}
              placeholder="411038"
              aria-invalid={Boolean(errorFor('branch.pincode'))}
              aria-describedby={describedBy('pincode', false, Boolean(errorFor('branch.pincode')))}
            />
          </Field>

          <Field name="branchPhone" label="Reception phone" errors={errorFor('branch.phone')}>
            <input
              id="branchPhone"
              name="branchPhone"
              type="tel"
              className={cn(inputClass, 'font-mono')}
              placeholder="+912025678900"
              aria-invalid={Boolean(errorFor('branch.phone'))}
              aria-describedby={describedBy(
                'branchPhone',
                false,
                Boolean(errorFor('branch.phone'))
              )}
            />
          </Field>
        </div>
      </section>

      {/* ---------------------------------------------------------------- */}
      <section hidden={step !== 3} aria-label="Your account">
        <h2 className="font-display mb-2 text-2xl">Your account.</h2>
        <p className="text-muted mb-6 text-[0.9375rem] leading-relaxed">
          You will be the owner — full access, and the only one who can add other owners.
        </p>

        <div className="grid gap-5 sm:grid-cols-2">
          <div className="sm:col-span-2">
            <Field name="fullName" label="Your name" errors={errorFor('owner.fullName')}>
              <input
                id="fullName"
                name="fullName"
                autoComplete="name"
                className={inputClass}
                placeholder="Dr A. Deshpande"
                aria-invalid={Boolean(errorFor('owner.fullName'))}
                aria-describedby={describedBy(
                  'fullName',
                  false,
                  Boolean(errorFor('owner.fullName'))
                )}
              />
            </Field>
          </div>

          <Field name="email" label="Email" errors={errorFor('owner.email')}>
            <input
              id="email"
              name="email"
              type="email"
              autoComplete="email"
              className={inputClass}
              placeholder="you@clinic.in"
              aria-invalid={Boolean(errorFor('owner.email'))}
              aria-describedby={describedBy('email', false, Boolean(errorFor('owner.email')))}
            />
          </Field>

          <Field
            name="phone"
            label="Mobile"
            hint="You can sign in with a code sent here."
            errors={errorFor('owner.phone')}
          >
            <input
              id="phone"
              name="phone"
              type="tel"
              autoComplete="tel"
              className={cn(inputClass, 'font-mono')}
              placeholder="+919876543210"
              aria-invalid={Boolean(errorFor('owner.phone'))}
              aria-describedby={describedBy('phone', true, Boolean(errorFor('owner.phone')))}
            />
          </Field>

          <div className="sm:col-span-2">
            <Field
              name="password"
              label="Password"
              hint="At least 12 characters, with an uppercase letter and a digit."
              errors={errorFor('owner.password')}
            >
              <input
                id="password"
                name="password"
                type="password"
                autoComplete="new-password"
                className={inputClass}
                aria-invalid={Boolean(errorFor('owner.password'))}
                aria-describedby={describedBy(
                  'password',
                  true,
                  Boolean(errorFor('owner.password'))
                )}
              />
            </Field>
          </div>
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
        {errorFor('acceptedTerms') ? (
          <p id="acceptedTerms-error" className="text-signal mt-1.5 text-[0.8125rem]">
            {errorFor('acceptedTerms')?.[0]}
          </p>
        ) : null}

        <p className="text-muted mt-5 text-[0.8125rem] leading-relaxed">
          Your 14-day trial starts now. No card, and nothing renews on its own.
        </p>
      </section>

      {/* Carried on every step so the final submit has them. */}
      <input type="hidden" name="branchCode" value="MAIN" />
      <input type="hidden" name="planCode" value="STARTER" />

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
