-- ---------------------------------------------------------------------------
-- PI-12 — Online pharmacy: order, hold, pack, ship, deliver.
--
-- ⚠️ FOUR STATEMENTS PRISMA GENERATED WERE DELETED FROM THIS FILE BY HAND, AND
--   DELETING THEM WAS THE POINT.
--
--   Two were `ALTER COLUMN "item_id" DROP NOT NULL` on `encounter_procedures`
--   and `encounter_investigations` — because CE-4 tightened both in hand-written
--   SQL the Prisma schema cannot express. Letting a later diff carry them along
--   would silently revert a deliberate constraint on the clinical record. Every
--   future diff in this repository will want to do it again; delete it again.
--   PI-7's migration carries the identical warning.
--
--   The other three were the `ALTER TYPE ... ADD VALUE` statements, moved to
--   `..090000_online_pharmacy_enum_members`. The CHECK rewritten below NAMES
--   `'ONLINE'`, and Postgres refuses to use a new enum value in the transaction
--   that added it — see that file.
--
-- What is hand-written below the generated section: the CHECK constraints, the
-- rewrite of `dispenses_prescription_has_patient`, and the RLS policies for the
-- three new tables (mirrored in `prisma/rls/enable-rls.sql`, which is the file
-- `db:rls:check` reads).
--
-- ⚠️ THE TWO NULLABLE UNIQUE INDEXES BELOW ARE **NOT** REWRITTEN NULLS NOT
--   DISTINCT, WHICH IS THE OPPOSITE CALL FROM EVERY OTHER ONE IN THIS SCHEMA.
--   `order_number` is NULL on every draft and `dispense_id` on every unpacked
--   order; collapsing those NULLs would let a branch hold exactly one draft, and
--   one unpacked order, at a time. Postgres' default `NULLS DISTINCT` is what is
--   wanted here — issued numbers and packed dispenses are still unique.
-- ---------------------------------------------------------------------------

-- CreateEnum
CREATE TYPE "OnlineOrderChannel" AS ENUM ('WEB', 'PHONE', 'WHATSAPP', 'EMAIL', 'COUNTER');

-- CreateEnum
CREATE TYPE "OnlineOrderStatus" AS ENUM ('DRAFT', 'CONFIRMED', 'PACKED', 'SHIPPED', 'DELIVERED', 'DELIVERY_FAILED', 'CANCELLED');

-- CreateTable
CREATE TABLE "online_orders" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "order_number" VARCHAR(64),
    "channel" "OnlineOrderChannel" NOT NULL,
    "status" "OnlineOrderStatus" NOT NULL DEFAULT 'DRAFT',
    "patient_id" UUID NOT NULL,
    "encounter_id" UUID,
    "location_id" UUID NOT NULL,
    "recipient_name" VARCHAR(255) NOT NULL,
    "recipient_phone" VARCHAR(20) NOT NULL,
    "address_line1" VARCHAR(255) NOT NULL,
    "address_line2" VARCHAR(255),
    "city" VARCHAR(100),
    "state" VARCHAR(100),
    "pincode" VARCHAR(10),
    "destination_country_code" CHAR(2) NOT NULL,
    "destination_region_code" VARCHAR(16),
    "patient_address_id" UUID,
    "notes" TEXT,
    "placed_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "placed_by_id" UUID NOT NULL,
    "confirmed_at" TIMESTAMPTZ(6),
    "confirmed_by_id" UUID,
    "packed_at" TIMESTAMPTZ(6),
    "packed_by_id" UUID,
    "cancelled_at" TIMESTAMPTZ(6),
    "cancelled_by_id" UUID,
    "cancellation_reason" TEXT,
    "dispense_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "online_orders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "online_order_lines" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "online_order_id" UUID NOT NULL,
    "line_number" SMALLINT NOT NULL,
    "encounter_prescription_id" UUID,
    "product_id" UUID NOT NULL,
    "quantity_entered" DECIMAL(18,6) NOT NULL,
    "unit_id" UUID NOT NULL,
    "quantity_base" DECIMAL(18,6) NOT NULL,
    "regulatory_decision_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "online_order_lines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "online_order_shipments" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "online_order_id" UUID NOT NULL,
    "carrier_name" VARCHAR(128) NOT NULL,
    "service_level" VARCHAR(64),
    "tracking_reference" VARCHAR(128),
    "package_count" SMALLINT NOT NULL DEFAULT 1,
    "shipped_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "shipped_by_id" UUID NOT NULL,
    "delivered_at" TIMESTAMPTZ(6),
    "delivered_by_id" UUID,
    "received_by_name" VARCHAR(255),
    "failed_at" TIMESTAMPTZ(6),
    "failed_by_id" UUID,
    "failure_reason" TEXT,
    "notes" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "online_order_shipments_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "online_orders_organization_id_branch_id_status_placed_at_idx" ON "online_orders"("organization_id", "branch_id", "status", "placed_at");

-- CreateIndex
CREATE INDEX "online_orders_organization_id_patient_id_placed_at_idx" ON "online_orders"("organization_id", "patient_id", "placed_at" DESC);

-- CreateIndex
CREATE INDEX "online_orders_organization_id_encounter_id_idx" ON "online_orders"("organization_id", "encounter_id");

-- CreateIndex
CREATE UNIQUE INDEX "online_orders_organization_id_order_number_key" ON "online_orders"("organization_id", "order_number");

-- CreateIndex
CREATE UNIQUE INDEX "online_orders_organization_id_dispense_id_key" ON "online_orders"("organization_id", "dispense_id");

-- CreateIndex
CREATE UNIQUE INDEX "online_orders_organization_id_id_key" ON "online_orders"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "online_orders_organization_id_branch_id_id_key" ON "online_orders"("organization_id", "branch_id", "id");

-- CreateIndex
CREATE INDEX "online_order_lines_organization_id_online_order_id_idx" ON "online_order_lines"("organization_id", "online_order_id");

-- CreateIndex
CREATE INDEX "online_order_lines_organization_id_product_id_idx" ON "online_order_lines"("organization_id", "product_id");

-- CreateIndex
CREATE INDEX "online_order_lines_organization_id_encounter_prescription_i_idx" ON "online_order_lines"("organization_id", "encounter_prescription_id");

-- CreateIndex
CREATE UNIQUE INDEX "online_order_lines_organization_id_online_order_id_line_num_key" ON "online_order_lines"("organization_id", "online_order_id", "line_number");

-- CreateIndex
-- ⚠️ ONE LINE PER PRODUCT. See the model comment: each line's reservations cite
--   THAT LINE's id, and two lines naming one product would be two holds for one
--   medicine and two answers to how much is coming.
CREATE UNIQUE INDEX "online_order_lines_organization_id_online_order_id_product__key" ON "online_order_lines"("organization_id", "online_order_id", "product_id");

-- CreateIndex
CREATE UNIQUE INDEX "online_order_lines_organization_id_id_key" ON "online_order_lines"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "online_order_lines_organization_id_branch_id_id_key" ON "online_order_lines"("organization_id", "branch_id", "id");

-- CreateIndex
CREATE INDEX "online_order_shipments_organization_id_branch_id_shipped_at_idx" ON "online_order_shipments"("organization_id", "branch_id", "shipped_at" DESC);

-- CreateIndex
CREATE INDEX "online_order_shipments_organization_id_tracking_reference_idx" ON "online_order_shipments"("organization_id", "tracking_reference");

-- CreateIndex
CREATE UNIQUE INDEX "online_order_shipments_organization_id_online_order_id_key" ON "online_order_shipments"("organization_id", "online_order_id");

-- CreateIndex
CREATE UNIQUE INDEX "online_order_shipments_organization_id_id_key" ON "online_order_shipments"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "online_order_shipments_organization_id_branch_id_id_key" ON "online_order_shipments"("organization_id", "branch_id", "id");

-- AddForeignKey
ALTER TABLE "online_orders" ADD CONSTRAINT "online_orders_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "online_orders" ADD CONSTRAINT "online_orders_organization_id_branch_id_fkey" FOREIGN KEY ("organization_id", "branch_id") REFERENCES "branches"("organization_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "online_orders" ADD CONSTRAINT "online_orders_organization_id_patient_id_fkey" FOREIGN KEY ("organization_id", "patient_id") REFERENCES "patients"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "online_orders" ADD CONSTRAINT "online_orders_organization_id_encounter_id_fkey" FOREIGN KEY ("organization_id", "encounter_id") REFERENCES "encounters"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "online_orders" ADD CONSTRAINT "online_orders_organization_id_branch_id_location_id_fkey" FOREIGN KEY ("organization_id", "branch_id", "location_id") REFERENCES "inventory_locations"("organization_id", "branch_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "online_orders" ADD CONSTRAINT "online_orders_organization_id_dispense_id_fkey" FOREIGN KEY ("organization_id", "dispense_id") REFERENCES "dispenses"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "online_orders" ADD CONSTRAINT "online_orders_placed_by_id_fkey" FOREIGN KEY ("placed_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "online_orders" ADD CONSTRAINT "online_orders_confirmed_by_id_fkey" FOREIGN KEY ("confirmed_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "online_orders" ADD CONSTRAINT "online_orders_packed_by_id_fkey" FOREIGN KEY ("packed_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "online_orders" ADD CONSTRAINT "online_orders_cancelled_by_id_fkey" FOREIGN KEY ("cancelled_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "online_order_lines" ADD CONSTRAINT "online_order_lines_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "online_order_lines" ADD CONSTRAINT "online_order_lines_organization_id_branch_id_fkey" FOREIGN KEY ("organization_id", "branch_id") REFERENCES "branches"("organization_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "online_order_lines" ADD CONSTRAINT "online_order_lines_organization_id_online_order_id_fkey" FOREIGN KEY ("organization_id", "online_order_id") REFERENCES "online_orders"("organization_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "online_order_lines" ADD CONSTRAINT "online_order_lines_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "online_order_lines" ADD CONSTRAINT "online_order_lines_unit_id_fkey" FOREIGN KEY ("unit_id") REFERENCES "units_of_measure"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "online_order_lines" ADD CONSTRAINT "online_order_lines_organization_id_encounter_prescription__fkey" FOREIGN KEY ("organization_id", "encounter_prescription_id") REFERENCES "encounter_prescriptions"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "online_order_lines" ADD CONSTRAINT "online_order_lines_organization_id_regulatory_decision_id_fkey" FOREIGN KEY ("organization_id", "regulatory_decision_id") REFERENCES "regulatory_decisions"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "online_order_shipments" ADD CONSTRAINT "online_order_shipments_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "online_order_shipments" ADD CONSTRAINT "online_order_shipments_organization_id_branch_id_fkey" FOREIGN KEY ("organization_id", "branch_id") REFERENCES "branches"("organization_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "online_order_shipments" ADD CONSTRAINT "online_order_shipments_organization_id_online_order_id_fkey" FOREIGN KEY ("organization_id", "online_order_id") REFERENCES "online_orders"("organization_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "online_order_shipments" ADD CONSTRAINT "online_order_shipments_shipped_by_id_fkey" FOREIGN KEY ("shipped_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "online_order_shipments" ADD CONSTRAINT "online_order_shipments_delivered_by_id_fkey" FOREIGN KEY ("delivered_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "online_order_shipments" ADD CONSTRAINT "online_order_shipments_failed_by_id_fkey" FOREIGN KEY ("failed_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- ---------------------------------------------------------------------------
-- CHECK constraints: the rules the type system cannot hold
--
-- Every one of these is a statement a SERVICE also makes. That is not
-- duplication — the service explains itself to a human with a sentence, and the
-- constraint holds when a later import, a fixture or a second code path forgets
-- to. PI-2 through PI-4 each found one of those, and PI-11 found one in its own
-- new CHECK.
-- ---------------------------------------------------------------------------

-- ⚠️ REWRITTEN, NOT ADDED TO. PI-7 wrote this constraint as a two-way choice
--   between the counter's two kinds; an ONLINE dispense satisfies neither arm
--   and every parcel would have been refused by the database.
--
--   The new arm ties ONLINE to a PATIENT and deliberately NOT to an encounter: a
--   parcel has to go to somebody — a supply nobody can attribute cannot be traced
--   when its lot is recalled — but it may or may not be against a prescription,
--   exactly as a counter sale may or may not be.
ALTER TABLE "dispenses" DROP CONSTRAINT "dispenses_prescription_has_patient";
ALTER TABLE "dispenses" ADD CONSTRAINT "dispenses_prescription_has_patient"
  CHECK (
    ("kind" = 'PRESCRIPTION' AND "encounter_id" IS NOT NULL AND "patient_id" IS NOT NULL)
    OR ("kind" = 'COUNTER_SALE' AND "encounter_id" IS NULL)
    OR ("kind" = 'ONLINE' AND "patient_id" IS NOT NULL)
  );

-- Who did what and when, on every act that has an actor. An acceptance
-- attributed to nobody is not an acceptance, and a `packed_at` with no packer is
-- a parcel nobody can be asked about.
ALTER TABLE "online_orders" ADD CONSTRAINT "online_orders_acts_are_attributed"
  CHECK (
    ("confirmed_at" IS NULL) = ("confirmed_by_id" IS NULL)
    AND ("packed_at" IS NULL) = ("packed_by_id" IS NULL)
    AND ("cancelled_at" IS NULL) = ("cancelled_by_id" IS NULL)
  );

-- ⚠️ THE STATE MACHINE, WRITTEN DOWN WHERE THE SERVICE CANNOT FORGET IT. Each
--   arm says what must ALREADY have happened for the order to be in that state:
--
--     DRAFT      nothing has. No number, no acceptance, no parcel.
--     CONFIRMED  accepted, and not yet packed.
--     the four
--     fulfilment
--     states     packed, which means a dispense exists.
--     CANCELLED  ⚠️ AND NO DISPENSE. Cancellation is only possible before
--                packing: after it the medicine has physically left, and undoing
--                that is a `dispense_returns` row. A CANCELLED order carrying a
--                dispense id would be a cancellation the stock ledger has never
--                heard of.
--
--   The number is required from CONFIRMED onwards for the same reason a purchase
--   order's is: it is quoted back by somebody outside the clinic.
ALTER TABLE "online_orders" ADD CONSTRAINT "online_orders_status_is_consistent"
  CHECK (
    (
      "status" = 'DRAFT'
      AND "order_number" IS NULL
      AND "confirmed_at" IS NULL
      AND "packed_at" IS NULL
      AND "cancelled_at" IS NULL
      AND "dispense_id" IS NULL
    )
    OR (
      "status" = 'CONFIRMED'
      AND "order_number" IS NOT NULL
      AND "confirmed_at" IS NOT NULL
      AND "packed_at" IS NULL
      AND "cancelled_at" IS NULL
      AND "dispense_id" IS NULL
    )
    OR (
      "status" IN ('PACKED', 'SHIPPED', 'DELIVERED', 'DELIVERY_FAILED')
      AND "order_number" IS NOT NULL
      AND "confirmed_at" IS NOT NULL
      AND "packed_at" IS NOT NULL
      AND "dispense_id" IS NOT NULL
      AND "cancelled_at" IS NULL
    )
    OR (
      "status" = 'CANCELLED'
      AND "cancelled_at" IS NOT NULL
      AND "cancellation_reason" IS NOT NULL
      AND "packed_at" IS NULL
      AND "dispense_id" IS NULL
    )
  );

-- A destination that is two letters and a region that is not the country prefix
-- repeated. ⚠️ `IN-KA` IN `destination_region_code` WOULD RENDER AS `IN-IN-KA`
--   and would miss every regional rule silently — the failure mode every region
--   column in this schema shares, written down once here because this is the one
--   a client supplies directly.
ALTER TABLE "online_orders" ADD CONSTRAINT "online_orders_destination_is_a_jurisdiction"
  CHECK (
    "destination_country_code" ~ '^[A-Z]{2}$'
    AND (
      "destination_region_code" IS NULL
      OR ("destination_region_code" <> '' AND "destination_region_code" NOT LIKE '%-%')
    )
  );

ALTER TABLE "online_order_lines" ADD CONSTRAINT "online_order_lines_quantities_positive"
  CHECK ("quantity_entered" > 0 AND "quantity_base" > 0);

ALTER TABLE "online_order_shipments" ADD CONSTRAINT "online_order_shipments_packages_positive"
  CHECK ("package_count" > 0);

ALTER TABLE "online_order_shipments" ADD CONSTRAINT "online_order_shipments_outcomes_are_attributed"
  CHECK (
    ("delivered_at" IS NULL) = ("delivered_by_id" IS NULL)
    AND ("failed_at" IS NULL) = ("failed_by_id" IS NULL)
    AND ("failed_at" IS NULL OR "failure_reason" IS NOT NULL)
  );

-- ⚠️ A FAILED ATTEMPT AND A DELIVERY CAN BOTH BE TRUE, AND THAT IS DELIBERATE. A
--   courier failing on Tuesday and delivering on Wednesday is the ordinary case;
--   clearing `failed_at` would hide an attempt somebody may have to answer for,
--   and refusing the delivery would leave the record disagreeing with the parcel.
--   What is forbidden is the impossible ORDER — arriving before failing to.
ALTER TABLE "online_order_shipments" ADD CONSTRAINT "online_order_shipments_outcomes_are_ordered"
  CHECK (
    "delivered_at" IS NULL
    OR "failed_at" IS NULL
    OR "delivered_at" >= "failed_at"
  );

-- ---------------------------------------------------------------------------
-- RLS — the three new tables
--
-- ⚠️ A TENANT TABLE WITHOUT A POLICY PRODUCES NO ERROR AND BREAKS NO
--   SINGLE-TENANT TEST. It just starts returning other clinics' records — and
--   the records here are "which medicine was sent to which named person's
--   house". `db:rls:check` fails until these exist, deliberately.
--
-- ⚠️ ALL THREE ARE IN BOTH LOOPS, WHICH IS THE FIRST TIME SINCE PI-7 THAT A
--   PHASE'S TABLES SHARE ONE TENANCY CLASS. PI-8, PI-9 and PI-10 each had a
--   configuration table with no `branch_id`; nothing here is configuration. An
--   order is fulfilled from ONE shelf, in ONE jurisdiction, and the parcel leaves
--   from that site — so `branch_id` is NOT NULL on all three and the branch
--   predicate is absolute rather than the `IS NULL OR` shape it takes elsewhere.
--   The wording is kept identical to `enable-rls.sql` so the two can be diffed by
--   eye.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  t text;
  online_tables text[] := ARRAY[
    'online_orders',
    'online_order_lines',
    'online_order_shipments'
  ];
BEGIN
  FOREACH t IN ARRAY online_tables LOOP
    EXECUTE format('ALTER TABLE %I ENABLE   ROW LEVEL SECURITY', t);
    -- ENABLE, not FORCE: the owner must keep bypassing so migrations and seeds
    -- work (ADR-0003).
    EXECUTE format('ALTER TABLE %I NO FORCE ROW LEVEL SECURITY', t);

    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t);
    EXECUTE format($f$
      CREATE POLICY tenant_isolation ON %I
        USING       (organization_id = app_current_org())
        WITH CHECK  (organization_id = app_current_org())
    $f$, t);

    EXECUTE format('DROP POLICY IF EXISTS branch_isolation ON %I', t);
    EXECUTE format($f$
      CREATE POLICY branch_isolation ON %I AS RESTRICTIVE
        USING      (branch_id IS NULL OR branch_id = ANY (app_branch_scope()))
        WITH CHECK (branch_id IS NULL OR branch_id = ANY (app_branch_scope()))
    $f$, t);
  END LOOP;
END
$$;

-- ---------------------------------------------------------------------------
-- The two plain FKs on `online_order_lines` (KI-3)
--
-- ⚠️ `product_id` AND `unit_id` POINT AT PLATFORM-EXTENSIBLE TABLES, SO
--   `tenant_isolation` SAYS NOTHING ABOUT THEM. It constrains the LINE's own
--   `organization_id`; the line is the attacker's either way. Without these a
--   clinic attaches another clinic's PRIVATE product to its own order and reads
--   the name back through the join the order screen makes.
--
-- ⚠️ THE FIRST DRAFT OF THIS FILE ARGUED THEY WERE UNNECESSARY, ON TWO CLAIMS
--   THAT WERE BOTH FALSE, AND THE SECURITY REVIEW CAUGHT IT:
--
--     "`dispense_lines` has the identical absence"  — it has the pair, plus a
--       third for `substituted_for_product_id`. PI-8 added them as a CRITICAL
--       fix and called the earlier absence "a hole rather than a choice".
--     "the same call PI-10 made about `recall_batches.batch_id`" — `batches` is
--       ORG-SCOPED and can never hold a platform row, so there is nothing there
--       for such a policy to distinguish. That difference IS KI-3.
--
--   Written out rather than added to the `visible` array in `enable-rls.sql`,
--   because that array has a twin in the `product_platform_core` migration and
--   the two must not drift — the same reason PI-8 wrote `dispense_lines`' three
--   out longhand. Kept word-for-word identical to `enable-rls.sql` so the two
--   files can be diffed by eye.
-- ---------------------------------------------------------------------------
DROP POLICY IF EXISTS product_visible ON online_order_lines;
CREATE POLICY product_visible ON online_order_lines AS RESTRICTIVE
  USING (EXISTS (
    SELECT 1 FROM products p
    WHERE p.id = online_order_lines.product_id
      AND (p.organization_id IS NULL OR p.organization_id = app_current_org())
  ))
  WITH CHECK (EXISTS (
    SELECT 1 FROM products p
    WHERE p.id = online_order_lines.product_id
      AND (p.organization_id IS NULL OR p.organization_id = app_current_org())
  ));

DROP POLICY IF EXISTS unit_visible ON online_order_lines;
CREATE POLICY unit_visible ON online_order_lines AS RESTRICTIVE
  USING (EXISTS (
    SELECT 1 FROM units_of_measure u
    WHERE u.id = online_order_lines.unit_id
      AND (u.organization_id IS NULL OR u.organization_id = app_current_org())
  ))
  WITH CHECK (EXISTS (
    SELECT 1 FROM units_of_measure u
    WHERE u.id = online_order_lines.unit_id
      AND (u.organization_id IS NULL OR u.organization_id = app_current_org())
  ));
