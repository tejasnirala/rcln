import Link from 'next/link';

/**
 * Where you can go from here — one row, one appearance, both surfaces.
 *
 * The console used to have its own nav on a dark bar and the clinic another on a
 * light one, which said the two were different kinds of place. They are not: the
 * console is a set of screens you have permission to open, exactly like the
 * clinic's. What differs is the *contents* of the row, and that is the caller's
 * business — filtering by permission belongs where the permissions are known.
 *
 * A link the caller cannot use is never rendered: following it would only produce
 * a 403 at the API, and a nav that lists doors you cannot open is a worse map
 * than a short one.
 */

export interface NavLink {
  href: string;
  label: string;
}

export function AppNav({ label, links }: { label: string; links: NavLink[] }) {
  if (links.length === 0) return null;

  return (
    <nav aria-label={label} className="border-rule bg-paper border-t">
      <ul className="px-gutter mx-auto flex max-w-7xl gap-1 py-1">
        {links.map((link) => (
          <li key={link.href}>
            {/* py-2 keeps the target above the 24px minimum; an inline link is
                about 19px from line-height alone (apps/web/AGENTS.md). */}
            <Link
              href={link.href}
              className="text-muted hover:text-drape hover:bg-drape-tint/50 inline-block rounded-sm px-3 py-2 text-[0.8125rem] transition-colors"
            >
              {link.label}
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  );
}
