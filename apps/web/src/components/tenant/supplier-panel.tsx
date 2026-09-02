'use client';

import Link from 'next/link';
import { useActionState, useState } from 'react';
import type { SupplierDetail, SupplierProductListResponse, UnitSummary } from '@rcln/contracts';
import { Input, Select } from '@/components/ui/field';
import { Button } from '@/components/ui/button';
import { Alert } from '@/components/ui/alert';
import { ProcurementNav } from '@/components/tenant/procurement-nav';
import { ProductPicker } from '@/components/tenant/product-picker';
import {
  addSupplierProductAction,
  addTaxIdentifierAction,
  IDLE_FORM,
  removeSupplierProductAction,
  removeTaxIdentifierAction,
  type ProcurementFormState,
} from '@/app/(tenant)/t/[slug]/(app)/procurement/actions';

/**
 * One supplier: who they are, their tax numbers, and what they sell us for how much.
 *
 * ⚠️ THE PRICE BOOK IS THE POINT OF THIS SCREEN, NOT THE ADDRESS. Without a priced
 *   row a buyer re-enters the pack conversion by hand on every order line, and every
 *   one of those is a chance to order ten times too many. The address is reference;
 *   the price book is the working part.
 *
 * ⚠️ THE TAX NUMBERS PRICE NOTHING AND THE COPY SAYS SO. They go on the purchase
 *   document and into a supplier report; what the clinic charges its patients is the
 *   Tax screen and has nothing to do with these.
 *
 * NO PHI.
 */
const SCHEMES = [
  { value: 'GST', label: 'GST' },
  { value: 'VAT', label: 'VAT' },
  { value: 'SALES_TAX', label: 'Sales tax' },
];

interface Props {
  slug: string;
  supplier: SupplierDetail;
  priceBook: SupplierProductListResponse['supplierProducts'];
  units: UnitSummary[];
  canManage: boolean;
  /** True when the product list was capped. Drives the honest hint. */
}

export function SupplierPanel({ slug, supplier, priceBook, units, canManage }: Props) {
  const [taxState, taxAction, taxPending] = useActionState<ProcurementFormState, FormData>(
    addTaxIdentifierAction.bind(null, slug, supplier.id),
    IDLE_FORM
  );
  const [priceState, priceAction, pricePending] = useActionState<ProcurementFormState, FormData>(
    addSupplierProductAction.bind(null, slug, supplier.id),
    IDLE_FORM
  );

  const [showTaxForm, setShowTaxForm] = useState(false);
  const [showPriceForm, setShowPriceForm] = useState(false);

  const taxErr = (name: string): string[] | undefined => taxState.fieldErrors?.[name];
  const priceErr = (name: string): string[] | undefined => priceState.fieldErrors?.[name];

  return (
    <div className="space-y-8">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="font-display text-ink text-[1.75rem] leading-tight tracking-tight">
            {supplier.name}
          </h1>
          <p className="text-muted mt-1 font-mono text-[0.8125rem]">
            {supplier.code}
            {supplier.status !== 'ACTIVE'
              ? ` · ${supplier.status === 'ON_HOLD' ? 'on hold' : 'blacklisted'}`
              : ''}
          </p>
        </div>
        {canManage ? (
          <Link
            href={`/procurement/suppliers/${supplier.id}/edit`}
            className="border-rule text-ink hover:bg-drape-tint/50 inline-flex items-center justify-center rounded-md border px-5 py-3 text-[0.9375rem] font-medium transition-colors"
          >
            Edit details
          </Link>
        ) : null}
      </header>

      <ProcurementNav />

      {supplier.status === 'BLACKLISTED' ? (
        <Alert tone="warning">
          Nothing can be ordered from or returned to this supplier while they are blacklisted.
          Change the status on their details if that is no longer the case.
        </Alert>
      ) : null}

      <section className="border-rule bg-card grid gap-x-8 gap-y-3 rounded-md border p-4 sm:grid-cols-2">
        <Detail label="Registered name" value={supplier.legalName} />
        <Detail label="Contact" value={supplier.contactPerson} />
        <Detail label="Phone" value={supplier.phone} />
        <Detail label="Email" value={supplier.email} />
        <Detail
          label="Address"
          value={
            [
              supplier.addressLine1,
              supplier.addressLine2,
              supplier.city,
              supplier.regionCode,
              supplier.postalCode,
              supplier.countryCode,
            ]
              .filter((part) => part !== null && part !== '')
              .join(', ') || null
          }
        />
        <Detail label="Currency" value={supplier.defaultCurrency} />
        <Detail
          label="Payment terms"
          value={
            supplier.paymentTermsDays === null ? null : `${supplier.paymentTermsDays} days to pay`
          }
        />
        <Detail
          label="Lead time"
          value={supplier.leadTimeDays === null ? null : `${supplier.leadTimeDays} days`}
        />
        {supplier.notes ? (
          <div className="sm:col-span-2">
            <Detail label="Notes" value={supplier.notes} />
          </div>
        ) : null}
      </section>

      {/* ---------------------------------------------------------------- */}
      <section className="space-y-3">
        <div className="border-rule flex flex-wrap items-baseline justify-between gap-2 border-b pb-2">
          <h2 className="text-ink text-[0.9375rem] font-medium">Tax numbers</h2>
          <p className="text-muted text-[0.75rem]">
            Recorded for the purchase document. These do not price anything.
          </p>
        </div>

        {taxState.status === 'error' && taxState.message ? (
          <Alert tone="error">{taxState.message}</Alert>
        ) : null}

        {supplier.taxIdentifiers.length === 0 ? (
          <p className="text-muted text-[0.875rem]">None recorded.</p>
        ) : (
          <ul className="border-rule divide-rule bg-card divide-y rounded-md border">
            {supplier.taxIdentifiers.map((id) => (
              <li key={id.id} className="flex flex-wrap items-baseline gap-x-3 px-4 py-3">
                <span className="text-ink font-mono text-[0.875rem]">{id.registrationNumber}</span>
                <span className="text-muted text-[0.75rem]">
                  {id.scheme} · {id.countryCode}
                  {id.regionCode ? `-${id.regionCode}` : ''}
                </span>
                <span className="text-muted text-[0.75rem]">
                  from {id.effectiveFrom}
                  {id.effectiveTo ? ` to ${id.effectiveTo}` : ''}
                </span>
                {canManage ? (
                  <form
                    action={async () => {
                      await removeTaxIdentifierAction(slug, supplier.id, id.id);
                    }}
                    className="ml-auto"
                  >
                    <Button type="submit" variant="secondary">
                      Remove
                    </Button>
                  </form>
                ) : null}
              </li>
            ))}
          </ul>
        )}

        {canManage ? (
          showTaxForm ? (
            <form
              action={taxAction}
              className="border-rule bg-card space-y-3 rounded-md border p-4"
            >
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                <Input
                  label="Number"
                  name="registrationNumber"
                  required
                  errors={taxErr('registrationNumber')}
                  hint="Exactly as printed on their invoice."
                />
                <Select
                  label="Scheme"
                  name="scheme"
                  defaultValue="GST"
                  options={SCHEMES}
                  errors={taxErr('scheme')}
                />
                <Input
                  label="Country"
                  name="countryCode"
                  required
                  defaultValue={supplier.countryCode ?? ''}
                  errors={taxErr('countryCode')}
                  placeholder="IN"
                />
                <Input
                  label="State or region"
                  name="regionCode"
                  defaultValue={supplier.regionCode ?? ''}
                  errors={taxErr('regionCode')}
                  hint="Blank means country-wide."
                />
                <Input
                  label="In force from"
                  name="effectiveFrom"
                  type="date"
                  required
                  errors={taxErr('effectiveFrom')}
                />
                <Input
                  label="Until"
                  name="effectiveTo"
                  type="date"
                  errors={taxErr('effectiveTo')}
                  hint="Blank while it is current."
                />
              </div>
              <div className="flex gap-3">
                <Button type="submit" disabled={taxPending}>
                  {taxPending ? 'Saving…' : 'Record number'}
                </Button>
                <Button type="button" variant="secondary" onClick={() => setShowTaxForm(false)}>
                  Cancel
                </Button>
              </div>
            </form>
          ) : (
            <Button type="button" variant="secondary" onClick={() => setShowTaxForm(true)}>
              Record a tax number
            </Button>
          )
        ) : null}
      </section>

      {/* ---------------------------------------------------------------- */}
      <section className="space-y-3">
        <div className="border-rule flex flex-wrap items-baseline justify-between gap-2 border-b pb-2">
          <h2 className="text-ink text-[0.9375rem] font-medium">Price book</h2>
          <p className="text-muted text-[0.75rem]">What they sell us, in their packs</p>
        </div>

        {priceState.status === 'error' && priceState.message ? (
          <Alert tone="error">{priceState.message}</Alert>
        ) : null}

        {priceBook.length === 0 ? (
          <div className="border-rule bg-card rounded-md border p-8 text-center">
            <p className="text-ink text-[0.9375rem]">Nothing priced yet.</p>
            <p className="text-muted mx-auto mt-2 max-w-md text-[0.875rem]">
              Record what they charge per pack and how many units are in one. Order lines then price
              themselves, instead of somebody converting boxes to capsules by hand.
            </p>
          </div>
        ) : (
          <ul className="border-rule divide-rule bg-card divide-y rounded-md border">
            {priceBook.map((row) => (
              <li key={row.id} className="px-4 py-3.5">
                <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                  <span className="text-ink text-[0.9375rem] font-medium">{row.productName}</span>
                  <span className="text-muted font-mono text-[0.75rem]">{row.supplierSku}</span>
                  {row.isPreferred ? (
                    <span className="text-drape border-drape/30 rounded-xs border px-1.5 py-0.5 text-[0.6875rem]">
                      Preferred
                    </span>
                  ) : null}
                  {!row.isActive ? (
                    <span className="text-muted border-rule rounded-xs border px-1.5 py-0.5 text-[0.6875rem]">
                      Not offered
                    </span>
                  ) : null}
                  {canManage ? (
                    <form
                      action={async () => {
                        await removeSupplierProductAction(slug, row.id, supplier.id);
                      }}
                      className="ml-auto"
                    >
                      <Button type="submit" variant="secondary">
                        Remove
                      </Button>
                    </form>
                  ) : null}
                </div>
                <p className="text-muted mt-1 text-[0.8125rem]">
                  {row.currency} {(row.pricePerPackMinor / 100).toFixed(2)} per {row.packUnitSymbol}{' '}
                  of {row.quantityPerPack} {row.baseUnitSymbol}
                  {' · '}
                  {row.currency} {(row.unitCostBase / 100).toFixed(2)} per {row.baseUnitSymbol}
                  {row.leadTimeDays === null ? '' : ` · ${row.leadTimeDays} day lead time`}
                </p>
                <p className="text-muted mt-0.5 text-[0.75rem]">
                  Priced from {row.priceEffectiveFrom}
                  {row.priceEffectiveTo ? ` to ${row.priceEffectiveTo}` : ''}
                  {row.minimumOrderPacks === null
                    ? ''
                    : ` · minimum ${row.minimumOrderPacks} ${row.packUnitSymbol}`}
                </p>
              </li>
            ))}
          </ul>
        )}

        {canManage ? (
          showPriceForm ? (
            <form
              action={priceAction}
              className="border-rule bg-card space-y-3 rounded-md border p-4"
            >
              <div className="grid gap-3 sm:grid-cols-2">
                <ProductPicker
                  slug={slug}
                  label="Product"
                  name="productId"
                  required
                  filters={{ isStockItem: true, status: 'ACTIVE' }}
                  errors={priceErr('productId')}
                  hint="Name, code, brand or barcode."
                />
                <Input
                  label="Their code"
                  name="supplierSku"
                  required
                  errors={priceErr('supplierSku')}
                  hint="The catalogue number they quote back on their invoice."
                />
                <Select
                  label="They sell it by the"
                  name="packUnitId"
                  required
                  options={[
                    { value: '', label: 'Choose a unit' },
                    ...units.map((u) => ({ value: u.id, label: `${u.name} (${u.symbol})` })),
                  ]}
                  errors={priceErr('packUnitId')}
                  hint="The word for one of their packs — box, case, vial."
                />
                <Input
                  label="Units in one pack"
                  name="quantityPerPack"
                  required
                  inputMode="decimal"
                  errors={priceErr('quantityPerPack')}
                  hint="In the product’s own unit. A box of 10 strips of 10 is 100."
                />
                <Input
                  label="Price per pack"
                  name="pricePerPack"
                  required
                  inputMode="decimal"
                  errors={priceErr('pricePerPackMinor')}
                  hint="What one pack costs."
                />
                <Input
                  label="Currency"
                  name="currency"
                  required
                  defaultValue={supplier.defaultCurrency ?? ''}
                  errors={priceErr('currency')}
                  placeholder="INR"
                />
                <Input
                  label="Priced from"
                  name="priceEffectiveFrom"
                  type="date"
                  required
                  errors={priceErr('priceEffectiveFrom')}
                />
                <Input
                  label="Until"
                  name="priceEffectiveTo"
                  type="date"
                  errors={priceErr('priceEffectiveTo')}
                  hint="Blank while it is current."
                />
                <Input
                  label="Lead time"
                  name="leadTimeDays"
                  inputMode="numeric"
                  errors={priceErr('leadTimeDays')}
                  hint="Days for this item, if it differs."
                />
                <Input
                  label="Minimum order"
                  name="minimumOrderPacks"
                  inputMode="decimal"
                  errors={priceErr('minimumOrderPacks')}
                  hint="In packs. Advice, not enforced."
                />
              </div>
              <label className="text-ink flex items-center gap-2 py-2 text-[0.875rem]">
                <input type="checkbox" name="isPreferred" className="size-4" />
                Offer this supplier first for this product
              </label>
              <div className="flex gap-3">
                <Button type="submit" disabled={pricePending}>
                  {pricePending ? 'Saving…' : 'Add to price book'}
                </Button>
                <Button type="button" variant="secondary" onClick={() => setShowPriceForm(false)}>
                  Cancel
                </Button>
              </div>
            </form>
          ) : (
            <Button type="button" variant="secondary" onClick={() => setShowPriceForm(true)}>
              Add a priced product
            </Button>
          )
        ) : null}
      </section>
    </div>
  );
}

function Detail({ label, value }: { label: string; value: string | null }) {
  return (
    <div>
      <dt className="text-muted text-[0.75rem]">{label}</dt>
      <dd className="text-ink mt-0.5 text-[0.875rem]">{value ?? '—'}</dd>
    </div>
  );
}
