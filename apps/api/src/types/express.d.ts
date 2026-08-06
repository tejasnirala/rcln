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
        /**
         * The session's IDLE deadline, off the row `authenticate` already read,
         * and a sliding one — `rotateRefreshToken` pushes it forward on every
         * refresh. Not a date to show anybody: it moves.
         */
        sessionExpiresAt: Date;
        /**
         * When the session began.
         *
         * The anchor for the impersonation ceiling, which is the only "when does
         * this end" anyone can be told truthfully — an ordinary session renews for
         * as long as it is used, and an impersonation renews only up to eight
         * hours from here. See `impersonationDeadline`.
         */
        sessionStartedAt: Date;
      };
    }
  }
}

export {};
