'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

/**
 * The four questions somebody opens this section to answer.
 *
 * ⚠️ THE ORDER IS THE CHAIN OF AUTHORITY, WHICH IS THE ONE STRUCTURAL CLAIM
 *   THESE TABS MAKE: a place has a regulator, a regulator publishes documents,
 *   documents become rules, rules are packaged by version. Reading them left to
 *   right is reading where a refusal came from, backwards from the rule to the
 *   law. That is why Sources sits last rather than first — it is where you end
 *   up when you ask "says who?".
 *
 * ⚠️ "RULES" AND NOT "REGULATORY", THE SAME CHOICE AS STOCK OVER INVENTORY AND
 *   BUYING OVER PROCUREMENT. Regulatory is what the domain is called in the
 *   schema; rules are what a pharmacist is looking for.
 *
 * ⚠️ EVERY TAB IS READ-ONLY, AT EVERY CLINIC, AND NO SCREEN BEHIND THEM HAS A
 *   SAVE BUTTON. The law of a country is the same for everybody in it and is
 *   maintained by rcln — a clinic's own regulatory work is on its products, not
 *   here. Saying that once, in the section header, beats a disabled control on
 *   four screens.
 */
const TABS = [
  { href: '/regulatory/jurisdictions', label: 'Places' },
  { href: '/regulatory/authorities', label: 'Regulators' },
  { href: '/regulatory/rule-packs', label: 'Rule packs' },
  { href: '/regulatory/sources', label: 'Sources' },
];

export function RegulatoryNav() {
  const pathname = usePathname();

  return (
    <nav aria-label="Rules" className="border-rule flex gap-1 overflow-x-auto border-b">
      {TABS.map((tab) => {
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
