/**
 * The document typefaces, as `@font-face` rules with the bytes inline.
 *
 * The bytes themselves are in `fonts.generated.ts`; its generator explains at
 * length why they are committed rather than read from `node_modules`. This file
 * is the small amount of CSS that turns them into two families.
 *
 * ⚠️ THE `unicode-range` DECLARATIONS ARE LOAD-BEARING AND ARE NOT AN
 *   OPTIMISATION. They are copied verbatim from the subsets the bytes were cut
 *   from. Get one wrong and the browser is told a face covers a codepoint it
 *   does not: it stops looking, and the glyph renders as a missing-glyph box
 *   instead of falling through to the next `@font-face`. The one that matters
 *   here is `U+20AD-20C0` in `latin-ext`, which is where ₹ lives — the `latin`
 *   subset's range stops at the euro.
 */

import {
  MONO_400_LATIN,
  MONO_400_LATIN_EXT,
  SANS_400_LATIN,
  SANS_400_LATIN_EXT,
  SANS_600_LATIN,
  SANS_600_LATIN_EXT,
} from './fonts.generated.js';

/** Google's `latin` subset range, as shipped by @fontsource. */
const LATIN =
  'U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,' +
  'U+0329,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD';

/** `latin-ext`. ⚠️ Contains U+20AD-20C0 — the rupee sign. */
const LATIN_EXT =
  'U+0100-02BA,U+02BD-02C5,U+02C7-02CC,U+02CE-02D7,U+02DD-02FF,U+0304,U+0308,U+0329,' +
  'U+1D00-1DBF,U+1E00-1E9F,U+1EF2-1EFF,U+2020,U+20A0-20AB,U+20AD-20C0,U+2113,' +
  'U+2C60-2C7F,U+A720-A7FF';

interface Face {
  family: string;
  weight: number;
  src: string;
  range: string;
}

const FACES: readonly Face[] = [
  { family: 'IBM Plex Sans', weight: 400, src: SANS_400_LATIN, range: LATIN },
  { family: 'IBM Plex Sans', weight: 400, src: SANS_400_LATIN_EXT, range: LATIN_EXT },
  { family: 'IBM Plex Sans', weight: 600, src: SANS_600_LATIN, range: LATIN },
  { family: 'IBM Plex Sans', weight: 600, src: SANS_600_LATIN_EXT, range: LATIN_EXT },
  { family: 'IBM Plex Mono', weight: 400, src: MONO_400_LATIN, range: LATIN },
  { family: 'IBM Plex Mono', weight: 400, src: MONO_400_LATIN_EXT, range: LATIN_EXT },
];

/**
 * The `@font-face` block.
 *
 * ⚠️ `font-display` IS DELIBERATELY ABSENT, WHICH MEANS `auto`. Every other
 *   value in that property describes what to show WHILE a font loads over a
 *   network, and there is no network here — the bytes are in the same string as
 *   the rule. `swap` in particular would be actively wrong: it invites the
 *   renderer to paint a fallback first, and Chromium's `page.pdf()` snapshots
 *   whatever is painted.
 */
export function fontFaceCss(): string {
  return FACES.map(
    (face) => `@font-face {
  font-family: '${face.family}';
  font-style: normal;
  font-weight: ${String(face.weight)};
  src: url(${face.src}) format('woff2');
  unicode-range: ${face.range};
}`
  ).join('\n');
}

/**
 * Whether a string is fully covered by the subsets above.
 *
 * ⚠️ NOTHING CALLS THIS TO REFUSE A DOCUMENT, AND IT MUST NOT. A patient whose
 *   name is written in Devanagari, Tamil or Kannada has a name, and refusing to
 *   bill them because the vendored subsets are Latin would be a far worse
 *   failure than the one it prevents. It exists so the render job can LOG that a
 *   document contained glyphs its fonts do not carry — the difference between a
 *   known gap and a silent one.
 *
 * The fix, when it comes, is another `@font-face` above: CSS does fallback
 * natively, and globals.css already notes that IBM Plex has a metrically
 * matched Devanagari sibling. It is a file and a row in `FACES`, not a redesign.
 */
export function unsupportedCodepoints(text: string): string[] {
  const missing = new Set<string>();
  for (const character of text) {
    const point = character.codePointAt(0);
    if (point === undefined) continue;
    if (point < 0x0100) continue;
    if (!covered(point)) missing.add(character);
  }
  return [...missing];
}

const COVERED_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x0000, 0x02ff],
  [0x0304, 0x0304],
  [0x0308, 0x0308],
  [0x0329, 0x0329],
  [0x1d00, 0x1dbf],
  [0x1e00, 0x1e9f],
  [0x1ef2, 0x1eff],
  [0x2000, 0x206f],
  [0x20a0, 0x20c0],
  [0x2113, 0x2113],
  [0x2122, 0x2122],
  [0x2191, 0x2191],
  [0x2193, 0x2193],
  [0x2212, 0x2212],
  [0x2215, 0x2215],
  [0x2c60, 0x2c7f],
  [0xa720, 0xa7ff],
  [0xfeff, 0xfeff],
  [0xfffd, 0xfffd],
];

function covered(point: number): boolean {
  return COVERED_RANGES.some(([start, end]) => point >= start && point <= end);
}
