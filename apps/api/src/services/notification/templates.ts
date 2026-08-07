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
  }
}
