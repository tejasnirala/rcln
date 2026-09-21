import type { OnlineOrderStatus } from '@rcln/contracts';

/**
 * What each state is called, in one place.
 *
 * ⚠️ ITS OWN MODULE RATHER THAN AN EXPORT FROM `online-order-list.tsx`, AND THE
 *   REASON IS THE BUNDLE. The detail screen needs these seven strings and
 *   nothing else from the list — but importing them from that file pulled the
 *   whole list client component in with them: its filter grid, its pagination,
 *   and `usePathname` / `useRouter` / `useSearchParams`. A string map is not a
 *   reason to ship a screen nobody is looking at.
 *
 * ⚠️ AND THE WORDS ARE THE PRODUCT'S, NOT THE COLUMN'S. `CONFIRMED` reads
 *   "Accepted, stock held" because what a dispensary needs to know at a glance
 *   is that the shelf is already committed; `PACKED` reads "Made up" because
 *   that is what somebody did. Rendering the enum would be honest and useless.
 *
 * ⚠️ `EXPIRED` READS "Hold lapsed", NOT "Expired", BECAUSE "expired" IN A
 *   PHARMACY MEANS A DRUG PAST ITS DATE. The medicine is fine; what ran out was
 *   the reservation holding it, and the stock has gone back to the shelf. A word
 *   that means one thing in the enum and a frightening other thing on the floor
 *   is worth spending a few characters to avoid.
 */
export const ORDER_STATUS_LABEL: Record<OnlineOrderStatus, string> = {
  DRAFT: 'Being taken',
  CONFIRMED: 'Accepted, stock held',
  EXPIRED: 'Hold lapsed — stock released',
  PACKED: 'Made up',
  SHIPPED: 'With the courier',
  DELIVERED: 'Delivered',
  DELIVERY_FAILED: 'Delivery failed',
  CANCELLED: 'Stood down',
};
