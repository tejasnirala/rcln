import { Router, type IRouter } from 'express';
import healthRoutes from './health.routes.js';

const router: IRouter = Router();

// Phase 1 mounts /auth, /organizations, /branches, /members here.
router.use('/health', healthRoutes);

export default router;
