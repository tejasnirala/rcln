/**
 * Documents: the one way anything in this application stores or retrieves a
 * file.
 *
 * ⚠️ THIS SERVICE IS NOT ABOUT INVOICES, AND MUST NOT BECOME SO (§31).
 *   The invoice engine is the first caller and will not be the last — lab
 *   reports, prescriptions, consent forms, patient attachments and referral
 *   letters all land here. So nothing in this file names an invoice, imports
 *   from the invoicing service, or takes an `invoiceId`. What it takes is a
 *   `DocumentType` and a storage key, and the caller that knows what an invoice
 *   is builds both.
 *
 *   The moment a function here needs to know which module called it, the design
 *   has gone wrong and the fix is a richer `metadata` argument, not a branch.
 *
 * ⚠️ AND IT IS NOT AN AUTHORIZATION BOUNDARY EITHER.
 *   `withTenant` + the `tenant_isolation` policy on `files` is what stops one
 *   clinic reading another's documents, and a permission check on the route is
 *   what stops a receptionist reading a lab report. Neither happens in here.
 *   A caller that reaches `readDocument` has already been allowed to.
 *
 *   The one thing this file DOES enforce is that a tenant's document always
 *   carries its `organization_id` — `files` permits a NULL one for platform
 *   assets, and a NULL-org document is readable by every tenant on the
 *   platform. There is deliberately no way to create one through here.
 *
 * THE ORDER OF OPERATIONS IS THE INTERESTING PART
 *   Bytes are written to storage BEFORE the row is marked READY, and the row is
 *   created BEFORE the bytes are written. That gives three failure modes and
 *   each one is survivable:
 *
 *     crash after the row, before the write   → row stuck GENERATING, no bytes.
 *                                               Findable by status; retryable.
 *     storage write fails                     → row set FAILED with a reason.
 *                                               Visible on screen, retryable.
 *     crash after the write, before READY     → orphan object on disk, row
 *                                               stuck GENERATING. Costs bytes,
 *                                               discloses nothing.
 *
 *   The arrangement to avoid is the opposite one — mark READY, then write —
 *   whose failure mode is a document the system swears exists and cannot serve.
 *   That is the case a patient discovers at the front desk.
 *
 * ⚠️ THE STORAGE WRITE IS OUTSIDE THE TRANSACTION, DELIBERATELY.
 *   A filesystem or an S3 PUT does not roll back with Postgres, so holding a
 *   transaction open across it buys no atomicity and does cost a connection
 *   held for the duration of a network call. The status column is what
 *   reconciles the two, which is exactly what it is for.
 */

import { randomUUID } from 'node:crypto';

import { withTenant, type TenantContext, type TxClient } from '@rcln/db';
import { buildKey, isStorageError, type ObjectMetadata } from '@rcln/storage';

import { documentLogger, getStorageProvider } from './runtime.js';

/** Mirrors the `DocumentType` enum in schema.prisma. */
export type DocumentType = 'INVOICE_PDF' | 'CREDIT_NOTE_PDF' | 'UPLOAD';

/** Mirrors `DocumentStatus`. */
export type DocumentStatus = 'PENDING' | 'GENERATING' | 'READY' | 'FAILED';

export class DocumentError extends Error {
  readonly code:
    'NOT_FOUND' | 'NOT_READY' | 'ALREADY_EXISTS' | 'STORAGE_FAILURE' | 'CHECKSUM_MISMATCH';

  constructor(code: DocumentError['code'], message: string) {
    super(message);
    this.name = 'DocumentError';
    this.code = code;
  }
}

export interface StoreDocumentInput {
  documentType: DocumentType;
  /**
   * Key segments under `organizations/{organizationId}/`. The tenant prefix is
   * added here rather than by the caller, so no caller can omit it and no
   * caller can get it wrong.
   */
  keyParts: readonly string[];
  /** What a browser should call it on download. Never a patient's name (§50). */
  fileName: string;
  mimeType: string;
  body: Buffer;
  branchId?: string | undefined;
  /**
   * Replace an existing document at the same key.
   *
   * ⚠️ Off by default, and the default is the point — an issued invoice's PDF
   *   is an immutable snapshot (§23). Only a FAILED regeneration passes true.
   */
  overwrite?: boolean | undefined;
}

export interface StoredDocument {
  id: string;
  documentType: DocumentType;
  status: DocumentStatus;
  storageProvider: string;
  storageKey: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  checksum: string | null;
  version: number;
}

/**
 * Store bytes and record them, in the order the header describes.
 *
 * Returns a READY document or throws. There is no half-success return value:
 * a caller that got a document back can serve it.
 */
export async function storeDocument(
  ctx: TenantContext,
  input: StoreDocumentInput
): Promise<StoredDocument> {
  const provider = getStorageProvider();

  /*
   * The tenant prefix is not decoration — it is what makes "delete everything
   * belonging to this clinic" a prefix operation on both providers, which a
   * DPDP erasure request eventually needs. See the header of `keys.ts`.
   */
  const storageKey = buildKey('organizations', ctx.organizationId, ...input.keyParts);

  /*
   * 1. Claim the row first, so a crash during the write leaves evidence.
   *
   * ⚠️ `files.storage_key` IS UNIQUE, SO THIS IS WHERE A DUPLICATE IS REFUSED —
   *   not at the provider. The provider's own `ALREADY_EXISTS` guard never gets
   *   a chance to fire, because the row is claimed first and Postgres rejects
   *   the second claim.
   *
   *   That ordering is right (the row is the record; the bytes are a copy), but
   *   it means the raw Prisma `P2002` is what surfaces unless it is translated
   *   here. Letting it through would put a Prisma error code on an API response
   *   — §39, and the sort of thing that tells a caller which column is unique.
   */
  const documentId = randomUUID();
  try {
    await withTenant(ctx, async (tx) => {
      await createGeneratingRow(tx, ctx, documentId, storageKey, input, provider.name);
    });
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new DocumentError('ALREADY_EXISTS', 'A document already exists for that reference');
    }
    throw error;
  }

  // 2. Write the bytes, outside any transaction.
  let written: ObjectMetadata;
  try {
    written = await provider.put({
      key: storageKey,
      body: input.body,
      contentType: input.mimeType,
      overwrite: input.overwrite ?? false,
    });
  } catch (error) {
    await markFailed(ctx, documentId, error);
    throw new DocumentError('STORAGE_FAILURE', 'The document could not be stored');
  }

  // 3. Only now is it a document anybody may download.
  return await withTenant(ctx, async (tx) => {
    const row = await tx.storedFile.update({
      where: { id: documentId },
      data: {
        status: 'READY',
        sizeBytes: BigInt(written.sizeBytes),
        checksum: written.checksum,
        failureReason: null,
      },
    });
    return toStoredDocument(row);
  });
}

/**
 * Fetch a document's bytes.
 *
 * ⚠️ THE CHECKSUM IS VERIFIED ON THE WAY OUT.
 *   Storage is a mounted volume an operator can write to and, later, a bucket
 *   with its own access policy. A document whose bytes no longer match what was
 *   recorded when it was stored is either corrupt or substituted, and both are
 *   things a clinic must not hand to a patient as a tax invoice. Refusing costs
 *   one hash of a few tens of kilobytes; not refusing means the one case where
 *   it matters is the one nobody notices.
 */
export async function readDocument(
  ctx: TenantContext,
  documentId: string
): Promise<{ document: StoredDocument; body: Buffer }> {
  const document = await getDocument(ctx, documentId);

  if (document.status !== 'READY') {
    throw new DocumentError('NOT_READY', 'The document is not available yet');
  }

  const provider = getStorageProvider();
  let body: Buffer;
  try {
    body = await provider.get(document.storageKey);
  } catch (error) {
    if (isStorageError(error) && error.code === 'NOT_FOUND') {
      /*
       * The row says READY and the bytes are gone. Almost always a storage root
       * that was not a persistent volume — see the note in the API config.
       * Logged with the id, never the key: a key carries the tenant id and,
       * for some document types, will carry a patient's.
       */
      documentLogger().error(
        { documentId, code: 'DOCUMENT_BYTES_MISSING' },
        'stored document has no bytes'
      );
      throw new DocumentError('NOT_FOUND', 'The document could not be found');
    }
    throw new DocumentError('STORAGE_FAILURE', 'The document could not be retrieved');
  }

  if (document.checksum !== null) {
    const { createHash } = await import('node:crypto');
    const actual = createHash('sha256').update(body).digest('hex');
    if (actual !== document.checksum) {
      documentLogger().error(
        { documentId, code: 'DOCUMENT_CHECKSUM_MISMATCH' },
        'stored document altered'
      );
      throw new DocumentError('CHECKSUM_MISMATCH', 'The document failed its integrity check');
    }
  }

  return { document, body };
}

/**
 * A short-lived URL for a document, or null when the provider has none.
 *
 * ⚠️ AUTHORIZATION HAS ALREADY HAPPENED BY THE TIME THIS IS CALLED, AND THAT IS
 *   THE ONLY REASON IT IS SAFE. A signed URL is a bearer token for one object:
 *   whoever holds it reads the document, with no session and no permission
 *   check. So it is minted per request, after the check, with a short expiry —
 *   and never logged, never stored, never put in an email (§50).
 */
export async function getDocumentUrl(
  ctx: TenantContext,
  documentId: string,
  expiresInSeconds = 300
): Promise<{ document: StoredDocument; url: string | null }> {
  const document = await getDocument(ctx, documentId);
  if (document.status !== 'READY') {
    throw new DocumentError('NOT_READY', 'The document is not available yet');
  }

  const url = await getStorageProvider().getSignedUrl(document.storageKey, {
    expiresInSeconds,
    downloadFilename: document.fileName,
  });

  return { document, url };
}

/** Metadata only. Throws `NOT_FOUND` for a document this tenant cannot see. */
export async function getDocument(ctx: TenantContext, documentId: string): Promise<StoredDocument> {
  return await withTenant(ctx, async (tx) => {
    const row = await tx.storedFile.findFirst({
      /*
       * `organizationId` is pinned explicitly as well as by RLS. The policy on
       * `files` permits a NULL organization_id — that is what makes a platform
       * asset readable — so without this pin, a tenant could read any
       * platform-owned document by id. Defence in depth is the rule for tenant
       * columns (ADR-0005); here it is not merely depth, it is the only thing
       * separating tenant documents from platform ones.
       */
      where: { id: documentId, organizationId: ctx.organizationId, deletedAt: null },
    });
    if (!row) throw new DocumentError('NOT_FOUND', 'The document could not be found');
    return toStoredDocument(row);
  });
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

async function createGeneratingRow(
  tx: TxClient,
  ctx: TenantContext,
  documentId: string,
  storageKey: string,
  input: StoreDocumentInput,
  providerName: string
): Promise<void> {
  await tx.storedFile.create({
    data: {
      id: documentId,
      organizationId: ctx.organizationId,
      branchId: input.branchId ?? null,
      documentType: input.documentType,
      status: 'GENERATING',
      storageProvider: providerName,
      storageKey,
      originalName: input.fileName,
      mimeType: input.mimeType,
      sizeBytes: BigInt(0),
      uploadedBy: ctx.userId,
    },
  });
}

/**
 * Record why a document could not be stored.
 *
 * ⚠️ Swallows its own failure. This runs on the error path of `storeDocument`,
 *   which is about to throw a `DocumentError` the caller will handle. Letting a
 *   secondary database failure escape from here would replace a precise
 *   "storage failed" with whatever went wrong while writing that down — the
 *   classic error-handler-masks-the-error, and the reason the original cause is
 *   logged before anything else happens.
 */
async function markFailed(ctx: TenantContext, documentId: string, cause: unknown): Promise<void> {
  const reason = isStorageError(cause)
    ? `${cause.code}: ${cause.message}`
    : cause instanceof Error
      ? cause.message
      : 'unknown storage failure';

  documentLogger().error(
    { documentId, code: 'DOCUMENT_STORE_FAILED', reason },
    'document storage failed'
  );

  try {
    await withTenant(ctx, async (tx) => {
      await tx.storedFile.update({
        where: { id: documentId },
        // Truncated to the column width. A reason longer than 500 characters is
        // a stack trace, and the log already has it.
        data: { status: 'FAILED', failureReason: reason.slice(0, 500) },
      });
    });
  } catch (error) {
    documentLogger().error(
      { documentId, code: 'DOCUMENT_STATUS_WRITE_FAILED' },
      error instanceof Error ? error.message : 'unknown'
    );
  }
}

/**
 * Prisma's unique-constraint code, checked structurally.
 *
 * Not `instanceof Prisma.PrismaClientKnownRequestError`: the generated client is
 * re-exported through `@rcln/db`, and an `instanceof` against it couples this
 * file to that re-export surviving a Prisma upgrade. The code is the stable
 * part of the contract.
 */
function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code: unknown }).code === 'P2002'
  );
}

interface StoredFileRow {
  id: string;
  documentType: string;
  status: string;
  storageProvider: string;
  storageKey: string;
  originalName: string;
  mimeType: string;
  sizeBytes: bigint;
  checksum: string | null;
  version: number;
}

function toStoredDocument(row: StoredFileRow): StoredDocument {
  return {
    id: row.id,
    documentType: row.documentType as DocumentType,
    status: row.status as DocumentStatus,
    storageProvider: row.storageProvider,
    storageKey: row.storageKey,
    fileName: row.originalName,
    mimeType: row.mimeType,
    // Safe: a BigInt of a file size is nowhere near 2^53, and the API returns
    // JSON, which cannot serialise a BigInt at all.
    sizeBytes: Number(row.sizeBytes),
    checksum: row.checksum,
    version: row.version,
  };
}
