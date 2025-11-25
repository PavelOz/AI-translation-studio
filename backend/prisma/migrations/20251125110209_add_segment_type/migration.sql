-- AlterTable
ALTER TABLE "Segment" ADD COLUMN     "segmentType" TEXT DEFAULT 'paragraph';

-- Update existing segments to have default segmentType
UPDATE "Segment" SET "segmentType" = 'paragraph' WHERE "segmentType" IS NULL;
