/**
 * DocumentService against real Postgres and a real filesystem.
 *
 * The three claims worth measuring here are the ones that are invisible until
 * they matter:
 *
 *   1. A tenant cannot read another tenant's document by id. RLS on `files`
 *      plus the explicit organization pin — and the pin is doing real work,
 *      because that policy deliberately permits a NULL organization_id.
 *   2. A failed storage write leaves a FAILED row, not a row that claims to
 *      have a document. That is the §40 failure the status column exists for.
 *   3. Bytes that changed underneath us are refused rather than served. An
 *      altered tax invoice handed to a patient is worse than an error page.
 *
 * Storage is pointed at a temporary directory rather than the repository's, so
 * the suite never writes into `./storage/documents` and never depends on what
 * is already there.
 */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { config as loadEnv } from 'dotenv';
import { Client } from 'pg';

loadEnv({ path: new URL('../../../../.env', import.meta.url).pathname });

// ⚠️ BEFORE the config module is imported, because `config` is frozen at import
// time. Setting it afterwards would leave the suite writing into the real
// storage root while appearing to be sandboxed.
const STORAGE_ROOT = await mkdtemp(join(tmpdir(), 'rcln-docs-test-'));
process.env['STORAGE_PROVIDER'] = 'local';
process.env['STORAGE_LOCAL_PATH'] = STORAGE_ROOT;

const { withTenant } = await import('@rcln/db');
type TenantContext = import('@rcln/db').TenantContext;

const { registerOrganization } =
  await import('../../src/services/organization/register.service.js');
const { initDatabase, disconnectDb } = await import('../../src/db/prisma.js');
const { redis } = await import('../../src/utils/redis.js');
const { storeDocument, readDocument, getDocument, getDocumentUrl, DocumentError } =
  await import('@rcln/documents/store');
const { getStorageProvider } = await import('@rcln/documents/store');

/*
 * The store is configured by the app, not by importing it — the same service is
 * pointed at a different root by the worker. Called here after the env vars
 * above, exactly as `initDocumentStore()` is called at boot.
 */
const { initDocumentStore } = await import('../../src/services/document/store.js');
initDocumentStore();

const SUFFIX = `d${Date.now().toString(36)}`;
const PASSWORD = 'CorrectHorse9Battery';
const PDF = Buffer.from('%PDF-1.7\ninvoice bytes\n%%EOF\n');

const ownerUrl = process.env['DIRECT_DATABASE_URL'];
let owner: Client;

let orgA: { organizationId: string; ownerUserId: string; branchId: string };
let orgB: { organizationId: string; ownerUserId: string; branchId: string };
let ctxA: TenantContext;
let ctxB: TenantContext;

function payload(slug: string, label: string) {
  return {
    organization: {
      legalName: `${label} Pvt Ltd`,
      displayName: label,
      slug,
      orgType: 'CLINIC' as const,
      countryCode: 'IN',
      timezone: 'Asia/Kolkata',
      currency: 'INR',
    },
    branch: { name: `${label} Main`, code: 'MAIN' },
    owner: {
      fullName: `${label} Owner`,
      email: `${slug}@example.test`,
      phone: `+9197${Math.floor(10_000_000 + Math.random() * 89_999_999)}`,
      password: PASSWORD,
    },
    planCode: 'STARTER',
    acceptedTerms: true as const,
  };
}

beforeAll(async () => {
  if (!ownerUrl) throw new Error('DIRECT_DATABASE_URL must be set to run this suite');

  owner = new Client({ connectionString: ownerUrl });
  await owner.connect();
  await initDatabase();

  orgA = await registerOrganization(payload(`doc-a-${SUFFIX}`, 'Doc A'));
  orgB = await registerOrganization(payload(`doc-b-${SUFFIX}`, 'Doc B'));

  ctxA = {
    organizationId: orgA.organizationId,
    branchIds: [orgA.branchId],
    userId: orgA.ownerUserId,
  };
  ctxB = {
    organizationId: orgB.organizationId,
    branchIds: [orgB.branchId],
    userId: orgB.ownerUserId,
  };
}, 30_000);

afterAll(async () => {
  const ids = [orgA?.organizationId, orgB?.organizationId].filter(Boolean);
  const users = [orgA?.ownerUserId, orgB?.ownerUserId].filter(Boolean);

  if (users.length > 0) {
    await owner?.query('DELETE FROM sessions WHERE user_id = ANY($1)', [users]);
  }
  if (ids.length > 0) {
    await owner?.query('DELETE FROM audit_logs WHERE organization_id = ANY($1)', [ids]);
    await owner?.query('DELETE FROM organizations WHERE id = ANY($1)', [ids]);
  }
  if (users.length > 0) {
    await owner?.query('DELETE FROM users WHERE id = ANY($1)', [users]);
  }

  await owner?.end();
  await disconnectDb();
  await redis.quit();
  await rm(STORAGE_ROOT, { recursive: true, force: true });
});

function invoiceDoc(name: string) {
  return {
    documentType: 'INVOICE_PDF' as const,
    keyParts: ['invoices', '2026', 'APP', name],
    fileName: `${name}.pdf`,
    mimeType: 'application/pdf',
    body: PDF,
  };
}

describe('storing a document', () => {
  it('writes the bytes, records the metadata, and comes back READY', async () => {
    const stored = await storeDocument(ctxA, invoiceDoc('inv-basic'));

    expect(stored.status).toBe('READY');
    expect(stored.documentType).toBe('INVOICE_PDF');
    expect(stored.storageProvider).toBe('local');
    expect(stored.sizeBytes).toBe(PDF.byteLength);
    expect(stored.checksum).toMatch(/^[0-9a-f]{64}$/);
    expect(stored.version).toBe(1);
  });

  /**
   * The tenant prefix is added by the service, never by the caller — see the
   * note in `storeDocument`. This pins that it is actually there, because a
   * caller that forgot it would still get a working document.
   */
  it('prefixes the key with the organization, and puts the bytes there', async () => {
    const stored = await storeDocument(ctxA, invoiceDoc('inv-key'));

    expect(stored.storageKey).toBe(
      `organizations/${orgA.organizationId}/invoices/2026/APP/inv-key`
    );
    expect(await readFile(join(STORAGE_ROOT, stored.storageKey))).toEqual(PDF);
  });

  /**
   * §23 — an issued invoice's PDF is an immutable snapshot. Writing over one
   * must fail loudly rather than replace a legal document.
   */
  /**
   * ⚠️ Refused by the UNIQUE on `files.storage_key`, not by the provider — the
   *   row is claimed before the bytes are written, so the provider's own
   *   overwrite guard never gets a chance to fire. What this pins is that the
   *   Prisma `P2002` is translated rather than escaping as-is (§39).
   */
  it('refuses a second write to the same key, without leaking a Prisma code', async () => {
    await storeDocument(ctxA, invoiceDoc('inv-once'));

    const failure = await storeDocument(ctxA, invoiceDoc('inv-once')).catch(
      (error: unknown) => error
    );

    expect(failure).toBeInstanceOf(DocumentError);
    expect((failure as InstanceType<typeof DocumentError>).code).toBe('ALREADY_EXISTS');
    expect((failure as Error).message).not.toMatch(/P2002|storage_key|constraint/i);
  });

  /**
   * ⚠️ §40, MEASURED BY ACTUALLY BREAKING THE WRITE.
   *   The row must not survive as something that claims to have a document —
   *   it must survive as evidence that one is missing, with a reason on it.
   *
   *   The provider is stubbed rather than the filesystem sabotaged: making the
   *   root unwritable is uncooperative under Docker (the container often runs
   *   as root, for which a mode-0 directory is no obstacle), and the point
   *   under test is the service's reaction to a failed put, not which failure.
   */
  it('leaves a FAILED row when the storage write fails', async () => {
    // Shadowed on the instance rather than via `jest.spyOn`: this suite runs as
    // a real ESM module, where the `jest` global does not exist.
    const provider = getStorageProvider();
    const realPut = provider.put.bind(provider);
    provider.put = () => Promise.reject(new Error('disk full'));

    try {
      const failure = await storeDocument(ctxA, invoiceDoc('inv-fail')).catch(
        (error: unknown) => error
      );
      expect(failure).toBeInstanceOf(DocumentError);
      expect((failure as InstanceType<typeof DocumentError>).code).toBe('STORAGE_FAILURE');
      // The underlying cause stays server-side.
      expect((failure as Error).message).not.toMatch(/disk full/);
    } finally {
      provider.put = realPut;
    }

    const rows = await owner.query(
      `SELECT status, failure_reason FROM files
        WHERE organization_id = $1 AND storage_key LIKE '%inv-fail%'`,
      [orgA.organizationId]
    );
    expect(rows.rowCount).toBe(1);
    expect(rows.rows[0].status).toBe('FAILED');
    expect(rows.rows[0].failure_reason).toContain('disk full');
  });
});

describe('reading a document', () => {
  it('round-trips the bytes', async () => {
    const stored = await storeDocument(ctxA, invoiceDoc('inv-read'));
    const { body, document } = await readDocument(ctxA, stored.id);

    expect(body).toEqual(PDF);
    expect(document.id).toBe(stored.id);
  });

  /**
   * ⚠️ Local disk has no URL space, so null is the correct answer and the route
   * streams instead. A test that expected a string here would pass on S3 and
   * fail on every development machine.
   */
  it('offers no signed URL on the local provider', async () => {
    const stored = await storeDocument(ctxA, invoiceDoc('inv-url'));
    const { url } = await getDocumentUrl(ctxA, stored.id);
    expect(url).toBeNull();
  });

  it('reports NOT_FOUND for an unknown id', async () => {
    await expect(getDocument(ctxA, '00000000-0000-0000-0000-000000000000')).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });

  /**
   * ⚠️ THE INTEGRITY CHECK, MEASURED BY ACTUALLY CORRUPTING THE FILE.
   *   Storage is a mounted volume somebody can write to. A tax invoice whose
   *   bytes no longer match what was recorded is refused, not served.
   */
  it('refuses bytes that no longer match the recorded checksum', async () => {
    const stored = await storeDocument(ctxA, invoiceDoc('inv-tamper'));

    await writeFile(join(STORAGE_ROOT, stored.storageKey), Buffer.from('%PDF-1.7\ntampered\n'));

    await expect(readDocument(ctxA, stored.id)).rejects.toMatchObject({
      code: 'CHECKSUM_MISMATCH',
    });
  });

  /**
   * The row says READY and the bytes are gone — the storage-root-was-not-a-
   * volume case from the API config note. It must be NOT_FOUND, not a 500.
   */
  it('reports NOT_FOUND when the row is READY but the bytes are missing', async () => {
    const stored = await storeDocument(ctxA, invoiceDoc('inv-vanished'));
    await rm(join(STORAGE_ROOT, stored.storageKey), { force: true });

    await expect(readDocument(ctxA, stored.id)).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});

describe('tenant isolation', () => {
  /**
   * ⚠️ THE ONE THAT MATTERS.
   *   Clinic B holds clinic A's document id — a guessed or leaked uuid, which
   *   §50 requires be useless. Both the RLS policy and the explicit
   *   organization pin have to hold for this to be NOT_FOUND.
   */
  it('refuses to read another organization’s document by id', async () => {
    const stored = await storeDocument(ctxA, invoiceDoc('inv-isolation'));

    await expect(getDocument(ctxB, stored.id)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(readDocument(ctxB, stored.id)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(getDocumentUrl(ctxB, stored.id)).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  /**
   * ⚠️ THE PIN IN `getDocument` IS NOT REDUNDANT, MEASURED.
   *   `files`' policy permits a NULL organization_id so that platform assets
   *   are readable by everyone. Without the explicit `organizationId` in the
   *   where clause, ANY tenant could read ANY platform document by id — and
   *   RLS would not object, because that is what the policy says.
   */
  it('refuses a tenant reading a platform-owned (NULL org) document', async () => {
    const platformId = '00000000-0000-0000-0000-0000000000f1';
    await owner.query(
      `INSERT INTO files (id, organization_id, document_type, status, storage_provider,
                          storage_key, original_name, mime_type, size_bytes)
       VALUES ($1, NULL, 'UPLOAD', 'READY', 'local', $2, 'platform.pdf', 'application/pdf', 10)
       ON CONFLICT (id) DO NOTHING`,
      [platformId, `platform/${SUFFIX}.pdf`]
    );

    try {
      await expect(getDocument(ctxA, platformId)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    } finally {
      await owner.query('DELETE FROM files WHERE id = $1', [platformId]);
    }
  });

  it('keeps each organization’s documents under its own key prefix', async () => {
    const a = await storeDocument(ctxA, invoiceDoc('inv-prefix'));
    const b = await storeDocument(ctxB, invoiceDoc('inv-prefix'));

    expect(a.storageKey).toContain(orgA.organizationId);
    expect(b.storageKey).toContain(orgB.organizationId);
    expect(a.storageKey).not.toBe(b.storageKey);

    // And neither can reach the other's bytes.
    await expect(getDocument(ctxA, b.id)).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});

describe('withTenant is the only way in', () => {
  /**
   * A document written by the service is visible to a raw tenant-scoped query,
   * and absent from the other tenant's — proving the row genuinely carries the
   * organization rather than the service merely filtering on the way out.
   */
  it('writes a row the other tenant’s session cannot see', async () => {
    const stored = await storeDocument(ctxA, invoiceDoc('inv-rls'));

    const seenByA = await withTenant(ctxA, (tx) =>
      tx.storedFile.findMany({ where: { id: stored.id } })
    );
    const seenByB = await withTenant(ctxB, (tx) =>
      tx.storedFile.findMany({ where: { id: stored.id } })
    );

    expect(seenByA).toHaveLength(1);
    expect(seenByB).toHaveLength(0);
  });
});
