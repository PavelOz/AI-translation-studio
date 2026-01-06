-- Fix RESTRICT constraints on Document to CASCADE

-- Segment.documentId
ALTER TABLE "Segment" 
DROP CONSTRAINT IF EXISTS "Segment_documentId_fkey";

ALTER TABLE "Segment" 
ADD CONSTRAINT "Segment_documentId_fkey" 
FOREIGN KEY ("documentId") 
REFERENCES "Document"("id") 
ON DELETE CASCADE;

-- AIRequest.documentId
ALTER TABLE "AIRequest" 
DROP CONSTRAINT IF EXISTS "AIRequest_documentId_fkey";

ALTER TABLE "AIRequest" 
ADD CONSTRAINT "AIRequest_documentId_fkey" 
FOREIGN KEY ("documentId") 
REFERENCES "Document"("id") 
ON DELETE CASCADE;





