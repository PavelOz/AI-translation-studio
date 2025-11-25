-- Ensure pgvector extension is enabled
CREATE EXTENSION IF NOT EXISTS vector;

-- AlterTable: Add embedding fields to Segment
ALTER TABLE "Segment" ADD COLUMN     "embeddingModel" TEXT,
ADD COLUMN     "embeddingUpdatedAt" TIMESTAMP(3),
ADD COLUMN     "sourceEmbedding" vector(1536);

-- AlterTable: Add embedding fields to TranslationMemoryEntry
ALTER TABLE "TranslationMemoryEntry" ADD COLUMN     "embeddingModel" TEXT,
ADD COLUMN     "embeddingUpdatedAt" TIMESTAMP(3),
ADD COLUMN     "embeddingVersion" TEXT,
ADD COLUMN     "sourceEmbedding" vector(1536);

-- Create HNSW index for vector similarity search on TranslationMemoryEntry
-- HNSW (Hierarchical Navigable Small World) is optimized for fast approximate nearest neighbor search
-- Using cosine distance operator (<=>) for semantic similarity
CREATE INDEX IF NOT EXISTS "tm_source_embedding_idx" 
ON "TranslationMemoryEntry" 
USING hnsw ("sourceEmbedding" vector_cosine_ops)
WITH (m = 16, ef_construction = 64)
WHERE "sourceEmbedding" IS NOT NULL;

CREATE INDEX IF NOT EXISTS "segment_source_embedding_idx" 
ON "Segment" 
USING hnsw ("sourceEmbedding" vector_cosine_ops)
WITH (m = 16, ef_construction = 64)
WHERE "sourceEmbedding" IS NOT NULL;

