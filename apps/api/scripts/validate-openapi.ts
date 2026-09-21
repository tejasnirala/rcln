/**
 * Validate the generated OpenAPI document against the 3.1 specification.
 *
 * ⚠️ A SCRIPT RATHER THAN A JEST CASE, AND NOT BY PREFERENCE. Under Jest's
 *   experimental VM modules `@scalar/openapi-parser` reports `valid: false`
 *   with an EMPTY error list — for a three-line document that is unarguably
 *   valid — so a case asserting on it would fail forever while telling us
 *   nothing. Here, under plain Node, the same parser works.
 *   `tests/unit/openapi.test.ts` covers the structural invariants; this covers
 *   conformance, and it is the check that caught the two real defects the
 *   document shipped with on its first build: a `$ref` carrying two fragment
 *   markers, and a path template variable that no parameter declared.
 *
 * Run it with `pnpm docs:validate`.
 */
import { validate } from '@scalar/openapi-parser';
import { buildOpenApiDocument } from '../src/openapi/document.js';

interface Coverage {
  endpoints: number;
  described: number;
  routers: number;
}

const document = buildOpenApiDocument();
const coverage = document['x-rcln-coverage'] as Coverage;
const paths = document['paths'] as Record<string, unknown>;
const schemas = (document['components'] as { schemas: Record<string, unknown> }).schemas;

console.log(
  `${String(coverage.endpoints)} endpoints across ${String(coverage.routers)} routers; ${String(coverage.described)} carry hand-written documentation.`
);
console.log(
  `${String(Object.keys(paths).length)} paths, ${String(Object.keys(schemas).length)} component schemas, ${String(Math.round(JSON.stringify(document).length / 1024))} KB.`
);

const result = await validate(document);

if (!result.valid) {
  console.error('\nOpenAPI validation FAILED:');
  console.error(JSON.stringify(result.errors, null, 2));
  process.exit(1);
}

console.log(`\nValid OpenAPI ${String(result.version)}.`);
process.exit(0);
