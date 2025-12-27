-- Add cascade delete to all Project foreign key relations

-- Document.projectId
ALTER TABLE "Document" 
DROP CONSTRAINT IF EXISTS "Document_projectId_fkey";

ALTER TABLE "Document" 
ADD CONSTRAINT "Document_projectId_fkey" 
FOREIGN KEY ("projectId") 
REFERENCES "Project"("id") 
ON DELETE CASCADE;

-- ProjectMember.projectId
ALTER TABLE "ProjectMember" 
DROP CONSTRAINT IF EXISTS "ProjectMember_projectId_fkey";

ALTER TABLE "ProjectMember" 
ADD CONSTRAINT "ProjectMember_projectId_fkey" 
FOREIGN KEY ("projectId") 
REFERENCES "Project"("id") 
ON DELETE CASCADE;

-- TranslationMemoryEntry.projectId
ALTER TABLE "TranslationMemoryEntry" 
DROP CONSTRAINT IF EXISTS "TranslationMemoryEntry_projectId_fkey";

ALTER TABLE "TranslationMemoryEntry" 
ADD CONSTRAINT "TranslationMemoryEntry_projectId_fkey" 
FOREIGN KEY ("projectId") 
REFERENCES "Project"("id") 
ON DELETE CASCADE;

-- TranslationMemoryFile.projectId
ALTER TABLE "TranslationMemoryFile" 
DROP CONSTRAINT IF EXISTS "TranslationMemoryFile_projectId_fkey";

ALTER TABLE "TranslationMemoryFile" 
ADD CONSTRAINT "TranslationMemoryFile_projectId_fkey" 
FOREIGN KEY ("projectId") 
REFERENCES "Project"("id") 
ON DELETE CASCADE;

-- GlossaryEntry.projectId
ALTER TABLE "GlossaryEntry" 
DROP CONSTRAINT IF EXISTS "GlossaryEntry_projectId_fkey";

ALTER TABLE "GlossaryEntry" 
ADD CONSTRAINT "GlossaryEntry_projectId_fkey" 
FOREIGN KEY ("projectId") 
REFERENCES "Project"("id") 
ON DELETE CASCADE;

-- Report.projectId
ALTER TABLE "Report" 
DROP CONSTRAINT IF EXISTS "Report_projectId_fkey";

ALTER TABLE "Report" 
ADD CONSTRAINT "Report_projectId_fkey" 
FOREIGN KEY ("projectId") 
REFERENCES "Project"("id") 
ON DELETE CASCADE;




