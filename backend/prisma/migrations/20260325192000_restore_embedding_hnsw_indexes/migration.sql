-- Prisma included spurious DROP INDEX in the billing migration because vector columns are Unsupported in schema.
-- Recreate HNSW indexes for similarity search (see 20260318120000_fix_vector_indexes).
CREATE EXTENSION IF NOT EXISTS vector;

CREATE INDEX IF NOT EXISTS "GlossaryEntry_sourceEmbedding_idx"
ON "GlossaryEntry"
USING hnsw ("sourceEmbedding" vector_cosine_ops);

CREATE INDEX IF NOT EXISTS "Document_documentEmbedding_idx"
ON "Document"
USING hnsw ("documentEmbedding" vector_cosine_ops);
