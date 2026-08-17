'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

/**
 * The three places charging works from, as tabs.
 *
 * ⚠️ THE ORDER IS FREQUENCY, NOT A SEQUENCE. "Waiting" is opened every hour by
 *   whoever is at the till; "Prices" is opened when something new is stocked;
 *   "Policy" is opened when a clinic changes its mind about what it charges for,
 *   which is a handful of times a year. Numbering them would claim they are
 *   steps you complete in turn — they are three depths of the same decision, and
 *   most people only ever reach the first.
 *
 * ⚠️ "WAITING" AND NOT "CHARGE REQUESTS". A charge request is what the table is
 *   called; what somebody at the till is looking at is what is waiting to go on
 *   a bill. Same choice the rest of this product makes — Stock over Inventory,
 *   Buying over Procurement, Waiting over Queue in the dispensary.
 *
 * ⚠️ EVERY TAB IS RENDERED REGARDLESS OF PERMISSION AND THE SCREEN BEHIND IT SAYS
 *   NO — the same call `PharmacyNav` and `ProcurementNav` make. These three are
 *   one subject: a pharmacist who may only read the queue still needs to see
 *   that a price list is where the missing number comes from, or the empty
 *   "no price" state on their screen is unexplainable.
 */
const TABS = [
  { href: '/charges', label: 'Waiting', exact: true },
  { href: '/charges/prices', label: 'Prices' },
  { href: '/charges/policy', label: 'Policy' },
];

export function ChargesNav() {
  const pathname = usePathname();

  return (
    <nav aria-label="Charges" className="border-rule flex gap-1 overflow-x-auto border-b">
      {TABS.map((tab) => {
        // `/charges` is a prefix of the other two, so the queue matches exactly
        // and the rest match by prefix — the exception PharmacyNav makes.
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
