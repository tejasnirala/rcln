import type { Metadata } from 'next';
import { cookies } from 'next/headers';
import { ThemeSettings } from '@/components/shell/theme-settings';
import { ACCENT_COOKIE, APPEARANCE_COOKIE, toAccent, toAppearance } from '@/lib/theme';

export const metadata: Metadata = {
  title: 'Appearance',
};

/**
 * admin.rcln.com/appearance — the same screen a clinic gets, in the console.
 *
 * The console is not a different kind of place (ADR-0012) and a preference about
 * this browser is not a preference about a clinic, so the component is the same
 * one. The cookie is host-only, which means the console's theme is its own: an
 * admin can run the dark console beside a clinic's light one, and neither is
 * carrying the other's setting.
 */
export default async function PlatformAppearancePage() {
  const jar = await cookies();

  return (
    <ThemeSettings
      initialAppearance={toAppearance(jar.get(APPEARANCE_COOKIE)?.value)}
      initialAccent={toAccent(jar.get(ACCENT_COOKIE)?.value)}
    />
  );
}
