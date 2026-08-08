import { Router, type IRouter } from 'express';
import auditRoutes from './audit.routes.js';
import authRoutes from './auth.routes.js';
import billingRoutes from './billing.routes.js';
import appointmentRoutes from './appointments.routes.js';
import branchRoutes from './branches.routes.js';
import clinicalTaxonomyRoutes from './clinical-taxonomy.routes.js';
import healthRoutes from './health.routes.js';
import invitationRoutes from './invitations.routes.js';
import doctorRoutes from './doctors.routes.js';
import designationRoutes from './designations.routes.js';
import memberRoutes from './members.routes.js';
import organizationRoutes from './organization.routes.js';
import patientRoutes from './patients.routes.js';
import platformRoutes from './platform.routes.js';
import publicRoutes from './public.routes.js';
import roleRoutes from './roles.routes.js';

const router: IRouter = Router();

router.use('/health', healthRoutes);

// Sign-in. Deliberately NOT behind requireTenant — it must also serve the apex
// and admin hosts, where a platform admin has no tenant. See auth.routes.ts.
router.use('/auth', authRoutes);

// Apex-domain marketing site. Unauthenticated and pre-tenant on purpose —
// see the header comment in public.routes.ts before adding anything here.
router.use('/public', publicRoutes);

// Super-admin console on admin.<root-domain>. Outside every tenant; gated on
// users.is_platform_admin, which answers 404 rather than 403. Impersonation
// STARTS here and is redeemed on /auth, because only the clinic's own host can
// be given a session cookie for it — see impersonation.service.ts.
router.use('/platform', platformRoutes);

// A clinic's own subdomain. The first router behind requireTenant, and the
// template for the tenant-scoped routers that follow it.
router.use('/branches', branchRoutes);

// Issuing invitations. Accepting one is on /auth, because the person accepting
// has no membership here yet — see the header of invitations.routes.ts.
router.use('/invitations', invitationRoutes);

// Doctors and their working hours — the input the availability engine reads.
// Carries no PHI: a doctor is staff, not a patient.
router.use('/doctors', doctorRoutes);

// What a practitioner is TRAINED IN — the hierarchical classification tree.
// Its own surface rather than a path under /doctors, because a procedure and a
// service will reference these nodes too: the taxonomy outlives the one screen
// that first needed it. Reads sit behind DOCTOR_READ so every screen showing a
// doctor can render their specialty name; curation is DOCTOR_MASTER_MANAGE.
router.use('/clinical-taxonomy', clinicalTaxonomyRoutes);

// Job titles. Its own surface rather than a path under /members, which would be
// swallowed by /members/:membershipId.
router.use('/designations', designationRoutes);

// ⚠️ THE FIRST PHI SURFACE. Every read under here writes a `data_access_logs`
// row, and `patients` deliberately carries NO branch_isolation policy — the
// branch boundary is on `patient_registrations` instead (ADR-0016). Read the
// header of patients.routes.ts before adding an endpoint to it.
router.use('/patients', patientRoutes);

// Bookings, and the availability engine behind them. PHI too: a patient, a
// doctor and a reason disclose more together than any one of them does. Unlike
// `patients`, `appointments` IS branch-scoped — identity follows the person,
// attendance belongs to the clinic it happened at.
router.use('/appointments', appointmentRoutes);

// Custom roles, and who holds what. Both act on rows that carry a RESTRICTIVE
// branch_isolation policy, where an out-of-scope write is a silent no-op rather
// than an error — see services/iam/guards.ts.
router.use('/roles', roleRoutes);
router.use('/members', memberRoutes);

// The clinic's own record, and its settings. Singular and with no id in the
// path: which organization this is was decided by the Host header. Both tables
// behind it are RLS-EXEMPT, so the scoping is entirely in the service — read the
// headers of organization.service.ts and setting.service.ts before touching it.
router.use('/organization', organizationRoutes);

// What the clinic pays and how. Reading and changing it are separate
// permissions, because downloading last month's invoice and cancelling the
// subscription are not the same decision.
//
// The provider's side of this is NOT here: webhooks are mounted directly on the
// app, ahead of the body parsers, because they must see the raw bytes they were
// signed over. See the header of webhooks.routes.ts.
router.use('/billing', billingRoutes);

// A record's own history, for any record in this clinic. Read-only, and the only
// way rows leave `audit_logs` — which is append-only at the database, not merely
// by convention. See audit.routes.ts.
router.use('/audit', auditRoutes);

export default router;
