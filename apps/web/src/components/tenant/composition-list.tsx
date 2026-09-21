'use client';

import Link from 'next/link';
import type { CompositionSummary } from '@rcln/contracts';
import { humanise } from '@/lib/enum-words';
import { CatalogueNav } from '@/components/tenant/catalogue-nav';

/**
 * What a medicine IS, as opposed to what it is called.
 *
 * ⚠️ THIS IS THE ONE MASTER THAT ANSWERS A QUESTION AT THE COUNTER. Two products
 *   are equivalent when they share a `compositionId` and never because their names
 *   look alike — `/pharmacy/prescriptions/…/substitutions/…` reads exactly this
 *   column. So the row leads with the formula and the product count, which are the
 *   two things that say whether the row is doing anything.
 *
 * ⚠️ A COMPOSITION WITH NO PRODUCTS IS INERT, AND THE ROW SAYS SO RATHER THAN
 *   SHOWING A ZERO. Somebody who has just added twelve of these needs to know the
 *   remaining step is on the product, not here — otherwise the next thing they do
 *   is add a thirteenth and wonder why the counter still offers nothing.
 *
 * ⚠️ IT GETS A PAGE PER COMPOSITION RATHER THAN THE INLINE EDIT THE OTHER MASTERS
 *   USE, because it has children: a variable number of ingredient rows, each with
 *   a strength and a unit. Four of those inside a list row is a form pretending to
 *   be a table.
 *
 * NO PHI.
 */
interface Props {
  compositions: CompositionSummary[];
  canManage: boolean;
}

export function CompositionList({ compositions, canManage }: Props) {
  return (
    <div className="space-y-8">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="font-display text-ink text-[1.75rem] leading-tight tracking-tight">
            Compositions
          </h1>
          <p className="text-muted mt-1 max-w-2xl text-[0.875rem]">
            What a medicine is made of, at what strength. Two products that share one are equivalent
            — this is the column the counter reads when it is asked what else would do.
          </p>
        </div>
        {canManage ? (
          <Link
            href="/products/compositions/new"
            className="bg-drape text-paper hover:bg-drape-deep inline-flex items-center justify-center rounded-md px-5 py-3 text-[0.9375rem] font-medium transition-colors duration-150"
          >
            Add a composition
          </Link>
        ) : null}
      </header>

      <CatalogueNav />

      {compositions.length === 0 ? (
        <div className="border-rule bg-card rounded-md border p-10 text-center">
          <p className="text-ink text-[0.9375rem]">No compositions yet.</p>
          <p className="text-muted mx-auto mt-2 max-w-md text-[0.875rem]">
            Add the ingredients first, then build a composition from them — paracetamol 500 mg, or
            amoxicillin 500 mg with clavulanic acid 125 mg. A product points at one, and that is
            what makes substitution possible.
          </p>
        </div>
      ) : (
        <ul className="space-y-2">
          {compositions.map((composition) => (
            <li key={composition.id}>
              <Link
                href={`/products/compositions/${composition.id}`}
                className="border-rule bg-card hover:border-drape flex flex-wrap items-start gap-x-4 gap-y-2 rounded-md border p-4 transition-colors"
              >
                <span className="min-w-56 flex-1">
                  <span className="text-ink block text-[1rem] font-medium">
                    {composition.name}
                    {composition.isActive ? null : (
                      <span className="text-muted ml-2 text-[0.8125rem] font-normal">
                        · Retired
                      </span>
                    )}
                  </span>
                  <span className="text-muted mt-0.5 block text-[0.8125rem]">
                    <span className="font-mono">{composition.code}</span>
                    {composition.dosageForm ? ` · ${humanise(composition.dosageForm)}` : ''}
                  </span>
                  <span className="text-ink mt-1 block text-[0.875rem]">
                    {formula(composition)}
                  </span>
                </span>

                <span className="text-muted text-[0.8125rem]">
                  {composition.productCount === 0
                    ? 'No product uses it yet'
                    : `${String(composition.productCount)} product${composition.productCount === 1 ? '' : 's'}`}
                </span>

                <span className="border-rule text-muted rounded-full border px-3 py-1 text-[0.75rem]">
                  {composition.isOwn ? 'This clinic' : 'Platform'}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/**
 * The formula as it is printed on a pack: `Amoxicillin 500 mg + Clavulanic acid 125 mg`.
 *
 * ⚠️ `perQuantity` IS PRINTED AND NEVER COMPUTED WITH — it is the denominator of
 *   a concentration, "125 mg per 5 mL", and the contract says the same thing. A
 *   screen that divided by it would be inventing a dose.
 */
function formula(composition: CompositionSummary): string {
  return composition.ingredients
    .map((ingredient) => {
      const strength = `${ingredient.strength} ${ingredient.strengthUnitSymbol}`;
      const per = ingredient.perQuantity === null ? '' : ` per ${ingredient.perQuantity}`;
      return `${ingredient.ingredientName} ${strength}${per}`;
    })
    .join(' + ');
}
