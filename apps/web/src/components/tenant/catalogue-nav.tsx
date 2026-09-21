'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

/**
 * The catalogue and the five master lists it is assembled from, as tabs.
 *
 * ⚠️ THE ORDER IS DEPENDENCY, NOT FREQUENCY, WHICH IS THE OPPOSITE CALL FROM
 *   `ChargesNav`. These are not three depths of one decision — they are the
 *   things a product POINTS AT, and a clinic setting up works right to left:
 *   there is no composition without ingredients, and no product worth having
 *   without a manufacturer. Ordering by how often each is opened would put
 *   Products first and then list its prerequisites in an order that says nothing,
 *   at exactly the moment somebody is working through them for the first time.
 *
 * ⚠️ "INGREDIENTS" AND NOT "ACTIVE INGREDIENTS". The table is
 *   `active_ingredients` because an excipient is an ingredient too; on a screen
 *   inside a medicines catalogue the qualifier earns nothing and costs a line
 *   wrap on a phone. Same choice the rest of this product makes — Stock over
 *   Inventory, Buying over Procurement, Waiting over Queue.
 *
 * ⚠️ "STORAGE" AND NOT "STORAGE REQUIREMENT PROFILES", for the same reason and
 *   more so: what a person is looking for is the fridge.
 *
 * ⚠️ EVERY TAB IS RENDERED REGARDLESS OF PERMISSION AND THE SCREEN BEHIND IT SAYS
 *   NO — the same call `PharmacyNav`, `ChargesNav` and `ProcurementNav` make.
 *   These six are one subject: somebody who may read the catalogue and not edit
 *   its masters still needs to see where the manufacturer on a product came
 *   from, or the "Not recorded" on the product screen is unexplainable.
 */
const TABS = [
  { href: '/products', label: 'Products', exact: true },
  { href: '/products/manufacturers', label: 'Manufacturers' },
  { href: '/products/ingredients', label: 'Ingredients' },
  { href: '/products/compositions', label: 'Compositions' },
  { href: '/products/categories', label: 'Categories' },
  { href: '/products/storage', label: 'Storage' },
];

export function CatalogueNav() {
  const pathname = usePathname();

  return (
    <nav aria-label="Catalogue" className="border-rule flex gap-1 overflow-x-auto border-b">
      {TABS.map((tab) => {
        // `/products` is a prefix of every other tab, so the list matches exactly
        // and the rest match by prefix — the exception `PharmacyNav` makes.
        const active = tab.exact ? pathname.endsWith(tab.href) : pathname.includes(tab.href);

        return (
          <Link
            key={tab.href}
            href={tab.href}
            aria-current={active ? 'page' : undefined}
            className={
              active
                ? 'border-drape text-ink -mb-px shrink-0 border-b-2 px-3 py-2 text-[0.875rem] font-medium'
                : 'text-muted hover:text-ink -mb-px shrink-0 border-b-2 border-transparent px-3 py-2 text-[0.875rem] transition-colors'
            }
          >
            {tab.label}
          </Link>
        );
      })}
    </nav>
  );
}
