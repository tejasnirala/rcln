import type { Metadata } from 'next';
import type { ClinicalMasterListResponse, ConsumptionTemplateListResponse } from '@rcln/contracts';
import { api } from '@/lib/api';
import { getAccessToken } from '@/lib/session';
import { Alert } from '@/components/ui/alert';
import { ConsumptionTemplateList } from '@/components/tenant/consumption-template-list';
import { usageAccess } from '../guard';

export const metadata: Metadata = { title: 'Consumption templates' };

/** How many procedures the picker offers before it admits it is showing a page. */
/*
 * ⚠️ ONE ROW, AND IT IS NOT A PICKER ANY MORE (KNOWN_ISSUES #34). This used to
 *   be `PICKER_LIMIT = 100`: the page fetched the first hundred procedures and
 *   the form filtered them in a `<select>`, so a clinic whose dictionary ran
 *   longer could not choose the rest and nothing said the list was cut.
 *   `ProcedurePicker` now searches the server, so the only thing this fetch
 *   still answers is "does the dictionary have ANYTHING in it" — which decides
 *   whether the screen offers the form or tells somebody to populate the
 *   dictionary first. One row answers that.
 */
const EXISTENCE_CHECK = 1;

/**
 * <slug>.rcln.com/usage/templates — what each procedure normally uses.
 *
 * ⚠️ NOT PHI. A template is a statement about a procedure, not about a patient,
 *   and no read here files a disclosure row.
 *
 * ⚠️ THE LIST IS EVERY VERSION, NOT JUST THE ONE IN FORCE. "What do we expect a
 *   root canal to use" and "what did we expect in March" are both questions this
 *   answers, and hiding the closed versions would make the second unanswerable
 *   from the screen that owns the subject.
 */
export default async function ConsumptionTemplatesPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { slug } = await params;
  const query = await searchParams;
  const access = await usageAccess(slug);

  if (!access.canRead) {
    return (
      <Alert tone="error">
        You do not have access to consumption templates here. Ask an administrator at this clinic.
      </Alert>
    );
  }

  const accessToken = await getAccessToken();
  const one = (key: string): string | undefined => {
    const value = query[key];
    return Array.isArray(value) ? value[0] : value;
  };

  const search = new URLSearchParams();
  for (const key of ['itemId', 'status', 'search', 'page']) {
    const value = one(key);
    if (value) search.set(key, value);
  }

  const [templates, procedures] = await Promise.all([
    api<ConsumptionTemplateListResponse>(`/api/v1/consumption/templates?${search.toString()}`, {
      slug,
      accessToken,
    }),
    api<ClinicalMasterListResponse>(
      `/api/v1/clinical-data?kind=PROCEDURE&pageSize=${String(EXISTENCE_CHECK)}`,
      { slug, accessToken }
    ),
  ]);

  if (!templates.ok || !templates.data) {
    return (
      <Alert tone="error">
        {templates.message ?? 'The templates could not be loaded. Try again in a moment.'}
      </Alert>
    );
  }

  return (
    <ConsumptionTemplateList
      slug={slug}
      templates={templates.data.items}
      meta={templates.data}
      /*
       * ⚠️ EMPTY WHEN THE CALLER CANNOT READ THE CLINICAL DICTIONARY. `GET
       *   /clinical-data` is gated on `appointment.read`, which a branch
       *   administrator holds and a storekeeper may not — and the create form
       *   degrades to "no procedures to choose from" rather than to a crash.
       */
      procedures={procedures.data?.items ?? []}
      canManage={access.canManageTemplates}
    />
  );
}
