/**
 * The prose half of the documentation: what each endpoint is for, what comes
 * back, and what a real call looks like.
 *
 * ⚠️ EVERY KEY IS CHECKED AGAINST THE ROUTERS. `tests/unit/openapi.test.ts`
 *   fails on a key that matches no route, so an endpoint renamed or deleted
 *   cannot leave a paragraph behind describing something that is no longer
 *   there. The reverse — a route with no entry here — is reported as coverage
 *   rather than as a failure, because a new endpoint should not block a deploy
 *   on its documentation.
 *
 * One file per domain, keyed `METHOD /full/path` with the path exactly as
 * OpenAPI writes it (`{branchId}`, not `:branchId`).
 */
import type { Tag } from '../mounts.js';
import type { DocRegistry } from '../types.js';

import { authDocs } from './auth.js';
import { branchDocs } from './branches.js';
import { patientDocs } from './patients.js';

export const DOCS: DocRegistry = {
  ...authDocs,
  ...branchDocs,
  ...patientDocs,
};

/** What each section of the API is, in one paragraph a stranger can read. */
export const TAG_DESCRIPTIONS: Partial<Record<Tag, string>> = {
  Health: 'Liveness and readiness. Unauthenticated, and excluded from request logging.',
  Authentication:
    'Signing in, refreshing, signing out, and moving between branches and organizations. Deliberately NOT behind the tenant guard: it also serves the apex and admin hosts, where a platform administrator has no clinic.',
  Public: 'The apex marketing site. Unauthenticated and pre-tenant.',
  Organization:
    "The clinic's own record and its settings. Singular, with no id in the path — which clinic this is was decided by the `Host` header.",
  Branches:
    'The places a clinic operates from. A solo clinic has one; a hospital group has several. Opening hours and closures live here.',
  'Members & Roles':
    'Who works here, what they may do, and how they were invited. Roles are held per branch, so the same person can be an administrator at one location and a receptionist at another.',
  Doctors:
    'Practitioners, their working hours, and the classification tree of what they are trained in. Carries no patient data — a doctor is staff.',
  Patients:
    'The people a clinic treats: identity, contact details, allergies, conditions and medications. **Every read here discloses PHI and is logged.**',
  Appointments:
    'Bookings and the availability engine behind them. PHI: a patient, a doctor and a reason disclose more together than any one of them alone.',
  'Clinical record':
    'What the doctor recorded — consultations, diagnoses, prescriptions, investigations and advice. **PHI throughout.** Authoring the record belongs to doctors alone among the system roles; reading it does not.',
  'Clinical configuration':
    'What a consultation form LOOKS like, and the body charts it draws on. Names no patient, so it sits behind its own permission rather than a clinical one.',
  'Product catalogue':
    'What a thing IS — one catalogue for medicines, gloves, implants, reagents and dental materials, plus the masters they point at. Nothing here carries a quantity.',
  Inventory:
    'Where stock is and how much of it exists: locations, batches, serials, movements, transfers and reservations. The other half of the catalogue.',
  Procurement:
    'How stock enters the system and where cost comes from — suppliers, requisitions, purchase orders, goods receipts and returns.',
  Pharmacy:
    'The dispensing counter: the queue, the supply, returns and the dashboard over them. **The most PHI-dense surface in the product.**',
  Regulatory:
    'What the law allows. Read-only from a clinic — jurisdictions, regulators and rule packs are platform data identical for every clinic in a country.',
  'Charging & consumption':
    'The seam between what was supplied and what is billed, and what a procedure actually consumed. Two facts, deliberately not derived from each other.',
  'Invoicing & tax':
    'What the clinic bills a PATIENT, the registrations it bills under, and what a visit costs. Not the subscription rcln charges the clinic — that is Billing.',
  'Recall & traceability':
    "A manufacturer's notice and the work it starts: which lots are still on which shelf, and which named people already received the product.",
  'Billing (subscription)':
    'What the clinic pays rcln, and how. Reading the invoice and cancelling the subscription are separate permissions.',
  Audit: "A record's own history. Read-only — `audit_logs` is append-only at the database.",
  'Platform admin':
    'The super-admin console on the admin host, outside every tenant. A caller without the flag is answered `404`, never `403`.',
  Webhooks:
    'Payment providers posting to us. Mounted ahead of the body parsers so the raw signed bytes survive; authenticated by signature, not by token.',
};
