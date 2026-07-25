import { Router, type IRouter, type Request, type Response } from 'express';
import { unsafeDbClient } from '@rcln/db/unsafe';
import { sendSuccess } from '../../utils/response.js';
import { redis } from '../../utils/redis.js';
import { config } from '../../config/index.js';

const router: IRouter = Router();

/** Liveness: is the process up. Must not touch the database. */
router.get('/', (_req: Request, res: Response) => {
  sendSuccess(
    res,
    { status: 'healthy', timestamp: new Date().toISOString(), environment: config.env },
    'Service is healthy'
  );
});

/** Readiness: can we actually serve traffic. Checked by the load balancer. */
router.get('/ready', async (_req: Request, res: Response) => {
  const checks: Record<string, string> = {};

  try {
    await unsafeDbClient().$queryRawUnsafe('SELECT 1');
    checks['database'] = 'connected';
  } catch {
    checks['database'] = 'disconnected';
  }

  try {
    await redis.ping();
    checks['redis'] = 'connected';
  } catch {
    checks['redis'] = 'disconnected';
  }

  const ready = Object.values(checks).every((v) => v === 'connected');

  if (!ready) {
    res.status(503).json({
      success: false,
      message: 'Service not ready',
      data: { status: 'not_ready', timestamp: new Date().toISOString(), ...checks },
    });
    return;
  }

  sendSuccess(
    res,
    { status: 'ready', timestamp: new Date().toISOString(), ...checks },
    'Service is ready'
  );
});

export default router;
