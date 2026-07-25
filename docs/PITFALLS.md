# Pitfalls

Traps already hit in this repository, with the symptom, the cause and the fix.

Every one of these **typechecks cleanly** and most produce no error message.
They were found by running the thing, not by reading the code. If something
behaves oddly, look here before debugging from scratch.

---

## Postgres and RLS

### `FORCE ROW LEVEL SECURITY` breaks migrations

**Symptom:** seeds and migrations insert nothing, apparently succeeding.
**Cause:** `FORCE` subjects the table owner to its own policies, and migrations
run as the owner with no tenant context.
**Fix:** use `ENABLE` + `NO FORCE`, and rely on the `rcln_owner` / `rcln_app`
split. `assertRlsActive()` guards the risk that creates. → ADR-0003

### Scoping the tenant-resolution table is circular

**Symptom:** every request resolves `tenant: null`, no errors anywhere.
**Cause:** `organization_domains` had an RLS policy requiring
`app.current_org` — but reading that table is _how_ `app.current_org` gets set.
**Fix:** exempt it, with the reason recorded in `enable-rls.sql` and
`check-rls.ts`.

### Unique indexes do not constrain nullable columns

**Symptom:** duplicate system roles, or the same "all branches" role granted
twice.
**Cause:** Postgres treats NULLs as distinct, so `UNIQUE (organization_id, code)`
permits many rows with `organization_id = NULL`.
**Fix:** `NULLS NOT DISTINCT` (Postgres 15+), added as raw SQL in migration
`20260725060000`.

### Prisma cannot target a compound unique containing NULL

**Symptom:** `Argument 'organizationId' must not be null` in an `upsert`.
**Cause:** Prisma will not build a `where` for a compound unique with a null
component.
**Fix:** `findFirst` then `create`/`update`. Uniqueness is still guaranteed by
the `NULLS NOT DISTINCT` index. See `prisma/seed.ts`.

### `P3014` — shadow database

**Symptom:** `prisma migrate dev` fails with "could not create the shadow
database".
**Cause:** `rcln_owner` lacks `CREATEDB`.
**Fix:** `ALTER ROLE rcln_owner CREATEDB;` — already in the init SQL. Only
`migrate dev` needs it; production uses `migrate deploy`, which does not.

---

## Node, pnpm and Prisma

### Prisma 7 removed `url` from the datasource block

**Symptom:** schema validation error pointing at `datasource db { url = … }`.
**Fix:** the URL moves to `prisma.config.ts`; the runtime client gets it via the
`@prisma/adapter-pg` adapter.

### Prisma 7 requires an explicit adapter

**Symptom:** `new PrismaClient()` throws about a missing adapter or
`accelerateUrl`.
**Fix:** `new PrismaClient({ adapter: new PrismaPg({ connectionString }) })`.
Seeds use `DIRECT_DATABASE_URL` (owner); the app uses `DATABASE_URL` (app role).

### The generated client is not on the root of the workspace

**Symptom:** `Cannot find module '../generated/prisma/index.js'` from `dist/`.
**Cause:** compiled output nests one level deeper than source, breaking the
relative path.
**Fix:** the generated client is exposed through a package self-reference,
`@rcln/db/generated`, so the specifier is identical in `src` and `dist`.

### pnpm does not hoist to the workspace root

**Symptom:** `require('pg')` fails from `/app` even though `pg` is installed.
**Cause:** pnpm's isolated layout only links a dependency into the package that
declares it.
**Fix:** the container's Postgres wait uses Node's built-in `net`, not `pg`.
More generally: import from the package that declares the dependency.

### `ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY`

**Cause:** pnpm refuses to modify a `node_modules` it considers foreign when it
cannot prompt.
**Fix:** `CI=true`. Set in the dev image.

### `pnpm deploy` needs `--legacy` from pnpm 10

**Symptom:** `ERR_PNPM_DEPLOY_NONINJECTED_WORKSPACE`.
**Fix:** `--legacy`. The alternative (`inject-workspace-packages=true`) would
hard-copy workspace deps at install time and break shared-package hot reload.

### `auto-install-peers` inflates production images

**Symptom:** a Node API image at 743 MB.
**Cause:** `@prisma/client` peer-depends on the `prisma` CLI, which pulls in
Studio, pglite, effect and TypeScript — all installed as production deps.
**Fix:** prune them in the build stage. 476 MB after.

---

## Docker

### Deleting files in the runtime stage does not shrink the image

**Symptom:** an aggressive `rm -rf` saves ~20 MB instead of ~250 MB.
**Cause:** the files still exist in the earlier layer.
**Fix:** prune in the stage that created them.

### Each service with a `build:` block gets its own image

**Symptom:** `docker compose build api` fixes one service; the others still run
the old code.
**Fix:** all dev services share `image: rcln-dev:local`, so one build serves all.

### `docker exec` without `-i` silently discards stdin

**Symptom:** a heredoc piped to `psql` reports success and does nothing.
**Fix:** `docker exec -i`. This one wasted real time — the command printed no
error at all.

### OOM kills can report `ExitCode=0`

**Symptom:** a container stops with no error; logs end mid-work.
**Cause:** the OOM killer took a child process; the `pnpm` wrapper above it
exited cleanly.
**Diagnosis:** `docker inspect <c> --format '{{.State.OOMKilled}}'`. Never trust
the exit code alone.

### Bind mounts shadow container `node_modules`

**Symptom:** modules missing, or native modules segfaulting.
**Cause:** mounting the repo over `/app` replaces the image's `node_modules`
with the host's.
**Fix:** a named volume over every `node_modules` path. More specific mounts win.

---

## Next.js 16

### It is not the Next you remember

`middleware.ts` is now **`proxy.ts`**, and the `eslint` config key was
**removed**. `apps/web/AGENTS.md` says to read `node_modules/next/dist/docs/`
before writing Next code. Both of these were hit by not doing so.

### Build-only config affects `next dev`

**Symptom:** CPU pinned, web container OOM-killed on first compile.
**Cause:** `outputFileTracingRoot` pointed at the monorepo root, so `next dev`
watched 58,347 files and ~1 GB of `node_modules`.
**Fix:** gate standalone options behind `NEXT_OUTPUT_STANDALONE=1`, set only in
the Dockerfile. Delete the `.next` volume afterwards — a cache built against the
bad root carries the problem forward. → ADR-0010

---

## Express and tooling

### `express-rate-limit` v8 rejects a naive `keyGenerator`

**Symptom:** `ERR_ERL_KEY_GEN_IPV6` at startup.
**Cause:** a custom key generator using raw `req.ip` — a single IPv6 host owns
astronomically many addresses and could sidestep the limit.
**Fix:** `ipKeyGenerator(req.ip, 56)`.

### The default rate-limit store is per-process

**Symptom:** limits are effectively N× looser with N containers.
**Fix:** `rate-limit-redis`.

### Turbo filters the environment

**Symptom:** a test suite passes via `pnpm --filter X test` but every case fails
under `pnpm validate`, with `Connection terminated unexpectedly`.
**Cause:** Turbo 2 passes through only the variables declared in `globalEnv` /
`globalPassThroughEnv`, for cache correctness. Undeclared ones are simply absent,
so the tenant-isolation suite fell back to the `.env` file's `localhost` and
found no Postgres inside the container. Postgres logged nothing, because no
connection was ever attempted.
**Fix:** declare runtime variables in `globalPassThroughEnv` in `turbo.json`
(passThrough, not `env`, so machine-specific values do not bust the cache).
**Diagnosis shortcut:** if `--env-mode=loose` makes it pass, it is this.

### Jest 30 needs a flag for ESM

**Symptom:** `SyntaxError: Cannot use import statement outside a module`.
**Fix:** `NODE_OPTIONS=--experimental-vm-modules` (already in the test scripts).

### `instanceof` is unreliable across pnpm symlinks

**Symptom:** a Prisma error is not caught by `instanceof
Prisma.PrismaClientKnownRequestError`.
**Cause:** the generated client and the app can resolve to separate class
identities.
**Fix:** narrow structurally on `err.name` and the presence of `code`.
