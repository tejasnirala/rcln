import { defineConfig, globalIgnores } from 'eslint/config';
import nextVitals from 'eslint-config-next/core-web-vitals';
import nextTs from 'eslint-config-next/typescript';

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  {
    rules: {
      /*
       * Match packages/config/eslint.base.js, which the api and worker use.
       * eslint-config-next brings its own copy of this rule without the ignore
       * pattern, so a deliberately unused `_`-prefixed argument was reported
       * here and nowhere else in the repo.
       *
       * Server actions need it: useActionState always passes the previous state
       * first, and an action that ignores it still has to accept it.
       */
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    },
  },
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    '.next/**',
    'out/**',
    'build/**',
    'next-env.d.ts',
  ]),
]);

export default eslintConfig;
