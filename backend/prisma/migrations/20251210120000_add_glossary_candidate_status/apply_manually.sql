-- Manual migration script for adding CANDIDATE status to GlossaryEntry
-- Run this in your PostgreSQL client (psql, pgAdmin, etc.)

-- Step 1: Add CANDIDATE to enum (run this first, then commit)
ALTER TYPE "GlossaryStatus" ADD VALUE IF NOT EXISTS 'CANDIDATE';

-- Step 2: After committing step 1, run this to add the column
ALTER TABLE "GlossaryEntry" ADD COLUMN IF NOT EXISTS "status" "GlossaryStatus" DEFAULT 'PREFERRED';

-- Step 3: Update existing rows to CANDIDATE
UPDATE "GlossaryEntry" SET "status" = 'CANDIDATE' WHERE "status" IS NULL OR "status" = 'PREFERRED';

-- Step 4: Set default and make NOT NULL
ALTER TABLE "GlossaryEntry" ALTER COLUMN "status" SET DEFAULT 'CANDIDATE';
ALTER TABLE "GlossaryEntry" ALTER COLUMN "status" SET NOT NULL;


