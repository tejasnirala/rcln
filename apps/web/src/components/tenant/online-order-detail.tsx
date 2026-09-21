import Link from 'next/link';
import type { OnlineOrderDetail, OnlineOrderStatus } from '@rcln/contracts';
import { Alert } from '@/components/ui/alert';
import { Input, Textarea } from '@/components/ui/field';
import { formatClinicDateTime } from '@/lib/format';
import { ORDER_STATUS_LABEL } from '@/components/tenant/online-order-status';
import { OnlineOrderActionCard } from '@/components/tenant/online-order-action-card';
import {
  cancelOnlineOrderAction,
  confirmOnlineOrderAction,
  deliverOnlineOrderAction,
  failOnlineOrderDeliveryAction,
  packOnlineOrderAction,
  shipOnlineOrderAction,
} from '@/app/(tenant)/t/[slug]/(app)/pharmacy/orders/actions';

/**
 * One order, and the one thing that can happen to it next.
 *
 * ⚠️ THE RAIL IS THE SIGNATURE ELEMENT, AND IT IS HONEST STRUCTURE RATHER THAN
 *   DECORATION. An order really is a sequence — a parcel cannot be shipped
 *   before it is made up, and it cannot be made up before stock is held for it —
 *   so showing the stages in order and leaving the unreached ones visibly empty
 *   tells somebody where the order is without their having to read a status
 *   word. It is the same device `MaturityRail` uses, for the same reason, and it
 *   is deliberately the only loud thing on the page.
 *
 * ⚠️ EXACTLY ONE ACTION IS OFFERED AT A TIME, DERIVED FROM THE STATUS. A screen
 *   that showed every button and let the server refuse five of them would teach
 *   a dispensary to ignore refusals.
 *
 * ⚠️ AND THE ONE BUTTON THAT SUPPLIES IS GATED ON `canDispense`, NOT ON AN
 *   ONLINE FLAG. Making the parcel up writes the dispense and moves the ledger;
 *   it is the same act as handing medicine across the counter.
 *
 * ⚠️ PHI EVERYWHERE ON THIS PAGE — a name, a telephone number, a home address and
 *   a medicine on one screen. Nothing here is put in a URL or stored on the
 *   client.
 *
 * No colour carries meaning on its own: every stage is also a word (WCAG 1.4.1).
 *
 * ⚠️ THIS FILE IS A SERVER COMPONENT, AND THE CLIENT BOUNDARY IS ONE CARD DEEP.
 *   Everything here — the rail, the address, the lines, the shipment — is
 *   presentation over data the server already has. Only the action forms need
 *   `useActionState`, so only `OnlineOrderActionCard` is `'use client'`, and the
 *   actions reach it already bound. The first draft put `'use client'` at the
 *   top of this file and shipped the whole screen to the browser in order to run
 *   four `<form>`s (PI-12 review).
 */
const STAGES: { key: OnlineOrderStatus; label: string }[] = [
  { key: 'DRAFT', label: 'Taken' },
  { key: 'CONFIRMED', label: 'Accepted' },
  { key: 'PACKED', label: 'Made up' },
  { key: 'SHIPPED', label: 'With the courier' },
  { key: 'DELIVERED', label: 'Delivered' },
];

/**
 * Is anything actually held for this line?
 *
 * ⚠️ A STRING TEST, NOT `Number(...) > 0`. Every quantity on this surface is a
 *   decimal STRING and this stack is scrupulous about never putting one through
 *   a float. It is harmless at these magnitudes; the habit is what is worth
 *   keeping, not the arithmetic.
 */
function isHeld(quantityBase: string): boolean {
  return !/^0(\.0+)?$/.test(quantityBase);
}

function stageIndex(status: OnlineOrderStatus): number {
  /*
   * ⚠️ `DELIVERY_FAILED` SITS AT THE COURIER STAGE, NOT PAST IT. The parcel is
   *   with the carrier and has not arrived; drawing it as further along than
   *   SHIPPED would say the delivery is nearly done when the opposite is true.
   *   CANCELLED reaches nothing — an order stood down did not progress, it
   *   stopped.
   */
  if (status === 'DELIVERY_FAILED') return STAGES.findIndex((stage) => stage.key === 'SHIPPED');
  if (status === 'CANCELLED') return -1;
  return STAGES.findIndex((stage) => stage.key === status);
}

function StageRail({ status }: { status: OnlineOrderStatus }) {
  const reached = stageIndex(status);

  return (
    <ol className="flex flex-wrap items-stretch gap-x-1 gap-y-3">
      {STAGES.map((stage, index) => {
        const done = index <= reached;
        return (
          <li key={stage.key}>
            <div
              aria-hidden="true"
              className={
                done
                  ? 'bg-drape h-1 w-16 rounded-full sm:w-24'
                  : 'bg-rule h-1 w-16 rounded-full opacity-50 sm:w-24'
              }
            />
            <p
              className={
                done
                  ? 'text-ink mt-1.5 text-[0.75rem]'
                  : /* ⚠️ NO OPACITY. `text-muted` is already tuned for contrast and
                       12px is the size that can least afford a reduction —
                       AGENTS.md names this exact bug. The `sr-only` word below
                       carries the meaning, so the fade said nothing it did not
                       (WCAG 1.4.3). */
                    'text-muted mt-1.5 text-[0.75rem]'
              }
            >
              {stage.label}
              <span className="sr-only">{done ? ' — done' : ' — not yet'}</span>
            </p>
          </li>
        );
      })}
    </ol>
  );
}

interface Props {
  slug: string;
  order: OnlineOrderDetail;
  timezone: string;
  timeFormat: '12H' | '24H';
  canManage: boolean;
  canDispense: boolean;
  canDispatch: boolean;
}

export function OnlineOrderDetailScreen({
  slug,
  order,
  timezone,
  timeFormat,
  canManage,
  canDispense,
  canDispatch,
}: Props) {
  const when = (iso: string): string => formatClinicDateTime(iso, timezone, timeFormat);

  return (
    <div className="space-y-8">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-muted text-[0.8125rem]">
            <Link href="/pharmacy/orders" className="hover:text-ink">
              Deliveries
            </Link>
          </p>
          <h1 className="font-display text-ink mt-1 text-[1.75rem] leading-tight tracking-tight tabular-nums">
            {order.orderNumber ?? 'Not accepted yet'}
          </h1>
          <p className="text-muted mt-1 text-[0.875rem]">
            {order.patientName} · {order.patientUhid} · taken {when(order.placedAt)} by{' '}
            {order.placedByName}
          </p>
        </div>
        <span className="border-rule text-muted rounded-full border px-3 py-1 text-[0.8125rem]">
          {ORDER_STATUS_LABEL[order.status]}
        </span>
      </header>

      <section className="border-rule bg-card space-y-4 rounded-md border p-4">
        <h2 className="text-ink text-[0.9375rem] font-medium">
          {order.status === 'CANCELLED'
            ? 'Stood down before anything left the shelf'
            : `Where this order has got to: ${ORDER_STATUS_LABEL[order.status]}`}
        </h2>
        {order.status === 'CANCELLED' ? (
          <p className="text-muted max-w-prose text-[0.875rem]">
            {order.cancellationReason} — stood down{' '}
            {order.cancelledAt ? when(order.cancelledAt) : ''} by {order.cancelledByName}.
          </p>
        ) : (
          <StageRail status={order.status} />
        )}
        {order.status === 'DELIVERY_FAILED' ? (
          <Alert tone="warning">
            The courier could not deliver it. The parcel is still out — the stock has not come back
            to the shelf, and nothing here puts it there. When it physically returns, record a
            return against the dispense.
          </Alert>
        ) : null}
      </section>

      <div className="grid gap-4 lg:grid-cols-2">
        <section className="border-rule bg-card space-y-2 rounded-md border p-4">
          <h2 className="text-ink text-[0.9375rem] font-medium">Going to</h2>
          <p className="text-ink text-[0.875rem]">{order.address.recipientName}</p>
          <p className="text-muted text-[0.875rem]">{order.address.recipientPhone}</p>
          <address className="text-muted text-[0.875rem] not-italic">
            {order.address.addressLine1}
            {order.address.addressLine2 ? <>, {order.address.addressLine2}</> : null}
            <br />
            {[order.address.city, order.address.state, order.address.pincode]
              .filter(Boolean)
              .join(', ')}
            <br />
            {order.destination}
          </address>
        </section>

        <section className="border-rule bg-card space-y-2 rounded-md border p-4">
          <h2 className="text-ink text-[0.9375rem] font-medium">Packed from</h2>
          <p className="text-muted text-[0.875rem]">
            {order.locationName} at {order.branchName}
          </p>
          {order.dispenseId ? (
            <p className="text-[0.875rem]">
              <Link href={`/pharmacy/dispenses/${order.dispenseId}`} className="text-drape">
                {order.dispenseNumber}
              </Link>{' '}
              <span className="text-muted">— the supply this became</span>
            </p>
          ) : (
            <p className="text-muted text-[0.875rem]">
              Nothing has left the shelf yet. Making the parcel up is what dispenses it.
            </p>
          )}
          {order.notes ? <p className="text-muted text-[0.875rem]">{order.notes}</p> : null}
        </section>
      </div>

      <section className="space-y-2">
        <h2 className="text-ink text-[0.9375rem] font-medium">What was asked for</h2>
        <ul className="space-y-2">
          {order.lines.map((line) => (
            <li
              key={line.id}
              className="border-rule bg-card flex flex-wrap items-center gap-4 rounded-md border p-4"
            >
              <span className="text-ink min-w-48 flex-1 text-[0.9375rem]">{line.productName}</span>
              <span className="text-muted text-[0.875rem] tabular-nums">
                {line.quantityEntered} {line.unitSymbol}
              </span>
              <span className="text-muted text-[0.8125rem] tabular-nums">
                {isHeld(line.heldQuantityBase)
                  ? `${line.heldQuantityBase} ${line.baseUnitSymbol} held`
                  : order.status === 'DRAFT'
                    ? 'Nothing held yet'
                    : 'No stock held'}
              </span>
              {line.acceptanceDecision && line.acceptanceDecision.conditions.length > 0 ? (
                <span className="border-warning/40 text-warning rounded-full border px-3 py-1 text-[0.8125rem]">
                  {line.acceptanceDecision.conditions.length} obligation
                  {line.acceptanceDecision.conditions.length === 1 ? '' : 's'}
                </span>
              ) : null}
            </li>
          ))}
        </ul>

        {order.lines.some(
          (line) =>
            line.acceptanceDecision !== null && line.acceptanceDecision.conditions.length > 0
        ) ? (
          <Alert tone="warning">
            <p className="font-medium">These have to be done for the supply to be lawful.</p>
            <ul className="mt-2 list-disc space-y-1 pl-5">
              {order.lines.flatMap((line) =>
                /* Indexed: one line can carry two conditions of the same kind,
                   which the engine does produce. */
                (line.acceptanceDecision?.conditions ?? []).map((condition, index) => (
                  <li key={`${line.id}-${String(index)}`}>{condition.detail}</li>
                ))
              )}
            </ul>
          </Alert>
        ) : null}
      </section>

      {order.shipment ? (
        <section className="border-rule bg-card space-y-2 rounded-md border p-4">
          <h2 className="text-ink text-[0.9375rem] font-medium">The parcel</h2>
          <p className="text-muted text-[0.875rem]">
            {order.shipment.carrierName}
            {order.shipment.serviceLevel ? ` · ${order.shipment.serviceLevel}` : ''} ·{' '}
            {order.shipment.packageCount}{' '}
            {order.shipment.packageCount === 1 ? 'package' : 'packages'} · handed over{' '}
            {when(order.shipment.shippedAt)} by {order.shipment.shippedByName}
          </p>
          {order.shipment.trackingReference ? (
            <p className="text-ink text-[0.875rem] tabular-nums">
              {order.shipment.trackingReference}
            </p>
          ) : null}
          {order.shipment.failedAt ? (
            <p className="text-warning text-[0.875rem]">
              Attempt failed {when(order.shipment.failedAt)}: {order.shipment.failureReason}
            </p>
          ) : null}
          {order.shipment.deliveredAt ? (
            <p className="text-success text-[0.875rem]">
              Delivered {when(order.shipment.deliveredAt)}
              {order.shipment.receivedByName ? ` — taken by ${order.shipment.receivedByName}` : ''}
            </p>
          ) : null}
        </section>
      ) : null}

      <NextAction
        slug={slug}
        order={order}
        canManage={canManage}
        canDispense={canDispense}
        canDispatch={canDispatch}
      />
    </div>
  );
}

/** The one thing that can happen next, and who may do it. */
function NextAction({
  slug,
  order,
  canManage,
  canDispense,
  canDispatch,
}: {
  slug: string;
  order: OnlineOrderDetail;
  canManage: boolean;
  canDispense: boolean;
  canDispatch: boolean;
}) {
  switch (order.status) {
    case 'DRAFT':
      return canManage ? (
        <div className="grid gap-4 lg:grid-cols-2">
          <OnlineOrderActionCard
            title="Accept it and hold the stock"
            blurb="Asks the rules of this place about every line, then takes the lots out of available stock so the shelf cannot sell them to somebody else. This is where an order is refused if nobody has cleared a product for remote supply."
            submitLabel="Accept the order"
            action={confirmOnlineOrderAction.bind(null, slug, order.id)}
          >
            {(errors) => (
              <Input
                label="Hold the stock for"
                name="holdForDays"
                type="number"
                min={1}
                max={90}
                defaultValue={7}
                errors={errors?.['holdForDays']}
                hint="Days. After this the sweep gives the stock back — an order nobody has made up is medicine better off on the shelf."
              />
            )}
          </OnlineOrderActionCard>
          <OnlineOrderActionCard
            title="Stand it down"
            blurb="Closes the order. Nothing is held yet, so nothing is given back."
            submitLabel="Stand down"
            variant="secondary"
            action={cancelOnlineOrderAction.bind(null, slug, order.id)}
          >
            {(errors) => (
              <Textarea label="Why" name="reason" rows={2} required errors={errors?.['reason']} />
            )}
          </OnlineOrderActionCard>
        </div>
      ) : null;

    case 'CONFIRMED':
      return (
        <div className="grid gap-4 lg:grid-cols-2">
          {canDispense ? (
            <OnlineOrderActionCard
              title="Make the parcel up"
              blurb="This is the supply: it takes the held lots off the shelf, writes the dispense and puts the charge on the bill. It cannot be undone — a parcel that comes back is a return against the dispense."
              submitLabel="Pack it"
              action={packOnlineOrderAction.bind(null, slug, order.id)}
            >
              {(errors) => (
                <Textarea label="Notes" name="notes" rows={2} errors={errors?.['notes']} />
              )}
            </OnlineOrderActionCard>
          ) : null}
          {canManage ? (
            <OnlineOrderActionCard
              title="Stand it down"
              blurb="Releases every hold and puts the stock back on the shelf."
              submitLabel="Stand down"
              variant="secondary"
              action={cancelOnlineOrderAction.bind(null, slug, order.id)}
            >
              {(errors) => (
                <Textarea label="Why" name="reason" rows={2} required errors={errors?.['reason']} />
              )}
            </OnlineOrderActionCard>
          ) : null}
        </div>
      );

    case 'PACKED':
      return canDispatch ? (
        <OnlineOrderActionCard
          title="Hand it to a carrier"
          blurb="Who is carrying it, and the number the patient will quote back."
          submitLabel="Hand over"
          action={shipOnlineOrderAction.bind(null, slug, order.id)}
        >
          {(errors) => (
            <div className="grid gap-3 sm:grid-cols-2">
              <Input label="Carrier" name="carrierName" required errors={errors?.['carrierName']} />
              <Input label="Service" name="serviceLevel" errors={errors?.['serviceLevel']} />
              <Input
                label="Tracking number"
                name="trackingReference"
                errors={errors?.['trackingReference']}
              />
              <Input
                label="Packages"
                name="packageCount"
                type="number"
                min={1}
                defaultValue={1}
                errors={errors?.['packageCount']}
              />
            </div>
          )}
        </OnlineOrderActionCard>
      ) : null;

    case 'SHIPPED':
    case 'DELIVERY_FAILED':
      return canDispatch ? (
        <div className="grid gap-4 lg:grid-cols-2">
          <OnlineOrderActionCard
            title="It arrived"
            blurb="Closes the delivery out. A failed attempt before it is kept — it is not erased."
            submitLabel="Mark delivered"
            action={deliverOnlineOrderAction.bind(null, slug, order.id)}
          >
            {(errors) => (
              <Input
                label="Who took it"
                name="receivedByName"
                errors={errors?.['receivedByName']}
                hint="Only if it was not the person named on the order."
              />
            )}
          </OnlineOrderActionCard>
          {order.status === 'SHIPPED' ? (
            <OnlineOrderActionCard
              title="It could not be delivered"
              blurb="Records the attempt. The parcel is still out, so no stock comes back here — when it physically returns, record a return against the dispense."
              submitLabel="Record the attempt"
              variant="secondary"
              action={failOnlineOrderDeliveryAction.bind(null, slug, order.id)}
            >
              {(errors) => (
                <Textarea
                  label="What happened"
                  name="reason"
                  rows={2}
                  required
                  errors={errors?.['reason']}
                />
              )}
            </OnlineOrderActionCard>
          ) : null}
        </div>
      ) : null;

    default:
      return null;
  }
}
