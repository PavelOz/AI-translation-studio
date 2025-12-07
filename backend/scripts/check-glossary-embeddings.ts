/**
 * Script to check glossary embedding completion status
 * Shows how many entries have embeddings vs how many don't
 */

import { prisma } from '../src/db/prisma';
import { logger } from '../src/utils/logger';

async function main() {
  try {
    console.log('\n╔══════════════════════════════════════════════════════════════╗');
    console.log('║        Glossary Embedding Status Check                      ║');
    console.log('╚══════════════════════════════════════════════════════════════╝\n');

    // Count entries with embeddings
    const withEmbeddingResult = await prisma.$queryRawUnsafe<Array<{ count: number }>>(
      `SELECT COUNT(*)::int as count FROM "GlossaryEntry" WHERE "sourceEmbedding" IS NOT NULL AND "sourceTerm" != ''`,
    );
    const withEmbedding = withEmbeddingResult[0].count;

    // Count entries without embeddings
    const withoutEmbeddingResult = await prisma.$queryRawUnsafe<Array<{ count: number }>>(
      `SELECT COUNT(*)::int as count FROM "GlossaryEntry" WHERE "sourceEmbedding" IS NULL AND "sourceTerm" != ''`,
    );
    const withoutEmbedding = withoutEmbeddingResult[0].count;

    // Total entries
    const total = withEmbedding + withoutEmbedding;
    const coverage = total > 0 ? (withEmbedding / total) * 100 : 0;

    console.log('Status:');
    console.log(`  Total entries: ${total.toLocaleString()}`);
    console.log(`  With embeddings: ${withEmbedding.toLocaleString()}`);
    console.log(`  Without embeddings: ${withoutEmbedding.toLocaleString()}`);
    console.log(`  Coverage: ${coverage.toFixed(2)}%\n`);

    if (withoutEmbedding > 0) {
      console.log(`💡 To generate embeddings, run:`);
      console.log(`   npx ts-node scripts/generate-glossary-embeddings.ts\n`);
    } else if (total > 0) {
      console.log('✅ All glossary entries have embeddings!\n');
    } else {
      console.log('ℹ️  No glossary entries found.\n');
    }

    console.log('─'.repeat(60));
    console.log('');

    process.exit(0);
  } catch (error: any) {
    console.error('❌ Error:', error.message);
    if (error.message?.includes('sourceEmbedding') || error.message?.includes('42703')) {
      console.error('\n💡 The glossary embedding columns may not exist yet.');
      console.error('   Run: npx ts-node scripts/apply-glossary-embeddings-migration.ts\n');
    }
    process.exit(1);
  }
}

main();

