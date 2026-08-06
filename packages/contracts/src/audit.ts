import { z } from 'zod';
import { uuid } from './common.js';

/**
 * A record's own history — who changed it, what moved, and when.
 *
 * WHAT THIS IS NOT
 *   Not an activity feed. Every request names ONE record, because "what happened
 *   to this branch" is the question people actually have, and an org-wide stream
 *   answers a different one. The org-wide view is `platform.audit.read`'s job.
 *
 * NAMES ARE RESOLVED HERE, IDS ARE WHAT IS STORED
 *   `audit_logs` holds `actor_user_id` and nothing else about the person —
 *   CONVENTIONS.md forbids re-storing PII on an audit row, and a name copied at
 *   write time would also be the name at write time, which is wrong the moment
 *   somebody marries. So the API joins to `users` on the way out and this carries
 *   the name for display only.
 */

/** How a single field moved. `null` on either side is a real value: it was unset. */
export const auditFieldChange = z.object({
  field: z.string(),
  /** Absent on a create — there was nothing there. */
  before: z.unknown().optional(),
  /** Absent on a delete — there is nothing there now. */
  after: z.unknown().optional(),
});

export const auditAction = z.enum([
  'CREATE',
  'UPDATE',
  'DELETE',
  'LOGIN',
  'LOGOUT',
  'EXPORT',
  'SWITCH_BRANCH',
  'IMPERSONATE',
  'PERMISSION_CHANGE',
]);

export const auditEntry = z.object({
  id: uuid,
  action: auditAction,
  occurredAt: z.iso.datetime(),
  /**
   * Who the change is attributed to. Null when the actor is gone — `audit_logs`
   * keeps the row and nulls the reference (`onDelete: SetNull`), because a
   * deleted account must not take the history of what it did with it.
   */
  actor: z
    .object({
      id: uuid,
      fullName: z.string(),
    })
    .nullable(),
  /**
   * Set when the change was made by rcln staff standing inside this clinic
   * (ADR-0012). The clinic sees that it was us, by name, which is the entire
   * point of the column — a write attributed only to `actor` would look like an
   * ordinary member's.
   */
  onBehalfOf: z
    .object({
      id: uuid,
      fullName: z.string(),
    })
    .nullable(),
  /** Only the fields that moved. An update that changed nothing is an empty list. */
  changes: z.array(auditFieldChange),
});

export const auditHistoryResponse = z.object({
  entityType: z.string(),
  entityId: uuid,
  entries: z.array(auditEntry),
  /**
   * True when the trail was cut short by the page limit, so the UI can say so
   * rather than implying the record's whole life is on screen.
   */
  truncated: z.boolean(),
});

export const auditHistoryQuery = z.object({
  /** lower_snake_case noun, as written by `recordAudit`: 'branch', 'membership'. */
  entityType: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[a-z][a-z0-9_]*$/, 'lowercase letters, digits and underscores only'),
  entityId: uuid,
  /** Capped server-side. A record with a thousand edits is a scroll, not a page. */
  limit: z.coerce.number().int().min(1).max(100).optional(),
});

export type AuditFieldChange = z.infer<typeof auditFieldChange>;
export type AuditAction = z.infer<typeof auditAction>;
export type AuditEntry = z.infer<typeof auditEntry>;
export type AuditHistoryResponse = z.infer<typeof auditHistoryResponse>;
export type AuditHistoryQuery = z.infer<typeof auditHistoryQuery>;
