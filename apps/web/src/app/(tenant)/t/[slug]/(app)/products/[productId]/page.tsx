import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { PERMISSIONS } from '@rcln/permissions';
import type {
  EquivalentProductsResponse,
  JurisdictionListResponse,
  MedicineDetail,
  ProductDetail,
  ProductRegulatoryProfileDetail,
  UnitListResponse,
} from '@rcln/contracts';
import { api } from '@/lib/api';
import { getAccessToken, getSession, timezoneOf } from '@/lib/session';
import { todayIn } from '@/lib/calendar-range';
import { Alert } from '@/components/ui/alert';
import { ProductPanel } from '@/components/tenant/product-panel';

export const metadata: Metadata = {
  title: 'Product',
};

/**
 * <slug>.rcln.com/products/<id>
 *
 * ── THE MEDICINE TAB IS FETCHED SEPARATELY AND MAY LEGITIMATELY 403 ──────────
 * `GET /products/:id/medicine` is behind `pharmacy.medicine.read`, which a lab
 * manager or a dental store manager does not hold — and that is the PI-ADR-011
 * split working, not an error. So its failure is swallowed into `null` and the
 * tab simply is not offered. A refusal here must never take the page down with
 * it: everything else on the screen is theirs to see.
 *
 * The product detail itself already includes packaging, identifiers and tax
 * classifications, so there is one request for the body of the page rather than
 * four.
 */
export default async function ProductPage({
  params,
}: {
  params: Promise<{ slug: string; productId: string }>;
}) {
  const { slug, productId } = await params;
  const session = await getSession(slug);
  const permissions = session?.permissions ?? [];

  if (!permissions.includes(PERMISSIONS.PRODUCT_DEFINITION_READ)) {
    return (
      <Alert tone="error">
        You do not have access to the catalogue here. Ask an administrator at this clinic.
      </Alert>
    );
  }

  const accessToken = await getAccessToken();
  const canReadMedicine = permissions.includes(PERMISSIONS.MEDICINE_READ);
  /*
   * ⚠️ THE REGULATORY TAB IS FETCHED SEPARATELY AND MAY LEGITIMATELY 403, exactly
   *   like the medicine one above and for the same reason: `product.regulatory.*`
   *   is its own pair of codes (PI-ADR-011's split applied again), and a lab
   *   manager holding the catalogue codes does not necessarily hold these. A
   *   refusal is swallowed and the tab is not offered.
   */
  const canReadRegulatory = permissions.includes(PERMISSIONS.PRODUCT_REGULATORY_READ);

  const [product, equivalents, medicine, units, regulatoryProfiles, jurisdictions] =
    await Promise.all([
      api<ProductDetail>(`/api/v1/products/${productId}`, { slug, accessToken }),
      api<EquivalentProductsResponse>(`/api/v1/products/${productId}/equivalents`, {
        slug,
        accessToken,
      }),
      canReadMedicine
        ? api<MedicineDetail | null>(`/api/v1/products/${productId}/medicine`, {
            slug,
            accessToken,
          })
        : Promise.resolve({ ok: false, status: 403 } as const),
      api<UnitListResponse>('/api/v1/units', { slug, accessToken }),
      canReadRegulatory
        ? api<{ profiles: ProductRegulatoryProfileDetail[] }>(
            `/api/v1/products/${productId}/regulatory-profiles`,
            { slug, accessToken }
          )
        : Promise.resolve({ ok: false, status: 403 } as const),
      /*
       * The places a profile can name. Fetched here rather than in the panel so the
       * picker is a real list rather than a free-text jurisdiction id — two
       * spellings of the same place is how a profile silently never matches a rule.
       */
      canReadRegulatory
        ? api<JurisdictionListResponse>('/api/v1/regulatory/jurisdictions?limit=100', {
            slug,
            accessToken,
          })
        : Promise.resolve({ ok: false, status: 403 } as const),
    ]);

  // A product in another tenant is filtered out by RLS before the service sees
  // it, so the API answers 404 — genuinely indistinguishable from one that never
  // existed, which is the intent.
  if (product.status === 404) notFound();

  if (!product.ok || !product.data) {
    return (
      <Alert tone="error">
        {product.message ?? 'This product could not be loaded. Try again in a moment.'}
      </Alert>
    );
  }

  return (
    <ProductPanel
      slug={slug}
      product={product.data}
      equivalents={equivalents.data?.products ?? []}
      medicine={medicine.ok ? (medicine.data ?? null) : null}
      units={units.data?.units ?? []}
      canManage={permissions.includes(PERMISSIONS.PRODUCT_DEFINITION_MANAGE)}
      canManageIdentifiers={permissions.includes(PERMISSIONS.PRODUCT_IDENTIFIER_MANAGE)}
      canManageTax={permissions.includes(PERMISSIONS.BILLING_TAX_MANAGE)}
      canReadMedicine={canReadMedicine}
      canManageMedicine={permissions.includes(PERMISSIONS.MEDICINE_MANAGE)}
      regulatoryProfiles={regulatoryProfiles.ok ? (regulatoryProfiles.data?.profiles ?? []) : []}
      /*
       * ⚠️ TODAY IN THE CLINIC'S ZONE, COMPUTED ON THE SERVER AND PASSED DOWN.
       *   The form seeds a new profile's `effectiveFrom` with it, and
       *   `new Date().toISOString().slice(0, 10)` in the browser is the UTC day —
       *   so a clinic in Kolkata adding a profile before 05:30 dated it
       *   yesterday, silently. Invariant 6, and `todayIn` is the helper that
       *   already exists for exactly this.
       */
      clinicToday={todayIn(await timezoneOf(slug))}
      jurisdictions={jurisdictions.ok ? (jurisdictions.data?.jurisdictions ?? []) : []}
      canReadRegulatory={canReadRegulatory}
      canManageRegulatory={permissions.includes(PERMISSIONS.PRODUCT_REGULATORY_MANAGE)}
    />
  );
}
