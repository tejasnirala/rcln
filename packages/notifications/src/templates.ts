import type { EmailTemplate } from './types.js';

/**
 * Email bodies.
 *
 * Plain functions over the same `vars` bag the sender interface already passes,
 * deliberately: a template engine buys nothing for three transactional emails,
 * and a rendering step that can throw sits directly in front of the only channel
 * by which an invited user can reach the product.
 *
 * NO PHI, EVER. These bodies are handed to an external relay and are stored in
 * plain text at the far end. Invitation links and verification codes only —
 * never a patient name, never a diagnosis. See CLAUDE.md.
 */

export interface RenderedEmail {
  subject: string;
  text: string;
  html: string;
}

/** Every value that reaches the HTML body goes through this. */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * A missing var is a programming error at the call site, not something to
 * paper over with an empty string — an invitation email whose link renders as
 * `` is worse than one that fails loudly next to the row that caused it.
 */
function required(vars: Record<string, string>, key: string, template: EmailTemplate): string {
  const value = vars[key];
  if (!value) throw new Error(`email template ${template} requires a '${key}' variable`);
  return value;
}

function layout(heading: string, bodyHtml: string): string {
  return [
    '<!doctype html>',
    '<html><body style="margin:0;padding:24px;background:#f6f7f9;',
    'font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Helvetica,Arial,sans-serif;color:#1a1d21">',
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center">',
    '<table role="presentation" width="520" cellpadding="0" cellspacing="0" ',
    'style="max-width:520px;background:#ffffff;border-radius:12px;padding:32px">',
    `<tr><td><h1 style="margin:0 0 16px;font-size:20px;line-height:1.3">${escapeHtml(heading)}</h1>`,
    bodyHtml,
    '<p style="margin:24px 0 0;font-size:12px;color:#6b7280">rcln — clinic management</p>',
    '</td></tr></table></td></tr></table></body></html>',
  ].join('');
}

function button(link: string, label: string): string {
  const href = escapeHtml(link);
  return [
    `<p style="margin:0 0 24px"><a href="${href}" `,
    'style="display:inline-block;background:#1a1d21;color:#ffffff;text-decoration:none;',
    `padding:12px 20px;border-radius:8px;font-size:14px">${escapeHtml(label)}</a></p>`,
    '<p style="margin:0;font-size:12px;color:#6b7280">If the button does not work, paste this ',
    `into your browser:<br><span style="word-break:break-all">${href}</span></p>`,
  ].join('');
}

export function renderEmail(template: EmailTemplate, vars: Record<string, string>): RenderedEmail {
  switch (template) {
    case 'INVITE':
    case 'INVITE_REMINDER': {
      const link = required(vars, 'link', template);
      const days = vars['expiresInDays'];
      const expiry = days ? `This link expires in ${days} day${days === '1' ? '' : 's'}.` : '';
      const reminder = template === 'INVITE_REMINDER';

      return {
        subject: reminder ? 'Reminder: your rcln invitation' : 'You have been invited to rcln',
        text: [
          reminder
            ? 'A reminder that you have been invited to join a clinic on rcln.'
            : 'You have been invited to join a clinic on rcln.',
          '',
          'Accept the invitation:',
          link,
          '',
          expiry,
          'If you were not expecting this, you can ignore this email.',
        ].join('\n'),
        html: layout(
          reminder ? 'Your invitation is still waiting' : 'You have been invited to rcln',
          [
            '<p style="margin:0 0 24px;font-size:14px;line-height:1.6">',
            'Accept the invitation to set up your account and join the clinic.',
            expiry ? ` ${escapeHtml(expiry)}` : '',
            '</p>',
            button(link, 'Accept invitation'),
          ].join('')
        ),
      };
    }

    case 'VERIFY_EMAIL': {
      const code = required(vars, 'code', template);

      return {
        subject: `${code} is your rcln verification code`,
        text: [
          `Your rcln verification code is ${code}.`,
          '',
          'Enter it on the verification screen to confirm this email address.',
          'If you did not request it, ignore this email.',
        ].join('\n'),
        html: layout(
          'Confirm your email address',
          [
            '<p style="margin:0 0 24px;font-size:14px;line-height:1.6">',
            'Enter this code on the verification screen:</p>',
            '<p style="margin:0 0 24px;font-size:32px;font-weight:600;letter-spacing:6px">',
            escapeHtml(code),
            '</p>',
            '<p style="margin:0;font-size:12px;color:#6b7280">',
            'If you did not request this, you can ignore this email.</p>',
          ].join('')
        ),
      };
    }

    /*
     * ⚠️ THE THREE DELIVERY EMAILS CARRY A REFERENCE AND A STATUS AND NOTHING
     *   ELSE, AND THAT IS THE WHOLE DESIGN. No patient name, no medicine, no
     *   quantity, no clinic name — because each of those, in an inbox and on a
     *   relay's disk, is a statement about somebody's health. "Your metformin
     *   has shipped" names a condition to anyone who reads the notification on a
     *   lock screen. The reference is meaningless to a stranger and sufficient
     *   to the patient, and everything else is one sign-in away.
     *
     *   `link` therefore goes to the ORDER, behind authentication. If a future
     *   template needs to say more than this, that is a PHI decision and not a
     *   copy change.
     */
    case 'ORDER_CONFIRMED': {
      const reference = required(vars, 'reference', template);
      const link = required(vars, 'link', template);

      return {
        subject: `Your order ${reference} is confirmed`,
        text: [
          `Your pharmacy order ${reference} has been confirmed and is being prepared.`,
          '',
          'Sign in to see what is on it:',
          link,
        ].join('\n'),
        html: layout(
          'Your order is confirmed',
          [
            '<p style="margin:0 0 24px;font-size:14px;line-height:1.6">',
            `Order ${escapeHtml(reference)} has been confirmed and is being prepared. `,
            'Sign in to see the details.</p>',
            button(link, 'View your order'),
          ].join('')
        ),
      };
    }

    case 'ORDER_SHIPPED': {
      const reference = required(vars, 'reference', template);
      const link = required(vars, 'link', template);
      const tracking = vars['tracking'];

      return {
        subject: `Your order ${reference} is on its way`,
        text: [
          `Your pharmacy order ${reference} has been dispatched.`,
          tracking ? `Tracking reference: ${tracking}` : '',
          '',
          'Sign in to see the details:',
          link,
        ]
          .filter(Boolean)
          .join('\n'),
        html: layout(
          'Your order is on its way',
          [
            '<p style="margin:0 0 24px;font-size:14px;line-height:1.6">',
            `Order ${escapeHtml(reference)} has been dispatched.`,
            tracking ? ` Tracking reference: ${escapeHtml(tracking)}.` : '',
            '</p>',
            button(link, 'View your order'),
          ].join('')
        ),
      };
    }

    case 'ORDER_DELIVERY_FAILED': {
      const reference = required(vars, 'reference', template);
      const link = required(vars, 'link', template);

      return {
        subject: `Your order ${reference} could not be delivered`,
        /*
         * ⚠️ THE REASON IS NOT IN THE BODY. `failure_reason` is free text a
         *   courier or a pharmacist wrote about a named person's address, and
         *   the schema calls it PHI-adjacent for that reason. It stays behind
         *   the sign-in.
         */
        text: [
          `Your pharmacy order ${reference} could not be delivered.`,
          '',
          'Sign in to see what happened and arrange another attempt:',
          link,
        ].join('\n'),
        html: layout(
          'Your order could not be delivered',
          [
            '<p style="margin:0 0 24px;font-size:14px;line-height:1.6">',
            `Order ${escapeHtml(reference)} could not be delivered. `,
            'Sign in to see what happened and arrange another attempt.</p>',
            button(link, 'View your order'),
          ].join('')
        ),
      };
    }

    /*
     * The one that goes to STAFF rather than to a patient, and it still names no
     * product: a medicine about to expire at a named clinic is a fact about
     * stock, but the list is long, changes hourly and belongs on the screen that
     * can act on it. The count is what decides whether somebody opens it.
     */
    case 'STOCK_EXPIRING': {
      const count = required(vars, 'count', template);
      const link = required(vars, 'link', template);
      const days = vars['withinDays'] ?? '30';

      return {
        subject: `${count} batch${count === '1' ? '' : 'es'} expiring within ${days} days`,
        text: [
          `${count} batch${count === '1' ? '' : 'es'} at your branch expire within ${days} days.`,
          '',
          'Review them here:',
          link,
        ].join('\n'),
        html: layout(
          'Stock is expiring',
          [
            '<p style="margin:0 0 24px;font-size:14px;line-height:1.6">',
            `${escapeHtml(count)} batch${count === '1' ? '' : 'es'} at your branch expire within `,
            `${escapeHtml(days)} days. Review them and decide what to do.</p>`,
            button(link, 'Review expiring stock'),
          ].join('')
        ),
      };
    }
  }
}
