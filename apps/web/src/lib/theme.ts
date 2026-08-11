/**
 * The theme, defined once.
 *
 * WHAT LIVES HERE
 *   The identifiers, their labels, the cookie they are stored under, the
 *   validation that turns an arbitrary cookie value into one of them, and the
 *   boot script that applies the result before the first paint. Everything about
 *   the theme that is not a colour.
 *
 * WHERE THE COLOURS LIVE
 *   `app/theme.css`, and nowhere else. This file deliberately contains no hex:
 *   an accent's swatch in the settings screen is rendered by wrapping real
 *   tokens in a `data-accent` div and letting the cascade paint it, so the
 *   preview cannot drift from the palette the way a duplicated hex list would.
 *
 *   ⚠️ THE TWO FILES ARE JOINED BY A STRING MATCH AND NOTHING ENFORCES IT. Each
 *     id in `ACCENTS` has to equal a `[data-accent='…']` selector in
 *     `theme.css`. A test asserted this and has been removed along with the rest
 *     of `apps/web`'s suite. Nothing typechecks the pairing, because one side is
 *     TypeScript and the other is CSS — an id with no matching block silently
 *     paints the previous accent, which looks like the setting not saving.
 *
 * ⚠️ NO `next/headers` IN THIS FILE. It is imported by client components, and by
 *   the settings page, which reads the cookies itself with the validators below.
 *   Same reason `session-cookie.ts` stays free of it.
 *
 * ADDING AN ACCENT
 *   One block in `theme.css` and one entry in `ACCENTS`. Nothing else — not a
 *   component, not a class name, not a conditional. If a change needs more than
 *   that, the thing being added is not an accent.
 */

/* ------------------------------------------------------------------ *
 * Appearance
 * ------------------------------------------------------------------ */

export const APPEARANCES = ['light', 'dark', 'system'] as const;
export type Appearance = (typeof APPEARANCES)[number];

/** What the page is actually painted as. `system` resolves to one of these. */
export type ResolvedAppearance = 'light' | 'dark';

export const DEFAULT_APPEARANCE: Appearance = 'light';

/**
 * ⚠️ THE DEFAULT IS `light`, NOT `system`, AND THAT IS DELIBERATE. Every clinic
 *   using rcln today has a light application; defaulting to the OS setting would
 *   turn the interface dark overnight for everyone whose laptop is in dark mode,
 *   which is a change nobody asked for. `system` is available and one click away
 *   — it is just not what you get for never having opened this screen.
 */
export const APPEARANCE_OPTIONS: ReadonlyArray<{
  id: Appearance;
  label: string;
  description: string;
}> = [
  { id: 'light', label: 'Light', description: 'The daylight interface.' },
  { id: 'dark', label: 'Dark', description: 'For evening clinics and dim rooms.' },
  { id: 'system', label: 'System', description: 'Follow this device’s setting.' },
];

/* ------------------------------------------------------------------ *
 * Accent
 * ------------------------------------------------------------------ */

export const ACCENTS = ['surgical', 'ember', 'indigo', 'plum', 'graphite'] as const;
export type Accent = (typeof ACCENTS)[number];

/**
 * `surgical` is the palette the product shipped with. It is the default because
 * a clinic that never opens this screen must keep the screens it already knows,
 * to the byte.
 */
export const DEFAULT_ACCENT: Accent = 'surgical';

export const ACCENT_OPTIONS: ReadonlyArray<{
  id: Accent;
  label: string;
  description: string;
}> = [
  { id: 'surgical', label: 'Surgical', description: 'Theatre green. The original.' },
  { id: 'ember', label: 'Ember', description: 'Fired clay orange.' },
  { id: 'indigo', label: 'Indigo', description: 'The ink of a printed form.' },
  { id: 'plum', label: 'Plum', description: 'Deep aubergine.' },
  { id: 'graphite', label: 'Graphite', description: 'No hue at all.' },
];

/* ------------------------------------------------------------------ *
 * Storage
 * ------------------------------------------------------------------ */

/**
 * Two cookies, holding two identifiers and nothing else.
 *
 * WHY COOKIES AND NOT THE DATABASE
 *   A theme is a property of this browser on this desk, not of the person and
 *   certainly not of the clinic. The front desk's shared terminal in a bright
 *   waiting room and the same receptionist's laptop at home want different
 *   answers, and a column on `users` can only hold one of them.
 *
 * WHY NOT ONE COOKIE HOLDING AN OBJECT
 *   Because then something would eventually put a colour in it. Two scalars,
 *   each validated against a closed list before use, cannot grow into a theme
 *   payload — and either one being corrupt costs the other nothing.
 *
 * ⚠️ NOT `httpOnly`, UNLIKE THE SESSION COOKIES. The boot script has to read
 *   this before React exists, and the settings screen has to write it without a
 *   round trip, which is what makes switching instant. That is safe here and
 *   only here: the value is one of five words from a list in this file, it is
 *   never interpolated into markup or SQL, and it grants nothing. Do not reach
 *   for this pattern for anything the server trusts.
 */
export const APPEARANCE_COOKIE = 'rcln_appearance';
export const ACCENT_COOKIE = 'rcln_accent';

/**
 * A year. Long enough that the preference survives a browser restart and a
 * holiday, short enough to expire on a terminal nobody uses any more.
 *
 * It has to outlive the session cookies (30 days) by a wide margin: signing out
 * clears those and must not take the theme with it, so the theme cookie is
 * written by a different code path with a different lifetime on purpose.
 */
export const THEME_COOKIE_MAX_AGE = 365 * 24 * 60 * 60;

/* ------------------------------------------------------------------ *
 * Validation
 * ------------------------------------------------------------------ */

/**
 * Anything at all in, one of the known values out.
 *
 * A cookie is a string a user can type. These are the only two doors it comes
 * through, on the server and in the browser alike, and they never throw — a
 * hand-edited cookie should give you the default theme, not a 500 on every page.
 */
export function toAppearance(value: string | undefined): Appearance {
  return (APPEARANCES as readonly string[]).includes(value ?? '')
    ? (value as Appearance)
    : DEFAULT_APPEARANCE;
}

export function toAccent(value: string | undefined): Accent {
  return (ACCENTS as readonly string[]).includes(value ?? '') ? (value as Accent) : DEFAULT_ACCENT;
}

export interface ThemePreference {
  appearance: Appearance;
  accent: Accent;
}

/* ------------------------------------------------------------------ *
 * Applying it
 * ------------------------------------------------------------------ */

/**
 * The preference, resolved to what the page is painted as.
 *
 * `system` is the only case that needs the second argument, and it is the reason
 * `theme.css` has no media query: the decision is made here, once, and the CSS
 * only ever sees `light` or `dark`. Two implementations of "is it dark" is one
 * too many, and the one in CSS cannot be tested.
 */
export function resolveAppearance(
  appearance: Appearance,
  prefersDark: boolean
): ResolvedAppearance {
  if (appearance === 'system') return prefersDark ? 'dark' : 'light';
  return appearance;
}

/** The media query the `system` appearance follows. One string, two callers. */
export const DARK_QUERY = '(prefers-color-scheme: dark)';

/**
 * Write the theme onto the document.
 *
 * Takes the element rather than reaching for `document` so it can be tested
 * against a plain object, and so a subtree — the preview swatches — can be
 * themed by the same function that themes the page.
 */
export function applyTheme(
  element: { dataset: DOMStringMap },
  preference: ThemePreference,
  prefersDark: boolean
): void {
  element.dataset['appearance'] = resolveAppearance(preference.appearance, prefersDark);
  element.dataset['accent'] = preference.accent;
}

/** Read a cookie out of a `document.cookie` string. Empty when absent. */
export function readCookie(jar: string, name: string): string | undefined {
  for (const part of jar.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() !== name) continue;
    try {
      return decodeURIComponent(part.slice(eq + 1).trim());
    } catch {
      // A malformed escape is a corrupt cookie, which means "no preference".
      return undefined;
    }
  }
  return undefined;
}

/**
 * Persist one preference from the browser.
 *
 * Attributes mirror `session-cookie.ts` — `SameSite=Lax`, `Path=/`, `Secure` off
 * the moment the page is not on https so development over plain http still
 * works, and NO `Domain`, so a clinic's preference stays on that clinic's
 * subdomain exactly as its session does.
 */
export function writeThemeCookie(name: string, value: string): void {
  const secure = window.location.protocol === 'https:' ? '; Secure' : '';
  document.cookie = `${name}=${encodeURIComponent(value)}; Path=/; Max-Age=${THEME_COOKIE_MAX_AGE}; SameSite=Lax${secure}`;
}

/* ------------------------------------------------------------------ *
 * The boot script
 * ------------------------------------------------------------------ */

/**
 * What runs before anything is painted.
 *
 * THIS IS THE WHOLE ANSWER TO THE DARK-MODE FLASH. The document is served with
 * no theme attributes, so without this the first paint is the light default and
 * a dark-mode user sees a white page for a frame before React arrives. A
 * synchronous script in `<head>` runs before the browser paints anything, which
 * is why it is inline and blocking rather than a component or an effect — both
 * of those run after the first paint, which is exactly too late.
 *
 * Built from the constants above rather than written out, so the allow-lists
 * here cannot drift from `ACCENTS` and `APPEARANCES`. It is `JSON.stringify`d
 * into the source, so no id can inject anything even if one were added carelessly.
 *
 * Everything is wrapped in try/catch. A browser with cookies disabled, or a
 * privacy mode that throws on `document.cookie`, gets the default theme — never
 * a script error before the application has loaded.
 */
export function themeBootScript(): string {
  return [
    '(function(){try{',
    `var A=${JSON.stringify(APPEARANCES)},C=${JSON.stringify(ACCENTS)};`,
    'var j=document.cookie||"",g=function(n){',
    'var p=j.split(";");for(var i=0;i<p.length;i++){var e=p[i].indexOf("=");',
    'if(e<0)continue;if(p[i].slice(0,e).trim()!==n)continue;',
    'try{return decodeURIComponent(p[i].slice(e+1).trim())}catch(x){return ""}}return ""};',
    `var a=g(${JSON.stringify(APPEARANCE_COOKIE)}),c=g(${JSON.stringify(ACCENT_COOKIE)});`,
    `if(A.indexOf(a)<0)a=${JSON.stringify(DEFAULT_APPEARANCE)};`,
    `if(C.indexOf(c)<0)c=${JSON.stringify(DEFAULT_ACCENT)};`,
    `if(a==="system")a=window.matchMedia(${JSON.stringify(DARK_QUERY)}).matches?"dark":"light";`,
    'var r=document.documentElement;r.dataset.appearance=a;r.dataset.accent=c;',
    '}catch(e){}})();',
  ].join('');
}
