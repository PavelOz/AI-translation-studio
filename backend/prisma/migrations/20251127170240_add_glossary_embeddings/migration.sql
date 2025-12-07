-- AlterTable
ALTER TABLE "GlossaryEntry" ADD COLUMN IF NOT EXISTS "sourceEmbedding" vector(1536),
ADD COLUMN IF NOT EXISTS "embeddingModel" TEXT,
ADD COLUMN IF NOT EXISTS "embeddingUpdatedAt" TIMESTAMP(3);

-- CreateIndex for vector similarity search (using HNSW for performance)
CREATE INDEX IF NOT EXISTS "GlossaryEntry_sourceEmbedding_idx" ON "GlossaryEntry" USING hnsw ("sourceEmbedding" vector_cosine_ops);
