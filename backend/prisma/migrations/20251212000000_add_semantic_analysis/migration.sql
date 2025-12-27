-- AlterTable
ALTER TABLE "DocumentAnalysis" ADD COLUMN IF NOT EXISTS "detectedDomain" TEXT;
ALTER TABLE "DocumentAnalysis" ADD COLUMN IF NOT EXISTS "detectedTone" TEXT;
ALTER TABLE "DocumentAnalysis" ADD COLUMN IF NOT EXISTS "translationStrategy" TEXT;





