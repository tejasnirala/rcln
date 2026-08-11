/**
 * The built-in roles (`organization_id` NULL, `is_system` true) and their grants.
 *
 * Depends on `seedPermissions` having run: it takes that code→id map.
 */
import { SYSTEM_ROLE_DEFINITIONS, type PermissionCode } from '@rcln/permissions';

import { prisma } from './client.js';

export async function seedSystemRoles(permissionIds: Map<PermissionCode, string>): Promise<void> {
  for (const def of SYSTEM_ROLE_DEFINITIONS) {
    // Prisma cannot target a compound unique with a NULL component, so this is
    // find-then-write rather than upsert. Uniqueness is still guaranteed by the
    // NULLS NOT DISTINCT index in the 20260725060000 migration.
    const existing = await prisma.role.findFirst({
      where: { organizationId: null, code: def.code },
    });

    const role = existing
      ? await prisma.role.update({
          where: { id: existing.id },
          data: { name: def.name, description: def.description, scopeLevel: def.scopeLevel },
        })
      : await prisma.role.create({
          data: {
            organizationId: null,
            code: def.code,
            name: def.name,
            description: def.description,
            scopeLevel: def.scopeLevel,
            isSystem: true,
          },
        });

    // Re-sync grants so editing roles.ts and re-seeding actually takes effect.
    await prisma.rolePermission.deleteMany({ where: { roleId: role.id } });
    await prisma.rolePermission.createMany({
      data: def.permissions
        .map((code) => permissionIds.get(code))
        .filter((id): id is string => Boolean(id))
        .map((permissionId) => ({ roleId: role.id, permissionId })),
      skipDuplicates: true,
    });
  }

  console.warn(`  system roles     ${SYSTEM_ROLE_DEFINITIONS.length}`);
}
