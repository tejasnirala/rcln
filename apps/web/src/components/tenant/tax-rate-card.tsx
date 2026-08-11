'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import type {
  ClinicTaxRegistrationSummary,
  ClinicTaxRuleSummary,
  TaxCategoryCard,
  TaxRateCardResponse,
} from '@rcln/contracts';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Input, Select } from '@/components/ui/field';
import { RecordHistory } from '@/components/tenant/record-history';
import { cn } from '@/lib/cn';
import {
  addRegistration,
  addRule,
  endRegistration,
  endRule,
  setRegistrationBranches,
  type TaxFormState,
} from '@/app/(tenant)/t/[slug]/(app)/taxes/actions';

/**
 * What this clinic charges.
 *
 * ⚠️ INHERITED AND OVERRIDDEN ROWS SIDE BY SIDE, BECAUSE A CLINIC WITH NO RULES OF
 *   ITS OWN IS FULLY CONFIGURED. rcln maintains a rate card per country and the
 *   engine READS it when it prices rather than copying it at signup — so a screen
 *   built on the clinic's own rows would show an empty page to a clinic charging
 *   tax on every bill. Every category here says where its rates came from.
 *
 * ⚠️ AND AN OVERRIDE TAKES THE WHOLE CATEGORY. Writing one rule for a category
 *   stops rcln's rows for it applying at all — not merging with them — which is
 *   why the form says so before it is submitted and why a `TENANT` category shows
 *   what it displaced. "We charge 18% where rcln says exempt" is either a clinic
 *   that knows its own mix of work or somebody who has just put GST on medical
 *   care, and both need to be visible.
 *
 * Quiet and conventional (apps/web/AGENTS.md): this is a configuration table an
 * accountant reads carefully, not a place to spend boldness. The one thing it does
 * insist on is stating the consequence of each control in words.
 */
export function TaxRateCard({
  slug,
  card,
  rules,
  showHistory,
  canManage,
  canReadHistory,
}: {
  slug: string;
  card: TaxRateCardResponse;
  rules: ClinicTaxRuleSummary[];
  /** Whether ended rules are listed. Nothing to do with `canReadHistory`. */
  showHistory: boolean;
  canManage: boolean;
  /**
   * `audit.record.read` — who changed a rate, and when.
   *
   * ⚠️ A DIFFERENT QUESTION FROM `showHistory`, WHICH IS ABOUT DATES ON THE
   *   RULE ITSELF. An ended rule says what was charged until when; the audit
   *   trail says who ended it. Both are needed to explain a bill, and only the
   *   second is a permission.
   */
  canReadHistory: boolean;
}) {
  const router = useRouter();
  const [state, setState] = useState<TaxFormState>({ status: 'idle' });
  const [pending, startTransition] = useTransition();
  const [adding, setAdding] = useState<'none' | 'registration' | 'rule'>('none');

  const live = card.registrations.filter((row) => row.isLive);

  function run(action: () => Promise<TaxFormState>): void {
    startTransition(async () => {
      const outcome = await action();
      setState(outcome);
      if (outcome.status === 'done') setAdding('none');
    });
  }

  return (
    <div className="space-y-10">
      <header>
        <h1 className="text-title font-display text-ink">Tax</h1>
        <p className="text-muted mt-2 max-w-prose text-sm">
          The registrations this clinic holds, and what it charges for each kind of item. These
          decide what every patient is billed and what the clinic owes — they are not display
          settings.
        </p>
      </header>

      {state.status === 'error' && state.message ? (
        <Alert tone="error">{state.message}</Alert>
      ) : null}

      {/*
       * ⚠️ THE REGISTRATIONS COME FIRST BECAUSE THEY DECIDE WHETHER ANY RATE
       *   APPLIES AT ALL. A clinic holding none charges no tax whatever its rules
       *   say, and the rate card below is then an answer to a question nobody is
       *   asking. Putting the rules first would invite a clinic to set rates and
       *   wonder why no invoice carries them.
       */}
      <section aria-labelledby="registrations-heading" className="space-y-4">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <h2 id="registrations-heading" className="text-ink font-display text-lg">
              Registrations
            </h2>
            <p className="text-muted mt-1 max-w-prose text-sm">
              The number this clinic is registered under, printed on every invoice it covers.
            </p>
          </div>
          {canManage && adding !== 'registration' ? (
            <Button variant="secondary" size="sm" onClick={() => setAdding('registration')}>
              Add a registration
            </Button>
          ) : null}
        </div>

        {card.registrations.length === 0 ? (
          <Alert tone="info">
            {/*
             * ⚠️ NOT AN ERROR AND NOT AN INCOMPLETE SETUP. A clinic below the
             *   registration threshold issues invoices with no tax, and the
             *   engine says NOT_REGISTERED rather than charging zero — which is a
             *   different and honest thing to print on a bill.
             */}
            This clinic holds no tax registration, so its invoices carry no tax and say so. That is
            correct for a practice below the registration threshold. Add one when the clinic
            registers.
          </Alert>
        ) : (
          <ul className="space-y-3">
            {card.registrations.map((registration) => (
              <li key={registration.id}>
                <RegistrationRow
                  slug={slug}
                  registration={registration}
                  branches={card.branches}
                  canManage={canManage}
                  pending={pending}
                  onSetBranches={(branchIds) =>
                    run(() => setRegistrationBranches(slug, registration.id, branchIds))
                  }
                  onEnd={(effectiveTo) =>
                    run(() => endRegistration(slug, registration.id, effectiveTo))
                  }
                  canReadHistory={canReadHistory}
                />
              </li>
            ))}
          </ul>
        )}

        {adding === 'registration' ? (
          <RegistrationForm
            countryCode={card.countryCode}
            pending={pending}
            fieldErrors={state.fieldErrors}
            onCancel={() => setAdding('none')}
            onSubmit={(input) => run(() => addRegistration(slug, input))}
          />
        ) : null}
      </section>

      <section aria-labelledby="rates-heading" className="space-y-4">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <h2 id="rates-heading" className="text-ink font-display text-lg">
              Rates
            </h2>
            <p className="text-muted mt-1 max-w-prose text-sm">
              What each kind of item is charged in {card.countryCode}. rcln keeps a rate card per
              country; anything this clinic has not set is taken from it.
            </p>
          </div>
          {canManage && adding !== 'rule' ? (
            <Button variant="secondary" size="sm" onClick={() => setAdding('rule')}>
              Set our own rate
            </Button>
          ) : null}
        </div>

        {card.unratedCategories.length > 0 ? (
          <Alert tone="error">
            {/*
             * ⚠️ THE ONLY PART OF THIS SCREEN THAT IS ABOUT A PROBLEM, AND IT IS
             *   SPECIFIC RATHER THAN A GENERAL WARNING. These categories are on
             *   open drafts and have no rate anywhere, so those bills cannot be
             *   issued — and without this the clinic finds out at the counter.
             */}
            <p className="font-medium">Some open bills cannot be issued.</p>
            <p className="mt-1">
              These categories are on drafts and have no rate set anywhere:{' '}
              <span className="font-mono">{card.unratedCategories.join(', ')}</span>. Set a rate for
              each, or change the lines to a category that has one.
            </p>
          </Alert>
        ) : null}

        <ul className="space-y-3">
          {card.categories.map((category) => (
            <li key={category.taxCategory}>
              <CategoryRow category={category} />
            </li>
          ))}
        </ul>

        {adding === 'rule' ? (
          <RuleForm
            countryCode={card.countryCode}
            scheme={live[0]?.scheme ?? 'GST'}
            pending={pending}
            fieldErrors={state.fieldErrors}
            onCancel={() => setAdding('none')}
            onSubmit={(input) => run(() => addRule(slug, input))}
          />
        ) : null}
      </section>

      <section aria-labelledby="ours-heading" className="space-y-4">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <h2 id="ours-heading" className="text-ink font-display text-lg">
              Rates this clinic set
            </h2>
            <p className="text-muted mt-1 max-w-prose text-sm">
              A rate that changes is a new rate from a new date, not an edit — so the old one stays
              here as the explanation of the invoices it priced.
            </p>
          </div>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => router.push(showHistory ? '/taxes' : '/taxes?history=true')}
          >
            {showHistory ? 'Hide ended rates' : 'Show ended rates'}
          </Button>
        </div>

        {rules.length === 0 ? (
          <p className="text-muted text-sm">
            This clinic has set none of its own, so every rate above is rcln&rsquo;s.
          </p>
        ) : (
          <ul className="space-y-3">
            {rules.map((rule) => (
              <li key={rule.id}>
                <OwnRuleRow
                  slug={slug}
                  rule={rule}
                  canManage={canManage}
                  canReadHistory={canReadHistory}
                  pending={pending}
                  onEnd={(effectiveTo) => run(() => endRule(slug, rule.id, effectiveTo))}
                />
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

/** The state in the words a clinic uses, never the tint alone (WCAG 1.4.1). */
const STATUS_WORDS: Record<ClinicTaxRegistrationSummary['status'], string> = {
  ACTIVE: 'in force',
  SCHEDULED: 'not started yet',
  LAPSED: 'ended',
};

function RegistrationRow({
  slug,
  registration,
  branches,
  canManage,
  canReadHistory,
  pending,
  onSetBranches,
  onEnd,
}: {
  slug: string;
  registration: ClinicTaxRegistrationSummary;
  branches: TaxRateCardResponse['branches'];
  canManage: boolean;
  canReadHistory: boolean;
  pending: boolean;
  onSetBranches: (branchIds: string[]) => void;
  onEnd: (effectiveTo: string) => void;
}) {
  const [editingCoverage, setEditingCoverage] = useState(false);
  const [ending, setEnding] = useState(false);
  const [effectiveTo, setEffectiveTo] = useState('');

  return (
    <div className="border-rule bg-card rounded-lg border p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <p className="text-ink font-mono">{registration.registrationNumber}</p>
        <div className="flex items-baseline gap-3">
          <p className="text-muted text-sm">
            {registration.scheme} · {registration.placeOfSupply} ·{' '}
            {STATUS_WORDS[registration.status]}
          </p>
          {/*
           * ⚠️ A REGISTRATION IS THE ONE THING ON THIS SCREEN THAT MAY BE
           *   EDITED IN PLACE, WHICH IS WHY ITS TRAIL MATTERS MOST. A corrected
           *   GSTIN leaves no other record of what it used to be — the number
           *   is snapshotted onto invoices already issued, so the row and the
           *   documents legitimately disagree afterwards, and this is where
           *   that disagreement is explained.
           */}
          {canReadHistory ? (
            <RecordHistory
              slug={slug}
              entityType="issuer_tax_registration"
              entityId={registration.id}
              label={registration.registrationNumber}
            />
          ) : null}
        </div>
      </div>
      {registration.legalName === null ? null : (
        <p className="text-muted mt-1 text-sm">Held in the name {registration.legalName}</p>
      )}
      <p className="text-muted mt-1 text-sm">
        From {registration.effectiveFrom}
        {registration.effectiveTo === null ? '' : ` until ${registration.effectiveTo}`}
      </p>
      {/*
       * ⚠️ COVERAGE IS THE ANSWER TO A DIFFERENT QUESTION FROM THE ROW ABOVE, AND
       *   THE COMMONEST PLACE THIS SCREEN IS GOT WRONG.
       *
       *   The row says what the clinic is registered as. This says which of its
       *   places bill under it — one registration may cover every branch, each
       *   branch may have its own, or two may share one while a third uses
       *   another. None of that follows from an address.
       *
       *   Until somebody states it, the branches shown are the ones whose place
       *   of supply matches, which is how the engine picks. An empty list under
       *   that reading is the silent failure: invoices issue with no tax and no
       *   error, because "this clinic holds no registration here" is a legitimate
       *   answer nothing can tell apart from a typo in a region code.
       */}
      <div className="border-rule mt-3 border-t pt-3">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          {registration.coveredBranches.length === 0 ? (
            <p className="text-signal text-sm">
              This covers none of the clinic&rsquo;s branches, so no invoice will be issued under
              it. Assign the branches that bill under it, or check the region against where they
              actually are.
            </p>
          ) : (
            <p className="text-muted text-sm">
              Covers {registration.coveredBranches.map((branch) => branch.name).join(', ')}
              {registration.coverageMode === 'JURISDICTION' ? (
                <span className="text-muted">
                  {' '}
                  — matched by place of supply, because no branches have been assigned
                </span>
              ) : null}
            </p>
          )}

          {canManage ? (
            <Button variant="ghost" size="sm" onClick={() => setEditingCoverage((open) => !open)}>
              {editingCoverage ? 'Cancel' : 'Choose branches'}
            </Button>
          ) : null}
        </div>

        {editingCoverage ? (
          <CoverageEditor
            registration={registration}
            branches={branches}
            pending={pending}
            onSave={(branchIds) => {
              onSetBranches(branchIds);
              setEditingCoverage(false);
            }}
          />
        ) : null}
      </div>

      {/*
        ⚠️ LAPSING IS THE ONLY WAY OUT, AND THERE IS NO DELETE ANYWHERE NEAR IT.
          The row is the account of every invoice issued under this number — a
          bill raised next April for a consultation given last March cites what
          was in force in March, found by date. So a registration that has ended
          gets an end date and stays; nothing removes it.

          Offered only while it is still in force. An ended registration has
          nothing to end, and a scheduled one is corrected by changing its start
          rather than by closing it before it opens.
      */}
      {canManage && registration.status === 'ACTIVE' ? (
        ending ? (
          <div className="border-rule mt-3 space-y-3 rounded-md border p-3">
            <Input
              name={`registrationEffectiveTo-${registration.id}`}
              label="In force up to and including"
              type="date"
              hint="The registration stays on the record. Invoices already issued under it are unaffected — they printed the number at the time."
              value={effectiveTo}
              onChange={(event) => setEffectiveTo(event.target.value)}
            />
            <div className="flex flex-wrap gap-2">
              <Button
                variant="danger"
                size="sm"
                disabled={pending || effectiveTo === ''}
                onClick={() => {
                  onEnd(effectiveTo);
                  setEnding(false);
                }}
              >
                {pending ? 'Ending…' : 'End this registration'}
              </Button>
              <Button variant="ghost" size="sm" disabled={pending} onClick={() => setEnding(false)}>
                Keep it in force
              </Button>
            </div>
            <p className="text-muted text-sm">
              Recording the number that replaces it is a separate, deliberate step: add a
              registration starting the day after. Both rows then sit here, one ended and one in
              force.
            </p>
          </div>
        ) : (
          <div className="mt-3">
            <Button variant="ghost" size="sm" onClick={() => setEnding(true)}>
              End this registration
            </Button>
          </div>
        )
      ) : null}
    </div>
  );
}

/**
 * Which branches bill under this registration.
 *
 * ⚠️ THE TICKS ARE WHAT SOMEBODY HAS STATED, NEVER WHAT THE SYSTEM INFERRED, AND
 *   THE DIFFERENCE IS THE WHOLE REASON THIS CONTROL IS CONFUSING TO GET WRONG.
 *
 *   This editor first seeded itself from the registration's EFFECTIVE coverage —
 *   what applies today, stated or matched. On a registration nobody had assigned,
 *   that opened with every jurisdiction-matched branch already ticked, which read
 *   as "these are your choices, edit them". They were not choices; they were a
 *   derivation. Unticking them all then sent an empty list, the server had no
 *   links to remove, and the screen came back saying exactly what it said before —
 *   a control that appeared to do nothing.
 *
 *   So an unstated registration opens with NOTHING ticked, and the branches it
 *   currently reaches by place of supply say so beside their name. Ticking is then
 *   the act of stating, and it always changes something.
 *
 * ⚠️ A REPLACE, NOT A PATCH: what is ticked when Save is pressed becomes the whole
 *   coverage, and unticking everything is a legitimate instruction that returns
 *   this registration to matching by place of supply. Said out loud below the
 *   list, because "save" over a set of checkboxes is otherwise ambiguous about
 *   what happens to the ones left unticked.
 */
function CoverageEditor({
  registration,
  branches,
  pending,
  onSave,
}: {
  registration: ClinicTaxRegistrationSummary;
  branches: TaxRateCardResponse['branches'];
  pending: boolean;
  onSave: (branchIds: string[]) => void;
}) {
  const [selected, setSelected] = useState<string[]>(
    /*
     * Stated coverage only. Under JURISDICTION nothing has been stated, so the
     * list starts empty however many branches the registration currently reaches.
     */
    registration.coverageMode === 'EXPLICIT'
      ? registration.coveredBranches.map((branch) => branch.id)
      : []
  );

  const toggle = (id: string): void =>
    setSelected((current) =>
      current.includes(id) ? current.filter((value) => value !== id) : [...current, id]
    );

  /*
   * Would this branch be reached by place of supply, if nobody stated anything?
   * The same rule the engine uses: a registration with no region covers its whole
   * country, one with a region covers only that region. `placeOfSupply` is
   * `IN-KA` or `IN`, on both sides, so it compares directly.
   */
  const matchedByPlace = (place: string): boolean =>
    registration.regionCode === null
      ? place.split('-')[0] === registration.countryCode
      : place === registration.placeOfSupply;

  const fallbackNames = branches.filter((b) => matchedByPlace(b.placeOfSupply)).map((b) => b.name);

  if (branches.length === 0) {
    return (
      <p className="text-muted mt-3 text-sm">
        This clinic has no branches yet, so there is nothing to assign.
      </p>
    );
  }

  return (
    <div className="mt-3">
      <ul className="grid gap-1.5">
        {branches.map((branch) => (
          <li key={branch.id}>
            {/* The label wraps the box — see apps/web/AGENTS.md on checkboxes. */}
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                className="accent-drape h-4 w-4"
                checked={selected.includes(branch.id)}
                onChange={() => toggle(branch.id)}
              />
              <span className="text-ink">{branch.name}</span>
              <span className="text-muted font-mono text-xs">{branch.placeOfSupply}</span>
              {/*
                Only meaningful while nothing is ticked — once the clinic states a
                set, place of supply stops deciding anything for this registration.
              */}
              {selected.length === 0 && matchedByPlace(branch.placeOfSupply) ? (
                <span className="text-muted text-xs">matches by place of supply</span>
              ) : null}
            </label>
          </li>
        ))}
      </ul>

      <p className="text-muted mt-2 text-sm">
        {selected.length === 0
          ? fallbackNames.length === 0
            ? 'With none ticked, this registration keeps matching by place of supply — which today matches no branch, so it covers nothing.'
            : `With none ticked, this registration keeps matching by place of supply — today that is ${fallbackNames.join(', ')}.`
          : 'Only the ticked branches will bill under this registration, whatever their place of supply says.'}
      </p>

      <Button
        size="sm"
        className="mt-3"
        /*
         * Nothing stated and nothing ticked is the one combination that would ask
         * the server to remove links it never had. Refusing the press is kinder
         * than a spinner followed by an unchanged screen.
         */
        disabled={
          pending || (selected.length === 0 && registration.coverageMode === 'JURISDICTION')
        }
        onClick={() => onSave(selected)}
      >
        {pending ? 'Saving…' : 'Save coverage'}
      </Button>
    </div>
  );
}

/** One category, and where its rates came from. */
function CategoryRow({ category }: { category: TaxCategoryCard }) {
  const ours = category.source === 'TENANT';

  return (
    <div className="border-rule bg-card rounded-lg border p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <p className="text-ink font-mono">{category.taxCategory}</p>
        <span
          className={cn(
            'rounded-sm border px-2 py-0.5 text-xs font-medium',
            ours ? 'border-drape/30 bg-drape-tint text-drape' : 'border-rule bg-paper text-muted'
          )}
        >
          {/* The word, never the tint alone (WCAG 1.4.1). */}
          {ours ? 'This clinic’s rate' : 'From rcln'}
        </span>
      </div>

      {category.applied.length === 0 ? (
        <p className="text-signal mt-2 text-sm">
          No rate applies today. A line in this category is charged nothing and the bill cannot be
          issued.
        </p>
      ) : (
        <ul className="mt-2 space-y-1">
          {category.applied.map((rule) => (
            <li key={rule.id} className="text-ink text-sm">
              <RateWords rule={rule} />
            </li>
          ))}
        </ul>
      )}

      {category.overriding.length > 0 ? (
        <p className="text-muted mt-2 text-sm">
          {/*
           * The most useful sentence this screen produces. Either the clinic is
           * right and the catalogue is stale, or somebody typed a rate they should
           * not have — and neither is discoverable from the clinic's own row.
           */}
          rcln&rsquo;s rate for this would be{' '}
          {category.overriding
            .map((rule) => <RateWords key={rule.id} rule={rule} />)
            .map((node, index) => (
              <span key={index}>
                {index > 0 ? ' and ' : ''}
                {node}
              </span>
            ))}
          .
        </p>
      ) : null}
    </div>
  );
}

/**
 * A rate, in words.
 *
 * ⚠️ EXEMPT AND ZERO-RATED ARE BOTH "NO TAX" AND THEY ARE NOT THE SAME THING. An
 *   exempt supply carries no input credit and is reported differently from a
 *   zero-rated one, which does appear on a return. Printing both as "0%" would
 *   misstate a return in whichever direction the clinic is in.
 */
function RateWords({ rule }: { rule: ClinicTaxRuleSummary }) {
  if (rule.treatment === 'EXEMPT') return <>Exempt — no tax, and no input credit</>;
  if (rule.treatment === 'ZERO_RATED') return <>Zero-rated — no tax, but it appears on a return</>;

  return (
    <>
      <span className="font-mono">{rule.rateBps / 100}%</span> {rule.lineName}
      {rule.split === 'INTRA_STATE_HALVES' ? ', split in half within the state' : ''}
      {rule.stacks ? ', charged in addition to the national rate' : ''}
    </>
  );
}

function OwnRuleRow({
  slug,
  rule,
  canManage,
  canReadHistory,
  pending,
  onEnd,
}: {
  slug: string;
  rule: ClinicTaxRuleSummary;
  canManage: boolean;
  canReadHistory: boolean;
  pending: boolean;
  onEnd: (effectiveTo: string) => void;
}) {
  const [ending, setEnding] = useState(false);
  const [effectiveTo, setEffectiveTo] = useState('');

  return (
    <div className="border-rule bg-card rounded-lg border p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <p className="text-ink font-mono">{rule.taxCategory}</p>
        <div className="flex items-baseline gap-3">
          <p className="text-muted text-sm">
            {rule.jurisdiction} · from {rule.effectiveFrom}
            {rule.effectiveTo === null ? '' : ` to ${rule.effectiveTo}`} ·{' '}
            {rule.isLive ? 'in force' : 'ended'}
          </p>
          {canReadHistory ? (
            <RecordHistory
              slug={slug}
              entityType="tax_rule"
              entityId={rule.id}
              label={rule.taxCategory}
            />
          ) : null}
        </div>
      </div>
      <p className="text-ink mt-1 text-sm">
        <RateWords rule={rule} />
      </p>
      {rule.description === null ? null : (
        <p className="text-muted mt-1 text-sm">{rule.description}</p>
      )}
      {rule.usedOnIssuedInvoices ? (
        <p className="text-muted mt-2 text-sm">
          {/*
           * ⚠️ SAID BEFORE THE API REFUSES, WHICH IS THE DIFFERENCE BETWEEN AN
           *   EXPLANATION AND A 409. Invoices have been issued under this rule, so
           *   its rate is fixed — the rule is the account of what those documents
           *   charged, and their totals are frozen at the database.
           */}
          Invoices have been issued under this rate, so it cannot be changed. Give it an end date
          and set the new rate from the day after.
        </p>
      ) : null}

      {canManage && rule.isLive ? (
        ending ? (
          <div className="border-rule mt-3 space-y-3 rounded-md border p-3">
            <Input
              name={`effectiveTo-${rule.id}`}
              label="Charge it up to and including"
              type="date"
              hint="The rule stays on the record. What applies afterwards is rcln’s rate for this category, or nothing if it keeps none."
              value={effectiveTo}
              onChange={(event) => setEffectiveTo(event.target.value)}
            />
            <div className="flex flex-wrap gap-2">
              <Button
                variant="danger"
                size="sm"
                disabled={pending || effectiveTo === ''}
                onClick={() => onEnd(effectiveTo)}
              >
                {pending ? 'Ending…' : 'End this rate'}
              </Button>
              <Button variant="ghost" size="sm" disabled={pending} onClick={() => setEnding(false)}>
                Keep charging it
              </Button>
            </div>
          </div>
        ) : (
          <div className="mt-3">
            <Button variant="ghost" size="sm" onClick={() => setEnding(true)}>
              End this rate
            </Button>
          </div>
        )
      ) : null}
    </div>
  );
}

const SCHEMES = [
  { value: 'GST', label: 'GST' },
  { value: 'VAT', label: 'VAT' },
  { value: 'SALES_TAX', label: 'Sales tax' },
];

function RegistrationForm({
  countryCode,
  pending,
  fieldErrors,
  onCancel,
  onSubmit,
}: {
  countryCode: string;
  pending: boolean;
  fieldErrors?: Record<string, string[]> | undefined;
  onCancel: () => void;
  onSubmit: (input: {
    countryCode: string;
    regionCode?: string;
    scheme: string;
    registrationNumber: string;
    legalName?: string;
    effectiveFrom: string;
  }) => void;
}) {
  const [form, setForm] = useState({
    countryCode,
    regionCode: '',
    scheme: 'GST',
    registrationNumber: '',
    legalName: '',
    effectiveFrom: '',
  });

  const err = (name: string): string[] | undefined => fieldErrors?.[name];

  return (
    <form
      className="border-rule bg-card space-y-4 rounded-lg border p-5"
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit({
          countryCode: form.countryCode,
          ...(form.regionCode === '' ? {} : { regionCode: form.regionCode }),
          scheme: form.scheme,
          registrationNumber: form.registrationNumber,
          ...(form.legalName === '' ? {} : { legalName: form.legalName }),
          effectiveFrom: form.effectiveFrom,
        });
      }}
    >
      <h3 className="text-ink font-display text-base">Add a registration</h3>
      <p className="text-muted -mt-2 max-w-prose text-sm">
        From the day it takes effect, every invoice it covers carries tax. There is no separate step
        to switch it on.
      </p>
      <div className="grid gap-4 sm:grid-cols-2">
        <Input
          name="countryCode"
          label="Country"
          required
          hint="Two letters, like IN."
          className="font-mono uppercase"
          value={form.countryCode}
          onChange={(event) => setForm({ ...form, countryCode: event.target.value })}
          errors={err('countryCode')}
        />
        <Input
          name="regionCode"
          label="State or region"
          /*
           * ⚠️ WITHOUT THE COUNTRY PREFIX — `KA`, not `IN-KA`. And empty means the
           *   whole country, which is how most VAT regimes work and is not how GST
           *   does: a GSTIN is per state.
           */
          hint="Without the country — KA, not IN-KA. Leave empty for a country-wide registration."
          className="font-mono uppercase"
          value={form.regionCode}
          onChange={(event) => setForm({ ...form, regionCode: event.target.value })}
          errors={err('regionCode')}
        />
        <Select
          name="scheme"
          label="Scheme"
          value={form.scheme}
          onChange={(event) => setForm({ ...form, scheme: event.target.value })}
          options={SCHEMES}
        />
        <Input
          name="registrationNumber"
          label="Registration number"
          required
          hint="Printed on every invoice this covers."
          className="font-mono"
          value={form.registrationNumber}
          onChange={(event) => setForm({ ...form, registrationNumber: event.target.value })}
          errors={err('registrationNumber')}
        />
        <Input
          name="legalName"
          label="Registered name"
          /*
           * ⚠️ NOT ALWAYS THE NAME OVER THE DOOR. A GST invoice must print the
           *   REGISTERED legal name, and printing the trading name instead is a
           *   defective invoice.
           */
          hint="The name the registration is held in, if it differs from the clinic’s trading name."
          fieldClassName="sm:col-span-2"
          value={form.legalName}
          onChange={(event) => setForm({ ...form, legalName: event.target.value })}
          errors={err('legalName')}
        />
        <Input
          name="effectiveFrom"
          label="In force from"
          type="date"
          required
          hint="A supply before this date is not taxable by the clinic, even though the registration exists."
          value={form.effectiveFrom}
          onChange={(event) => setForm({ ...form, effectiveFrom: event.target.value })}
          errors={err('effectiveFrom')}
        />
      </div>
      <div className="flex flex-wrap gap-3">
        <Button type="submit" size="sm" disabled={pending}>
          {pending ? 'Saving…' : 'Add the registration'}
        </Button>
        <Button variant="ghost" size="sm" disabled={pending} onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

function RuleForm({
  countryCode,
  scheme,
  pending,
  fieldErrors,
  onCancel,
  onSubmit,
}: {
  countryCode: string;
  scheme: string;
  pending: boolean;
  fieldErrors?: Record<string, string[]> | undefined;
  onCancel: () => void;
  onSubmit: (input: {
    countryCode: string;
    regionCode?: string;
    scheme: string;
    taxCategory: string;
    description?: string;
    rateBps: number;
    treatment: string;
    lineName: string;
    regionalLineName?: string;
    split: string;
    stacks: boolean;
    effectiveFrom: string;
  }) => void;
}) {
  const [form, setForm] = useState({
    countryCode,
    regionCode: '',
    scheme,
    taxCategory: '',
    description: '',
    /** A percentage as typed. Basis points on the wire — see the submit. */
    percent: '',
    treatment: 'STANDARD',
    lineName: scheme === 'VAT' ? 'VAT' : 'GST',
    regionalLineName: '',
    split: 'NONE',
    stacks: false,
    effectiveFrom: '',
  });

  const err = (name: string): string[] | undefined => fieldErrors?.[name];
  const charges = form.treatment === 'STANDARD';

  return (
    <form
      className="border-rule bg-card space-y-4 rounded-lg border p-5"
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit({
          countryCode: form.countryCode,
          ...(form.regionCode === '' ? {} : { regionCode: form.regionCode }),
          scheme: form.scheme,
          taxCategory: form.taxCategory,
          ...(form.description === '' ? {} : { description: form.description }),
          /*
           * Basis points on the wire, a percentage in the box: 12% is 1200, and
           * nobody setting a rate should have to know that. An exempt or
           * zero-rated rule must carry 0, which the API also refuses.
           */
          rateBps: charges ? Math.round(Number(form.percent) * 100) : 0,
          treatment: form.treatment,
          lineName: form.lineName,
          ...(form.regionalLineName === '' ? {} : { regionalLineName: form.regionalLineName }),
          split: form.split,
          stacks: form.stacks,
          effectiveFrom: form.effectiveFrom,
        });
      }}
    >
      <h3 className="text-ink font-display text-base">Set this clinic&rsquo;s own rate</h3>
      <p className="text-muted -mt-2 max-w-prose text-sm">
        {/*
         * ⚠️ ALL-OR-NOTHING PER CATEGORY, SAID BEFORE THE FORM IS SUBMITTED. One
         *   rule takes the whole category out of rcln's card — it does not merge
         *   with it — and a clinic that expected a merge would be issuing invoices
         *   carrying one rate it chose and one it never saw.
         */}
        This replaces rcln&rsquo;s rates for the whole category, not just the part you set. Anything
        rcln charges for this category stops applying.
      </p>
      <div className="grid gap-4 sm:grid-cols-2">
        <Input
          name="taxCategory"
          label="Category"
          required
          /*
           * ⚠️ MATCHED EXACTLY AGAINST THE INVOICE LINE'S CATEGORY, WITH NO PREFIX
           *   TREE. A code that nearly matches matches nothing, and the line is then
           *   UNRATED — which refuses to issue rather than charging the wrong rate
           *   confidently.
           */
          hint="Matched exactly against what the invoice line says. CONSULTATION, MEDICINE, or an HSN/SAC code."
          className="font-mono"
          value={form.taxCategory}
          onChange={(event) => setForm({ ...form, taxCategory: event.target.value })}
          errors={err('taxCategory')}
        />
        <Select
          name="treatment"
          label="How it is taxed"
          value={form.treatment}
          onChange={(event) => setForm({ ...form, treatment: event.target.value })}
          options={[
            { value: 'STANDARD', label: 'Taxed at a rate' },
            // Both are "no tax" and they are not the same thing — see RateWords.
            { value: 'EXEMPT', label: 'Exempt — no tax, no input credit' },
            { value: 'ZERO_RATED', label: 'Zero-rated — no tax, but on the return' },
          ]}
        />
        {charges ? (
          <Input
            name="rateBps"
            label="Rate"
            required
            inputMode="decimal"
            hint="A percentage — 12 for 12%."
            className="text-right font-mono"
            value={form.percent}
            onChange={(event) => setForm({ ...form, percent: event.target.value })}
            errors={err('rateBps')}
          />
        ) : null}
        <Input
          name="lineName"
          label="Printed as"
          required
          /*
           * ⚠️ WHAT THE AUTHORITY CALLS IT, PRINTED VERBATIM. A line called "Tax"
           *   is compliant nowhere, and one country can need several names —
           *   Ontario prints HST, British Columbia prints GST and PST.
           */
          hint="What the tax authority calls it. This is printed on the invoice exactly as typed."
          className="font-mono uppercase"
          value={form.lineName}
          onChange={(event) => setForm({ ...form, lineName: event.target.value })}
          errors={err('lineName')}
        />
        <Select
          name="split"
          label="Split"
          hint="India charges CGST and SGST as two halves of one rate within a state."
          value={form.split}
          onChange={(event) => setForm({ ...form, split: event.target.value })}
          options={[
            { value: 'NONE', label: 'One line' },
            { value: 'INTRA_STATE_HALVES', label: 'Halved within the state' },
          ]}
        />
        <Input
          name="regionCode"
          label="State or region"
          hint="Without the country. Leave empty for a rate that applies country-wide, which most do."
          className="font-mono uppercase"
          value={form.regionCode}
          onChange={(event) => setForm({ ...form, regionCode: event.target.value })}
          errors={err('regionCode')}
        />
        <Input
          name="effectiveFrom"
          label="Charge it from"
          type="date"
          required
          hint="A bill for care given before this date is taxed by whatever applied then."
          value={form.effectiveFrom}
          onChange={(event) => setForm({ ...form, effectiveFrom: event.target.value })}
          errors={err('effectiveFrom')}
        />
        <Input
          name="description"
          label="Note"
          hint="For whoever reads this screen next. Never printed on an invoice."
          fieldClassName="sm:col-span-2"
          value={form.description}
          onChange={(event) => setForm({ ...form, description: event.target.value })}
          errors={err('description')}
        />
      </div>
      <div className="flex flex-wrap gap-3">
        <Button type="submit" size="sm" disabled={pending}>
          {pending ? 'Saving…' : 'Add the rate'}
        </Button>
        <Button variant="ghost" size="sm" disabled={pending} onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
