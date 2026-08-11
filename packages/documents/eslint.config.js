import base from '@rcln/config/eslint';

/**
 * ⚠️ `src/fonts.generated.ts` IS EXCLUDED, AND FINDING OUT WHY COST A GREEN
 *   CHECK. It is written by `scripts/build-fonts.mjs` and is 141KB of base64 on
 *   six lines. `eslint --fix` reformats it — prettier does not care about the
 *   file's `eslint-disable` banner — which makes it differ from what the
 *   generator produces, so `fonts:check` then reports it stale and CI fails on a
 *   file nobody edited.
 *
 *   The repo rule is already this: never hand-edit a generated file, and a
 *   formatter is a hand-edit with more steps.
 */
export default [...base, { ignores: ['src/fonts.generated.ts'] }];
