/**
 * The one way to record that someone READ a patient record.
 *
 * WHY THIS IS A SEPARATE TABLE AND NOT AN `AuditAction.READ`
 *   `audit_logs` answers "what changed", and the per-record history drawer
 *   already reads it by `(entity_type, entity_id)`. Folding read rows in would
 *   drown that screen — reads outnumber writes by orders of magnitude — and
 *   would let any caller of `recordAudit` write into the immutable mutation
 *   trail. Two questions, two tables, two helpers.
 *
 * WHY IT EXISTS AT ALL
 *   Every other control in this product constrains what staff can CHANGE. The
 *   failure this product actually has is a member of staff reading the record of
 *   a patient who is none of their business — a neighbour, a colleague, someone
 *   in the news. That read mutates nothing, breaks nothing, and appears in no
 *   other table. This is the only evidence it happened.
 *
 * ⚠️ WHAT MAY GO IN A ROW: IDS, ENUMS, COUNTS AND A HASH. NOTHING ELSE.
 *   No names, no phone numbers, no free text, ever. This table is built to be
 *   read by compliance and security people who have no business reading patient
 *   records; a name landing here is a disclosure, not a log line. In particular:
 *
 *     - `queryHash` is a SHA-256 of the normalised search term. It proves two
 *       searches were for the same thing and never recovers a surname.
 *     - `route` is the matched route PATTERN (`GET /v1/patients/:id`), never
 *       `req.originalUrl`, which carries the search string with it.
 *
 * ONE ROW PER REQUEST, NEVER PER RESULT ROW.
 *   A search writes a single row with `resultCount` set and `patientId` null; a
 *   detail view writes one naming the patient. The rule for anything new: log a
 *   read that discloses clinical content or singles out one patient's record. A
 *   day board showing "10:00 · P000042" to the receptionist running that clinic
 *   is neither, and logging it would turn this table into a per-poll firehose.
 *
 * Append-only, enforced by Postgres in two independent layers — see the
 * `data_access_log_immutability` migration.
 */
import { createHash } from 'node:crypto';
import type { DataAccessResource, DataAccessType, TenantContext, TxClient } from '@rcln/db';
import { redis } from '../../utils/redis.js';
import { logger } from '../../utils/logger.js';

export interface DataAccessEntry {
  accessType: DataAccessType;
  resource: DataAccessResource;
  /** The patient whose record this was. Omit for a search or a list. */
  patientId?: string | undefined;
  /** The specific record read, when it is not the patient row itself. */
  resourceId?: string | undefined;
  /** How many records came back. Defaults to 1 (a detail view). */
  resultCount?: number | undefined;
  /**
   * The raw search term. Hashed here and never stored — pass it plainly, this
   * function is the boundary that makes it safe.
   */
  searchTerm?: string | undefined;
  branchId?: string | null | undefined;
  /** The matched route pattern. NEVER `req.originalUrl`. */
  route?: string | undefined;
  ipAddress?: string | undefined;
  userAgent?: string | undefined;
}

/** How long the same actor re-reading the same record stays deduplicated. */
const DEDUPE_TTL_SECONDS = 300;

/**
 * Normalise before hashing so "  Sharma" and "sharma" collide.
 *
 * Without this the hash is useless for the question it exists to answer — "did
 * this person search for the same thing eleven times?" — because trivial
 * whitespace and case differences would produce eleven distinct hashes.
 */
function hashSearchTerm(term: string): string {
  return createHash('sha256').update(term.trim().toLowerCase()).digest('hex');
}

/**
 * True when this exact read was already logged recently, and may be skipped.
 *
 * A doctor tabbing between three panels of one chart is one clinical act, not
 * thirty. `SET key 1 EX <ttl> NX` returns null when the key already existed, so
 * the first read in a window logs and the rest do not.
 *
 * Only ids go into the key — permitted by CONVENTIONS, and the reason there is
 * no search term or name anywhere in it.
 *
 * A Redis failure must NOT drop the log row. Falling back to "not a duplicate"
 * writes an extra row at worst; failing closed would silently lose evidence
 * whenever the cache is down, which is exactly when things are going wrong.
 */
async function isDuplicate(
  ctx: TenantContext,
  resource: DataAccessResource,
  resourceId: string
): Promise<boolean> {
  const key = `dal:${ctx.organizationId}:${ctx.userId}:${resource}:${resourceId}`;
  try {
    const set = await redis.set(key, '1', 'EX', DEDUPE_TTL_SECONDS, 'NX');
    return set === null;
  } catch (err) {
    logger.warn({ err }, 'data-access dedupe check failed; logging the read anyway');
    return false;
  }
}

/**
 * Write one PHI-read row, inside the caller's transaction.
 *
 * ⚠️ INSIDE the transaction, deliberately, and NOT fire-and-forget after the
 * response. A read that succeeds while its log silently fails is a read with no
 * evidence — the one thing this table exists to prevent.
 *
 * @example
 * return withTenant(ctx, async (tx) => {
 *   const patient = await tx.patient.findFirst({ where: { id }, select: PATIENT_SELECT });
 *   if (!patient) throw new NotFoundError('Patient');
 *   await recordDataAccess(tx, ctx, {
 *     accessType: 'VIEW', resource: 'PATIENT', patientId: id, resourceId: id, ...meta,
 *   });
 *   return toDetail(patient);
 * });
 */
export async function recordDataAccess(
  tx: TxClient,
  ctx: TenantContext,
  entry: DataAccessEntry
): Promise<void> {
  /*
   * Deduplicate only reads that name one record. A SEARCH is deliberately never
   * deduplicated: repeatedly searching for the same person is itself the signal
   * — collapsing eleven attempts into one would erase the pattern that makes
   * this table worth having.
   */
  const dedupeId = entry.resourceId ?? entry.patientId;
  if (dedupeId !== undefined && entry.accessType === 'VIEW') {
    if (await isDuplicate(ctx, entry.resource, dedupeId)) return;
  }

  await tx.dataAccessLog.create({
    data: {
      organizationId: ctx.organizationId,
      actorUserId: ctx.userId,
      accessType: entry.accessType,
      resource: entry.resource,
      resultCount: entry.resultCount ?? 1,
      ...(entry.patientId !== undefined ? { patientId: entry.patientId } : {}),
      ...(entry.resourceId !== undefined ? { resourceId: entry.resourceId } : {}),
      ...(entry.branchId != null ? { branchId: entry.branchId } : {}),
      ...(ctx.impersonatedByUserId !== undefined
        ? { impersonatedByUserId: ctx.impersonatedByUserId }
        : {}),
      ...(entry.searchTerm !== undefined ? { queryHash: hashSearchTerm(entry.searchTerm) } : {}),
      ...(entry.route !== undefined ? { route: entry.route.slice(0, 128) } : {}),
      ...(entry.ipAddress !== undefined ? { ipAddress: entry.ipAddress } : {}),
      // varchar(512); a longer one would abort the transaction, taking the read
      // it describes with it.
      ...(entry.userAgent !== undefined ? { userAgent: entry.userAgent.slice(0, 512) } : {}),
    },
  });
}
