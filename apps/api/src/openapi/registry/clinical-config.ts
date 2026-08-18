/**
 * Clinical configuration — what a consultation form LOOKS like, and the charts
 * it draws on.
 *
 * ⚠️ ONE CODE GATES BOTH DIRECTIONS HERE, WHICH IS THE OPPOSITE OF WHAT
 *   `/clinical-data` DOES — and the difference is who needs the answer. Every
 *   screen that renders a diagnosis needs the VOCABULARY, so gating the
 *   dictionary behind the permission to edit it would show a receptionist uuids
 *   where the words should be. Nobody needs the TEMPLATE LIST except the person
 *   configuring it: a doctor reads the RESOLVED configuration from
 *   `GET /api/v1/appointments/{appointmentId}/consultation-config`, behind
 *   `clinical.encounter.read`, which they already hold.
 *
 * ⚠️ CONFIGURING A CONSULTATION IS NOT CONDUCTING ONE, AND DRAWING ON A CHART IS
 *   NOT CONFIGURING ONE. These codes are deliberately outside the clinical
 *   authoring set: a DOCTOR holds neither, because changing what every
 *   colleague's consultation looks like is not an act of practising.
 *
 * NO PHI ANYWHERE ON THIS SURFACE. A template names no patient and the 32 teeth
 * of the FDI notation are the same 32 teeth everywhere — so nothing here is
 * read-audited and every id is safe in a URL.
 */
import {
  consultationTemplate,
  consultationTemplateDetail,
  consultationTemplateListResponse,
  consultationTemplateVersionSummary,
  visualMap,
  visualMapDetail,
  visualMapListResponse,
  visualRegion,
} from '@rcln/contracts';
import type { DocRegistry } from '../types.js';
import {
  CARE_CONTEXT_ID,
  SPECIALTY_GENERAL_MEDICINE_ID,
  TEMPLATE_DRAFT_VERSION_ID,
  TEMPLATE_ID,
  TEMPLATE_VERSION_ID,
  VISUAL_MAP_ID,
  VISUAL_REGION_ID,
} from './fixtures.js';

const TEMPLATE_NOTE = 'The template, as `GET /api/v1/consultation-templates` lists it.';
const VERSION_NOTE = "The version, from the template's `versions[]`.";
const MAP_NOTE = 'The chart, as `GET /api/v1/visual-maps` lists it.';

const PUBLISHED_VERSION = {
  id: TEMPLATE_VERSION_ID,
  version: 3,
  status: 'PUBLISHED',
  publishedAt: '2026-01-12T06:00:00.000Z',
  retiredAt: null,
  sectionCount: 6,
  visibleSectionCount: 5,
};

const DRAFT_VERSION = {
  id: TEMPLATE_DRAFT_VERSION_ID,
  version: 4,
  status: 'DRAFT',
  publishedAt: null,
  retiredAt: null,
  sectionCount: 6,
  visibleSectionCount: 6,
};

const TEMPLATE_EXAMPLE = {
  id: TEMPLATE_ID,
  code: 'GEN_MED_OPD',
  name: 'General Medicine — OPD',
  description: 'The standard outpatient consultation form.',
  careContextId: CARE_CONTEXT_ID,
  careContextName: 'Outpatient',
  specialtyId: SPECIALTY_GENERAL_MEDICINE_ID,
  specialtyName: 'General Medicine',
  isActive: true,
  isOwn: true,
  publishedVersion: PUBLISHED_VERSION,
  draftVersion: null,
};

const REGION = {
  id: VISUAL_REGION_ID,
  code: 'FDI_11',
  label: 'Upper right central incisor',
  parentId: null,
  displayOrder: 1,
  metadata: { quadrant: 1, toothNumber: 1 },
};

const MAP_EXAMPLE = {
  id: VISUAL_MAP_ID,
  code: 'DENTAL_FDI_ADULT',
  name: 'Adult dentition (FDI)',
  description: 'The 32 permanent teeth in FDI two-digit notation.',
  renderer: 'SVG',
  assetKey: 'charts/dental-fdi-adult.svg',
  careContextId: CARE_CONTEXT_ID,
  careContextName: 'Outpatient',
  specialtyId: null,
  specialtyName: null,
  viewBox: '0 0 640 320',
  isActive: true,
  isOwn: false,
  regionCount: 32,
};

export const clinicalConfigDocs: DocRegistry = {
  'GET /api/v1/consultation-templates': {
    summary: 'List consultation templates',
    description: `
The consultation forms available here, each with the version that is live and the
draft in progress.

\`publishedVersion\` is what consultations are actually conducted on;
\`draftVersion\` is null unless somebody is editing. Both being present is the
normal state of a template being revised — the live one keeps serving while the
draft is worked on.

\`visibleSectionCount\` is how many of the sections a doctor actually sees, which
is not \`sectionCount\`: a section can be configured but hidden.
`.trim(),
    response: consultationTemplateListResponse,
    paginated: true,
    params: {
      careContextId: 'Narrow to one care context, e.g. outpatient.',
      includeInactive: 'Include retired templates. Defaults to `false`.',
      page: 'Page number, from 1.',
      pageSize: 'Rows per page, up to 100.',
    },
    responseExamples: [
      {
        summary: 'One template with a live version',
        value: {
          success: true,
          message: 'Success',
          data: { templates: [TEMPLATE_EXAMPLE], total: 1, page: 1, pageSize: 25 },
        },
      },
    ],
  },

  'POST /api/v1/consultation-templates': {
    summary: 'Create a consultation template',
    description: `
Define a new consultation form.

**Created with no version at all** — the template is the identity, and what it
looks like is a version. Start the first draft with
\`POST /{templateId}/versions\`, save a definition into it, then publish.

\`careContextId\` is required and decides where the form applies;
\`specialtyId\` narrows it further, and omitted means every specialty in that
context. \`code\` is upper-case and unique within this clinic.
`.trim(),
    response: consultationTemplate,
    status: 201,
    errors: [409],
    requestExamples: [
      {
        summary: 'An outpatient form for General Medicine',
        value: {
          code: 'GEN_MED_OPD',
          name: 'General Medicine — OPD',
          description: 'The standard outpatient consultation form.',
          careContextId: CARE_CONTEXT_ID,
          specialtyId: SPECIALTY_GENERAL_MEDICINE_ID,
        },
      },
    ],
    responseExamples: [
      {
        summary: 'Created',
        value: {
          success: true,
          message: 'Success',
          data: { ...TEMPLATE_EXAMPLE, publishedVersion: null },
        },
      },
    ],
  },

  'GET /api/v1/consultation-templates/{templateId}': {
    summary: 'Get a consultation template',
    description:
      'One template with every version it has ever had and the definition document of the current one. `definition` is the JSONB describing sections and fields — a document, deliberately, and never a set of foreign keys.',
    response: consultationTemplateDetail,
    params: { templateId: TEMPLATE_NOTE },
    responseExamples: [
      {
        summary: 'A template mid-revision',
        value: {
          success: true,
          message: 'Success',
          data: {
            ...TEMPLATE_EXAMPLE,
            draftVersion: DRAFT_VERSION,
            versions: [DRAFT_VERSION, PUBLISHED_VERSION],
            definition: { sections: [] },
          },
        },
      },
    ],
  },

  'PATCH /api/v1/consultation-templates/{templateId}': {
    summary: 'Update a consultation template',
    description: `
Rename a template, re-describe it, or retire it.

**This edits the template's identity, never its content.** What the form looks
like lives in versions, and changing that means publishing a new one.

\`code\`, \`careContextId\` and \`specialtyId\` are not editable — a form that
applies somewhere else is a different form, and consultations already cite this
one.
`.trim(),
    response: consultationTemplate,
    errors: [409],
    params: { templateId: TEMPLATE_NOTE },
    requestExamples: [
      { summary: 'Rename', value: { name: 'General Medicine — Outpatient' } },
      { summary: 'Retire it', value: { isActive: false } },
    ],
    responseExamples: [
      {
        summary: 'Updated',
        value: {
          success: true,
          message: 'Success',
          data: { ...TEMPLATE_EXAMPLE, name: 'General Medicine — Outpatient' },
        },
      },
    ],
  },

  'POST /api/v1/consultation-templates/{templateId}/versions': {
    summary: 'Start a new draft',
    description: `
Begin a revision, copied from the published version.

⚠️ **A \`POST\` with no body, because editing a live template IS publishing a new
version.** There is no endpoint that edits a published document and there never
will be: a finalized consultation's snapshot is a statement about the
configuration that existed when it was made, and rewriting that would silently
change what signed records mean.

A template that already has a draft is \`409\` — one revision at a time.
`.trim(),
    response: consultationTemplateVersionSummary,
    status: 201,
    errors: [409],
    params: { templateId: TEMPLATE_NOTE },
    responseExamples: [
      {
        summary: 'Draft started',
        value: { success: true, message: 'Success', data: DRAFT_VERSION },
      },
    ],
  },

  'PUT /api/v1/consultation-templates/{templateId}/versions/{versionId}': {
    summary: 'Save the draft definition',
    description: `
Replace the draft's definition document — the sections, the fields and their
descriptors.

⚠️ **A document that says nothing checkable is refused, with a sentence naming
the section and the key.** \`{ "require": true }\` for \`{ "required": true }\`
comes back as a \`400\` rather than as a mandatory field silently switched off.
That distinction matters: a typo here means a doctor is never asked for something
the clinic believes is compulsory, and nothing would ever surface it.

**Only a \`DRAFT\` version can be saved.** A published one is \`409\`.

\`PUT\`, so the definition is replaced wholesale rather than merged.
`.trim(),
    response: consultationTemplateVersionSummary,
    errors: [409],
    params: { templateId: TEMPLATE_NOTE, versionId: VERSION_NOTE },
    requestExamples: [
      {
        summary: 'Two sections',
        value: {
          definition: {
            sections: [
              {
                key: 'history',
                label: 'History',
                type: 'FREE_TEXT',
                displayOrder: 1,
                visible: true,
                fields: [],
              },
              {
                key: 'examination',
                label: 'Examination',
                type: 'FIELDS',
                displayOrder: 2,
                visible: true,
                fields: [
                  { key: 'throat', label: 'Throat', type: 'TEXT', required: true },
                  { key: 'chest', label: 'Chest', type: 'TEXT', required: false },
                ],
              },
            ],
          },
        },
      },
    ],
    responseExamples: [
      { summary: 'Saved', value: { success: true, message: 'Success', data: DRAFT_VERSION } },
    ],
  },

  'POST /api/v1/consultation-templates/{templateId}/versions/{versionId}/publish': {
    summary: 'Publish a draft',
    description: `
Put the draft live, retiring the version it replaces **in the same
transaction** — there is no moment at which the template has two published
versions or none.

⚠️ **Consultations already conducted are untouched.** Each one holds a frozen
snapshot of the version it was written on, so a record from last year still
renders as it was written. That is what makes publishing safe, and it is why
there is no edit-in-place anywhere on this surface.

New consultations opened after this pick up the new version. Ones currently in
draft keep the version they started on.
`.trim(),
    response: consultationTemplateVersionSummary,
    errors: [409],
    params: { templateId: TEMPLATE_NOTE, versionId: VERSION_NOTE },
    responseExamples: [
      {
        summary: 'Published',
        value: {
          success: true,
          message: 'Success',
          data: { ...DRAFT_VERSION, status: 'PUBLISHED', publishedAt: '2026-03-17T04:00:00.000Z' },
        },
      },
    ],
  },

  'DELETE /api/v1/consultation-templates/{templateId}/versions/{versionId}': {
    summary: 'Discard a draft',
    description: `
Throw away a revision that will not be published.

**Only a \`DRAFT\`.** A published or retired version cannot be deleted — signed
consultations hold snapshots of it, and the version row is what makes those
snapshots legible.

The live version is unaffected; the template simply stops having a draft.
`.trim(),
    errors: [409],
    params: { templateId: TEMPLATE_NOTE, versionId: VERSION_NOTE },
    responseExamples: [
      { summary: 'Discarded', value: { success: true, message: 'Success', data: null } },
    ],
  },

  'GET /api/v1/visual-maps': {
    summary: 'List body charts',
    description:
      "The charts a consultation can draw findings on — a dental arch, a body outline. `isOwn` separates the ones rcln ships from the clinic's own. `regionCount` is how many marked areas a chart has, which is what makes a picker useful without loading every region.",
    response: visualMapListResponse,
    paginated: true,
    params: {
      careContextId: 'Narrow to one care context.',
      specialtyId: 'Narrow to one specialty.',
      includeInactive: 'Include retired charts. Defaults to `false`.',
      page: 'Page number, from 1.',
      pageSize: 'Rows per page, up to 100.',
    },
    responseExamples: [
      {
        summary: 'The shipped dental chart',
        value: {
          success: true,
          message: 'Success',
          data: { items: [MAP_EXAMPLE], total: 1, page: 1, pageSize: 25 },
        },
      },
    ],
  },

  'GET /api/v1/visual-maps/{mapId}': {
    summary: 'Get a body chart',
    description:
      'One chart with every region on it. `viewBox` is the SVG coordinate space the regions are expressed in — four numbers, validated here, again in the rendering engine, and once more by a database CHECK, because a malformed one draws a chart nobody can click.',
    response: visualMapDetail,
    params: { mapId: MAP_NOTE },
    responseExamples: [
      {
        summary: 'A chart with its regions',
        value: {
          success: true,
          message: 'Success',
          data: { ...MAP_EXAMPLE, regionCount: 1, regions: [REGION] },
        },
      },
    ],
  },

  'POST /api/v1/visual-maps': {
    summary: 'Create a body chart',
    description: `
Define a chart of this clinic's own.

\`viewBox\` is \`"minX minY width height"\` — four numbers separated by spaces,
matching the SVG asset the regions will be placed on.

\`renderer\` decides how it is drawn: \`SVG\` for a vector chart with clickable
paths, \`IMAGE_MAP\` for a bitmap with coordinate regions. \`assetKey\` points at
the stored artwork.

Created with no regions; add them with \`POST /{mapId}/regions\`.
`.trim(),
    response: visualMap,
    status: 201,
    errors: [409],
    requestExamples: [
      {
        summary: 'A dental chart',
        value: {
          code: 'DENTAL_FDI_ADULT',
          name: 'Adult dentition (FDI)',
          renderer: 'SVG',
          assetKey: 'charts/dental-fdi-adult.svg',
          careContextId: CARE_CONTEXT_ID,
          viewBox: '0 0 640 320',
        },
      },
    ],
    responseExamples: [
      {
        summary: 'Created',
        value: {
          success: true,
          message: 'Success',
          data: { ...MAP_EXAMPLE, isOwn: true, regionCount: 0 },
        },
      },
    ],
  },

  'PATCH /api/v1/visual-maps/{mapId}': {
    summary: 'Update a body chart',
    description:
      'Rename a chart, re-scope it to a specialty, adjust its `viewBox`, or retire it. `code` and `careContextId` are not editable. A chart rcln ships cannot be edited by a clinic — clone the idea rather than the row.',
    response: visualMap,
    errors: [403, 409],
    params: { mapId: MAP_NOTE },
    requestExamples: [
      { summary: 'Rename', value: { name: 'Adult dentition (FDI notation)' } },
      { summary: 'Retire it', value: { isActive: false } },
    ],
    responseExamples: [
      {
        summary: 'Updated',
        value: {
          success: true,
          message: 'Success',
          data: { ...MAP_EXAMPLE, name: 'Adult dentition (FDI notation)', isOwn: true },
        },
      },
    ],
  },

  'POST /api/v1/visual-maps/{mapId}/regions': {
    summary: 'Add a region to a chart',
    description: `
Add one clickable area — a tooth, a quadrant, a limb.

\`code\` is upper-case and unique within the chart; it is what a finding cites,
so it should mean something durable (\`FDI_11\`, not \`REGION_1\`).

\`parentId\` nests regions, which is how a quadrant contains its teeth — a
finding can then be recorded against either level.

\`metadata\` is free-form JSON for whatever the renderer needs: a quadrant
number, an SVG path id. It is a **document**, never a set of foreign keys.
`.trim(),
    response: visualRegion,
    status: 201,
    errors: [409],
    params: { mapId: MAP_NOTE },
    requestExamples: [
      {
        summary: 'One tooth',
        value: {
          code: 'FDI_11',
          label: 'Upper right central incisor',
          displayOrder: 1,
          metadata: { quadrant: 1, toothNumber: 1 },
        },
      },
    ],
    responseExamples: [
      { summary: 'Added', value: { success: true, message: 'Success', data: REGION } },
    ],
  },

  'PATCH /api/v1/visual-maps/{mapId}/regions/{regionId}': {
    summary: 'Update a region',
    description:
      'Relabel a region, re-nest it, reorder it, or change its metadata. **`code` is not editable** — findings already recorded cite it, and changing it would silently repoint clinical records at a different part of the body.',
    response: visualRegion,
    errors: [409],
    params: { mapId: MAP_NOTE, regionId: "The region, from the chart's `regions[]`." },
    requestExamples: [
      { summary: 'Relabel', value: { label: 'Tooth 11 — upper right central incisor' } },
      { summary: 'Nest it under a quadrant', value: { parentId: VISUAL_REGION_ID } },
    ],
    responseExamples: [
      {
        summary: 'Updated',
        value: {
          success: true,
          message: 'Success',
          data: { ...REGION, label: 'Tooth 11 — upper right central incisor' },
        },
      },
    ],
  },

  'DELETE /api/v1/visual-maps/{mapId}/regions/{regionId}': {
    summary: 'Remove a region',
    description: `
Take a region off a chart.

**A region with findings recorded against it cannot be removed** — \`409\`.
Those findings are clinical records that point here, and deleting the region
would leave them describing nowhere. Retire the whole chart instead if it is no
longer used.

Removing a region that has children removes them too.
`.trim(),
    errors: [409],
    params: { mapId: MAP_NOTE, regionId: "The region, from the chart's `regions[]`." },
    responseExamples: [
      { summary: 'Removed', value: { success: true, message: 'Success', data: null } },
    ],
  },
};
