#!/usr/bin/env node
/**
 * .kb lookup — "does something that does X already exist?"
 *
 *   pnpm kb:find slug              name, signature or summary matches /slug/i
 *   pnpm kb:find '^hash' --name    match the name column only
 *   pnpm kb:find redis --export    exported symbols only
 *   pnpm kb:find cache --kind fn   restrict to one kind
 *
 * Plain `grep` over symbols.tsv works too, but file paths contain words like
 * `[slug]`, so a bare grep matches every route under that segment. This only
 * searches the columns you asked for.
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const KB = resolve(dirname(fileURLToPath(import.meta.url)));
const TSV = join(KB, 'symbols.tsv');

const argv = process.argv.slice(2);
const flags = new Set(argv.filter((a) => a.startsWith('--')));
const kindIdx = argv.indexOf('--kind');
const kindWanted = kindIdx >= 0 ? argv[kindIdx + 1] : null;
const terms = argv.filter((a, i) => !a.startsWith('--') && !(kindIdx >= 0 && i === kindIdx + 1));

if (!terms.length) {
  console.error('usage: pnpm kb:find <pattern> [--name] [--export] [--kind fn]');
  process.exit(2);
}
if (!existsSync(TSV)) {
  console.error('symbols.tsv missing — run: pnpm kb');
  process.exit(2);
}

let re;
try {
  re = new RegExp(terms.join('|'), 'i');
} catch (err) {
  console.error(`bad pattern: ${err.message}`);
  process.exit(2);
}

const rows = readFileSync(TSV, 'utf8')
  .split('\n')
  .filter((l) => l && !l.startsWith('#'))
  .map((l) => {
    const [name, kind, visibility, location, module, sig, summary] = l.split('\t');
    return { name, kind, visibility, location, module, sig, summary };
  })
  .filter((r) => {
    if (flags.has('--export') && r.visibility !== 'export') return false;
    if (kindWanted && !r.kind.startsWith(kindWanted)) return false;
    return flags.has('--name')
      ? re.test(r.name)
      : re.test(r.name) || re.test(r.sig) || re.test(r.summary);
  });

if (!rows.length) {
  console.log('no match — nothing in the codebase does this yet.');
  process.exit(0);
}

const pad = (s, n) => s.padEnd(n).slice(0, n);
const w = Math.min(34, Math.max(...rows.map((r) => r.name.length)));
for (const r of rows) {
  const vis = r.visibility === 'export' ? ' ' : '·';
  console.log(`${vis} ${pad(r.name, w)}  ${pad(r.kind, 14)} ${r.location}`);
  if (r.sig) console.log(`  ${' '.repeat(w)}  ${r.sig}`);
  if (r.summary) console.log(`  ${' '.repeat(w)}  ${r.summary}`);
}
console.log(`\n${rows.length} match(es). '·' = not exported.`);
