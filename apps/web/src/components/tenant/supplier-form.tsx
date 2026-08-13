'use client';

import { useRouter } from 'next/navigation';
import { useActionState, useEffect } from 'react';
import type { SupplierDetail } from '@rcln/contracts';
import { Input, Select, Textarea } from '@/components/ui/field';
import { Button } from '@/components/ui/button';
import { Alert } from '@/components/ui/alert';
import {
  createSupplierAction,
  updateSupplierAction,
  IDLE_FORM,
  type ProcurementFormState,
} from '@/app/(tenant)/t/[slug]/(app)/procurement/actions';

/**
 * Adding or editing a supplier.
 *
 * ⚠️ THE CODE IS SET ONCE AND IS NOT EDITABLE AFTERWARDS. Orders, deliveries and
 *   returns are searched and reconciled by it, and renaming it silently detaches
 *   three years of a buyer's muscle memory from the rows it refers to. The NAME is
 *   what a clinic wanted to change nine times in ten, and it is editable — with no
 *   effect on existing documents, which carry their own snapshot of it.
 *
 * ⚠️ ONE FORM FOR BOTH, DECIDED BY WHETHER `supplier` IS PRESENT. Two components
 *   would drift: the create one grows a field and the edit one does not, and the
 *   clinic can enter something it cannot then correct.
 */
const STATUSES = [
  { value: 'ACTIVE', label: 'Active — we order from them' },
  { value: 'ON_HOLD', label: 'On hold — not ordering for now' },
  { value: 'BLACKLISTED', label: 'Blacklisted — never order again' },
];

interface Props {
  slug: string;
  supplier?: SupplierDetail;
  /** ISO 4217 codes the clinic already uses, offered first. */
  currencies: string[];
  /** The clinic's own country, as the default for a new supplier. */
  countryCode: string;
}

export function SupplierForm({ slug, supplier, currencies, countryCode }: Props) {
  const router = useRouter();
  const editing = supplier !== undefined;

  const [state, action, pending] = useActionState<ProcurementFormState, FormData>(
    editing
      ? updateSupplierAction.bind(null, slug, supplier.id)
      : createSupplierAction.bind(null, slug),
    IDLE_FORM
  );

  useEffect(() => {
    if (state.status === 'saved' && state.createdId) {
      router.push(`/procurement/suppliers/${state.createdId}`);
    }
  }, [router, state.status, state.createdId]);

  const err = (name: string): string[] | undefined => state.fieldErrors?.[name];

  const currencyOptions = [
    { value: '', label: 'Not decided yet' },
    ...[...new Set([...currencies, 'INR', 'USD', 'EUR', 'GBP'])].map((code) => ({
      value: code,
      label: code,
    })),
  ];

  return (
    <form action={action} className="max-w-3xl space-y-10">
      <header>
        <h1 className="font-display text-ink text-[1.75rem] leading-tight tracking-tight">
          {editing ? supplier.name : 'Add a supplier'}
        </h1>
        <p className="text-muted mt-1 text-[0.875rem]">
          {editing
            ? 'Changes apply to new orders. Existing orders and deliveries keep the name they were raised with.'
            : 'One record per business, shared by every branch.'}
        </p>
      </header>

      {state.status === 'error' && state.message ? (
        <Alert tone="error">{state.message}</Alert>
      ) : null}
      {state.status === 'saved' && editing ? <Alert tone="success">Saved.</Alert> : null}

      <section className="space-y-4">
        <h2 className="text-ink border-rule border-b pb-2 text-[0.9375rem] font-medium">Who</h2>
        <div className="grid gap-4 sm:grid-cols-2">
          {editing ? (
            <Input
              label="Code"
              name="displayCode"
              defaultValue={supplier.code}
              disabled
              hint="Set when the supplier was added. Orders cite it, so it does not change."
            />
          ) : (
            <Input
              label="Code"
              name="code"
              required
              defaultValue=""
              errors={err('code')}
              placeholder="MEDIDIST"
              hint="Your short code for them. Uppercase letters, digits and dashes."
            />
          )}
          <Select
            label="Status"
            name="status"
            defaultValue={supplier?.status ?? 'ACTIVE'}
            options={STATUSES}
            errors={err('status')}
          />
          <Input
            label="Name"
            name="name"
            required
            defaultValue={supplier?.name ?? ''}
            errors={err('name')}
            hint="What everyone calls them. Shown on every picker."
          />
          <Input
            label="Registered name"
            name="legalName"
            defaultValue={supplier?.legalName ?? ''}
            errors={err('legalName')}
            hint="Optional. The name on the contract, if it differs."
          />
        </div>
      </section>

      <section className="space-y-4">
        <h2 className="text-ink border-rule border-b pb-2 text-[0.9375rem] font-medium">
          How to reach them
        </h2>
        <div className="grid gap-4 sm:grid-cols-2">
          <Input
            label="Contact"
            name="contactPerson"
            defaultValue={supplier?.contactPerson ?? ''}
            errors={err('contactPerson')}
          />
          <Input
            label="Phone"
            name="phone"
            type="tel"
            defaultValue={supplier?.phone ?? ''}
            errors={err('phone')}
          />
          <Input
            label="Email"
            name="email"
            type="email"
            defaultValue={supplier?.email ?? ''}
            errors={err('email')}
          />
          <Input
            label="Website"
            name="website"
            defaultValue={supplier?.website ?? ''}
            errors={err('website')}
          />
        </div>
      </section>

      <section className="space-y-4">
        <h2 className="text-ink border-rule border-b pb-2 text-[0.9375rem] font-medium">Where</h2>
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="sm:col-span-2">
            <Input
              label="Address"
              name="addressLine1"
              defaultValue={supplier?.addressLine1 ?? ''}
              errors={err('addressLine1')}
            />
          </div>
          <div className="sm:col-span-2">
            <Input
              label="Address line 2"
              name="addressLine2"
              defaultValue={supplier?.addressLine2 ?? ''}
              errors={err('addressLine2')}
            />
          </div>
          <Input
            label="City"
            name="city"
            defaultValue={supplier?.city ?? ''}
            errors={err('city')}
          />
          <Input
            label="State or region code"
            name="regionCode"
            defaultValue={supplier?.regionCode ?? ''}
            errors={err('regionCode')}
            placeholder="KA"
            hint="Decides whether a purchase is in-state. ISO code, without the country."
          />
          <Input
            label="Postal code"
            name="postalCode"
            defaultValue={supplier?.postalCode ?? ''}
            errors={err('postalCode')}
          />
          <Input
            label="Country"
            name="countryCode"
            defaultValue={supplier?.countryCode ?? countryCode}
            errors={err('countryCode')}
            placeholder="IN"
            hint="Two-letter code."
          />
        </div>
      </section>

      <section className="space-y-4">
        <h2 className="text-ink border-rule border-b pb-2 text-[0.9375rem] font-medium">Terms</h2>
        <div className="grid gap-4 sm:grid-cols-3">
          <Select
            label="Currency"
            name="defaultCurrency"
            defaultValue={supplier?.defaultCurrency ?? ''}
            options={currencyOptions}
            errors={err('defaultCurrency')}
            hint="What new orders default to. You can change it per order."
          />
          <Input
            label="Payment terms"
            name="paymentTermsDays"
            inputMode="numeric"
            defaultValue={
              supplier?.paymentTermsDays === null || supplier?.paymentTermsDays === undefined
                ? ''
                : String(supplier.paymentTermsDays)
            }
            errors={err('paymentTermsDays')}
            hint="Days to pay, as agreed. Recorded only."
          />
          <Input
            label="Lead time"
            name="leadTimeDays"
            inputMode="numeric"
            defaultValue={
              supplier?.leadTimeDays === null || supplier?.leadTimeDays === undefined
                ? ''
                : String(supplier.leadTimeDays)
            }
            errors={err('leadTimeDays')}
            hint="Usual days from order to delivery."
          />
        </div>
        <Textarea
          label="Notes"
          name="notes"
          rows={3}
          defaultValue={supplier?.notes ?? ''}
          errors={err('notes')}
        />
      </section>

      <div className="flex flex-wrap gap-3">
        <Button type="submit" disabled={pending}>
          {pending ? 'Saving…' : editing ? 'Save changes' : 'Add supplier'}
        </Button>
        <Button
          type="button"
          variant="secondary"
          onClick={() =>
            router.push(
              editing ? `/procurement/suppliers/${supplier.id}` : '/procurement/suppliers'
            )
          }
        >
          Cancel
        </Button>
      </div>
    </form>
  );
}
