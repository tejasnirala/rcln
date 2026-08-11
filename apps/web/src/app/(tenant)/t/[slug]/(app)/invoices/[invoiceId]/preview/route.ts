import { NextResponse, type NextRequest } from 'next/server';
import { apiBinary } from '@/lib/api';
import { getAccessToken } from '@/lib/session';

/**
 * The rendered invoice, on its way to the preview frame.
 *
 * ⚠️ A CONDUIT AND NOT A RENDERER, WHICH IS THE SECOND VERSION OF THIS FILE. The
 *   first one called `renderInvoiceHtml` here, and `next build` refused it:
 *   `react-dom/server` is declined in a Server Component's module graph AND in an
 *   App Route's. So the render moved to `GET /v1/invoices/:id/preview`, which is
 *   the better home anyway — the document is the API's product, and this app is
 *   now a conduit for both of its representations rather than the renderer of one
 *   and the proxy of the other.
 *
 * WHY THE FRAME CANNOT POINT AT THE API DIRECTLY
 *   The same reason the PDF cannot. The access token is in an httpOnly cookie on
 *   this host, so a browser request to `api.<root>` would carry no credential and
 *   could not be given one without putting the token where a script can read it.
 *   The request is therefore made server-side, on this origin, with the cookie the
 *   browser already holds.
 *
 * ⚠️ EVERY DECISION ABOUT WHO MAY SEE THIS IS THE API'S — the source-visibility
 *   rule, the 404 where it says no, and the `data_access_logs` row. This handler
 *   adds no check of its own and must not.
 */
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ slug: string; invoiceId: string }> }
): Promise<NextResponse> {
  const { slug, invoiceId } = await params;

  const document = await apiBinary(`/api/v1/invoices/${invoiceId}/preview`, {
    slug,
    accessToken: await getAccessToken(),
    accept: 'text/html, application/json',
  });

  if (!document.ok || !document.body) {
    /*
     * Plain text inside the frame rather than an error page: whoever is reading
     * this is looking at a panel on the invoice screen, and the totals beside it
     * are still the invoice's own. The API's sentence, never ours.
     */
    return new NextResponse(document.message ?? 'This document could not be loaded.', {
      status: document.status === 0 ? 502 : document.status,
      headers: {
        'content-type': 'text/plain; charset=utf-8',
        'cache-control': 'private, no-store',
      },
    });
  }

  return new NextResponse(document.body, {
    status: 200,
    headers: {
      'content-type': document.contentType ?? 'text/html; charset=utf-8',
      /*
       * Restated rather than forwarded. The document has no scripts — the template
       * test asserts there is no `<script>` in the output — and the frame is
       * sandboxed without `allow-scripts` as well. The API sends the same policy;
       * this response is ours, and a document naming a patient must not sit in a
       * shared cache whatever the upstream said.
       */
      'content-security-policy': "default-src 'none'; img-src data:; style-src 'unsafe-inline'",
      'x-content-type-options': 'nosniff',
      'cache-control': 'private, no-store',
    },
  });
}
