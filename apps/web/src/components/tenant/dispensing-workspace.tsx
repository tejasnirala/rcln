'use client';

import { useActionState, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import type {
  AllocationPlanResponse,
  DispenseLineRequest,
  InventoryLocationSummary,
  PharmacyPrescriptionDetail,
  SubstitutionCandidate,
} from '@rcln/contracts';
import { Alert } from '@/components/ui/alert';
import { cn } from '@/lib/cn';
import { Button } from '@/components/ui/button';
import { Input, Select, inputClass } from '@/components/ui/field';
import {
  dispenseAction,
  IDLE_FORM,
  type PharmacyFormState,
} from '@/app/(tenant)/t/[slug]/(app)/pharmacy/actions';

/**
 * The dispensing workspace — the most important screen in the programme.
 *
 * ── THE COUNTER STRIP ───────────────────────────────────────────────────────
 * Each medicine is one strip, and it reads left to right the way the job is
 * actually done: what the prescriber wrote · what is on the shelf, oldest lot
 * first · how much is going out · what the law says about it. Nothing about a
 * medicine is more than one strip away, and the strip does not collapse: a
 * pharmacist checking six items should never have to remember what the third one
 * said.
 *
 * ⚠️ THE EXPIRY IS THE LEADING LABEL ON EVERY LOT, WHICH IS THE ONE PIECE OF
 *   VISUAL EMPHASIS THIS SCREEN SPENDS. FEFO is not a policy the software applies
 *   behind the counter; it is the reason this lot and not that one, and putting
 *   the date first makes the plan self-evidently right — or visibly wrong, which
 *   is the case that matters.
 *
 * ⚠️ A WARNING IS NEVER A DIALOG. Anything the rules said sits inside the strip
 *   it belongs to, so it cannot be dismissed without being read, and it is the
 *   rule's own sentence — never a rule id, a pack version or an outcome code
 *   (FRONTEND_ARCHITECTURE.md). Those belong on the Rules screens, for the
 *   person whose job they are.
 *
 * ⚠️ THIS SCREEN AUTHORISES NOTHING. The plan it shows was computed a moment ago
 *   and the server recomputes it inside the posting transaction; the engine is
 *   asked again there too. What is rendered here is a proposal a human confirms.
 *
 * ⚠️ PHI. Everything on it. Nothing is written to `localStorage`, a cookie or a
 *   URL, and the patient's name appears only in the rendered page.
 */

interface LinePlan {
  encounterPrescriptionId: string;
  plan: AllocationPlanResponse | null;
}

/** The equivalents for one prescribed line, each with the law's answer attached. */
interface LineSubstitutions {
  encounterPrescriptionId: string;
  candidates: SubstitutionCandidate[];
}

interface Props {
  slug: string;
  prescription: PharmacyPrescriptionDetail;
  /** Every candidate lot for each line, oldest-first, from the FEFO planner. */
  plans: LinePlan[];
  /** What else has the same composition, per line, with the decision attached. */
  substitutions: LineSubstitutions[];
  locations: InventoryLocationSummary[];
  canDispense: boolean;
}

interface DraftLot {
  key: string;
  locationId: string;
  locationName: string;
  batchId: string | null;
  lotNumber: string | null;
  expiresOn: string | null;
  serialId: string | null;
  availableQuantityBase: string;
  /** What the FEFO plan proposed for this lot, as a string. */
  plannedQuantityBase: string;
  quantity: string;
  overrideReason: string;
}

interface DraftLine {
  item: PharmacyPrescriptionDetail['items'][number];
  include: boolean;
  lots: DraftLot[];
  /**
   * The product actually being handed over, when it is not the one prescribed
   * (PI-8, closing KNOWN_ISSUES #11).
   *
   * ⚠️ NULL IS "SUPPLY WHAT WAS PRESCRIBED", NOT "UNDECIDED". The overwhelming
   *   majority of lines are never substituted and must not be made to look like a
   *   decision somebody skipped.
   */
  substituteProductId: string | null;
  /** ⚠️ REQUIRED WHENEVER A SUBSTITUTE IS CHOSEN — CHECKed in the database. */
  substitutionReason: string;
}

function lotKey(lot: {
  locationId: string;
  batchId: string | null;
  serialId: string | null;
}): string {
  return `${lot.locationId}|${lot.batchId ?? '-'}|${lot.serialId ?? '-'}`;
}

/**
 * Add decimal quantity strings without going through a float.
 *
 * ⚠️ SIX PLACES, BECAUSE THAT IS `stock_ledger`'s SCALE. Fixed-point on the
 *   integer of the scaled value, so nothing ever becomes a double.
 */
function sumQuantities(values: readonly string[]): string {
  const SCALE = 1_000_000;
  const total = values.reduce((sum, value) => sum + Math.round(Number(value) * SCALE), 0);
  return (total / SCALE).toFixed(6).replace(/\.?0+$/, '');
}

/** One chosen lot, in the shape the request wants. */
function toAllocation(lot: DraftLot) {
  return {
    locationId: lot.locationId,
    batchId: lot.batchId,
    serialId: lot.serialId,
    quantityBase: lot.quantity,
    isOverride: lot.quantity !== lot.plannedQuantityBase,
    overrideReason: lot.overrideReason.trim() === '' ? null : lot.overrideReason.trim(),
  };
}

/**
 * How one substitute reads in the picker.
 *
 * ⚠️ THE LAW'S ANSWER IS IN THE LABEL, NOT BESIDE IT. A pharmacist scanning a
 *   dropdown reads the option text and nothing else, so "may not be substituted
 *   here" has to be part of that text — a badge next to it is a badge somebody
 *   does not look at. The wording is about SUBSTITUTION and never about
 *   equivalence: two products sharing a composition is chemistry, and whether one
 *   may stand in for the other is jurisdiction.
 *
 * ⚠️ AND THE STOCK POSITION IS THERE TOO, because a substitute that cannot cover
 *   what is outstanding turns one supply into two and is usually not what
 *   somebody wants.
 */
function substituteLabel(candidate: SubstitutionCandidate): string {
  const parts = [candidate.productName];
  if (candidate.strength) parts.push(candidate.strength);
  if (candidate.manufacturerName) parts.push(candidate.manufacturerName);

  const stock = candidate.coversRequirement
    ? `${candidate.availableQuantityBase} ${candidate.baseUnitSymbol} on hand`
    : `only ${candidate.availableQuantityBase} ${candidate.baseUnitSymbol} on hand`;

  const legal =
    candidate.decision.outcome === 'PERMITTED'
      ? null
      : candidate.decision.outcome === 'PERMITTED_WITH_CONDITIONS'
        ? 'conditions apply'
        : candidate.decision.outcome === 'REFUSED'
          ? 'may not be substituted here'
          : 'the rules give no answer here';

  return [parts.join(' · '), stock, legal].filter(Boolean).join(' — ');
}

function buildDraft(prescription: PharmacyPrescriptionDetail, plans: LinePlan[]): DraftLine[] {
  const planByLine = new Map(plans.map((entry) => [entry.encounterPrescriptionId, entry.plan]));

  return prescription.items.map((item) => {
    const plan = planByLine.get(item.id) ?? null;
    const outstanding = item.outstandingQuantityBase ?? '0';

    /*
     * The planner was asked for everything on the shelf, so its lines ARE the
     * candidate list in FEFO order. What each lot should give is then walked down
     * that list against what is still outstanding — which is the same arithmetic
     * the server does, and is why the numbers below match what it posts.
     */
    let remaining = Number(outstanding);
    const lots: DraftLot[] = (plan?.lines ?? []).map((line) => {
      const take = Math.max(0, Math.min(remaining, Number(line.availableQuantityBase)));
      remaining -= take;
      return {
        key: lotKey(line),
        locationId: line.locationId,
        locationName: line.locationName,
        batchId: line.batchId,
        lotNumber: line.lotNumber,
        expiresOn: line.expiresOn,
        serialId: line.serialId,
        availableQuantityBase: line.availableQuantityBase,
        plannedQuantityBase: String(take),
        quantity: take > 0 ? String(take) : '',
        overrideReason: '',
      };
    });

    return {
      item,
      include:
        item.isStockItem && Number(outstanding) > 0 && lots.some((lot) => lot.quantity !== ''),
      lots,
      substituteProductId: null,
      substitutionReason: '',
    };
  });
}

export function DispensingWorkspace({
  slug,
  prescription,
  plans,
  substitutions,
  locations,
  canDispense,
}: Props) {
  const router = useRouter();
  const [lines, setLines] = useState<DraftLine[]>(() => buildDraft(prescription, plans));
  const [locationId, setLocationId] = useState(locations[0]?.id ?? '');
  const [notes, setNotes] = useState('');

  const [state, formAction, pending] = useActionState<PharmacyFormState, FormData>(
    async (previous, form) => {
      const result = await dispenseAction(slug, previous, form);
      if (result.status === 'saved' && result.createdId) {
        router.push(`/pharmacy/dispenses/${result.createdId}`);
      }
      return result;
    },
    IDLE_FORM
  );

  /**
   * The equivalents offered for one prescribed line. Empty when there are none.
   *
   * ⚠️ ONLY CANDIDATES MEASURED IN THE SAME BASE UNIT AS THE PRESCRIBED LINE, AND
   *   THIS FILTER IS A CORRECTNESS FIX RATHER THAN A TIDINESS ONE. The quantity
   *   this screen sends for a substituted line is
   *   `item.outstandingQuantityBase`, which is denominated in the PRESCRIBED
   *   product's base unit. Offer a candidate measured in millilitres against a
   *   line outstanding in tablets and the server is asked to dispense "30" of the
   *   substitute — thirty millilitres, planned and posted, with nothing anywhere
   *   raising an error.
   *
   *   Converting instead would be worse: the two products' base units are
   *   frequently different CLASSES, which is not a conversion at all, and even
   *   where it is, silently restating a dose is not a thing a dispensing screen
   *   may do. A pharmacist swapping to a different presentation has to re-key the
   *   quantity, which means a different flow than this control.
   */
  const candidatesFor = (encounterPrescriptionId: string): SubstitutionCandidate[] => {
    const item = prescription.items.find((entry) => entry.id === encounterPrescriptionId);
    return (
      substitutions
        .find((entry) => entry.encounterPrescriptionId === encounterPrescriptionId)
        ?.candidates.filter((candidate) => candidate.baseUnitId === item?.baseUnitId) ?? []
    );
  };

  /** The candidate a line has actually been switched to, if any. */
  const substituteOf = (line: DraftLine): SubstitutionCandidate | undefined =>
    line.substituteProductId === null
      ? undefined
      : candidatesFor(line.item.id).find(
          (candidate) => candidate.productId === line.substituteProductId
        );

  const payload: DispenseLineRequest[] = useMemo(
    () =>
      lines
        .filter((line) => line.include)
        .map((line) => {
          const chosen = line.lots.filter((lot) => Number(lot.quantity) > 0);
          /*
           * ⚠️ SUMMED AS A DECIMAL STRING, NOT AS FLOATS. `quantity_base` is
           *   `Decimal(18,6)`; `0.1 + 0.2` is `0.30000000000000004` and a
           *   liquid dispensed in millilitres hits that on an ordinary split
           *   across two lots. Tablets are integers, which is why this was
           *   latent rather than visible.
           */
          const total = sumQuantities(chosen.map((lot) => lot.quantity));
          const substituted = line.substituteProductId !== null;

          return {
            encounterPrescriptionId: line.item.id,
            /* What is actually handed over. The prescribed product unless swapped. */
            productId: line.substituteProductId ?? line.item.productId,
            /*
             * ⚠️ ON A SUBSTITUTION THE QUANTITY IS WHAT IS OUTSTANDING, NOT THE
             *   SUM OF THE LOTS. The lots on screen were planned for the
             *   PRESCRIBED product and are meaningless for the substitute — see
             *   `allocations` below.
             */
            quantity: substituted ? (line.item.outstandingQuantityBase ?? '0') : total,
            /*
             * ⚠️ THE PRODUCT'S BASE UNIT, BECAUSE THAT IS THE UNIT THIS SCREEN
             *   COUNTS IN. A workspace that offered a pack-size dropdown would be
             *   converting twice — once here and once on the server — and the two
             *   would disagree the first time a packaging level changed.
             *
             * ⚠️ AND ON A SUBSTITUTION IT IS THE SUBSTITUTE'S BASE UNIT, WHICH IS
             *   WHY THE CANDIDATE CARRIES ONE. Sending the prescribed product's
             *   unit for a different product is a conversion against the wrong
             *   graph — the ledger would refuse it, but only after the engine had
             *   been asked about a quantity nobody meant.
             */
            /*
             * ⚠️ THE SAME UNIT EITHER WAY, BECAUSE `candidatesFor` ONLY OFFERS
             *   CANDIDATES THAT SHARE THE PRESCRIBED LINE'S BASE UNIT. The
             *   substitute's own id is sent rather than the prescribed one's
             *   because they are different rows for the same unit, and a request
             *   should say which product's unit it means; the fallback is
             *   therefore provably equivalent rather than a fail-open guess.
             */
            unitId: substituteOf(line)?.baseUnitId ?? line.item.baseUnitId,
            ...(substituted
              ? {
                  substitutedForProductId: line.item.productId,
                  substitutionReason: line.substitutionReason.trim(),
                }
              : {}),
            /*
             * ⚠️ A SUBSTITUTED LINE SENDS NO ALLOCATIONS, AND THAT IS THE WHOLE
             *   REASON THIS CONTROL IS SAFE TO OFFER. The lots on screen were
             *   planned for the product the prescriber wrote; the substitute has
             *   its own lots, its own expiries and its own FEFO order. Omitting
             *   `allocations` is the contract's own "you plan it" — the server
             *   runs `planStockAllocationWithin` inside the posting transaction,
             *   against the product actually being supplied. Sending the
             *   prescribed product's lots for a different product would take
             *   stock off the wrong shelf.
             */
            ...(substituted ? {} : { allocations: chosen.map(toAllocation) }),
          } satisfies DispenseLineRequest;
        }),
    /*
     * ⚠️ `substitutions` IS A DEPENDENCY, reached through `substituteOf`. It is a
     *   server-rendered prop that cannot change without a remount today, so the
     *   omission was benign — and a stale closure over a prop is the shape of bug
     *   that stops being benign the moment somebody adds a refresh.
     */
    [lines, substitutions]
  );

  const nothingToSupply = payload.length === 0;
  /*
   * ⚠️ A SUBSTITUTION WITH NO REASON IS REFUSED BY THE DATABASE, so the button is
   *   disabled rather than letting somebody press it and read a CHECK constraint.
   *   The contract refines the same rule; this is the courtesy in front of both.
   */
  const missingSubstitutionReason = lines.some(
    (line) =>
      line.include && line.substituteProductId !== null && line.substitutionReason.trim() === ''
  );

  /*
   * ⚠️ AND A SUBSTITUTION NEEDS AN OUTSTANDING QUANTITY, FOR THE SAME REASON THE
   *   BUTTON IS DISABLED ABOVE RATHER THAN THE SERVER ANSWERING 400. A substituted
   *   line sends `outstandingQuantityBase` — deliberately, because the lots on
   *   screen were planned for the PRESCRIBED product — and that field is nullable.
   *   When it is null the payload used to fall back to `'0'`, which
   *   `positiveQuantity` rejects, so the pharmacist got a validation error naming
   *   a quantity no control on the screen sets and no edit could fix.
   *
   *   The prescribed product is still dispensable on that line; it is only the
   *   swap that cannot be sized. Saying so beats a 400.
   */
  const unsizedSubstitution = lines.some(
    (line) =>
      line.include &&
      line.substituteProductId !== null &&
      line.item.outstandingQuantityBase === null
  );

  const setLot = (lineIndex: number, key: string, patch: Partial<DraftLot>): void => {
    setLines((current) =>
      current.map((line, index) =>
        index === lineIndex
          ? {
              ...line,
              lots: line.lots.map((lot) => (lot.key === key ? { ...lot, ...patch } : lot)),
            }
          : line
      )
    );
  };

  return (
    <form action={formAction} className="space-y-8">
      <input type="hidden" name="branchId" value={prescription.branchId} />
      <input type="hidden" name="encounterId" value={prescription.encounterId} />
      <input type="hidden" name="kind" value="PRESCRIPTION" />
      <input type="hidden" name="locationId" value={locationId} />
      <input type="hidden" name="notes" value={notes} />
      <input type="hidden" name="lines" value={JSON.stringify(payload)} />

      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="font-display text-ink text-[1.75rem] leading-tight tracking-tight">
            Dispensing for {prescription.patientName}
          </h1>
          <p className="text-muted mt-1 text-[0.875rem]">
            {prescription.patientUhid} · prescribed by{' '}
            {prescription.prescriberName ?? 'a clinician at this clinic'}
            {prescription.encounterNumber ? ` · ${prescription.encounterNumber}` : ''}
          </p>
        </div>
        <Link
          href={`/pharmacy/prescriptions/${prescription.encounterId}`}
          className="text-muted hover:text-ink text-[0.875rem] underline underline-offset-4"
        >
          Back to the prescription
        </Link>
      </header>

      {!prescription.isDispensable ? (
        <Alert tone="error">
          This consultation is {prescription.encounterStatus.toLowerCase()}, so nothing can be
          supplied against it. Ask the prescriber for a current prescription.
        </Alert>
      ) : null}

      {state.status === 'error' ? (
        <Alert tone="error">
          <p>{state.message}</p>
          {state.ruleMessages?.length ? (
            <ul className="mt-2 list-disc space-y-1 pl-5">
              {state.ruleMessages.map((message) => (
                <li key={message}>{message}</li>
              ))}
            </ul>
          ) : null}
        </Alert>
      ) : null}

      <div className="border-rule bg-card grid gap-3 rounded-md border p-4 sm:grid-cols-2">
        <Select
          label="Dispensing from"
          name="locationPicker"
          value={locationId}
          options={locations.map((location) => ({ value: location.id, label: location.name }))}
          onChange={(event) => setLocationId(event.target.value)}
        />
        <Input
          label="Note on this supply"
          name="notes"
          value={notes}
          onChange={(event) => setNotes(event.target.value)}
          placeholder="Counselled on drowsiness"
        />
      </div>

      <ol className="space-y-4">
        {lines.map((line, lineIndex) => {
          const outstanding = line.item.outstandingQuantityBase;
          /* Displayed, and summed the same exact way the payload is. */
          const supplying = sumQuantities(line.lots.map((lot) => lot.quantity || '0'));

          return (
            <li
              key={line.item.id}
              className={`border-rule bg-card rounded-md border ${line.include ? '' : 'opacity-60'}`}
            >
              <div className="border-rule flex flex-wrap items-start justify-between gap-4 border-b p-4">
                <div>
                  <label className="flex items-start gap-3">
                    <input
                      type="checkbox"
                      checked={line.include}
                      disabled={!line.item.isStockItem}
                      onChange={(event) =>
                        setLines((current) =>
                          current.map((entry, index) =>
                            index === lineIndex
                              ? { ...entry, include: event.target.checked }
                              : entry
                          )
                        )
                      }
                      className="mt-1"
                    />
                    <span>
                      <span className="text-ink block text-[1rem] font-medium">
                        {line.item.productName}
                        {line.item.strength ? ` · ${line.item.strength}` : ''}
                      </span>
                      <span className="text-muted block text-[0.875rem]">
                        {[
                          line.item.dose && line.item.doseUnit
                            ? `${line.item.dose} ${line.item.doseUnit}`
                            : null,
                          line.item.frequency && line.item.frequencyUnit
                            ? `${line.item.frequency}× per ${line.item.frequencyUnit.toLowerCase()}`
                            : null,
                          line.item.durationValue && line.item.durationUnit
                            ? `for ${line.item.durationValue} ${line.item.durationUnit.toLowerCase()}`
                            : null,
                          line.item.isPrn ? 'as needed' : null,
                        ]
                          .filter(Boolean)
                          .join(' · ')}
                      </span>
                      {line.item.instructions ? (
                        <span className="text-muted mt-1 block text-[0.875rem] italic">
                          “{line.item.instructions}”
                        </span>
                      ) : null}
                    </span>
                  </label>
                </div>

                <dl className="text-[0.875rem]">
                  <div className="flex gap-2">
                    <dt className="text-muted">Prescribed</dt>
                    <dd className="text-ink">
                      {line.item.quantityBase ?? '—'} {line.item.baseUnitSymbol}
                    </dd>
                  </div>
                  <div className="flex gap-2">
                    <dt className="text-muted">Still to supply</dt>
                    <dd className="text-ink">
                      {outstanding ?? 'not stated'} {outstanding ? line.item.baseUnitSymbol : ''}
                    </dd>
                  </div>
                  <div className="flex gap-2">
                    <dt className="text-muted">Supplying now</dt>
                    <dd className="text-ink font-medium">
                      {supplying} {line.item.baseUnitSymbol}
                    </dd>
                  </div>
                </dl>
              </div>

              {/*
                ⚠️ THE SWAP, AND IT CARRIES THE LAW'S ANSWER WITH IT (PI-8,
                  closing KNOWN_ISSUES #11). Every option is labelled with what
                  `@rcln/regulatory` said about substituting THAT product HERE —
                  never with the word "equivalent" alone. Two products sharing a
                  composition is a fact about chemistry; whether one may stand in
                  for the other is a fact about the jurisdiction, the prescriber's
                  instruction and the drug's therapeutic index, and a picker that
                  offered the first as though it answered the second would put a
                  clinical claim on screen that nothing had checked.

                ⚠️ AND IT IS RENDERED ONLY WHERE THERE IS SOMETHING TO OFFER. A
                  control that is always present and almost always empty trains
                  people to ignore it.
              */}
              {line.item.isStockItem && candidatesFor(line.item.id).length > 0 ? (
                <div className="border-rule bg-paper border-b p-4">
                  <Select
                    label="Hand over"
                    name={`substitute-${line.item.id}`}
                    value={line.substituteProductId ?? ''}
                    options={[
                      {
                        value: '',
                        label: `${line.item.productName} — as prescribed`,
                      },
                      ...candidatesFor(line.item.id).map((candidate) => ({
                        value: candidate.productId,
                        label: substituteLabel(candidate),
                      })),
                    ]}
                    onChange={(event) =>
                      setLines((current) =>
                        current.map((entry, index) =>
                          index === lineIndex
                            ? {
                                ...entry,
                                substituteProductId:
                                  event.target.value === '' ? null : event.target.value,
                                /* Clearing the swap clears the reason it needed. */
                                substitutionReason:
                                  event.target.value === '' ? '' : entry.substitutionReason,
                              }
                            : entry
                        )
                      )
                    }
                  />

                  {line.substituteProductId ? (
                    <div className="mt-3 space-y-3">
                      {/*
                        The chosen candidate's own decision, verbatim. The server
                        asks the engine again inside the posting transaction, so
                        this is a warning and never an authorisation.
                      */}
                      {(substituteOf(line)?.decision.messages ?? []).length > 0 ? (
                        <Alert tone="warning">
                          <ul className="list-disc space-y-1 pl-5">
                            {substituteOf(line)?.decision.messages.map((message) => (
                              <li key={message}>{message}</li>
                            ))}
                          </ul>
                        </Alert>
                      ) : null}

                      {substituteOf(line)?.isNarrowTherapeuticIndex ? (
                        <Alert tone="error">
                          Small differences in blood level matter for this medicine. Substituting it
                          is a clinical decision — check with the prescriber before you do.
                        </Alert>
                      ) : null}

                      <Input
                        label="Why this instead"
                        name={`substitution-reason-${line.item.id}`}
                        value={line.substitutionReason}
                        onChange={(event) =>
                          setLines((current) =>
                            current.map((entry, index) =>
                              index === lineIndex
                                ? { ...entry, substitutionReason: event.target.value }
                                : entry
                            )
                          )
                        }
                        placeholder="Prescribed brand out of stock"
                        hint="Required. It goes on the record beside the supply."
                        {...(line.include && line.substitutionReason.trim() === ''
                          ? { errors: ['Say why a different product is being handed over.'] }
                          : {})}
                      />

                      <p className="text-muted text-[0.8125rem]">
                        The lots below are the prescribed product’s. Because you are handing over
                        something else, the counter will pick its lots by expiry when you confirm.
                      </p>
                    </div>
                  ) : null}
                </div>
              ) : null}

              {!line.item.isStockItem ? (
                <p className="text-muted p-4 text-[0.875rem]">
                  This is not stocked here, so there is nothing to hand over. It stays on the
                  prescription as advice.
                </p>
              ) : line.lots.length === 0 ? (
                <p className="text-muted p-4 text-[0.875rem]">
                  Nothing dispensable on the shelf. Expired, quarantined and recalled stock is
                  deliberately not offered.
                </p>
              ) : (
                <ul className="divide-rule divide-y">
                  {line.lots.map((lot) => {
                    const changed = lot.quantity !== lot.plannedQuantityBase;
                    return (
                      <li key={lot.key} className="flex flex-wrap items-center gap-4 p-4">
                        {/*
                          The expiry leads. See the header: FEFO made visible is
                          the whole point of the strip.
                        */}
                        <span className="text-ink w-28 shrink-0 text-[0.875rem] font-medium tabular-nums">
                          {lot.expiresOn ?? 'no expiry'}
                        </span>
                        <span className="text-muted min-w-40 flex-1 text-[0.875rem]">
                          {lot.lotNumber ? `Lot ${lot.lotNumber}` : 'Untracked stock'} ·{' '}
                          {lot.locationName} · {lot.availableQuantityBase}{' '}
                          {line.item.baseUnitSymbol} on hand
                        </span>
                        {/*
                          ⚠️ A BARE CONTROL ON `inputClass`, NOT `<Input>`, AND THIS
                            IS ONE OF THE CASES AGENTS.md ALLOWS IT. `Input` renders
                            its label as a block above the box; here the label is the
                            row itself — expiry, lot, location — and a stacked one per
                            lot would triple the height of a strip a pharmacist reads
                            six of at a glance. The accessible name is on the control.
                        */}
                        <label className="flex items-center gap-2">
                          <span className="text-muted text-[0.8125rem]">Take</span>
                          <input
                            type="text"
                            inputMode="decimal"
                            aria-label={`Quantity of ${line.item.productName} to take from ${
                              lot.lotNumber ? `lot ${lot.lotNumber}` : 'untracked stock'
                            }`}
                            value={lot.quantity}
                            onChange={(event) =>
                              setLot(lineIndex, lot.key, { quantity: event.target.value })
                            }
                            className={cn(inputClass, 'w-24 text-right tabular-nums')}
                          />
                        </label>
                        {changed ? (
                          <input
                            type="text"
                            aria-label={`Why this lot of ${line.item.productName} instead of the one the plan chose`}
                            value={lot.overrideReason}
                            onChange={(event) =>
                              setLot(lineIndex, lot.key, { overrideReason: event.target.value })
                            }
                            placeholder="Why this lot, and not the plan's?"
                            className={cn(inputClass, 'border-signal w-full sm:w-72')}
                          />
                        ) : null}
                      </li>
                    );
                  })}
                </ul>
              )}
            </li>
          );
        })}
      </ol>

      <div className="flex flex-wrap items-center justify-between gap-4">
        <p className="text-muted text-[0.875rem]">
          {unsizedSubstitution
            ? 'One of these prescriptions does not say how much is outstanding, so a substitute cannot be sized. Hand over the prescribed medicine on that line, or ask the prescriber to restate the quantity.'
            : nothingToSupply
              ? 'Nothing is selected to hand over yet.'
              : `Handing over ${payload.length} ${payload.length === 1 ? 'medicine' : 'medicines'}.`}
        </p>
        <Button
          type="submit"
          disabled={
            !canDispense ||
            nothingToSupply ||
            missingSubstitutionReason ||
            unsizedSubstitution ||
            pending
          }
        >
          {pending ? 'Dispensing…' : 'Dispense'}
        </Button>
      </div>
    </form>
  );
}
