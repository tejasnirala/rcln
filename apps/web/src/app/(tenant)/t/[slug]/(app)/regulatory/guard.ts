import { PERMISSIONS } from '@rcln/permissions';
import { getSession } from '@/lib/session';

/**
 * What this caller may do under `/regulatory`, resolved once.
 *
 * ⚠️ ONE FLAG, BECAUSE THERE IS ONE THING TO DO HERE: READ. A clinic never
 *   writes a rule pack — `regulatory.rule.manage` is rcln's, held by nobody at a
 *   clinic, and the database refuses the write regardless. A second flag here
 *   would imply a screen that does not and must not exist.
 *
 * What a clinic DOES maintain is on its products, and is gated by
 * `product.regulatory.manage` on the Catalogue screens.
 */
export async function regulatoryAccess(slug: string): Promise<{ canRead: boolean }> {
  const session = await getSession(slug);
  const permissions = session?.permissions ?? [];
  return { canRead: permissions.includes(PERMISSIONS.REGULATORY_READ) };
}
