-- AlterTable
ALTER TABLE "Document" ADD COLUMN IF NOT EXISTS "summary" TEXT;
ALTER TABLE "Document" ADD COLUMN IF NOT EXISTS "summaryGeneratedAt" TIMESTAMP(3);
ALTER TABLE "Document" ADD COLUMN IF NOT EXISTS "clusterId" TEXT;
ALTER TABLE "Document" ADD COLUMN IF NOT EXISTS "clusterSummary" TEXT;
ALTER TABLE "Document" ADD COLUMN IF NOT EXISTS "documentEmbedding" vector(1536);
ALTER TABLE "Document" ADD COLUMN IF NOT EXISTS "embeddingModel" TEXT;
ALTER TABLE "Document" ADD COLUMN IF NOT EXISTS "embeddingUpdatedAt" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX IF NOT EXISTS "Document_clusterId_idx" ON "Document"("clusterId");

-- CreateIndex for vector similarity search (using HNSW for performance)
CREATE INDEX IF NOT EXISTS "Document_documentEmbedding_idx" ON "Document" USING hnsw ("documentEmbedding" vector_cosine_ops);







