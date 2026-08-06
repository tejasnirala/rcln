/**
 * Invoice numbers.
 *
 * WHAT A FINANCE TEAM NEEDS FROM ONE
 *   Unique, obviously sequential within a customer, and stable forever. Not a
 *   UUID — an invoice number goes on a bank narration and into a spreadsheet,
 *   and gets read aloud on the phone.
 *
 * THE SHAPE
 *   `INV-2026-4F73C7-000012`
 *    ^   ^    ^      ^
 *    |   |    |      sequence within this organization, this year
 *    |   |    six hex characters of the organization id
 *    |   year the invoice was issued
 *    fixed prefix
 *
 *   Organization-scoped rather than global: a global counter tells every
 *   customer how many invoices the platform has ever issued, which is a
 *   revenue disclosure nobody agreed to. The id fragment is there so two
 *   clinics' number 12 do not collide in the unique index.
 *
 * ⚠️ THE SEQUENCE IS COMPUTED BY COUNTING, AND THAT RACES
 *   Two invoices issued for one clinic in the same instant can compute the same
 *   number. That is why `subscription_invoices.invoice_number` is UNIQUE: the
 *   second one loses at the database rather than silently duplicating, and the
 *   caller retries. `nextInvoiceNumber` is therefore safe to call inside a
 *   transaction and must be called inside one.
 *
 *   A Postgres sequence per organization would remove the retry and add a DDL
 *   statement per tenant, which is a worse trade at this size. If invoice volume
 *   ever makes the retry visible, that is the change to make — not a wider lock.
 */

const PREFIX = 'INV';

export interface InvoiceNumberInput {
  organizationId: string;
  /** How many invoices this organization already has for `issuedAt`'s year. */
  countThisYear: number;
  issuedAt: Date;
}

export function formatInvoiceNumber(input: InvoiceNumberInput): string {
  const year = input.issuedAt.getUTCFullYear();
  // Six hex characters of the uuid, hyphens stripped. Enough to separate
  // tenants; not enough to be mistaken for the id itself.
  const tenant = input.organizationId.replace(/-/g, '').slice(0, 6).toUpperCase();
  const sequence = String(input.countThisYear + 1).padStart(6, '0');

  return `${PREFIX}-${String(year)}-${tenant}-${sequence}`;
}

/** The UTC year boundaries the count above is taken over. */
export function yearBounds(at: Date): { start: Date; end: Date } {
  const year = at.getUTCFullYear();
  return {
    start: new Date(Date.UTC(year, 0, 1)),
    end: new Date(Date.UTC(year + 1, 0, 1)),
  };
}
