/**
 * The credit-note request contract (PI-8 review, HIGH).
 *
 * ⚠️ THESE LIVE AT THE CONTRACT AND NOT AT THE SERVICE, WHICH IS THE POINT. The
 *   per-line credit ceiling in `resolveLines` measures every entry against
 *   `alreadyCreditedByItem`, a snapshot taken ONCE before the loop. Naming one
 *   `invoiceItemId` twice therefore had both entries read the same untouched
 *   remainder and both pass — so the cap that stops a line being credited past
 *   what was supplied was defeated by repetition, not by arithmetic.
 *
 *   It could not be closed in the service without re-reading per entry, and the
 *   sibling request `createInvoiceFromChargesRequest` had already answered the
 *   identical question with a `.refine()`. `charging.test.ts` calls
 *   `createCreditNote` directly and so never sees Zod at all, which is exactly
 *   why the regression test for a Zod-level rule has to be here.
 */
import { createCreditNoteRequest } from '@rcln/contracts';

const ITEM_A = '11111111-1111-4111-8111-111111111111';
const ITEM_B = '22222222-2222-4222-8222-222222222222';

describe('crediting the same invoice line twice', () => {
  it('is refused, however the quantities are split', () => {
    const result = createCreditNoteRequest.safeParse({
      reason: 'Returned',
      lines: [
        { invoiceItemId: ITEM_A, quantity: '6' },
        { invoiceItemId: ITEM_A, quantity: '4' },
      ],
    });

    expect(result.success).toBe(false);
  });

  /*
   * ⚠️ THE SPLIT MATTERS, AND IS WHY THE FAILURE WAS NOT ALREADY CAUGHT. Two
   *   FULL-quantity entries push the note's grand total over the invoice's, so
   *   `assertWithinRemaining` happened to refuse them. Split the same duplicate
   *   across two smaller quantities on a multi-line invoice and the total lands
   *   under the ceiling and commits — a statutory credit note reversing a
   *   quantity of one HSN that was never billed under it.
   */
  it('is refused even when the total would stay under the invoice', () => {
    const result = createCreditNoteRequest.safeParse({
      reason: 'Returned',
      lines: [
        { invoiceItemId: ITEM_A, quantity: '1' },
        { invoiceItemId: ITEM_A, quantity: '1' },
      ],
    });

    expect(result.success).toBe(false);
  });

  it('still allows distinct lines, which is the ordinary partial return', () => {
    const result = createCreditNoteRequest.safeParse({
      reason: 'Returned',
      lines: [
        { invoiceItemId: ITEM_A, quantity: '6' },
        { invoiceItemId: ITEM_B, quantity: '4' },
      ],
    });

    expect(result.success).toBe(true);
  });

  /** Empty is "credit the whole invoice", which the service expands. */
  it('still allows an empty set', () => {
    expect(createCreditNoteRequest.safeParse({ reason: 'All of it' }).success).toBe(true);
  });
});
