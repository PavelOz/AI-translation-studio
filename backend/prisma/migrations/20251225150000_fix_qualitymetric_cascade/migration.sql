-- Fix QualityMetric RESTRICT constraint to CASCADE

ALTER TABLE "QualityMetric" 
DROP CONSTRAINT IF EXISTS "QualityMetric_segmentId_fkey";

ALTER TABLE "QualityMetric" 
ADD CONSTRAINT "QualityMetric_segmentId_fkey" 
FOREIGN KEY ("segmentId") 
REFERENCES "Segment"("id") 
ON DELETE CASCADE;



