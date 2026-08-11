import { themeBootScript } from '@/lib/theme';

/**
 * The first thing that runs on the page.
 *
 * ⚠️ THIS MUST STAY A BLOCKING INLINE SCRIPT. Not `next/script`, not an effect,
 *   not a `useLayoutEffect` — every one of those runs after the browser has
 *   already painted a frame, and that frame is the white flash a dark-mode user
 *   sees on every reload. A synchronous script in the document runs before the
 *   first paint, which is the only place this can be done.
 *
 * The tag is deliberately unstyled and childless so React never re-renders it,
 * and the script itself is built in `lib/theme.ts` from the same constants the
 * settings screen writes — there is no second list of accent ids here to fall
 * out of step.
 */
export function ThemeScript() {
  return <script dangerouslySetInnerHTML={{ __html: themeBootScript() }} />;
}
