/**
 * Point `@rcln/documents/store` at this process's storage.
 *
 * The service itself moved into a package when the worker became the thing that
 * writes a PDF and the API stayed the thing that serves it — see that package's
 * `runtime.ts`. What is left here is the half that is genuinely the API's: its
 * own configuration and its own logger.
 *
 * ⚠️ THE WORKER'S EQUIVALENT MUST RESOLVE THE SAME ROOT. `STORAGE_LOCAL_PATH` is
 *   one variable used on both sides of the compose bind mount so that it does.
 *   Both processes anchor a relative value to the REPO ROOT rather than to
 *   `cwd`, because the API runs from `apps/api` and the worker from
 *   `apps/worker` — a real bug, caught by probing the running container rather
 *   than by any test.
 *
 * Called at boot beside `initialisePayments()`, and by the integration suite
 * after it has pointed storage at a temp directory.
 */

import { configureDocumentStore } from '@rcln/documents/store';

import { config } from '../../config/index.js';
import { logger } from '../../utils/logger.js';

export function initDocumentStore(): void {
  configureDocumentStore({
    provider: config.storage.provider,
    local: { rootDir: config.storage.local.rootDir },
    s3: {
      bucket: config.storage.s3.bucket,
      region: config.storage.s3.region,
      keyPrefix: config.storage.s3.keyPrefix,
    },
    logger,
  });
}
