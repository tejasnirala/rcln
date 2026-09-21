import type { Config } from 'jest';

const config: Config = {
  preset: 'ts-jest/presets/default-esm',
  testEnvironment: 'node',
  roots: ['<rootDir>/tests'],
  testMatch: ['**/*.test.ts'],
  extensionsToTreatAsEsm: ['.ts'],
  moduleNameMapper: {
    // ESM source uses .js specifiers that point at .ts files.
    '^(\\.{1,2}/.*)\\.js$': '$1',
  },
  // Pins RATE_LIMIT_RELAXED off before config reads the environment; the
  // rate-limit cases in auth.test.ts assert the budgets as written.
  setupFiles: ['<rootDir>/tests/setup-env.ts'],
  // Closes the lazily-opened BullMQ producer after every suite. See the file's
  // header: without it a green run does not exit, and `--forceExit` hides it.
  setupFilesAfterEnv: ['<rootDir>/tests/setup-after-env.ts'],
  transform: {
    '^.+\\.tsx?$': ['ts-jest', { useESM: true, tsconfig: { verbatimModuleSyntax: false } }],
  },
  collectCoverageFrom: ['src/**/*.ts', '!src/**/*.d.ts', '!src/index.ts', '!src/types/**'],
  coverageDirectory: 'coverage',
  coverageReporters: ['text', 'lcov'],
  verbose: true,
  testTimeout: 30000,
  /**
   * One worker. These are integration suites, not unit tests.
   *
   * They share one Postgres and one Redis, and several of them clear `rl:*`
   * before making a request so that the rate limiters do not count another
   * suite's traffic. In parallel that is exactly backwards: one suite's flush
   * lands in the middle of another suite's deliberate count, and the rate-limit
   * regression cases in auth.test.ts fail depending on which worker got there
   * first.
   *
   * That was latent from the moment a second suite started flushing; adding a
   * ninth suite made it reproducible. Serial execution is the honest fix — the
   * shared state is real, and pretending otherwise buys a few seconds in
   * exchange for a suite that fails at random.
   */
  maxWorkers: 1,

  /**
   * Restart the worker when it grows past this, and note that the ceiling being
   * defended is the CONTAINER'S, not V8's.
   *
   * ⚠️ RAISING `--max-old-space-size` MAKES THIS WORSE, WHICH IS WHY IT WAS
   *   TRIED TWICE AND FAILED TWICE. `mem_limit: 3g` in docker-compose.yml is
   *   below any heap large enough to hold 102 suites, so a bigger heap does not
   *   avoid the wall — it reaches it in a state the kernel answers with SIGKILL
   *   instead of a V8 OOM. Exit 137 and no stack looks like a broken test.
   *
   *   The growth is real and is not a leak in any one suite: `maxWorkers: 1`
   *   means one process accumulates 102 module registries, each holding a
   *   Prisma client and a compiled type graph, and nothing evicts them. So the
   *   fix is to recycle the worker rather than to make room for all of it at
   *   once — which is what sharding was standing in for, at the cost of the
   *   suite being run six times by hand and never as `pnpm test`.
   *
   *   1200MB leaves headroom under 3g for postgres, redis and the dev servers
   *   sharing the container. Restarts cost a few seconds each and buy back a
   *   single command that finishes.
   */
  workerIdleMemoryLimit: '1200MB',
};

export default config;
