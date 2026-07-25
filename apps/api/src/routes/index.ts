import { Router, type IRouter } from 'express';
import v1Routes from './v1/index.js';

const router: IRouter = Router();

// API versioning
router.use('/v1', v1Routes);

// // Default redirect to v1
// router.use('/', v1Routes);

export default router;
