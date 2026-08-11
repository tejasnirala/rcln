/**
 * The clinical taxonomy tree: traversal, search, and curation of the catalogue.
 *
 * Backed by `specialties`, an adjacency list. Ancestors and descendants are
 * `WITH RECURSIVE` over `parent_id`.
 *
 * ── WHY NOT A CLOSURE TABLE ──────────────────────────────────────────────────
 * The obvious alternative materialises every ancestor/descendant pair. At this
 * scale it buys nothing: the platform catalogue is ~150 nodes, five levels at
 * the deepest, and `specialties_parent_id_idx` makes each level of the recursion
 * an index lookup. A closure table would add a second table to keep consistent
 * on every re-parent, which is a whole class of drift bug in exchange for
 * microseconds. Revisit if the tree reaches five figures.
 *
 * ── TENANCY ──────────────────────────────────────────────────────────────────
 * Every statement runs inside `withTenant`, so the `tenant_isolation` policy on
 * `specialties` applies: a clinic sees platform rows (organization_id IS NULL)
 * plus its own, and nothing else. The recursive CTEs therefore need no
 * hand-written org predicate to be SAFE — but a tenant's private subtree hanging
 * off a platform node is only visible to that tenant, so two clinics legitimately
 * see different trees under the same root. That is the intent, not a bug.
 *
 * ⚠️ THE READ POLICY IS PERMISSIVE AND THE WRITE POLICY IS NOT:
 *
 *     USING      (organization_id IS NULL OR organization_id = app_current_org())
 *     WITH CHECK (organization_id = app_current_org())
 *
 *   The permissive USING is what lets every clinic read the platform catalogue.
 *   It is tempting to conclude that an UPDATE against a platform id therefore
 *   goes through — the row is visible, so the statement finds it. It does find
 *   it, and then fails the WITH CHECK, which is evaluated against the row as it
 *   would be AFTER the write: a platform row's organization_id stays NULL.
 *   Postgres refuses it.
 *
 *   `assertMutable` below is the SECOND layer, not the only one. It exists so a
 *   clinic editing a platform row gets a 400 that names the problem instead of
 *   an opaque row-level-security error. Keep both — and note that copying the
 *   NULL-permissive WITH CHECK from `files` onto this table would delete the
 *   real protection and leave only the service check standing.
 *
 * NO PHI. Nothing here joins to `patients`.
 */
import { withTenant, type TenantContext, type TxClient } from '@rcln/db';
import type {
  CreateTaxonomyNodeRequest,
  TaxonomyNode,
  TaxonomyNodeWithAncestors,
  TaxonomySearchQuery,
  TaxonomyTreeNode,
  UpdateTaxonomyNodeRequest,
} from '@rcln/contracts';
import { ConflictError, NotFoundError, ValidationError } from '../../utils/errors.js';
import { recordAudit } from '../audit/audit.service.js';

export interface TaxonomyActionOptions {
  ipAddress?: string | undefined;
  userAgent?: string | undefined;
}

/**
 * The row shape every read produces, so list, tree and search cannot drift.
 *
 * `depth` and `has_children` are computed in SQL rather than in TypeScript: the
 * first is free inside the recursion, and the second would otherwise be a second
 * query per node — the N+1 that makes a tree endpoint slow.
 */
interface NodeRow {
  id: string;
  code: string;
  name: string;
  parent_id: string | null;
  type: TaxonomyNode['type'];
  description: string | null;
  display_order: number;
  is_active: boolean;
  organization_id: string | null;
  depth: number;
  has_children: boolean;
}

function toNode(row: NodeRow): TaxonomyNode {
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    parentId: row.parent_id,
    type: row.type,
    description: row.description,
    displayOrder: Number(row.display_order),
    isActive: row.is_active,
    isOwn: row.organization_id !== null,
    depth: Number(row.depth),
    hasChildren: row.has_children,
  };
}

/*
 * `has_children` is spelled out inline in each statement rather than shared as a
 * string constant, because Prisma's tagged-template `$queryRaw` parameterises
 * only interpolated VALUES — splicing SQL fragments in would need
 * `$queryRawUnsafe` and lose that. It is deliberately NOT filtered by
 * `is_active`: an inactive child is still a reason to render an expand chevron,
 * and making the flag depend on the caller's filter means two callers disagree
 * about whether the same node is a leaf.
 */

/**
 * Load one node, or fail. Used by every endpoint that takes an `:id`.
 *
 * ⚠️ NOT FOUND, NEVER FORBIDDEN, for a node belonging to another tenant. RLS has
 *   already filtered it out of the read, so it is genuinely indistinguishable
 *   from a node that does not exist — and answering 403 would confirm the id is
 *   real to someone probing for it.
 */
async function loadNode(tx: TxClient, id: string): Promise<NodeRow> {
  const rows = await tx.$queryRaw<NodeRow[]>`
    -- ⚠️ depth IS COMPUTED, NOT HARDCODED TO 0.
    --
    -- It used to be a literal zero, on the reasoning that a single-node read has
    -- no recursion to carry a depth. But this function supplies the response
    -- body for POST and PATCH, so creating a node three levels down answered
    -- "depth: 0" — a cascading selector reading that from the create response
    -- puts a brand-new sub-specialty in the domain column. Every OTHER endpoint
    -- reported the right depth, which is what made it convincing.
    WITH RECURSIVE up AS (
      SELECT s.id, s.parent_id, 0 AS d
      FROM specialties s
      WHERE s.id = ${id}::uuid AND s.deleted_at IS NULL
      UNION ALL
      SELECT p.id, p.parent_id, up.d + 1
      FROM specialties p
      JOIN up ON up.parent_id = p.id
      WHERE p.deleted_at IS NULL
    )
    SELECT s.id, s.code, s.name, s.parent_id, s.type, s.description,
      s.display_order, s.is_active, s.organization_id,
      (SELECT max(d) FROM up) AS depth,
      EXISTS (SELECT 1 FROM specialties c WHERE c.parent_id = s.id AND c.deleted_at IS NULL)
        AS has_children
    FROM specialties s
    WHERE s.id = ${id}::uuid AND s.deleted_at IS NULL
  `;
  const row = rows[0];
  if (!row) throw new NotFoundError('Taxonomy node');
  return row;
}

/**
 * Refuse to mutate a platform row.
 *
 * The database refuses it too — see the WITH CHECK discussion in the file
 * header. This runs first so the caller gets a 400 explaining that the
 * catalogue is platform-wide and suggesting they add their own node, rather
 * than a 500-shaped "new row violates row-level security policy".
 */
function assertMutable(row: NodeRow): void {
  if (row.organization_id === null) {
    throw new ValidationError(
      'This is a platform-wide classification and cannot be modified. Add your own node instead.'
    );
  }
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

/** The roots — the clinical domains. `parent_id IS NULL`. */
export async function listRoots(
  ctx: TenantContext,
  includeInactive: boolean
): Promise<TaxonomyNode[]> {
  const rows = await withTenant(
    ctx,
    (tx) =>
      tx.$queryRaw<NodeRow[]>`
      SELECT s.id, s.code, s.name, s.parent_id, s.type, s.description,
             s.display_order, s.is_active, s.organization_id,
             0 AS depth,
             EXISTS (SELECT 1 FROM specialties c
                     WHERE c.parent_id = s.id AND c.deleted_at IS NULL) AS has_children
      FROM specialties s
      WHERE s.parent_id IS NULL
        AND s.deleted_at IS NULL
        AND (${includeInactive}::boolean OR s.is_active)
      ORDER BY s.display_order, s.name
    `
  );
  return rows.map(toNode);
}

/** Immediate children of one node. One level, not the subtree. */
export async function listChildren(
  ctx: TenantContext,
  id: string,
  includeInactive: boolean
): Promise<TaxonomyNode[]> {
  return withTenant(ctx, async (tx) => {
    await loadNode(tx, id);
    const rows = await tx.$queryRaw<NodeRow[]>`
      -- ⚠️ depth IS ABSOLUTE — parent's depth + 1, NOT the literal 1.
      --
      -- It was 1, which is only right when the parent happens to be a root.
      -- Children of Cardiology are at depth 2, and reporting them as 1 made the
      -- SAME NODE answer a different depth depending on which endpoint asked:
      -- /search said 2, /children said 1. The contract calls depth "distance
      -- from the root of the tenant-visible tree", so anything relative is a lie
      -- to every caller that believes it.
      WITH RECURSIVE up AS (
        SELECT p.id, p.parent_id, 0 AS d
        FROM specialties p
        WHERE p.id = ${id}::uuid AND p.deleted_at IS NULL
        UNION ALL
        SELECT g.id, g.parent_id, up.d + 1
        FROM specialties g
        JOIN up ON up.parent_id = g.id
        WHERE g.deleted_at IS NULL
      )
      SELECT s.id, s.code, s.name, s.parent_id, s.type, s.description,
             s.display_order, s.is_active, s.organization_id,
             (SELECT max(d) FROM up) + 1 AS depth,
             EXISTS (SELECT 1 FROM specialties c
                     WHERE c.parent_id = s.id AND c.deleted_at IS NULL) AS has_children
      FROM specialties s
      WHERE s.parent_id = ${id}::uuid
        AND s.deleted_at IS NULL
        AND (${includeInactive}::boolean OR s.is_active)
      ORDER BY s.display_order, s.name
    `;
    return rows.map(toNode);
  });
}

/**
 * Every descendant of `id`, as flat rows carrying their depth.
 *
 * Shared by the tree endpoint and by descendant-aware doctor filtering, so the
 * two can never disagree about what "under Cardiology" means.
 *
 * ⚠️ `includeSelf` CHANGES THE MEANING FOR FILTERING. Searching for doctors
 *   "in Cardiology" must match doctors tagged Cardiology itself, not only its
 *   sub-specialties — so the filter passes true.
 */
export async function descendantRows(
  tx: TxClient,
  id: string,
  includeInactive: boolean,
  includeSelf: boolean
): Promise<NodeRow[]> {
  return tx.$queryRaw<NodeRow[]>`
    WITH RECURSIVE
    -- How deep the subtree's own root sits. Added to the relative depth below so
    -- the emitted depth is ABSOLUTE and agrees with every other endpoint —
    -- /tree used to report Cardiology as 0 while /search reported it as 1.
    root_depth AS (
      SELECT r.id, r.parent_id, 0 AS d
      FROM specialties r
      WHERE r.id = ${id}::uuid AND r.deleted_at IS NULL
      UNION ALL
      SELECT p.id, p.parent_id, rd.d + 1
      FROM specialties p
      JOIN root_depth rd ON rd.parent_id = p.id
      WHERE p.deleted_at IS NULL
    ),
    subtree AS (
      SELECT s.id, s.parent_id, 0 AS rel
      FROM specialties s
      WHERE s.id = ${id}::uuid AND s.deleted_at IS NULL
      UNION ALL
      -- Terminates because the tree is acyclic, which is enforced by the
      -- specialties_no_cycle trigger rather than hoped for here.
      SELECT c.id, c.parent_id, t.rel + 1
      FROM specialties c
      JOIN subtree t ON c.parent_id = t.id
      WHERE c.deleted_at IS NULL
    )
    SELECT s.id, s.code, s.name, s.parent_id, s.type, s.description,
           s.display_order, s.is_active, s.organization_id,
           (SELECT max(d) FROM root_depth) + t.rel AS depth,
           EXISTS (SELECT 1 FROM specialties c
                   WHERE c.parent_id = s.id AND c.deleted_at IS NULL) AS has_children
    FROM subtree t
    JOIN specialties s ON s.id = t.id
    -- ⚠️ rel, NOT depth. includeSelf means "the node this walk started
    --   from", which is rel = 0 regardless of how deep that node sits. Filtering
    --   on the absolute depth here would drop every node in the subtree whenever
    --   the root was itself a domain, and drop nothing otherwise.
    WHERE (${includeSelf}::boolean OR t.rel > 0)
      AND (${includeInactive}::boolean OR s.is_active)
    ORDER BY t.rel, s.display_order, s.name
  `;
}

/**
 * The subtree rooted at `id`, nested.
 *
 * Assembled in one pass from the flat rows: the recursion returns parents before
 * children (`ORDER BY depth`), so a node's parent is always already in the map
 * by the time the node is reached.
 */
export async function getSubtree(
  ctx: TenantContext,
  id: string,
  includeInactive: boolean
): Promise<TaxonomyTreeNode> {
  return withTenant(ctx, async (tx) => {
    await loadNode(tx, id);
    const rows = await descendantRows(tx, id, includeInactive, true);

    const byId = new Map<string, TaxonomyTreeNode>();
    let root: TaxonomyTreeNode | undefined;

    for (const row of rows) {
      const node: TaxonomyTreeNode = { ...toNode(row), children: [] };
      byId.set(node.id, node);
      if (node.id === id) {
        root = node;
        continue;
      }
      // A parent missing from the map means it was filtered out by
      // `includeInactive` — an inactive node hides its whole subtree, which is
      // what "deactivated" has to mean for a selector to be trustworthy.
      byId.get(node.parentId ?? '')?.children.push(node);
    }

    if (!root) throw new NotFoundError('Taxonomy node');
    return root;
  });
}

/**
 * The chain from the root down to (but excluding) `id`.
 *
 * The walk goes UP, so the rows come back deepest-first and are reversed before
 * returning — `ancestors[0]` is the domain, which is the order a breadcrumb
 * renders in.
 */
export async function getAncestors(
  ctx: TenantContext,
  id: string
): Promise<TaxonomyNodeWithAncestors> {
  return withTenant(ctx, async (tx) => {
    const self = await loadNode(tx, id);

    const rows = await tx.$queryRaw<NodeRow[]>`
      WITH RECURSIVE chain AS (
        SELECT s.id, s.parent_id, 0 AS depth
        FROM specialties s
        WHERE s.id = ${id}::uuid AND s.deleted_at IS NULL
        UNION ALL
        SELECT p.id, p.parent_id, c.depth + 1
        FROM specialties p
        JOIN chain c ON c.parent_id = p.id
        WHERE p.deleted_at IS NULL
      )
      SELECT s.id, s.code, s.name, s.parent_id, s.type, s.description,
             s.display_order, s.is_active, s.organization_id, c.depth,
             EXISTS (SELECT 1 FROM specialties ch
                     WHERE ch.parent_id = s.id AND ch.deleted_at IS NULL) AS has_children
      FROM chain c
      JOIN specialties s ON s.id = c.id
      WHERE c.depth > 0
      ORDER BY c.depth DESC
    `;

    // `depth` from the walk counts UP from the node; re-express it as distance
    // from the root so it means the same thing as everywhere else in this file.
    const ancestors = rows.map((row, index) => ({ ...toNode(row), depth: index }));
    return {
      node: { ...toNode(self), depth: ancestors.length },
      ancestors,
    };
  });
}

/**
 * Name and code search.
 *
 * ⚠️ MATCHES ARE RETURNED WITH THEIR DEPTH, NOT AS BARE NAMES. "Oncology"
 *   matches four nodes across two domains, and a picker showing four identical
 *   rows is unusable — the caller pairs each hit with `GET /:id/ancestors`, or
 *   uses `underId` to scope the search to one subtree in the first place.
 */
export async function searchNodes(
  ctx: TenantContext,
  query: TaxonomySearchQuery
): Promise<TaxonomyNode[]> {
  const { q, underId = null, type = null, includeInactive, limit } = query;

  const rows = await withTenant(
    ctx,
    (tx) =>
      tx.$queryRaw<NodeRow[]>`
      WITH RECURSIVE
      -- Anchored on underId alone, so when it is NULL this yields no rows and
      -- costs nothing. The predicate below is what makes NULL mean "everywhere",
      -- NOT this CTE — anchoring on "every node" and unioning children would walk
      -- the entire tree once per root to answer a query that ignores the result.
      scope AS (
        SELECT s.id FROM specialties s WHERE s.id = ${underId}::uuid
        UNION ALL
        SELECT c.id FROM specialties c
        JOIN scope ON c.parent_id = scope.id
        WHERE c.deleted_at IS NULL
      ),
      -- Depth for every node in ONE downward pass from the roots. The obvious
      -- alternative — a correlated "walk up from here" subquery in the SELECT —
      -- reads more naturally and runs once per row in the table, not once per
      -- row in the result, because the LIMIT is applied after the join.
      depths AS (
        SELECT s.id, s.parent_id, 0 AS depth
        FROM specialties s
        WHERE s.parent_id IS NULL AND s.deleted_at IS NULL
        UNION ALL
        SELECT c.id, c.parent_id, d.depth + 1
        FROM specialties c
        JOIN depths d ON c.parent_id = d.id
        WHERE c.deleted_at IS NULL
      )
      SELECT s.id, s.code, s.name, s.parent_id, s.type, s.description,
             s.display_order, s.is_active, s.organization_id,
             coalesce(d.depth, 0) AS depth,
             EXISTS (SELECT 1 FROM specialties c
                     WHERE c.parent_id = s.id AND c.deleted_at IS NULL) AS has_children
      FROM specialties s
      JOIN depths d ON d.id = s.id
      WHERE s.deleted_at IS NULL
        AND (${includeInactive}::boolean OR s.is_active)
        AND (${type}::text IS NULL OR s.type = ${type}::"TaxonomyNodeType")
        AND (${underId}::uuid IS NULL OR s.id IN (SELECT id FROM scope))
        AND (lower(s.name) LIKE '%' || lower(${q}) || '%' OR lower(s.code) LIKE '%' || lower(${q}) || '%')
      ORDER BY
        -- A prefix match is what the user meant; a substring match is a
        -- consolation. "Cardio" should put Cardiology above Paediatric Cardiology.
        (lower(s.name) LIKE lower(${q}) || '%') DESC,
        length(s.name),
        s.name
      LIMIT ${limit}
    `
  );
  return rows.map(toNode);
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

/**
 * Add a node to THIS CLINIC's catalogue.
 *
 * Always org-scoped. There is no path here that writes a platform row: the seed
 * owns those, and the RLS WITH CHECK would refuse anyway.
 */
export async function createNode(
  ctx: TenantContext,
  input: CreateTaxonomyNodeRequest,
  options: TaxonomyActionOptions = {}
): Promise<TaxonomyNode> {
  return withTenant(ctx, async (tx) => {
    if (input.parentId) {
      const parent = await loadNode(tx, input.parentId);
      if (!parent.is_active) {
        throw new ValidationError('Cannot add a classification under an inactive parent.');
      }
    }

    const clash = await tx.specialty.findFirst({
      where: { organizationId: ctx.organizationId, code: input.code, deletedAt: null },
      select: { id: true },
    });
    if (clash) throw new ConflictError('A classification with this code already exists.');

    let createdId: string;
    try {
      const created = await tx.specialty.create({
        data: {
          organizationId: ctx.organizationId,
          code: input.code,
          name: input.name,
          parentId: input.parentId ?? null,
          type: input.type,
          description: input.description ?? null,
          displayOrder: input.displayOrder,
        },
        select: { id: true },
      });
      createdId = created.id;
    } catch (err) {
      throw translateWriteError(err);
    }

    await recordAudit(tx, ctx, {
      action: 'CREATE',
      entityType: 'specialty',
      entityId: createdId,
      after: { code: input.code, name: input.name, parentId: input.parentId ?? null },
      ...options,
    });

    return toNode(await loadNode(tx, createdId));
  });
}

export async function updateNode(
  ctx: TenantContext,
  id: string,
  input: UpdateTaxonomyNodeRequest,
  options: TaxonomyActionOptions = {}
): Promise<TaxonomyNode> {
  return withTenant(ctx, async (tx) => {
    const existing = await loadNode(tx, id);
    assertMutable(existing);

    if (input.parentId !== undefined && input.parentId !== null) {
      if (input.parentId === id) {
        throw new ValidationError('A classification cannot be its own parent.');
      }
      const parent = await loadNode(tx, input.parentId);
      if (!parent.is_active) {
        throw new ValidationError('Cannot move a classification under an inactive parent.');
      }
      /*
       * Reject a move INTO this node's own subtree before attempting it.
       *
       * The `specialties_no_cycle` trigger would refuse it anyway, but as a
       * raw Postgres exception with no field attached. Checking here turns
       * that into a message naming what the user actually did.
       */
      const subtree = await descendantRows(tx, id, true, false);
      if (subtree.some((n) => n.id === input.parentId)) {
        throw new ValidationError(
          'Cannot move a classification underneath one of its own descendants.'
        );
      }
    }

    /*
     * ⚠️ DEACTIVATION IS NOT A FIELD UPDATE LIKE THE OTHERS. Hiding a node whose
     *   children are still active leaves those children reachable by id but
     *   unreachable by browsing — a selector shows an empty branch and the data
     *   looks corrupted. Refuse, and make the caller deal with the subtree.
     */
    if (input.isActive === false && existing.is_active) {
      await assertSafeToDeactivate(tx, id);
    }

    try {
      await tx.specialty.update({
        where: { id },
        data: {
          ...(input.name !== undefined ? { name: input.name } : {}),
          ...(input.parentId !== undefined ? { parentId: input.parentId } : {}),
          ...(input.type !== undefined ? { type: input.type } : {}),
          ...(input.description !== undefined ? { description: input.description } : {}),
          ...(input.displayOrder !== undefined ? { displayOrder: input.displayOrder } : {}),
          ...(input.isActive !== undefined ? { isActive: input.isActive } : {}),
        },
        select: { id: true },
      });
    } catch (err) {
      throw translateWriteError(err);
    }

    const after = await loadNode(tx, id);

    await recordAudit(tx, ctx, {
      action: 'UPDATE',
      entityType: 'specialty',
      entityId: id,
      before: { name: existing.name, parentId: existing.parent_id, isActive: existing.is_active },
      after: { name: after.name, parentId: after.parent_id, isActive: after.is_active },
      ...options,
    });

    return toNode(after);
  });
}

/**
 * Deactivate. NOT a hard delete, and the route says DELETE only because that is
 * the verb the client has.
 *
 * A taxonomy node is referenced by `doctor_specialties` with `onDelete: Restrict`
 * and will later be referenced by procedures. Removing the row would break the
 * historical record of what a doctor was classified as; `is_active = false`
 * keeps existing assignments resolving while removing the node from every picker.
 */
export async function deactivateNode(
  ctx: TenantContext,
  id: string,
  options: TaxonomyActionOptions = {}
): Promise<void> {
  await withTenant(ctx, async (tx) => {
    const existing = await loadNode(tx, id);
    assertMutable(existing);
    await assertSafeToDeactivate(tx, id);

    await tx.specialty.update({ where: { id }, data: { isActive: false } });

    await recordAudit(tx, ctx, {
      action: 'DELETE',
      entityType: 'specialty',
      entityId: id,
      before: { code: existing.code, name: existing.name },
      ...options,
    });
  });
}

/**
 * The two things that make deactivating a node destructive.
 *
 * Both are refusals rather than cascades on purpose. Cascading would deactivate
 * a subtree, or silently detach doctors from their recorded specialty, from a
 * single click on one node — and neither is recoverable by pressing undo.
 */
async function assertSafeToDeactivate(tx: TxClient, id: string): Promise<void> {
  const activeChildren = await tx.specialty.count({
    where: { parentId: id, isActive: true, deletedAt: null },
  });
  if (activeChildren > 0) {
    throw new ConflictError(
      `This classification has ${activeChildren} active sub-classification(s). Deactivate or move them first.`
    );
  }

  const assigned = await tx.doctorSpecialty.count({ where: { specialtyId: id, isActive: true } });
  if (assigned > 0) {
    throw new ConflictError(
      `This classification is assigned to ${assigned} doctor(s). Remove it from them first.`
    );
  }
}

/**
 * Turn the database's guards into messages a user can act on.
 *
 * These fire only when a check above was raced or missed — they are the second
 * layer, not the first, and a message reaching a user from here means a
 * validation gap worth finding.
 */
function translateWriteError(err: unknown): Error {
  /*
   * ⚠️ THE CONSTRAINT NAME IS NOT IN `err.message`, AND NOT IN `meta.target`.
   *
   * Under Prisma 7 with the pg driver adapter, a P2002 arrives as:
   *
   *   meta.driverAdapterError.cause.originalMessage
   *     = 'duplicate key value violates unique constraint "specialties_sibling_name_key"'
   *
   * and there is no `meta.target` at all — that was the Prisma 5/6 shape. So
   * matching on the message, or on `meta.target`, silently never fires: the
   * sibling-name collision falls through to the generic P2002 handler and
   * answers "A record with this value already exists", which is true,
   * uninformative, and indistinguishable from a duplicate code.
   *
   * Serialising the whole `meta` is deliberately blunt. It survives the next
   * reshuffle of Prisma's error internals, which a path into a specific nested
   * field would not — and this is error-message polish, not a control.
   */
  const message = err instanceof Error ? err.message : '';
  const meta = (err as { meta?: unknown } | null)?.meta;
  let metaText = '';
  try {
    metaText = meta === undefined ? '' : JSON.stringify(meta);
  } catch {
    metaText = '';
  }
  const haystack = `${message} ${metaText}`;

  if (haystack.includes('specialties_sibling_name_key')) {
    return new ConflictError(
      'A classification with this name already exists under the same parent.'
    );
  }
  if (haystack.includes('cannot be its own parent') || haystack.includes('descendant of itself')) {
    return new ValidationError('That change would create a loop in the classification tree.');
  }
  if (haystack.includes('specialties_organization_id_code_key')) {
    return new ConflictError('A classification with this code already exists.');
  }
  return err instanceof Error ? err : new Error(String(err));
}
