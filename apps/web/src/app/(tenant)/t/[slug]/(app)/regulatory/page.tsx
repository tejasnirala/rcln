import { redirect } from 'next/navigation';

/**
 * `/regulatory` on its own is not a screen.
 *
 * Places is the first tab because it is the question everything else hangs off:
 * which rules apply here at all.
 */
export default async function RegulatoryIndexPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  await params;
  redirect('/regulatory/jurisdictions');
}
