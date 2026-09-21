'use client';

import { useActionState, useEffect, useMemo, useRef, useState } from 'react';
import { ONBOARDING_STEP_ORDER, type OnboardingState, type OnboardingStep } from '@rcln/contracts';
import { Alert, useOutcomeFocus } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/cn';
import { hardNavigate } from '@/lib/hard-navigate';
import {
  finishSetup,
  saveCareContexts,
  saveIdentity,
  saveLocale,
  saveModules,
  saveStaff,
  saveTax,
  type SetupFormState,
} from '@/app/(tenant)/t/[slug]/(setup)/setup/actions';

/**
 * The wizard's resting state.
 *
 * ⚠️ HERE RATHER THAN BESIDE THE ACTIONS, AND IT IS NOT A STYLE CHOICE. A
 *   'use server' module may export async functions and nothing else — a
 *   constant there fails at MODULE EVALUATION, and Next reports the last export
 *   in the file rather than the one at fault. Every sibling `actions.ts` in this
 *   app carries the same note; this is where the value belongs.
 */
const IDLE: SetupFormState = { status: 'idle' };
import {
  CareContextStep,
  IdentityStep,
  LocaleStep,
  ModuleStep,
  ReviewStep,
  StaffStep,
  TaxStep,
} from './onboarding-steps';

/**
 * The setup wizard.
 *
 * ── THE DIRECTION IS INHERITED, NOT INVENTED ─────────────────────────────────
 * Palette, type scale and spacing come from the tenant screens that already
 * exist — `bg-card`, `text-ink`, `border-rule`, `text-drape`, no raw colours and
 * no new tokens. `apps/web/AGENTS.md` is explicit that a second screen with its
 * own direction is a bug rather than a fresh design.
 *
 * What it DOES spend is the one licence that file grants: boldness belongs in
 * the shell and the onboarding states, and this is both.
 *
 * ── THE SIGNATURE: THE SPINE ─────────────────────────────────────────────────
 * The rail is a single hairline running the height of the seven steps, with a
 * marker on each. A finished step's marker is filled; the step you are on is the
 * one row drawn inverted — `bg-ink text-paper`, the idiom the shell already uses
 * — and everything ahead of you is an outline on the same line. One idea, used
 * seven times, and it encodes something true: setup is a sequence, and the rail
 * is the only place in the product where numbering earns its place.
 *
 * ── ONE QUESTION PER SCREEN ──────────────────────────────────────────────────
 * The form area holds exactly one step. No accordion and no branching: a clinic
 * that can see all seven forms at once will answer them in the wrong order and
 * lose the thread. The rail is what makes the length of the thing legible.
 */
export function OnboardingWizard({
  slug,
  initialState,
}: {
  slug: string;
  initialState: OnboardingState;
}) {
  /*
   * The server hands back the whole wizard state on every save, so the rail
   * advances without a refetch. `initialState` is the server-rendered first
   * paint; after that this is the authority.
   */
  const [state, setState] = useState(initialState);

  const firstIncomplete = useMemo(() => {
    const pending = ONBOARDING_STEP_ORDER.find(
      (step) => !state.steps.find((s) => s.step === step)?.completedAt
    );
    return pending ?? 'REVIEW';
  }, [state.steps]);

  const [current, setCurrent] = useState<OnboardingStep>(firstIncomplete);

  const outcomeRef = useRef<HTMLParagraphElement>(null);

  /*
   * ⚠️ ONE ACTION STATE FOR THE WHOLE WIZARD, NOT ONE PER STEP. Every step
   *   returns the same `SetupFormState` and only one step is mounted at a time,
   *   so seven `useActionState` calls would be seven pending flags of which six
   *   are always false — and the shared one is what lets the "saved" message and
   *   the focus move behave identically on every step.
   */
  const [outcome, submit, pending] = useActionState(
    async (previous: SetupFormState, formData: FormData): Promise<SetupFormState> => {
      const step = formData.get('step') as OnboardingStep;
      const result = await SAVERS[step](slug, previous, formData);

      if (result.state) setState(result.state);

      /*
       * Advance on success, and only on success. A failed save that moved the
       * user forward would hide the error it was trying to show them.
       */
      if (result.status === 'saved') {
        const index = ONBOARDING_STEP_ORDER.indexOf(step);
        const next = ONBOARDING_STEP_ORDER[index + 1];
        if (next) setCurrent(next);
      }

      return result;
    },
    IDLE
  );

  useOutcomeFocus(outcome.status, outcomeRef);

  /*
   * Finishing setup leaves the wizard and lands on the clinic's own home page —
   * which is what the owner expects, and what the `(app)` layout will now let
   * them have: `setupComplete` is true, so it no longer redirects here.
   *
   * ⚠️ A HARD NAVIGATION, NOT `router.push` AND NOT A SERVER-ACTION `redirect`.
   *   `proxy.ts` rewrites by Host, so on a clinic subdomain `/` means
   *   `/t/<slug>` — and that rewrite only runs for real HTTP requests. Both of
   *   the other two resolve `/` against the route tree instead and hand the
   *   owner the public marketing page on their own subdomain. `hardNavigate`
   *   exists for this exact failure; its header records it.
   *
   * ⚠️ AND IT KEYS ON `outcome.finished`, NOT ON `state.completedAt`. The latter
   *   is already true for somebody who re-opened `/setup` to change an answer,
   *   so navigating on it would throw them out of the screen they just asked
   *   for. This fires only for the submission that finished setup.
   */
  useEffect(() => {
    if (outcome.finished) hardNavigate('/');
  }, [outcome.finished]);

  const errorsFor = (field: string): string[] | undefined => outcome.fieldErrors?.[field];

  const stepProps = {
    state,
    pending,
    errorsFor,
    onBack: (step: OnboardingStep) => {
      setCurrent(step);
    },
  };

  return (
    <div className="mx-auto grid max-w-5xl gap-10 lg:grid-cols-[15rem_1fr] lg:gap-16">
      <Rail
        steps={state.steps}
        current={current}
        completedAt={state.completedAt}
        onPick={setCurrent}
      />

      {outcome.finished ? (
        <div className="min-w-0">
          <p className="text-muted text-[0.8125rem] tracking-[0.08em] uppercase">Setup</p>
          <h1 className="text-ink mt-1 text-2xl font-medium">You&rsquo;re all set</h1>
          <p role="status" className="text-drape mt-2 max-w-prose text-[0.9375rem]">
            Taking you to your clinic now.
          </p>
          {/*
           * ⚠️ A PLAIN <a>, AND IT IS NOT DECORATION. Without JavaScript the
           *   effect above never runs — but the setup is saved either way, so a
           *   real document load finishes the job and goes through `proxy.ts`
           *   exactly as the scripted path does. `<Link>` is what the lint rule
           *   wants and is wrong here for that reason. Same call
           *   `JoinedRedirect` and `ContinueLink` make.
           */}
          <p className="mt-6 text-[0.875rem]">
            {/* eslint-disable-next-line @next/next/no-html-link-for-pages */}
            <a href="/" className="text-drape hover:text-drape-deep underline underline-offset-2">
              Go to your clinic
            </a>
          </p>
        </div>
      ) : (
        <form action={submit} className="min-w-0">
          <input type="hidden" name="step" value={current} />

          <header className="mb-8">
            <p className="text-muted text-[0.8125rem] tracking-[0.08em] uppercase">
              Step {String(ONBOARDING_STEP_ORDER.indexOf(current) + 1)} of 7
            </p>
            <h1 className="text-ink mt-1 text-2xl font-medium">{STEP_TITLE[current]}</h1>
            <p className="text-drape mt-2 max-w-prose text-[0.9375rem]">{STEP_BLURB[current]}</p>
          </header>

          {outcome.status === 'error' && outcome.message ? (
            <Alert tone="error" className="mb-6">
              <span ref={outcomeRef} tabIndex={-1}>
                {outcome.message}
              </span>
            </Alert>
          ) : null}

          {current === 'IDENTITY' ? <IdentityStep {...stepProps} /> : null}
          {current === 'CARE_CONTEXTS' ? <CareContextStep {...stepProps} /> : null}
          {current === 'MODULES' ? <ModuleStep {...stepProps} /> : null}
          {current === 'LOCALE_HOURS' ? <LocaleStep {...stepProps} /> : null}
          {current === 'TAX_BILLING' ? <TaxStep {...stepProps} /> : null}
          {current === 'STAFF' ? <StaffStep {...stepProps} /> : null}
          {current === 'REVIEW' ? <ReviewStep {...stepProps} slug={slug} /> : null}

          <Footer
            current={current}
            pending={pending}
            onBack={() => {
              const index = ONBOARDING_STEP_ORDER.indexOf(current);
              const previous = ONBOARDING_STEP_ORDER[index - 1];
              if (previous) setCurrent(previous);
            }}
          />
        </form>
      )}
    </div>
  );
}

const SAVERS: Record<
  OnboardingStep,
  (slug: string, previous: SetupFormState, formData: FormData) => Promise<SetupFormState>
> = {
  IDENTITY: saveIdentity,
  CARE_CONTEXTS: saveCareContexts,
  MODULES: saveModules,
  LOCALE_HOURS: saveLocale,
  TAX_BILLING: saveTax,
  STAFF: saveStaff,
  REVIEW: (slug, previous) => finishSetup(slug, previous),
};

/**
 * The steps in the clinic's words, not the schema's.
 *
 * The same instinct as "Stock" over "Inventory" in the nav: somebody setting up
 * a practice is not looking for `CARE_CONTEXTS`, they are answering "who do you
 * treat".
 */
const STEP_TITLE: Record<OnboardingStep, string> = {
  IDENTITY: 'Who you are',
  CARE_CONTEXTS: 'Who you treat',
  MODULES: 'What you run',
  LOCALE_HOURS: "When you're open",
  TAX_BILLING: 'How you bill',
  STAFF: 'Who works here',
  REVIEW: 'Check and finish',
};

const STEP_BLURB: Record<OnboardingStep, string> = {
  IDENTITY: 'The name over the door and the name on the paperwork. They can differ.',
  CARE_CONTEXTS:
    'This decides what a new patient record starts as — and whether your front desk is asked at all.',
  MODULES: 'Only what you pick appears in the menu. You can change this later.',
  LOCALE_HOURS: 'Set this per site. A group with two branches answers it twice.',
  TAX_BILLING: 'What goes on the bills you raise. Skip anything you do not have yet.',
  STAFF: 'Send invitations now, or add people later from Staff.',
  REVIEW: 'What we set up for you, and where to change any of it.',
};

const SHORT_TITLE: Record<OnboardingStep, string> = {
  IDENTITY: 'Who you are',
  CARE_CONTEXTS: 'Who you treat',
  MODULES: 'What you run',
  LOCALE_HOURS: 'Opening hours',
  TAX_BILLING: 'Billing',
  STAFF: 'Your team',
  REVIEW: 'Finish',
};

/**
 * The spine.
 *
 * ⚠️ A LIST OF BUTTONS, NOT LINKS. The wizard is one form and one client
 *   component; a step is a state, not a URL. Routing per step would put the
 *   half-typed contents of the current form at the mercy of a navigation.
 *
 * Every step is reachable at any time. A clinic that wants to change its care
 * contexts after finishing should not have to walk through billing again, and a
 * rail that only moves forwards is a rail people fight.
 */
function Rail({
  steps,
  current,
  completedAt,
  onPick,
}: {
  steps: OnboardingState['steps'];
  current: OnboardingStep;
  completedAt: string | null;
  onPick: (step: OnboardingStep) => void;
}) {
  return (
    <nav aria-label="Setup steps" className="lg:sticky lg:top-8 lg:self-start">
      <p className="text-muted mb-4 text-[0.8125rem] tracking-[0.08em] uppercase">Setup</p>

      {/* The hairline the markers sit on. `left-[0.4375rem]` centres it under a
          14px marker; the list's padding clears it. */}
      <ol className="border-rule relative space-y-1 border-l pl-0">
        {steps.map((step) => {
          const done = step.completedAt !== null;
          const active = step.step === current;

          return (
            <li key={step.step} className="relative">
              <button
                type="button"
                onClick={() => {
                  onPick(step.step);
                }}
                aria-current={active ? 'step' : undefined}
                className={cn(
                  'flex w-full items-center gap-3 rounded-r py-2 pr-3 pl-4 text-left text-[0.9375rem] transition-colors',
                  active
                    ? 'bg-ink text-paper'
                    : 'text-drape hover:bg-drape-tint/40 focus-visible:bg-drape-tint/40'
                )}
              >
                <span
                  aria-hidden
                  className={cn(
                    'ring-rule -ml-[1.375rem] size-3.5 shrink-0 rounded-full ring-1',
                    done ? 'bg-drape ring-drape' : active ? 'bg-paper ring-paper' : 'bg-paper'
                  )}
                />
                <span className="truncate">{SHORT_TITLE[step.step]}</span>
                {/* The state is already carried by the marker's fill; this is
                    the non-visual half of it (WCAG 1.4.1). */}
                <span className="sr-only">{done ? ' — done' : ' — not done yet'}</span>
              </button>
            </li>
          );
        })}
      </ol>

      {completedAt ? (
        <p className="text-muted mt-5 text-[0.8125rem]">
          Setup finished. Changing anything here updates it.
        </p>
      ) : null}
    </nav>
  );
}

function Footer({
  current,
  pending,
  onBack,
}: {
  current: OnboardingStep;
  pending: boolean;
  onBack: () => void;
}) {
  const isFirst = current === 'IDENTITY';
  const isLast = current === 'REVIEW';

  return (
    <div className="border-rule mt-10 flex items-center gap-3 border-t pt-6">
      <Button type="submit" disabled={pending}>
        {pending ? 'Saving…' : isLast ? 'Finish setup' : 'Save and continue'}
      </Button>
      {isFirst ? null : (
        <Button type="button" variant="ghost" onClick={onBack} disabled={pending}>
          Back
        </Button>
      )}
    </div>
  );
}
