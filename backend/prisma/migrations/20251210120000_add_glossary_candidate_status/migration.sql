-- Part 1/2: Add CANDIDATE value to GlossaryStatus enum only.
-- PostgreSQL requires the new enum value to be committed before use,
-- so adding the column that uses it must be in the next migration.
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

