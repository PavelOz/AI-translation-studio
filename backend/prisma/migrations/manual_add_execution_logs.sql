-- Manual migration to add executionLogs field to DocumentAnalysis
-- Run this if the automatic migration fails

-- Add executionLogs column as JSONB (PostgreSQL) or JSON (other databases)
ALTER TABLE "DocumentAnalysis" 
ADD COLUMN IF NOT EXISTS "executionLogs" JSONB;

-- Set default to empty array
UPDATE "DocumentAnalysis" 
SET "executionLogs" = '[]'::jsonb 
WHERE "executionLogs" IS NULL;






