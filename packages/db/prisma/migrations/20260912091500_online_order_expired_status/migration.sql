-- ---------------------------------------------------------------------------
-- An abandoned order stops claiming to be confirmed (PI-24, KNOWN_ISSUES #23).
--
-- The reservation sweep releases a hold whose `expires_at` has passed and knows
-- nothing about the order that placed it, so an order nobody packed kept saying
-- CONFIRMED for ever — while its stock had gone back to the shelf. The screen
-- said the parcel was coming and the shelf said otherwise.
--
-- ⚠️ `EXPIRED` KEEPS THE NUMBER AND THE CONFIRMATION, WHICH IS WHY IT IS NOT
--   `DRAFT`. This CHECK is what made that obvious: DRAFT requires
--   `order_number IS NULL`, so rolling an abandoned order back would destroy the
--   reference the patient was given. Nor is it CANCELLED — nobody cancelled it,
--   and that branch requires a `cancellation_reason` somebody wrote.
--
--   So its branch is CONFIRMED's, verbatim: numbered, confirmed, not packed, not
--   cancelled, no dispense. What changes is only that it can no longer be
--   packed, which the service enforces.
-- ---------------------------------------------------------------------------
ALTER TABLE "online_orders" DROP CONSTRAINT "online_orders_status_is_consistent";

ALTER TABLE "online_orders" ADD CONSTRAINT "online_orders_status_is_consistent" CHECK (
  (
    "status" = 'DRAFT'
    AND "order_number" IS NULL AND "confirmed_at" IS NULL
    AND "packed_at" IS NULL AND "cancelled_at" IS NULL AND "dispense_id" IS NULL
  ) OR (
    "status" IN ('CONFIRMED', 'EXPIRED')
    AND "order_number" IS NOT NULL AND "confirmed_at" IS NOT NULL
    AND "packed_at" IS NULL AND "cancelled_at" IS NULL AND "dispense_id" IS NULL
  ) OR (
    "status" IN ('PACKED', 'SHIPPED', 'DELIVERED', 'DELIVERY_FAILED')
    AND "order_number" IS NOT NULL AND "confirmed_at" IS NOT NULL
    AND "packed_at" IS NOT NULL AND "dispense_id" IS NOT NULL AND "cancelled_at" IS NULL
  ) OR (
    "status" = 'CANCELLED'
    AND "cancelled_at" IS NOT NULL AND "cancellation_reason" IS NOT NULL
    AND "packed_at" IS NULL AND "dispense_id" IS NULL
  )
);
