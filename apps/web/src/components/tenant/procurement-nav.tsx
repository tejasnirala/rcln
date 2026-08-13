'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

/**
 * The questions a buyer opens this section to answer, as tabs.
 *
 * ⚠️ THE ORDER IS THE FLOW, AND THAT IS THE ONE STRUCTURAL CLAIM THESE TABS MAKE.
 *   A requisition becomes an order, an order becomes a delivery, a delivery
 *   sometimes becomes a return — so left to right is the sequence a person actually
 *   walks, and Suppliers sits first because everything after it names one. It is
 *   not numbered: the tabs are places you can be at any time, not steps you must
 *   complete in turn, and numbering them would claim otherwise.
 *
 * ⚠️ "DELIVERIES" AND NOT "GOODS RECEIPTS". A goods receipt is what the schema and
 *   the ADRs call the document; a delivery is what the person at the loading bay
 *   calls the thing they are recording. Same choice as Stock over Inventory and
 *   Buying over Procurement.
 *
 * ⚠️ EVERY TAB IS RENDERED REGARDLESS OF PERMISSION, AND THE SCREEN BEHIND IT SAYS
 *   NO. That is the opposite call from the top-level nav, which filters — and it is
 *   deliberate: the top nav is a map of the product, where a door you cannot open
 *   is noise, while these seven are one workflow. A storekeeper who can raise a
 *   requisition and not issue an order needs to see that Orders is where their
 *   request went, or the flow appears to end at Requisitions.
 *
 * ⚠️ REAL ANCHORS, AND `aria-current="page"` RATHER THAN COLOUR ALONE (WCAG 1.4.1).
 */
const TABS = [
  { href: '/procurement/suppliers', label: 'Suppliers' },
  { href: '/procurement/price-book', label: 'Price book' },
  { href: '/procurement/requisitions', label: 'Requisitions' },
  { href: '/procurement/purchase-orders', label: 'Orders' },
  { href: '/procurement/goods-receipts', label: 'Deliveries' },
  { href: '/procurement/returns', label: 'Returns' },
  { href: '/procurement/costs', label: 'Costs' },
];

export function ProcurementNav() {
  const pathname = usePathname();

  return (
    // Scrolls rather than wrapping. Seven tabs do not fit a phone, and a wrapped
    // second row reads as a second navigation — same call as StockNav.
    <nav aria-label="Buying" className="border-rule flex gap-1 overflow-x-auto border-b">
      {TABS.map((tab) => {
        // Prefix matching throughout: no tab here is a prefix of another, so
        // unlike StockNav there is no exact-match exception to make.
        const active = pathname.startsWith(tab.href);

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
