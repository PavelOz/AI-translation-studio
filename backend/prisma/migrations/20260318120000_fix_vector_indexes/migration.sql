-- Fix incorrect BTREE indexes on pgvector columns.
-- Prisma migrations previously created BTREE indexes on vector columns:
-- - "GlossaryEntry_sourceEmbedding_idx"
-- - "Document_documentEmbedding_idx"
-- BTREE indexes on large vectors can fail on updates with:
--   "index row size ... exceeds btree version ...".
-- We drop them and recreate HNSW indexes suitable for pgvector similarity search.

CREATE EXTENSION IF NOT EXISTS vector;

-- Glossary embeddings index
ALTER TABLE "GlossaryEntry"
  ALTER COLUMN "sourceEmbedding" TYPE vector(1536)
  USING "sourceEmbedding"::vector(1536);

DROP INDEX IF EXISTS "GlossaryEntry_sourceEmbedding_idx";
CREATE INDEX IF NOT EXISTS "GlossaryEntry_sourceEmbedding_idx"
ON "GlossaryEntry"
USING hnsw ("sourceEmbedding" vector_cosine_ops);

-- Document clustering embeddings index
ALTER TABLE "Document"
  ALTER COLUMN "documentEmbedding" TYPE vector(1536)
  USING "documentEmbedding"::vector(1536);

DROP INDEX IF EXISTS "Document_documentEmbedding_idx";
CREATE INDEX IF NOT EXISTS "Document_documentEmbedding_idx"
ON "Document"
USING hnsw ("documentEmbedding" vector_cosine_ops);

