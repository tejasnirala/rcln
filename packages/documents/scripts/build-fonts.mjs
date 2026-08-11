/**
 * Vendor the document typefaces into a generated TypeScript module.
 *
 *   pnpm --filter @rcln/documents run fonts          rewrite it
 *   pnpm --filter @rcln/documents run fonts:check    fail if it is stale
 *
 * ⚠️ WHY THE BYTES ARE COMMITTED AS BASE64 RATHER THAN READ FROM DISK AT
 *   RUNTIME, WHICH IS THE OBVIOUS IMPLEMENTATION. The same template is rendered
 *   in three processes — the API, the worker, and Next's server runtime in
 *   `apps/web` — and a `readFileSync` into `node_modules/@fontsource/...` is a
 *   different gamble in each of them: a bundler that traces imports does not
 *   trace a path built at runtime, `pnpm deploy --prod` prunes a devDependency,
 *   and Next inlines server code unless the package is externalised by name.
 *
 *   Every one of those failures is SILENT. A missing `@font-face` src does not
 *   throw; the browser falls back to a system font, the page still renders, and
 *   the only symptom is that the PDF the patient receives is set in something
 *   other than the preview the clinic approved — which is the exact drift this
 *   whole one-template design exists to prevent. A string constant cannot fail
 *   that way in one process and not another.
 *
 *   The cost is ~150KB of generated source that no human ever reads, and a
 *   regeneration step when the font dependency moves. `fonts:check` runs in CI
 *   so the second one cannot be forgotten quietly.
 *
 * ⚠️ THE SUBSETS ARE `latin` AND `latin-ext`, AND DROPPING THE SECOND ONE LOSES
 *   THE RUPEE SIGN. Google's `latin` unicode-range stops at U+20AC (the euro);
 *   ₹ is U+20B9, which lives in `latin-ext`'s U+20AD-20C0. An India-first
 *   product whose invoices cannot print their own currency symbol would be a
 *   remarkable thing to ship, and the failure looks like a missing-glyph box on
 *   a tax document rather than an error anywhere.
 */

import { createRequire } from 'node:module';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
const target = resolve(here, '../src/fonts.generated.ts');

/**
 * What the template actually sets.
 *
 * Three faces and no more. Every additional weight is ~30KB of base64 in the
 * generated file and one more thing that has to be present for the preview and
 * the print to agree — so a face earns its place by being used, not by being
 * available. Italic is deliberately absent: nothing on an invoice is emphasised
 * that way.
 */
const FACES = [
  { constant: 'SANS_400', family: 'ibm-plex-sans', weight: 400 },
  { constant: 'SANS_600', family: 'ibm-plex-sans', weight: 600 },
  { constant: 'MONO_400', family: 'ibm-plex-mono', weight: 400 },
];

const SUBSETS = ['latin', 'latin-ext'];

function dataUri(family, subset, weight) {
  const file = require.resolve(
    `@fontsource/${family}/files/${family}-${subset}-${String(weight)}-normal.woff2`
  );
  const bytes = readFileSync(file);
  return `data:font/woff2;base64,${bytes.toString('base64')}`;
}

const banner = `/**
 * GENERATED FILE — DO NOT EDIT.
 *
 * Written by \`packages/documents/scripts/build-fonts.mjs\`, which explains why
 * the bytes are here rather than being read from node_modules at runtime.
 * Regenerate with \`pnpm --filter @rcln/documents run fonts\`.
 *
 * IBM Plex Sans and IBM Plex Mono, SIL Open Font License 1.1.
 * https://github.com/IBM/plex — subsets: ${SUBSETS.join(' + ')}.
 */
/* eslint-disable */
`;

const body = FACES.map((face) => {
  const uris = SUBSETS.map((subset) => dataUri(face.family, subset, face.weight));
  return uris
    .map(
      (uri, index) =>
        `export const ${face.constant}_${SUBSETS[index].toUpperCase().replace('-', '_')} =\n  '${uri}';\n`
    )
    .join('\n');
}).join('\n');

const next = `${banner}\n${body}`;

if (process.argv.includes('--check')) {
  let current = '';
  try {
    current = readFileSync(target, 'utf8');
  } catch {
    /* missing counts as stale */
  }
  if (current !== next) {
    console.error('fonts.generated.ts is stale. Run: pnpm --filter @rcln/documents run fonts');
    process.exit(1);
  }
  console.log('fonts.generated.ts is up to date');
} else {
  writeFileSync(target, next);
  console.log(
    `wrote ${target} — ${String(FACES.length * SUBSETS.length)} faces, ${String(Math.round(next.length / 1024))}KB`
  );
}
