/**
 * The WORKER's binding of the movement engine's dependencies.
 *
 * ⚠️ IT IS NOT THE API'S, AND IT CANNOT BE. The API injects `recordAudit` from
 *   its audit service and `loadUnitGraph` from its product service; the worker
 *   cannot import either — they live in an application, and an app-to-app
 *   dependency would pull express and argon2 into a queue consumer. These two
 *   are the same reads and the same write, expressed against `@rcln/db`
 *   directly, and they must stay in step with their API counterparts.
 *
 *   ⚠️ IF THE AUDIT ROW'S SHAPE CHANGES, CHANGE BOTH. Nothing catches these two
 *     drifting; the engine only knows it was handed something with the right
 *     signature. The narrow `MovementDeps` interface is what keeps the surface
 *     small enough for that to be a realistic ask — it is one INSERT and one
 *     pair of SELECTs.
 *
 * ⚠️ EXTRACTED FROM `expiry.processor.ts` IN PI-3, WHEN THE RESERVATION SWEEP
 *   BECAME THE SECOND PROCESSOR TO NEED IT. Two copies of this object in one
 *   application would be two things to keep in step with the API instead of one
 *   — and the whole reason this file carries a warning is that keeping ONE of
 *   them in step is already a manual job.
 */
import type { TxClient } from '@rcln/db';
import { buildUnitGraph, type MovementDeps, type UnitGraph } from '@rcln/inventory';

export const movementDeps: MovementDeps = {
  async recordAudit(tx, ctx, entry) {
    await tx.auditLog.create({
      data: {
        organizationId: ctx.organizationId,
        actorUserId: ctx.userId,
        action: entry.action,
        entityType: entry.entityType,
        entityId: entry.entityId,
        ...(entry.branchId != null ? { branchId: entry.branchId } : {}),
        ...(entry.after !== undefined ? { afterData: entry.after as Record<string, never> } : {}),
      },
    });
  },

  async loadUnitGraph(tx: TxClient): Promise<UnitGraph> {
    /*
     * Loaded WHOLE, exactly as the API's `loadUnitGraph` does. Fetching only the
     * two units a conversion names turns a two-hop path (box -> strip -> tablet)
     * into "no conversion recorded" — silently, and only for products with more
     * than one packaging level.
     */
    const [units, conversions] = await Promise.all([
      tx.unitOfMeasure.findMany({
        where: { isActive: true },
        select: { id: true, code: true, unitClass: true },
      }),
      tx.unitConversion.findMany({
        select: { fromUnitId: true, toUnitId: true, numerator: true, denominator: true },
      }),
    ]);

    return buildUnitGraph(
      units.map((u) => ({ id: u.id, code: u.code, unitClass: u.unitClass })),
      conversions
    );
  },
};
