-- Document & storage metadata: `files` becomes the generic document table that
-- `DocumentService` writes to (invoice engine, phase 1).
--
-- Additive only. Every existing row is an upload that already has its bytes, so
-- the defaults (`UPLOAD`, `READY`, `local`, version 1) describe them correctly
-- and no backfill is needed.
--
-- ⚠️ `storage_provider` defaults to 'local' for EXISTING rows too, and that is a
--   claim about where their bytes are. It is true today because nothing has
--   ever written to this table — there is no upload code in the repository yet.
--   Were there rows from an S3 era, this default would quietly mislabel them.

-- CreateEnum
CREATE TYPE "DocumentType" AS ENUM ('INVOICE_PDF', 'CREDIT_NOTE_PDF', 'UPLOAD');

-- CreateEnum
CREATE TYPE "DocumentStatus" AS ENUM ('PENDING', 'GENERATING', 'READY', 'FAILED');

-- AlterTable
ALTER TABLE "files" ADD COLUMN     "document_type" "DocumentType" NOT NULL DEFAULT 'UPLOAD',
ADD COLUMN     "failure_reason" VARCHAR(500),
ADD COLUMN     "status" "DocumentStatus" NOT NULL DEFAULT 'READY',
ADD COLUMN     "storage_provider" VARCHAR(16) NOT NULL DEFAULT 'local',
ADD COLUMN     "version" SMALLINT NOT NULL DEFAULT 1,
ALTER COLUMN "size_bytes" SET DEFAULT 0;

-- CreateIndex
CREATE INDEX "files_organization_id_document_type_status_idx" ON "files"("organization_id", "document_type", "status");

-- CreateIndex
--
-- The composite-FK target of ADR-0004, so phase 3's `invoice_documents` can
-- reference a document via (organization_id, id) and make a cross-tenant
-- reference unrepresentable rather than merely unlikely.
--
-- Deliberately NOT `NULLS NOT DISTINCT`, unlike the other nullable-column
-- uniques in this schema: `id` is the primary key, so this pair is unique
-- whatever `organization_id` holds, and the index exists only to be an FK
-- target. See the model comment.
CREATE UNIQUE INDEX "files_organization_id_id_key" ON "files"("organization_id", "id");

-- ---------------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------------
-- `files` already carries its `tenant_isolation` policy, applied when the table
-- was created and unchanged here — this migration adds columns to an existing
-- protected table rather than a new table, so there is no new policy to write
-- and `db:rls:check` was already counting it.
--
-- ⚠️ That policy permits a NULL organization_id in its WITH CHECK, which is
--   right for a platform asset and is NOT the shape to copy for a tenant table
--   (see the `specialties` note in enable-rls.sql). Every document the invoice
--   engine writes carries a real organization_id; nothing in `DocumentService`
--   may create a NULL-org document on a tenant's behalf.
