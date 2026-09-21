'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

/**
 * The two places consumption works from, as tabs.
 *
 * ⚠️ "USED" AND "TEMPLATES", IN THAT ORDER, AND THE ORDER IS FREQUENCY RATHER
 *   THAN SEQUENCE. What a procedure used is read whenever somebody reconciles a
 *   trolley or checks a variance; a template is written when a clinic decides
 *   how a procedure is done, which is a handful of times a year. Numbering them
 *   would claim they are steps you complete in turn — they are not, and most
 *   people who open this section never reach the second.
 *
 * ⚠️ "USED", NOT "CONSUMPTIONS". `clinical_consumptions` is what the table is
 *   called; what somebody opens this to see is what got used. Same choice the
 *   rest of the product makes — Stock over Inventory, Waiting over Charge
 *   requests, Catalogue over Products.
 *
 * ⚠️ BOTH TABS RENDER REGARDLESS OF PERMISSION AND THE SCREEN BEHIND SAYS NO —
 *   the call `ChargesNav` and `PharmacyNav` make. A nurse who may record but not
 *   write templates still needs to see that a template is where the pre-filled
 *   numbers come from, or the empty state on their panel is unexplainable.
 */
const TABS = [
  { href: '/usage', label: 'Used', exact: true },
  { href: '/usage/templates', label: 'Templates' },
];

export function UsageNav() {
  const pathname = usePathname();

  return (
    <nav aria-label="Usage" className="border-rule flex gap-1 overflow-x-auto border-b">
      {TABS.map((tab) => {
        // `/usage` is a prefix of the other, so the list matches exactly and the
        // rest match by prefix — the exception ChargesNav makes.
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
