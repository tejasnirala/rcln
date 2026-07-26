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

/**
 * The dev server is initialised on `localhost`, but every URL in this product is
 * a hostname off the root domain — `lvh.me:3000` for marketing, `alpha.lvh.me`
 * for a tenant. Next 16 blocks cross-origin requests to dev-only assets, so
 * without this the HMR and client chunks are refused and **nothing hydrates**:
 * pages render, look completely correct, and no button works.
 *
 * The failure is silent in the browser — the only evidence is a "Blocked
 * cross-origin request to Next.js dev resource" line in the dev server log.
 * Development only; production serves same-origin and ignores this.
 */
const rootDomain = process.env['NEXT_PUBLIC_ROOT_DOMAIN'] ?? 'lvh.me';

const nextConfig: NextConfig = {
  allowedDevOrigins: [rootDomain, `*.${rootDomain}`],

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
