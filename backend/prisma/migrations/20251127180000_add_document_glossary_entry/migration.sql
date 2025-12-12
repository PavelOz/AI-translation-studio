-- CreateTable
CREATE TABLE "DocumentGlossaryEntry" (
    "id" TEXT NOT NULL,
    "documentId" TEXT NOT NULL,
    "sourceTerm" TEXT NOT NULL,
    "targetTerm" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DocumentGlossaryEntry_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "DocumentGlossaryEntry_documentId_idx" ON "DocumentGlossaryEntry"("documentId");

-- AddForeignKey
ALTER TABLE "DocumentGlossaryEntry" ADD CONSTRAINT "DocumentGlossaryEntry_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "Document"("id") ON DELETE CASCADE ON UPDATE CASCADE;




