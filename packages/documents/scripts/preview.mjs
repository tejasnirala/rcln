/**
 * Render the sample invoices to HTML, so the document can be LOOKED AT.
 *
 *   docker compose exec worker sh -c \
 *     'cd packages/documents && node scripts/preview.mjs /tmp/preview'
 *
 * ⚠️ A DEVELOPMENT TOOL, NOT A CODE PATH. Nothing in the application imports it,
 *   and it deliberately renders FIXTURES rather than reading the database — the
 *   point is to see the template's edge cases (a bill that breaks across pages,
 *   a zero-decimal currency, a voided document) without having to construct each
 *   one through the API first.
 *
 *   The PDF half is not here on purpose: turning this HTML into a PDF is the
 *   worker's `renderPdf`, and a second renderer in a script is exactly the kind
 *   of "nearly the same" path that makes a preview stop matching a print.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import {
  renderInvoiceHtml,
  indianInvoice,
  unregisteredInvoice,
  yenInvoice,
  longInvoice,
} from '../dist/index.js';

const outDir = resolve(process.argv[2] ?? './preview');
await mkdir(outDir, { recursive: true });

const documents = {
  'indian-gst': indianInvoice,
  unregistered: unregisteredInvoice,
  japan: yenInvoice,
  'multi-page': longInvoice(45),
  voided: { ...indianInvoice, status: 'VOID' },
};

for (const [name, data] of Object.entries(documents)) {
  const file = resolve(outDir, `${name}.html`);
  await writeFile(file, renderInvoiceHtml(data));
  console.log(`${file}`);
}
