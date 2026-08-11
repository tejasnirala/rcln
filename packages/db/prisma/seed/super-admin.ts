/**
 * The super admin — the one account never created through the UI.
 */
import { hash } from '@node-rs/argon2';

import { prisma } from './client.js';

// Argon2id parameters. OWASP baseline: 19 MiB memory, 2 iterations, 1 lane.
const ARGON2 = { memoryCost: 19_456, timeCost: 2, parallelism: 1 } as const;

export async function seedSuperAdmin(): Promise<void> {
  const email = process.env['SUPERADMIN_EMAIL'] ?? 'superadmin@rcln.local';
  const password = process.env['SUPERADMIN_PASSWORD'];
  const fullName = process.env['SUPERADMIN_NAME'] ?? 'Platform Super Admin';

  if (!password) {
    console.warn('  super admin      SKIPPED (SUPERADMIN_PASSWORD not set)');
    return;
  }

  if (process.env['NODE_ENV'] === 'production' && password.length < 16) {
    throw new Error('SUPERADMIN_PASSWORD must be at least 16 characters in production');
  }

  const user = await prisma.user.upsert({
    where: { email },
    update: { isPlatformAdmin: true, status: 'ACTIVE' },
    create: {
      email,
      fullName,
      passwordHash: await hash(password, ARGON2),
      status: 'ACTIVE',
      isPlatformAdmin: true,
      emailVerifiedAt: new Date(),
    },
  });

  console.warn(`  super admin      ${user.email}`);
}
