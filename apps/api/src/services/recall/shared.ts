/**
 * The pieces both recall services need, in one place so they cannot drift.
 *
 * NO PHI IS LOGGED FROM THIS FILE.
 */
/*
 * ⚠️ RE-EXPORTED, NOT REDEFINED (PI-11 review). `assertBranchInScope` and `q`
 *   were copies of the same two functions in three other service directories.
 *   `services/shared/branch.ts` is the single source — see its header for why
 *   this particular pair must not drift.
 */
export { assertBranchInScope, q } from '../shared/branch.js';

/** What every recall route hands its service. */
export interface RecallActionOptions {
  /**
   * ⚠️ THE MATCHED ROUTE PATTERN AND NEVER `req.originalUrl`. A URL carries its
   *   query string into `data_access_logs`, which is the one table that never
   *   takes free text.
   */
  route?: string | undefined;
  ipAddress?: string | undefined;
  userAgent?: string | undefined;
}

/**
 * The two fields `recordAudit` takes, pulled out of the wider options object.
 *
 * ⚠️ EXPLICIT RATHER THAN `...options`, for the reason `pharmacy/shared.ts` and
 *   `consumption/shared.ts` both give: spreading a wider options object into an
 *   audit row puts whatever a later phase adds to it into the audit row's shape.
 */
export function auditMeta(options: RecallActionOptions): {
  ipAddress?: string;
  userAgent?: string;
} {
  return {
    ...(options.ipAddress !== undefined ? { ipAddress: options.ipAddress } : {}),
    ...(options.userAgent !== undefined ? { userAgent: options.userAgent } : {}),
  };
}

/**
 * The reference a movement carries when a recall pulled it.
 *
 * ⚠️ THE REGULATOR'S NUMBER WHERE THERE IS ONE, THE CLINIC'S OTHERWISE — never
 *   an internal uuid. `batches.recall_reference` is read by a human explaining
 *   to somebody outside the clinic why a lot was pulled, and a uuid answers a
 *   different question from the one being asked.
 */
export function recallReferenceFor(recall: {
  reference: string;
  noticeReference: string | null;
}): string {
  return recall.noticeReference ?? recall.reference;
}
