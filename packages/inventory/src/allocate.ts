/**
 * FEFO allocation — WHICH lot goes out, and in what order (PI-3.5).
 *
 * ⚠️ THIS FUNCTION MOVES NOTHING AND READS NOTHING. It takes the candidate
 *   buckets a caller has already read, orders them, and walks down the list
 *   taking what it can until the demand is met. That is the entire contract, and
 *   it is why this file has no `tx`, no `ctx` and no imports from `@rcln/db`.
 *
 *   The reason it is shaped that way is the same reason `readableQuantity` moved
 *   out of `apps/web` in PI-2: ordering rules are exactly the kind of logic that
 *   is wrong in a way no integration test notices — a tie broken the wrong way
 *   dispenses the second-oldest lot, which looks completely normal until an audit
 *   asks why the oldest one expired on the shelf. A pure function in a package
 *   with a unit suite is testable against every tie, every null and every
 *   shortfall; the same code inside a service is testable against whatever the
 *   fixture happened to contain.
 *
 * ── FEFO IS THE DEFAULT, NOT THE LAW ────────────────────────────────────────
 * First-Expiry-First-Out is right for anything that expires and wrong for a
 * good deal that does not. So the strategy is resolved per product, with an
 * explicit per-request override, and `AllocationStrategy` on the product is a
 * NULLABLE column where NULL means "nobody has thought about it" rather than
 * "somebody chose FEFO". See the enum comment for why those must stay distinct.
 *
 * ── WHAT THE CALLER MUST HAVE DONE BEFORE CALLING ───────────────────────────
 * Filtered the candidates. This function trusts the list it is given and will
 * happily allocate an expired lot if one is in it. The service reads only
 * `AVAILABLE` buckets, at active locations, of lots that are neither quarantined
 * nor recalled nor past their expiry — and PI-5's rule packs will narrow that
 * further, BEFORE any of the orderings below run. A jurisdiction that forbids
 * dispensing within thirty days of expiry is removing candidates, not reordering
 * them, and putting that in here would mix "what may go out" with "what goes out
 * first".
 *
 * NO PHI. Ids, quantities, dates.
 */
import {
  compareQuantities,
  parseQuantity,
  formatQuantity,
  rational,
  type Rational,
} from './units.js';

/** Which lot goes out first when several could. Mirrors the Prisma enum. */
export type AllocationStrategy = 'FEFO' | 'FIFO' | 'LIFO';

/**
 * One bucket that could satisfy some of the demand.
 *
 * `expiresOn` and `receivedAt` are ISO date strings rather than `Date`s, and
 * that is deliberate: they are compared, never arithmetic'd, ISO dates sort
 * correctly as strings, and a `Date` here would invite somebody to subtract two
 * of them and get a duration in the container's timezone. Invariant 6.
 */
export interface AllocationCandidate {
  locationId: string;
  batchId: string | null;
  serialId: string | null;
  /** `AVAILABLE` quantity in this bucket, in base units, less anything reserved. */
  availableQuantityBase: string;
  /** The lot's expiry, `YYYY-MM-DD`. NULL for a lot with none, and for no lot. */
  expiresOn: string | null;
  /** When the lot arrived. The FEFO tie-break and the whole of FIFO/LIFO. */
  receivedAt: string;
}

export interface AllocationLine {
  candidate: AllocationCandidate;
  /** How much to take from this bucket, in base units. Always positive. */
  quantityBase: string;
}

export interface AllocationPlan {
  lines: AllocationLine[];
  /** What was asked for. */
  requestedQuantityBase: string;
  /** What the lines add up to. Less than requested when the clinic is short. */
  allocatedQuantityBase: string;
  /** `requested − allocated`. Non-zero means this demand cannot be filled. */
  shortfallQuantityBase: string;
}

/**
 * Order the candidates.
 *
 * ⚠️ THE COMPARATOR IS TOTAL, AND THAT IS NOT PEDANTRY. `Array.prototype.sort`
 *   is stable in every current engine, so an incomplete comparator does not
 *   produce a random order — it produces the ORDER THE ROWS ARRIVED IN, which is
 *   whatever the database's plan happened to be that day. The plan changes when
 *   the table grows, and a clinic that has been dispensing oldest-first for a
 *   year starts dispensing newest-first with no code change and no error. So
 *   every comparison chain below ends in an id, which is unique.
 *
 * ⚠️ A LOT WITH NO EXPIRY SORTS **LAST** UNDER FEFO, NOT FIRST. `null` is "this
 *   never expires", not "this expires at the beginning of time", and the naive
 *   comparison puts it first — Postgres does the same thing with NULLS FIRST on
 *   ASC, which is why `listBatches` spells `nulls: 'last'` out. Getting this
 *   backwards empties the non-expiring stock while the expiring stock expires.
 */
export function orderCandidates(
  candidates: AllocationCandidate[],
  strategy: AllocationStrategy
): AllocationCandidate[] {
  const keyOf = (c: AllocationCandidate): string =>
    `${c.locationId}|${c.batchId ?? '-'}|${c.serialId ?? '-'}`;

  return [...candidates].sort((a, b) => {
    if (strategy === 'FEFO') {
      // NULL last, as above.
      if (a.expiresOn !== b.expiresOn) {
        if (a.expiresOn === null) return 1;
        if (b.expiresOn === null) return -1;
        return a.expiresOn < b.expiresOn ? -1 : 1;
      }
      // Ties on the same expiry day break on arrival — the older lot has been
      // on the shelf longer and is the one an auditor expects to have gone.
      if (a.receivedAt !== b.receivedAt) return a.receivedAt < b.receivedAt ? -1 : 1;
    } else if (strategy === 'FIFO') {
      if (a.receivedAt !== b.receivedAt) return a.receivedAt < b.receivedAt ? -1 : 1;
    } else {
      if (a.receivedAt !== b.receivedAt) return a.receivedAt < b.receivedAt ? 1 : -1;
    }

    // The total order. See the warning above.
    const ka = keyOf(a);
    const kb = keyOf(b);
    if (ka === kb) return 0;
    return ka < kb ? -1 : 1;
  });
}

/** Subtract two positive decimal strings exactly, over the rationals. */
function subtract(a: string, b: string): string {
  const left = parseQuantity(a);
  const right = parseQuantity(b);
  const diff: Rational = rational(left.n * right.d - right.n * left.d, left.d * right.d);
  // Exact by construction: both operands have at most six decimal places, so the
  // difference does too, and `formatQuantity` has nothing to round.
  return formatQuantity(diff).quantity;
}

/**
 * Put a caller's decimal string onto the ledger's scale.
 *
 * ⚠️ EVERY QUANTITY THIS FILE EMITS GOES THROUGH HERE, AND THE FIRST VERSION DID
 *   NOT. A quantity that passed through `subtract` came back as `15.000000`
 *   while one taken whole from a bucket came back as whatever the caller's
 *   string was — `30` — so one plan carried both scales, and which one a given
 *   line got depended on whether that line happened to be the last. Nothing
 *   errored: `readableQuantity` trims both to the same thing on screen, so it is
 *   invisible until something compares two of them as strings, or a fixture
 *   asserts on one. Found by the test that asserts on one.
 */
function normalise(quantity: string): string {
  return formatQuantity(parseQuantity(quantity)).quantity;
}

/**
 * Build the plan.
 *
 * Walks the ordered candidates taking as much as each holds until the demand is
 * met. The last line is usually partial, which is the normal case and not a
 * special one — a demand for 45 tablets from lots of 30 and 30 takes all of the
 * first and half of the second.
 *
 * ⚠️ A SHORTFALL IS RETURNED, NOT THROWN. "The clinic holds 12 and you asked for
 *   20" is an answer the dispensing screen has to show — with the 12 it CAN give
 *   out, so the pharmacist can dispense a partial supply and order the rest.
 *   Throwing here would make the useful half of that answer unreachable, and the
 *   caller that commits is the one that decides whether a partial fill is
 *   acceptable. Nothing is reserved by planning; see the contract.
 *
 * ⚠️ ZERO AND NEGATIVE BUCKETS ARE SKIPPED RATHER THAN TRUSTED. A bucket fully
 *   issued leaves a row holding `0` behind, and a bucket whose reservations
 *   exceed its available quantity computes negative in the caller's subtraction.
 *   Allocating from either would emit a line the commit then refuses — a 409 on
 *   a plan the screen had already shown as fine.
 */
export function planAllocation(
  candidates: AllocationCandidate[],
  requestedQuantityBase: string,
  strategy: AllocationStrategy
): AllocationPlan {
  const lines: AllocationLine[] = [];
  const requested = normalise(requestedQuantityBase);
  let remaining = requested;

  for (const candidate of orderCandidates(candidates, strategy)) {
    if (compareQuantities(remaining, '0') <= 0) break;
    if (compareQuantities(candidate.availableQuantityBase, '0') <= 0) continue;

    const take = normalise(
      compareQuantities(candidate.availableQuantityBase, remaining) <= 0
        ? candidate.availableQuantityBase
        : remaining
    );

    lines.push({ candidate, quantityBase: take });
    remaining = subtract(remaining, take);
  }

  const allocated = subtract(requested, remaining);

  return {
    lines,
    requestedQuantityBase: requested,
    allocatedQuantityBase: allocated,
    shortfallQuantityBase: remaining,
  };
}

/**
 * Which strategy applies, and where it came from.
 *
 * The source is returned alongside because "why did it pick that lot" is the
 * question this whole file exists to answer, and "FEFO" alone does not answer
 * it — "FEFO, because nobody set one on this product" and "FEFO, because
 * somebody chose it" lead to different next questions.
 *
 * ⚠️ PI-5's JURISDICTION RULES ARE NOT A FOURTH SOURCE HERE, AND MUST NOT
 *   BECOME ONE. A rule pack narrows WHICH LOTS MAY GO OUT — no dispensing within
 *   N days of expiry — which is a filter applied to the candidate list before it
 *   reaches this file. A jurisdiction that reordered rather than excluded would
 *   be overriding a clinical decision a clinic made on purpose, which is the one
 *   thing the nullable column above exists to keep visible.
 */
export function resolveStrategy(
  requested: AllocationStrategy | null | undefined,
  productStrategy: AllocationStrategy | null | undefined
): { strategy: AllocationStrategy; source: 'REQUEST' | 'PRODUCT' | 'DEFAULT' } {
  if (requested != null) return { strategy: requested, source: 'REQUEST' };
  if (productStrategy != null) return { strategy: productStrategy, source: 'PRODUCT' };
  return { strategy: 'FEFO', source: 'DEFAULT' };
}
