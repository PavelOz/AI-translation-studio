import { PrismaClient } from '@prisma/client';
import {
  generateEmbeddingsForExistingEntries,
  getEmbeddingGenerationProgress,
  cancelEmbeddingGeneration,
} from '../src/services/embedding-generation.service';
import { getEmbeddingStats } from '../src/services/vector-search.service';

const prisma = new PrismaClient();

async function testEmbeddingGeneration() {
  console.log('🧪 Testing Embedding Generation...\n');

  try {
    // Check current stats
    console.log('1. Checking current embedding stats...');
    const statsBefore = await getEmbeddingStats();
    console.log(`   Total entries: ${statsBefore.total}`);
    console.log(`   With embeddings: ${statsBefore.withEmbedding}`);
    console.log(`   Coverage: ${statsBefore.coverage}%\n`);

    if (statsBefore.total === 0) {
      console.log('⚠️  No TM entries found. Please import some TMX files first.\n');
      return;
    }

    // Start generation with small limit for testing
    console.log('2. Starting embedding generation (test mode: 10 entries)...');
    const progressId = await generateEmbeddingsForExistingEntries({
      limit: 10, // Test with just 10 entries
      batchSize: 5,
      onProgress: (progress) => {
        const percentage = progress.total > 0 
          ? Math.round((progress.processed / progress.total) * 100) 
          : 0;
        console.log(`   Progress: ${progress.processed}/${progress.total} (${percentage}%) - ${progress.succeeded} succeeded, ${progress.failed} failed`);
        if (progress.currentEntry) {
          console.log(`   Current: ${progress.currentEntry.sourceText.substring(0, 50)}...`);
        }
      },
    });

    console.log(`   Progress ID: ${progressId}\n`);

    // Poll progress
    console.log('3. Polling progress...');
    let lastStatus = 'running';
    const pollInterval = setInterval(async () => {
      const progress = getEmbeddingGenerationProgress(progressId);
      
      if (!progress) {
        console.log('   ⚠️  Progress not found');
        clearInterval(pollInterval);
        return;
      }

      if (progress.status !== lastStatus) {
        console.log(`   Status changed: ${lastStatus} -> ${progress.status}`);
        lastStatus = progress.status;
      }

      if (progress.status === 'completed' || progress.status === 'cancelled' || progress.status === 'error') {
        clearInterval(pollInterval);
        console.log(`\n   ✅ Generation ${progress.status}`);
        console.log(`   Processed: ${progress.processed}`);
        console.log(`   Succeeded: ${progress.succeeded}`);
        console.log(`   Failed: ${progress.failed}`);
        
        if (progress.error) {
          console.log(`   Error: ${progress.error}`);
        }

        // Check stats after
        console.log('\n4. Checking stats after generation...');
        const statsAfter = await getEmbeddingStats();
        console.log(`   Total entries: ${statsAfter.total}`);
        console.log(`   With embeddings: ${statsAfter.withEmbedding} (+${statsAfter.withEmbedding - statsBefore.withEmbedding})`);
        console.log(`   Coverage: ${statsAfter.coverage}%\n`);

        console.log('✅ Test complete!\n');
      }
    }, 1000); // Poll every second

    // Timeout after 2 minutes
    setTimeout(() => {
      if (lastStatus === 'running') {
        clearInterval(pollInterval);
        console.log('\n⏱️  Test timeout (2 minutes). Cancelling...');
        cancelEmbeddingGeneration(progressId);
        console.log('✅ Cancellation requested\n');
      }
    }, 120000);

  } catch (error: any) {
    console.error('\n❌ Test failed:', error.message);
    throw error;
  } finally {
    await prisma.$disconnect();
  }
}

testEmbeddingGeneration().catch((e) => {
  console.error('Fatal error:', e);
  process.exit(1);
});



