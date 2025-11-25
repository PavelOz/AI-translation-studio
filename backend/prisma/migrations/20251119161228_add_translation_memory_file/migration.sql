-- AlterTable
ALTER TABLE "TranslationMemoryEntry" ADD COLUMN     "clientName" TEXT,
ADD COLUMN     "domain" TEXT,
ADD COLUMN     "tmxFileId" TEXT;

-- CreateTable
CREATE TABLE "TranslationMemoryFile" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "filename" TEXT NOT NULL,
    "storagePath" TEXT,
    "externalUrl" TEXT,
    "projectId" TEXT,
    "clientName" TEXT,
    "domain" TEXT,
    "entryCount" INTEGER NOT NULL DEFAULT 0,
    "createdById" TEXT NOT NULL,
    "lastImportedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TranslationMemoryFile_pkey" PRIMARY KEY ("id")
);

-- AddForeignKey
ALTER TABLE "TranslationMemoryFile" ADD CONSTRAINT "TranslationMemoryFile_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TranslationMemoryFile" ADD CONSTRAINT "TranslationMemoryFile_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TranslationMemoryEntry" ADD CONSTRAINT "TranslationMemoryEntry_tmxFileId_fkey" FOREIGN KEY ("tmxFileId") REFERENCES "TranslationMemoryFile"("id") ON DELETE SET NULL ON UPDATE CASCADE;
