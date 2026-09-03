/**
 * Reading what a clinic said it is — the LIVE half of CO-1.
 *
 * `onboarding.service.ts` is the wizard: it captures the answers and seeds the
 * settings that follow from them. This module is the reader, and it answers a
 * deliberately small question — "which nav tabs should this branch draw, and
 * does the patient form need to ask person-or-animal?" — for every branch of an
 * organization at once.
 *
 * ⚠️ EXACTLY TWO THINGS READ THIS AT REQUEST TIME, AND ADDING A THIRD NEEDS AN
 *   ARGUMENT (ADR-0018). Everything else the wizard captured became a
 *   `setting_values` row that the clinic owns and the settings screen reports.
 *   In particular this is NOT read to resolve a consultation template:
 *   `consultation-config.service.ts` already resolves the care context from
 *   `patients.subject_type`, per patient, so a pet clinic's templates are
 *   correct because its patients are ANIMAL. A profile read there would be a
 *   second, contradictable answer, and it would break a mixed practice's one
 *   human patient.
 *
 * ⚠️ NOTHING HERE IS AN AUTHORIZATION INPUT. A module missing from a summary
 *   must never be the reason a request is refused — `authorize()` is, and it is
 *   unchanged. This decides what is DRAWN. A caller who types the URL of a
 *   hidden route meets the permission gate exactly as before, and a clinic that
 *   ticks a module box grants nobody anything.
 *
 * ⚠️ RESOLUTION IS BRANCH OVER ORGANIZATION, the same ladder `setting_values`
 *   walks and for the same reason: a hospital whose satellite is a standalone
 *   pharmacy is one organization with two honest answers. A branch with no row
 *   of its own inherits the organization's — it does not fall back to empty,
 *   which would read as "this site runs nothing".
 *
 * ⚠️ AND IT IS NOT CACHED. `loadUserAccess` holds a 60-second Redis cache and
 *   this is deliberately outside it, resolved beside the branch list in the same
 *   uncached transaction. Folding it in would mean every onboarding write had to
 *   call `invalidateOrganizationAccess`, and a clinic that finished setup would
 *   watch the old nav for a minute wondering whether it had saved. The next
 *   person to read this file will want to cache it; this paragraph is why not.
 */
import type { TxClient } from '@rcln/db';
import type { ClinicModule, ClinicProfileSummary } from '@rcln/contracts';

/**
 * What a branch with no profile of its own and no organization row sees.
 *
 * ⚠️ EMPTY `careContextIds` MEANS "NOBODY HAS ANSWERED YET", AND THE PATIENT
 *   FORM MUST TREAT IT AS "SHOW THE PICKER". Refusing to ask the question is
 *   only safe once somebody has answered it; a clinic mid-setup that silently
 *   defaulted every record to HUMAN would be a veterinary practice quietly
 *   registering dogs as people.
 *
 * ⚠️ EMPTY `modules` MEANS THE NAV FALLS BACK TO SHOWING EVERYTHING THE
 *   CALLER'S PERMISSIONS ALLOW — see `clinicNav`. A pre-onboarding clinic with
 *   no tabs at all would be a clinic that cannot reach the screen that fixes it.
 */
export const EMPTY_CLINIC_PROFILE: ClinicProfileSummary = {
  careContextIds: [],
  careContextCodes: [],
  modules: [],
};

export interface ResolvedClinicProfiles {
  /** The organization's answer, or the empty profile if it has none yet. */
  organization: ClinicProfileSummary;
  /** One entry per branch asked for, already resolved branch-over-org. */
  byBranch: Map<string, ClinicProfileSummary>;
  /** `clinic_profiles.completed_at` on the ORG-level row. Null until reviewed. */
  completedAt: Date | null;
}

/**
 * Resolve the profile for an organization and any number of its branches.
 *
 * ⚠️ ONE QUERY FOR EVERY BRANCH, NOT ONE PER BRANCH. This runs inside
 *   `listMemberships`, which runs on every render of every page — an N+1 here is
 *   an N+1 on the hottest path in the product. Modelled directly on
 *   `resolveSettingForBranches`, which exists for the identical reason.
 *
 * ⚠️ `branchIds` MUST COME FROM A LIST ALREADY READ UNDER RLS — `loadUserAccess`
 *   or a `withTenant` query. Unlike `setting_values` these tables DO carry
 *   policies, so a foreign id returns nothing rather than another clinic's row;
 *   the rule is restated because the call site is shared with the settings
 *   resolver, where it is the only thing standing between a caller and another
 *   clinic's configuration.
 */
export async function resolveClinicProfiles(
  tx: TxClient,
  scopes: { organizationId: string; branchIds: readonly string[] }
): Promise<ResolvedClinicProfiles> {
  const profiles = await tx.clinicProfile.findMany({
    where: {
      organizationId: scopes.organizationId,
      // The org-level row plus any override for a branch we were asked about.
      OR: [{ branchId: null }, { branchId: { in: [...scopes.branchIds] } }],
    },
    select: {
      branchId: true,
      completedAt: true,
      modules: { select: { module: true } },
      careContexts: { select: { specialtyId: true, specialty: { select: { code: true } } } },
    },
  });

  const toSummary = (row: (typeof profiles)[number]): ClinicProfileSummary => ({
    careContextIds: row.careContexts.map((c) => c.specialtyId),
    careContextCodes: row.careContexts.map((c) => c.specialty.code),
    modules: row.modules.map((m) => m.module as ClinicModule),
  });

  const orgRow = profiles.find((p) => p.branchId === null);
  const organization = orgRow ? toSummary(orgRow) : EMPTY_CLINIC_PROFILE;

  const overrides = new Map<string, ClinicProfileSummary>();
  for (const row of profiles) {
    if (row.branchId) overrides.set(row.branchId, toSummary(row));
  }

  /*
   * ⚠️ THE OVERRIDE REPLACES THE ORGANIZATION'S ANSWER WHOLE — it does not merge
   *   with it, and that is the same semantics `setting_values` has. A satellite
   *   whose profile says PHARMACY runs a pharmacy and nothing else; if the
   *   clinic meant "everything the group does, plus a pharmacy", the wizard's
   *   branch step shows them the organization's set pre-ticked so that is what
   *   they save. Merging here would make it impossible to express a site that
   *   does LESS than its organization, which is the whole reason branch
   *   overrides exist.
   */
  const byBranch = new Map<string, ClinicProfileSummary>(
    scopes.branchIds.map((id) => [id, overrides.get(id) ?? organization])
  );

  return { organization, byBranch, completedAt: orgRow?.completedAt ?? null };
}
