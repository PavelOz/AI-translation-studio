-- AlterTable
ALTER TABLE "DocumentGlossaryEntry" ADD COLUMN IF NOT EXISTS "occurrenceCount" INTEGER NOT NULL DEFAULT 1;



