import type { ResolvedTenant } from '../middleware/tenant.middleware.js';

declare global {
  namespace Express {
    interface Request {
      /** Set by resolveTenant from the Host header. Absent on platform routes. */
      tenant?: ResolvedTenant;
      /** Set by the authenticate middleware once a JWT is verified. */
      auth?: {
        userId: string;
        sessionId: string;
        isPlatformAdmin: boolean;
        membershipId: string | null;
        organizationId: string | null;
        branchId: string | null;
        branchScope: string[];
        impersonatedByUserId: string | null;
      };
    }
  }
}

export {};
