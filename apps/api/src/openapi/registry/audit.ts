/**
 * Audit — one endpoint, and a record's own history is all it serves.
 *
 * ⚠️ `audit_logs` IS APPEND-ONLY AT THE DATABASE. There is no write endpoint
 *   here and there will not be one: the trail is written as a side effect of the
 *   thing being audited, inside the same transaction, so it cannot disagree with
 *   what actually happened.
 */
import { auditHistoryResponse } from '@rcln/contracts';
import type { DocRegistry } from '../types.js';
import {
  AUDIT_CREATE_ID,
  AUDIT_SUPPORT_ID,
  AUDIT_UPDATE_ID,
  BRANCH_ID,
  SUPPORT_USER,
  USER,
  USER_ID,
} from './fixtures.js';

export const auditDocs: DocRegistry = {
  'GET /api/v1/audit': {
    summary: "Read a record's history",
    description: `
Who changed this record, when, and which fields moved — newest first.

⚠️ **The gate is not a plain \`authorize()\`, and it is the only one in the API
that is not.** The acceptable permission depends on *which* record you are
asking about: \`audit.record.read\` opens everything, but the code that owns an
entity type also opens that type's history. Today \`appointment_vital\` is
readable by \`clinical.vitals.read\`, so a doctor can see who corrected the
observations their consultation rests on — they hold the read code and
deliberately not the write one.

That entry list is a **permission decision, not a convenience**. Add to it
because the holder of the code is the person who wrote the record, never because
a screen showed a \`403\`.

**Only fields that actually moved appear in \`changes\`.** \`before\` is absent
on a create and \`after\` is absent on a delete, so the two are distinguishable
without reading \`action\`.

\`actor\` is null when the account is gone — \`audit_logs\` keeps the row and
nulls the reference, because a deleted member must not take the history of what
they did with them. \`onBehalfOf\` is set when the change was made by rcln staff
standing inside the clinic; the clinic sees that it was us, by name.

\`truncated\` says the trail was cut by \`limit\`, so the UI can admit the
record's whole life is not on screen rather than implying it is.
`.trim(),
    response: auditHistoryResponse,
    errors: [403],
    params: {
      entityType:
        "The record's type as `recordAudit` writes it — lower_snake_case, e.g. `branch`, `membership`, `patient`, `appointment_vital`.",
      entityId:
        "The record's `id`. One belonging to another clinic returns an empty trail, never another clinic's.",
      limit:
        'How many entries to return, newest first. Capped server-side; the default is enough for a panel, not for an export.',
    },
    responseExamples: [
      {
        summary: 'A branch renamed, then its phone corrected',
        value: {
          success: true,
          message: 'Success',
          data: {
            entityType: 'branch',
            entityId: BRANCH_ID,
            truncated: false,
            entries: [
              {
                id: AUDIT_UPDATE_ID,
                action: 'UPDATE',
                occurredAt: '2026-03-16T11:02:00.000Z',
                actor: { id: USER_ID, fullName: USER.fullName },
                onBehalfOf: null,
                changes: [{ field: 'phone', before: '+918041234567', after: '+919845012345' }],
              },
              {
                id: AUDIT_CREATE_ID,
                action: 'CREATE',
                occurredAt: '2024-10-28T05:40:00.000Z',
                actor: { id: USER_ID, fullName: USER.fullName },
                onBehalfOf: null,
                changes: [{ field: 'name', after: 'Alpha Clinic — Indiranagar' }],
              },
            ],
          },
        },
      },
      {
        summary: 'Changed by rcln staff',
        description:
          "`onBehalfOf` names the platform administrator who was standing inside the clinic. Without it this row would look like an ordinary member's write.",
        value: {
          success: true,
          message: 'Success',
          data: {
            entityType: 'branch',
            entityId: BRANCH_ID,
            truncated: false,
            entries: [
              {
                id: AUDIT_SUPPORT_ID,
                action: 'UPDATE',
                occurredAt: '2026-03-10T09:15:00.000Z',
                actor: { id: USER_ID, fullName: USER.fullName },
                onBehalfOf: SUPPORT_USER,
                changes: [{ field: 'timezone', before: 'Asia/Calcutta', after: 'Asia/Kolkata' }],
              },
            ],
          },
        },
      },
    ],
  },
};
