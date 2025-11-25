import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function applyMigration() {
  console.log('🔧 Manually applying vector migration...\n');

  try {
    // Step 1: Ensure pgvector extension
    console.log('1. Ensuring pgvector extension...');
    await prisma.$executeRawUnsafe('CREATE EXTENSION IF NOT EXISTS vector;');
    console.log('   ✅ Extension ready\n');

    // Step 2: Add columns to Segment
    console.log('2. Adding columns to Segment...');
    try {
      await prisma.$executeRawUnsafe(`
        ALTER TABLE "Segment" 
        ADD COLUMN IF NOT EXISTS "embeddingModel" TEXT,
        ADD COLUMN IF NOT EXISTS "embeddingUpdatedAt" TIMESTAMP(3),
        ADD COLUMN IF NOT EXISTS "sourceEmbedding" vector(1536)
      `);
      console.log('   ✅ Segment columns added\n');
    } catch (e: any) {
      if (e.message?.includes('already exists') || e.message?.includes('duplicate')) {
        console.log('   ⚠️  Segment columns already exist\n');
      } else {
        throw e;
      }
    }

    // Step 3: Add columns to TranslationMemoryEntry
    console.log('3. Adding columns to TranslationMemoryEntry...');
    try {
      await prisma.$executeRawUnsafe(`
        ALTER TABLE "TranslationMemoryEntry" 
        ADD COLUMN IF NOT EXISTS "embeddingModel" TEXT,
        ADD COLUMN IF NOT EXISTS "embeddingUpdatedAt" TIMESTAMP(3),
        ADD COLUMN IF NOT EXISTS "embeddingVersion" TEXT,
        ADD COLUMN IF NOT EXISTS "sourceEmbedding" vector(1536)
      `);
      console.log('   ✅ TranslationMemoryEntry columns added\n');
    } catch (e: any) {
      if (e.message?.includes('already exists') || e.message?.includes('duplicate')) {
        console.log('   ⚠️  TranslationMemoryEntry columns already exist\n');
      } else {
        throw e;
      }
    }

    // Step 4: Create indexes (wait a moment for columns to be committed)
    console.log('4. Creating vector indexes...');
    await new Promise(resolve => setTimeout(resolve, 500)); // Small delay for transaction commit
    
    try {
      await prisma.$executeRawUnsafe(`
        CREATE INDEX IF NOT EXISTS "tm_source_embedding_idx" 
        ON "TranslationMemoryEntry" 
        USING hnsw ("sourceEmbedding" vector_cosine_ops)
        WITH (m = 16, ef_construction = 64)
        WHERE "sourceEmbedding" IS NOT NULL
      `);
      console.log('   ✅ TM embedding index created\n');
    } catch (e: any) {
      if (e.message?.includes('already exists')) {
        console.log('   ⚠️  TM index already exists\n');
      } else {
        console.log(`   ⚠️  Index creation error: ${e.message}\n`);
      }
    }

    try {
      await prisma.$executeRawUnsafe(`
        CREATE INDEX IF NOT EXISTS "segment_source_embedding_idx" 
        ON "Segment" 
        USING hnsw ("sourceEmbedding" vector_cosine_ops)
        WITH (m = 16, ef_construction = 64)
        WHERE "sourceEmbedding" IS NOT NULL
      `);
      console.log('   ✅ Segment embedding index created\n');
    } catch (e: any) {
      if (e.message?.includes('already exists')) {
        console.log('   ⚠️  Segment index already exists\n');
      } else {
        console.log(`   ⚠️  Index creation error: ${e.message}\n`);
      }
    }

    console.log('✅ Migration complete!\n');

  } catch (error: any) {
    console.error('\n❌ Migration failed:', error.message);
    throw error;
  } finally {
    await prisma.$disconnect();
  }
}

applyMigration().catch((e) => {
  console.error('Fatal error:', e);
  process.exit(1);
});

