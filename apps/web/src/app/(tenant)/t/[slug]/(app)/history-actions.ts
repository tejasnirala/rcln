'use server';

import type { AuditHistoryResponse, TimeFormat } from '@rcln/contracts';
import { api } from '@/lib/api';
import { getAccessToken, timeFormatOf, timezoneOf } from '@/lib/session';

/**
 * A record's history, fetched when somebody asks for it.
 *
 * WHY AN ACTION AND NOT PART OF THE PAGE'S OWN FETCH
 *   The history drawer is opened for one record at a time, rarely. Loading it with
 *   the list would mean an audit query per row on every render of every screen —
 *   the cost of a feature nobody has clicked. This is lazy by design, and the
 *   drawer shows a loading state for the one request it makes.
 *
 * `slug` is bound on the server before this reaches the browser, so a client
 * cannot re-point it at another clinic. `entityType` and `entityId` DO come from
 * the browser, and that is fine: the API gates on `audit.record.read` and
 * `audit_logs` is under RLS, so the worst a tampered pair can do is return an
 * empty list for a record in the caller's own organization.
 */

export type HistoryState =
  | {
      status: 'ok';
      history: AuditHistoryResponse;
      /**
       * The clinic's zone, so the drawer can stamp each entry in it.
       *
       * ⚠️ RETURNED WITH THE PAYLOAD RATHER THAN PASSED IN AS A PROP. The drawer
       *   is rendered from six different lists, none of which has any other
       *   reason to know a timezone — threading one through all six is six
       *   chances to forget. This action already runs on the server with the
       *   slug bound to it, so it is the cheapest honest place to answer.
       */
      timezone: string;
      /** And the clock face it reads in — same argument as `timezone` above. */
      timeFormat: TimeFormat;
    }
  | { status: 'error'; message: string };

export async function readRecordHistory(
  slug: string,
  entityType: string,
  entityId: string
): Promise<HistoryState> {
  const accessToken = await getAccessToken();
  if (!accessToken) {
    return { status: 'error', message: 'Your session has expired. Sign in again.' };
  }

  const query = new URLSearchParams({ entityType, entityId });

  const result = await api<AuditHistoryResponse>(`/api/v1/audit?${query.toString()}`, {
    slug,
    accessToken,
  });

  if (!result.ok || !result.data) {
    return {
      status: 'error',
      message:
        result.status === 403
          ? 'You do not have access to this record’s history.'
          : (result.message ?? 'We could not load the history.'),
    };
  }

  const [timezone, timeFormat] = await Promise.all([timezoneOf(slug), timeFormatOf(slug)]);
  return { status: 'ok', history: result.data, timezone, timeFormat };
}
