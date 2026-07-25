export {
  createDbClient,
  getDbClient,
  assertRlsActive,
  disconnectDb,
  type DbConfig,
} from './client.js';
export { withTenant, forTenant, type TenantContext, type TenantClient } from './tenant.js';

// Re-export the generated client: enums, model types, and `Prisma` (error
// classes, input types). Consumers should never import @prisma/client directly.
export * from '@rcln/db/generated';
