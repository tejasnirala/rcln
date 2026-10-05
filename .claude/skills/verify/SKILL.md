---
name: verify
description: Run rcln's check sequence once, in the order CLAUDE.md requires — lint and format, then typecheck, then the full test split, plus the RLS check and the API-reference check when they apply — and report pass/fail. No production build. Use after finishing a change, before committing, or when asked to "verify", "check" or "make sure it passes". Lighter than /code-review, which also runs the reviewer subagents.
---

# Verify (rcln)

Run once, at the end of the work — never between stations (see CLAUDE.md
§ Order of work). Everything runs inside the Docker stack; if `docker compose ps`
shows it down, start it with `docker compose up -d` and wait for `api` to be
healthy.

Stop at the first real failure, fix it, and re-run from that step.

1. **Lint and format**

   ```bash
   docker compose exec -T api pnpm lint
   pnpm format
   ```

   Lint the second time if the first run failed only on formatting — `pnpm format`
   fixes those, and a lint pass before formatting reports them as errors.

2. **Typecheck only — no `pnpm build`**

   ```bash
   docker compose exec -T api npx turbo run typecheck --concurrency=2
   ```

   ⚠️ Plain `pnpm typecheck` runs every package's `tsc` at once and the container
   can be OOM-killed: a task that ends in `exited (137)` is memory, not a type
   error. The `--concurrency=2` form avoids it.

3. **Schema gate** — only if anything under `packages/db/prisma/` changed:

   ```bash
   docker compose exec -T api pnpm db:rls:check
   ```

4. **API reference** — only if a route or anything under
   `apps/api/src/openapi/` changed:

   ```bash
   docker compose exec -T api pnpm --filter @rcln/api docs:validate
   ```

   The two numbers it prints must be equal:
   `<n> endpoints … <n> carry hand-written documentation`.

5. **Tests, last and once**

   ```bash
   docker compose exec -T api pnpm test
   ```

   It takes several minutes; run it in the background and wait for it to
   finish rather than polling.

## Report

One line per step: ✅ / ❌ / skipped (with why), plus the failing lines for any
❌. Name the test counts (`Tests: N passed`). If everything passes, end with
"All checks pass." Never call something verified that was only edited.
