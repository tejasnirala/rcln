import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, symlink, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { StorageError } from '../src/errors.js';
import { LocalStorageProvider } from '../src/providers/local.js';

const KEY = 'organizations/8f3a/invoices/2026/APP/9c21/invoice.pdf';
const BODY = Buffer.from('%PDF-1.7\nnot really a pdf\n');

let root: string;
let provider: LocalStorageProvider;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'rcln-storage-'));
  provider = new LocalStorageProvider({ rootDir: root });
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('put', () => {
  it('stores the bytes and returns metadata computed from them', async () => {
    const metadata = await provider.put({ key: KEY, body: BODY, contentType: 'application/pdf' });

    expect(metadata.key).toBe(KEY);
    expect(metadata.sizeBytes).toBe(BODY.byteLength);
    expect(metadata.contentType).toBe('application/pdf');
    expect(metadata.checksum).toBe(createHash('sha256').update(BODY).digest('hex'));
    expect(await readFile(join(root, KEY))).toEqual(BODY);
  });

  it('creates intermediate directories', async () => {
    await provider.put({ key: KEY, body: BODY, contentType: 'application/pdf' });
    expect(await provider.exists(KEY)).toBe(true);
  });

  /**
   * §23: an issued invoice's PDF is an immutable snapshot. A second write to
   * its key must be an error, not a silently replaced legal document.
   */
  it('refuses to overwrite by default', async () => {
    await provider.put({ key: KEY, body: BODY, contentType: 'application/pdf' });

    await expect(
      provider.put({ key: KEY, body: Buffer.from('different'), contentType: 'application/pdf' })
    ).rejects.toMatchObject({ code: 'ALREADY_EXISTS' });

    // And the original bytes are untouched.
    expect(await provider.get(KEY)).toEqual(BODY);
  });

  it('overwrites when explicitly asked to', async () => {
    await provider.put({ key: KEY, body: BODY, contentType: 'application/pdf' });
    const replacement = Buffer.from('regenerated');

    const metadata = await provider.put({
      key: KEY,
      body: replacement,
      contentType: 'application/pdf',
      overwrite: true,
    });

    expect(await provider.get(KEY)).toEqual(replacement);
    expect(metadata.checksum).toBe(createHash('sha256').update(replacement).digest('hex'));
  });

  it('leaves no temporary file behind', async () => {
    await provider.put({ key: KEY, body: BODY, contentType: 'application/pdf' });
    const { readdir } = await import('node:fs/promises');
    const entries = await readdir(join(root, 'organizations/8f3a/invoices/2026/APP/9c21'));
    expect(entries.filter((e) => e.endsWith('.tmp'))).toEqual([]);
  });
});

describe('get / head / exists', () => {
  it('round-trips the declared content type rather than sniffing the extension', async () => {
    // A `.pdf` key holding HTML must still report what was declared — serving
    // it as text/html from our own origin would be stored XSS.
    await provider.put({
      key: KEY,
      body: Buffer.from('<script>x</script>'),
      contentType: 'application/pdf',
    });
    expect((await provider.head(KEY)).contentType).toBe('application/pdf');
  });

  it('reports NOT_FOUND for an unknown key', async () => {
    await expect(provider.get(KEY)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(provider.head(KEY)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(await provider.exists(KEY)).toBe(false);
  });
});

describe('remove', () => {
  it('deletes the object and its metadata', async () => {
    await provider.put({ key: KEY, body: BODY, contentType: 'application/pdf' });
    await provider.remove(KEY);

    expect(await provider.exists(KEY)).toBe(false);
    await expect(provider.head(KEY)).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('is idempotent', async () => {
    await expect(provider.remove(KEY)).resolves.toBeUndefined();
  });
});

describe('getSignedUrl', () => {
  /**
   * Null is the correct answer, not a failure — the download route branches on
   * it and streams the bytes itself. See the note on `StorageProvider`.
   */
  it('returns null, because local disk has no URL space', async () => {
    await provider.put({ key: KEY, body: BODY, contentType: 'application/pdf' });
    expect(await provider.getSignedUrl(KEY, { expiresInSeconds: 60 })).toBeNull();
  });
});

describe('the storage root is a boundary', () => {
  it.each([
    ['traversal', 'organizations/../../../../etc/passwd'],
    ['absolute', '/etc/passwd'],
  ])('refuses to read through %s', async (_label, key) => {
    await expect(provider.get(key)).rejects.toMatchObject({ code: 'INVALID_KEY' });
  });

  it('refuses to write through a traversal sequence', async () => {
    await expect(
      provider.put({ key: '../escaped.pdf', body: BODY, contentType: 'application/pdf' })
    ).rejects.toBeInstanceOf(StorageError);
  });

  /**
   * ⚠️ THE SECOND LAYER, MEASURED.
   *
   * Every segment here is well-formed, so `assertValidKey` passes it. The path
   * still leaves the root, because a directory along it is a symlink — which
   * key validation cannot see, because it never touches the disk. This is the
   * case that justifies the resolve-and-check-prefix in `pathFor`.
   */
  it('refuses a well-formed key that escapes the root through a symlink', async () => {
    const outside = await mkdtemp(join(tmpdir(), 'rcln-outside-'));
    try {
      await writeFile(join(outside, 'secret.pdf'), 'private');
      await mkdir(join(root, 'organizations'), { recursive: true });
      await symlink(outside, join(root, 'organizations', 'escape'), 'dir');

      await expect(provider.get('organizations/escape/secret.pdf')).rejects.toMatchObject({
        code: 'INVALID_KEY',
      });
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  /**
   * A sibling directory is not a child, and `startsWith(root)` alone accepts
   * one. The `+ sep` in `assertPrefixed` is what refuses it.
   */
  it('refuses a sibling directory that shares the root as a string prefix', async () => {
    const sibling = new LocalStorageProvider({ rootDir: `${root}-evil` });
    await sibling.put({ key: KEY, body: BODY, contentType: 'application/pdf' });
    try {
      // Reaching that sibling from THIS provider must fail, even though its
      // absolute path begins with this provider's root.
      await expect(provider.get(`../${KEY}`)).rejects.toMatchObject({ code: 'INVALID_KEY' });
    } finally {
      await rm(`${root}-evil`, { recursive: true, force: true });
    }
  });
});
