'use client';

import { useActionState, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import type {
  BranchSummary,
  InventoryLocationSummary,
  OnlineOrderLineRequest,
} from '@rcln/contracts';
import { Alert, useOutcomeFocus } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Input, Select } from '@/components/ui/field';
import { PharmacyNav } from '@/components/tenant/pharmacy-nav';
import { PatientPicker } from '@/components/tenant/patient-picker';
import { ConsultationPicker } from '@/components/tenant/consultation-picker';
import { ProductPicker } from '@/components/tenant/product-picker';
import { createOnlineOrderAction } from '@/app/(tenant)/t/[slug]/(app)/pharmacy/orders/actions';
import { IDLE_FORM, type PharmacyFormState } from '@/app/(tenant)/t/[slug]/(app)/pharmacy/actions';

/**
 * Taking an order over the telephone, or off a form somebody filled in.
 *
 * ⚠️ THIS SAVES A DRAFT AND HOLDS NOTHING. No number is issued, no stock leaves
 *   `AVAILABLE` and the rules are not consulted until somebody accepts it on the
 *   next screen. That separation is the point: the person writing down what was
 *   asked for is often not the person who decides the clinic can supply it.
 *
 * ⚠️ THERE IS NO "MAY THIS BE SENT BY POST" TICKBOX, AND THAT IS THE WHOLE
 *   CONCEPT — the same one the counter-sale form makes about over-the-counter.
 *   Whether a product may be supplied remotely is recorded on its regulatory
 *   profile per jurisdiction, and the server refuses the acceptance with the
 *   product's name and what to do about it.
 *
 * ⚠️ ONE LINE PER PRODUCT. The stock is held per line, so two lines naming one
 *   medicine would be two holds for one thing. The server refuses it; this form
 *   says so before somebody gets that far.
 *
 * ⚠️ PHI: the address block is the most sensitive thing on this screen. It is
 *   posted, rendered, and stored nowhere on the client.
 *
 * ⚠️ THE PATIENT AND PRODUCT FIELDS WERE RAW UUID BOXES UNTIL PI-23
 *   (KNOWN_ISSUES #25, #25b). "Patient" was a free-text input whose hint said
 *   "the patient's id" — the database's concern, not the user's — so the only
 *   way to fill it was to copy an id off another screen, and one mis-pasted
 *   character sent a parcel to somebody else. Both are searches now.
 *
 * ⚠️ "CONSULTATION" IS STILL AN ID BOX, AND THAT IS AN API GAP RATHER THAN AN
 *   OVERSIGHT. Nothing in `@rcln/contracts` lists a patient's consultations —
 *   there is no `GET /encounters?patientId=` — so a picker here would need a new
 *   endpoint, which is a contract change and not identifier resolution. The
 *   field is optional, and the copy now says where the id comes from.
 */
interface Props {
  slug: string;
  branches: BranchSummary[];
  locations: InventoryLocationSummary[];
  /** The default country for the address, from the branch the clinic works in. */
  defaultCountryCode: string;
  /** The branch's zone, so a consultation date reads as the clinic's day. */
  timeZone: string;
}

interface OrderLine {
  key: string;
  productId: string;
  /**
   * ⚠️ CARRIED ON THE LINE, NOT LOOKED UP (PI-23). The unit posted with a line is
   *   the product's own base unit, and it used to be found by searching a
   *   catalogue this component held — which silently posted an empty unit for any
   *   product outside the fetched page. The picker hands both over together.
   */
  baseUnitId: string;
  quantity: string;
}

const CHANNELS = [
  { value: 'PHONE', label: 'Telephone' },
  { value: 'WHATSAPP', label: 'WhatsApp' },
  { value: 'EMAIL', label: 'Email' },
  { value: 'WEB', label: 'Web' },
  { value: 'COUNTER', label: 'Asked at the counter' },
];

export function OnlineOrderForm({
  slug,
  branches,
  locations,
  defaultCountryCode,
  timeZone,
}: Props) {
  const router = useRouter();
  /* AGENTS.md: on a failed submit, move focus to the first field at fault. */
  const formRef = useRef<HTMLFormElement>(null);
  const [branchId, setBranchId] = useState(branches[0]?.id ?? '');
  /* Held here because the consultation picker is a sibling of the patient
   * picker, not a child of it. */
  const [patientId, setPatientId] = useState('');
  const [locationId, setLocationId] = useState('');
  const [lines, setLines] = useState<OrderLine[]>([
    { key: crypto.randomUUID(), productId: '', baseUnitId: '', quantity: '' },
  ]);

  const [state, formAction, pending] = useActionState<PharmacyFormState, FormData>(
    async (previous, form) => {
      const result = await createOnlineOrderAction(slug, previous, form);
      if (result.status === 'saved' && result.createdId) {
        router.push(`/pharmacy/orders/${result.createdId}`);
      }
      return result;
    },
    IDLE_FORM
  );

  useOutcomeFocus(state.status, formRef);

  const payload: OnlineOrderLineRequest[] = lines
    .filter((line) => line.productId !== '' && Number(line.quantity) > 0)
    .map(
      (line) =>
        ({
          productId: line.productId,
          quantity: line.quantity,
          /* The product's own base unit: this form counts in what the shelf counts in. */
          unitId: line.baseUnitId,
        }) satisfies OnlineOrderLineRequest
    );

  const chosen = lines.map((line) => line.productId).filter((id) => id !== '');
  const duplicated = chosen.length !== new Set(chosen).size;

  /*
   * ⚠️ A LINE WITH A MEDICINE AND NO USABLE QUANTITY IS DROPPED FROM THE
   *   PAYLOAD, AND USED TO BE DROPPED IN SILENCE. The only thing this form
   *   posts is the hidden `lines` JSON above — the per-line quantity inputs are
   *   never read — so a quantity left blank, typed as `0`, or written "2 boxes"
   *   removed that medicine from the order with nothing on screen to say so,
   *   while the submit button stayed enabled as long as ONE line survived. The
   *   pharmacist took a three-medicine order over the phone, saved it, and the
   *   detail screen showed two. The duplicate case a few lines below has always
   *   had a visible warning; this one had none. (PI-24 review.)
   */
  const incomplete = lines.filter((line) => line.productId !== '' && !(Number(line.quantity) > 0));

  const locationsHere = locations.filter((location) => location.branchId === branchId);

  return (
    <div className="space-y-8">
      <header>
        <h1 className="font-display text-ink text-[1.75rem] leading-tight tracking-tight">
          Take an order
        </h1>
        <p className="text-muted mt-1 text-[0.875rem]">
          What somebody has asked to have sent out. Saving this holds no stock — accepting it on the
          next screen does.
        </p>
      </header>

      <PharmacyNav />

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

      {incomplete.length > 0 ? (
        <Alert tone="warning">
          {incomplete.length === 1
            ? 'One line has a medicine but no quantity, and will not be ordered.'
            : `${incomplete.length} lines have a medicine but no quantity, and will not be ordered.`}{' '}
          Give each one a quantity, or remove the line.
        </Alert>
      ) : null}

      {duplicated ? (
        <Alert tone="warning">
          One medicine is on this order twice. Put the whole quantity on a single line — stock is
          held per line, and two holds for one medicine is two answers to how much is coming.
        </Alert>
      ) : null}

      <form ref={formRef} action={formAction} className="space-y-6">
        <input type="hidden" name="branchId" value={branchId} />
        <input type="hidden" name="locationId" value={locationId} />
        <input type="hidden" name="lines" value={JSON.stringify(payload)} />

        <fieldset className="border-rule bg-card grid gap-3 rounded-md border p-4 sm:grid-cols-2">
          <legend className="text-ink px-1 text-[0.875rem] font-medium">Who and where from</legend>
          <Select
            label="Branch"
            name="branchPicker"
            hint="The dispensary that will make the parcel up. Its country decides which rules apply."
            value={branchId}
            options={branches.map((branch) => ({ value: branch.id, label: branch.name }))}
            onChange={(event) => {
              setBranchId(event.target.value);
              setLocationId('');
            }}
          />
          <Select
            label="Packing from"
            name="locationPicker"
            /* ⚠️ THE ERROR FOR `locationId`, WHICH IS A HIDDEN INPUT. An error
             * rendered against nothing does not exist to a screen reader
             * (AGENTS.md), so it is attached to the control that sets it. */
            errors={state.fieldErrors?.['locationId']}
            value={locationId}
            options={[
              { value: '', label: 'Choose a dispensing point' },
              ...locationsHere.map((location) => ({ value: location.id, label: location.name })),
            ]}
            onChange={(event) => setLocationId(event.target.value)}
          />
          <Select
            label="How the order arrived"
            name="channel"
            errors={state.fieldErrors?.['channel']}
            options={CHANNELS}
          />
          <PatientPicker
            slug={slug}
            name="patientId"
            label="Patient"
            required
            errors={state.fieldErrors?.['patientId']}
            hint="Name, phone or UHID. A parcel has to go to somebody on this branch's list."
            onChoose={(patient) => setPatientId(patient?.id ?? '')}
          />
          {/*
            ⚠️ A LIST OF THE PATIENT'S CONSULTATIONS, NOT AN ID BOX
               (KNOWN_ISSUES #33). This asked a receptionist to paste a uuid
               copied off the prescription queue. It loads once a patient is
               chosen, and shows date, doctor and item count — never a diagnosis,
               which is why it reads the pharmacy endpoint rather than the
               clinical one.
          */}
          <ConsultationPicker
            slug={slug}
            name="encounterId"
            patientId={patientId}
            timeZone={timeZone}
            errors={state.fieldErrors?.['encounterId']}
          />
        </fieldset>

        <fieldset className="border-rule bg-card grid gap-3 rounded-md border p-4 sm:grid-cols-2">
          <legend className="text-ink px-1 text-[0.875rem] font-medium">Where it is going</legend>
          <Input
            label="Who signs for it"
            name="recipientName"
            errors={state.fieldErrors?.['recipientName']}
            hint="Often not the patient — whoever will be in."
            required
          />
          <Input
            label="Telephone for the courier"
            name="recipientPhone"
            errors={state.fieldErrors?.['recipientPhone']}
            type="tel"
            required
          />
          <Input
            label="Address"
            name="addressLine1"
            errors={state.fieldErrors?.['addressLine1']}
            required
          />
          <Input label="Area" name="addressLine2" errors={state.fieldErrors?.['addressLine2']} />
          <Input label="Town or city" name="city" errors={state.fieldErrors?.['city']} />
          <Input label="State" name="state" errors={state.fieldErrors?.['state']} />
          <Input
            label="Postcode"
            name="pincode"
            errors={state.fieldErrors?.['pincode']}
            inputMode="numeric"
          />
          <Input
            label="Country"
            name="destinationCountryCode"
            errors={state.fieldErrors?.['destinationCountryCode']}
            hint="Two letters. Where the parcel arrives, which is not always where it is packed."
            defaultValue={defaultCountryCode}
            required
          />
          <Input
            label="State code"
            name="destinationRegionCode"
            errors={state.fieldErrors?.['destinationRegionCode']}
            hint="The subdivision code without the country in front — KA, not IN-KA. Leave blank if you are not sure."
          />
        </fieldset>

        <fieldset className="space-y-2">
          <legend className="text-ink mb-2 text-[0.875rem] font-medium">What was asked for</legend>
          <ul className="space-y-2">
            {lines.map((line, index) => (
              <li
                key={line.key}
                className="border-rule bg-card flex flex-wrap gap-3 rounded-md border p-4"
              >
                <div className="min-w-64 flex-1">
                  <ProductPicker
                    slug={slug}
                    label="Product"
                    filters={{ isStockItem: true, status: 'ACTIVE' }}
                    onChoose={(product) =>
                      setLines((current) =>
                        current.map((entry, position) =>
                          position === index
                            ? {
                                ...entry,
                                productId: product?.id ?? '',
                                baseUnitId: product?.baseUnitId ?? '',
                              }
                            : entry
                        )
                      )
                    }
                  />
                </div>
                <Input
                  label="Quantity"
                  name={`quantity-${String(index)}`}
                  inputMode="decimal"
                  fieldClassName="w-32"
                  className="text-right tabular-nums"
                  value={line.quantity}
                  onChange={(event) =>
                    setLines((current) =>
                      current.map((entry, position) =>
                        position === index ? { ...entry, quantity: event.target.value } : entry
                      )
                    )
                  }
                />
                {lines.length > 1 ? (
                  <button
                    type="button"
                    onClick={() =>
                      setLines((current) => current.filter((_, position) => position !== index))
                    }
                    className="text-muted hover:text-ink self-end pb-2 text-[0.875rem]"
                  >
                    Remove
                  </button>
                ) : null}
              </li>
            ))}
          </ul>
        </fieldset>

        <Input
          label="Notes"
          name="notes"
          errors={state.fieldErrors?.['notes']}
          hint="Anything the person taking the order wrote down."
        />

        <div className="flex flex-wrap items-center justify-between gap-3">
          <Button
            type="button"
            variant="secondary"
            onClick={() =>
              setLines((current) => [
                ...current,
                { key: crypto.randomUUID(), productId: '', baseUnitId: '', quantity: '' },
              ])
            }
          >
            Add a medicine
          </Button>
          <Button type="submit" disabled={pending || payload.length === 0 || locationId === ''}>
            {pending ? 'Saving…' : 'Save the order'}
          </Button>
        </div>
      </form>
    </div>
  );
}
