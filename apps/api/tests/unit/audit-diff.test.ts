/**
 * The audit diff.
 *
 * Impersonation grants full write access (ADR-0012), so the audit trail is not
 * a supplement to a permission model that already limits the damage — it is the
 * only control. That makes these unglamorous cases load-bearing: a diff that
 * silently reports "nothing changed", or one that reports every field as
 * changed on every update, destroys the trail just as thoroughly as not writing
 * it. Both are easy to introduce and neither raises an error.
 */
import { diffSnapshots } from '../../src/services/audit/audit.service.js';

describe('diffSnapshots', () => {
  it('keeps only the fields that moved', () => {
    const { before, after } = diffSnapshots(
      { name: 'Acme Clinic', city: 'Pune', code: 'MAIN' },
      { name: 'Acme Health', city: 'Pune', code: 'MAIN' }
    );

    expect(before).toEqual({ name: 'Acme Clinic' });
    expect(after).toEqual({ name: 'Acme Health' });
  });

  it('reports an unchanged update as empty rather than as a full copy', () => {
    const row = { name: 'Acme', city: 'Pune' };
    expect(diffSnapshots(row, { ...row })).toEqual({ before: {}, after: {} });
  });

  it('treats a create as wholly new and a delete as wholly gone', () => {
    expect(diffSnapshots(undefined, { code: 'B2' })).toEqual({
      before: undefined,
      after: { code: 'B2' },
    });
    expect(diffSnapshots({ code: 'B2' }, undefined)).toEqual({
      before: { code: 'B2' },
      after: undefined,
    });
  });

  it('does not report equal Dates as a change', () => {
    // Prisma returns a fresh Date per read, so === is false for equal instants.
    // Without this, every update would look like it touched every timestamp.
    const { after } = diffSnapshots(
      { updatedAt: new Date('2026-07-26T10:00:00Z'), name: 'A' },
      { updatedAt: new Date('2026-07-26T10:00:00Z'), name: 'B' }
    );
    expect(after).toEqual({ name: 'B' });
  });

  it('does not report equal nested objects as a change', () => {
    const { before, after } = diffSnapshots(
      { hours: { opensAt: '09:00' }, isClosed: false },
      { hours: { opensAt: '09:00' }, isClosed: true }
    );
    expect(before).toEqual({ isClosed: false });
    expect(after).toEqual({ isClosed: true });
  });

  it('detects a field appearing or disappearing', () => {
    const { before, after } = diffSnapshots({ taxId: null }, { taxId: '27AAAAA0000A1Z5' });
    expect(before).toEqual({ taxId: null });
    expect(after).toEqual({ taxId: '27AAAAA0000A1Z5' });
  });

  it('records that a credential changed without recording the credential', () => {
    const { before, after } = diffSnapshots(
      { passwordHash: '$argon2id$old', email: 'a@example.com' },
      { passwordHash: '$argon2id$new', email: 'a@example.com' }
    );
    expect(before).toEqual({ passwordHash: '[redacted]' });
    expect(after).toEqual({ passwordHash: '[redacted]' });
  });

  it('redacts credentials on a create too, where there is nothing to diff against', () => {
    const { after } = diffSnapshots(undefined, { token: 'raw-invite-token', email: 'a@b.com' });
    expect(after).toEqual({ token: '[redacted]', email: 'a@b.com' });
  });

  /**
   * ⚠️ THE BACKSTOP UNDER THE INVOICE SNAPSHOT, TESTED WHERE IT CAN BE REACHED.
   *   `invoiceAuditSnapshot()` never selects these columns, so nothing in the
   *   product passes them today and no integration test can produce a row that
   *   exercises this. That is exactly why it is worth pinning: the layer exists
   *   for the next service that writes an invoice and reaches for `{...row}`,
   *   and a deny-list nobody has ever seen fire is a deny-list that quietly
   *   stopped containing the key it was written for.
   */
  /**
   * ⚠️ THE SAME BACKSTOP, FOR THE ANIMAL'S OWNER (PI-11 review, MEDIUM). Nothing
   *   in the product passes these either — `snapshot()` in
   *   `animal-profile.service.ts` emits `guardianForm` and never the name — so
   *   this unit test is the only place the layer can be seen to fire. A
   *   deny-list nobody has watched work is a deny-list that quietly stopped
   *   containing the key it was written for.
   */
  it('redacts an animal’s owner, who is a person', () => {
    const { after } = diffSnapshots(undefined, {
      guardianName: 'Padmanabhan Iyengar',
      guardianPhone: '+919812345690',
      species: 'Dog',
      breed: 'Indie',
      weightKg: '18.4',
    });

    expect(after).toEqual({
      guardianName: '[redacted]',
      guardianPhone: '[redacted]',
      /* Facts about the PATIENT, not about a person. "Somebody corrected this
         record from Dog to Cat" is what the trail is for, and a weight
         identifies nobody — see the note beside these keys in audit.service.ts. */
      species: 'Dog',
      breed: 'Indie',
      weightKg: '18.4',
    });
  });

  it('redacts an invoice’s customer block, which is the patient', () => {
    const { after } = diffSnapshots(undefined, {
      customerName: 'Meenakshi Varadarajan',
      customerPhone: '+919845011223',
      customerEmail: 'meenakshi@example.test',
      customerAddress: '12, Cross Road, Bengaluru',
      customerTaxId: '29AAACR1234K1ZP',
      patientId: 'a3f1…',
    });

    expect(after).toEqual({
      customerName: '[redacted]',
      customerPhone: '[redacted]',
      customerEmail: '[redacted]',
      customerAddress: '[redacted]',
      /* The two identifiers a reader follows are NOT redacted, deliberately:
         one is a business's public tax number, the other names nobody. */
      customerTaxId: '29AAACR1234K1ZP',
      patientId: 'a3f1…',
    });
  });

  /** Both columns say so in the schema, and neither was in the set until now. */
  it('redacts the free text on an invoice while still reporting that it moved', () => {
    const { before, after } = diffSnapshots(
      { notes: null, cancellationReason: null },
      { notes: 'Discussed at the counter', cancellationReason: 'Duplicate of INV-2026-…' }
    );

    expect(before).toEqual({ notes: '[redacted]', cancellationReason: '[redacted]' });
    expect(after).toEqual({ notes: '[redacted]', cancellationReason: '[redacted]' });
  });
});
