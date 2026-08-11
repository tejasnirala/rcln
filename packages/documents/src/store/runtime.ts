/**
 * The document store's one storage provider, and where it comes from.
 *
 * ⚠️ THIS USED TO READ `apps/api`'s CONFIG DIRECTLY, AND THAT IS EXACTLY WHY THE
 *   SERVICE HAD TO LEAVE THE APP. A document is now WRITTEN by the worker and
 *   SERVED by the API — two processes, one `files` table, one folder. A service
 *   that could only be constructed from one app's config would have forced the
 *   worker to write those rows itself, which is two implementations of the
 *   row-then-bytes-then-READY ordering that the whole design rests on.
 *
 *   So the configuration is injected instead, once per process at boot, and each
 *   app keeps ownership of reading its own environment. `configurePayments()`
 *   solved the same problem the same way for the same pair of processes.
 *
 * ⚠️ AND THE TWO PROCESSES MUST BE GIVEN THE SAME ROOT. `STORAGE_LOCAL_PATH` is
 *   one variable used on both sides of the compose bind mount for precisely this
 *   reason. Point the worker somewhere else and nothing fails: it writes the PDF
 *   happily, the `files` row says READY, and the download 404s — a document the
 *   system swears exists and cannot serve, discovered by a patient at the front
 *   desk.
 *
 * ⚠️ A RELATIVE ROOT IS THE CALLER'S PROBLEM, AND IT IS A REAL ONE. The API runs
 *   from `apps/api` and the worker from `apps/worker`, so `resolve('./storage')`
 *   gives them different folders. Both apps anchor it to the repo root before
 *   calling in here; this module takes the absolute path it is given and does not
 *   try to be clever about it.
 */

import { createStorageProvider, type StorageProvider } from '@rcln/storage';

export interface DocumentStoreConfig {
  provider: 'local' | 's3';
  local: { rootDir: string };
  s3: { bucket: string; region: string; keyPrefix?: string | undefined };
  /**
   * Where this module's own diagnostics go.
   *
   * Structural rather than `pino`, because the two consumers construct their
   * loggers differently and neither of them should have to be the one this
   * package depends on. ⚠️ Everything logged through it is an id — never a
   * storage key, which carries the tenant id and, for some document types, will
   * carry a patient's.
   */
  logger?: DocumentStoreLogger | undefined;
}

export interface DocumentStoreLogger {
  error: (context: Record<string, unknown>, message: string) => void;
}

const noopLogger: DocumentStoreLogger = { error: () => undefined };

let config: DocumentStoreConfig | null = null;
let provider: StorageProvider | null = null;

/** Called once at boot by the API and by the worker. */
export function configureDocumentStore(next: DocumentStoreConfig): void {
  config = next;
  provider = null;
}

/**
 * The single provider instance.
 *
 * ⚠️ CONSTRUCTED LAZILY, AND THE LAZINESS IS DELIBERATE. `createStorageProvider`
 *   throws when the configuration is wrong — S3 selected but not implemented, an
 *   unknown name — and doing that at import time turns a configuration mistake
 *   into a module-load failure with no useful stack. Deferring it to first use
 *   means the error surfaces at the operation that needed storage, and means the
 *   test suites that never store a document do not need storage configured at
 *   all.
 *
 * ⚠️ ONE INSTANCE, NOT ONE PER CALL. Harmless today, and it stops being harmless
 *   the moment a provider holds a connection pool or a credential refresh timer.
 */
export function getStorageProvider(): StorageProvider {
  if (config === null) {
    throw new Error('The document store is not configured. Call configureDocumentStore() at boot.');
  }

  provider ??= createStorageProvider({
    provider: config.provider,
    local: { rootDir: config.local.rootDir },
    s3: {
      bucket: config.s3.bucket,
      region: config.s3.region,
      keyPrefix: config.s3.keyPrefix,
    },
  });

  return provider;
}

export function documentLogger(): DocumentStoreLogger {
  return config?.logger ?? noopLogger;
}

/** Test seam. Never called by application code. */
export function resetDocumentStoreForTesting(): void {
  provider = null;
}
