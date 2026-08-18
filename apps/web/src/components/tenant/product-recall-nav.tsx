'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

/**
 * Two screens, and they are two screens rather than two panels because they are
 * opened by different people at different moments.
 *
 * ⚠️ "TRACE" IS NOT A TAB OF A NOTICE, AND THAT IS THE POINT. "Where did this lot
 *   come from" and "who got this device" are asked BEFORE anybody decides there
 *   is a recall — a suspicious delivery, an implant that failed — and that is
 *   usually how a recall starts. Burying the lookup inside a notice would mean
 *   creating a notice in order to find out whether one is needed.
 *
 * ⚠️ REAL ANCHORS, AND `aria-current="page"` RATHER THAN COLOUR ALONE, the rule
 *   every nav in this workspace follows.
 */
const TABS = [
  { href: '/product-recalls', label: 'Notices' },
  { href: '/product-recalls/trace', label: 'Trace a lot' },
];

export function ProductRecallNav() {
  const pathname = usePathname();

  return (
    <nav aria-label="Product recalls" className="border-rule flex gap-1 overflow-x-auto border-b">
      {TABS.map((tab) => {
        // `/recalls` is a prefix of the other, so it matches exactly while the
        // rest match by prefix. Without the distinction Notices stays lit on
        // every screen in the section.
        const active =
          tab.href === '/product-recalls'
            ? pathname === '/product-recalls'
            : pathname.startsWith(tab.href);

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
