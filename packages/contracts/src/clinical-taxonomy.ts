/**
 * The clinical taxonomy: what a practitioner is TRAINED IN.
 *
 * Backed by `specialties`, which is a self-referencing tree — `parentId` is the
 * hierarchy and the ONLY thing that is. `type` is a label for rendering and
 * reporting; nothing derives depth from it, and nothing may branch authorization
 * on it. One doctor's branch may be four levels deep and another's two.
 *
 * ⚠️ THREE NEIGHBOURING CONCEPTS LIVE ELSEWHERE, DELIBERATELY.
 *   · where someone works  → `branches`, `staffProfile.department`
 *   · what they perform    → procedures/services, which point AT a node here
 *   · what they hold       → `qualifications`, `registrationNumber`
 *   "Angioplasty" is a procedure and "Fellowship in Cardiology" is a credential.
 *   Neither is a taxonomy node, however tempting the autocomplete.
 */
import { z } from 'zod';
import { uuid } from './common.js';

export const taxonomyNodeType = z.enum([
  /**
   * The true root — Human, Veterinary (CE-1).
   *
   * ⚠️ FIRST IN THE LIST BECAUSE THE LIST IS READ TOP-DOWN BY THE CASCADING
   *   SELECTOR, not because anything depends on the order. The tree's shape is
   *   `parentId` and only `parentId`; this enum labels a node, it does not place
   *   one. Never assigned to a doctor — a clinician practises a specialty, not a
   *   kingdom of patient.
   */
  'CARE_CONTEXT',
  'DOMAIN',
  'DEPARTMENT',
  'SPECIALTY',
  'SUB_SPECIALTY',
  'FOCUS_AREA',
  'EXPERTISE',
]);

export const specialtyProficiency = z.enum(['PRACTISING', 'SPECIALIST', 'EXPERT']);

/**
 * Stable machine-readable identifier. Flat, never a path.
 *
 * ⚠️ `MED-CARD-INTERVENTIONAL` IS NOT A CODE, IT IS A PATH THAT WILL GO STALE.
 *   Re-parenting a node would force a code change; the code is what the seed
 *   upserts on and what `doctor_specialties` was written against, so the rename
 *   silently forks one node into two. The path is `parentId`. This regex
 *   (unchanged from `createSpecialtyRequest`) rejects the hyphen for that reason.
 */
const taxonomyCode = z
  .string()
  .min(2)
  .max(64)
  .regex(/^[A-Z0-9_]+$/, 'uppercase letters, digits and underscores only');

// ---------------------------------------------------------------------------
// Requests
// ---------------------------------------------------------------------------

export const createTaxonomyNodeRequest = z.object({
  code: taxonomyCode,
  name: z.string().min(2).max(255),
  /** Omitted or null creates a root. */
  parentId: uuid.nullish(),
  type: taxonomyNodeType.default('SPECIALTY'),
  description: z.string().max(2000).nullish(),
  displayOrder: z.number().int().min(0).max(100_000).default(0),
});

/**
 * Every field optional — PATCH semantics.
 *
 * `code` is absent on purpose and that is not an oversight: it is the stable
 * identity the seed and every existing assignment key on. A clinic that needs a
 * different code needs a different node.
 */
export const updateTaxonomyNodeRequest = z
  .object({
    name: z.string().min(2).max(255),
    parentId: uuid.nullable(),
    type: taxonomyNodeType,
    description: z.string().max(2000).nullable(),
    displayOrder: z.number().int().min(0).max(100_000),
    isActive: z.boolean(),
  })
  .partial()
  .refine((v) => Object.keys(v).length > 0, 'at least one field must be supplied');

export const taxonomySearchQuery = z.object({
  q: z.string().trim().min(2).max(64),
  /** Restrict to one subtree — the id of the ancestor to search beneath. */
  underId: uuid.optional(),
  type: taxonomyNodeType.optional(),
  includeInactive: z.stringbool().default(false),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});

export const taxonomyTreeQuery = z.object({
  includeInactive: z.stringbool().default(false),
});

// ---------------------------------------------------------------------------
// Responses
// ---------------------------------------------------------------------------

export const taxonomyNode = z.object({
  id: uuid,
  code: z.string(),
  name: z.string(),
  parentId: uuid.nullable(),
  type: taxonomyNodeType,
  description: z.string().nullable(),
  displayOrder: z.number().int(),
  isActive: z.boolean(),
  /** False for a platform row, true for one this clinic added. Drives editability. */
  isOwn: z.boolean(),
  /** Distance from the root of the tenant-visible tree. 0 for a domain. */
  depth: z.number().int(),
  /** Whether this node has any child at all — lets a selector render a chevron
   *  without a second round trip. */
  hasChildren: z.boolean(),
});

/**
 * A node plus the chain above it, root first.
 *
 * `ancestors[0]` is the domain and the last element is the node's own parent;
 * the node itself is NOT in the list. Rendering a breadcrumb is
 * `[...ancestors, node]`.
 */
export const taxonomyNodeWithAncestors = z.object({
  node: taxonomyNode,
  ancestors: z.array(taxonomyNode),
});

/** One node with its descendants inlined. Recursive, so the depth is the data's. */
export type TaxonomyTreeNode = z.infer<typeof taxonomyNode> & {
  children: TaxonomyTreeNode[];
};

export const taxonomyTreeNode: z.ZodType<TaxonomyTreeNode> = taxonomyNode.extend({
  children: z.lazy(() => z.array(taxonomyTreeNode)),
});

export const taxonomyNodeListResponse = z.object({ nodes: z.array(taxonomyNode) });
export const taxonomyTreeResponse = z.object({ nodes: z.array(taxonomyTreeNode) });

export type TaxonomyNodeType = z.infer<typeof taxonomyNodeType>;
export type SpecialtyProficiency = z.infer<typeof specialtyProficiency>;
export type TaxonomyNode = z.infer<typeof taxonomyNode>;
export type TaxonomyNodeWithAncestors = z.infer<typeof taxonomyNodeWithAncestors>;
export type TaxonomyNodeListResponse = z.infer<typeof taxonomyNodeListResponse>;
export type TaxonomyTreeResponse = z.infer<typeof taxonomyTreeResponse>;
export type CreateTaxonomyNodeRequest = z.infer<typeof createTaxonomyNodeRequest>;
export type UpdateTaxonomyNodeRequest = z.infer<typeof updateTaxonomyNodeRequest>;
export type TaxonomySearchQuery = z.infer<typeof taxonomySearchQuery>;
export type TaxonomyTreeQuery = z.infer<typeof taxonomyTreeQuery>;
