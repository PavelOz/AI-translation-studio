-- AlterEnum
ALTER TYPE "GlossaryStatus" ADD VALUE 'CANDIDATE';

-- AlterTable
ALTER TABLE "Document" ADD COLUMN     "clusterId" TEXT,
ADD COLUMN     "clusterSummary" TEXT,
ADD COLUMN     "documentEmbedding" vector,
ADD COLUMN     "embeddingModel" TEXT,
ADD COLUMN     "embeddingUpdatedAt" TIMESTAMP(3),
ADD COLUMN     "summary" TEXT,
ADD COLUMN     "summaryGeneratedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "GlossaryEntry" ADD COLUMN     "contextRules" JSONB,
ADD COLUMN     "embeddingModel" TEXT,
ADD COLUMN     "embeddingUpdatedAt" TIMESTAMP(3),
ADD COLUMN     "sourceEmbedding" vector,
ADD COLUMN     "status" "GlossaryStatus" NOT NULL DEFAULT 'PREFERRED';

-- AlterTable
ALTER TABLE "Segment" ADD COLUMN     "segmentType" TEXT DEFAULT 'paragraph';

-- CreateIndex
CREATE INDEX "Document_clusterId_idx" ON "Document"("clusterId");

-- CreateIndex
CREATE INDEX "Document_documentEmbedding_idx" ON "Document"("documentEmbedding");

-- CreateIndex
CREATE INDEX "GlossaryEntry_sourceEmbedding_idx" ON "GlossaryEntry"("sourceEmbedding");
