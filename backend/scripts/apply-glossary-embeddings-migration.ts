/**
 * Script to manually apply glossary embeddings migration
 * This ensures the sourceEmbedding column exists in GlossaryEntry table
 */

import { prisma } from '../src/db/prisma';
import { logger } from '../src/utils/logger';

async function main() {
  try {
    console.log('\n╔══════════════════════════════════════════════════════════════╗');
    console.log('║        Applying Glossary Embeddings Migration               ║');
    console.log('╚══════════════════════════════════════════════════════════════╝\n');

    console.log('Step 1: Enabling pgvector extension...');
    await prisma.$executeRawUnsafe(`CREATE EXTENSION IF NOT EXISTS vector;`);
    console.log('✓ pgvector extension enabled\n');

    console.log('Step 2: Adding embedding columns to GlossaryEntry...');
    await prisma.$executeRawUnsafe(`
      ALTER TABLE "GlossaryEntry" 
      ADD COLUMN IF NOT EXISTS "sourceEmbedding" vector(1536),
      ADD COLUMN IF NOT EXISTS "embeddingModel" TEXT,
      ADD COLUMN IF NOT EXISTS "embeddingUpdatedAt" TIMESTAMP(3);
    `);
    console.log('✓ Added embedding columns\n');

    console.log('Step 3: Creating HNSW index for vector search...');
    await prisma.$executeRawUnsafe(`
      CREATE INDEX IF NOT EXISTS "GlossaryEntry_sourceEmbedding_idx" 
      ON "GlossaryEntry" 
      USING hnsw ("sourceEmbedding" vector_cosine_ops);
    `);
    console.log('✓ Created HNSW index\n');

    console.log('✅ Glossary embeddings migration applied successfully!\n');
    console.log('─'.repeat(60));
    console.log('');
    
    process.exit(0);
  } catch (error: any) {
    console.error('\n❌ Error:', error.message);
    console.error('\nStack:', error.stack);
    process.exit(1);
  }
}

main();

