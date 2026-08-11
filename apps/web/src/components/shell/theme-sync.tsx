'use client';

import { useEffect } from 'react';
import {
  ACCENT_COOKIE,
  APPEARANCE_COOKIE,
  DARK_QUERY,
  applyTheme,
  readCookie,
  toAccent,
  toAppearance,
} from '@/lib/theme';

/**
 * Keeps the `system` appearance honest while a tab is open.
 *
 * The boot script resolves `system` once, at load. Someone whose laptop flips to
 * dark at sunset — or who changes the OS setting with rcln open on the second
 * monitor — would otherwise sit on the resolution from whenever they last
 * navigated, which is the bug that makes people conclude "System doesn't work".
 *
 * WHY IT RE-READS THE COOKIE INSTEAD OF HOLDING STATE
 *   The document's attributes and the cookie are the theme; this component owns
 *   neither. Re-reading on the rare media change costs nothing and means the
 *   settings screen can write the cookie without also having to notify anyone.
 *   A React context here would put a client boundary at the root of every page
 *   in the product to serve one event listener.
 *
 * Renders nothing, and mounts once from the root layout.
 */
export function ThemeSync() {
  useEffect(() => {
    const media = window.matchMedia(DARK_QUERY);

    const sync = () => {
      const jar = document.cookie;
      applyTheme(
        document.documentElement,
        {
          appearance: toAppearance(readCookie(jar, APPEARANCE_COOKIE)),
          accent: toAccent(readCookie(jar, ACCENT_COOKIE)),
        },
        media.matches
      );
    };

    media.addEventListener('change', sync);
    return () => media.removeEventListener('change', sync);
  }, []);

  return null;
}
