---
name: api-integration
description: Add or change an rcln API endpoint end to end — Zod contract in @rcln/contracts, permission code, service via withTenant, route with the correct middleware chain, and the web consumer. Invoke with /api-integration <endpoint-or-feature>.
---

# API Integration (rcln)

Wire an endpoint through the monorepo. Unlike a split-repo setup there is no external contract to reverse-engineer: **`@rcln/contracts` _is_ the contract**, and both `apps/api` and `apps/web` infer their types from it. Write the schema first.

**Target:** $ARGUMENTS

## 1. Establish the Contract — `packages/contracts/src/<domain>.ts`

Define the Zod schemas before any handler:

```ts
export const createExampleSchema = z.object({ ... });
export const exampleResponseSchema = z.object({ ... });
export type CreateExampleInput = z.infer<typeof createExampleSchema>;
```

Export from `packages/contracts/src/index.ts`. If you are changing an existing schema, make added fields optional so existing callers and stored payloads keep working, and say explicitly whether the change is breaking.

Contracts are consumed from `dist/` — the package must be built for api and web to see a new export. The dev entrypoint handles this on boot; otherwise `docker compose exec api pnpm --filter @rcln/contracts build`.

## 2. Permission code — `packages/permissions/src/codes.ts`

Add the code, grant it to the right system roles in `roles.ts`. Decide whether the check is org-wide or branch-scoped. Never a string literal at the call site.

## 3. Service — `apps/api/src/services/<domain>.service.ts`

All data access through `withTenant(ctx, …)` / `forTenant(ctx)` from `@rcln/db`. Never the raw Prisma client — eslint's `no-restricted-imports` blocks it, and `@rcln/db/unsafe` is only for genuinely pre-tenant work.

- `organizationId` explicit in the signature (ADR-0005).
- One `withTenant` per logical unit of work, not per query.
- Typed errors from `apps/api/src/utils/errors.ts`; Prisma errors narrowed by `err.name`.

## 4. Route — `apps/api/src/routes/v1/<domain>.routes.ts`

Mount in `routes/v1/index.ts`. The chain is fixed:

```
resolveTenant → authenticate → authorize(CODE) → withTenant → handler
```

- `validate.middleware.ts` with the `@rcln/contracts` schema at the boundary.
- Responses via `apps/api/src/utils/response.ts`; errors bubble to `error.middleware.ts`.
- **Unknown tenant → 404, never 403.**
- Auth-adjacent endpoints get the stricter rate limiter, not the general one.
- Audit every mutation and every PHI read.

## 5. Caching

Redis for ids and permission metadata only — **no PHI**. Every key gets a TTL; cache negative results too so unknown hosts cannot hammer Postgres. State the invalidation trigger, not just the TTL.

## 6. Web consumer — `apps/web`

Import the request/response types from `@rcln/contracts`. Fetch in a server component where possible; independent fetches go in `Promise.all` (`[async-parallel]`). Surface errors from the normalized response shape. No PHI into `localStorage`, cookies, or query params.

## 7. Verify

```bash
docker compose exec api pnpm typecheck
docker compose exec api pnpm lint
docker compose exec api pnpm test
```

Then actually call it:

```bash
curl -i -H 'Host: alpha.localhost' http://localhost:5000/api/v1/<path>
```

Check the negative cases too: no tenant header → 404, wrong permission → 403, another tenant's id → not found. Report real output.
