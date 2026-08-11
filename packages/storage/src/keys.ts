/**
 * Storage keys.
 *
 * ⚠️ A KEY IS UNTRUSTED INPUT UNTIL IT HAS BEEN THROUGH `assertValidKey`.
 *   On S3 a key is an opaque string and `../` is a legal character sequence
 *   with no meaning. On a local filesystem it is a path, and `../` means
 *   something very specific. A key that is merely joined onto a root directory
 *   is an arbitrary-file-write on the API container — and, on the download
 *   side, an arbitrary-file-READ: `organizations/x/../../../../etc/passwd`
 *   streamed back through an endpoint that has already checked the caller may
 *   read *some* document.
 *
 *   `LocalStorageProvider` does resolve-and-check-prefix as a second layer, but
 *   validation happens here, once, so every provider gets it and so the rule is
 *   in one readable place rather than inferred from a `path.resolve` call.
 *
 * THE SHAPE IS THE SAME ON EVERY PROVIDER, DELIBERATELY
 *   `organizations/{orgId}/invoices/{year}/{sourceCode}/{invoiceId}/invoice.pdf`
 *
 *   Local and S3 store the identical key, so migrating is a copy of the bytes
 *   and an UPDATE of `storage_provider` — the rest of the system, including
 *   every `invoice_documents` row already written, does not move. That is the
 *   entire point of §27.
 *
 * WHY THE TENANT ID IS THE FIRST SEGMENT
 *   Not for isolation — isolation is RLS on `files`, and a key is not a
 *   permission. It is so that "delete everything belonging to this clinic" is a
 *   prefix operation on both providers, which is what a DPDP erasure request
 *   eventually needs, and so that a bucket listing is legible to a human
 *   debugging at 2am.
 */

import { StorageError } from './errors.js';

/** Longest key any provider here accepts. Matches `files.storage_key`'s column. */
export const MAX_KEY_LENGTH = 512;

/**
 * Segments may hold letters, digits, dot, dash and underscore. Nothing else.
 *
 * Deliberately an allow-list. A deny-list of `..` and `/` misses backslashes on
 * a Windows volume, NUL bytes truncating a C-level path, unicode normalisation
 * turning one segment into another, and every trick discovered after it was
 * written. It also rules out a leading dot on its own (`.` and `..`) by
 * requiring at least one non-dot character.
 */
const SEGMENT = /^(?=.*[^.])[A-Za-z0-9._-]+$/;

/**
 * Reject anything that is not a well-formed key.
 *
 * Throws rather than returning a boolean: every call site's correct response to
 * a bad key is to stop, and a boolean invites a call site that logs and carries
 * on.
 */
export function assertValidKey(key: string): void {
  if (key.length === 0) {
    throw new StorageError('INVALID_KEY', 'Storage key is empty');
  }
  if (key.length > MAX_KEY_LENGTH) {
    throw new StorageError(
      'INVALID_KEY',
      `Storage key exceeds ${String(MAX_KEY_LENGTH)} characters`,
      `length=${String(key.length)}`
    );
  }
  // Absolute paths and Windows separators, before the segment loop — they are
  // worth naming individually because they are the two that read as harmless.
  if (key.startsWith('/') || key.includes('\\')) {
    throw new StorageError('INVALID_KEY', 'Storage key must be a relative, slash-separated path');
  }

  const segments = key.split('/');
  for (const segment of segments) {
    if (!SEGMENT.test(segment)) {
      throw new StorageError(
        'INVALID_KEY',
        'Storage key contains an illegal path segment',
        // The offending segment is safe to log: it is the thing we refused.
        `segment=${JSON.stringify(segment)}`
      );
    }
  }
}

/**
 * Build a key from parts, validating each one.
 *
 * Use this rather than a template literal. A template literal with an id
 * interpolated into it is exactly how a traversal sequence reaches a key in the
 * first place — and every id here comes from a database row, right up until the
 * day one of them comes from a request body.
 */
export function buildKey(...parts: readonly string[]): string {
  const key = parts
    .flatMap((part) => part.split('/'))
    .filter((part) => part.length > 0)
    .join('/');
  assertValidKey(key);
  return key;
}
