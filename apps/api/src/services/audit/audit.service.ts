/**
 * The one way to write an audit row.
 *
 * WHY THIS EXISTS
 *   A platform admin inside a tenant can read, write and delete exactly as the
 *   membership they are impersonating can — there is no elevation step and no
 *   write block (ADR-0012). The audit trail is therefore not a nice-to-have
 *   sitting alongside a permission model that already constrains the damage; it
 *   is the only control. "The clinic name was X, is now Y, changed by Z" has to
 *   be answerable for every actor and every mutation, so writing that row stops
 *   being something each call site remembers to do in its own shape.
 *
 * WHAT IT GUARANTEES
 *   - The row is written inside the caller's transaction. An audit row that can
 *     commit while its mutation rolls back is worse than none.
 *   - `impersonatedByUserId` comes off the TenantContext, so an impersonated
 *     write is attributed to both the impersonated user and the real admin
 *     without the call site knowing impersonation exists.
 *   - Only fields that actually changed are stored. A 40-column before/after
 *     pair is not readable and re-stores data nobody asked for.
 *   - Credentials are marked as changed, never recorded.
 *
 * WHAT IT DOES NOT DO
 *   Decide what is safe to log. `before`/`after` are whatever the caller passes.
 *   Pass ids, codes and configuration; never a patient name, never a full row
 *   that happens to contain one. CONVENTIONS.md: an audit row is not a place to
 *   re-store PII.
 */
import type { AuditAction, Prisma, TenantContext, TxClient } from '@rcln/db';

/**
 * Never written, even when the caller passes them.
 *
 * Replaced rather than dropped: that a password hash changed is exactly the
 * kind of thing an incident review asks about, while its value is exactly the
 * kind of thing that must not sit in a table built for wide read access.
 */
const REDACTED_KEYS = new Set([
  'passwordHash',
  'password',
  'mfaSecret',
  'codeHash',
  'token',
  'refreshTokenHash',
  'previousTokenHash',

  /*
   * PHI and direct identifiers — the SECOND layer, not the first.
   *
   * The first layer is each service passing an allow-list snapshot rather than
   * a whole row. This backstop exists because that layer is one careless
   * `{...row}` away from failing, and the result would be a name, a date of
   * birth and an ABHA number sitting permanently in a table that is
   * deliberately protected against deletion and is read widely.
   *
   * Redacted, not dropped: THAT a patient's identifier changed is a legitimate
   * audit question. What it changed to is not this table's business.
   *
   * ⚠️ ONLY KEYS THAT ARE PHI ON EVERY ENTITY THAT COULD CARRY THEM.
   *   `email` and `phone` are deliberately NOT here, and adding them would be a
   *   regression rather than an improvement: `invitations` records the invited
   *   email on purpose — "who was invited" IS the audit record — and `branches`
   *   records a clinic's public switchboard number. Blanket-redacting by key
   *   name would quietly gut both trails to protect a patient column that no
   *   service passes anyway. A patient's contact details are kept out by the
   *   allow-list snapshot in the patient service, which is where the entity is
   *   actually known, and by the integration test that greps every audit row for
   *   the seeded patient's details.
   */
  'firstName',
  'lastName',
  'fullName',
  'dateOfBirth',
  'abhaNumber',
  'nationalId',
  'allergenText',
  'medicineText',
  'conditionText',
  'chiefComplaint',
  /*
   * Added with the patient tables. Both are PHI on every entity that could
   * carry them — there is no `reaction` or `dosage` anywhere in this system
   * that is not about one patient's body — so unlike `email` and `phone` above,
   * a key-name deny-list is the right instrument here.
   *
   * `uhid` and `mrn` are deliberately NOT here. They are the identifiers the
   * audit row is ABOUT: an audit trail that cannot say which patient record was
   * edited records nothing useful, and neither number discloses anything on its
   * own to a reader who cannot already resolve it.
   */
  'reaction',
  'dosage',

  /*
   * Added with the invoice engine. These four are the `invoices` table's
   * customer block, and on a clinic's invoice the customer is the patient: the
   * name, the phone, the address and the email are copied onto the row at
   * creation precisely so the document keeps printing them after the patient
   * marries and changes their surname.
   *
   * ⚠️ THEY DO NOT CONTRADICT THE `email`/`phone` PARAGRAPH ABOVE — THEY ARE
   *   WHY IT IS WORDED THE WAY IT IS. Blanket-redacting `email` would gut the
   *   invitation trail, where the invited address IS the record. `customerEmail`
   *   is a different key on one table, and the only entity in this system that
   *   carries it is a bill raised to a patient. A B2B invoice's contact details
   *   are the price of the rule, and they are a price worth paying: nothing in
   *   the audit trail needs them, because `patientId` and `customerTaxId` are
   *   what a reader follows.
   *
   * The first layer is still the allow-list snapshot — `invoiceAuditSnapshot()`
   * in `invoice-lifecycle.service.ts` never selects these columns at all. This
   * is the backstop for the next service that writes an invoice row and reaches
   * for a convenient `{...invoice}`.
   */
  'customerName',
  'customerPhone',
  'customerEmail',
  'customerAddress',

  /*
   * ⚠️ THE TWO FREE-TEXT COLUMNS ON AN INVOICE, WHICH THE SCHEMA HAS SAID BELONG
   *   HERE SINCE PHASE 3 AND WHICH WERE NOT HERE. `invoices.notes` carries the
   *   comment "PHI-CAPABLE FREE TEXT, printed on the invoice. In REDACTED_KEYS",
   *   and `cancellation_reason` says "same PHI treatment as notes". Both are
   *   boxes a cashier types a sentence into, and a sentence about why a bill was
   *   reversed is a sentence about a patient often enough to count.
   *
   *   The snapshot in `invoice-lifecycle.service.ts` reports them as
   *   `hasNotes` / `hasCancellationReason` — "a reason was recorded" is the
   *   auditable fact, and the text itself stays on the invoice, where a reader
   *   who may see the bill can read it. These entries are the backstop under
   *   that, so a caller passing the raw column gets `[redacted]` instead.
   */
  'notes',
  'cancellationReason',
]);

const REDACTED = '[redacted]';

/** A row shape as handed to the audit trail: flat, JSON-serialisable. */
export type AuditSnapshot = Record<string, unknown>;

export interface AuditEntry {
  action: AuditAction;
  /** lower_snake_case noun: 'branch', 'invitation', 'membership_role'. */
  entityType: string;
  entityId?: string | undefined;
  /** Omit for a create. */
  before?: AuditSnapshot | undefined;
  /** Omit for a delete. */
  after?: AuditSnapshot | undefined;
  /** The branch the change belongs to, where the entity has one. */
  branchId?: string | null | undefined;
  ipAddress?: string | undefined;
  userAgent?: string | undefined;
}

function redact(snapshot: AuditSnapshot): AuditSnapshot {
  const out: AuditSnapshot = {};
  for (const [key, value] of Object.entries(snapshot)) {
    out[key] = REDACTED_KEYS.has(key) ? REDACTED : value;
  }
  return out;
}

/**
 * Compare by JSON rather than by identity.
 *
 * Prisma hands back `Date` objects and `Decimal` instances, neither of which is
 * `===` to an equal sibling. Comparing those directly reports every field as
 * changed on every update, which is the same as recording nothing.
 */
function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a instanceof Date && b instanceof Date) return a.getTime() === b.getTime();
  if (a === null || b === null || a === undefined || b === undefined) return false;
  if (typeof a === 'object' || typeof b === 'object') {
    return JSON.stringify(a) === JSON.stringify(b);
  }
  // Decimal, BigInt and friends: their string forms are stable and comparable.
  return String(a) === String(b);
}

interface Diff {
  before: AuditSnapshot | undefined;
  after: AuditSnapshot | undefined;
}

/**
 * Reduce a before/after pair to only the keys whose value moved.
 *
 * A create has no `before` and a delete has no `after`; in both cases the whole
 * snapshot is the interesting part and there is nothing to narrow against.
 */
export function diffSnapshots(
  before: AuditSnapshot | undefined,
  after: AuditSnapshot | undefined
): Diff {
  if (!before || !after) {
    return {
      before: before ? redact(before) : undefined,
      after: after ? redact(after) : undefined,
    };
  }

  const changedBefore: AuditSnapshot = {};
  const changedAfter: AuditSnapshot = {};

  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (sameValue(before[key], after[key])) continue;
    changedBefore[key] = REDACTED_KEYS.has(key) ? REDACTED : before[key];
    changedAfter[key] = REDACTED_KEYS.has(key) ? REDACTED : after[key];
  }

  // An update that changed nothing still happened, and the row records that it
  // was attempted — but with empty objects rather than a misleading full copy.
  return { before: changedBefore, after: changedAfter };
}

/**
 * Write one audit row, inside the caller's transaction.
 *
 * @example
 * await withTenant(ctx, async (tx) => {
 *   const before = await tx.branch.findUniqueOrThrow({ where: { id } });
 *   const after  = await tx.branch.update({ where: { id }, data });
 *   await recordAudit(tx, ctx, {
 *     action: 'UPDATE', entityType: 'branch', entityId: id,
 *     before, after, branchId: id,
 *   });
 *   return after;
 * });
 */
export async function recordAudit(
  tx: TxClient,
  ctx: TenantContext,
  entry: AuditEntry
): Promise<void> {
  const { before, after } = diffSnapshots(entry.before, entry.after);

  await tx.auditLog.create({
    data: {
      organizationId: ctx.organizationId,
      actorUserId: ctx.userId,
      action: entry.action,
      entityType: entry.entityType,
      ...(entry.entityId !== undefined ? { entityId: entry.entityId } : {}),
      ...(entry.branchId != null ? { branchId: entry.branchId } : {}),
      ...(ctx.impersonatedByUserId !== undefined
        ? { impersonatedByUserId: ctx.impersonatedByUserId }
        : {}),
      ...(before !== undefined ? { beforeData: before as Prisma.InputJsonValue } : {}),
      ...(after !== undefined ? { afterData: after as Prisma.InputJsonValue } : {}),
      ...(entry.ipAddress !== undefined ? { ipAddress: entry.ipAddress } : {}),
      // audit_logs.user_agent is varchar(512); a longer one would abort the
      // transaction, taking the mutation with it.
      ...(entry.userAgent !== undefined ? { userAgent: entry.userAgent.slice(0, 512) } : {}),
    },
  });
}
