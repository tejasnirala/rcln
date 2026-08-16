import Link from 'next/link';
import type { SubstitutionResponse } from '@rcln/contracts';
import { Alert } from '@/components/ui/alert';

/**
 * What else is equivalent, and whether the law here allows it.
 *
 * ⚠️ TWO QUESTIONS, TWO ANSWERS, SIDE BY SIDE — which is the whole reason this
 *   screen exists rather than a dropdown of "similar products" in the workspace.
 *   The composition triangle says what is EQUIVALENT; `@rcln/regulatory` says
 *   whether it may be SUBSTITUTED, per jurisdiction and sometimes per prescriber
 *   instruction. India, for one, forbids it outright for Schedule H, H1 and X. A
 *   picker that showed only the first answer would read as permission.
 *
 * ⚠️ READ-ONLY, AND DELIBERATELY SO IN THIS PHASE. Supplying a substitute is
 *   supported by the API — a dispense line carries `substitutedForProductId` and
 *   a reason, and the engine is asked with `isSubstitution` set — and it is not
 *   yet wired into the workspace, which supplies what was prescribed. Recorded in
 *   KNOWN_ISSUES rather than implied by a button that does not exist.
 *
 * ⚠️ NO RULE IDS AND NO PACK VERSIONS, the same as everywhere else at the
 *   counter. The sentence a rule carries was written to be read by the person
 *   being refused.
 */
interface Props {
  encounterId: string;
  substitution: SubstitutionResponse;
  baseUnitSymbol: string;
}

const OUTCOME_LABEL: Record<string, string> = {
  PERMITTED: 'May be substituted',
  PERMITTED_WITH_CONDITIONS: 'May be substituted, with conditions',
  REFUSED: 'May not be substituted',
  UNDETERMINED: 'Cannot be relied on',
};

export function SubstitutionPanel({ encounterId, substitution, baseUnitSymbol }: Props) {
  return (
    <div className="space-y-8">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="font-display text-ink text-[1.75rem] leading-tight tracking-tight">
            Equivalents for {substitution.prescribedProductName}
          </h1>
          <p className="text-muted mt-1 text-[0.875rem]">
            Same composition, on the shelf here — and what the rules for this place say about
            handing one over instead.
          </p>
        </div>
        <Link
          href={`/pharmacy/prescriptions/${encounterId}`}
          className="text-muted hover:text-ink text-[0.875rem] underline underline-offset-4"
        >
          Back to the prescription
        </Link>
      </header>

      {substitution.candidates.length === 0 ? (
        <div className="border-rule bg-card rounded-md border p-10 text-center">
          <p className="text-ink text-[0.9375rem]">Nothing equivalent is in stock here.</p>
          <p className="text-muted mx-auto mt-2 max-w-md text-[0.875rem]">
            Only products sharing this one’s composition are counted, and only lots that could
            actually be supplied — nothing expired, quarantined or recalled.
          </p>
        </div>
      ) : (
        <ul className="space-y-2">
          {substitution.candidates.map((candidate) => (
            <li key={candidate.productId} className="border-rule bg-card rounded-md border">
              <div className="flex flex-wrap items-start justify-between gap-4 p-4">
                <div>
                  <p className="text-ink text-[1rem] font-medium">
                    {candidate.productName}
                    {candidate.strength ? ` · ${candidate.strength}` : ''}
                  </p>
                  <p className="text-muted text-[0.875rem]">
                    {candidate.manufacturerName ?? 'Manufacturer not recorded'} ·{' '}
                    {candidate.availableQuantityBase} {candidate.baseUnitSymbol || baseUnitSymbol}{' '}
                    on the shelf
                    {candidate.coversRequirement ? '' : ' — not enough for this line'}
                  </p>
                  {candidate.isNarrowTherapeuticIndex ? (
                    <p className="text-warning mt-1 text-[0.875rem]">
                      Narrow therapeutic index — a small change in blood level matters clinically.
                    </p>
                  ) : null}
                </div>
                <span
                  className={
                    candidate.decision.outcome === 'PERMITTED' ||
                    candidate.decision.outcome === 'PERMITTED_WITH_CONDITIONS'
                      ? 'border-success/40 text-success rounded-full border px-3 py-1 text-[0.8125rem]'
                      : 'border-warning/40 text-warning rounded-full border px-3 py-1 text-[0.8125rem]'
                  }
                >
                  {OUTCOME_LABEL[candidate.decision.outcome] ?? candidate.decision.outcome}
                </span>
              </div>

              {candidate.decision.messages.length > 0 ||
              candidate.decision.conditions.length > 0 ? (
                <div className="border-rule bg-paper space-y-2 border-t p-4">
                  {candidate.decision.conditions.map((condition) => (
                    <p
                      key={`${condition.kind}-${condition.detail}`}
                      className="text-ink text-[0.875rem]"
                    >
                      <strong className="font-medium">Must be done:</strong> {condition.detail}
                    </p>
                  ))}
                  {candidate.decision.messages.map((message) => (
                    <p key={message} className="text-muted text-[0.875rem]">
                      {message}
                    </p>
                  ))}
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      )}

      <Alert tone="info">
        Handing over an equivalent is recorded against the prescribed line, with the reason and the
        rules that applied. Ask the prescriber first wherever the answer above is anything other
        than a clear yes.
      </Alert>
    </div>
  );
}
