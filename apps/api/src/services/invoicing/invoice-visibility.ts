/**
 * WHICH invoices a caller may see — the §0.7 rule, in one place.
 *
 * The brief asks that a pharmacist see pharmacy invoices and not lab invoices.
 * The obvious implementation is a permission code per module —
 * `pharmacy.invoice.read`, `lab.invoice.read`, … — and it is 12 roles × 7
 * sources of matrix to maintain, with no clean answer for the accountant who
 * should see all of them and a re-grant to everybody every time a source is
 * added.
 *
 * So `billing.invoice.read` stays the gate on the SURFACE, and the set of
 * sources is DERIVED from the modules a caller already works in. A pharmacist
 * holds `pharmacy.dispense.read` because they dispense; that is what makes a
 * pharmacy invoice their business, and no separate grant has to say so twice.
 * `billing.invoice.read_all` is the escape for the roles whose job is the whole
 * ledger.
 *
 * ⚠️ THE RESULT IS APPLIED IN THE QUERY, NOT IN A ROUTE GUARD, AND NEVER AS A
 *   DEFAULT FOR A FILTER THE CALLER PASSES. `?sourceType=LAB` from a pharmacist
 *   must return nothing rather than everything — a filter the client controls is
 *   not a boundary. Same failure shape as the `?doctorProfileId=` override in
 *   the patient search, and it gets the same treatment: the caller's filter
 *   INTERSECTS the visible set, it never replaces it.
 *
 * ⚠️ AND IT IS ONE RULE FOR THREE ROUTES. The list, the detail and the PDF all
 *   consult this function. Three copies of "may this caller see this source" is
 *   how a download link outlives the list it was hidden from.
 */
import { withTenant, type TenantContext } from '@rcln/db';
import { PERMISSIONS, type PermissionCode } from '@rcln/permissions';

import type { InvoiceSourceType } from './invoice-number.service.js';

/**
 * Every source, in the order the enum declares them.
 *
 * Includes the three whose modules do not exist yet: the column carries them,
 * the number series has codes for them, and a caller asking for `LAB` today
 * correctly gets nothing rather than an error about a feature.
 */
export const INVOICE_SOURCE_TYPES = [
  'APPOINTMENT',
  'PROCEDURE',
  'SERVICE',
  'LAB',
  'PHARMACY',
  'INVENTORY',
  'OTHER',
] as const satisfies readonly InvoiceSourceType[];

/**
 * The sources that belong to a module, and the permission that says so.
 *
 * ⚠️ A READ CODE, NEVER A WRITE ONE. `pharmacy.dispense.read` and not
 *   `.create`: the question is whose business the invoice is, and someone who
 *   may look at what was dispensed may look at what it cost. A returns clerk who
 *   cannot dispense still reconciles the bill.
 *
 * Everything NOT in this map — APPOINTMENT, PROCEDURE, SERVICE, OTHER — is the
 * clinic's general billing: what the front desk raises at the counter. It comes
 * with `billing.invoice.read` itself, because a receptionist who cannot see the
 * consultation fee they just charged cannot do their job, and there is no
 * narrower module to hang it on.
 */
const MODULE_GATED = {
  LAB: PERMISSIONS.LAB_ORDER_READ,
  PHARMACY: PERMISSIONS.DISPENSE_READ,
  INVENTORY: PERMISSIONS.STOCK_READ,
} as const satisfies Partial<Record<InvoiceSourceType, PermissionCode>>;

/** The sources any holder of `billing.invoice.read` sees. */
const GENERAL_SOURCES = INVOICE_SOURCE_TYPES.filter((s) => !(s in MODULE_GATED));

export interface InvoiceVisibility {
  /**
   * True when this caller is a clinician without the whole ledger, so the only
   * invoices they may see are their own.
   *
   * ⚠️ SEPARATE FROM THE ID BELOW, AND THE PAIR IS THE WHOLE POINT. A doctor who
   *   has no `doctor_profiles` row yet is still a doctor: scoped, with nothing of
   *   their own to see. Collapsing the two into "null means unscoped" is exactly
   *   the fail-open this had at first — a half-configured clinician read every
   *   consultation in the clinic, because the absence of their profile widened
   *   them instead of narrowing them.
   */
  scopedToOwnWork: boolean;
  /**
   * When set, the caller sees ONLY invoices they are the practitioner on.
   *
   * ⚠️ THE SECOND AXIS OF THIS RULE, AND IT NARROWS RATHER THAN WIDENS. Source
   *   type answers "is this kind of invoice your business?"; this answers "is
   *   this one yours?". A doctor holds `billing.invoice.read` — they have to see
   *   what their own consultations were billed at — and not `.read_all`, so the
   *   clinic's whole ledger is not theirs to read. Both conditions apply
   *   together: a doctor still sees only the SOURCES their modules cover.
   *
   *   Null with `scopedToOwnWork` false is everybody else — a receptionist is
   *   not a clinician and is scoped by source alone, exactly as before. Null
   *   WITH it true is a clinician who has no profile: no invoice can be theirs.
   */
  practitionerProfileId: string | null;

  /**
   * True when the caller holds `billing.invoice.read_all`.
   *
   * Kept as a flag rather than collapsed into "sources is all of them" because
   * the two are different facts: a caller who happens to hold every module's
   * read code today would otherwise be indistinguishable from one granted the
   * whole ledger, and would silently lose sources as new ones are added.
   */
  all: boolean;
  /** The sources this caller may see. Every source when `all`. */
  sources: InvoiceSourceType[];
}

/**
 * Resolve what this caller may see.
 *
 * Takes an async predicate rather than the request, so the rule is a pure
 * function of the permissions held and can be tested without an HTTP layer. The
 * route passes `(p) => callerHasPermission(req, p)`, which is a Redis cache hit:
 * `authorize()` has already warmed the caller's access for this organization on
 * the way in.
 */
export async function resolveInvoiceVisibility(
  holds: (permission: PermissionCode) => Promise<boolean>,
  /**
   * The caller's own doctor profile, when they have one.
   *
   * ⚠️ PASSED IN RATHER THAN LOOKED UP, so this stays a pure function of what
   *   the caller IS and can be tested without a tenant or a transaction — the
   *   same reason `holds` is a predicate. The route resolves it once per
   *   request.
   */
  practitionerProfileId: string | null = null
): Promise<InvoiceVisibility> {
  /*
   * ⚠️ `read_all` WINS OVER BEING A DOCTOR, AND THE ORDER IS THE POINT. A
   *   clinician who is also an administrator — or whom the clinic has explicitly
   *   granted the whole ledger — is not narrowed to their own list. The grant is
   *   the clinic's decision and this must not quietly override it.
   */
  if (await holds(PERMISSIONS.INVOICE_READ_ALL)) {
    return {
      all: true,
      sources: [...INVOICE_SOURCE_TYPES],
      scopedToOwnWork: false,
      practitionerProfileId: null,
    };
  }

  /*
   * ⚠️ BEING A CLINICIAN IS A PERMISSION QUESTION, NOT "DO THEY HAVE A PROFILE
   *   ROW?". Signing a prescription is held by DOCTOR alone among the system
   *   roles — invariant 7 strips it from ORG_OWNER and ORG_ADMIN by name — so it
   *   is the honest test for "this person practises here".
   *
   *   Keying off the profile row instead is what failed open: a member with the
   *   DOCTOR role and no `doctor_profiles` row resolved to "not scoped" and read
   *   the whole clinic's consultations. An authorization boundary that widens
   *   when data is missing is the wrong way round.
   */
  const clinician = await holds(PERMISSIONS.PRESCRIPTION_SIGN);

  const gated = await Promise.all(
    Object.entries(MODULE_GATED).map(async ([source, permission]) =>
      (await holds(permission)) ? (source as InvoiceSourceType) : null
    )
  );

  return {
    all: false,
    sources: [...GENERAL_SOURCES, ...gated.filter((s): s is InvoiceSourceType => s !== null)],
    scopedToOwnWork: clinician,
    practitionerProfileId: clinician ? practitionerProfileId : null,
  };
}

/**
 * May this caller see this one invoice's practitioner?
 *
 * ⚠️ ASKED OF THE DETAIL AND THE PDF, NOT ONLY THE LIST. A scoped caller who
 *   guesses an id, or follows a link to an invoice that has since been
 *   reassigned, must get the same 404 the list gives by omission — three copies
 *   of "may this caller see this row" is how a download outlives the list it was
 *   hidden from, which is the note at the top of this file.
 */
export function canSeePractitioner(
  visibility: InvoiceVisibility,
  practitionerProfileId: string | null
): boolean {
  if (!visibility.scopedToOwnWork) return true;
  /*
   * A clinician with no profile of their own owns no invoice, so nothing
   * matches. Never `null === null` — that would hand them every unattributed
   * counter sale in the clinic.
   */
  if (visibility.practitionerProfileId === null) return false;
  return practitionerProfileId === visibility.practitionerProfileId;
}

/**
 * May this caller see this one invoice?
 *
 * ⚠️ THE ANSWER IS 404 AND NOT 403 WHEN IT IS NO. A 403 on an invoice id
 *   confirms the invoice exists, which is the same probe RLS already refuses to
 *   answer for another tenant's row. "You may not see lab invoices" is a fact
 *   about the caller and belongs in the UI; "invoice X exists" is a fact about
 *   the clinic's business and belongs to nobody who cannot read it.
 */
export function canSeeSource(visibility: InvoiceVisibility, source: InvoiceSourceType): boolean {
  return visibility.all || visibility.sources.includes(source);
}

/**
 * The caller's own doctor profile, or null if they have none.
 *
 * ⚠️ RESOLVED FROM `ctx.userId` AND NEVER FROM ANYTHING THE CALLER SENT. This is
 *   the value the whole scope hangs on: a `?doctorProfileId=` in the query
 *   string deciding whose invoices you see would be an authorization check the
 *   client performs on itself.
 *
 * ⚠️ AND IT IS READ UNDER `withTenant`, so RLS has already established that the
 *   profile belongs to this organization. A doctor who works at two clinics on
 *   the same platform has a profile row in each, and only this tenant's can come
 *   back.
 *
 * ⚠️ NULL NARROWS, IT DOES NOT WIDEN. A soft-deleted or never-created profile
 *   means a clinician with no invoices of their own, and their list comes back
 *   empty. The first version of this reasoned the other way — better a stale
 *   clinician reading the ledger than one whose screen empties — and that was
 *   wrong: an empty list is a visible setup gap somebody fixes, and a doctor
 *   silently reading their colleagues' billing is a disclosure nobody granted.
 */
export async function practitionerProfileFor(ctx: TenantContext): Promise<string | null> {
  return withTenant(ctx, async (tx) => {
    const profile = await tx.doctorProfile.findFirst({
      where: { userId: ctx.userId, deletedAt: null },
      select: { id: true },
    });
    return profile?.id ?? null;
  });
}
