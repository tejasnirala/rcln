# ADR-0017 — The theme is a device preference, composed rather than enumerated

**Status:** Accepted

## Context

rcln shipped with one palette — theatre green, later named `surgical` — written
as literal Tailwind colours in `globals.css`. Two requests arrived together: a
dark mode for evening clinics and dim rooms, and a choice of accent so a clinic's
console does not look like every other tenant's.

Three questions had to be answered before a single hex moved, and each has an
obvious answer that is wrong:

1. **Whose preference is it?** The obvious answer is the user's, so it goes in a
   column on `users`. But the front desk's shared terminal under a bright waiting
   room window and the same receptionist's laptop at home want different answers,
   and one column can only hold one of them. It is a property of _this browser on
   this desk_.
2. **How many things is "light | dark × five accents"?** The obvious answer is
   ten — ten stylesheets, or ten class names, or a `if (dark && ember)` somewhere.
   Ten is the number that guarantees the eleventh is wrong: an accent added later
   gets its light ramp and its dark ramp written by different people on different
   days.
3. **When is it applied?** The obvious answer is "in React, from a context". That
   answer produces a white flash on every reload for every dark-mode user,
   because React runs after the browser has painted.

## Decision

**A theme is two identifiers in two cookies, composed in CSS, and applied by a
blocking inline script before the first paint.**

- **Two cookies, `rcln_appearance` and `rcln_accent`**, holding one word each
  from a closed list. One year, `Path=/`, `SameSite=Lax`, host-only, no `Domain`.
  No database column, no API call, no server round trip.
- **An accent is one CSS block** in `app/theme.css` declaring a light ramp and a
  dark ramp, plus one entry in `ACCENTS` in `lib/theme.ts`. The appearance switch
  is written once and applies to all five. Adding a sixth accent touches exactly
  those two places — no component, no class name, no conditional.
- **`theme.css` publishes `--rcln-*` custom properties; `globals.css` maps them
  onto the Tailwind names with `@theme inline`.** So `bg-card` and `text-drape`
  compile to `var(--rcln-*)`, and every screen written before any of this existed
  became themable without being touched.
- **The selection is applied by a synchronous inline `<script>` in `<head>`**
  (`ThemeScript`), built from the same constants the settings screen writes.
  `ThemeSync` then keeps `system` honest for the life of the tab.
- **`system` is resolved in TypeScript, never in CSS.** `theme.css` contains no
  `prefers-color-scheme` query at all; it only ever sees `light` or `dark` on
  `data-appearance`.

## Why cookies rather than the database, in full

A column on `users` is wrong for the reason above — it cannot express
per-device. A column on `organizations` is worse: it makes one clinic's admin
decide whether a colleague with low vision gets dark mode.

The cookie also buys the thing that makes the feature feel finished. The settings
screen writes `document.cookie` and applies the attribute in the same tick, so
switching is instant with no request, no pending state and no optimistic-update
rollback path. A database-backed preference is a round trip on a screen whose
entire job is to be immediately visible.

⚠️ **These two cookies are deliberately NOT `httpOnly`, unlike the session
cookies.** The boot script has to read the value before React exists. That is
acceptable here and nowhere else: the value is one of eight words validated
against a closed list on both sides, it is never interpolated into markup or SQL,
and it authorises nothing. It is not a precedent for anything the server trusts.

## Why compose rather than enumerate

Ten combinations written out is ten things to keep in step. Composed, it is five
palettes plus one appearance switch, and the switch is the same code for the
palette that shipped and the palette added next year. The settings screen's
swatches make the same bet: they are real tokens inside a `data-accent` wrapper,
painted by the cascade, so a preview cannot drift from the palette the way a
duplicated hex list would.

`signal` — the live-state hue, "this is happening right now" — is explicitly
**not** part of an accent, and neither are `success`, `warning` and `danger`. A
status that changed colour with a personalisation setting would stop being a
status. They are declared once for every accent.

## Consequences

- **Never write a raw colour anywhere in `apps/web`.** Not `bg-white`, not
  `text-neutral-900`, not a hex in a `style` prop. Each is correct in exactly one
  of the ten themes and wrong in the other nine — and it will pass review,
  because review happens in the default one.
- **Reading a token in JavaScript reads `--rcln-*`, not `--color-*`.**
  `@theme inline` means the Tailwind names are never emitted as real custom
  properties, so `getPropertyValue('--color-drape')` returns an empty string.
- **`--rcln-scrim` does not invert.** A modal veil is dark in both appearances;
  `bg-scrim/60`, never `bg-ink/40`.
- Settings live at `/appearance` on both the tenant and platform surfaces, behind
  no permission — a personal display preference is not an administrative act.
- Marketing pages stay statically rendered. The theme arrives from a cookie read
  in the browser, so nothing about it forces a dynamic render.
- ⚠️ **Nothing verifies any of this.** `apps/web` has no test suite. A test that
  parsed `theme.css` and asserted every pair's contrast, and one that asserted
  every `ACCENTS` id has a matching `[data-accent]` block, both existed and were
  removed — they were the only tests in `apps/web` and shipped with an
  uninstalled jest toolchain that broke `typecheck` for the whole workspace. The
  ten combinations were contrast-measured by hand; nothing re-measures them.

## How this can be broken

- **Adding a `theme` column to `users` or `organizations`.** It will look like a
  natural home and will immediately be a second source of truth that cannot
  express the case the cookie exists for.
- **Writing a colour literal in a component.** One `bg-white` is invisible in
  nine themes and unreadable in the tenth.
- **Moving the theme application into React** — a provider, an effect, a
  `useLayoutEffect`. All three run after the first paint and restore the flash
  the inline script exists to remove.
- **Adding a `prefers-color-scheme` query to `theme.css`.** That is a second,
  silently divergent implementation of "is it dark", and the one in CSS is the
  one nobody can test.
- **Adding an accent id in `lib/theme.ts` without the matching block in
  `theme.css`.** Nothing typechecks the pairing — one side is TypeScript, the
  other is CSS. The symptom is the previous accent staying on screen, which
  reads as the setting failing to save.
