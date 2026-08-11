/**
 * Job ids, which are the queue's only correctness surface that is not a type.
 *
 * Everything else here is a name or an interface the compiler checks. A job id
 * is a string that BullMQ uses to de-duplicate, so a wrong one does not throw —
 * it silently drops work or silently does it twice, and both are discovered
 * downstream by somebody wondering where their document went.
 */

import { jobId } from '../src/index.js';

describe('the invoice render id', () => {
  it('is one id per invoice, so a double-clicked Issue renders once', () => {
    expect(jobId.invoicePdf('abc')).toBe('invoice-pdf-abc');
    expect(jobId.invoicePdf('abc')).toBe(jobId.invoicePdf('abc'));
  });

  /*
   * ⚠️ THE CASE THE `attempt` ARGUMENT EXISTS FOR. BullMQ de-duplicates on job
   *   id while a job is queued, active OR RECENTLY COMPLETED. A regeneration
   *   after a failed render therefore resolves against the old completed job:
   *   `queue.add()` succeeds, reports an id, and nothing renders. The retry has
   *   to be a different id or it is not a retry.
   */
  it('is a different id for a deliberate regeneration', () => {
    expect(jobId.invoicePdf('abc', 2)).not.toBe(jobId.invoicePdf('abc'));
    expect(jobId.invoicePdf('abc', 2)).toBe('invoice-pdf-abc-r2');
    expect(jobId.invoicePdf('abc', 3)).toBe('invoice-pdf-abc-r3');
  });

  /* Attempt 1 keeps the plain form, so the first id never changes shape. */
  it('treats attempt 1 and no attempt as the same job', () => {
    expect(jobId.invoicePdf('abc', 1)).toBe(jobId.invoicePdf('abc'));
  });
});

/**
 * ⚠️ NO COLONS, ANYWHERE.
 *
 * BullMQ namespaces its own Redis keys with `:` and rejects a custom job id
 * containing one — by throwing at `queue.add()`, in the producer, at runtime.
 * These separators were colons once; every one of them would have failed the
 * first time it was used, and the first one to be used did exactly that.
 */
describe('every id is a legal BullMQ id', () => {
  const ids = [
    jobId.appointmentReminder('a1', 24),
    jobId.invoicePdf('i1'),
    jobId.invoicePdf('i1', 2),
    jobId.subscriptionRenewal('s1', '2026-08-01'),
    jobId.expirySweep('b1', '2026-08-01'),
    jobId.billingAction('RENEW', 's1', '2026-08-01'),
  ];

  it.each(ids)('%s contains no colon', (id) => {
    expect(id).not.toContain(':');
  });

  it('is non-empty and url-safe throughout', () => {
    for (const id of ids) {
      expect(id.length).toBeGreaterThan(0);
      expect(id).toMatch(/^[A-Za-z0-9._-]+$/);
    }
  });
});
