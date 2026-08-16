import type { Metadata } from 'next';
import type { ClinicalMasterListResponse, SpecialtyListResponse } from '@rcln/contracts';
import { PERMISSIONS } from '@rcln/permissions';
import { api } from '@/lib/api';
import { getAccessToken, getSession } from '@/lib/session';
import { Alert } from '@/components/ui/alert';
import { ClinicalTermList } from '@/components/tenant/clinical-term-list';

export const metadata: Metadata = { title: 'Clinical terms' };

/**
 * <slug>.rcln.com/clinical-terms — the words this clinic can write down.
 *
 * ⚠️ NO PHI ON THIS SCREEN, and that is what makes it different from every other
 *   clinical surface. "Dental caries" is a dictionary entry; it names nobody, it
 *   is not read-audited, and it is safe in a URL. The moment anything here joins
 *   to a patient, that stops being true.
 *
 * Server-rendered and SERVER-PAGINATED. Nothing filters an in-memory array: the
 * platform vocabulary is shared, so a client-side filter would get slower as
 * OTHER clinics' terms grow — the worst kind of performance bug to diagnose.
 *
 * ⚠️ TWO AUDIENCES, ONE SCREEN, AND THE COPY IS NOT THE CONTROL. Anyone who can
 *   read an appointment can read the vocabulary, because every clinical picker
 *   needs these names. Only `clinical.master.manage` gets the form. The API is
 *   the gate either way.
 */
const KINDS = [
  { value: 'SYMPTOM', label: 'Symptoms' },
  { value: 'DIAGNOSIS', label: 'Diagnoses' },
  { value: 'PROCEDURE', label: 'Procedures' },
  { value: 'INVESTIGATION', label: 'Investigations' },
  { value: 'ADVICE', label: 'Advice' },
  { value: 'HISTORY_ITEM', label: 'History' },
  { value: 'FINDING_TYPE', label: 'Findings' },
] as const;

export default async function ClinicalTermsPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { slug } = await params;
  const query = await searchParams;
  const session = await getSession(slug);
  const permissions = session?.permissions ?? [];

  if (!permissions.includes(PERMISSIONS.APPOINTMENT_READ)) {
    return (
      <Alert tone="error">
        You do not have access to the clinical terms here. Ask an administrator at this clinic.
      </Alert>
    );
  }

  const rawKind = query['kind'];
  const kind =
    typeof rawKind === 'string' && KINDS.some((k) => k.value === rawKind) ? rawKind : 'DIAGNOSIS';
  const rawSearch = query['search'];
  const search = typeof rawSearch === 'string' ? rawSearch : '';
  const rawPage = query['page'];

  const params_ = new URLSearchParams({ kind, pageSize: '25' });
  if (search !== '') params_.set('search', search);
  if (typeof rawPage === 'string') params_.set('page', rawPage);

  const accessToken = await getAccessToken();
  const result = await api<ClinicalMasterListResponse>(
    `/api/v1/clinical-data?${params_.toString()}`,
    { slug, accessToken }
  );

  if (!result.ok || result.data === undefined) {
    return (
      <Alert tone="error">
        {result.message ?? 'The clinical terms could not be loaded. Try again in a moment.'}
      </Alert>
    );
  }

  /*
   * The taxonomy, for the "relevant to" picker on the form.
   *
   * ⚠️ RELEVANCE RANKS, IT NEVER FILTERS — the form's label says so, because a
   *   clinician who reads it as a restriction will tag defensively and make the
   *   vocabulary worse. A term with no node still appears everywhere.
   */
  const taxonomy = permissions.includes(PERMISSIONS.CLINICAL_MASTER_MANAGE)
    ? await api<SpecialtyListResponse>('/api/v1/doctors/masters', { slug, accessToken })
    : null;

  return (
    <ClinicalTermList
      slug={slug}
      kind={kind}
      kinds={[...KINDS]}
      search={search}
      data={result.data}
      specialties={taxonomy?.ok ? (taxonomy.data?.specialties ?? []) : []}
      canManage={permissions.includes(PERMISSIONS.CLINICAL_MASTER_MANAGE)}
    />
  );
}
