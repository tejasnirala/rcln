/**
 * Who is acting, as the rule engine judges them (PI-8, closing KNOWN_ISSUES #5
 * and #9).
 *
 * ⚠️ BOTH HALVES OF `RegulatoryActor` WERE EMPTY ON EVERY CALL BEFORE THIS FILE,
 *   AND THEY FAILED IN OPPOSITE DIRECTIONS OF THE SAME WAY. `roleCodes` was `[]`
 *   on a stock movement (#5) because neither the goods-receipt nor the transfer
 *   service was given the caller's permissions. `licenceTypes` was `[]`
 *   EVERYWHERE (#9) because nothing in the schema recorded that anybody held a
 *   professional registration. A rule naming either — a
 *   `PHARMACIST_AUTHORITY`, an `IMPORT_RESTRICTION` — therefore resolved
 *   `UNDETERMINED`, which REFUSES.
 *
 * ⚠️ IT WAS LATENT AND IT WAS NEVER GOING TO STAY LATENT. Nothing enforces below
 *   `PRODUCTION_ENABLED`, and no pack is there, so the refusals were recorded
 *   and not acted on. The day a named human signs a pack off is the day both
 *   become live — and it must not be that day's discovery that the engine was
 *   being told nothing about the person acting. NEXT_SESSION.md said "both must
 *   land before any pack reaches PRODUCTION_ENABLED"; this is that.
 *
 * ── WHY ONE FUNCTION AND NOT TWO ────────────────────────────────────────────
 * Every consult in the programme — a supply, a return, a goods receipt, a
 * transfer, and PI-9's consumption when it lands — asks the same question about
 * the same person. A per-call-site answer is how one path ends up passing
 * permissions and another passing nothing, which is precisely the state this
 * file is fixing.
 *
 * NO PHI. A licence is a fact about a member of staff, not about a patient.
 */
import type { TenantContext, TxClient } from '@rcln/db';

import type { RegulatoryActorInput } from './evaluation.service.js';

/**
 * The caller's professional registrations, as licence-type strings.
 *
 * ⚠️ MATCHED EXACTLY AGAINST WHAT A RULE PACK NAMES, WITH NO NORMALISATION. A
 *   pack says `PHARMACIST` because that is what the jurisdiction issues; a fuzzy
 *   or case-insensitive match here would apply a confident, unreviewed answer,
 *   which is the same refusal `tax_category` makes about prefix trees.
 *
 * ⚠️ BOTH THE STATUS AND THE DATE HAVE TO BE GOOD, AND THAT IS NOT BELT AND
 *   BRACES. `status` is what the clinic recorded; `expires_on` is what the
 *   calendar says. A registration that lapsed while nobody updated the row stops
 *   counting on the day it lapsed rather than on the day somebody notices — and
 *   the direction of that failure matters, because the alternative is a rule
 *   satisfied by a licence that expired last year.
 *
 * ⚠️ EVALUATED AT THE MOMENT OF THE ACT, NOT AT `now()`. A dispense keyed in on
 *   Monday for a Friday supply is judged against whether the pharmacist was
 *   registered on FRIDAY — the same reason every other input to the engine
 *   carries `occurredAt`.
 *
 * ⚠️ READ UNDER THE CALLER'S OWN TRANSACTION, SO RLS AND THE `parent_isolation`
 *   POLICY APPLY. `membership_professional_registrations` has no
 *   `organization_id` of its own and is protected through `memberships`; a
 *   licence held at another clinic on the same platform cannot come back here.
 */
function startOfUtcDay(on: Date): Date {
  return new Date(Date.UTC(on.getUTCFullYear(), on.getUTCMonth(), on.getUTCDate(), 0, 0, 0, 0));
}

/**
 * Midnight of `on`'s calendar day AT THE BRANCH, as an instant.
 *
 * `expires_on` and `issued_on` are `date` columns, so what is compared against
 * them is a day boundary rather than a moment — but WHICH day depends on where
 * the counter is, which is the whole of invariant 6.
 */
async function startOfBranchDay(tx: TxClient, branchId: string, on: Date): Promise<Date> {
  const rows = await tx.$queryRaw<{ start_of_day: Date }[]>`
    SELECT (date_trunc('day', ${on}::timestamptz AT TIME ZONE b.timezone)
              AT TIME ZONE b.timezone) AS start_of_day
      FROM branches b
     WHERE b.id = ${branchId}::uuid
  `;
  return rows[0]?.start_of_day ?? startOfUtcDay(on);
}

export async function licenceTypesFor(
  tx: TxClient,
  ctx: TenantContext,
  on: Date,
  branchId?: string
): Promise<string[]> {
  /*
   * ⚠️ THE CALENDAR DAY IS THE CLINIC'S, NOT THE CONTAINER'S (invariant 6). This
   *   used to be `Date.UTC(on.getUTCFullYear(), …)`, which is the container's
   *   zone wearing a UTC label — and `issued_on` / `expires_on` are DATES in a
   *   council's own reckoning, as `access-control.prisma` says in the model
   *   comment. For an IST clinic every supply between 00:00 and 05:30 local falls
   *   on the PREVIOUS UTC day, so a licence that expired yesterday was still
   *   honoured through that window, in the direction this domain may never fail
   *   in: a rule satisfied by a registration that had lapsed.
   *
   *   Resolved in SQL from `branches.timezone`, the way `dashboard.service.ts` and
   *   `inventory_branches_with_expired_stock` do it, never in Node.
   *
   * ⚠️ UTC IS THE FALLBACK WHEN NO BRANCH IS NAMED, which is what the caller that
   *   cannot name one gets. It is the previous behaviour, so it is no worse; it is
   *   not correct, and the parameter exists so a caller can be correct.
   */
  const day = branchId ? await startOfBranchDay(tx, branchId, on) : startOfUtcDay(on);

  const rows = await tx.membershipProfessionalRegistration.findMany({
    where: {
      deletedAt: null,
      status: 'ACTIVE',
      membership: {
        userId: ctx.userId,
        organizationId: ctx.organizationId,
        status: 'ACTIVE',
        deletedAt: null,
      },
      /*
       * A registration with no expiry is open-ended, which is how several
       * councils issue them. `null` is "does not expire", never "expired".
       */
      OR: [{ expiresOn: null }, { expiresOn: { gte: day } }],
      AND: [{ OR: [{ issuedOn: null }, { issuedOn: { lte: day } }] }],
    },
    select: { licenceType: true },
  });

  /* Distinct: the unique is per (membership, licence type), so this is belt only. */
  return [...new Set(rows.map((row) => row.licenceType))];
}

/**
 * The whole actor, for a consult that has a transaction open.
 *
 * `roleCodes` is passed in rather than resolved here, because `TenantContext`
 * deliberately carries no permissions — it is an isolation boundary, not an
 * authorization one — and the route has already warmed that cache through
 * `authorize()`. Resolving it here would mean a second lookup on every line of
 * every document.
 */
export async function regulatoryActorWithin(
  tx: TxClient,
  ctx: TenantContext,
  input: {
    roleCodes: readonly string[];
    occurredAt: Date;
    /**
     * Where the act happened — the counter, the receiving bay. Decides whose
     * calendar day a registration's validity is measured in (invariant 6).
     * Omitted falls back to UTC, which is the old behaviour and is not correct.
     */
    branchId?: string;
    /** Derived by the caller from the encounter, never accepted from a client. */
    isPrescriber?: boolean;
  }
): Promise<RegulatoryActorInput> {
  return {
    roleCodes: input.roleCodes,
    licenceTypes: await licenceTypesFor(tx, ctx, input.occurredAt, input.branchId),
    ...(input.isPrescriber !== undefined ? { isPrescriber: input.isPrescriber } : {}),
  };
}
