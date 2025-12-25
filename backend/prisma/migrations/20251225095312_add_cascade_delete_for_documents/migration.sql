-- AlterTable: Add CASCADE delete to Document.project relation
-- This ensures that when a Project is deleted, all associated Documents are automatically deleted

-- Drop the existing foreign key constraint
ALTER TABLE "Document" DROP CONSTRAINT IF EXISTS "Document_projectId_fkey";

-- Recreate the foreign key constraint with CASCADE delete
ALTER TABLE "Document" 
  ADD CONSTRAINT "Document_projectId_fkey" 
  FOREIGN KEY ("projectId") 
  REFERENCES "Project"("id") 
  ON DELETE CASCADE 
  ON UPDATE CASCADE;

