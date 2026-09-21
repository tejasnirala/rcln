'use client';

import { useId, useState, useTransition } from 'react';
import type { ProductSummary } from '@rcln/contracts';
import { FieldError, Input } from '@/components/ui/field';
import { Button } from '@/components/ui/button';
import { Alert } from '@/components/ui/alert';
import {
  searchProducts,
  type ProductSearchFilters,
  type ProductSearchState,
} from '@/app/(tenant)/t/[slug]/(app)/lookup-actions';

/**
 * Find a product by typing part of it, or by scanning it.
 *
 * ⚠️ THIS REPLACES EVERY CAPPED `<select>` IN THE APPLICATION AND IS THE POINT OF
 *   PI-23 ON THE WEB.
 *   Every stock and procurement form used to load the first 100 products at
 *   render and offer them in a dropdown; a clinic with three thousand products
 *   got a picker that could not reach most of its own catalogue and did not say
 *   so loudly enough (KNOWN_ISSUES #25b). Searching on the server removes the cap
 *   rather than raising it.
 *
 * ⚠️ THE SEARCH BOX ACCEPTS A SCAN, AND THAT IS NOT A BONUS FEATURE. The
 *   catalogue's `q` already matches `product_identifiers.value` exactly, so a
 *   thirteen-digit EAN typed or scanned into this field finds the product it
 *   belongs to. What it will NOT do is take a full GS1 DataMatrix apart — that
 *   is `/stock/scan`, and this field says so rather than failing quietly on a
 *   payload that begins `01`.
 *
 * ⚠️ THE CHOSEN ID LIVES IN A HIDDEN INPUT, NOT IN A PARENT'S STATE. Every form
 *   this sits in is a plain `<form action={serverAction}>` posting a `FormData`,
 *   so the value has to be IN the form — lifting it into React state would work
 *   until somebody submits with the keyboard before the state settles.
 *
 * ⚠️ AND IT NEVER PRE-SELECTS THE FIRST MATCH. The dropdowns it replaces
 *   defaulted to `products[0]`, which is defensible for a list of five and is a
 *   mis-picked product waiting to happen for a search that returned twenty. An
 *   empty choice is a form that cannot be submitted; a wrong choice is a lot
 *   recorded against the wrong medicine.
 */
/** Enough of a product to show which one is chosen. */
interface ChosenProduct {
  id: string;
  name: string;
  code?: string;
}

interface Props {
  slug: string;
  /**
   * The form field the chosen id posts under — `productId` almost everywhere.
   *
   * ⚠️ OPTIONAL, FOR THE ONE FORM THAT POSTS ITS LINES AS JSON. The consumption
   *   template editor serialises its whole line list into a single hidden input,
   *   so a second hidden input per line would post fields its action does not
   *   read. Omitted, this renders no input at all and the caller owns the value
   *   through `onChoose`.
   */
  name?: string;
  label: string;
  hint?: string;
  errors?: string[];
  /**
   * Marks the label. ⚠️ NOT `required` ON THE HIDDEN INPUT — a hidden field is
   *   barred from constraint validation, so the browser would never enforce it
   *   and the attribute would read as protection that is not there. The Zod
   *   contract on the server is what refuses an empty id, under this field's
   *   name, in this field's error slot.
   */
  required?: boolean;
  /** Narrow what may be chosen. A lot needs a batch-tracked product; a serial does not. */
  filters?: ProductSearchFilters;
  /**
   * Pre-chosen, when a form is editing something that already names a product.
   *
   * ⚠️ A DISPLAY SHAPE, NOT A `ProductSummary`. What is stored against an
   *   existing row is an id and a name — a consumption template line carries
   *   exactly those and no product code — and demanding the full summary would
   *   force every editing form to either fetch the product it is already
   *   displaying or fake the missing fields with a cast. `onChoose` still hands
   *   back the whole row, because that is what a NEW choice actually is.
   */
  initial?: ChosenProduct | null;
  /**
   * The chosen product, when the PARENT owns it — a line in a form that a scan
   * can fill in from outside.
   *
   * ⚠️ THIS EXISTS SO THE THREE SCANNING FORMS DO NOT HAVE TO REMOUNT THE
   *   PICKER, WHICH IS KNOWN_ISSUES #37. `initial` seeds `useState` and is
   *   therefore read once, so a scan that changed the line's product could not
   *   reach it — the forms passed `key={line.productId}` and threw the whole
   *   subtree away instead. That worked, and it cost the search term, the result
   *   list, the scroll position and the FOCUS on every scan, which on a goods
   *   receipt means the operator's cursor leaves the scan box after each carton.
   *
   *   Passing `value` (even `null`) makes the component controlled and `initial`
   *   is ignored; omitting it leaves the other thirteen call sites exactly as
   *   they were. (PI-24 review.)
   */
  value?: ChosenProduct | null;
  /** Told what was chosen, for a form that reacts to it — an expiry that becomes required. */
  onChoose?: (product: ProductSummary | null) => void;
  /** What to say when nothing in the catalogue can be chosen here. */
  emptyHint?: string;
  /** Show the choice and offer no way to change it — a read-only version. */
  disabled?: boolean;
  className?: string;
}

const IDLE: ProductSearchState = { status: 'idle' };

export function ProductPicker({
  slug,
  name,
  label,
  hint,
  required = false,
  errors,
  filters,
  initial = null,
  value,
  onChoose,
  emptyHint = 'Nothing matched. Try part of the name, the product code, or its barcode.',
  disabled = false,
  className,
}: Props) {
  const fieldId = useId();
  const [internalChosen, setInternalChosen] = useState<ChosenProduct | null>(initial);
  /* Controlled when `value` was passed at all — `null` is a choice, `undefined`
   * is "you own this". */
  const controlled = value !== undefined;
  const chosen = controlled ? value : internalChosen;
  const [term, setTerm] = useState('');
  const [state, setState] = useState<ProductSearchState>(IDLE);
  const [pending, startTransition] = useTransition();

  const choose = (product: ProductSummary | null): void => {
    if (!controlled) setInternalChosen(product);
    setState(IDLE);
    setTerm('');
    onChoose?.(product);
  };

  const find = (): void => {
    const asked = term.trim();
    if (asked.length < 2) {
      setState({ status: 'error', message: 'Type at least two characters.' });
      return;
    }
    startTransition(async () => {
      setState(await searchProducts(slug, asked, filters));
    });
  };

  if (chosen !== null) {
    return (
      <div className={className}>
        <p className="text-ink text-sm font-medium">{label}</p>
        <div className="border-rule bg-paper mt-2 flex flex-wrap items-center justify-between gap-3 rounded-md border px-3.5 py-2.5">
          <span className="text-ink text-[0.9375rem]">
            {chosen.name}
            {chosen.code === undefined ? null : (
              <span className="text-muted ml-2 font-mono text-[0.75rem]">{chosen.code}</span>
            )}
          </span>
          {disabled ? null : (
            <Button type="button" size="sm" variant="secondary" onClick={() => choose(null)}>
              Change
            </Button>
          )}
        </div>
        {name === undefined ? null : <input type="hidden" name={name} value={chosen.id} />}
        {errors?.[0] ? <FieldError name={name ?? fieldId} message={errors[0]} /> : null}
      </div>
    );
  }

  const nothingMatched = state.status === 'done' && state.products.length === 0;

  if (disabled) {
    return (
      <div className={className}>
        <p className="text-ink text-sm font-medium">{label}</p>
        <p className="border-rule bg-paper text-muted mt-2 rounded-md border px-3.5 py-2.5 text-[0.9375rem]">
          Nothing chosen
        </p>
        {/*
         * ⚠️ THE EMPTY HIDDEN INPUT BELONGS HERE TOO, and this branch returned
         *   before reaching it — so a disabled picker posted no key at all,
         *   contradicting the reasoning stated at the input further down. No
         *   call site passes `disabled` today, so it was latent; the first one
         *   that does would get a Zod error filed under the wrong field.
         *
         *   Always empty: the `chosen` branch above has already returned by
         *   here, so a disabled picker with a choice renders there (without the
         *   Change button) and this branch is only ever the empty one.
         *   (PI-24 review.)
         */}
        {name === undefined ? null : <input type="hidden" name={name} value="" />}
      </div>
    );
  }

  return (
    <div className={className}>
      {/*
       * ⚠️ THE HINT SITS OUTSIDE THE ROW SO THE BUTTON LINES UP WITH THE BOX.
       *   `Field` renders its hint INSIDE the wrapper, below the control, so a
       *   field with a hint is a line taller than its own box and `items-end`
       *   aligns the button to the bottom of the HINT. The patient picker on the
       *   appointment board learned this first; this is that fix, reused.
       */}
      <div className="flex flex-wrap items-end gap-3">
        <Input
          id={fieldId}
          type="search"
          label={
            required ? (
              <>
                {label} <span className="text-muted font-normal">(required)</span>
              </>
            ) : (
              label
            )
          }
          autoComplete="off"
          value={term}
          onChange={(event) => setTerm(event.target.value)}
          onKeyDown={(event) => {
            // Enter means "find", never "submit the form I am sitting in".
            if (event.key === 'Enter') {
              event.preventDefault();
              find();
            }
          }}
          fieldClassName="min-w-[14rem] flex-1"
          aria-describedby={`${fieldId}-note`}
        />
        <Button type="button" variant="secondary" onClick={find} disabled={pending}>
          {pending ? 'Searching…' : 'Find'}
        </Button>
      </div>
      <p id={`${fieldId}-note`} className="text-muted mt-1.5 text-[0.8125rem] leading-snug">
        {hint ?? 'Name, code, brand or barcode.'}
      </p>

      {/*
       * ⚠️ AN EMPTY HIDDEN INPUT WHILE NOTHING IS CHOSEN, RATHER THAN NO INPUT.
       *   A missing key in the FormData and an empty one reach the server action
       *   differently, and every one of these forms reports its own field errors
       *   from the Zod contract. An empty string fails `uuid` with a message
       *   under the right field; a missing key fails somewhere else.
       */}
      {name === undefined ? null : <input type="hidden" name={name} value="" />}

      {errors?.[0] ? <FieldError name={name ?? fieldId} message={errors[0]} /> : null}

      {state.status === 'error' ? (
        <Alert tone="error" className="mt-2">
          {state.message}
        </Alert>
      ) : null}

      {state.status === 'done' && state.products.length > 0 ? (
        <>
          <ul className="border-rule divide-rule mt-2 divide-y rounded-md border">
            {state.products.map((product) => (
              <li key={product.id}>
                <button
                  type="button"
                  onClick={() => choose(product)}
                  className="hover:bg-drape-tint/40 flex w-full cursor-pointer flex-wrap items-center justify-between gap-2 px-3.5 py-2.5 text-left"
                >
                  <span className="text-ink text-[0.875rem]">
                    {product.name}
                    {product.brandName === null ? null : (
                      <span className="text-muted ml-2 text-[0.75rem]">{product.brandName}</span>
                    )}
                  </span>
                  <span className="text-muted font-mono text-[0.75rem]">{product.code}</span>
                </button>
              </li>
            ))}
          </ul>
          {state.capped ? (
            <p className="text-muted mt-1.5 text-[0.8125rem]">
              More matched than are shown. Type more of the name to narrow it.
            </p>
          ) : null}
        </>
      ) : null}

      {nothingMatched ? <p className="text-muted mt-2 text-[0.8125rem]">{emptyHint}</p> : null}
    </div>
  );
}
