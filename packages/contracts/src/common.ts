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
