import { z } from 'zod';
import { email, phone } from './common.js';

/**
 * The apex marketing site (rcln.com). Everything here is pre-tenant: it is
 * submitted by someone who has no organization, no membership and no login, so
 * none of it can be tenant-scoped and all of it is public input.
 */

/**
 * A demo request from the landing page.
 *
 * Contact details only — never clinical data. Somebody will paste a patient's
 * problem into `message` eventually, so treat it as free text that a human
 * reads and nothing downstream parses.
 */
export const demoRequestInput = z.object({
  clinicName: z.string().trim().min(2, 'tell us the clinic name').max(255),
  contactName: z.string().trim().min(2, 'tell us who to ask for').max(255),
  email,
  phone,
  city: z.string().trim().max(100).optional(),
  branchCount: z.coerce.number().int().min(1).max(500).optional(),
  specialty: z.string().trim().max(120).optional(),
  message: z.string().trim().max(2000).optional(),

  /**
   * Bot trap. A real person never sees this field, so anything in it is a
   * script filling every input on the page. Named plausibly on purpose.
   *
   * Deliberately NOT constrained to empty here. Rejecting it in validation
   * returns an error naming this exact field, which teaches a bot to leave it
   * alone next time. The route accepts it, answers as if it succeeded, and
   * throws the submission away instead.
   */
  website: z.string().max(255).optional(),

  /**
   * Milliseconds between the form rendering and the submit. Scripts post
   * immediately; people take seconds. Coerced because it arrives from FormData
   * as a string.
   */
  elapsedMs: z.coerce.number().int().min(0).max(86_400_000).optional(),
});

export type DemoRequestInput = z.infer<typeof demoRequestInput>;

export const demoRequestResponse = z.object({
  /**
   * Always true for any well-formed submission, whether or not it was stored.
   * A caller must not be able to tell a duplicate from a first-time request —
   * that would turn this endpoint into a "does this clinic use rcln" oracle.
   */
  received: z.literal(true),
});

export type DemoRequestResponse = z.infer<typeof demoRequestResponse>;
