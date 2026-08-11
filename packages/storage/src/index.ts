/**
 * `@rcln/storage` — object storage behind one interface.
 *
 * Development writes to local disk, production writes to a private S3 bucket,
 * and nothing above this package knows which. See `types.ts` for the dependency
 * rule that makes that true, and `keys.ts` for why a key is untrusted input.
 *
 * ⚠️ THIS PACKAGE IS NOT AN AUTHORIZATION BOUNDARY.
 *   It knows nothing about tenants, memberships or permissions — a key is a
 *   string, and any caller holding one gets the bytes. Deciding WHO may read a
 *   document is `DocumentService` and the route above it, against `files` and
 *   its RLS policy. Putting a tenant check in here would be a second, weaker
 *   copy of the real one, and the first thing anyone would do on finding it is
 *   trust it.
 */

export { StorageError, isStorageError, type StorageErrorCode } from './errors.js';
export { assertValidKey, buildKey, MAX_KEY_LENGTH } from './keys.js';
export { LocalStorageProvider, type LocalStorageConfig } from './providers/local.js';
export { createStorageProvider, type StorageConfig } from './registry.js';
export type {
  ObjectMetadata,
  PutObjectInput,
  SignedUrlOptions,
  StorageProvider,
  StorageProviderName,
} from './types.js';
