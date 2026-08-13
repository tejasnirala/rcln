import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import type { RegulatoryRuleListResponse, RulePackSummary } from '@rcln/contracts';
import { api } from '@/lib/api';
import { getAccessToken, timezoneOf } from '@/lib/session';
import { Alert } from '@/components/ui/alert';
import { RulePackDetail } from '@/components/tenant/rule-pack-detail';
import { regulatoryAccess } from '../../guard';

export const metadata: Metadata = { title: 'Rule pack' };

/**
 * <slug>.rcln.com/regulatory/rule-packs/<id>
 *
 * ⚠️ THE RULES ARE FETCHED ALONGSIDE THE PACK, NOT AFTER IT. Two sequential
 *   awaits here would be a waterfall on a page that always needs both.
 *
 * NO PHI.
 */
export default async function RulePackPage({
  params,
}: {
  params: Promise<{ slug: string; packId: string }>;
}) {
  const { slug, packId } = await params;
  const access = await regulatoryAccess(slug);

  if (!access.canRead) {
    return (
      <Alert tone="error">
        You do not have access to the rules here. Ask an administrator at this clinic.
      </Alert>
    );
  }

  const accessToken = await getAccessToken();
  const [timezone, pack, rules] = await Promise.all([
    timezoneOf(slug),
    api<{ pack: RulePackSummary }>(`/api/v1/regulatory/rule-packs/${packId}`, {
      slug,
      accessToken,
    }),
    api<RegulatoryRuleListResponse>(`/api/v1/regulatory/rules?packId=${packId}&limit=100`, {
      slug,
      accessToken,
    }),
  ]);

  if (!pack.ok || !pack.data?.pack) notFound();

  return (
    <RulePackDetail pack={pack.data.pack} rules={rules.data?.rules ?? []} timezone={timezone} />
  );
}
