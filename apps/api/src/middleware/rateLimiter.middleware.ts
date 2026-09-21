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

/**
 * Every `max` in this file goes through here.
 *
 * The budgets below are sized for a person using a clinic, not for a developer
 * hammering a screen through a hot reload. `RATE_LIMIT_RELAXED=true` scales all
 * of them by the same factor rather than letting local development run without
 * limiters at all — the code path stays identical, so a 429 you hit in staging
 * is one you could have hit locally. The factor is pinned to 1 in production by
 * config, and by tests/setup-env.ts in the suite, where the budgets are asserted.
 */
const budget = (max: number): number => max * config.rateLimit.relaxedFactor;

/** 40 scans a minute across the configured window. */
const getScanBudget = (): number => Math.round((config.rateLimit.windowMs / 60_000) * 40);

export const generalLimiter = rateLimit({
  windowMs: config.rateLimit.windowMs,
  max: budget(config.rateLimit.maxRequests),
  standardHeaders: true,
  legacyHeaders: false,
  store: store('rl:general:'),
  handler: (_req, res) => {
    sendError(res, 'Too many requests, please try again later', 429);
  },
});

/**
 * The scanner, which needs a BIGGER budget than the general one, not a smaller.
 *
 * ⚠️ THE GENERAL LIMITER IS THE WRONG SHAPE FOR THIS ENDPOINT IN BOTH
 *   DIRECTIONS, WHICH IS WHY `API_ARCHITECTURE.md` ASKED FOR A DEDICATED ONE
 *   (KNOWN_ISSUES #35). `GET /v1/stock/resolve` is fired once per carton at a
 *   loading bay: 100 requests per fifteen minutes is a couple of minutes of
 *   honest work, so the shared budget would refuse a delivery halfway through
 *   unpacking it — and the storekeeper would read that as the scanner being
 *   broken. In the other direction, scan traffic running through the general
 *   bucket exhausts the budget every other screen in the application shares.
 *
 *   Its own bucket answers both: a generous sustained rate for the one workflow
 *   that legitimately produces it, and no borrowing from anybody else's. It is
 *   still bounded, because the endpoint reads the catalogue and the stock ledger
 *   and is the cheapest thing in the programme to enumerate with.
 *
 *   40 a minute sustained is about four times the fastest a person unpacks and
 *   scans, and it costs nothing to a human clicking through a screen.
 */
export const scanLimiter = rateLimit({
  windowMs: config.rateLimit.windowMs,
  max: budget(getScanBudget()),
  standardHeaders: true,
  legacyHeaders: false,
  store: store('rl:scan:'),
  handler: (_req, res) => {
    sendError(res, 'Too many scans, please slow down and try again shortly', 429);
  },
});

/** Auth endpoints are the ones worth brute-forcing, so they get their own budget. */
export const authLimiter = rateLimit({
  windowMs: config.rateLimit.windowMs,
  max: budget(config.rateLimit.authMaxRequests),
  standardHeaders: true,
  legacyHeaders: false,
  store: store('rl:auth:'),
  handler: (_req, res) => {
    sendError(res, 'Too many authentication attempts, please try again later', 429);
  },
});

/**
 * Unauthenticated forms on the public marketing site.
 *
 * Nobody legitimately books five demos in an hour, and this is the only route
 * on the apex domain that writes to the database, so the budget is small and
 * the window is long. `generalLimiter` already ran; this narrows it further.
 */
export const publicFormLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: budget(5),
  standardHeaders: true,
  legacyHeaders: false,
  store: store('rl:public-form:'),
  handler: (_req, res) => {
    sendError(res, 'Too many submissions from this network. Please try again later.', 429);
  },
});

/**
 * Clinic registration. Tighter than the demo form, because each success creates
 * an organization, a subdomain, a user and a trial subscription — a script that
 * gets through here leaves real rows behind, not a lead to ignore.
 */
export const registrationLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: budget(3),
  standardHeaders: true,
  legacyHeaders: false,
  store: store('rl:registration:'),
  handler: (_req, res) => {
    sendError(res, 'Too many registration attempts from this network. Try again later.', 429);
  },
});

/**
 * Subdomain availability.
 *
 * This endpoint answers "does clinic X bank with us", one guess at a time — it
 * is a customer-list enumeration oracle by construction. It cannot be
 * authenticated (it runs before an account exists) so the budget is what limits
 * it: generous enough to type a name into a form, far too small to walk a
 * dictionary.
 */
export const slugCheckLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: budget(30),
  standardHeaders: true,
  legacyHeaders: false,
  store: store('rl:slug-check:'),
  handler: (_req, res) => {
    sendError(res, 'Too many lookups. Please wait a moment.', 429);
  },
});

/**
 * Login, metered per ACCOUNT rather than per address.
 *
 * Runs alongside `authLimiter`, not instead of it — the two answer different
 * questions and a caller has to satisfy both:
 *
 *   authLimiter      "is this address making too many attempts?"   (any target)
 *   identityLimiter  "is this account under too many attempts?"    (any source)
 *
 * The per-IP budget alone misses the attack that matters here. A password spray
 * runs one guess per account from a different address each time, so it never
 * approaches an address limit — while a clinic behind a single office NAT trips
 * it constantly just by having staff arrive at nine o'clock.
 *
 * This is not the account lockout in password.service.ts, which counts FAILED
 * attempts and locks the account. This counts attempts of any kind and refuses
 * the request before a password is ever verified, so it also caps the argon2
 * work a stranger can make us do.
 *
 * The budget is deliberately roomy: someone mistyping a password four times and
 * then using the reset link must not be told to come back later. It exists to
 * stop machines, and the lockout counter handles the rest.
 */
export const identityLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: budget(10),
  standardHeaders: true,
  legacyHeaders: false,
  store: store('rl:identity:'),
  keyGenerator: (req, res) => {
    const identifier = (req.body as { identifier?: string } | undefined)?.identifier;
    /*
     * Lower-cased so `Asha@x.test` and `asha@x.test` share one budget — they are
     * the same account, and `email` in @rcln/contracts normalises the same way.
     * Falling back to the address keeps a body-less request metered rather than
     * unmetered; ipKeyGenerator normalises IPv6 to a /56, which express-rate-limit
     * v8 requires because one IPv6 host owns astronomically many addresses.
     */
    return identifier?.toLowerCase() ?? ipKeyGenerator(req.ip ?? '', 56) ?? String(res.statusCode);
  },
  handler: (_req, res) => {
    // Deliberately says nothing about whether the account exists — the same
    // reasoning as the single credential-failure message in login.service.ts.
    sendError(res, 'Too many sign-in attempts for that account. Wait a few minutes.', 429);
  },
});

/**
 * Issuing and resending invitations, metered per organization.
 *
 * Not per IP: a clinic sits behind one office NAT, so an IP budget would be a
 * whole-clinic budget by accident. Not per invited address either — the abuse
 * being priced here is one compromised admin account used to mail a hundred
 * different people from a domain that carries a real clinic's name. Onboarding
 * a new location is a handful of invitations in an afternoon, so the budget is
 * generous for that and hopeless for bulk.
 *
 * The route sits behind `requireTenant`, so `req.tenant` is always present by
 * the time this runs; the IP fallback is only there because the type is not.
 */
export const inviteLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: budget(30),
  standardHeaders: true,
  legacyHeaders: false,
  store: store('rl:invite:'),
  keyGenerator: (req, res) => {
    const organizationId = req.tenant?.organizationId;
    return organizationId ?? ipKeyGenerator(req.ip ?? '', 56) ?? String(res.statusCode);
  },
  handler: (_req, res) => {
    sendError(res, 'Too many invitations sent from this clinic. Try again later.', 429);
  },
});

/**
 * Email and phone verification, metered per ACCOUNT and per channel.
 *
 * Not per address, for the same reason as `identityLimiter`: a clinic arrives
 * through one office NAT, and half a dozen people verifying their email on a
 * Monday morning must not lock the rest of the practice out of doing the same.
 *
 * These routes sit behind `authenticate` + `requireAuth`, so `req.auth` is
 * always present by the time this runs — the address fallback exists only
 * because the type does not say so.
 *
 * The path is part of the key so that requesting a code, confirming one, and
 * doing either for the other channel are four separate budgets. Sharing one
 * would mean a user who mistyped a code four times could no longer ask for a
 * replacement, which is precisely when they need it.
 *
 * Ten per hour is roomy for a person and hopeless for a script; a wrong code is
 * separately capped at `OTP_MAX_ATTEMPTS` tries by challenge.service.ts, which
 * burns the token rather than the budget.
 */
export const verificationLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: budget(10),
  standardHeaders: true,
  legacyHeaders: false,
  store: store('rl:verification:'),
  keyGenerator: (req, res) => {
    const userId = req.auth?.userId ?? ipKeyGenerator(req.ip ?? '', 56) ?? String(res.statusCode);
    return `${userId}:${req.path}`;
  },
  handler: (_req, res) => {
    sendError(res, 'Too many verification attempts. Try again in a little while.', 429);
  },
});

/**
 * OTP sending is metered per phone number, not per IP — an attacker rotating
 * IPs must not be able to spam one person's handset (and burn your SMS credit).
 */
export const otpLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: budget(3),
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
