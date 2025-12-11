-- AlterTable
ALTER TABLE "DocumentAnalysis" ADD COLUMN IF NOT EXISTS "currentStage" TEXT;
ALTER TABLE "DocumentAnalysis" ADD COLUMN IF NOT EXISTS "progressPercentage" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "DocumentAnalysis" ADD COLUMN IF NOT EXISTS "currentMessage" TEXT;


