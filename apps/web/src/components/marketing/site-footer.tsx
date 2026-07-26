import Link from 'next/link';
import { Wordmark } from './wordmark';

/*
 * The legal pages exist now, but they are DRAFTS carrying a visible
 * "not yet in force" banner and unfilled placeholders. Before this is public:
 * fill every <Placeholder> in app/(marketing)/legal/*, have counsel sign them
 * off, remove the banner, and replace the entity name and support address here.
 * Run `grep -rn "Placeholder>" apps/web/src/app/\(marketing\)/legal` for the list.
 */
const COLUMNS = [
  {
    title: 'Product',
    links: [
      { href: '#product', label: 'What it runs' },
      { href: '#branches', label: 'Multiple branches' },
      { href: '#india', label: 'Built for India' },
      { href: '#pricing', label: 'Pricing' },
    ],
  },
  {
    title: 'Trust',
    links: [
      { href: '#security', label: 'How your data is kept apart' },
      { href: '/legal/privacy', label: 'Privacy policy' },
      { href: '/legal/terms', label: 'Terms of service' },
      { href: '/legal/dpa', label: 'Data processing agreement' },
    ],
  },
  {
    title: 'Company',
    links: [
      { href: '#demo', label: 'Book a demo' },
      { href: 'mailto:hello@rcln.com', label: 'hello@rcln.com' },
      { href: '/login', label: 'Log in' },
    ],
  },
];

export function SiteFooter() {
  return (
    <footer className="bg-ink text-paper on-ink">
      <div className="mx-auto w-full max-w-6xl px-gutter py-16">
        <div className="grid gap-12 sm:grid-cols-2 lg:grid-cols-[1.5fr_repeat(3,1fr)]">
          <div>
            <Wordmark />
            <p className="text-drape-tint/70 mt-4 max-w-xs text-sm leading-relaxed">
              Practice software for Indian clinics and hospitals. One patient record from the front
              desk to the GST invoice, across every branch you open.
            </p>
          </div>

          {COLUMNS.map((column) => (
            <div key={column.title}>
              <h3 className="eyebrow text-drape-tint/60">{column.title}</h3>
              <ul className="mt-4 space-y-2.5">
                {column.links.map((link) => (
                  <li key={link.href + link.label}>
                    <Link
                      href={link.href}
                      className="text-drape-tint/85 hover:text-paper text-sm transition-colors"
                    >
                      {link.label}
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>

        <div className="border-drape-tint/15 text-drape-tint/55 mt-14 flex flex-wrap items-center justify-between gap-3 border-t pt-6 text-[0.8125rem]">
          <p>© {new Date().getFullYear()} rcln. All rights reserved.</p>
          <p className="font-mono text-[0.6875rem] tracking-wide">Hosted in India · ap-south-1</p>
        </div>
      </div>
    </footer>
  );
}
