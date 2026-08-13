import { PERMISSIONS } from '@rcln/permissions';
import { getSession } from '@/lib/session';

/**
 * What this caller may do under `/procurement`, resolved once.
 *
 * ⚠️ EXTRACTED BECAUSE FOURTEEN PAGES ASK THE SAME QUESTION AND ONE OF THEM WOULD
 *   OTHERWISE ASK IT DIFFERENTLY. Each screen still decides which flag it needs and
 *   what to render without it; this only makes sure they are all reading the same
 *   codes. The API refuses the request regardless — a screen that renders a button
 *   somebody may not use produces a 403, and one that hides a button they may use is
 *   a worse map.
 */
export interface ProcurementAccess {
  canManageSuppliers: boolean;
  canRequisition: boolean;
  canApprove: boolean;
  canReadOrders: boolean;
  canManageOrders: boolean;
  canReceive: boolean;
  canReadStock: boolean;
  /** Whether any of the above is true — i.e. whether the section is theirs at all. */
  any: boolean;
}

export async function procurementAccess(slug: string): Promise<ProcurementAccess> {
  const session = await getSession(slug);
  const permissions = session?.permissions ?? [];
  const has = (code: string): boolean => permissions.includes(code);

  const access = {
    canManageSuppliers: has(PERMISSIONS.SUPPLIER_MANAGE),
    canRequisition: has(PERMISSIONS.REQUISITION_CREATE),
    canApprove: has(PERMISSIONS.REQUISITION_APPROVE),
    canReadOrders: has(PERMISSIONS.PURCHASE_ORDER_READ),
    canManageOrders: has(PERMISSIONS.PURCHASE_ORDER_MANAGE),
    canReceive: has(PERMISSIONS.GOODS_RECEIPT_MANAGE),
    canReadStock: has(PERMISSIONS.STOCK_READ),
  };

  return { ...access, any: Object.values(access).some(Boolean) };
}
