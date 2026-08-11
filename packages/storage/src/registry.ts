/**
 * Which provider a deployment runs, decided once, from configuration.
 *
 * §29 of the brief: `STORAGE_PROVIDER=local` in development,
 * `STORAGE_PROVIDER=s3` in production, and nothing else changes. That only
 * holds if exactly one place in the codebase reads that variable — this one.
 *
 * Same shape as `@rcln/payments`' provider registry, on purpose. Two seams that
 * do the same job should not have two different idioms behind them.
 */

import { StorageError } from './errors.js';
import { LocalStorageProvider } from './providers/local.js';
import type { StorageProvider, StorageProviderName } from './types.js';

export interface StorageConfig {
  provider: StorageProviderName;
  local: { rootDir: string };
  s3: {
    bucket: string;
    region: string;
    /** Optional prefix inside the bucket, for a bucket shared with other data. */
    keyPrefix?: string | undefined;
  };
}

export function createStorageProvider(config: StorageConfig): StorageProvider {
  switch (config.provider) {
    case 'local':
      return new LocalStorageProvider({ rootDir: config.local.rootDir });

    case 's3':
      /*
       * Deliberately a hard failure rather than a silent fall back to local.
       *
       * Falling back would mean a production deployment that believes it is
       * writing to a private bucket is in fact writing to container scratch
       * space — every invoice PDF lost on the next deploy, with no error
       * anywhere and an `invoice_documents` row insisting the file exists.
       * Same reasoning as the mock-payment-provider guard in the API config.
       */
      throw new StorageError(
        'UNSUPPORTED',
        'The S3 storage provider is not implemented yet (invoice engine, phase 11). ' +
          'Set STORAGE_PROVIDER=local, or implement providers/s3.ts behind StorageProvider.',
        `bucket=${config.s3.bucket} region=${config.s3.region}`
      );

    default: {
      // Exhaustiveness: adding a provider name without a case here fails to
      // compile rather than reaching this line at runtime.
      const unreachable: never = config.provider;
      throw new StorageError('UNSUPPORTED', `Unknown storage provider: ${String(unreachable)}`);
    }
  }
}
