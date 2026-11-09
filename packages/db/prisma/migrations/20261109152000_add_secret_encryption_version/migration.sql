-- AlterTable
ALTER TABLE "Project" ADD COLUMN "secretVersion" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "StorageSource" ADD COLUMN "secretVersion" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "Destination" ADD COLUMN "secretVersion" INTEGER NOT NULL DEFAULT 0;
