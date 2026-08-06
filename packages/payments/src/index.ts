/**
 * `@rcln/payments` — everything about talking to a payment provider, and
 * nothing about what a subscription is.
 *
 * The billing rules (proration, dunning, cancellation, entitlements) live in
 * `@rcln/billing`; they are the same rules whoever the acquirer is. This package
 * knows about money, currencies and one HTTP API at a time.
 *
 * It has no dependencies, reads no environment variables, and touches no
 * database. That is what makes it testable without a gateway and swappable
 * without a migration.
 */

export * from './types.js';
export * from './errors.js';
export * from './money.js';
export * from './currency.js';
export * from './registry.js';
export { CashfreeProvider, type CashfreeConfig } from './providers/cashfree.js';
export { RazorpayProvider, type RazorpayConfig } from './providers/razorpay.js';
export {
  MockProvider,
  InMemoryMockStore,
  type MockConfig,
  type MockOutcome,
  type MockStore,
} from './providers/mock.js';
