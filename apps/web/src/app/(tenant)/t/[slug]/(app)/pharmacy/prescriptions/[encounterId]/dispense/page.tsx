import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import type {
  AllocationPlanResponse,
  InventoryLocationListResponse,
  PharmacyPrescriptionDetail,
  SubstitutionResponse,
} from '@rcln/contracts';
import { api } from '@/lib/api';
import { getAccessToken } from '@/lib/session';
import { Alert } from '@/components/ui/alert';
import { DispensingWorkspace } from '@/components/tenant/dispensing-workspace';
import { pharmacyAccess } from '../../../guard';

export const metadata: Metadata = { title: 'Dispensing' };

/**
 * The workspace loads the prescription and, for every line that is stocked, the
 * lots that could supply it.
 *
 * ⚠️ THE PLAN IS ASKED FOR THE WHOLE OF WHAT IS ON THE SHELF, NOT FOR WHAT IS
 *   OUTSTANDING, AND THAT IS DELIBERATE. `POST /stock/allocations/plan` returns
 *   the buckets it would use in FEFO order — so asking for everything available
 *   turns it into the CANDIDATE LIST, which is what a pharmacist needs to reach
 *   past the oldest lot with a reason. Asking for the outstanding quantity would
 *   return only the lots FEFO happened to pick and quietly remove the choice.
 *
 * ⚠️ IT WRITES NOTHING. Planning holds no stock and two people planning at once
 *   get the same answer; the server re-plans inside the posting transaction, so
 *   what is rendered here is a proposal and never a reservation.
 *
 * ⚠️ ONE REQUEST PER LINE, IN PARALLEL. A prescription is a handful of medicines,
 *   not a page of them, and the alternative — a bulk endpoint — would be a second
 *   allocator to keep in step with the one that posts.
 *
 * ⚠️ THE EQUIVALENTS ARE FETCHED HERE TOO, ON THE SERVER, RATHER THAN LAZILY FROM
 *   THE BROWSER (PI-8, closing KNOWN_ISSUES #11). Each candidate carries a
 *   REGULATORY DECISION — whether the law permits substituting it, here, today —
 *   and a control that offered a swap before that answer arrived would let
 *   somebody pick a product the engine is about to refuse. Loading them with the
 *   plans means the swap and its legal answer appear together or not at all.
 *
 *   A refusal is swallowed per line: `pharmacy.dispense.read` gates this endpoint
 *   too, so a caller who reaches the workspace always holds it, but a line whose
 *   product has no composition simply has no equivalents and must not take the
 *   page down.
 */
export default async function DispenseWorkspacePage({
  params,
}: {
  params: Promise<{ slug: string; encounterId: string }>;
}) {
  const { slug, encounterId } = await params;
  const access = await pharmacyAccess(slug);

  if (!access.canDispense) {
    return (
      <Alert tone="error">
        You do not have permission to dispense here. Ask an administrator at this clinic.
      </Alert>
    );
  }

  const accessToken = await getAccessToken();
  const prescription = await api<PharmacyPrescriptionDetail>(
    `/api/v1/pharmacy/prescriptions/${encounterId}`,
    { slug, accessToken }
  );

  if (prescription.status === 404) notFound();
  if (!prescription.ok || !prescription.data) {
    return (
      <Alert tone="error">
        {prescription.message ?? 'That prescription could not be loaded. Try again in a moment.'}
      </Alert>
    );
  }

  const detail = prescription.data;

  const [locations, plans, substitutions] = await Promise.all([
    api<InventoryLocationListResponse>(
      `/api/v1/inventory-locations?branchId=${detail.branchId}&limit=100`,
      { slug, accessToken }
    ),
    Promise.all(
      detail.items.map(async (item) => {
        if (!item.isStockItem || Number(item.availableQuantityBase) <= 0) {
          return { encounterPrescriptionId: item.id, plan: null };
        }
        const plan = await api<AllocationPlanResponse>('/api/v1/stock/allocations/plan', {
          method: 'POST',
          slug,
          accessToken,
          body: {
            branchId: detail.branchId,
            productId: item.productId,
            quantity: item.availableQuantityBase,
          },
        });
        return { encounterPrescriptionId: item.id, plan: plan.data ?? null };
      })
    ),
    Promise.all(
      detail.items.map(async (item) => {
        /*
         * ⚠️ GATED ON THE SAME CONDITION AS THE PLAN FAN-OUT ABOVE, WHICH IT WAS
         *   NOT. It fired for every item including fully-dispensed ones, passing
         *   `quantityBase=0` — which the endpoint's own validation rejects, and
         *   the `?? []` fallback then makes a real failure indistinguishable from
         *   "no equivalents". It also doubled the request count on a long
         *   prescription against an API with a rate limiter in the chain.
         */
        if (!item.isStockItem || Number(item.outstandingQuantityBase ?? '0') <= 0) {
          return { encounterPrescriptionId: item.id, candidates: [] };
        }
        const candidates = await api<SubstitutionResponse>(
          `/api/v1/pharmacy/prescriptions/${encounterId}/substitutions/${item.productId}` +
            `?branchId=${detail.branchId}&quantityBase=${item.outstandingQuantityBase ?? '0'}`,
          { slug, accessToken }
        );
        return {
          encounterPrescriptionId: item.id,
          candidates: candidates.ok ? (candidates.data?.candidates ?? []) : [],
        };
      })
    ),
  ]);

  const dispensingPoints = (locations.data?.locations ?? []).filter(
    (location) => location.isDispensingPoint && location.isActive
  );

  if (dispensingPoints.length === 0) {
    return (
      <Alert tone="warning">
        This branch has no dispensing point set up, so nothing can go out of it. Mark a location as
        a dispensing point under Stock first.
      </Alert>
    );
  }

  return (
    <DispensingWorkspace
      slug={slug}
      prescription={detail}
      plans={plans}
      substitutions={substitutions}
      locations={dispensingPoints}
      canDispense={access.canDispense}
    />
  );
}
