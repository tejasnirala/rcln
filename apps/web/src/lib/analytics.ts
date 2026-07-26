/**
 * Analytics seam.
 *
 * Deliberately not wired to a provider yet. On a healthcare product, adding a
 * third-party script is a DPDP consent decision — consent banner, processing
 * agreement, where the data lands — not a front-end detail. Until that is
 * settled this logs in development and does nothing in production, so no
 * cookies are set and no consent is required.
 *
 * When a provider is chosen, this is the only file that changes: every call
 * site already goes through `track`.
 */

export type AnalyticsEvent =
  | 'cta_book_demo'
  | 'cta_log_in'
  | 'demo_request_submitted'
  | 'demo_request_failed'
  | 'pricing_viewed'
  | 'cta_start_clinic'
  | 'signup_completed'
  | 'signup_failed';

export function track(event: AnalyticsEvent, props?: Record<string, string | number>): void {
  if (process.env.NODE_ENV === 'development') {
    console.debug('[analytics]', event, props ?? {});
  }
}
