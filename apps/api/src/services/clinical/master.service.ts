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
 * ⚠️ `specialtyIds` RANKS, AND THE LEFT JOIN BELOW IS WHAT MAKES THAT TRUE. §11
 *   and §34 both say a word relevant to several specialties must not be hidden
 *   from a doctor because nobody tagged it — so a scope match sorts a row UP and
 *   its absence never removes one. An INNER JOIN here would mean that the day a
 *   clinic adds a diagnosis and forgets to tag it, that diagnosis becomes
 *   invisible to every doctor, with no error and nothing to notice.
 *
 * ⚠️ `onlyScoped` TURNS IT INTO A FILTER, AND IT IS THE CALLER'S DECISION. It is
 *   a HAVING rather than an INNER JOIN so the two modes are one query and cannot
 *   drift apart. What keeps §34 intact is not this endpoint refusing to narrow —
 *   it is that the caller always offers the way back out. `apps/web` widens on
 *   an empty scoped result and says so on screen.
 *
 * ⚠️ A SCOPE IS A BRANCH, NOT A NODE, AND THIS IS A FIX RATHER THAN A FEATURE.
 *   `clinical_master_scopes.specialty_id` has always been documented as covering
 *   "every node beneath it" — the model says so — while this query compared it
 *   with `=`. So a clinic that tagged a word to `ENDODONTICS` got no ranking at
 *   all for a dentist whose template scopes to `DEN`, which is precisely the
 *   level a clinic is told to tag at. The CTE below walks BOTH ways from every
 *   requested node:
 *
 *     up    HUMAN → DEN            an ancestor's word applies to the branch
 *                                  ("Fever", tagged at the care context)
 *     down  DEN → ENDODONTICS      a sub-specialty's word belongs to its domain
 *                                  ("Pulpectomy", tagged at the leaf)
 *
 *   Both directions matter under `onlyScoped`: without `up` a filtered list
 *   loses every general term, and without `down` it loses everything the clinic
 *   tagged more precisely than the template asks.
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
    const parentId = query.parentId ?? null;
    /*
     * ⚠️ AN EMPTY ARRAY IS THE "NO SCOPE ASKED FOR" CASE AND MUST STAY EMPTY.
     *   `in_scope` then has no rows, the LEFT JOIN matches nothing, and the
     *   ranking collapses to the clinic's own order — which is exactly what an
     *   unscoped call meant before any of this existed. `onlyScoped` with no
     *   nodes would therefore return nothing, so the caller is not allowed to
     *   ask for that: the filter is ignored unless something was scoped.
     */
    const specialtyIds = query.specialtyIds;
    const onlyScoped = query.onlyScoped && specialtyIds.length > 0;

    const rows = await tx.$queryRaw<(ItemRow & { total: bigint })[]>`
      WITH RECURSIVE requested AS (
        SELECT unnest(${specialtyIds}::uuid[]) AS id
      ),
      /* Every ancestor of a requested node, and the node itself. */
      up AS (
        SELECT sp.id, sp.parent_id
          FROM specialties sp JOIN requested r ON r.id = sp.id
         WHERE sp.deleted_at IS NULL
        UNION
        SELECT parent.id, parent.parent_id
          FROM specialties parent JOIN up ON up.parent_id = parent.id
         WHERE parent.deleted_at IS NULL
      ),
      /* Every descendant of a requested node, and the node itself. */
      down AS (
        SELECT sp.id
          FROM specialties sp JOIN requested r ON r.id = sp.id
         WHERE sp.deleted_at IS NULL
        UNION
        SELECT child.id
          FROM specialties child JOIN down ON child.parent_id = down.id
         WHERE child.deleted_at IS NULL
      ),
      in_scope AS (
        SELECT id FROM up
        UNION
        SELECT id FROM down
      )
      SELECT i.id, i.organization_id, i.kind, i.code, i.name, i.description,
             i.parent_id, i.display_order, i.is_active,
             count(*) OVER () AS total
        FROM clinical_master_items i
        /* Ranking by default — a LEFT JOIN, never an INNER one. The narrowing,
           when it is asked for, is the HAVING below. */
        LEFT JOIN clinical_master_scopes s
          ON s.item_id = i.id
         AND s.specialty_id IN (SELECT id FROM in_scope)
       WHERE i.deleted_at IS NULL
         AND i.kind = ${query.kind}::"ClinicalMasterKind"
         AND (${query.includeInactive}::boolean OR i.is_active)
         AND (${parentId}::uuid IS NULL OR i.parent_id = ${parentId}::uuid)
         AND (${search}::text IS NULL OR lower(i.name) LIKE '%' || lower(${search}::text) || '%')
       GROUP BY i.id
       /* ⚠️ max(s.relevance) IS THE "MATCHED" TEST, NOT count(s.id) > 0, so it
          reads identically to the ORDER BY below and the two cannot disagree
          about what in-scope means. relevance defaults to 0, never NULL, so a
          match is never mistaken for an absence. Window functions run AFTER
          HAVING, so the total counts the filtered set.

          ⚠️ NO BACKTICKS ANYWHERE INSIDE THIS TEMPLATE LITERAL. A backtick in a
          SQL comment ENDS the tagged template, and the parse error it produces
          points at the comment rather than at the query. */
       HAVING (${onlyScoped}::boolean = false OR max(s.relevance) IS NOT NULL)
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
        /*
         * ⚠️ NEITHER NESTED CREATE MAY NAME `organizationId`, AND BOTH USED TO.
         *   `codings` and `scopes` reach their item through a COMPOSITE relation
         *   — (organization_id, item_id) -> (organization_id, id) — so
         *   `organization_id` is one of the two columns Prisma fills in from the
         *   parent it is creating. Supplying it as well is not merely redundant:
         *   Prisma rejects the whole call, and the API answers 400 "Invalid data
         *   provided", which names neither the field nor the relation.
         *
         *   That made `POST /clinical-data` fail for EVERY request carrying a
         *   coding or a specialty — including the one the clinical-terms screen
         *   sends, which is the only way a clinic tags its own vocabulary. It
         *   went unnoticed because no test had ever created a term with either.
         *   Inheriting the column is also the safer shape: a scope can no longer
         *   disagree with the item it hangs off.
         */
        ...(input.codings !== undefined && input.codings.length > 0
          ? {
              codings: {
                create: input.codings.map((c) => ({
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
                create: input.specialtyIds.map((specialtyId) => ({ specialtyId })),
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
