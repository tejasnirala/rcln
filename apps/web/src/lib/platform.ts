import { cache } from 'react';
import type {
  PlatformOrganizationListResponse,
  TaxRegistrationListResponse,
} from '@rcln/contracts';
import { ADMIN_HOST, api, type ApiResult } from './api';
import { getAccessToken } from './session';

/**
 * Every clinic on the platform — the only list in the product that crosses the
 * tenant boundary.
 *
 * Memoised per request with React `cache` because two things now need it on the
 * same render: the header's clinic selector, which lives in the layout, and the
 * clinics page itself. Without this, opening that page costs two identical
 * cross-tenant queries.
 *
 * The full `ApiResult` rather than just the rows: a caller that renders a list
 * needs to tell "no clinics" apart from "we could not load the clinics", and an
 * empty array collapses the two.
 *
 * The API gates this on `users.is_platform_admin` and answers anyone else with a
 * 404, so this is not a surface that needs its own check — but nothing here
 * should be rendered to a caller the layout has not already vouched for.
 */
export const listPlatformOrganizations = cache(
  async (): Promise<ApiResult<PlatformOrganizationListResponse>> => {
    const accessToken = await getAccessToken();

    return api<PlatformOrganizationListResponse>('/api/v1/platform/organizations', {
      host: ADMIN_HOST,
      accessToken,
    });
  }
);

/**
 * Where rcln is registered to collect tax.
 *
 * Not memoised, unlike the clinic list above: it is read on one page and it is
 * the page that edits it, so a cached answer would be the stale one immediately
 * after a change.
 */
export async function listTaxRegistrations(): Promise<ApiResult<TaxRegistrationListResponse>> {
  return api<TaxRegistrationListResponse>('/api/v1/platform/tax-registrations', {
    host: ADMIN_HOST,
    accessToken: await getAccessToken(),
  });
}
