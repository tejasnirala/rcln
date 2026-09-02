'use server';

import type {
  BatchListResponse,
  BatchSummary,
  PatientListResponse,
  PatientSummary,
  ProductListResponse,
  ProductSummary,
  ScanResolveResponse,
} from '@rcln/contracts';
import { api } from '@/lib/api';
import { getAccessToken } from '@/lib/session';

/**
 * PI-23 — the four lookups every screen in this application needs, in one place.
 *
 * ⚠️ THIS FILE IS THE ANSWER TO THE `PICKER_LIMIT` DEBT, AND THE DEBT WAS REAL.
 *   Seven screens fetched the first 100 (or 200) products at render and filtered
 *   them in a `<select>`, each with an honest note saying the cap was PI-23's
 *   work. A clinic with three thousand products got a picker that silently could
 *   not reach most of its own catalogue — and the goods-receipt and order forms
 *   went one worse and asked a receptionist to type raw UUIDs (KNOWN_ISSUES #25,
 *   #25b, #31). Searching on the server is the fix: the cap disappears because
 *   nothing is ever listed exhaustively.
 *
 * ⚠️ AND IT IS AN ACTION RATHER THAN A ROUTE HANDLER, for the reason
 *   `history-actions.ts` gives: the access token is httpOnly and stays on the
 *   server. A `/api` proxy route would have to re-implement the tenant header
 *   and the token read, and would be a second door onto the same two endpoints.
 *
 * `slug` is bound on the server before this reaches the browser. Everything else
 * comes FROM the browser, which is fine: both endpoints gate on a permission
 * code and both tables are under RLS, so a tampered argument returns this
 * clinic's own rows or none.
 *
 * ⚠️ THREE OF THE FOUR CARRY NO PHI AT ALL — a product is a product and a barcode
 *   names a box. `searchPatients` is the exception and is marked at its own
 *   definition: it returns names, and the API logs the disclosure.
 */

export type ProductSearchState =
  | { status: 'idle' }
  | { status: 'done'; products: ProductSummary[]; term: string; capped: boolean }
  | { status: 'error'; message: string };

/** How many rows one search offers. A person picks from a short list or types more. */
const SEARCH_LIMIT = 20;

export interface ProductSearchFilters {
  /** `LOT_BATCH`, `SERIAL`, … Several are passed as several calls; see below. */
  trackingModes?: string[];
  isStockItem?: boolean;
  status?: string;
}

/**
 * Find products by name, code, brand or barcode.
 *
 * ⚠️ SEVERAL TRACKING MODES ARE SEVERAL CALLS, NOT A COMMA-SEPARATED PARAMETER.
 *   `productListQuery.trackingMode` takes one value, and the lot form already
 *   made two parallel calls for exactly this reason before PI-23 touched it.
 *   Inventing a multi-value parameter for one picker would be a contract change
 *   in service of a client convenience.
 */
export async function searchProducts(
  slug: string,
  rawTerm: string,
  filters: ProductSearchFilters = {}
): Promise<ProductSearchState> {
  const term = rawTerm.trim();
  if (term.length < 2) return { status: 'idle' };

  const accessToken = await getAccessToken();
  const base = new URLSearchParams({ q: term, limit: String(SEARCH_LIMIT) });
  if (filters.isStockItem === true) base.set('isStockItem', 'true');
  if (filters.status !== undefined) base.set('status', filters.status);

  const modes = filters.trackingModes ?? [];
  const queries =
    modes.length === 0
      ? [base.toString()]
      : modes.map((mode) => {
          const q = new URLSearchParams(base);
          q.set('trackingMode', mode);
          return q.toString();
        });

  const results = await Promise.all(
    queries.map((q) => api<ProductListResponse>(`/api/v1/products?${q}`, { slug, accessToken }))
  );

  const failure = results.find((r) => !r.ok || !r.data);
  if (failure) {
    return {
      status: 'error',
      message:
        failure.status === 403
          ? 'You cannot browse the catalogue here.'
          : (failure.message ?? 'The search could not be run.'),
    };
  }

  const products = results
    .flatMap((r) => r.data?.products ?? [])
    .sort((a, b) => a.name.localeCompare(b.name));

  /*
   * ⚠️ "MORE MATCHED THAN ARE SHOWN" IS SAID OUT LOUD. This is the honest
   *   remnant of the old cap: a search that returns exactly twenty rows may have
   *   matched two hundred, and a picker that shows twenty and implies twenty is
   *   the same silent truncation with a search box in front of it.
   */
  const capped = results.some((r) => (r.data?.meta.total ?? 0) > SEARCH_LIMIT);

  return { status: 'done', products, term, capped };
}

export type ScanState =
  | { status: 'idle' }
  | { status: 'done'; result: ScanResolveResponse }
  | { status: 'error'; message: string };

/**
 * Decode a scan and resolve it to a product, a lot and a device.
 *
 * ⚠️ THE PAYLOAD IS SENT VERBATIM AND IS NEVER CLEANED UP HERE. Trimming,
 *   upper-casing or stripping the reader's symbology prefix in the browser would
 *   change what the decoder sees, and the decoder is the only thing that knows
 *   which characters are data — a lot number is case-sensitive to a regulator,
 *   and `]d2` in front of a payload is a fact about the READER that the decoder
 *   uses to tell a DataMatrix from a hand-typed line.
 */
export async function resolveScan(
  slug: string,
  code: string,
  branchId?: string
): Promise<ScanState> {
  if (code.trim() === '') return { status: 'idle' };

  const query = new URLSearchParams({ code });
  if (branchId !== undefined && branchId !== '') query.set('branchId', branchId);

  const result = await api<ScanResolveResponse>(`/api/v1/stock/resolve?${query.toString()}`, {
    slug,
    accessToken: await getAccessToken(),
  });

  if (!result.ok || !result.data) {
    return {
      status: 'error',
      message:
        result.status === 403
          ? 'You cannot resolve scans here. It needs both the stock and the catalogue read permissions.'
          : (result.message ?? 'The scan could not be resolved.'),
    };
  }

  return { status: 'done', result: result.data };
}

export type LotListState =
  | { status: 'idle' }
  | { status: 'done'; lots: BatchSummary[]; capped: boolean }
  | { status: 'error'; message: string };

/** How many lots one product at one branch offers before the screen says so. */
const LOT_LIMIT = 100;

/**
 * The open lots of ONE product at ONE branch.
 *
 * ⚠️ FETCHED AFTER THE PRODUCT IS CHOSEN, NOT BEFORE. The serial form used to
 *   pull the first hundred lots at ANY branch for ANY product and narrow them in
 *   the browser — so the lot somebody was holding was missing whenever the
 *   clinic had more than a hundred open lots, which is most clinics, and the
 *   form could only say "showing the most recent". Asking once the product and
 *   the branch are known makes the list short enough to be complete:
 *   `batches` is indexed on `(organization_id, branch_id, product_id,
 *   expires_on)`, which is this exact query.
 */
export async function lotsForProduct(
  slug: string,
  productId: string,
  branchId: string
): Promise<LotListState> {
  if (productId === '' || branchId === '') return { status: 'idle' };

  const query = new URLSearchParams({
    productId,
    branchId,
    status: 'ACTIVE',
    limit: String(LOT_LIMIT),
  });

  const result = await api<BatchListResponse>(`/api/v1/batches?${query.toString()}`, {
    slug,
    accessToken: await getAccessToken(),
  });

  if (!result.ok || !result.data) {
    return {
      status: 'error',
      message:
        result.status === 403
          ? 'You cannot browse lots here.'
          : (result.message ?? 'The lots could not be loaded.'),
    };
  }

  const lots = result.data.batches;
  return { status: 'done', lots, capped: result.data.meta.total > lots.length };
}

export type PatientSearchState =
  | { status: 'idle' }
  | { status: 'done'; patients: PatientSummary[]; term: string }
  | { status: 'error'; message: string };

/**
 * Find a patient by name, phone or UHID.
 *
 * ⚠️ THIS ONE IS PHI, AND IT IS HERE BECAUSE THE ORDER FORM ASKED A RECEPTIONIST
 *   TO TYPE A UUID (KNOWN_ISSUES #25). A parcel has to go to somebody on the
 *   clinic's list, and the only way anybody had to name that somebody was to
 *   copy a database id off another screen — which made the field unusable by the
 *   person it was designed for, and made a mis-pasted id a parcel sent to the
 *   wrong patient.
 *
 * ⚠️ `scope: 'BRANCH'`, WHICH IS THE DEFAULT AND IS STATED ANYWAY. Widening to
 *   the organization is a deliberate act that ADR-0016 logs as such; a picker on
 *   a dispensing form has no business doing it silently.
 *
 * Nothing returned here is logged, cached or put in a URL. It is rendered and
 * dropped — the API writes the `data_access_logs` row.
 */
export async function searchPatients(slug: string, rawTerm: string): Promise<PatientSearchState> {
  const term = rawTerm.trim();
  if (term.length < 2) return { status: 'idle' };

  const query = new URLSearchParams({ q: term, scope: 'BRANCH', limit: '10' });
  const result = await api<PatientListResponse>(`/api/v1/patients?${query.toString()}`, {
    slug,
    accessToken: await getAccessToken(),
  });

  if (!result.ok || !result.data) {
    return {
      status: 'error',
      message:
        result.status === 403
          ? 'You do not have access to patient records here.'
          : (result.message ?? 'The search could not be run.'),
    };
  }

  return { status: 'done', patients: result.data.patients, term };
}
