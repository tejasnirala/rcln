import type { NextConfig } from 'next';

/**
 * Standalone output is PRODUCTION-BUILD ONLY, and must never be on in dev.
 *
 * `outputFileTracingRoot` points at the monorepo root so `next build` can trace
 * files reached through workspace symlinks (@rcln/contracts and friends).
 * In `next dev` that same setting makes the repo root the project root, so the
 * dev server watches ~58,000 files and ~1 GB of node_modules — which pins the
 * CPU and gets the container OOM-killed on first compile.
 *
 * The flag is set in apps/web/Dockerfile's build stage. It is deliberately an
 * explicit variable rather than a NODE_ENV check, so `next dev` can never
 * switch it on by accident.
 */
const isStandaloneBuild = process.env['NEXT_OUTPUT_STANDALONE'] === '1';

const nextConfig: NextConfig = {
  ...(isStandaloneBuild
    ? {
        output: 'standalone' as const,
        outputFileTracingRoot: new URL('../../', import.meta.url).pathname,
      }
    : {}),

  // Fail the production build on type errors rather than shipping them.
  // Note: the `eslint` key was REMOVED in Next 16 — linting is no longer part
  // of `next build`. It runs via `pnpm lint` and in CI instead.
  typescript: { ignoreBuildErrors: false },

  poweredByHeader: false,
};

export default nextConfig;
