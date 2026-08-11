/**
 * The seed's database connection.
 *
 * Seeds write platform-wide rows (permissions, system roles, plans) that no
 * tenant owns, so this connects as the OWNER role, which RLS does not restrict.
 *
 * ⚠️ NEVER import this from application code. It is the RLS-bypassing owner
 *   connection and exists only for seeding. Application code uses
 *   `withTenant(ctx, …)` from `@rcln/db`.
 */
import { config as loadEnv } from 'dotenv';

// Single .env at the repo root; this file sits at packages/db/prisma/seed/.
loadEnv({ path: new URL('../../../../.env', import.meta.url).pathname });

import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../../generated/prisma/index.js';

const connectionString = process.env['DIRECT_DATABASE_URL'];
if (!connectionString) throw new Error('DIRECT_DATABASE_URL is required to seed');

export const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
