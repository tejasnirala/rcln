import Link from 'next/link';
import { Cta } from './cta';
import { Wordmark } from './wordmark';

const NAV = [
  { href: '#product', label: 'Product' },
  { href: '#branches', label: 'Branches' },
  { href: '#security', label: 'Security' },
  { href: '#pricing', label: 'Pricing' },
];

/**
 * No hamburger. The nav is four anchors into one scrolling page, and a control
 * that exists to reveal four links earns nothing — below the medium breakpoint
 * they become a scrollable strip instead of disappearing.
 *
 * `Log in` is never hidden. A clinic coming back on a phone has to be able to
 * find its way in, and it was previously dropped below 640px.
 */
export function SiteHeader() {
  return (
    <header className="bg-paper/85 border-rule sticky top-0 z-50 border-b backdrop-blur-md">
      <div className="mx-auto flex h-16 w-full max-w-6xl items-center justify-between gap-3 px-gutter">
        <Link
          href="/"
          aria-label="rcln, home"
          className="text-ink hover:text-drape shrink-0 transition-colors"
        >
          <Wordmark />
        </Link>

        <nav aria-label="Page sections" className="hidden items-center gap-8 md:flex">
          {NAV.map((item) => (
            <a
              key={item.href}
              href={item.href}
              className="text-muted hover:text-ink text-sm transition-colors"
            >
              {item.label}
            </a>
          ))}
        </nav>

        <div className="flex shrink-0 items-center gap-1 sm:gap-3">
          <Cta href="/login" variant="quiet" event="cta_log_in" className="px-2 py-2 sm:px-3">
            Log in
          </Cta>
          <Cta
            href="/signup"
            event="cta_start_clinic"
            className="px-3.5 py-2.5 text-sm sm:px-5 sm:py-3 sm:text-[0.9375rem]"
          >
            Start a clinic
          </Cta>
        </div>
      </div>

      {/* Small screens keep the section nav, scrollable rather than hidden. */}
      <nav
        aria-label="Page sections"
        className="border-rule scrollbar-none flex gap-5 overflow-x-auto border-t px-gutter md:hidden"
      >
        {NAV.map((item) => (
          <a
            key={item.href}
            href={item.href}
            className="text-muted hover:text-ink shrink-0 py-2.5 text-[0.8125rem] whitespace-nowrap transition-colors"
          >
            {item.label}
          </a>
        ))}
      </nav>
    </header>
  );
}
