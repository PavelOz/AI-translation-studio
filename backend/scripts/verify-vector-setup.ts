import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function verifySetup() {
  console.log('🔍 Verifying Vector Setup...\n');

  try {
    // Check pgvector extension
    const extensionCheck = await prisma.$queryRawUnsafe<Array<{ extname: string }>>(`
      SELECT extname 
      FROM pg_extension 
      WHERE extname = 'vector'
    `);

    if (extensionCheck.length > 0) {
      console.log('✅ pgvector extension: INSTALLED');
    } else {
      console.log('❌ pgvector extension: NOT INSTALLED');
    }

    // Check columns
    const columns = await prisma.$queryRawUnsafe<Array<{ column_name: string; data_type: string }>>(`
      SELECT column_name, data_type
      FROM information_schema.columns 
      WHERE table_name = 'TranslationMemoryEntry' 
        AND column_name IN ('sourceEmbedding', 'embeddingModel', 'embeddingVersion', 'embeddingUpdatedAt')
      ORDER BY column_name
    `);

    console.log(`\n📊 TranslationMemoryEntry columns: ${columns.length}/4`);
    columns.forEach(col => {
      console.log(`  ✅ ${col.column_name} (${col.data_type})`);
    });

    // Check indexes
    const indexes = await prisma.$queryRawUnsafe<Array<{ indexname: string; indexdef: string }>>(`
      SELECT indexname, indexdef
      FROM pg_indexes 
      WHERE tablename = 'TranslationMemoryEntry' 
        AND indexname LIKE '%embedding%'
    `);

    console.log(`\n📊 Vector indexes: ${indexes.length}`);
    indexes.forEach(idx => {
      console.log(`  ✅ ${idx.indexname}`);
      console.log(`     ${idx.indexdef.substring(0, 80)}...`);
    });

    // Check embedding coverage
    const stats = await prisma.$queryRawUnsafe<Array<{
      total: bigint;
      with_embedding: bigint;
      coverage: number;
    }>>(`
      SELECT 
        COUNT(*) as total,
        COUNT("sourceEmbedding") as with_embedding,
        ROUND(COUNT("sourceEmbedding")::numeric / NULLIF(COUNT(*), 0) * 100, 2) as coverage
      FROM "TranslationMemoryEntry"
    `);

    if (stats.length > 0) {
      const s = stats[0];
      console.log(`\n📊 Embedding Coverage:`);
      console.log(`  Total entries: ${s.total}`);
      console.log(`  With embeddings: ${s.with_embedding}`);
      console.log(`  Coverage: ${s.coverage}%`);
    }

    console.log('\n✅ Verification complete!\n');

  } catch (error: any) {
    console.error('\n❌ Verification failed:', error.message);
    throw error;
  } finally {
    await prisma.$disconnect();
  }
}

verifySetup().catch((e) => {
  console.error('Fatal error:', e);
  process.exit(1);
});



