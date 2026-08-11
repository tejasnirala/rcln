'use client';

import { useState, useTransition } from 'react';
import type { DiscountInputRequest, InvoiceDetail, UpdateInvoiceRequest } from '@rcln/contracts';
import { formatMoney, fromMajor, money, toMajorString } from '@rcln/payments/money';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Input, Select, Textarea } from '@/components/ui/field';
import { calendarDateIn } from '@/lib/calendar-range';
import { saveDraft, type InvoiceFormState } from '@/app/(tenant)/t/[slug]/(app)/invoices/actions';

/**
 * Editing a draft.
 *
 * ⚠️ IT HOLDS THE WHOLE DOCUMENT AND SENDS THE WHOLE DOCUMENT, BECAUSE PRICING
 *   IS A PROPERTY OF THE INVOICE AND NOT OF A LINE. A whole-bill discount is
 *   apportioned across every line before tax, so adding one line re-prices all
 *   of them — a per-line save would have to re-price the document anyway, and
 *   would additionally have to answer what happens when two cashiers hold the
 *   same bill open. `PUT /v1/invoices/:id` is the same arithmetic with none of
 *   that, and the priced answer it returns is what the screen then shows.
 *
 * ⚠️ AND THE NUMBERS ON SCREEN WHILE TYPING ARE NOT THE INVOICE'S NUMBERS. There
 *   is no client-side pricing here on purpose: apportionment, largest-remainder
 *   rounding, per-currency precision and the effective-dated tax rule all live
 *   in the engine, and a second implementation in the browser would be wrong in
 *   ways nobody would notice until a return was filed. The line extension shown
 *   beside each row is quantity × price and says so; every other figure comes
 *   back from the server after a save.
 *
 * ⚠️ MONEY IS TYPED IN MAJOR UNITS AND TRAVELS IN MINOR ONES. A cashier types
 *   `500` and means five hundred rupees; the wire carries `50000`. `fromMajor`
 *   does the conversion and REFUSES a value with too many decimals for the
 *   currency rather than rounding it silently — a rounded price is a bill that
 *   does not add up to what was agreed.
 */
export function InvoiceDraftEditor({
  slug,
  invoice,
  timezone,
  onDone,
}: {
  slug: string;
  invoice: InvoiceDetail;
  /** The branch's zone. Decides which calendar day the stored instants fall on. */
  timezone: string;
  /** Leave the editor. Called on a successful save and on Discard. */
  onDone: () => void;
}) {
  const [state, setState] = useState<InvoiceFormState>({ status: 'idle' });
  const [pending, startTransition] = useTransition();

  const [customer, setCustomer] = useState({
    name: invoice.customerName,
    phone: invoice.customerPhone ?? '',
    email: invoice.customerEmail ?? '',
    address: invoice.customerAddress ?? '',
    taxId: invoice.customerTaxId ?? '',
  });

  /*
   * ⚠️ THE STORED INSTANT READ BACK INTO THE BRANCH'S CALENDAR DAY, NOT
   *   `slice(0, 10)`. The API turned `suppliedOn` into local MIDDAY precisely so
   *   it lands on the intended day in the branch's zone; slicing the ISO string
   *   would read it in UTC, which is the same day for midday but a different one
   *   the moment anybody stores anything else there. Getting this wrong re-dates
   *   the invoice — and with it the tax rule it is priced under — on a save
   *   where nobody touched the field.
   */
  const [suppliedOn, setSuppliedOn] = useState(calendarDateIn(invoice.suppliedAt, timezone));
  /*
   * ⚠️ AND THE DUE DATE IS SLICED, NOT CONVERTED — THE TWO COLUMNS ARE NOT THE
   *   SAME KIND OF THING. `supplied_at` is a `timestamptz` holding local midday
   *   in the branch's zone, so which day it falls on is a question about a zone.
   *   `due_date` is a `DATE`, which Prisma hands back as UTC midnight and which
   *   has no zone at all: running it through `calendarDateIn` would report the
   *   previous day for every clinic west of Greenwich, and would then SAVE that
   *   day back. A calendar date read as a calendar date is `slice(0, 10)`.
   */
  const [dueDate, setDueDate] = useState(invoice.dueDate?.slice(0, 10) ?? '');
  const [notes, setNotes] = useState(invoice.notes ?? '');

  const [lines, setLines] = useState<EditableLine[]>(() =>
    invoice.items.map((item) => ({
      key: item.id,
      description: item.description,
      taxCategory: item.taxCategory,
      itemCode: item.itemCode ?? '',
      quantity: item.quantity,
      unitPrice: toMajorString(money(item.unitPriceMinor, invoice.currency)),
    }))
  );

  const [discount, setDiscount] = useState<EditableDiscount>(() =>
    toEditable(invoice.discount, invoice.currency)
  );

  const fieldErrors = state.fieldErrors ?? {};
  const err = (name: string): string[] | undefined => fieldErrors[name];

  function setLine(index: number, changes: Partial<EditableLine>): void {
    setLines((current) =>
      current.map((line, at) => (at === index ? { ...line, ...changes } : line))
    );
  }

  function addLine(): void {
    setLines((current) => [
      ...current,
      {
        // Not the array index: removing the middle row would renumber the rest
        // and React would reuse the wrong input's DOM node, carrying a typed
        // value onto a different line.
        key: `new-${crypto.randomUUID()}`,
        description: '',
        /*
         * The tax category is required and there is no sensible default the
         * clinic did not choose — it is matched EXACTLY against
         * `tax_rules.tax_category` and a guess would either fail to match (an
         * unrated line, which refuses to issue) or match something the clinic
         * meant for a different kind of item. The first line of an appointment
         * invoice already carries the right one; a hand-added line inherits it
         * rather than inventing one.
         */
        taxCategory: current[0]?.taxCategory ?? '',
        itemCode: '',
        quantity: '1',
        unitPrice: '',
      },
    ]);
  }

  function submit(): void {
    /*
     * The conversion to minor units happens here rather than per keystroke so a
     * half-typed `12.` is not a validation error while somebody is still typing
     * it. `fromMajor` throws on a value the currency cannot hold, and that is
     * reported against the line rather than thrown at the page.
     */
    const priced: { lines: UpdateInvoiceRequest['lines']; errors: Record<string, string[]> } = {
      lines: [],
      errors: {},
    };

    lines.forEach((line, index) => {
      try {
        priced.lines.push({
          description: line.description.trim(),
          taxCategory: line.taxCategory.trim(),
          ...(line.itemCode.trim() === '' ? {} : { itemCode: line.itemCode.trim() }),
          quantity: line.quantity.trim(),
          unitPriceMinor: fromMajor(
            line.unitPrice.trim() === '' ? '0' : line.unitPrice,
            invoice.currency
          ).amountMinor,
        });
      } catch {
        priced.errors[`lines.${index}.unitPriceMinor`] = [
          `Enter an amount in ${invoice.currency}, with no more decimals than the currency has.`,
        ];
      }
    });

    if (Object.keys(priced.errors).length > 0) {
      setState({
        status: 'error',
        message: 'Check the highlighted amounts.',
        fieldErrors: priced.errors,
      });
      return;
    }

    let wholeBill: DiscountInputRequest | undefined;
    if (discount.type === 'PERCENTAGE' && discount.value.trim() !== '') {
      // Basis points on the wire, percent in the box: 10% is 1000, and the
      // cashier should never have to know that.
      wholeBill = { type: 'PERCENTAGE', bps: Math.round(Number(discount.value) * 100) };
    } else if (discount.type === 'FIXED' && discount.value.trim() !== '') {
      try {
        wholeBill = {
          type: 'FIXED',
          amountMinor: fromMajor(discount.value, invoice.currency).amountMinor,
        };
      } catch {
        setState({
          status: 'error',
          message: 'Check the discount.',
          fieldErrors: { 'discount.amountMinor': ['Enter an amount, or clear the field.'] },
        });
        return;
      }
    }

    const body: UpdateInvoiceRequest = {
      ...(invoice.patientId ? { patientId: invoice.patientId } : {}),
      customer: {
        name: customer.name.trim(),
        ...(customer.phone.trim() === '' ? {} : { phone: customer.phone.trim() }),
        ...(customer.email.trim() === '' ? {} : { email: customer.email.trim() }),
        ...(customer.address.trim() === '' ? {} : { address: customer.address.trim() }),
        ...(customer.taxId.trim() === '' ? {} : { taxId: customer.taxId.trim() }),
      },
      suppliedOn,
      ...(dueDate === '' ? {} : { dueDate }),
      currency: invoice.currency,
      lines: priced.lines,
      ...(wholeBill ? { discount: wholeBill } : {}),
      ...(notes.trim() === '' ? {} : { notes: notes.trim() }),
    };

    startTransition(async () => {
      const outcome = await saveDraft(slug, invoice.id, body);
      setState(outcome);
      if (outcome.status === 'done') onDone();
    });
  }

  return (
    <form
      className="space-y-8"
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      {state.status === 'error' && state.message ? (
        <Alert tone="error">{state.message}</Alert>
      ) : null}

      <section className="border-rule bg-card space-y-4 rounded-lg border p-5">
        <h2 className="text-ink font-display text-lg">Billed to</h2>
        <p className="text-muted -mt-2 text-sm">
          {/* The snapshot rule, in one sentence a cashier can act on. */}
          What the document prints. Changing it here does not change the patient&rsquo;s record, and
          updating the record later does not change an invoice already raised.
        </p>
        <div className="grid gap-4 sm:grid-cols-2">
          <Input
            name="customer.name"
            label="Name"
            required
            value={customer.name}
            onChange={(event) => setCustomer({ ...customer, name: event.target.value })}
            errors={err('customer.name')}
          />
          <Input
            name="customer.phone"
            label="Phone"
            inputMode="tel"
            value={customer.phone}
            onChange={(event) => setCustomer({ ...customer, phone: event.target.value })}
            errors={err('customer.phone')}
          />
          <Input
            name="customer.email"
            label="Email"
            type="email"
            value={customer.email}
            onChange={(event) => setCustomer({ ...customer, email: event.target.value })}
            errors={err('customer.email')}
          />
          <Input
            name="customer.taxId"
            label="Customer tax number"
            hint="Only on a bill raised to a business."
            className="font-mono"
            value={customer.taxId}
            onChange={(event) => setCustomer({ ...customer, taxId: event.target.value })}
            errors={err('customer.taxId')}
          />
          <Textarea
            name="customer.address"
            label="Address"
            rows={2}
            fieldClassName="sm:col-span-2"
            value={customer.address}
            onChange={(event) => setCustomer({ ...customer, address: event.target.value })}
            errors={err('customer.address')}
          />
        </div>
      </section>

      <section className="border-rule bg-card space-y-4 rounded-lg border p-5">
        <h2 className="text-ink font-display text-lg">Dates</h2>
        <div className="grid gap-4 sm:grid-cols-2">
          <Input
            name="suppliedOn"
            label="Date of supply"
            type="date"
            required
            /*
             * ⚠️ THE DATE THAT DECIDES THE TAX, NOT THE DATE OF ISSUE. It selects
             *   the effective-dated rule and the registration, so a bill raised
             *   in April for a March consultation is taxed as March was. Saying
             *   so here is the difference between a cashier correcting it and a
             *   cashier assuming it is decoration.
             */
            hint="When the care was given. This is what the tax is worked out from."
            value={suppliedOn}
            onChange={(event) => setSuppliedOn(event.target.value)}
            errors={err('suppliedOn')}
          />
          <Input
            name="dueDate"
            label="Payment due"
            type="date"
            hint="Leave empty for a bill settled at the counter."
            value={dueDate}
            onChange={(event) => setDueDate(event.target.value)}
            errors={err('dueDate')}
          />
        </div>
      </section>

      <section className="border-rule bg-card space-y-4 rounded-lg border p-5">
        <div className="flex items-center justify-between gap-4">
          <h2 className="text-ink font-display text-lg">Lines</h2>
          <Button variant="secondary" size="sm" onClick={addLine}>
            Add a line
          </Button>
        </div>

        <ul className="space-y-4">
          {lines.map((line, index) => (
            <li key={line.key} className="border-rule rounded-md border p-4">
              <div className="grid gap-4 sm:grid-cols-6">
                <Input
                  name={`lines.${index}.description`}
                  label="Description"
                  required
                  fieldClassName="sm:col-span-3"
                  value={line.description}
                  onChange={(event) => setLine(index, { description: event.target.value })}
                  errors={err(`lines.${index}.description`)}
                />
                <Input
                  name={`lines.${index}.taxCategory`}
                  label="Tax category"
                  required
                  /*
                   * ⚠️ NOT THE SAME STRING AS THE ITEM CODE, AND FUSING THEM IS
                   *   THE BUG THE TWO FIELDS PREVENT. This is matched exactly
                   *   against the clinic's tax rules and decides what is
                   *   charged; the code beside it is printed and decides
                   *   nothing.
                   */
                  hint="Decides the rate."
                  fieldClassName="sm:col-span-2"
                  className="font-mono"
                  value={line.taxCategory}
                  onChange={(event) => setLine(index, { taxCategory: event.target.value })}
                  errors={err(`lines.${index}.taxCategory`)}
                />
                <Input
                  name={`lines.${index}.itemCode`}
                  label="HSN / SAC"
                  hint="Printed only."
                  className="font-mono"
                  value={line.itemCode}
                  onChange={(event) => setLine(index, { itemCode: event.target.value })}
                  errors={err(`lines.${index}.itemCode`)}
                />
                <Input
                  name={`lines.${index}.quantity`}
                  label="Quantity"
                  inputMode="decimal"
                  required
                  hint="Up to three decimals."
                  value={line.quantity}
                  onChange={(event) => setLine(index, { quantity: event.target.value })}
                  errors={err(`lines.${index}.quantity`)}
                />
                <Input
                  name={`lines.${index}.unitPriceMinor`}
                  label={`Unit price (${invoice.currency})`}
                  inputMode="decimal"
                  required
                  fieldClassName="sm:col-span-2"
                  className="text-right font-mono"
                  value={line.unitPrice}
                  onChange={(event) => setLine(index, { unitPrice: event.target.value })}
                  errors={err(`lines.${index}.unitPriceMinor`)}
                />
                <div className="flex items-end justify-between gap-3 sm:col-span-3">
                  <p className="text-muted text-sm">
                    {/*
                     * Quantity × price, and labelled as exactly that. It is NOT
                     * the line total: discounts and tax are the engine's, and
                     * showing a guess at them here would be a second pricing
                     * implementation that nobody would notice going wrong.
                     */}
                    <span className="text-muted">Before discount and tax: </span>
                    <span className="text-ink font-mono">{extension(line, invoice.currency)}</span>
                  </p>
                  {lines.length > 1 ? (
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => setLines((current) => current.filter((_, at) => at !== index))}
                    >
                      Remove line
                    </Button>
                  ) : null}
                </div>
              </div>
            </li>
          ))}
        </ul>
      </section>

      <section className="border-rule bg-card space-y-4 rounded-lg border p-5">
        <h2 className="text-ink font-display text-lg">Discount on the whole bill</h2>
        <p className="text-muted -mt-2 max-w-prose text-sm">
          {/*
           * ⚠️ APPORTIONED ONTO THE LINES BEFORE TAX, WHICH IS A DECISION AND
           *   NOT AN IMPLEMENTATION DETAIL. Taking it off the total afterwards
           *   would charge tax on money nobody paid. Saying so here is cheaper
           *   than a cashier discovering it in the tax summary.
           */}
          Spread across the lines before tax is worked out, so the tax is charged on what is
          actually being paid.
        </p>
        <div className="grid gap-4 sm:grid-cols-2">
          <Select
            name="discount.type"
            label="How"
            value={discount.type}
            onChange={(event) =>
              setDiscount({ type: event.target.value as EditableDiscount['type'], value: '' })
            }
            options={[
              { value: 'NONE', label: 'No discount' },
              { value: 'PERCENTAGE', label: 'A percentage' },
              { value: 'FIXED', label: 'An amount' },
            ]}
          />
          {discount.type === 'NONE' ? null : (
            <Input
              name={discount.type === 'PERCENTAGE' ? 'discount.bps' : 'discount.amountMinor'}
              label={
                discount.type === 'PERCENTAGE' ? 'Percent off' : `Amount off (${invoice.currency})`
              }
              inputMode="decimal"
              className="text-right font-mono"
              value={discount.value}
              onChange={(event) => setDiscount({ ...discount, value: event.target.value })}
              errors={err('discount.bps') ?? err('discount.amountMinor') ?? err('discount')}
            />
          )}
        </div>
      </section>

      <section className="border-rule bg-card space-y-4 rounded-lg border p-5">
        <Textarea
          name="notes"
          label="Notes on the bill"
          rows={3}
          hint="Printed on the document. Never anything clinical."
          value={notes}
          onChange={(event) => setNotes(event.target.value)}
          errors={err('notes')}
        />
      </section>

      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" disabled={pending}>
          {pending ? 'Saving…' : 'Save the draft'}
        </Button>
        <Button variant="ghost" onClick={onDone} disabled={pending}>
          Discard changes
        </Button>
        <p className="text-muted text-sm">
          Saving re-prices the whole bill and updates the preview.
        </p>
      </div>
    </form>
  );
}

interface EditableLine {
  key: string;
  description: string;
  taxCategory: string;
  itemCode: string;
  quantity: string;
  /** Major units, as typed. Converted on save — see the header. */
  unitPrice: string;
}

interface EditableDiscount {
  type: 'NONE' | 'PERCENTAGE' | 'FIXED';
  /** Percent, or major units, depending on `type`. Empty means none. */
  value: string;
}

/**
 * The stored discount, back into the boxes it was typed in.
 *
 * ⚠️ `toMajorString` AND NOT `/ 100`, BECAUSE NOT EVERY CURRENCY HAS TWO
 *   DECIMALS. A fixed discount of ¥500 is 500 minor units, and dividing it by a
 *   hundred would re-open the draft showing ¥5 — then save that. The percentage
 *   IS `/ 100`, and that is not the same division: basis points are basis
 *   points in every currency there is.
 */
function toEditable(discount: InvoiceDetail['discount'], currency: string): EditableDiscount {
  if (discount === null) return { type: 'NONE', value: '' };
  return discount.type === 'PERCENTAGE'
    ? { type: 'PERCENTAGE', value: String(discount.bps / 100) }
    : { type: 'FIXED', value: toMajorString(money(discount.amountMinor, currency)) };
}

/**
 * Quantity × price, for the row the cashier is typing in.
 *
 * Returns a dash rather than a zero while either field is unusable: a zero here
 * would read as "this line is free", which is a claim, where a dash is the
 * absence of one. Nothing is computed from this — it is not sent anywhere.
 */
function extension(line: EditableLine, currency: string): string {
  const quantity = Number(line.quantity);
  if (!Number.isFinite(quantity) || line.unitPrice.trim() === '') return '—';
  try {
    const unit = fromMajor(line.unitPrice, currency);
    return formatMoney(money(Math.round(unit.amountMinor * quantity), currency));
  } catch {
    return '—';
  }
}
