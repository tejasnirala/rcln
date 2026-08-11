import type { Metadata } from 'next';
import { cookies } from 'next/headers';
import { ThemeSettings } from '@/components/shell/theme-settings';
import { ACCENT_COOKIE, APPEARANCE_COOKIE, toAccent, toAppearance } from '@/lib/theme';

export const metadata: Metadata = {
  title: 'Appearance',
};

/**
 * <slug>.rcln.com/appearance — how rcln looks on this browser.
 *
 * NO PERMISSION GUARDS THIS SCREEN, AND NONE SHOULD. Everything behind the other
 * tabs is a decision about the clinic; this is a decision about the monitor in
 * front of you. A receptionist may not read a fee schedule and may absolutely
 * turn the lights down.
 *
 * Nothing is fetched and nothing is written server-side: the cookies are read
 * here only so the correct card is already ticked in the first HTML. The theme
 * itself was applied before this page rendered, by the boot script in the root
 * layout.
 */
export default async function AppearancePage() {
  const jar = await cookies();

  return (
    <ThemeSettings
      initialAppearance={toAppearance(jar.get(APPEARANCE_COOKIE)?.value)}
      initialAccent={toAccent(jar.get(ACCENT_COOKIE)?.value)}
    />
  );
}
