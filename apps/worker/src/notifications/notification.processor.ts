/**
 * The notifications processor — the consumer `QUEUE.NOTIFICATIONS` never had.
 *
 * ⚠️ THE QUEUE HAS EXISTED SINCE THE WORKER DID, AND ITS HANDLER LOGGED
 *   "processor not implemented yet". So every pharmacy event that was supposed
 *   to reach somebody reached a log line instead: an accepted online order told
 *   the patient nothing, a dispatch told them nothing, and stock about to expire
 *   told the branch nothing. KNOWN_ISSUES #26 and KI-6. (PI-24.)
 *
 * ── WHAT THIS FILE MAY NOT DO ───────────────────────────────────────────────
 * ⚠️ THE JOB PAYLOAD IS IDS. Everything a message needs is read HERE, inside
 *   `withTenant`, from Postgres — never carried through Redis. A BullMQ payload
 *   is a Redis key that outlives the job and shows in any dashboard attached to
 *   the queue, and CLAUDE.md is unambiguous: ids only, never PHI. That is also
 *   why the recipient's address is looked up at send time rather than captured
 *   at enqueue time — a patient who corrects it in between still gets the
 *   message, and a queue that backs up cannot deliver to an address the clinic
 *   has since removed.
 *
 * ⚠️ THE BODY NAMES NO MEDICINE AND NO PATIENT. See `@rcln/notifications` —
 *   these bodies sit in plain text on a relay and in an inbox on a lock screen.
 *   Reference, status, and a link behind the sign-in.
 *
 * ⚠️ A FAILED SEND MUST NOT UNDO THE THING THAT HAPPENED. The order shipped; the
 *   stock expired. Throwing here asks BullMQ to retry, which is right for a
 *   relay that is briefly down and wrong for an order with no email address on
 *   it — so the first is thrown and the second returns quietly. A patient who
 *   gave no email is not an error.
 */
import { withTenant, type TenantContext } from '@rcln/db';
import {
  NOTIFICATION_JOB,
  type NotificationJobName,
  type OnlineOrderNotificationJob,
  type StockExpiringNotificationJob,
} from '@rcln/queue';
import type { EmailTemplate, NotificationSender } from '@rcln/notifications';

interface Logger {
  info(obj: Record<string, unknown>, msg: string): void;
  warn(obj: Record<string, unknown>, msg: string): void;
  error(obj: Record<string, unknown>, msg: string): void;
}

export interface NotificationDeps {
  sender: NotificationSender;
  logger: Logger;
  /** Where a link should point — the tenant's own host. */
  webUrl: string;
}

/** `https://alpha.rcln.com/pharmacy/orders/<id>` for a clinic on `alpha`. */
function tenantLink(webUrl: string, slug: string, path: string): string {
  const url = new URL(webUrl);
  url.hostname = `${slug}.${url.hostname}`;
  url.pathname = path;
  return url.toString();
}

const ORDER_TEMPLATE: Record<string, EmailTemplate> = {
  [NOTIFICATION_JOB.ONLINE_ORDER_CONFIRMED]: 'ORDER_CONFIRMED',
  [NOTIFICATION_JOB.ONLINE_ORDER_SHIPPED]: 'ORDER_SHIPPED',
  [NOTIFICATION_JOB.ONLINE_ORDER_DELIVERY_FAILED]: 'ORDER_DELIVERY_FAILED',
};

async function notifyAboutOrder(
  jobName: NotificationJobName,
  job: OnlineOrderNotificationJob,
  deps: NotificationDeps
): Promise<void> {
  const template = ORDER_TEMPLATE[jobName];
  if (!template) {
    deps.logger.warn({ jobName }, 'notification: unknown order job — no template for it');
    return;
  }

  const ctx: TenantContext = {
    organizationId: job.organizationId,
    branchIds: [job.branchId],
    userId: job.actorUserId,
  };

  /*
   * ⚠️ THE ADDRESS COMES FROM THE PATIENT'S RECORD, NOT FROM THE ORDER, BECAUSE
   *   THE ORDER HAS NO EMAIL ON IT. Its delivery snapshot carries a name, a
   *   phone and a street address — deliberately frozen at confirm so a later
   *   correction cannot rewrite where a parcel WAS sent. None of that helps
   *   here: the only channel that works today is email (SMS is stubbed pending
   *   TRAI DLT), and the only email the platform holds for a patient is on
   *   `patients`. It is nullable, and a patient without one is the ordinary
   *   case for a counter order rather than an error.
   */
  const details = await withTenant(ctx, (tx) =>
    tx.onlineOrder.findFirst({
      where: { id: job.onlineOrderId },
      select: {
        id: true,
        orderNumber: true,
        patient: { select: { email: true } },
        organization: { select: { slug: true } },
        shipment: { select: { trackingReference: true } },
      },
    })
  );

  if (!details) {
    /* Deleted between the enqueue and the send. Nothing to say and nobody to
     * say it to — a retry would find the same absence. */
    deps.logger.warn({ onlineOrderId: job.onlineOrderId }, 'notification: order is gone');
    return;
  }

  if (!details.patient.email) {
    /* ⚠️ NOT AN ERROR. A counter order taken over the phone has no email on it,
     * and retrying five times will not invent one. */
    deps.logger.info(
      { onlineOrderId: job.onlineOrderId, jobName },
      'notification: order has no email address, nothing sent'
    );
    return;
  }

  /* An order confirmed but not yet numbered still has to be identifiable to the
   * person who placed it, and the id's first block is stable and meaningless to
   * anybody else. */
  const reference = details.orderNumber ?? details.id.slice(0, 8).toUpperCase();
  const tracking = details.shipment?.trackingReference ?? undefined;

  await deps.sender.sendEmail(details.patient.email, template, {
    reference,
    link: tenantLink(deps.webUrl, details.organization.slug, `/pharmacy/orders/${details.id}`),
    ...(tracking ? { tracking } : {}),
  });

  deps.logger.info({ onlineOrderId: details.id, jobName }, 'notification: sent');
}

async function notifyAboutExpiringStock(
  job: StockExpiringNotificationJob,
  deps: NotificationDeps
): Promise<void> {
  const ctx: TenantContext = {
    organizationId: job.organizationId,
    branchIds: [job.branchId],
    userId: job.actorUserId,
  };

  /*
   * ⚠️ WHO GETS IT IS A PERMISSION QUESTION, NOT A ROLE ONE. Everybody at this
   *   branch holding `inventory.stock.read` — because that is exactly the set of
   *   people the screen behind the link will let in, and a mail to somebody who
   *   then gets a 403 is worse than no mail. Roles are clinic-defined and a role
   *   NAME means nothing across two clinics; the code means the same thing
   *   everywhere.
   */
  const recipients = await withTenant(ctx, async (tx) => {
    const rows = await tx.membership.findMany({
      where: {
        status: 'ACTIVE',
        deletedAt: null,
        roles: {
          some: {
            /*
             * ⚠️ A ROLE GRANT HAS A VALIDITY WINDOW, NOT A `deleted_at`. A grant
             *   that has lapsed is still a row, and mailing somebody whose
             *   access ended last month is a disclosure about a branch they can
             *   no longer open.
             */
            AND: [
              { OR: [{ validFrom: null }, { validFrom: { lte: new Date() } }] },
              { OR: [{ validTo: null }, { validTo: { gte: new Date() } }] },
            ],
            /* NULL branch means every branch in the organization — see ADR-0002. */
            OR: [{ branchId: job.branchId }, { branchId: null }],
            role: {
              permissions: { some: { permission: { code: 'inventory.stock.read' } } },
            },
          },
        },
      },
      select: { user: { select: { email: true } }, organization: { select: { slug: true } } },
    });
    return rows;
  });

  const addresses = [
    ...new Set(
      recipients
        .map((row) => row.user.email)
        .filter((email): email is string => email !== null && email !== '')
    ),
  ];
  const slug = recipients[0]?.organization.slug;

  if (addresses.length === 0 || !slug) {
    deps.logger.info(
      { branchId: job.branchId },
      'notification: nobody at this branch can read stock, nothing sent'
    );
    return;
  }

  /*
   * ⚠️ THE AGEING REPORT, NOT `/stock/expiring` — THAT SCREEN DOES NOT EXIST.
   *   The API serves `GET /v1/stock/expiring`, and it is tempting to assume a
   *   page of the same name; there is none, and a mail whose button 404s is
   *   worse than no mail. `inventory-aging` buckets exactly this stock and is a
   *   real route.
   */
  const link = tenantLink(deps.webUrl, slug, '/reports/inventory-aging');
  for (const address of addresses) {
    await deps.sender.sendEmail(address, 'STOCK_EXPIRING', {
      count: String(job.batchCount),
      withinDays: String(job.withinDays),
      link,
    });
  }

  deps.logger.info(
    { branchId: job.branchId, recipients: addresses.length, batches: job.batchCount },
    'notification: expiry alert sent'
  );
}

export async function processNotificationJob(
  jobName: string,
  data: unknown,
  deps: NotificationDeps
): Promise<void> {
  switch (jobName) {
    case NOTIFICATION_JOB.ONLINE_ORDER_CONFIRMED:
    case NOTIFICATION_JOB.ONLINE_ORDER_SHIPPED:
    case NOTIFICATION_JOB.ONLINE_ORDER_DELIVERY_FAILED:
      await notifyAboutOrder(jobName, data as OnlineOrderNotificationJob, deps);
      return;
    case NOTIFICATION_JOB.STOCK_EXPIRING:
      await notifyAboutExpiringStock(data as StockExpiringNotificationJob, deps);
      return;
    default:
      deps.logger.warn({ jobName }, 'notification: unknown job — no processor for it');
  }
}
