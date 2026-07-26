import type { Metadata } from 'next';
import type { InvitationPreview } from '@rcln/contracts';
import { api } from '@/lib/api';
import { getSession } from '@/lib/session';
import { Wordmark } from '@/components/marketing/wordmark';
import { JoinForm } from '@/components/tenant/join-form';
import { JoinedRedirect } from '@/components/tenant/joined-redirect';

export const metadata: Metadata = {
  title: 'Join this clinic',
  // Never indexed. A crawler following a forwarded link would publish both the
  // customer list and a live credential.
  robots: { index: false, follow: false },
};

/**
 * <slug>.rcln.com/join?token=… — where an invitation email lands.
 *
 * WHY THIS IS NOT UNDER `(app)`
 *   The `(app)` layout redirects to /login when there is no session, and the
 *   person opening this link has none — obtaining access is what they are here
 *   to do. So it gets its own shell, exactly as login/page.tsx does, and the
 *   route group keeps the two concerns apart rather than special-casing a guard.
 *
 * The token arrives in the query because that is what an email link can carry.
 * It goes no further that way: the preview and the accept both send it in a
 * POST body, so it stays out of the API's access logs.
 */
export default async function JoinPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ token?: string }>;
}) {
  const [{ slug }, query] = await Promise.all([params, searchParams]);
  const token = query.token ?? '';

  const preview = token
    ? await api<InvitationPreview>('/api/v1/auth/invitations/preview', {
        method: 'POST',
        slug,
        body: { token },
      })
    : null;

  const invitation = preview?.ok ? preview.data : undefined;

  /**
   * A spent token in the hands of someone who is signed in here is not a dead
   * link — it is a join that just succeeded.
   *
   * This page is re-rendered as part of the Server Action's own response, and by
   * then the token is consumed, so the preview 404s. Without this branch the
   * page told a brand-new member their invitation had expired, unmounting the
   * form and the redirect it was carrying. See components/tenant/joined-redirect.
   *
   * Only asked on a 404, so the ordinary render costs nothing extra. It also
   * reads correctly for anyone already signed in who opens an old link.
   */
  const joined = !invitation && preview?.status === 404 ? await getSession(slug) : null;
  const joinedOrganizationName =
    joined?.memberships.find((m) => m.organizationId === joined.activeOrganizationId)
      ?.organizationName ?? slug;

  /*
   * A dead link and a refused request are not the same thing, and saying so
   * matters: "ask for a new one" is useless advice when the invitation is fine
   * and the API simply rate-limited us, because the new link fails identically.
   * Only 404 means the token is genuinely spent — and THAT case stays vague on
   * purpose, since expired, used and cancelled must be indistinguishable.
   */
  const refusal: { heading: string; detail: string } =
    preview?.status === 429
      ? {
          heading: 'Too many attempts',
          detail:
            'This clinic has checked a lot of invitations in the last few minutes. Wait five minutes and open the link again — it is still valid.',
        }
      : preview !== null && preview.status >= 500
        ? {
            heading: 'We cannot check this right now',
            detail:
              'Something on our side is not responding. Your invitation is unaffected — try the link again in a few minutes.',
          }
        : {
            heading: 'This link no longer works',
            detail:
              'It may have expired, already been used, or been cancelled. Ask whoever invited you to send a new one — they can do that from their invitations screen.',
          };

  return (
    <div className="px-gutter flex min-h-dvh flex-col py-10">
      <span className="text-ink self-start">
        <Wordmark />
      </span>

      <main id="main" className="flex flex-1 items-center justify-center py-12">
        <div className="w-full max-w-md">
          {invitation ? (
            <>
              <p className="eyebrow">You have been invited to</p>
              <h1 className="font-display mt-2 text-3xl tracking-tight">
                {invitation.organizationName}
              </h1>

              {/*
                The offer, stated plainly and in full before anyone types
                anything: what the role is and where it applies. Someone who
                works at more than one clinic needs to know which one this is.
              */}
              <dl className="border-rule mt-6 grid gap-3 border-y py-5 text-[0.875rem]">
                <div className="flex gap-3">
                  <dt className="text-muted w-24 shrink-0">Role</dt>
                  <dd className="text-ink">{invitation.roleName}</dd>
                </div>
                <div className="flex gap-3">
                  <dt className="text-muted w-24 shrink-0">Branches</dt>
                  <dd className="text-ink">
                    {invitation.branchNames.length === 0
                      ? 'Every branch'
                      : invitation.branchNames.join(', ')}
                  </dd>
                </div>
                <div className="flex gap-3">
                  <dt className="text-muted w-24 shrink-0">Sent to</dt>
                  <dd className="text-ink font-mono break-all">{invitation.email}</dd>
                </div>
              </dl>

              <div className="mt-8">
                <JoinForm slug={slug} token={token} invitation={invitation} />
              </div>
            </>
          ) : joined ? (
            <JoinedRedirect organizationName={joinedOrganizationName} />
          ) : (
            <>
              <p className="eyebrow">Invitation</p>
              <h1 className="font-display mt-2 text-3xl tracking-tight">{refusal.heading}</h1>
              {/*
                For a genuinely dead token this is one message covering expired,
                cancelled, already used, and meant-for-another-clinic. Telling
                those apart would let anyone holding a guess learn which clinics
                exist and who works at them. See `refusal` above for the cases
                that are NOT that and must not pretend to be.
              */}
              <p className="text-muted mt-4 text-sm leading-relaxed">{refusal.detail}</p>
            </>
          )}
        </div>
      </main>
    </div>
  );
}
