'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

/**
 * The five places a dispensary works from, as tabs.
 *
 * ⚠️ THE ORDER IS THE COUNTER'S DAY, not a numbered sequence: what is waiting,
 *   what has gone out, what came back, and the view over all three. Numbering
 *   them would claim they are steps you complete in turn, and they are places you
 *   can be at any moment.
 *
 * ⚠️ "WAITING" AND NOT "QUEUE". A queue is what the table is called; waiting is
 *   what a pharmacist sees when they look up. Same choice the rest of this
 *   product makes — Stock over Inventory, Buying over Procurement.
 *
 * ⚠️ EVERY TAB IS RENDERED REGARDLESS OF PERMISSION AND THE SCREEN BEHIND IT SAYS
 *   NO — the same call `ProcurementNav` makes. These four are one workflow: a
 *   technician who may dispense and not take returns still needs to see where a
 *   return would go.
 */
const TABS = [
  { href: '/pharmacy', label: 'Counter', exact: true },
  { href: '/pharmacy/queue', label: 'Waiting' },
  { href: '/pharmacy/dispenses', label: 'Dispensed' },
  { href: '/pharmacy/sales/new', label: 'Counter sale' },
  /*
   * ⚠️ "DELIVERIES" AND NOT "ONLINE ORDERS". What a dispensary is looking at is
   *   the medicine that has to go out in a parcel today; "online" describes how
   *   the request arrived, which is the least useful thing about it once it is
   *   on the list. Same choice the rest of this product makes — Waiting over
   *   Queue, Stock over Inventory.
   */
  { href: '/pharmacy/orders', label: 'Deliveries' },
];

export function PharmacyNav() {
  const pathname = usePathname();

  return (
    <nav aria-label="Pharmacy" className="border-rule flex gap-1 overflow-x-auto border-b">
      {TABS.map((tab) => {
        // `/pharmacy` is a prefix of every other tab, so the dashboard matches
        // exactly and the rest match by prefix — the exception StockNav makes.
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
