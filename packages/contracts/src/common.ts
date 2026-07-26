import { z } from 'zod';

export const uuid = z.uuid();

/** Subdomain label: what becomes `alpha` in alpha.xyz.com. */
export const slug = z
  .string()
  .min(3)
  .max(63)
  .regex(/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/, 'lowercase letters, digits and hyphens only')
  .refine((s) => !s.includes('--'), 'consecutive hyphens are not allowed');

/**
 * Subdomains the platform keeps for itself. A tenant claiming `api` or `admin`
 * would break routing for everyone, so this is checked at registration.
 */
export const RESERVED_SLUGS = new Set([
  'www',
  'admin',
  'api',
  'app',
  'auth',
  'static',
  'cdn',
  'assets',
  'mail',
  'smtp',
  'ftp',
  'blog',
  'status',
  'help',
  'support',
  'docs',
  'dev',
  'staging',
  'test',
  'demo',
  'billing',
  'account',
  'accounts',
  'login',
  'signup',
  'register',
  'dashboard',
  'internal',
  'system',
  'root',
  'superadmin',
  'platform',
]);

export const availableSlug = slug.refine(
  (s) => !RESERVED_SLUGS.has(s),
  'this subdomain is reserved by the platform'
);

/** E.164, which is what every Indian SMS/WhatsApp provider expects. */
export const phone = z
  .string()
  .regex(/^\+[1-9]\d{7,14}$/, 'must be E.164 format, e.g. +919876543210');

export const email = z.email().max(255).toLowerCase();

/**
 * A real IANA time zone, checked by asking the platform rather than by listing.
 *
 * `Intl` throws `RangeError` on an unknown identifier, which is a cheaper and
 * far more durable check than a hard-coded list that goes stale every time a
 * country changes its mind about DST. The screen offers a short curated select
 * — this is what stops anything else, including a typo arriving over the API.
 *
 * The constructor really does throw here, unlike the currency case below. Both
 * were checked against a deliberately invalid value.
 */
export const timezone = z
  .string()
  .min(1)
  .max(64)
  .refine((value) => {
    try {
      new Intl.DateTimeFormat('en', { timeZone: value });
      return true;
    } catch {
      return false;
    }
  }, 'not a time zone, e.g. Asia/Kolkata');

/**
 * ISO 4217, from the platform's own list.
 *
 * NOT the `Intl.NumberFormat` constructor trick that `timezone` uses above:
 * `new Intl.NumberFormat('en', { currency: 'XYZ' })` does NOT throw. It only
 * checks that the code is three ASCII letters, so that version accepted `XYZ`
 * and stored it — measured, not assumed. `supportedValuesOf` is the API that
 * actually knows the currency list.
 *
 * Built once, lazily, because it is a few hundred strings and most requests
 * never look at a currency. If the runtime is old enough not to have
 * `supportedValuesOf` the check degrades to the three-letter shape rather than
 * rejecting every currency — failing open on a display preference, where the
 * alternative is a clinic that cannot save its own name.
 *
 * Uppercased first, so `inr` from a form is stored as `INR`: the column is
 * `char(3)` and a lowercase copy compares unequal to every other row.
 */
let currencySet: Set<string> | null | undefined;

function knownCurrency(value: string): boolean {
  if (currencySet === undefined) {
    const supported = (Intl as unknown as { supportedValuesOf?: (key: string) => string[] })
      .supportedValuesOf;
    currencySet = supported ? new Set(supported('currency')) : null;
  }
  return currencySet === null || currencySet.has(value);
}

export const currencyCode = z
  .string()
  .length(3)
  .regex(/^[A-Za-z]{3}$/, 'three letters, e.g. INR')
  .toUpperCase()
  .refine(knownCurrency, 'not a currency code, e.g. INR');

export const password = z
  .string()
  .min(12, 'at least 12 characters')
  .max(128)
  .regex(/[a-z]/, 'needs a lowercase letter')
  .regex(/[A-Z]/, 'needs an uppercase letter')
  .regex(/\d/, 'needs a digit');

export const paginationQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  sortBy: z.string().max(64).optional(),
  sortOrder: z.enum(['asc', 'desc']).default('desc'),
});

export type PaginationQuery = z.infer<typeof paginationQuery>;

export interface Paginated<T> {
  data: T[];
  meta: { page: number; limit: number; total: number; totalPages: number };
}

export const apiError = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    details: z.unknown().optional(),
  }),
});

export type ApiError = z.infer<typeof apiError>;
