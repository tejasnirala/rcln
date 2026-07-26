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
};

export default config;
