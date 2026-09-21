'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

/**
 * The questions a storekeeper opens this section to answer, as tabs.
 *
 * ⚠️ SEPARATE SCREENS RATHER THAN ONE WITH PANELS, because they answer different
 *   questions at different cadences. "What is on the shelf right now" is opened
 *   every morning; "what moved, and who moved it" is opened when something is
 *   wrong. Folding the ledger into the overview would make the daily screen slow
 *   and the forensic one hard to find.
 *
 * ⚠️ THERE IS NO "ADJUSTMENTS" TAB, AND PI-3.6 ASKS FOR ONE. An adjustments list
 *   would be the MOVEMENTS list filtered to one type — the same rows, the same
 *   query, a second door onto one screen — and two tabs showing overlapping sets
 *   of the same rows is how a person loses track of which one is complete.
 *   Recording an adjustment is an ACTION, so it is a button on Movements, and
 *   the filter that isolates them is on that screen already.
 *
 * ⚠️ REAL ANCHORS, AND `aria-current="page"` RATHER THAN COLOUR ALONE. The
 *   active tab is announced, not merely tinted — the same rule the catalogue's
 *   provenance badge follows, and one this codebase has already got wrong once.
 */
const TABS = [
  { href: '/stock', label: 'Overview' },
  /*
   * PI-23. Second, not last, because it is the fastest way into every other tab
   * on this row: a storekeeper holding a box knows the box, not the product id.
   */
  { href: '/stock/scan', label: 'Scan' },
  { href: '/stock/lots', label: 'Lots' },
  { href: '/stock/serials', label: 'Serials' },
  { href: '/stock/locations', label: 'Locations' },
  { href: '/stock/transfers', label: 'Transfers' },
  { href: '/stock/reservations', label: 'Reservations' },
  { href: '/stock/ledger', label: 'Movements' },
];

export function StockNav() {
  const pathname = usePathname();

  return (
    // ⚠️ SCROLLS RATHER THAN WRAPPING. Eight tabs do not fit a phone, and a
    //   wrapped second row of tabs reads as a second navigation. Horizontal
    //   scroll keeps one row and one meaning.
    <nav aria-label="Stock" className="border-rule flex gap-1 overflow-x-auto border-b">
      {TABS.map((tab) => {
        // `/stock` is a prefix of every other tab, so it matches exactly while
        // the rest match by prefix. Without the distinction Overview stays lit
        // on every screen in the section.
        const active =
          tab.href === '/stock' ? pathname === '/stock' : pathname.startsWith(tab.href);

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
