-- AlterTable
ALTER TABLE "Project" ADD COLUMN IF NOT EXISTS "type" TEXT NOT NULL DEFAULT 'DATABASE';
ALTER TABLE "Project" ALTER COLUMN "dbUrl" DROP NOT NULL;

-- CreateTable
CREATE TABLE IF NOT EXISTS "StorageSource" (
    "id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "credentials" TEXT NOT NULL,
    "targetFolder" TEXT NOT NULL,
    "prefix" TEXT,
    "projectId" TEXT NOT NULL,

    CONSTRAINT "StorageSource_pkey" PRIMARY KEY ("id")
);

-- AlterTable
ALTER TABLE "BackupLog" ALTER COLUMN "fileSize" TYPE BIGINT;
ALTER TABLE "BackupLog" ADD COLUMN IF NOT EXISTS "fileCount" INTEGER;

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "StorageSource_projectId_key" ON "StorageSource"("projectId");

-- AddForeignKey
DO $$ BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'StorageSource_projectId_fkey'
    ) THEN
        ALTER TABLE "StorageSource" ADD CONSTRAINT "StorageSource_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;
    END IF;
END $$;
