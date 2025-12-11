-- Add CANDIDATE value to GlossaryStatus enum
-- Note: This must be done in a separate transaction in PostgreSQL
-- The DO block checks if it exists first to avoid errors on re-runs
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_enum 
    WHERE enumlabel = 'CANDIDATE' 
    AND enumtypid = (SELECT oid FROM pg_type WHERE typname = 'GlossaryStatus')
  ) THEN
    EXECUTE 'ALTER TYPE "GlossaryStatus" ADD VALUE ''CANDIDATE''';
  END IF;
END $$;

-- Add status column (will use PREFERRED as temporary type-safe default)
-- Then we'll update to CANDIDATE after the enum is available
ALTER TABLE "GlossaryEntry" ADD COLUMN IF NOT EXISTS "status" "GlossaryStatus";

-- Set existing rows to PREFERRED (safe default that exists)
UPDATE "GlossaryEntry" SET "status" = 'PREFERRED' WHERE "status" IS NULL;

-- Now update to CANDIDATE (enum value should be available now)
UPDATE "GlossaryEntry" SET "status" = 'CANDIDATE';

-- Set default and make NOT NULL
ALTER TABLE "GlossaryEntry" ALTER COLUMN "status" SET DEFAULT 'CANDIDATE';
ALTER TABLE "GlossaryEntry" ALTER COLUMN "status" SET NOT NULL;

