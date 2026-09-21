/**
 * The clinical taxonomy — the classification tree a doctor's specialty points at.
 *
 * Seven levels from `CARE_CONTEXT` down to `EXPERTISE`, of which most clinics
 * only ever see `DEPARTMENT` → `SPECIALTY` → `SUB_SPECIALTY`.
 *
 * ⚠️ READS ARE BEHIND `doctor.read`, NOT THE MANAGE CODE. Every screen that
 *   renders a doctor needs their specialty NAME, and gating the catalogue behind
 *   the permission to EDIT it would show a receptionist blanks where the
 *   specialties should be.
 *
 * ⚠️ THE TREE IS TWO TREES SHARING ONE SHAPE. rcln ships the platform rows and
 *   every clinic sees them; a clinic may graft its own nodes on. `isOwn` says
 *   which is which, and the write routes cannot touch a platform row — enforced
 *   twice, by `assertMutable` for a legible `400` and by an RLS `WITH CHECK`
 *   that a platform row can never satisfy.
 *
 * No PHI here. A classification is not a patient.
 */
import {
  taxonomyNode,
  taxonomyNodeListResponse,
  taxonomyNodeWithAncestors,
  taxonomyTreeResponse,
} from '@rcln/contracts';
import type { DocRegistry } from '../types.js';
import {
  SPECIALTY_CARDIOLOGY_ID,
  SPECIALTY_GENERAL_MEDICINE_ID,
  SPECIALTY_INTERVENTIONAL_ID,
  SPECIALTY_MEDICINE_ID,
} from './fixtures.js';

const NODE_NOTE =
  'The node, as any of the browse endpoints returns it. A node belonging to another clinic is answered `404`; a platform node is visible to everybody.';

const MEDICINE = {
  id: SPECIALTY_MEDICINE_ID,
  code: 'MEDICINE',
  name: 'Medicine',
  parentId: null,
  type: 'DEPARTMENT',
  description: 'Non-surgical adult care.',
  displayOrder: 1,
  isActive: true,
  isOwn: false,
  depth: 0,
  hasChildren: true,
};

const GENERAL_MEDICINE = {
  id: SPECIALTY_GENERAL_MEDICINE_ID,
  code: 'GENERAL_MEDICINE',
  name: 'General Medicine',
  parentId: SPECIALTY_MEDICINE_ID,
  type: 'SPECIALTY',
  description: null,
  displayOrder: 1,
  isActive: true,
  isOwn: false,
  depth: 1,
  hasChildren: false,
};

const CARDIOLOGY = {
  id: SPECIALTY_CARDIOLOGY_ID,
  code: 'CARDIOLOGY',
  name: 'Cardiology',
  parentId: SPECIALTY_MEDICINE_ID,
  type: 'SPECIALTY',
  description: null,
  displayOrder: 2,
  isActive: true,
  isOwn: false,
  depth: 1,
  hasChildren: true,
};

export const clinicalTaxonomyDocs: DocRegistry = {
  'GET /api/v1/clinical-taxonomy/search': {
    summary: 'Search the classification tree',
    description: `
Find a node by name or code, anywhere in the tree, without walking it.

This is what a specialty picker calls as somebody types. \`q\` needs two
characters. \`underId\` confines the search to one subtree — "cardiology
sub-specialties only" — and \`type\` to one level.

Matches are returned flat with their \`depth\`, not nested: a search result is a
list of destinations, and the path to each is
\`GET /clinical-taxonomy/{nodeId}/ancestors\` when it is needed.

Inactive nodes are excluded unless \`includeInactive=true\`, so a picker does not
offer a classification the clinic has retired.
`.trim(),
    response: taxonomyNodeListResponse,
    params: {
      q: 'What to search for, minimum two characters. Matches name and code.',
      underId: 'Confine the search to the subtree beneath this node.',
      type: 'Confine the search to one level of the tree, e.g. `SUB_SPECIALTY`.',
      includeInactive: 'Include retired nodes. Defaults to `false`.',
      limit: 'Maximum matches to return. Defaults to 25.',
    },
    responseExamples: [
      {
        summary: 'Searching for "card"',
        value: { success: true, message: 'Success', data: { nodes: [CARDIOLOGY] } },
      },
    ],
  },

  'GET /api/v1/clinical-taxonomy': {
    summary: 'List the top of the tree',
    description:
      'The root nodes — the departments and care contexts everything else hangs beneath. One level only; descend with `/{nodeId}/children` or take a whole branch at once with `/{nodeId}/tree`. `hasChildren` says whether descending is worthwhile, so a lazy tree control does not have to fetch to find out.',
    response: taxonomyNodeListResponse,
    params: { includeInactive: 'Include retired nodes. Defaults to `false`.' },
    responseExamples: [
      {
        summary: 'One department at the root',
        value: { success: true, message: 'Success', data: { nodes: [MEDICINE] } },
      },
    ],
  },

  'GET /api/v1/clinical-taxonomy/{nodeId}/children': {
    summary: "List a node's children",
    description:
      'One level down from the named node — what a tree control fetches when somebody expands a row. Immediate children only, never grandchildren.',
    response: taxonomyNodeListResponse,
    params: { nodeId: NODE_NOTE, includeInactive: 'Include retired nodes. Defaults to `false`.' },
    responseExamples: [
      {
        summary: 'Under Medicine',
        value: {
          success: true,
          message: 'Success',
          data: { nodes: [GENERAL_MEDICINE, CARDIOLOGY] },
        },
      },
    ],
  },

  'GET /api/v1/clinical-taxonomy/{nodeId}/tree': {
    summary: 'Get a whole subtree',
    description: `
The named node and everything beneath it, nested, in one call.

Use it when the whole branch is going to be rendered anyway — it saves the
round-trip-per-level that \`/children\` costs. Use \`/children\` instead when the
tree is browsed lazily and most branches are never opened.

Nodes carry their \`children\` array recursively; a leaf has an empty one.
`.trim(),
    response: taxonomyTreeResponse,
    params: { nodeId: NODE_NOTE, includeInactive: 'Include retired nodes. Defaults to `false`.' },
    responseExamples: [
      {
        summary: 'Medicine and everything under it',
        value: {
          success: true,
          message: 'Success',
          data: {
            nodes: [
              {
                ...MEDICINE,
                children: [
                  { ...GENERAL_MEDICINE, children: [] },
                  { ...CARDIOLOGY, children: [] },
                ],
              },
            ],
          },
        },
      },
    ],
  },

  'GET /api/v1/clinical-taxonomy/{nodeId}/ancestors': {
    summary: 'Get the path to a node',
    description:
      'The node, plus every ancestor from the root down to its parent — the breadcrumb. This is what turns a search result into something a reader can place: "Cardiology" alone is ambiguous, "Medicine → Cardiology" is not. `ancestors` is ordered root-first and is empty for a root node.',
    response: taxonomyNodeWithAncestors,
    params: { nodeId: NODE_NOTE },
    responseExamples: [
      {
        summary: 'The path to General Medicine',
        value: {
          success: true,
          message: 'Success',
          data: { node: GENERAL_MEDICINE, ancestors: [MEDICINE] },
        },
      },
    ],
  },

  'POST /api/v1/clinical-taxonomy': {
    summary: 'Add a classification',
    description: `
Graft a node of this clinic's own onto the tree.

⚠️ **It may hang beneath a platform node, which is the point.** A clinic adding
"Interventional Cardiology" under the shipped *Cardiology* is the normal case —
the parent stays platform-owned and untouched, and only the new node is the
clinic's.

\`code\` is UPPER_SNAKE_CASE and unique within this clinic; it may reuse a code
another clinic has. \`parentId\` omitted or \`null\` creates a root.
\`displayOrder\` decides the order among siblings.

Behind \`doctor.master.manage\` — curating the catalogue, not reading it.
`.trim(),
    response: taxonomyNode,
    status: 201,
    message: 'Classification added',
    errors: [409],
    requestExamples: [
      {
        summary: 'A sub-specialty under a shipped node',
        value: {
          code: 'INTERVENTIONAL_CARDIOLOGY',
          name: 'Interventional Cardiology',
          parentId: SPECIALTY_CARDIOLOGY_ID,
          type: 'SUB_SPECIALTY',
          displayOrder: 1,
        },
      },
      {
        summary: 'A new department at the root',
        value: { code: 'AYURVEDA', name: 'Ayurveda', type: 'DEPARTMENT' },
      },
    ],
    responseExamples: [
      {
        summary: 'Added',
        value: {
          success: true,
          message: 'Classification added',
          data: {
            id: SPECIALTY_INTERVENTIONAL_ID,
            code: 'INTERVENTIONAL_CARDIOLOGY',
            name: 'Interventional Cardiology',
            parentId: SPECIALTY_CARDIOLOGY_ID,
            type: 'SUB_SPECIALTY',
            description: null,
            displayOrder: 1,
            isActive: true,
            isOwn: true,
            depth: 2,
            hasChildren: false,
          },
        },
      },
    ],
  },

  'PATCH /api/v1/clinical-taxonomy/{nodeId}': {
    summary: 'Update a classification',
    description: `
Rename, re-describe, reorder or re-parent one of this clinic's own nodes.

⚠️ **A platform node cannot be edited, and the refusal is enforced twice.** The
service answers \`400\` with an explanation, and behind it the RLS \`WITH CHECK\`
on \`specialties\` requires \`organization_id = app_current_org()\` — which a
platform row can never satisfy, so Postgres refuses the write regardless. The
permissive \`USING\` clause that lets you *read* the row does not let you write
it, which is the intuitive-but-wrong reading.

Re-parenting via \`parentId\` moves the whole subtree with it. A cycle is
rejected.

At least one field must be supplied.
`.trim(),
    response: taxonomyNode,
    message: 'Classification updated',
    errors: [409],
    params: { nodeId: NODE_NOTE },
    requestExamples: [
      { summary: 'Rename', value: { name: 'Interventional Cardiology (Cath Lab)' } },
      { summary: 'Reorder among siblings', value: { displayOrder: 3 } },
      { summary: 'Retire it', value: { isActive: false } },
    ],
    responseExamples: [
      {
        summary: 'Updated',
        value: {
          success: true,
          message: 'Classification updated',
          data: { ...CARDIOLOGY, name: 'Cardiology (Cath Lab)', isOwn: true },
        },
      },
    ],
  },

  'DELETE /api/v1/clinical-taxonomy/{nodeId}': {
    summary: 'Deactivate a classification',
    description: `
Retire one of this clinic's own nodes.

⚠️ **A deactivation, not a delete** — the endpoint is \`DELETE\` but the row
survives. Doctors are classified against it, and a specialty that vanished would
take their classification with it. The node stops being offered in pickers and
keeps every profile that already points at it.

Its descendants go with it: retiring a department retires everything beneath.

A platform node is refused, for the reasons on \`PATCH\`. Answers \`null\` data.
`.trim(),
    message: 'Classification deactivated',
    errors: [409],
    params: { nodeId: NODE_NOTE },
    responseExamples: [
      {
        summary: 'Deactivated',
        value: { success: true, message: 'Classification deactivated', data: null },
      },
    ],
  },
};
