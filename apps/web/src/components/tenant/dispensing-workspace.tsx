'use client';

import { useActionState, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import type {
  AllocationPlanResponse,
  DispenseLineRequest,
  InventoryLocationSummary,
  PharmacyPrescriptionDetail,
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

interface Props {
  slug: string;
  prescription: PharmacyPrescriptionDetail;
  /** Every candidate lot for each line, oldest-first, from the FEFO planner. */
  plans: LinePlan[];
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
}

function lotKey(lot: {
  locationId: string;
  batchId: string | null;
  serialId: string | null;
}): string {
  return `${lot.locationId}|${lot.batchId ?? '-'}|${lot.serialId ?? '-'}`;
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
    };
  });
}

export function DispensingWorkspace({ slug, prescription, plans, locations, canDispense }: Props) {
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

  const payload: DispenseLineRequest[] = useMemo(
    () =>
      lines
        .filter((line) => line.include)
        .map((line) => {
          const chosen = line.lots.filter((lot) => Number(lot.quantity) > 0);
          const total = chosen.reduce((sum, lot) => sum + Number(lot.quantity), 0);
          return {
            encounterPrescriptionId: line.item.id,
            productId: line.item.productId,
            quantity: String(total),
            /*
             * ⚠️ THE PRODUCT'S BASE UNIT, BECAUSE THAT IS THE UNIT THIS SCREEN
             *   COUNTS IN. A workspace that offered a pack-size dropdown would be
             *   converting twice — once here and once on the server — and the two
             *   would disagree the first time a packaging level changed.
             */
            unitId: line.item.baseUnitId,
            allocations: chosen.map((lot) => ({
              locationId: lot.locationId,
              batchId: lot.batchId,
              serialId: lot.serialId,
              quantityBase: lot.quantity,
              isOverride: lot.quantity !== lot.plannedQuantityBase,
              overrideReason: lot.overrideReason.trim() === '' ? null : lot.overrideReason.trim(),
            })),
          } satisfies DispenseLineRequest;
        }),
    [lines]
  );

  const nothingToSupply = payload.length === 0;

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
          const supplying = line.lots.reduce((sum, lot) => sum + Number(lot.quantity || 0), 0);

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
          {nothingToSupply
            ? 'Nothing is selected to hand over yet.'
            : `Handing over ${payload.length} ${payload.length === 1 ? 'medicine' : 'medicines'}.`}
        </p>
        <Button type="submit" disabled={!canDispense || nothingToSupply || pending}>
          {pending ? 'Dispensing…' : 'Dispense'}
        </Button>
      </div>
    </form>
  );
}
