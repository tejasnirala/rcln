import rateLimit, { ipKeyGenerator } from 'express-rate-limit';
import { RedisStore } from 'rate-limit-redis';
import { config } from '../config/index.js';
import { redis } from '../utils/redis.js';
import { sendError } from '../utils/response.js';

/**
 * Redis-backed, not in-memory.
 *
 * express-rate-limit's default MemoryStore counts per process, so with two API
 * containers an attacker gets double the budget — and the limit effectively
 * disappears as you scale out.
 */
const store = (prefix: string): RedisStore =>
  new RedisStore({
    prefix,
    sendCommand: (...args: string[]) =>
      redis.call(...(args as [string, ...string[]])) as Promise<never>,
  });

export const generalLimiter = rateLimit({
  windowMs: config.rateLimit.windowMs,
  max: config.rateLimit.maxRequests,
  standardHeaders: true,
  legacyHeaders: false,
  store: store('rl:general:'),
  handler: (_req, res) => {
    sendError(res, 'Too many requests, please try again later', 429);
  },
});

/** Auth endpoints are the ones worth brute-forcing, so they get their own budget. */
export const authLimiter = rateLimit({
  windowMs: config.rateLimit.windowMs,
  max: config.rateLimit.authMaxRequests,
  standardHeaders: true,
  legacyHeaders: false,
  store: store('rl:auth:'),
  handler: (_req, res) => {
    sendError(res, 'Too many authentication attempts, please try again later', 429);
  },
});

/**
 * OTP sending is metered per phone number, not per IP — an attacker rotating
 * IPs must not be able to spam one person's handset (and burn your SMS credit).
 */
export const otpLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 3,
  standardHeaders: true,
  legacyHeaders: false,
  store: store('rl:otp:'),
  // ipKeyGenerator normalises IPv6 to a /56 subnet. express-rate-limit v8
  // refuses a raw req.ip key because a single IPv6 host owns astronomically
  // many addresses and could otherwise sidestep the limit for free.
  keyGenerator: (req, res) => {
    const phone = (req.body as { phone?: string } | undefined)?.phone;
    return phone ?? ipKeyGenerator(req.ip ?? '', 56) ?? String(res.statusCode);
  },
  handler: (_req, res) => {
    sendError(res, 'Too many OTP requests. Please wait before trying again.', 429);
  },
});
