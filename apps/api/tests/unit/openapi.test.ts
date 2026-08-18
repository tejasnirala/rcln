/**
 * The documentation audit.
 *
 * ⚠️ THE BUG THIS EXISTS TO CATCH IS DRIFT, AND DRIFT IS SILENT BY NATURE. A
 *   renamed route, a deleted endpoint, a tightened permission — none of them
 *   breaks a build, and all of them leave the API reference confidently
 *   describing something that is no longer true. A reference a customer cannot
 *   trust is worse than no reference: they write against it and find out at
 *   runtime.
 *
 *   So the document is asserted against the routers rather than proof-read.
 */
import routes from '../../src/routes/index.js';
import webhookRoutes from '../../src/routes/v1/webhooks.routes.js';
import { buildOpenApiDocument } from '../../src/openapi/document.js';
import { assertMountsCover, MOUNTS, TAGS } from '../../src/openapi/mounts.js';
import { countRoutes, introspectRouter, reachableRouters } from '../../src/openapi/introspect.js';
import { DOCS } from '../../src/openapi/registry/index.js';
import * as FIXTURES from '../../src/openapi/registry/fixtures.js';
import { endpointKey } from '../../src/openapi/types.js';
import { disconnectDb } from '../../src/db/prisma.js';
import { redis } from '../../src/utils/redis.js';

/*
 * Importing a router pulls the whole service layer behind it, which opens a
 * Redis connection at module load whether or not anything uses it. Same note
 * `route-gates.test.ts` carries, and the same hang without it.
 */
afterAll(async () => {
  await disconnectDb();
  await redis.quit();
});

const toOpenApiPath = (path: string): string => path.replace(/:([A-Za-z0-9_]+)/g, '{$1}');

/** Every `METHOD /full/path` the mount table can reach. */
function declaredEndpointKeys(): Set<string> {
  const keys = new Set<string>();
  for (const mount of MOUNTS) {
    for (const route of introspectRouter(mount.router)) {
      const path = toOpenApiPath(`${mount.prefix}${route.path === '/' ? '' : route.path}`);
      keys.add(endpointKey(route.method, path));
    }
  }
  return keys;
}

describe('OpenAPI document', () => {
  const document = buildOpenApiDocument();

  /*
   * ⚠️ THE FULL SPEC VALIDATION IS `pnpm docs:validate`, NOT A CASE HERE, AND
   *   THAT IS NOT A GAP BEING WAVED THROUGH. `@scalar/openapi-parser` returns
   *   `valid: false` with an EMPTY error list under Jest's experimental VM
   *   modules — for a three-line document that is unarguably valid — so a case
   *   asserting on it would fail forever while telling us nothing. The script
   *   runs the same parser under plain Node, where it works, and the structural
   *   assertions below cover the failure the parser actually caught here: a
   *   path template variable with no matching parameter.
   */
  it('is shaped like an OpenAPI 3.1 document', () => {
    expect(document['openapi']).toBe('3.1.0');
    expect(document['info']).toMatchObject({ title: 'rcln API' });
    expect(Object.keys(document['paths'] as object).length).toBeGreaterThan(300);
  });

  it('declares a parameter for every variable in every path template', () => {
    const paths = document['paths'] as Record<
      string,
      Record<string, { parameters?: { name: string; in: string }[] }>
    >;
    const missing: string[] = [];

    for (const [path, operations] of Object.entries(paths)) {
      const variables = [...path.matchAll(/\{([A-Za-z0-9_]+)\}/g)].map((match) => match[1]);
      for (const [method, operation] of Object.entries(operations)) {
        const declared = new Set(
          (operation.parameters ?? []).filter((p) => p.in === 'path').map((p) => p.name)
        );
        for (const variable of variables) {
          if (variable !== undefined && !declared.has(variable)) {
            missing.push(`${method.toUpperCase()} ${path} -> {${variable}}`);
          }
        }
      }
    }

    expect(missing).toEqual([]);
  });

  it('gives every operation a summary, a description and a success response', () => {
    const paths = document['paths'] as Record<
      string,
      Record<
        string,
        { summary?: string; description?: string; responses?: Record<string, unknown> }
      >
    >;
    const incomplete: string[] = [];

    for (const [path, operations] of Object.entries(paths)) {
      for (const [method, operation] of Object.entries(operations)) {
        const statuses = Object.keys(operation.responses ?? {});
        const hasSuccess = statuses.some((status) => status.startsWith('2'));
        if (!operation.summary || !operation.description || !hasSuccess) {
          incomplete.push(`${method.toUpperCase()} ${path}`);
        }
      }
    }

    expect(incomplete).toEqual([]);
  });

  /**
   * ⚠️ THE ASSERTION THAT MAKES THE MOUNT TABLE SAFE. `mounts.ts` restates the
   *   prefixes because Express 5 discards them, and a restated fact is a fact
   *   that can go stale. Comparing router OBJECTS — not names, not paths —
   *   means a router mounted in `v1/index.ts` and forgotten in `mounts.ts` fails
   *   here rather than quietly vanishing from the documentation.
   */
  it('documents every router the app actually mounts', () => {
    /*
     * Walked from the API routers rather than from the app, so `/docs` — which
     * is app-level and describes the API rather than being part of it — is out
     * of scope. `webhookRoutes` is added by hand because app.ts mounts it
     * directly, ahead of the body parsers.
     */
    const reachable = new Set([...reachableRouters(routes), webhookRoutes]);
    expect(() => {
      assertMountsCover(reachable);
    }).not.toThrow();
  });

  it('describes every single route the API can serve', () => {
    const reachable = countRoutes(routes) + countRoutes(webhookRoutes);
    const documented = Object.values(document['paths'] as Record<string, object>).reduce(
      (total, operations) => total + Object.keys(operations).length,
      0
    );

    expect(documented).toBe(reachable);
  });

  /**
   * ⚠️ A REGISTRY KEY THAT MATCHES NOTHING IS A PARAGRAPH ABOUT AN ENDPOINT
   *   THAT NO LONGER EXISTS, and it is exactly what a rename leaves behind.
   *   The reverse — a route with no entry — is reported as coverage below
   *   rather than failed, because a new endpoint should not block a deploy on
   *   its prose.
   */
  it('has no registry entry for a route that does not exist', () => {
    const real = declaredEndpointKeys();
    const orphans = Object.keys(DOCS).filter((key) => !real.has(key));
    expect(orphans).toEqual([]);
  });

  it('reports its own coverage', () => {
    const coverage = document['x-rcln-coverage'] as { endpoints: number; described: number };
    expect(coverage.endpoints).toBeGreaterThan(400);
    expect(coverage.described).toBe(Object.keys(DOCS).length);
  });

  /**
   * ⚠️ EVERY ENDPOINT CARRIES PROSE, AND THIS IS A HARD FAILURE.
   *
   *   This case used to be the reverse: a route with no registry entry was
   *   REPORTED as coverage rather than failed, on the reasoning that a new
   *   endpoint should not block a deploy on its documentation. That reasoning is
   *   what took the document to 425 endpoints of which 43 said anything — the
   *   other 382 rendered as a bare `GET /api/v1/doctors` with no description, no
   *   response shape and nothing to copy.
   *
   *   A summary is one line and the failure names the exact key to add, so the
   *   cost of this gate is a minute. The cost of not having it is measured in
   *   years and was paid once already.
   */
  it('has a registry entry for every route the API serves', () => {
    const undocumented = [...declaredEndpointKeys()].filter((key) => DOCS[key] === undefined);
    expect(undocumented).toEqual([]);
  });

  /**
   * ⚠️ EVERY ID IN THE DOCUMENT COMES FROM `fixtures.ts`.
   *
   *   The examples are worth reading only if they tell ONE story: the patient in
   *   Patients is the patient the appointment books, whose prescription the
   *   pharmacy dispenses out of the batch procurement received. That property
   *   holds only while every file imports the same id, and it is destroyed by a
   *   single invented uuid — which is invisible in review, because one uuid looks
   *   exactly like another.
   *
   *   So: no literal uuid in a registry file. Add it to `fixtures.ts` and import
   *   it, which is also where it gets a name and a sentence saying what it is.
   */
  it('draws every identifier in its examples from the fixture set', () => {
    const declared = new Set<string>();
    /* Nested fixture objects (BRANCH, PATIENT, …) carry ids of their own. */
    const collect = (value: unknown): void => {
      if (typeof value === 'string') {
        declared.add(value);
        return;
      }
      if (Array.isArray(value)) {
        for (const entry of value) collect(entry);
        return;
      }
      if (typeof value === 'object' && value !== null) {
        for (const entry of Object.values(value)) collect(entry);
      }
    };
    collect(FIXTURES as unknown);

    /*
     * ⚠️ ONLY THE `example` / `examples` SUBTREES, NOT THE WHOLE DOCUMENT. A
     *   uuid SCHEMA carries the nil and max uuids inside its validation
     *   `pattern`, and those are part of the format rather than data anybody
     *   wrote. Scanning the document wholesale reports them for ever.
     */
    const UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/g;
    const strays = new Set<string>();

    const scan = (value: unknown, insideExample: boolean): void => {
      if (typeof value === 'string') {
        if (!insideExample) return;
        for (const id of value.match(UUID) ?? []) {
          if (!declared.has(id)) strays.add(id);
        }
        return;
      }
      if (Array.isArray(value)) {
        for (const entry of value) scan(entry, insideExample);
        return;
      }
      if (typeof value !== 'object' || value === null) return;
      for (const [key, entry] of Object.entries(value)) {
        scan(entry, insideExample || key === 'example' || key === 'examples');
      }
    };
    scan(document, false);

    expect([...strays]).toEqual([]);
  });

  it('gives every operation a tag drawn from the declared set', () => {
    const paths = document['paths'] as Record<string, Record<string, { tags?: string[] }>>;
    const known = new Set<string>(TAGS);

    const untagged: string[] = [];
    for (const [path, operations] of Object.entries(paths)) {
      for (const [method, operation] of Object.entries(operations)) {
        const tags = operation.tags ?? [];
        if (tags.length === 0 || !tags.every((tag) => known.has(tag))) {
          untagged.push(`${method.toUpperCase()} ${path} -> ${JSON.stringify(tags)}`);
        }
      }
    }
    expect(untagged).toEqual([]);
  });

  /**
   * Every `$ref` resolves. The parser checks this too, but a targeted assertion
   * names the offender instead of reporting one line of a 1.9 MB document.
   */
  it('has no dangling schema references', () => {
    const components = Object.keys(
      (document['components'] as { schemas: Record<string, unknown> }).schemas
    );
    const refs = [...JSON.stringify(document).matchAll(/"\$ref":"([^"]+)"/g)].map(
      (match) => match[1] ?? ''
    );

    const dangling = [
      ...new Set(
        refs
          .map((ref) => ref.replace('#/components/schemas/', '').split('/')[0] ?? '')
          .filter((name) => !components.includes(name))
      ),
    ];
    expect(dangling).toEqual([]);
  });

  /**
   * ⚠️ THE ONE ASSERTION ABOUT THE CONTENT RATHER THAN THE SHAPE. An endpoint
   *   that gates on a permission has to SAY which one: the 403 body deliberately
   *   names no permission, so this document is the only place an integrator can
   *   find out what to grant.
   */
  it('names the permission on every gated operation', () => {
    const paths = document['paths'] as Record<string, Record<string, { description?: string }>>;
    const gated: string[] = [];

    for (const mount of MOUNTS) {
      for (const route of introspectRouter(mount.router)) {
        if (route.permissions === null || route.permissions.length === 0) continue;
        const path = toOpenApiPath(`${mount.prefix}${route.path === '/' ? '' : route.path}`);
        const description = paths[path]?.[route.method.toLowerCase()]?.description ?? '';
        for (const code of route.permissions) {
          if (!description.includes(`\`${code}\``)) gated.push(`${route.method} ${path} (${code})`);
        }
      }
    }

    expect(gated).toEqual([]);
  });
});
