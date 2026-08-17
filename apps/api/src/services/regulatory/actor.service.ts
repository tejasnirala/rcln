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
export async function licenceTypesFor(
  tx: TxClient,
  ctx: TenantContext,
  on: Date
): Promise<string[]> {
  const day = new Date(
    Date.UTC(on.getUTCFullYear(), on.getUTCMonth(), on.getUTCDate(), 0, 0, 0, 0)
  );

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
    /** Derived by the caller from the encounter, never accepted from a client. */
    isPrescriber?: boolean;
  }
): Promise<RegulatoryActorInput> {
  return {
    roleCodes: input.roleCodes,
    licenceTypes: await licenceTypesFor(tx, ctx, input.occurredAt),
    ...(input.isPrescriber !== undefined ? { isPrescriber: input.isPrescriber } : {}),
  };
}
