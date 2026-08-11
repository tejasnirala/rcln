/**
 * The permission catalogue — one row per code in `@rcln/permissions`.
 *
 * Returns the code→id map, which `seedSystemRoles` needs to attach grants.
 */
import { ALL_PERMISSIONS, moduleOf, type PermissionCode } from '@rcln/permissions';

import { prisma } from './client.js';

function describe(code: PermissionCode): string {
  const [, ...rest] = code.split('.');
  return rest.join(' ').replace(/_/g, ' ');
}

export async function seedPermissions(): Promise<Map<PermissionCode, string>> {
  const ids = new Map<PermissionCode, string>();

  for (const code of ALL_PERMISSIONS) {
    const parts = code.split('.');
    const row = await prisma.permission.upsert({
      where: { code },
      update: {},
      create: {
        code,
        module: moduleOf(code),
        action: parts[parts.length - 1] ?? 'unknown',
        description: describe(code),
      },
    });
    ids.set(code, row.id);
  }

  console.warn(`  permissions      ${ids.size}`);
  return ids;
}
