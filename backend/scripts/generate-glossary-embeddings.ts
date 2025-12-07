/**
 * Script to generate embeddings for ALL glossary entries
 * This will process all entries that don't have embeddings yet
 */

import { generateEmbeddingsForExistingGlossaryEntries, getEmbeddingGenerationProgress } from '../src/services/embedding-generation.service';
import { prisma } from '../src/db/prisma';
import { logger } from '../src/utils/logger';

async function main() {
  console.log('\n╔══════════════════════════════════════════════════════════════╗');
  console.log('║        Glossary Embedding Generation                        ║');
  console.log('╚══════════════════════════════════════════════════════════════╝\n');
  
  try {
    // Show initial status
    const totalEntries = await prisma.$queryRawUnsafe<Array<{ count: number }>>(
      `SELECT COUNT(*)::int as count FROM "GlossaryEntry" WHERE "sourceTerm" != ''`
    );
    const withEmbeddings = await prisma.$queryRawUnsafe<Array<{ count: number }>>(
      `SELECT COUNT(*)::int as count FROM "GlossaryEntry" WHERE "sourceEmbedding" IS NOT NULL AND "sourceTerm" != ''`
    );
    const withoutEmbeddings = await prisma.$queryRawUnsafe<Array<{ count: number }>>(
      `SELECT COUNT(*)::int as count FROM "GlossaryEntry" WHERE "sourceEmbedding" IS NULL AND "sourceTerm" != ''`
    );
    
    console.log('Current status:');
    console.log(`  Total glossary entries: ${totalEntries[0].count}`);
    console.log(`  Already have embeddings: ${withEmbeddings[0].count}`);
    console.log(`  Need embeddings: ${withoutEmbeddings[0].count}\n`);
    
    if (withoutEmbeddings[0].count === 0) {
      console.log('✅ All glossary entries already have embeddings!\n');
      process.exit(0);
    }
    
    console.log('Starting embedding generation...\n');
    
    // Start generation without limit (processes all entries)
    const progressId = await generateEmbeddingsForExistingGlossaryEntries({
      batchSize: 50, // Process 50 entries at a time
      // No limit - process all entries
    });
    
    console.log(`✓ Embedding generation started. Progress ID: ${progressId}`);
    console.log('Monitoring progress...\n');
    
    // Monitor progress
    let lastProcessed = 0;
    const startTime = Date.now();
    
    while (true) {
      await new Promise(resolve => setTimeout(resolve, 2000)); // Check every 2 seconds
      
      const progress = getEmbeddingGenerationProgress(progressId);
      
      if (!progress) {
        console.error('❌ Progress not found. Generation may have failed.');
        break;
      }
      
      // Log progress updates
      if (progress.processed !== lastProcessed) {
        const elapsed = (Date.now() - startTime) / 1000;
        const rate = elapsed > 0 ? progress.processed / elapsed : 0;
        const remaining = progress.total > 0 && rate > 0
          ? Math.max(0, (progress.total - progress.processed) / rate)
          : 0;
        
        const percentage = progress.total > 0 
          ? Math.round((progress.processed / progress.total) * 100)
          : 0;
        
        const hours = Math.floor(remaining / 3600);
        const minutes = Math.floor((remaining % 3600) / 60);
        const seconds = Math.floor(remaining % 60);
        
        console.log(`Progress: ${progress.processed}/${progress.total} (${percentage}%)`);
        console.log(`  ✅ Succeeded: ${progress.succeeded}`);
        console.log(`  ❌ Failed: ${progress.failed}`);
        console.log(`  📈 Rate: ${rate.toFixed(2)} entries/sec`);
        if (remaining > 0) {
          console.log(`  ⏳ ETA: ${hours}h ${minutes}m ${seconds}s`);
        }
        console.log('');
        
        lastProcessed = progress.processed;
      }
      
      // Check if completed
      if (progress.status === 'completed') {
        const duration = progress.completedAt && progress.startedAt
          ? Math.round((progress.completedAt.getTime() - progress.startedAt.getTime()) / 1000)
          : 0;
        
        // Get final status
        const finalWithEmbeddings = await prisma.$queryRawUnsafe<Array<{ count: number }>>(
          `SELECT COUNT(*)::int as count FROM "GlossaryEntry" WHERE "sourceEmbedding" IS NOT NULL AND "sourceTerm" != ''`
        );
        const finalWithoutEmbeddings = await prisma.$queryRawUnsafe<Array<{ count: number }>>(
          `SELECT COUNT(*)::int as count FROM "GlossaryEntry" WHERE "sourceEmbedding" IS NULL AND "sourceTerm" != ''`
        );
        
        console.log('─'.repeat(60));
        console.log('✅ Glossary embedding generation completed!\n');
        console.log('Summary:');
        console.log(`  Entries processed: ${progress.total}`);
        console.log(`  ✅ Succeeded: ${progress.succeeded}`);
        console.log(`  ❌ Failed: ${progress.failed}`);
        console.log(`  📊 Success rate: ${progress.total > 0 ? Math.round((progress.succeeded / progress.total) * 100) : 0}%`);
        console.log(`  ⏱️  Duration: ${duration}s\n`);
        console.log('Current status:');
        const finalTotal = await prisma.$queryRawUnsafe<Array<{ count: number }>>(
          `SELECT COUNT(*)::int as count FROM "GlossaryEntry" WHERE "sourceTerm" != ''`
        );
        console.log(`  Total glossary entries: ${finalTotal[0].count}`);
        console.log(`  With embeddings: ${finalWithEmbeddings[0].count}${finalWithoutEmbeddings[0].count > 0 ? ` (${finalWithoutEmbeddings[0].count} still remaining)` : ''}`);
        console.log('─'.repeat(60));
        console.log('');
        
        if (progress.failed > 0) {
          console.log('💡 Note: Failed entries can be retried by running the script again.');
          console.log('   The script will skip entries that already have embeddings.\n');
        } else if (finalWithoutEmbeddings[0].count === 0) {
          console.log('🎉 All glossary entries now have embeddings!\n');
        }
        break;
      }
      
      if (progress.status === 'cancelled') {
        console.log('⚠️  Glossary embedding generation was cancelled\n');
        break;
      }
      
      if (progress.status === 'error') {
        console.error('❌ Glossary embedding generation failed');
        console.error(`Error: ${progress.error}\n`);
        break;
      }
    }
    
    await prisma.$disconnect();
    process.exit(0);
  } catch (error: any) {
    console.error('\n❌ Failed to generate glossary embeddings');
    console.error(`Error: ${error.message}\n`);
    if (error.message?.includes('sourceEmbedding') || error.message?.includes('42703')) {
      console.error('💡 The glossary embedding columns may not exist yet.');
      console.error('   Run: npx ts-node scripts/apply-glossary-embeddings-migration.ts\n');
    }
    await prisma.$disconnect().catch(() => {});
    process.exit(1);
  }
}

main();

