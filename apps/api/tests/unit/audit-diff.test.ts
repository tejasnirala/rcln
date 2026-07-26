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
    const { before, after } = diffSnapshots({ gstNumber: null }, { gstNumber: '27AAAAA0000A1Z5' });
    expect(before).toEqual({ gstNumber: null });
    expect(after).toEqual({ gstNumber: '27AAAAA0000A1Z5' });
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
});
