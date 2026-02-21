-- Part 2/3: Add status column using only PREFERRED (no CANDIDATE in this transaction).
ALTER TABLE "GlossaryEntry" ADD COLUMN IF NOT EXISTS "status" "GlossaryStatus" DEFAULT 'PREFERRED';
UPDATE "GlossaryEntry" SET "status" = 'PREFERRED' WHERE "status" IS NULL;
ALTER TABLE "GlossaryEntry" ALTER COLUMN "status" SET NOT NULL;
