'use client';

import { useCallback, useState, useSyncExternalStore } from 'react';
import { Check } from 'lucide-react';
import { cn } from '@/lib/cn';
import {
  ACCENT_COOKIE,
  ACCENT_OPTIONS,
  APPEARANCE_COOKIE,
  APPEARANCE_OPTIONS,
  DARK_QUERY,
  applyTheme,
  writeThemeCookie,
  type Accent,
  type Appearance,
  type ResolvedAppearance,
  resolveAppearance,
  type ThemePreference,
} from '@/lib/theme';

/**
 * The appearance screen.
 *
 * TWO CHOICES, AND THE PAGE IS THE PREVIEW. There is no Save, no Apply and no
 * confirmation: picking writes the cookie and re-points the document's theme in
 * the same tick, so the screen you are looking at — including this control — is
 * already wearing the answer. A preview pane beside a form would be a smaller,
 * less truthful version of what is already on screen.
 *
 * THE SWATCHES ARE THE REAL PALETTE, NOT A PICTURE OF IT.
 *   Each card carries `data-accent` (and `data-appearance`) of the option it
 *   offers, so `bg-drape` inside it resolves through that palette instead of the
 *   page's — the same cascade that themes the application, aimed at a 120px box.
 *   Nothing here holds a colour, which is what makes a palette impossible to
 *   misrepresent: change a hex in theme.css and this screen changes with it.
 *
 * `initial*` comes from the server, which read the same cookies. Without it the
 * first client render would show the default selected and correct itself a beat
 * later — the theme would be right (the boot script saw to that) and the tick
 * would be on the wrong card.
 */
export function ThemeSettings({
  initialAppearance,
  initialAccent,
}: {
  initialAppearance: Appearance;
  initialAccent: Accent;
}) {
  const [preference, setPreference] = useState<ThemePreference>({
    appearance: initialAppearance,
    accent: initialAccent,
  });

  /*
   * What the page is actually painted as, which is what the swatches must be
   * drawn in — an accent's dark ramp previewed on a light page would be a lie.
   *
   * `useSyncExternalStore` rather than state plus an effect: the OS colour
   * setting IS an external store, React 19 has the hook for exactly this, and it
   * gets the server snapshot right for free. Reading `matchMedia` during render
   * or seeding state from it in an effect are the two ways this goes wrong — the
   * first is a hydration mismatch, the second a cascading render on every mount.
   */
  const prefersDark = useSyncExternalStore(subscribeToScheme, deviceIsDark, serverIsLight);

  const commit = useCallback(
    (next: ThemePreference) => {
      setPreference(next);
      writeThemeCookie(APPEARANCE_COOKIE, next.appearance);
      writeThemeCookie(ACCENT_COOKIE, next.accent);
      applyTheme(document.documentElement, next, window.matchMedia(DARK_QUERY).matches);
    },
    [setPreference]
  );

  const resolved = resolveAppearance(preference.appearance, prefersDark);

  return (
    <div className="max-w-3xl">
      <header>
        <p className="eyebrow">This device</p>
        <h1 className="font-display text-ink mt-2 text-3xl tracking-tight">Appearance</h1>
        <p className="text-muted mt-3 text-sm leading-relaxed">
          How rcln looks on this browser. The choice is kept here, not on your account, so a shared
          terminal at the front desk and your own laptop can each be set to suit the room they are
          in. It takes effect as you pick it.
        </p>
      </header>

      <Group
        legend="Mode"
        hint="Dark keeps the same layout and the same colours at the same contrast — it is the surfaces that change, not the design."
      >
        <div className="mt-4 grid gap-3 sm:grid-cols-3">
          {APPEARANCE_OPTIONS.map((option) => (
            <Choice
              key={option.id}
              name="appearance"
              value={option.id}
              label={option.label}
              description={option.description}
              checked={preference.appearance === option.id}
              onSelect={() => commit({ ...preference, appearance: option.id })}
            >
              <ModePreview mode={option.id} accent={preference.accent} />
            </Choice>
          ))}
        </div>
      </Group>

      <Group
        legend="Accent"
        hint="Used for primary actions, the active tab, links and focus rings. Success, warning and error keep their own colours in every accent — an outcome is not a preference."
      >
        <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {ACCENT_OPTIONS.map((option) => (
            <Choice
              key={option.id}
              name="accent"
              value={option.id}
              label={option.label}
              description={option.description}
              checked={preference.accent === option.id}
              onSelect={() => commit({ ...preference, accent: option.id })}
            >
              <AccentPreview accent={option.id} resolved={resolved} />
            </Choice>
          ))}
        </div>
      </Group>

      <p className="text-muted border-rule mt-10 border-t pt-6 text-[0.8125rem] leading-relaxed">
        Saved in this browser for a year. Signing out does not clear it, and it is never sent to
        another clinic — the same rule the rest of your session follows.
      </p>
    </div>
  );
}

/*
 * The device's colour setting, as an external store. Module-level so the
 * subscribe function is referentially stable — a new one each render would tear
 * the listener down and set it up again on every keystroke elsewhere.
 */
function subscribeToScheme(onChange: () => void): () => void {
  const media = window.matchMedia(DARK_QUERY);
  media.addEventListener('change', onChange);
  return () => media.removeEventListener('change', onChange);
}

const deviceIsDark = () => window.matchMedia(DARK_QUERY).matches;

/** The server has no device. It renders the default, and the client corrects it. */
const serverIsLight = () => false;

/* ------------------------------------------------------------------ *
 * The two controls
 * ------------------------------------------------------------------ */

function Group({
  legend,
  hint,
  children,
}: {
  legend: string;
  hint: string;
  children: React.ReactNode;
}) {
  return (
    <fieldset className="mt-10">
      <legend className="text-ink text-sm font-medium">{legend}</legend>
      <p className="text-muted mt-1.5 max-w-prose text-[0.8125rem] leading-snug">{hint}</p>
      {children}
    </fieldset>
  );
}

/**
 * One option, as a real radio.
 *
 * The input is `sr-only` rather than absent: a div with `role="radio"` would
 * have to reimplement arrow-key roving, the group's single tab stop and the
 * announcement, and every one of those is free from a native radio in a
 * fieldset. The card is painted from React state and the input's `checked`
 * carries the same value, so the visible tick and the accessibility tree cannot
 * disagree about which option is chosen.
 *
 * Selection is carried by a tick and a border weight as well as by colour
 * (WCAG 1.4.1) — on a screen whose entire subject is colour, colour alone would
 * be a particularly poor way to say which one you chose.
 */
function Choice({
  name,
  value,
  label,
  description,
  checked,
  onSelect,
  children,
}: {
  name: string;
  value: string;
  label: string;
  description: string;
  checked: boolean;
  onSelect: () => void;
  children: React.ReactNode;
}) {
  return (
    <label
      className={cn(
        'group bg-card relative flex cursor-pointer flex-col gap-3 rounded-lg border p-3 transition-colors',
        // The real input is `sr-only`, so the global focus ring lands on
        // something invisible. `has-` moves it to the card the user sees.
        'has-[:focus-visible]:outline-signal has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2',
        checked ? 'border-drape ring-drape ring-1' : 'border-rule hover:border-muted'
      )}
    >
      <input
        type="radio"
        name={name}
        value={value}
        checked={checked}
        onChange={onSelect}
        className="sr-only"
      />
      {children}
      <span className="flex items-start justify-between gap-2">
        <span>
          <span className="text-ink block text-sm font-medium">{label}</span>
          <span className="text-muted mt-0.5 block text-[0.75rem] leading-snug">{description}</span>
        </span>
        {/* A tick, not a coloured edge alone (WCAG 1.4.1) — on a screen whose
            whole subject is colour, colour is the worst available way to say
            which option is the chosen one. */}
        <span
          className={cn(
            'mt-0.5 grid size-4 shrink-0 place-items-center rounded-full',
            checked ? 'bg-drape text-paper' : 'border-rule border'
          )}
        >
          {checked ? (
            <>
              <Check className="size-3" strokeWidth={3} aria-hidden="true" />
              <span className="sr-only">Selected</span>
            </>
          ) : null}
        </span>
      </span>
    </label>
  );
}

/* ------------------------------------------------------------------ *
 * The previews
 * ------------------------------------------------------------------ */

/**
 * A miniature of the application shell — header, nav row with one active tab, a
 * card — painted from the tokens of the theme this card is offering.
 *
 * `System` shows both halves rather than showing whichever one this device
 * happens to be on right now, because that is what the option means. The seam is
 * the point of the drawing.
 */
function ModePreview({ mode, accent }: { mode: Appearance; accent: Accent }) {
  if (mode === 'system') {
    return (
      <span className="border-rule flex h-20 overflow-hidden rounded-md border">
        <span className="w-1/2">
          <Miniature appearance="light" accent={accent} half />
        </span>
        <span className="w-1/2">
          <Miniature appearance="dark" accent={accent} half />
        </span>
      </span>
    );
  }

  return (
    <span className="border-rule block h-20 overflow-hidden rounded-md border">
      <Miniature appearance={mode} accent={accent} />
    </span>
  );
}

function Miniature({
  appearance,
  accent,
  half,
}: {
  appearance: ResolvedAppearance;
  accent: Accent;
  half?: boolean;
}) {
  return (
    <span
      // The whole trick, in two attributes: this subtree resolves every token
      // through the palette named here instead of the page's.
      data-appearance={appearance}
      data-accent={accent}
      className="bg-paper flex h-20 flex-col gap-1 p-1.5"
      aria-hidden="true"
    >
      <span className="bg-card border-rule flex items-center gap-1 rounded-xs border px-1 py-1">
        <span className="bg-drape size-1.5 rounded-full" />
        <span className="bg-rule h-1 w-4 rounded-full" />
      </span>
      <span className="flex items-center gap-1">
        <span className="bg-drape h-1.5 w-5 rounded-full" />
        <span className="bg-rule h-1.5 w-4 rounded-full" />
        {half ? null : <span className="bg-rule h-1.5 w-3 rounded-full" />}
      </span>
      <span className="bg-card border-rule flex-1 rounded-xs border p-1">
        <span className="bg-ink/70 block h-1 w-8 rounded-full" />
        <span className="bg-muted/50 mt-1 block h-1 w-full rounded-full" />
      </span>
    </span>
  );
}

/**
 * A palette, shown as the four things it decides: the primary action, the tint
 * behind a selected row, the page and a surface on it. Four chips say more than
 * a single dot, because an accent is a ramp and it is the ramp that has to hold
 * together.
 */
function AccentPreview({ accent, resolved }: { accent: Accent; resolved: ResolvedAppearance }) {
  return (
    <span
      data-appearance={resolved}
      data-accent={accent}
      className="bg-paper border-rule flex items-center gap-2 rounded-md border p-2.5"
      aria-hidden="true"
    >
      <span className="bg-drape text-paper rounded-sm px-2 py-1 text-[0.625rem] font-medium">
        Action
      </span>
      <span className="bg-drape-tint text-drape-deep rounded-sm px-2 py-1 text-[0.625rem]">
        Selected
      </span>
      <span className="ml-auto flex items-center gap-1">
        <span className="bg-card border-rule size-4 rounded-full border" />
        <span className="bg-signal size-4 rounded-full" />
      </span>
    </span>
  );
}
