/**
 * Telling a patient what happened to their order (PI-24).
 *
 * ⚠️ ENQUEUED AFTER THE TRANSACTION COMMITS, NEVER INSIDE IT. A job the worker
 *   picks up before the commit lands reads the order in its previous state and
 *   sends the wrong message — or finds nothing at all. And a queue that is down
 *   must not roll back a dispatch that physically happened, which is why every
 *   failure here is logged rather than thrown, exactly as `requestInvoicePdf`
 *   argues for the invoice PDF.
 *
 * ⚠️ IDS ONLY. The payload is a Redis key that outlives the job and appears in
 *   any dashboard attached to the queue. The worker reads the patient's address
 *   and the order's number from Postgres inside `withTenant`, where RLS applies.
 *   Nothing about the medicine, the patient or the address goes through here.
 */
import { QUEUE, jobId, type NOTIFICATION_JOB, type OnlineOrderNotificationJob } from '@rcln/queue';
import type { TenantContext } from '@rcln/db';

import { getJobProducer } from '../../queue/producer.js';
import { logger } from '../../utils/logger.js';

type OrderEvent =
  | typeof NOTIFICATION_JOB.ONLINE_ORDER_CONFIRMED
  | typeof NOTIFICATION_JOB.ONLINE_ORDER_SHIPPED
  | typeof NOTIFICATION_JOB.ONLINE_ORDER_DELIVERY_FAILED;

export async function notifyAboutOrder(
  ctx: TenantContext,
  event: OrderEvent,
  order: { id: string; branchId: string }
): Promise<void> {
  const job: OnlineOrderNotificationJob = {
    organizationId: ctx.organizationId,
    branchId: order.branchId,
    onlineOrderId: order.id,
    actorUserId: ctx.userId,
  };

  try {
    await getJobProducer().add(QUEUE.NOTIFICATIONS, event, job, {
      jobId: jobId.orderNotification(order.id, event),
    });
  } catch (error) {
    logger.error(
      {
        organizationId: ctx.organizationId,
        onlineOrderId: order.id,
        event,
        code: 'ORDER_NOTIFICATION_ENQUEUE_FAILED',
        error: error instanceof Error ? error.message : 'unknown',
      },
      'could not enqueue the order notification'
    );
  }
}
