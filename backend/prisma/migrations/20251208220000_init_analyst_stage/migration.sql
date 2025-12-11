-- CreateTable
CREATE TABLE IF NOT EXISTS "DocumentAnalysis" (
    "id" TEXT NOT NULL,
    "documentId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "glossaryExtracted" BOOLEAN NOT NULL DEFAULT false,
    "styleRulesExtracted" BOOLEAN NOT NULL DEFAULT false,
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DocumentAnalysis_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "DocumentStyleRule" (
    "id" TEXT NOT NULL,
    "documentId" TEXT NOT NULL,
    "ruleType" TEXT NOT NULL,
    "pattern" TEXT NOT NULL,
    "description" TEXT,
    "examples" JSONB,
    "priority" INTEGER NOT NULL DEFAULT 50,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DocumentStyleRule_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX IF NOT EXISTS "DocumentStyleRule_documentId_idx" ON "DocumentStyleRule"("documentId");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "DocumentAnalysis_documentId_key" ON "DocumentAnalysis"("documentId");

-- AddForeignKey
ALTER TABLE "DocumentAnalysis" ADD CONSTRAINT "DocumentAnalysis_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "Document"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DocumentStyleRule" ADD CONSTRAINT "DocumentStyleRule_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "Document"("id") ON DELETE CASCADE ON UPDATE CASCADE;



