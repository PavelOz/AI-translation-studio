-- CreateTable
CREATE TABLE "DocumentDna" (
    "id" TEXT NOT NULL,
    "documentId" TEXT NOT NULL,
    "technicalSchema" JSONB,
    "namingConventions" JSONB,
    "abbreviationLogic" JSONB,
    "entityGroups" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DocumentDna_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "DocumentDna_documentId_key" ON "DocumentDna"("documentId");

-- CreateIndex
CREATE INDEX "DocumentDna_documentId_idx" ON "DocumentDna"("documentId");

-- AddForeignKey
ALTER TABLE "DocumentDna" ADD CONSTRAINT "DocumentDna_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "Document"("id") ON DELETE CASCADE ON UPDATE CASCADE;
