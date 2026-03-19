-- Add glossary compliance review flag to segments
ALTER TABLE "Segment"
ADD COLUMN IF NOT EXISTS "glossaryFlagged" BOOLEAN NOT NULL DEFAULT false;

