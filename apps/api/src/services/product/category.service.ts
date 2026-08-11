/**
 * The product category tree.
 *
 * ⚠️ THE SAME SHAPE AS `clinical-taxonomy.service.ts`, AND THAT IS THE POINT.
 *   An adjacency list on `parent_id`, ancestors and descendants by
 *   `WITH RECURSIVE`, `depth` and `has_children` computed in SQL. A second
 *   traversal style for the same problem is how two trees start disagreeing
 *   about what "under Antibiotics" means. Read that file before changing this
 *   one; anything fixed there probably needs fixing here.
 *
 * Not a closure table, for the same reason: the catalogue is a few hundred
 * nodes, `product_categories_parent_id_idx` makes each level of the recursion an
 * index lookup, and a closure table is a second structure to keep consistent on
 * every re-parent.
 *
 * ── TENANCY ──────────────────────────────────────────────────────────────────
 * Platform catalogue + tenant extension, so two clinics legitimately see
 * different trees under the same root: a tenant's private subtree is visible
 * only to that tenant. That is the intent, not a bug.
 *
 * ⚠️ THERE IS NO POLICY STOPPING A TENANT PARENTING ITS CATEGORY UNDER ANOTHER
 *   TENANT'S PRIVATE ONE, exactly as there is none on `specialties`. One was
 *   written and removed: `parent_id` is a self-reference, and a policy on a table
 *   may not read that same table — it raises "infinite recursion detected in
 *   policy", and because `products.category_visible` reads this table the
 *   recursion took every read of `products` down with it. See the
 *   `drop_category_parent_visible` migration.
 *
 *   The residual gap is an id-existence oracle and nothing more: the ancestor
 *   walk below runs under RLS, so an invisible parent is simply dropped from the
 *   chain and its name is never readable. `loadCategory` still refuses an id the
 *   caller cannot see, which is what stops it happening through this service.
 *
 * NO PHI.
 */
import { withTenant, type TenantContext, type TxClient } from '@rcln/db';
import type {
  CreateProductCategoryRequest,
  ProductCategory,
  UpdateProductCategoryRequest,
} from '@rcln/contracts';
import { ConflictError, NotFoundError, ValidationError } from '../../utils/errors.js';
import { recordAudit } from '../audit/audit.service.js';
import type { CatalogueActionOptions } from './unit.service.js';

interface CategoryRow {
  id: string;
  code: string;
  name: string;
  parent_id: string | null;
  description: string | null;
  display_order: number;
  is_active: boolean;
  organization_id: string | null;
  depth: number;
  has_children: boolean;
}

function toCategory(row: CategoryRow): ProductCategory {
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    parentId: row.parent_id,
    description: row.description,
    displayOrder: Number(row.display_order),
    isActive: row.is_active,
    isOwn: row.organization_id !== null,
    depth: Number(row.depth),
    hasChildren: row.has_children,
  };
}

/**
 * Load one node, or fail.
 *
 * ⚠️ `depth` IS COMPUTED, NOT HARDCODED TO 0. This supplies the response body
 *   for POST and PATCH as well, so a literal zero would tell a cascading
 *   selector that a brand-new third-level category belongs in the root column.
 *   The clinical taxonomy shipped that bug; it is not repeated here.
 */
async function loadCategory(tx: TxClient, id: string): Promise<CategoryRow> {
  const rows = await tx.$queryRaw<CategoryRow[]>`
    WITH RECURSIVE up AS (
      SELECT c.id, c.parent_id, 0 AS d
      FROM product_categories c
      WHERE c.id = ${id}::uuid AND c.deleted_at IS NULL
      UNION ALL
      SELECT p.id, p.parent_id, up.d + 1
      FROM product_categories p
      JOIN up ON up.parent_id = p.id
      WHERE p.deleted_at IS NULL
    )
    SELECT c.id, c.code, c.name, c.parent_id, c.description,
           c.display_order, c.is_active, c.organization_id,
           (SELECT max(d) FROM up) AS depth,
           EXISTS (SELECT 1 FROM product_categories ch
                   WHERE ch.parent_id = c.id AND ch.deleted_at IS NULL) AS has_children
    FROM product_categories c
    WHERE c.id = ${id}::uuid AND c.deleted_at IS NULL
  `;
  const row = rows[0];
  if (!row) throw new NotFoundError('Product category');
  return row;
}

function assertMutable(row: CategoryRow): void {
  if (row.organization_id === null) {
    throw new ValidationError(
      'This is a platform-wide category and cannot be modified. Add your own category instead.'
    );
  }
}

/** Every descendant of `id`, flat, carrying an ABSOLUTE depth. */
async function descendantRows(
  tx: TxClient,
  id: string,
  includeInactive: boolean,
  includeSelf: boolean
): Promise<CategoryRow[]> {
  return tx.$queryRaw<CategoryRow[]>`
    WITH RECURSIVE
    root_depth AS (
      SELECT r.id, r.parent_id, 0 AS d
      FROM product_categories r
      WHERE r.id = ${id}::uuid AND r.deleted_at IS NULL
      UNION ALL
      SELECT p.id, p.parent_id, rd.d + 1
      FROM product_categories p
      JOIN root_depth rd ON rd.parent_id = p.id
      WHERE p.deleted_at IS NULL
    ),
    subtree AS (
      SELECT c.id, c.parent_id, 0 AS rel
      FROM product_categories c
      WHERE c.id = ${id}::uuid AND c.deleted_at IS NULL
      UNION ALL
      -- Terminates because the tree is acyclic, which the
      -- product_categories_no_cycle trigger enforces rather than this hoping.
      SELECT ch.id, ch.parent_id, t.rel + 1
      FROM product_categories ch
      JOIN subtree t ON ch.parent_id = t.id
      WHERE ch.deleted_at IS NULL
    )
    SELECT c.id, c.code, c.name, c.parent_id, c.description,
           c.display_order, c.is_active, c.organization_id,
           (SELECT max(d) FROM root_depth) + t.rel AS depth,
           EXISTS (SELECT 1 FROM product_categories ch
                   WHERE ch.parent_id = c.id AND ch.deleted_at IS NULL) AS has_children
    FROM subtree t
    JOIN product_categories c ON c.id = t.id
    -- ⚠️ rel, NOT depth. includeSelf means "the node this walk started from",
    --   which is rel = 0 however deep that node sits. Filtering on the ABSOLUTE
    --   depth here would drop the whole subtree whenever the root was itself a
    --   top-level category, and drop nothing otherwise.
    --
    -- (No backticks in these comments: this is a JS template literal, and one
    --  would end the string mid-query.)
    WHERE (${includeSelf}::boolean OR t.rel > 0)
      AND (${includeInactive}::boolean OR c.is_active)
    ORDER BY t.rel, c.display_order, c.name
  `;
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

/**
 * The whole visible tree, flat, parents before children.
 *
 * Flat rather than nested because the catalogue is small and every consumer —
 * the filter dropdown, the create wizard, the breadcrumb — wants a different
 * shape. Nesting is one `reduce` on whichever side needs it; un-nesting is not.
 *
 * ⚠️ `LEFT JOIN depths`, NOT `JOIN`. `depths` is seeded from `parent_id IS NULL`
 *   and walks down, so a category is only in it if its WHOLE ancestor chain is
 *   visible in this transaction. An inner join therefore did not merely lose a
 *   depth number — it DROPPED THE ROW.
 *
 *   That is reachable, and it loses a tenant's OWN data. `product_categories`
 *   has no `parent_visible` policy and cannot have one (a policy may not read
 *   its own table — see migration `20260814093000`), so a clinic can parent its
 *   own category under another tenant's private one. The parent is invisible
 *   under RLS, the walk never reaches the child, and the clinic's own category
 *   vanished from its own list with no error anywhere.
 *
 *   Left-joined, `coalesce(d.depth, 0)` does the job it was always written for
 *   and such a category surfaces at the root instead of disappearing. Visible
 *   and slightly misplaced beats absent and unexplained.
 */
export async function listCategories(
  ctx: TenantContext,
  includeInactive: boolean
): Promise<ProductCategory[]> {
  const rows = await withTenant(
    ctx,
    (tx) =>
      tx.$queryRaw<CategoryRow[]>`
      WITH RECURSIVE depths AS (
        SELECT c.id, c.parent_id, 0 AS depth
        FROM product_categories c
        WHERE c.parent_id IS NULL AND c.deleted_at IS NULL
        UNION ALL
        SELECT ch.id, ch.parent_id, d.depth + 1
        FROM product_categories ch
        JOIN depths d ON ch.parent_id = d.id
        WHERE ch.deleted_at IS NULL
      )
      SELECT c.id, c.code, c.name, c.parent_id, c.description,
             c.display_order, c.is_active, c.organization_id,
             coalesce(d.depth, 0) AS depth,
             EXISTS (SELECT 1 FROM product_categories ch
                     WHERE ch.parent_id = c.id AND ch.deleted_at IS NULL) AS has_children
      FROM product_categories c
      LEFT JOIN depths d ON d.id = c.id
      WHERE c.deleted_at IS NULL
        AND (${includeInactive}::boolean OR c.is_active)
      ORDER BY coalesce(d.depth, 0), c.display_order, c.name
    `
  );
  return rows.map(toCategory);
}

/**
 * The ids of a category and everything under it.
 *
 * ⚠️ WHAT MAKES A CATEGORY FILTER MEAN WHAT A USER EXPECTS. Filtering products
 *   by "Antibiotics" must return the ones filed under Penicillins too — a clinic
 *   that files precisely would otherwise get an empty list from the category it
 *   just clicked. `includeSelf` is true for the same reason.
 */
export async function categorySubtreeIds(tx: TxClient, id: string): Promise<string[]> {
  const rows = await descendantRows(tx, id, true, true);
  return rows.map((r) => r.id);
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

export async function createCategory(
  ctx: TenantContext,
  input: CreateProductCategoryRequest,
  options: CatalogueActionOptions = {}
): Promise<ProductCategory> {
  return withTenant(ctx, async (tx) => {
    if (input.parentId) {
      const parent = await loadCategory(tx, input.parentId);
      if (!parent.is_active) {
        throw new ValidationError('Cannot add a category under an inactive parent.');
      }
    }

    const clash = await tx.productCategory.findFirst({
      where: { organizationId: ctx.organizationId, code: input.code, deletedAt: null },
      select: { id: true },
    });
    if (clash) throw new ConflictError('A category with this code already exists.');

    const created = await tx.productCategory.create({
      data: {
        organizationId: ctx.organizationId,
        code: input.code,
        name: input.name,
        parentId: input.parentId ?? null,
        description: input.description ?? null,
        displayOrder: input.displayOrder,
      },
      select: { id: true },
    });

    await recordAudit(tx, ctx, {
      action: 'CREATE',
      entityType: 'product_category',
      entityId: created.id,
      after: { code: input.code, name: input.name, parentId: input.parentId ?? null },
      ...options,
    });

    return toCategory(await loadCategory(tx, created.id));
  });
}

export async function updateCategory(
  ctx: TenantContext,
  id: string,
  input: UpdateProductCategoryRequest,
  options: CatalogueActionOptions = {}
): Promise<ProductCategory> {
  return withTenant(ctx, async (tx) => {
    const existing = await loadCategory(tx, id);
    assertMutable(existing);

    if (input.parentId !== undefined && input.parentId !== null) {
      if (input.parentId === id) {
        throw new ValidationError('A category cannot be its own parent.');
      }
      const parent = await loadCategory(tx, input.parentId);
      if (!parent.is_active) {
        throw new ValidationError('Cannot move a category under an inactive parent.');
      }
      /*
       * Reject a move into this node's own subtree BEFORE attempting it. The
       * `product_categories_no_cycle` trigger would refuse it anyway, as a raw
       * Postgres exception with no field attached; this turns that into a
       * message naming what the user just did.
       */
      const subtree = await descendantRows(tx, id, true, false);
      if (subtree.some((n) => n.id === input.parentId)) {
        throw new ValidationError('Cannot move a category underneath one of its own descendants.');
      }
    }

    if (input.isActive === false && existing.is_active) {
      await assertSafeToDeactivate(tx, id);
    }

    await tx.productCategory.update({
      where: { id },
      data: {
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.parentId !== undefined ? { parentId: input.parentId } : {}),
        ...(input.description !== undefined ? { description: input.description } : {}),
        ...(input.displayOrder !== undefined ? { displayOrder: input.displayOrder } : {}),
        ...(input.isActive !== undefined ? { isActive: input.isActive } : {}),
      },
      select: { id: true },
    });

    const after = await loadCategory(tx, id);

    await recordAudit(tx, ctx, {
      action: 'UPDATE',
      entityType: 'product_category',
      entityId: id,
      before: { name: existing.name, parentId: existing.parent_id, isActive: existing.is_active },
      after: { name: after.name, parentId: after.parent_id, isActive: after.is_active },
      ...options,
    });

    return toCategory(after);
  });
}

/**
 * Deactivate. NOT a hard delete — the route says DELETE only because that is the
 * verb the client has.
 *
 * `products.category_id` references this with `onDelete: Restrict`, so removing
 * the row would break the record of how a product was filed. `is_active = false`
 * takes it out of every picker while existing products keep resolving.
 */
export async function deactivateCategory(
  ctx: TenantContext,
  id: string,
  options: CatalogueActionOptions = {}
): Promise<void> {
  await withTenant(ctx, async (tx) => {
    const existing = await loadCategory(tx, id);
    assertMutable(existing);
    await assertSafeToDeactivate(tx, id);

    await tx.productCategory.update({ where: { id }, data: { isActive: false } });

    await recordAudit(tx, ctx, {
      action: 'DELETE',
      entityType: 'product_category',
      entityId: id,
      before: { code: existing.code, name: existing.name },
      ...options,
    });
  });
}

/**
 * The two things that make deactivating a category destructive.
 *
 * Both refuse rather than cascade. Cascading would hide a whole subtree, or
 * detach products from how they were filed, from one click — and neither is
 * recoverable by pressing undo.
 */
async function assertSafeToDeactivate(tx: TxClient, id: string): Promise<void> {
  const activeChildren = await tx.productCategory.count({
    where: { parentId: id, isActive: true, deletedAt: null },
  });
  if (activeChildren > 0) {
    throw new ConflictError(
      `This category has ${activeChildren} active sub-categor(y/ies). Deactivate or move them first.`
    );
  }

  const filed = await tx.product.count({ where: { categoryId: id, deletedAt: null } });
  if (filed > 0) {
    throw new ConflictError(`${filed} product(s) are filed under this category. Move them first.`);
  }
}
