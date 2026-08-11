/**
 * Storage failures, as a closed set.
 *
 * Every one of these crosses an API boundary eventually, and §39 of the brief
 * is right that the client must not learn the filesystem path or the bucket
 * name. So the message on these is safe to log and NEVER safe to return
 * verbatim — the route layer maps `code` to a sentence, and the `detail` stays
 * server-side.
 */

export type StorageErrorCode =
  /** The key does not name an object. */
  | 'NOT_FOUND'
  /** The key is malformed — traversal, absolute path, control characters. */
  | 'INVALID_KEY'
  /** Writing would overwrite an object, and the caller did not ask to. */
  | 'ALREADY_EXISTS'
  /** The provider rejected the operation — permissions, disk full, network. */
  | 'PROVIDER_FAILURE'
  /** The provider cannot do this at all (e.g. signed URLs on local disk). */
  | 'UNSUPPORTED';

export class StorageError extends Error {
  readonly code: StorageErrorCode;
  /** Provider-specific context. Log it; never return it to a client. */
  readonly detail: string | undefined;

  constructor(code: StorageErrorCode, message: string, detail?: string) {
    super(message);
    this.name = 'StorageError';
    this.code = code;
    this.detail = detail;
  }
}

export function isStorageError(error: unknown): error is StorageError {
  return error instanceof StorageError;
}
