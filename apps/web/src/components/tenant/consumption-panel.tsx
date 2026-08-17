'use client';

import { useActionState, useState } from 'react';
import type {
  ConsumptionPlanResponse,
  ConsumptionSummary,
  InventoryLocationSummary,
} from '@rcln/contracts';
import { Alert } from '@/components/ui/alert';
import { formatClinicDateTime } from '@/lib/format';
import {
  recordConsumptionAction,
  IDLE_USAGE_FORM,
  type UsageFormState,
} from '@/app/(tenant)/t/[slug]/(app)/usage/actions';

/**
 * What this consultation used, and the form for recording it.
 *
 * ⚠️ IT SITS ON THE CONSULTATION AND NOT IN A SECTION OF ITS OWN, because the
 *   anchor is what makes the record traceable. A standalone form would have to
 *   ask which patient and which procedure — a question the person standing in
 *   the room has already answered, and one they can get wrong.
 *
 * ⚠️ THE PANEL PRE-FILLS AND COMMITS TO NOTHING. Every quantity is editable,
 *   including down to nothing: a clinician who used two swabs instead of five
 *   types two, and a line they did not use at all is left blank and never
 *   written. The template is a starting point.
 *
 * ⚠️ AND A DEPARTURE IS NEVER BLOCKED HERE. The reason box appears when the
 *   number stops matching the expectation and the record is refused without one
 *   — but the FIELD stays editable either way, because a screen that clamped the
 *   figure would invite somebody to key the expected number, which puts a
 *   quantity in the ledger nobody used. That is the one outcome this whole
 *   design rules out.
 *
 * ⚠️ PHI: this names a patient's procedure and the materials used on them.
 *   Nothing here is written to `localStorage`, a cookie or a URL.
 */
/**
 * One lot, or one numbered device, as the picker holds it (PI-9.9).
 *
 * ⚠️ `quantityBase` IS IN BASE UNITS AND THE LINE'S `quantity` IS NOT. The line
 *   is typed in whatever unit the template stated — "2 pairs" — and the lots are
 *   counted in the product's base unit, because that is the only unit a shelf
 *   balance exists in. The two are reconciled by the SERVER, which converts the
 *   line and checks the lots add up to it; a screen that tried to convert would
 *   be a second conversion graph.
 */
interface PanelLot {
  key: string;
  locationId: string;
  locationName: string;
  batchId: string | null;
  lotNumber: string | null;
  expiresOn: string | null;
  serialId: string | null;
  serialNumber: string | null;
  availableQuantityBase: string;
  /** What FEFO proposed. Kept so the screen can say what it is departing from. */
  plannedQuantityBase: string;
  quantityBase: string;
  overrideReason: string;
}

interface PanelLine {
  key: string;
  templateLineId: string | null;
  productId: string;
  productName: string;
  unitId: string;
  unitSymbol: string;
  expectedQuantity: string;
  expectedQuantityBase: string;
  baseUnitSymbol: string;
  isOptional: boolean;
  availableQuantityBase: string;
  /** What the clinician says was used, in the unit the template stated. */
  quantity: string;
  overrideReason: string;
  /** Empty for untracked stock — there is nothing to choose between. */
  lots: PanelLot[];
  /**
   * ⚠️ FALSE UNTIL SOMEBODY TOUCHES THE PICKER, AND THAT IS WHAT DECIDES WHETHER
   *   `allocations` IS SENT AT ALL. An untouched line omits them, and the server
   *   runs its own FEFO plan inside the posting transaction — which is the
   *   contract's own "you plan it" and keeps the ordinary case free of a client
   *   opinion about lots. Sending the pre-filled numbers on every line would
   *   turn any drift between the browser's snapshot and the shelf into a
   *   refusal, on lines nobody chose anything for.
   */
  lotsChosen: boolean;
}

interface Props {
  slug: string;
  plan: ConsumptionPlanResponse;
  records: ConsumptionSummary[];
  locations: InventoryLocationSummary[];
  timeZone: string;
  canRecord: boolean;
  canOverride: boolean;
}

export function ConsumptionPanel({
  slug,
  plan,
  records,
  locations,
  timeZone,
  canRecord,
  canOverride,
}: Props) {
  const [lines, setLines] = useState<PanelLine[]>(() =>
    plan.lines.map((line, index) => ({
      key: `${line.productId}-${String(index)}`,
      templateLineId: line.templateLineId,
      productId: line.productId,
      productName: line.productName,
      unitId: line.unitId,
      unitSymbol: line.unitSymbol,
      expectedQuantity: line.expectedQuantity,
      expectedQuantityBase: line.expectedQuantityBase,
      baseUnitSymbol: line.baseUnitSymbol,
      isOptional: line.isOptional,
      availableQuantityBase: line.availableQuantityBase,
      /* An optional line starts empty; a required one starts at what it expects. */
      quantity: line.isOptional ? '' : line.expectedQuantity,
      overrideReason: '',
      lots: line.candidateLots.map((lot, lotIndex) => ({
        key: `${lot.locationId}|${lot.batchId ?? '-'}|${lot.serialId ?? '-'}|${String(lotIndex)}`,
        locationId: lot.locationId,
        locationName: lot.locationName,
        batchId: lot.batchId,
        lotNumber: lot.lotNumber,
        expiresOn: lot.expiresOn,
        serialId: lot.serialId,
        serialNumber: lot.serialNumber,
        availableQuantityBase: lot.availableQuantityBase,
        plannedQuantityBase: lot.plannedQuantityBase,
        /* Optional lines expect nothing, so FEFO proposed nothing for them. */
        quantityBase: line.isOptional ? '0' : lot.plannedQuantityBase,
        overrideReason: '',
      })),
      lotsChosen: false,
    }))
  );

  const [state, record, recording] = useActionState<UsageFormState, FormData>(
    recordConsumptionAction.bind(null, slug),
    IDLE_USAGE_FORM
  );

  function update(key: string, patch: Partial<PanelLine>): void {
    setLines((current) => current.map((line) => (line.key === key ? { ...line, ...patch } : line)));
  }

  /** Change one lot, and mark the line as one somebody has chosen lots for. */
  function updateLot(lineKey: string, lotKey: string, patch: Partial<PanelLot>): void {
    setLines((current) =>
      current.map((line) =>
        line.key === lineKey
          ? {
              ...line,
              lotsChosen: true,
              lots: line.lots.map((lot) => (lot.key === lotKey ? { ...lot, ...patch } : lot)),
            }
          : line
      )
    );
  }

  /** What the chosen lots add up to, in base units. */
  function chosenBase(line: PanelLine): number {
    return line.lots.reduce((sum, lot) => sum + (Number(lot.quantityBase) || 0), 0);
  }

  /*
   * ⚠️ AN INDICATION, NOT THE ANSWER. The server derives the departure from the
   *   BASE quantities after converting through the unit graph, and this compares
   *   the typed figure against the template's own figure in the template's own
   *   unit. They agree whenever the clinician keeps the offered unit, which is
   *   every case this screen produces — and where they would not, the server's
   *   answer is the one that decides.
   */
  function departs(line: PanelLine): boolean {
    if (line.quantity === '') return false;
    const typed = Number(line.quantity);
    const expected = Number(line.expectedQuantity);
    return !Number.isNaN(typed) && typed !== expected;
  }

  const used = lines.filter((line) => line.quantity !== '' && Number(line.quantity) > 0);
  const serialised = JSON.stringify(
    used.map((line) => ({
      templateLineId: line.templateLineId,
      productId: line.productId,
      quantity: line.quantity,
      unitId: line.unitId,
      overrideReason: line.overrideReason === '' ? null : line.overrideReason,
      /*
       * ⚠️ ONLY WHERE SOMEBODY ACTUALLY CHOSE — see `lotsChosen`. An untouched
       *   line sends nothing and the server plans it, which is both the ordinary
       *   case and the one where a stale browser snapshot must not become a
       *   refusal.
       */
      ...(line.lotsChosen
        ? {
            allocations: line.lots
              .filter((lot) => Number(lot.quantityBase) > 0)
              .map((lot) => ({
                locationId: lot.locationId,
                batchId: lot.batchId,
                serialId: lot.serialId,
                quantityBase: lot.quantityBase,
                overrideReason: lot.overrideReason === '' ? null : lot.overrideReason,
              })),
          }
        : {}),
    }))
  );

  const willDepart = used.some(departs);

  /**
   * A line whose chosen lots do not add up to what it says was used.
   *
   * ⚠️ THE SERVER REFUSES THIS ANYWAY — "a consumption whose lots do not add up
   *   is one nobody can trace" — and the check is repeated here only so the
   *   answer arrives before the round trip. ⚠️ IT COMPARES BASE UNITS AGAINST
   *   BASE UNITS ONLY WHEN THE LINE IS IN ITS BASE UNIT; where the template
   *   states a different unit the two scales differ and this stays quiet rather
   *   than guessing, because converting here would be a second conversion graph.
   */
  function lotsDisagree(line: PanelLine): boolean {
    if (!line.lotsChosen || line.quantity === '') return false;
    if (line.unitSymbol !== line.baseUnitSymbol) return false;
    return chosenBase(line) !== Number(line.quantity);
  }

  const anyLotsDisagree = used.some(lotsDisagree);

  return (
    <section className="border-rule bg-card mt-4 rounded-lg border p-5">
      <h2 className="eyebrow text-drape">What this used</h2>

      {records.length > 0 ? (
        <ul className="mt-3 space-y-2">
          {records.map((entry) => (
            <li key={entry.id} className="text-[0.9375rem]">
              <span className="text-ink">
                {entry.kind === 'CONSUMPTION_REVERSAL'
                  ? 'Put back'
                  : entry.kind === 'ADDITIONAL_CONSUMPTION'
                    ? 'More was used'
                    : 'Recorded'}
                : {entry.lineCount === 1 ? '1 item' : `${String(entry.lineCount)} items`}
              </span>
              <span className="text-muted"> — {entry.recordedByName}</span>
              <span className="text-muted">
                {' '}
                · {formatClinicDateTime(entry.occurredAt, timeZone)}
              </span>
              {entry.hasVariance ? (
                <span className="text-drape"> · differed from the template</span>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}

      {!canRecord ? (
        records.length === 0 ? (
          <p className="text-muted mt-3 text-[0.875rem]">
            Nothing has been recorded against this consultation.
          </p>
        ) : null
      ) : locations.length === 0 ? (
        <p className="text-muted mt-3 text-[0.875rem]">
          There is nowhere at this branch to draw materials from yet. Add a location under Stock
          first.
        </p>
      ) : (
        <form action={record} className="mt-4 space-y-4">
          <input type="hidden" name="encounterId" value={plan.encounterId} />
          <input type="hidden" name="branchId" value={plan.branchId} />
          {plan.encounterProcedureId === null ? null : (
            <input type="hidden" name="encounterProcedureId" value={plan.encounterProcedureId} />
          )}
          <input type="hidden" name="lines" value={serialised} />

          {state.status === 'error' ? <Alert tone="error">{state.message}</Alert> : null}
          {state.status === 'saved' ? (
            <Alert tone="success">Recorded. The stock has come off the shelf.</Alert>
          ) : null}

          {plan.templateId === null ? (
            <p className="text-muted text-[0.875rem]">
              This procedure has no template, so nothing is pre-filled. Record what was used.
            </p>
          ) : (
            <p className="text-muted text-[0.875rem]">
              Pre-filled from {plan.templateName} · version {plan.templateVersion}. Change anything
              that was not what happened.
            </p>
          )}

          {lines.length === 0 ? (
            <p className="border-rule text-muted rounded-md border border-dashed p-4 text-[0.875rem]">
              Nothing to pre-fill. Templates are set up under Usage.
            </p>
          ) : (
            <ul className="space-y-2">
              {lines.map((line) => {
                const differs = departs(line);
                return (
                  <li key={line.key} className="border-rule rounded-md border p-3">
                    <div className="flex flex-wrap items-end gap-3">
                      <span className="min-w-48 flex-1">
                        <span className="text-ink block text-[0.9375rem]">{line.productName}</span>
                        <span className="text-muted block text-[0.8125rem]">
                          {line.isOptional
                            ? 'Used sometimes — nothing is expected'
                            : `Expected ${line.expectedQuantity} ${line.unitSymbol}`}
                          {' · '}
                          {line.availableQuantityBase} {line.baseUnitSymbol} on the shelf
                        </span>
                      </span>

                      <label className="w-32 text-[0.8125rem]">
                        <span className="text-muted block pb-1">Used</span>
                        <input
                          inputMode="decimal"
                          className="border-rule bg-card text-ink w-full rounded-md border px-3 py-2 text-[0.875rem]"
                          value={line.quantity}
                          onChange={(event) => {
                            update(line.key, { quantity: event.target.value });
                          }}
                        />
                      </label>
                      <span className="text-muted pb-2 text-[0.8125rem]">{line.unitSymbol}</span>
                    </div>

                    {differs ? (
                      <label className="mt-3 block text-[0.8125rem]">
                        <span className="text-muted block pb-1">
                          Why this differs from the template
                        </span>
                        <input
                          className="border-rule bg-card text-ink w-full rounded-md border px-3 py-2 text-[0.875rem]"
                          value={line.overrideReason}
                          onChange={(event) => {
                            update(line.key, { overrideReason: event.target.value });
                          }}
                        />
                      </label>
                    ) : null}

                    {/*
                      ⚠️ THE LOT AND SERIAL PICKER (PI-9.9). Rendered only for
                        batch- or serial-tracked stock, because untracked stock
                        has one bucket and nothing to choose between — a
                        one-option picker on every glove is how a screen teaches
                        people to click past it.

                      ⚠️ AND IT IS A `<details>`, CLOSED BY DEFAULT ON EVERY LINE
                        BUT A SERIALISED ONE. FEFO is right almost always, and a
                        clinician working through a tray should not have to
                        dismiss a lot table per item. A numbered device is the
                        exception and opens: which one went into the patient is
                        the question the record exists to answer, and it is not
                        answerable later.
                    */}
                    {line.lots.length > 0 ? (
                      <details
                        className="mt-3"
                        open={line.lots.some((lot) => lot.serialId !== null)}
                      >
                        <summary className="text-muted cursor-pointer text-[0.8125rem]">
                          {line.lots.some((lot) => lot.serialId !== null)
                            ? 'Which one was used'
                            : 'Which lot it came from'}
                          {line.lotsChosen ? ' · chosen' : ' · oldest first'}
                        </summary>

                        <ul className="mt-2 space-y-2">
                          {line.lots.map((lot) => (
                            <li
                              key={lot.key}
                              className="flex flex-wrap items-end gap-3 border-l-2 border-rule pl-3"
                            >
                              <span className="min-w-40 flex-1">
                                <span className="text-ink block text-[0.875rem]">
                                  {lot.serialNumber ??
                                    (lot.lotNumber === null
                                      ? 'Untracked stock'
                                      : `Lot ${lot.lotNumber}`)}
                                </span>
                                <span className="text-muted block text-[0.8125rem]">
                                  {lot.expiresOn === null
                                    ? 'No expiry'
                                    : `Expires ${lot.expiresOn}`}
                                  {' · '}
                                  {lot.availableQuantityBase} {line.baseUnitSymbol} in{' '}
                                  {lot.locationName}
                                </span>
                              </span>

                              {lot.serialId === null ? (
                                <label className="w-28 text-[0.8125rem]">
                                  <span className="text-muted block pb-1">Take</span>
                                  <input
                                    inputMode="decimal"
                                    className="border-rule bg-card text-ink w-full rounded-md border px-3 py-2 text-[0.875rem]"
                                    value={lot.quantityBase}
                                    onChange={(event) => {
                                      updateLot(line.key, lot.key, {
                                        quantityBase: event.target.value,
                                      });
                                    }}
                                  />
                                </label>
                              ) : (
                                /*
                                  ⚠️ A SERIAL IS A CHECKBOX, NOT A QUANTITY. One
                                    numbered device is one device; a number field
                                    beside it invites "2", which the ledger then
                                    refuses in a way nobody standing at a chair
                                    can act on.
                                */
                                <label className="flex items-center gap-2 pb-2 text-[0.8125rem]">
                                  <input
                                    type="checkbox"
                                    checked={Number(lot.quantityBase) > 0}
                                    onChange={(event) => {
                                      updateLot(line.key, lot.key, {
                                        quantityBase: event.target.checked ? '1' : '0',
                                      });
                                    }}
                                  />
                                  <span className="text-ink">Used this one</span>
                                </label>
                              )}
                            </li>
                          ))}
                        </ul>

                        {lotsDisagree(line) ? (
                          <p className="text-danger mt-2 text-[0.8125rem]">
                            These add up to {chosenBase(line)} {line.baseUnitSymbol} and the line
                            says {line.quantity}. A consumption whose lots do not add up is one
                            nobody can trace.
                          </p>
                        ) : null}

                        {line.lotsChosen ? (
                          <label className="mt-2 block text-[0.8125rem]">
                            <span className="text-muted block pb-1">
                              Why not the lot the plan chose
                            </span>
                            <input
                              className="border-rule bg-card text-ink w-full rounded-md border px-3 py-2 text-[0.875rem]"
                              value={line.lots[0]?.overrideReason ?? ''}
                              onChange={(event) => {
                                /*
                                  One reason for the line, written onto every lot
                                  it sends: the server decides per allocation
                                  which of them actually departed from the plan,
                                  and asking a clinician for a reason per lot
                                  would ask the same question four times.
                                */
                                setLines((current) =>
                                  current.map((row) =>
                                    row.key === line.key
                                      ? {
                                          ...row,
                                          lots: row.lots.map((lot) => ({
                                            ...lot,
                                            overrideReason: event.target.value,
                                          })),
                                        }
                                      : row
                                  )
                                );
                              }}
                            />
                          </label>
                        ) : null}
                      </details>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          )}

          <label className="block text-[0.8125rem]">
            <span className="text-muted block pb-1">Where it came from</span>
            <select
              name="locationId"
              defaultValue={locations[0]?.id ?? ''}
              className="border-rule bg-card text-ink rounded-md border px-3 py-2 text-[0.875rem]"
            >
              {locations.map((location) => (
                <option key={location.id} value={location.id}>
                  {location.name}
                </option>
              ))}
            </select>
          </label>

          <label className="block text-[0.8125rem]">
            <span className="text-muted block pb-1">Anything worth noting</span>
            <input
              name="notes"
              className="border-rule bg-card text-ink w-full rounded-md border px-3 py-2 text-[0.875rem]"
            />
          </label>

          {willDepart && !canOverride ? (
            <Alert tone="warning">
              Recording a quantity different from the one expected needs the override permission,
              which you do not have. Ask a colleague who does rather than keying the expected figure
              — that would put a number in the ledger nobody used.
            </Alert>
          ) : null}

          <button
            type="submit"
            disabled={recording || used.length === 0 || anyLotsDisagree}
            className="bg-drape text-paper hover:bg-drape-deep rounded-md px-4 py-2 text-[0.875rem] font-medium disabled:opacity-50"
          >
            {recording ? 'Recording…' : 'Record what was used'}
          </button>
          <p className="text-muted text-[0.8125rem]">
            This takes the stock off the shelf. Correcting it afterwards is another entry, never an
            edit.
          </p>
        </form>
      )}
    </section>
  );
}
