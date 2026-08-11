import { NextResponse, type NextRequest } from 'next/server';
import { apiBinary } from '@/lib/api';
import { getAccessToken } from '@/lib/session';

/**
 * The stored invoice PDF, on its way to the browser.
 *
 * WHY THIS IS A ROUTE HANDLER AND NOT A LINK STRAIGHT AT THE API
 *   The access token is in an httpOnly cookie on this host. A browser fetching
 *   `api.<root>/v1/invoices/<id>/pdf` would send no credential and get a 401,
 *   and the only way to give it one is to put the token somewhere a script can
 *   read — which is the thing httpOnly exists to prevent. So the request is made
 *   server-side, on this origin, with the cookie the browser already holds.
 *
 * WHY IT IS NOT A SERVER ACTION
 *   A Server Action returns a value into a React render. This has to be a
 *   navigable URL, because what a cashier does with a bill is open it in a tab
 *   or hand it to the browser's own PDF viewer.
 *
 * ⚠️ EVERY DECISION HERE IS THE API'S. Whether this caller may see this invoice,
 *   whether the invoice exists, and the `PRINT` row in `data_access_logs` are
 *   all settled by `GET /v1/invoices/:id/pdf` before a byte is read. This
 *   handler adds no check of its own and must not: a second opinion about who
 *   may read an invoice is a second place for that opinion to be wrong. It
 *   forwards, and it passes the refusal back.
 *
 * ⚠️ THE FILENAME AND THE CACHE HEADERS COME FROM THE API TOO. The document is
 *   named after the invoice NUMBER and never the patient — a filename survives
 *   into every folder, mail attachment and screen share the file reaches — and
 *   it is served `private, no-store` because it is somebody's medical bill.
 *   Re-deriving either here would be a second copy of a rule that already exists.
 */
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ slug: string; invoiceId: string }> }
): Promise<NextResponse> {
  const { slug, invoiceId } = await params;

  const file = await apiBinary(`/api/v1/invoices/${invoiceId}/pdf`, {
    slug,
    accessToken: await getAccessToken(),
  });

  if (!file.ok || !file.body) {
    /*
     * ⚠️ A 409 HERE IS THE ORDINARY ANSWER FOR AN INVOICE ISSUED A MOMENT AGO,
     *   NOT AN ERROR. The render is queued after the invoice commits and runs in
     *   the worker, so there is a window — usually about a second — in which an
     *   issued invoice has no bytes. The API's own sentence says to try again
     *   shortly, and it is passed through verbatim rather than replaced with
     *   something this layer invented. Plain text, because whoever is reading
     *   this asked for a document and got a browser tab.
     */
    return new NextResponse(file.message ?? 'This invoice has no document yet.', {
      status: file.status === 0 ? 502 : file.status,
      headers: {
        'content-type': 'text/plain; charset=utf-8',
        'cache-control': 'private, no-store',
      },
    });
  }

  return new NextResponse(file.body, {
    status: 200,
    headers: {
      'content-type': file.contentType ?? 'application/pdf',
      ...(file.contentDisposition ? { 'content-disposition': file.contentDisposition } : {}),
      // Restated rather than forwarded: this response is ours, and a bill must
      // not sit in a shared cache whatever the upstream said.
      'cache-control': 'private, no-store',
    },
  });
}
