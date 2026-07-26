import { Router, type IRouter } from 'express';
import authRoutes from './auth.routes.js';
import branchRoutes from './branches.routes.js';
import healthRoutes from './health.routes.js';
import invitationRoutes from './invitations.routes.js';
import memberRoutes from './members.routes.js';
import platformRoutes from './platform.routes.js';
import publicRoutes from './public.routes.js';
import roleRoutes from './roles.routes.js';

const router: IRouter = Router();

// Phase 1 still to mount here: /settings.
router.use('/health', healthRoutes);

// Sign-in. Deliberately NOT behind requireTenant — it must also serve the apex
// and admin hosts, where a platform admin has no tenant. See auth.routes.ts.
router.use('/auth', authRoutes);

// Apex-domain marketing site. Unauthenticated and pre-tenant on purpose —
// see the header comment in public.routes.ts before adding anything here.
router.use('/public', publicRoutes);

// Super-admin console on admin.<root-domain>. Outside every tenant; gated on
// users.is_platform_admin, which answers 404 rather than 403.
router.use('/platform', platformRoutes);

// A clinic's own subdomain. The first router behind requireTenant, and the
// template for the tenant-scoped routers that follow it.
router.use('/branches', branchRoutes);

// Issuing invitations. Accepting one is on /auth, because the person accepting
// has no membership here yet — see the header of invitations.routes.ts.
router.use('/invitations', invitationRoutes);

// Custom roles, and who holds what. Both act on rows that carry a RESTRICTIVE
// branch_isolation policy, where an out-of-scope write is a silent no-op rather
// than an error — see services/iam/guards.ts.
router.use('/roles', roleRoutes);
router.use('/members', memberRoutes);

export default router;
