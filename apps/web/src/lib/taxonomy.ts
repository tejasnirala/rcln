import type { SpecialtySummary, TaxonomyNodeType } from '@rcln/contracts';

/**
 * Client-side shape of the clinical taxonomy.
 *
 * ⚠️ NO FETCHING HAPPENS HERE, AND THAT IS THE POINT.
 *   `/api/v1/doctors/masters` already returns every node this clinic can see —
 *   flat, but carrying `parentId`, `type` and `displayOrder` — and the doctors
 *   page already awaits it alongside its other calls. The whole tree is
 *   therefore on the page before the user clicks anything.
 *
 *   The obvious alternative is the one the API was also built for: call
 *   `/clinical-taxonomy` for the roots, then `/:id/children` on each drill-down.
 *   That is the right shape for a large or lazily-loaded tree. Here it would add
 *   a round trip per column to re-fetch data already in memory — a loading
 *   spinner between "Medical" and "Cardiology" for a payload of ~150 rows.
 *
 *   Revisit if the catalogue grows past a few thousand nodes, at which point the
 *   children endpoints are already there and only this module changes.
 */

export interface TaxonomyTree {
  byId: Map<string, SpecialtySummary>;
  /** Children of a node id, pre-sorted. Roots are under the `ROOTS` key. */
  childrenOf: Map<string, SpecialtySummary[]>;
}

/**
 * Bucket key for top-level nodes, which have `parentId === null`.
 *
 * Deliberately not a bare word: this map is keyed by node id everywhere else, so
 * the sentinel has to be a string no uuid can ever equal. The underscores make
 * that intent visible at the call site rather than resting on the reader knowing
 * uuids are 36 characters.
 */
export const ROOTS = '__roots__';

const byOrderThenName = (a: SpecialtySummary, b: SpecialtySummary): number =>
  a.displayOrder - b.displayOrder || a.name.localeCompare(b.name);

export function buildTree(nodes: SpecialtySummary[]): TaxonomyTree {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const childrenOf = new Map<string, SpecialtySummary[]>();

  for (const node of nodes) {
    /*
     * A node whose parent is not in this list is treated as a root.
     *
     * That is not defensive noise: the catalogue is filtered by RLS, and a
     * tenant's private node can hang off a parent it can see — but the reverse
     * could arise from a future filter. Dropping such a node would make it
     * unreachable in the picker while still being assignable through the API,
     * which is worse than showing it at the top level.
     */
    const key = node.parentId !== null && byId.has(node.parentId) ? node.parentId : ROOTS;
    const bucket = childrenOf.get(key);
    if (bucket) bucket.push(node);
    else childrenOf.set(key, [node]);
  }

  for (const bucket of childrenOf.values()) bucket.sort(byOrderThenName);

  return { byId, childrenOf };
}

/**
 * The chain from the root down to and including `id`.
 *
 * Returns `[]` for an unknown id rather than throwing — a doctor may hold a
 * classification whose node has since been retired out of the catalogue, and a
 * profile that crashes rather than rendering is not an improvement.
 *
 * The hop guard mirrors the database trigger: the tree is acyclic because
 * `specialties_no_cycle` enforces it, but a render loop is a frozen tab.
 */
export function pathTo(tree: TaxonomyTree, id: string): SpecialtySummary[] {
  const chain: SpecialtySummary[] = [];
  let cursor = tree.byId.get(id);

  while (cursor && chain.length < 64) {
    chain.unshift(cursor);
    cursor = cursor.parentId === null ? undefined : tree.byId.get(cursor.parentId);
  }
  return chain;
}

/** `Medical › Cardiology › Interventional Cardiology`, excluding the node itself. */
export function ancestorLabel(tree: TaxonomyTree, id: string): string {
  return pathTo(tree, id)
    .slice(0, -1)
    .map((n) => n.name)
    .join(' › ');
}

export function childrenOf(tree: TaxonomyTree, id: string | null): SpecialtySummary[] {
  return tree.childrenOf.get(id ?? ROOTS) ?? [];
}

/**
 * What to call the column a set of nodes sits in.
 *
 * ⚠️ DERIVED FROM THE DATA, NEVER HARDCODED. The levels are not fixed: Dental
 *   goes domain → specialty in two hops while Cardiology takes four, so a column
 *   headed "Sub-specialty" because it is the third one would be lying about half
 *   the tree. The nodes in the column say what they are.
 */
const TYPE_LABELS: Record<TaxonomyNodeType, string> = {
  DOMAIN: 'Clinical area',
  DEPARTMENT: 'Department',
  SPECIALTY: 'Specialty',
  SUB_SPECIALTY: 'Sub-specialty',
  FOCUS_AREA: 'Focus area',
  EXPERTISE: 'Area of expertise',
};

export function columnLabel(nodes: SpecialtySummary[]): string {
  if (nodes.length === 0) return 'Specialty';

  const types = new Set(nodes.map((n) => n.type));
  const [only] = [...types];
  // Mixed column — "Cardiology" (DEPARTMENT) sits beside "Nephrology"
  // (SPECIALTY) under Medical. A neutral heading beats picking a winner.
  return types.size === 1 && only ? TYPE_LABELS[only] : 'Specialty';
}

/**
 * Nodes whose name or code contains `term`, best match first.
 *
 * Mirrors the ordering of `GET /clinical-taxonomy/search` so the two never
 * disagree about which hit is most relevant: a name that STARTS with the term
 * outranks one that merely contains it, then shorter names, then alphabetical.
 */
export function searchNodes(tree: TaxonomyTree, term: string, limit = 30): SpecialtySummary[] {
  const q = term.trim().toLowerCase();
  if (q.length < 2) return [];

  return [...tree.byId.values()]
    .filter((n) => n.name.toLowerCase().includes(q) || n.code.toLowerCase().includes(q))
    .sort((a, b) => {
      const aPrefix = a.name.toLowerCase().startsWith(q) ? 0 : 1;
      const bPrefix = b.name.toLowerCase().startsWith(q) ? 0 : 1;
      return aPrefix - bPrefix || a.name.length - b.name.length || a.name.localeCompare(b.name);
    })
    .slice(0, limit);
}

/** Every id at or beneath `id`. Used to filter the roster by a subtree. */
export function subtreeIds(tree: TaxonomyTree, id: string): Set<string> {
  const out = new Set<string>([id]);
  const queue = [id];

  while (queue.length > 0) {
    const next = queue.pop() as string;
    for (const child of childrenOf(tree, next)) {
      if (out.has(child.id)) continue;
      out.add(child.id);
      queue.push(child.id);
    }
  }
  return out;
}
