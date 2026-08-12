'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

/**
 * The five questions a storekeeper opens this section to answer, as five tabs.
 *
 * ⚠️ FIVE SCREENS RATHER THAN ONE WITH PANELS, because they answer different
 *   questions at different cadences. "What is on the shelf right now" is opened
 *   every morning; "what moved, and who moved it" is opened when something is
 *   wrong. Folding the ledger into the overview would make the daily screen slow
 *   and the forensic one hard to find.
 *
 * ⚠️ REAL ANCHORS, AND `aria-current="page"` RATHER THAN COLOUR ALONE. The
 *   active tab is announced, not merely tinted — the same rule the catalogue's
 *   provenance badge follows, and one this codebase has already got wrong once.
 */
const TABS = [
  { href: '/stock', label: 'Overview' },
  { href: '/stock/lots', label: 'Lots' },
  { href: '/stock/serials', label: 'Serials' },
  { href: '/stock/locations', label: 'Locations' },
  { href: '/stock/ledger', label: 'Movements' },
];

export function StockNav() {
  const pathname = usePathname();

  return (
    <nav aria-label="Stock" className="border-rule flex gap-1 border-b">
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
                ? 'border-drape text-ink -mb-px border-b-2 px-3 py-2 text-[0.875rem] font-medium'
                : 'text-muted hover:text-ink -mb-px border-b-2 border-transparent px-3 py-2 text-[0.875rem] transition-colors'
            }
          >
            {tab.label}
          </Link>
        );
      })}
    </nav>
  );
}
