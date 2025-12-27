-- Add status field to DocumentGlossaryEntry to track review decisions

ALTER TABLE "DocumentGlossaryEntry" 
ADD COLUMN IF NOT EXISTS "status" TEXT;

-- Create index on status for faster filtering
CREATE INDEX IF NOT EXISTS "DocumentGlossaryEntry_status_idx" ON "DocumentGlossaryEntry"("status");



