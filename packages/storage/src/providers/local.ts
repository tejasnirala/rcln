/**
 * Local filesystem storage. The development default (§25).
 *
 * ⚠️ THE ROOT DIRECTORY MUST BE A DOCKER VOLUME, NOT CONTAINER SCRATCH SPACE.
 *   Compose mounts `./storage/documents` over `/app/storage/documents`. Without
 *   that mount every issued invoice's PDF disappears on the next
 *   `docker compose up --build`, while its `invoice_documents` row survives —
 *   so the invoice claims to have a document, the download 404s, and the
 *   database is the only place that still remembers the file ever existed.
 *
 * ⚠️ THREE INDEPENDENT LAYERS STOP A KEY ESCAPING THE ROOT, AND EACH CATCHES
 *   SOMETHING THE OTHERS DO NOT.
 *
 *   1. `assertValidKey` refuses `..`, absolute paths and separators up front.
 *   2. A LEXICAL resolve-and-prefix check, which catches anything that got past
 *      (1) — including a future caller who bypasses `buildKey`.
 *   3. A REAL-PATH check, which is the only one that sees symlinks.
 *
 *   (2) does not subsume (3): `path.resolve` is pure string arithmetic and
 *   never touches the disk, so a key of entirely well-formed segments still
 *   escapes if a directory along it is a symlink to somewhere else. That is not
 *   hypothetical here — the storage root is a mounted volume, and a mount whose
 *   contents an operator has been editing is exactly where a stray link
 *   appears. (3) alone is also not enough, because it can only inspect paths
 *   that exist, and a WRITE names one that does not yet.
 *
 *   ⚠️ Both prefix comparisons use the REAL path of the root as well. On macOS
 *   `os.tmpdir()` is `/var/folders/…`, whose real path is `/private/var/…` —
 *   comparing a real path against a lexical root fails every check and turns
 *   the whole provider into a machine for throwing INVALID_KEY.
 *
 * DURABILITY: WRITE TO A TEMPORARY FILE, THEN RENAME
 *   `rename` within one filesystem is atomic, so a reader never observes a
 *   half-written PDF and a crash mid-write leaves a stray temp file rather than
 *   a truncated document that looks complete. The temp file is created inside
 *   the destination directory precisely so the rename stays within one
 *   filesystem — across a mount boundary it degrades to copy-then-unlink and
 *   stops being atomic.
 */

import { createHash } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { access, mkdir, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';

import { StorageError } from '../errors.js';
import { assertValidKey } from '../keys.js';
import type {
  ObjectMetadata,
  PutObjectInput,
  SignedUrlOptions,
  StorageProvider,
} from '../types.js';

/**
 * The content type is stored beside the object rather than guessed from the
 * extension on the way out.
 *
 * Extension-sniffing is how a `.pdf` that is actually HTML gets served as
 * `text/html` from our own origin, which is a stored-XSS delivery mechanism
 * wearing an invoice's name. What was declared at write time is what is
 * returned at read time.
 */
interface SidecarMetadata {
  contentType: string;
  checksum: string;
  sizeBytes: number;
  storedAt: string;
}

const SIDECAR_SUFFIX = '.meta.json';

export interface LocalStorageConfig {
  /** Absolute path to the storage root. Created on first write. */
  rootDir: string;
}

export class LocalStorageProvider implements StorageProvider {
  readonly name = 'local' as const;

  private readonly rootDir: string;
  /**
   * The root with symlinks resolved, memoised. Resolved lazily because the
   * directory may not exist when the provider is constructed at boot — the
   * first write creates it.
   */
  private realRoot: string | null = null;

  constructor(config: LocalStorageConfig) {
    this.rootDir = resolve(config.rootDir);
  }

  async put(input: PutObjectInput): Promise<ObjectMetadata> {
    const path = this.lexicalPath(input.key);
    const overwrite = input.overwrite ?? false;

    if (!overwrite && (await this.exists(input.key))) {
      throw new StorageError(
        'ALREADY_EXISTS',
        'An object already exists at that storage key',
        `key=${input.key}`
      );
    }

    const checksum = createHash('sha256').update(input.body).digest('hex');
    const storedAt = new Date();
    const sidecar: SidecarMetadata = {
      contentType: input.contentType,
      checksum,
      sizeBytes: input.body.byteLength,
      storedAt: storedAt.toISOString(),
    };

    try {
      await mkdir(dirname(path), { recursive: true });
    } catch (error) {
      throw new StorageError(
        'PROVIDER_FAILURE',
        'Could not create the storage directory',
        describe(error)
      );
    }

    // AFTER mkdir and BEFORE writing: the directory now exists, so its real
    // path can be checked. Checking before would find nothing to resolve and
    // prove nothing; checking after the write would already have written.
    await this.assertRealPathWithinRoot(path, input.key);

    try {
      // Unique per attempt so two concurrent writers to one key cannot corrupt
      // each other's temp file — they race on the rename instead, where the
      // loser is simply overwritten by an identical set of bytes.
      const temp = `${path}.${process.pid.toString(36)}.${Date.now().toString(36)}.tmp`;
      await writeFile(temp, input.body, { mode: 0o640 });
      await rename(temp, path);

      // The sidecar is written second, so a crash between the two leaves an
      // object with no metadata — which `head` reports as NOT_FOUND. The other
      // order would leave metadata describing bytes that are not there, and a
      // download that 200s with an empty body.
      await writeFile(`${path}${SIDECAR_SUFFIX}`, JSON.stringify(sidecar), { mode: 0o640 });
    } catch (error) {
      throw new StorageError(
        'PROVIDER_FAILURE',
        'Could not write the object to local storage',
        describe(error)
      );
    }

    return {
      key: input.key,
      sizeBytes: sidecar.sizeBytes,
      contentType: input.contentType,
      checksum,
      storedAt,
    };
  }

  async get(key: string): Promise<Buffer> {
    const path = await this.safePath(key);
    try {
      return await readFile(path);
    } catch (error) {
      throw this.readFailure(error, key);
    }
  }

  async head(key: string): Promise<ObjectMetadata> {
    const path = await this.safePath(key);
    let raw: string;
    try {
      raw = await readFile(`${path}${SIDECAR_SUFFIX}`, 'utf8');
    } catch (error) {
      throw this.readFailure(error, key);
    }

    let sidecar: SidecarMetadata;
    try {
      sidecar = JSON.parse(raw) as SidecarMetadata;
    } catch (error) {
      throw new StorageError(
        'PROVIDER_FAILURE',
        'Stored object metadata is unreadable',
        describe(error)
      );
    }

    return {
      key,
      sizeBytes: sidecar.sizeBytes,
      contentType: sidecar.contentType,
      checksum: sidecar.checksum,
      storedAt: new Date(sidecar.storedAt),
    };
  }

  /**
   * ⚠️ Answers false for a key that escapes the root, rather than throwing.
   *
   * "Does this exist?" about a path we would refuse to serve has one honest
   * answer, and it is no. Throwing here would also make `put`'s overwrite guard
   * fail for the wrong reason.
   */
  async exists(key: string): Promise<boolean> {
    let path: string;
    try {
      path = await this.safePath(key);
    } catch {
      return false;
    }
    try {
      await access(path, fsConstants.F_OK);
      return true;
    } catch {
      return false;
    }
  }

  async remove(key: string): Promise<void> {
    const path = await this.safePath(key);
    try {
      // `force` makes a missing file a success — see the interface note on why
      // delete is idempotent.
      await rm(path, { force: true });
      await rm(`${path}${SIDECAR_SUFFIX}`, { force: true });
    } catch (error) {
      throw new StorageError(
        'PROVIDER_FAILURE',
        'Could not remove the object from local storage',
        describe(error)
      );
    }
  }

  /**
   * Always null. Local disk has no URL space — see the interface note; the
   * download route streams the bytes through itself instead.
   *
   * `options` is accepted and ignored so that the day this becomes an
   * HMAC-signed route, no caller changes.
   */
  getSignedUrl(_key: string, _options: SignedUrlOptions): Promise<string | null> {
    return Promise.resolve(null);
  }

  // -------------------------------------------------------------------------
  // Path safety — layers 2 and 3 of the header note.
  // -------------------------------------------------------------------------

  /** Layers 1 and 2: key validation, then a lexical prefix check. */
  private lexicalPath(key: string): string {
    assertValidKey(key);
    const path = resolve(join(this.rootDir, key));
    this.assertPrefixed(path, this.rootDir, key);
    return path;
  }

  /** Layers 1–3, for every operation that reads or removes an existing path. */
  private async safePath(key: string): Promise<string> {
    const path = this.lexicalPath(key);
    await this.assertRealPathWithinRoot(path, key);
    return path;
  }

  /**
   * Layer 3. Resolves symlinks on the deepest part of the path that exists and
   * checks the result still sits under the real root.
   *
   * Walking up on ENOENT is what makes this usable for a write: the file itself
   * does not exist yet, but its directory does, and a symlinked directory is
   * the escape route that matters. If nothing on the path exists at all we fall
   * through to the lexical check, which has already passed.
   */
  private async assertRealPathWithinRoot(path: string, key: string): Promise<void> {
    const realRoot = await this.resolveRoot();

    let candidate = path;
    for (;;) {
      try {
        this.assertPrefixed(await realpath(candidate), realRoot, key);
        return;
      } catch (error) {
        if (error instanceof StorageError) throw error;
        if (!isNodeError(error) || error.code !== 'ENOENT') {
          throw new StorageError(
            'PROVIDER_FAILURE',
            'Could not resolve the storage path',
            describe(error)
          );
        }
      }
      const parent = dirname(candidate);
      // Reached the filesystem root without finding anything that exists.
      if (parent === candidate) return;
      candidate = parent;
    }
  }

  /**
   * ⚠️ The `+ sep` is load-bearing. A bare `startsWith(root)` also accepts
   * `/app/storage-evil`, which is a sibling directory, not a child.
   */
  private assertPrefixed(path: string, root: string, key: string): void {
    if (path !== root && !path.startsWith(root + sep)) {
      throw new StorageError(
        'INVALID_KEY',
        'Storage key resolves outside the storage root',
        `key=${key}`
      );
    }
  }

  private async resolveRoot(): Promise<string> {
    if (this.realRoot !== null) return this.realRoot;
    try {
      this.realRoot = await realpath(this.rootDir);
    } catch (error) {
      // Not yet created — the lexical root is the best available answer, and
      // the first write will create it and memoise the real one.
      if (isNodeError(error) && error.code === 'ENOENT') return this.rootDir;
      throw new StorageError(
        'PROVIDER_FAILURE',
        'Could not resolve the storage root',
        describe(error)
      );
    }
    return this.realRoot;
  }

  private readFailure(error: unknown, key: string): StorageError {
    if (isNodeError(error) && error.code === 'ENOENT') {
      return new StorageError('NOT_FOUND', 'No stored object for that key', `key=${key}`);
    }
    return new StorageError(
      'PROVIDER_FAILURE',
      'Could not read the object from local storage',
      describe(error)
    );
  }
}

/**
 * ⚠️ STRUCTURAL, NOT `instanceof Error`.
 *
 * A filesystem error thrown by a node internal does not always satisfy
 * `instanceof Error` in a jest VM context — the two realms have different
 * `Error` constructors. That turned every ENOENT into a PROVIDER_FAILURE under
 * test while behaving correctly in production, which is the worst possible
 * arrangement: the tests disagree with the thing they are testing.
 */
function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === 'object' && error !== null && 'code' in error;
}

/** Never returned to a client — `StorageError.detail` is server-side only. */
function describe(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}
