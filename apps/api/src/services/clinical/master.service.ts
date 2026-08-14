/**
 * The clinical vocabulary: what a clinic can say (CD-5).
 *
 * Platform catalogue with per-tenant extension, exactly like `specialties`.
 * `organizationId = NULL` is a row every clinic reads; a clinic that needs a
 * word we have not thought of adds its own rather than waiting for a deploy.
 *
 * ⚠️ THE WRITE PATH CANNOT TOUCH A PLATFORM ROW, AND THAT IS ENFORCED THREE
 *   TIMES. `tenant_isolation` reads permissively but its WITH CHECK requires
 *   `organization_id = app_current_org()`, which a platform row can never
 *   satisfy; the `platform_rows_immutable` trigger refuses the UPDATE and the
 *   DELETE that the policy alone would let through; and `assertMutable` below
 *   runs first only so the caller gets a sentence rather than a constraint name.
 *   ⚠️ Copying the NULL-permissive WITH CHECK from `files` onto these tables
 *   would delete the real protection and leave only this file standing.
 *
 * NO PHI. Nothing here joins to `patients` — a dictionary entry discloses
 * nothing about anybody, which is why the search is not read-audited and the
 * episode service's reads are.
 */
import { withTenant, type TenantContext, type TxClient } from '@rcln/db';
import type {
  ClinicalMasterItem,
  ClinicalMasterKindValue,
  ClinicalMasterListResponse,
  ClinicalMasterQuery,
  CreateClinicalMasterRequest,
  UpdateClinicalMasterRequest,
} from '@rcln/contracts';
import { ConflictError, NotFoundError, ValidationError } from '../../utils/errors.js';
import { recordAudit } from '../audit/audit.service.js';

interface ItemRow {
  id: string;
  organization_id: string | null;
  kind: ClinicalMasterKindValue;
  code: string;
  name: string;
  description: string | null;
  parent_id: string | null;
  display_order: number;
  is_active: boolean;
}

function assertMutable(row: { organization_id: string | null }): void {
  if (row.organization_id === null) {
    throw new ValidationError(
      'This is a platform-wide clinical term and cannot be modified. Add your own instead.'
    );
  }
}

async function codingsFor(
  tx: TxClient,
  itemIds: string[]
): Promise<Map<string, ClinicalMasterItem['codings']>> {
  if (itemIds.length === 0) return new Map();
  const rows = await tx.clinicalMasterCoding.findMany({
    where: { itemId: { in: itemIds } },
    select: { itemId: true, system: true, code: true, display: true, isPrimary: true },
    orderBy: [{ system: 'asc' }, { code: 'asc' }],
  });
  const byItem = new Map<string, ClinicalMasterItem['codings']>();
  for (const r of rows) {
    const list = byItem.get(r.itemId) ?? [];
    list.push({ system: r.system, code: r.code, display: r.display, isPrimary: r.isPrimary });
    byItem.set(r.itemId, list);
  }
  return byItem;
}

/**
 * Search the vocabulary.
 *
 * ⚠️ `specialtyId` RANKS. IT DOES NOT FILTER, and the LEFT JOIN below is the
 *   whole difference. §11 and §34 both say a word relevant to several
 *   specialties must not be hidden from a doctor because nobody tagged it — so
 *   a scope match sorts a row UP and its absence never removes one. An INNER
 *   JOIN here would mean that the day a clinic adds a diagnosis and forgets to
 *   tag it, that diagnosis becomes invisible to every doctor, with no error and
 *   nothing to notice.
 *
 * ⚠️ RAW SQL BECAUSE OF THE TRIGRAM INDEX. `lower(name) % $term` is what uses
 *   `clinical_master_items_name_trgm_idx`; Prisma's `contains` compiles to an
 *   ILIKE that cannot, and the alternative is a sequential scan over every word
 *   on the PLATFORM. Every value is parameterised — never interpolated.
 */
export async function searchMasters(
  ctx: TenantContext,
  query: ClinicalMasterQuery
): Promise<ClinicalMasterListResponse> {
  return withTenant(ctx, async (tx) => {
    const offset = (query.page - 1) * query.pageSize;
    const search = query.search ?? null;
    const specialtyId = query.specialtyId ?? null;
    const parentId = query.parentId ?? null;

    const rows = await tx.$queryRaw<(ItemRow & { total: bigint })[]>`
      SELECT i.id, i.organization_id, i.kind, i.code, i.name, i.description,
             i.parent_id, i.display_order, i.is_active,
             count(*) OVER () AS total
        FROM clinical_master_items i
        /* Ranking only — see the note above. A LEFT JOIN, never an INNER one. */
        LEFT JOIN clinical_master_scopes s
          ON s.item_id = i.id
         AND ${specialtyId}::uuid IS NOT NULL
         AND s.specialty_id = ${specialtyId}::uuid
       WHERE i.deleted_at IS NULL
         AND i.kind = ${query.kind}::"ClinicalMasterKind"
         AND (${query.includeInactive}::boolean OR i.is_active)
         AND (${parentId}::uuid IS NULL OR i.parent_id = ${parentId}::uuid)
         AND (${search}::text IS NULL OR lower(i.name) LIKE '%' || lower(${search}::text) || '%')
       GROUP BY i.id
       ORDER BY
         /* Scoped first, then the clinic's own words above the platform's, then
            the clinic's chosen order. A total order: name breaks every tie. */
         (max(s.relevance) IS NOT NULL) DESC,
         max(s.relevance) DESC NULLS LAST,
         (i.organization_id IS NOT NULL) DESC,
         i.display_order ASC,
         i.name ASC
       LIMIT ${query.pageSize} OFFSET ${offset}
    `;

    const total = rows[0] ? Number(rows[0].total) : 0;
    const codings = await codingsFor(
      tx,
      rows.map((r) => r.id)
    );

    return {
      items: rows.map((r) => ({
        id: r.id,
        kind: r.kind,
        code: r.code,
        name: r.name,
        description: r.description,
        parentId: r.parent_id,
        displayOrder: r.display_order,
        isActive: r.is_active,
        isOwn: r.organization_id !== null,
        codings: codings.get(r.id) ?? [],
      })),
      total,
      page: query.page,
      pageSize: query.pageSize,
    };
  });
}

export async function createMaster(
  ctx: TenantContext,
  input: CreateClinicalMasterRequest,
  options: { ipAddress?: string | undefined; userAgent?: string | undefined } = {}
): Promise<ClinicalMasterItem> {
  return withTenant(ctx, async (tx) => {
    /*
     * ⚠️ THE DUPLICATE CHECK SPANS PLATFORM ROWS TOO. The unique index is
     *   (organization_id, kind, code) NULLS NOT DISTINCT, so a clinic CAN
     *   legally create `DENTAL_CARIES` beside the platform's — and then has two
     *   words that render identically in every picker, with no way for a
     *   clinician to tell which one they just chose. Refusing is the useful
     *   answer; the clinic edits nothing and uses the platform row.
     */
    const clash = await tx.clinicalMasterItem.findFirst({
      where: { kind: input.kind, code: input.code, deletedAt: null },
      select: { id: true, organizationId: true },
    });
    if (clash) {
      throw new ConflictError(
        clash.organizationId === null
          ? 'A platform-wide term already uses that code.'
          : 'That code is already in use.'
      );
    }

    if (input.parentId !== undefined) {
      const parent = await tx.clinicalMasterItem.findFirst({
        where: { id: input.parentId, deletedAt: null },
        select: { kind: true },
      });
      if (!parent) throw new NotFoundError('Parent term');
      /*
       * ⚠️ A SYMPTOM CANNOT BE GROUPED UNDER A DIAGNOSIS. The tree groups within
       *   a kind — "Cardiovascular" over a set of symptoms — and a cross-kind
       *   parent would make every descendant walk return a mixture the caller
       *   asked one question about.
       */
      if (parent.kind !== input.kind) {
        throw new ValidationError('A term can only be grouped under one of the same kind.');
      }
    }

    const created = await tx.clinicalMasterItem.create({
      data: {
        organizationId: ctx.organizationId,
        kind: input.kind,
        code: input.code,
        name: input.name,
        ...(input.description !== undefined ? { description: input.description } : {}),
        ...(input.parentId !== undefined ? { parentId: input.parentId } : {}),
        ...(input.displayOrder !== undefined ? { displayOrder: input.displayOrder } : {}),
        ...(input.codings !== undefined && input.codings.length > 0
          ? {
              codings: {
                create: input.codings.map((c) => ({
                  organizationId: ctx.organizationId,
                  system: c.system,
                  code: c.code,
                  ...(c.display !== undefined ? { display: c.display } : {}),
                  isPrimary: c.isPrimary,
                })),
              },
            }
          : {}),
        ...(input.specialtyIds !== undefined && input.specialtyIds.length > 0
          ? {
              scopes: {
                create: input.specialtyIds.map((specialtyId) => ({
                  organizationId: ctx.organizationId,
                  specialtyId,
                })),
              },
            }
          : {}),
      },
      select: {
        id: true,
        organizationId: true,
        kind: true,
        code: true,
        name: true,
        description: true,
        parentId: true,
        displayOrder: true,
        isActive: true,
        codings: {
          select: { system: true, code: true, display: true, isPrimary: true },
          orderBy: [{ system: 'asc' }, { code: 'asc' }],
        },
      },
    });

    await recordAudit(tx, ctx, {
      action: 'CREATE',
      entityType: 'clinical_master_item',
      entityId: created.id,
      after: {
        id: created.id,
        kind: created.kind,
        code: created.code,
        name: created.name,
        parentId: created.parentId,
      },
      ...options,
    });

    return {
      id: created.id,
      kind: created.kind,
      code: created.code,
      name: created.name,
      description: created.description,
      parentId: created.parentId,
      displayOrder: created.displayOrder,
      isActive: created.isActive,
      isOwn: true,
      codings: created.codings,
    };
  });
}

export async function updateMaster(
  ctx: TenantContext,
  itemId: string,
  input: UpdateClinicalMasterRequest,
  options: { ipAddress?: string | undefined; userAgent?: string | undefined } = {}
): Promise<ClinicalMasterItem> {
  return withTenant(ctx, async (tx) => {
    const existing = await tx.clinicalMasterItem.findFirst({
      where: { id: itemId, deletedAt: null },
      select: {
        id: true,
        organizationId: true,
        kind: true,
        code: true,
        name: true,
        description: true,
        parentId: true,
        displayOrder: true,
        isActive: true,
      },
    });
    if (!existing) throw new NotFoundError('Clinical term');
    assertMutable({ organization_id: existing.organizationId });

    const updated = await tx.clinicalMasterItem.update({
      where: { id: itemId },
      data: {
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.description !== undefined ? { description: input.description } : {}),
        ...(input.displayOrder !== undefined ? { displayOrder: input.displayOrder } : {}),
        ...(input.isActive !== undefined ? { isActive: input.isActive } : {}),
      },
      select: {
        id: true,
        organizationId: true,
        kind: true,
        code: true,
        name: true,
        description: true,
        parentId: true,
        displayOrder: true,
        isActive: true,
        codings: {
          select: { system: true, code: true, display: true, isPrimary: true },
          orderBy: [{ system: 'asc' }, { code: 'asc' }],
        },
      },
    });

    /*
     * Scopes are replaced wholesale rather than diffed. They carry no history
     * and no meaning beyond "these are the nodes it is relevant to", so a
     * replace is honest and a diff would be three statements to reach the same
     * place.
     */
    if (input.specialtyIds !== undefined) {
      await tx.clinicalMasterScope.deleteMany({ where: { itemId } });
      if (input.specialtyIds.length > 0) {
        await tx.clinicalMasterScope.createMany({
          data: input.specialtyIds.map((specialtyId) => ({
            organizationId: ctx.organizationId,
            itemId,
            specialtyId,
          })),
        });
      }
    }

    await recordAudit(tx, ctx, {
      action: 'UPDATE',
      entityType: 'clinical_master_item',
      entityId: itemId,
      before: {
        name: existing.name,
        description: existing.description,
        displayOrder: existing.displayOrder,
        isActive: existing.isActive,
      },
      after: {
        name: updated.name,
        description: updated.description,
        displayOrder: updated.displayOrder,
        isActive: updated.isActive,
      },
      ...options,
    });

    return {
      id: updated.id,
      kind: updated.kind,
      code: updated.code,
      name: updated.name,
      description: updated.description,
      parentId: updated.parentId,
      displayOrder: updated.displayOrder,
      isActive: updated.isActive,
      isOwn: true,
      codings: updated.codings,
    };
  });
}

/**
 * Deactivate, not delete.
 *
 * From CE-4 onwards `encounter_diagnoses` and its siblings reference these rows,
 * and hard-deleting would destroy the record of what a clinician actually
 * concluded. `is_active = false` removes the word from every picker while every
 * consultation that already used it keeps rendering.
 */
export async function deactivateMaster(
  ctx: TenantContext,
  itemId: string,
  options: { ipAddress?: string | undefined; userAgent?: string | undefined } = {}
): Promise<void> {
  await withTenant(ctx, async (tx) => {
    const existing = await tx.clinicalMasterItem.findFirst({
      where: { id: itemId, deletedAt: null },
      select: { id: true, organizationId: true, isActive: true },
    });
    if (!existing) throw new NotFoundError('Clinical term');
    assertMutable({ organization_id: existing.organizationId });

    const children = await tx.clinicalMasterItem.count({
      where: { parentId: itemId, isActive: true, deletedAt: null },
    });
    if (children > 0) {
      throw new ConflictError(
        'This term still groups other terms. Deactivate or re-group those first.'
      );
    }

    await tx.clinicalMasterItem.update({ where: { id: itemId }, data: { isActive: false } });

    await recordAudit(tx, ctx, {
      action: 'UPDATE',
      entityType: 'clinical_master_item',
      entityId: itemId,
      before: { isActive: existing.isActive },
      after: { isActive: false },
      ...options,
    });
  });
}
