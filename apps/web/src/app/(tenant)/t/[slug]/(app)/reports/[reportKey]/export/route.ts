import { NextResponse, type NextRequest } from 'next/server';
import { apiBinary } from '@/lib/api';
import { getAccessToken } from '@/lib/session';
import { REPORT_PATHS } from '@/lib/report-specs';

/**
 * A report as a CSV, on its way to the browser.
 *
 * WHY THIS IS A ROUTE HANDLER AND NOT A LINK STRAIGHT AT THE API
 *   The access token is in an httpOnly cookie on this host. A browser fetching
 *   the API directly would send no credential and get a 401, and the only way to
 *   give it one is to put the token somewhere a script can read — the thing
 *   httpOnly exists to prevent. The same reasoning the invoice PDF handler
 *   gives, and the same shape.
 *
 * ⚠️ EVERY DECISION HERE IS THE API'S, INCLUDING WHETHER THIS CALLER MAY EXPORT
 *   AT ALL. `?format=csv` is what makes the API require `report.export` on top
 *   of the report's own read code; this handler adds no check of its own and
 *   must not. A second opinion about who may take a table out of the building is
 *   a second place for that opinion to be wrong. It forwards, and it passes the
 *   refusal back.
 *
 * ⚠️ THE QUERY STRING IS FORWARDED WHOLE AND `format` IS FORCED. Forwarding it
 *   is what makes the file match the screen the person was looking at — an
 *   export with different filters from the report above it is the discrepancy an
 *   auditor finds. Forcing `format` means a hand-typed `?format=json` cannot
 *   turn this route into an unaudited JSON proxy that skips the export
 *   permission; the API would answer, and it would answer without asking for
 *   `report.export`.
 *
 * ⚠️ AND `private, no-store`, RESTATED RATHER THAN FORWARDED. A stock valuation
 *   is commercially sensitive and must not sit in a shared cache whatever the
 *   upstream said. Nothing here is PHI — no report names a patient — but "not
 *   PHI" is not "publishable".
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ slug: string; reportKey: string }> }
): Promise<NextResponse> {
  const { slug, reportKey } = await params;

  /*
   * ⚠️ `Object.hasOwn` BECAUSE A BARE LOOKUP READS THROUGH THE PROTOTYPE.
   *   `REPORT_PATHS` is an object literal, so `/reports/constructor/export`,
   *   `/reports/__proto__/export` and `/reports/toString/export` all returned a
   *   truthy `path` and walked past this 404 into a malformed upstream URL. No
   *   data reached anyone — the API host is fixed, so there is no SSRF and the
   *   result was a 502 — but a 404 is the honest answer and an inherited
   *   property is never a report. (PI-24 review.)
   */
  const path = Object.hasOwn(REPORT_PATHS, reportKey) ? REPORT_PATHS[reportKey] : undefined;
  if (!path) {
    return new NextResponse('No such report.', {
      status: 404,
      headers: {
        'content-type': 'text/plain; charset=utf-8',
        'cache-control': 'private, no-store',
      },
    });
  }

  const query = new URLSearchParams(request.nextUrl.searchParams);
  query.set('format', 'csv');

  const file = await apiBinary(`/api/v1${path}?${query.toString()}`, {
    slug,
    accessToken: await getAccessToken(),
    accept: 'text/csv, application/json',
  });

  if (!file.ok || !file.body) {
    return new NextResponse(file.message ?? 'This report could not be exported.', {
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
      'content-type': file.contentType ?? 'text/csv; charset=utf-8',
      ...(file.contentDisposition ? { 'content-disposition': file.contentDisposition } : {}),
      'cache-control': 'private, no-store',
    },
  });
}
