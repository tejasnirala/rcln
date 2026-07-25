import { base } from './eslint.base.js';
import tseslint from 'typescript-eslint';

/**
 * Node service preset (api, worker).
 *
 * The `no-restricted-imports` rule below is a real guardrail, not style policing:
 * importing the raw Prisma client bypasses the RLS transaction wrapper in
 * `@rcln/db`, which means queries run with no tenant scoping. Services must use
 * `forTenant(ctx)`. If you genuinely need the unscoped client (migrations,
 * platform-admin reads), import it from `@rcln/db/unsafe` so it greps.
 */
export const node = tseslint.config(...base, {
  rules: {
    'no-restricted-imports': [
      'error',
      {
        paths: [
          {
            name: '@prisma/client',
            message:
              'Do not import @prisma/client directly — it bypasses RLS tenant scoping. Use forTenant(ctx) from @rcln/db.',
          },
        ],
        patterns: [
          {
            group: ['**/generated/prisma', '**/generated/prisma/**'],
            message:
              'Do not import the generated client directly — use @rcln/db (forTenant) so RLS session vars are set.',
          },
        ],
      },
    ],
  },
});

export default node;
