-- AlterTable
ALTER TABLE "memberships" ADD COLUMN     "last_branch_id" UUID;

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "last_platform_organization_id" UUID;

-- AddForeignKey
ALTER TABLE "users" ADD CONSTRAINT "users_last_platform_organization_id_fkey" FOREIGN KEY ("last_platform_organization_id") REFERENCES "organizations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_organization_id_last_branch_id_fkey" FOREIGN KEY ("organization_id", "last_branch_id") REFERENCES "branches"("organization_id", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;
