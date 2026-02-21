-- Part 3/3: Switch to CANDIDATE (enum value is committed after 20251210120000).
UPDATE "GlossaryEntry" SET "status" = 'CANDIDATE' WHERE "status" = 'PREFERRED';
ALTER TABLE "GlossaryEntry" ALTER COLUMN "status" SET DEFAULT 'CANDIDATE';
