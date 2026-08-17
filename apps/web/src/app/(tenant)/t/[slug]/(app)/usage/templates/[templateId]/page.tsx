import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import type { ConsumptionTemplateDetail, ProductListResponse } from '@rcln/contracts';
import { api } from '@/lib/api';
import { getAccessToken } from '@/lib/session';
import { Alert } from '@/components/ui/alert';
import { ConsumptionTemplateEditor } from '@/components/tenant/consumption-template-editor';
import { usageAccess } from '../../guard';

export const metadata: Metadata = { title: 'Consumption template' };

/** How many products the picker offers before it admits it is showing a page. */
const PICKER_LIMIT = 200;

/**
 * <slug>.rcln.com/usage/templates/<id> — one version, and what it lists.
 *
 * ⚠️ THE PRODUCT PICKER IS SERVER-FETCHED AND STOCKED-ONLY. A template line has
 *   to name something that can come off a shelf; offering a consultation fee
 *   would produce a row the API refuses with a sentence about billing, which is
 *   a confusing place to learn that a fee is not a material.
 *
 * ⚠️ NOT PHI.
 */
export default async function ConsumptionTemplatePage({
  params,
}: {
  params: Promise<{ slug: string; templateId: string }>;
}) {
  const { slug, templateId } = await params;
  const access = await usageAccess(slug);

  if (!access.canRead) {
    return (
      <Alert tone="error">
        You do not have access to consumption templates here. Ask an administrator at this clinic.
      </Alert>
    );
  }

  const accessToken = await getAccessToken();
  const [template, products] = await Promise.all([
    api<ConsumptionTemplateDetail>(`/api/v1/consumption/templates/${templateId}`, {
      slug,
      accessToken,
    }),
    api<ProductListResponse>(
      `/api/v1/products?isStockItem=true&status=ACTIVE&limit=${String(PICKER_LIMIT)}`,
      { slug, accessToken }
    ),
  ]);

  if (template.status === 404) notFound();

  if (!template.ok || !template.data) {
    return (
      <Alert tone="error">
        {template.message ?? 'This template could not be loaded. Try again in a moment.'}
      </Alert>
    );
  }

  return (
    <ConsumptionTemplateEditor
      slug={slug}
      template={template.data}
      products={products.data?.products ?? []}
      canManage={access.canManageTemplates}
    />
  );
}
