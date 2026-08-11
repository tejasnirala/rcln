/**
 * The storage seam.
 *
 * ⚠️ NOTHING ABOVE THIS INTERFACE MAY NAME A PROVIDER.
 *   No `aws-sdk` import outside `providers/s3.ts`, no `fs` import outside
 *   `providers/local.ts`, and no `if (provider === 's3')` anywhere at all. The
 *   invoice engine's only relationship with storage is `DocumentService`, whose
 *   only relationship with storage is this interface. §24 of the brief is a
 *   dependency rule, and a dependency rule only holds if it is checkable — so
 *   it is stated here, where a reviewer reading a new provider will see it.
 *
 * WHY IT IS DELIBERATELY SMALL
 *   Six operations, no listing, no copy, no multipart, no lifecycle rules.
 *   Every method added here has to be implemented correctly by every provider
 *   forever, including the ones written under time pressure. A method nobody
 *   calls is a method nobody tests, and it is on local disk that the untested
 *   one will be subtly wrong.
 *
 * WHAT A `Buffer` IS DOING HERE INSTEAD OF A STREAM
 *   An invoice PDF is tens of kilobytes and is generated in memory. Streaming
 *   would buy nothing and cost the ability to checksum the bytes before they
 *   land. When this package first stores something that does not fit in memory
 *   — a scan, a DICOM study — that is the moment to add `putStream`, not now.
 */

/** Which implementation stored an object. Persisted on `files.storage_provider`. */
export type StorageProviderName = 'local' | 's3';

export interface PutObjectInput {
  key: string;
  body: Buffer;
  contentType: string;
  /**
   * Refuse rather than overwrite when an object already exists at `key`.
   *
   * Defaults to true, and the default is the whole point: an issued invoice's
   * PDF is an immutable snapshot (§23), so a second write to its key is a bug
   * that must surface as an error rather than as a silently replaced legal
   * document. A caller that genuinely means to replace — a regenerated
   * FAILED document — passes false and says so.
   */
  overwrite?: boolean;
}

export interface ObjectMetadata {
  key: string;
  sizeBytes: number;
  contentType: string;
  /** Lowercase hex SHA-256 of the stored bytes. */
  checksum: string;
  storedAt: Date;
}

export interface SignedUrlOptions {
  /** How long the URL stays valid. Providers clamp to their own maximum. */
  expiresInSeconds: number;
  /** Filename offered to the browser, via `Content-Disposition`. */
  downloadFilename?: string;
}

export interface StorageProvider {
  readonly name: StorageProviderName;

  /**
   * Store bytes and return what was actually written.
   *
   * The returned checksum is computed over the bytes, by the provider, after
   * writing — not taken on trust from the caller. It is what `files.checksum`
   * records, and a checksum the caller supplied would only ever prove that the
   * caller can do arithmetic.
   */
  put(input: PutObjectInput): Promise<ObjectMetadata>;

  /** Retrieve the bytes. Throws `NOT_FOUND` rather than returning null. */
  get(key: string): Promise<Buffer>;

  /** Metadata without the bytes. Throws `NOT_FOUND`. */
  head(key: string): Promise<ObjectMetadata>;

  exists(key: string): Promise<boolean>;

  /**
   * Remove an object. Idempotent — deleting a key that is already gone is a
   * success, because the caller's intent ("this must not exist") is satisfied
   * and a retried delete is not an error.
   */
  remove(key: string): Promise<void>;

  /**
   * A short-lived URL the browser can fetch directly, or `null` if this
   * provider has none.
   *
   * ⚠️ `null` IS A REAL ANSWER, NOT A FAILURE. Local disk has no URL space of
   *   its own, and inventing one — an endpoint that takes a key and a
   *   signature — would be building a second authorization system next to the
   *   one that already works. So the download route branches on null and
   *   streams the bytes through itself instead, which it must be able to do
   *   anyway: that is the code path that enforces RBAC, and on S3 it is the
   *   code path that decides whether to hand out a URL at all.
   *
   *   Because of that, `getSignedUrl` is an OPTIMISATION — never the boundary.
   *   Authorization has already happened by the time anything calls it.
   */
  getSignedUrl(key: string, options: SignedUrlOptions): Promise<string | null>;
}
