-- CreateEnum
CREATE TYPE "DemoRequestStatus" AS ENUM ('NEW', 'CONTACTED', 'CONVERTED', 'SPAM');

-- CreateTable
CREATE TABLE "demo_requests" (
    "id" UUID NOT NULL,
    "clinic_name" VARCHAR(255) NOT NULL,
    "contact_name" VARCHAR(255) NOT NULL,
    "email" VARCHAR(255) NOT NULL,
    "phone" VARCHAR(20) NOT NULL,
    "city" VARCHAR(100),
    "branch_count" INTEGER,
    "specialty" VARCHAR(120),
    "message" TEXT,
    "source" VARCHAR(255),
    "status" "DemoRequestStatus" NOT NULL DEFAULT 'NEW',
    "handled_at" TIMESTAMPTZ(6),
    "notes" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "demo_requests_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "demo_requests_status_created_at_idx" ON "demo_requests"("status", "created_at");

-- CreateIndex
CREATE INDEX "demo_requests_email_idx" ON "demo_requests"("email");
