import { PrismaClient } from '@prisma/client';
import {
  generateEmbeddingsForExistingEntries,
  getEmbeddingGenerationProgress,
} from '../src/services/embedding-generation.service';
import { getEmbeddingStats } from '../src/services/vector-search.service';

const prisma = new PrismaClient();

async function testLargeBatch() {
  console.log('🧪 Testing Large Batch Embedding Generation (1000 entries)...\n');

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

    // Start generation with larger batch
    console.log('2. Starting embedding generation (1000 entries, batch size 50)...');
    const progressId = await generateEmbeddingsForExistingEntries({
      limit: 1000, // Test with 1000 entries
      batchSize: 50, // Process 50 at a time
      onProgress: (progress) => {
        const percentage = progress.total > 0 
          ? Math.round((progress.processed / progress.total) * 100) 
          : 0;
        const elapsed = progress.startedAt 
          ? Math.round((Date.now() - progress.startedAt.getTime()) / 1000)
          : 0;
        const rate = elapsed > 0 && progress.processed > 0
          ? Math.round(progress.processed / elapsed)
          : 0;
        const remaining = rate > 0 && progress.total > progress.processed
          ? Math.round((progress.total - progress.processed) / rate)
          : 0;

        console.log(`   Progress: ${progress.processed}/${progress.total} (${percentage}%) - ${progress.succeeded} succeeded, ${progress.failed} failed`);
        console.log(`   Rate: ~${rate} entries/sec | Elapsed: ${elapsed}s | ETA: ${remaining}s`);
        if (progress.currentEntry) {
          console.log(`   Current: ${progress.currentEntry.sourceText.substring(0, 60)}...`);
        }
        console.log('');
      },
    });

    console.log(`   Progress ID: ${progressId}\n`);

    // Poll progress
    console.log('3. Monitoring progress (updates every 2 seconds)...\n');
    let lastStatus = 'running';
    let lastProcessed = 0;
    const pollInterval = setInterval(async () => {
      const progress = getEmbeddingGenerationProgress(progressId);
      
      if (!progress) {
        console.log('   ⚠️  Progress not found');
        clearInterval(pollInterval);
        return;
      }

      // Only log if status changed or significant progress made
      if (progress.status !== lastStatus || progress.processed - lastProcessed >= 50) {
        if (progress.status !== lastStatus) {
          console.log(`\n   📊 Status changed: ${lastStatus} -> ${progress.status}\n`);
          lastStatus = progress.status;
        }
        lastProcessed = progress.processed;
      }

      if (progress.status === 'completed' || progress.status === 'cancelled' || progress.status === 'error') {
        clearInterval(pollInterval);
        
        const elapsed = progress.startedAt && progress.completedAt
          ? Math.round((progress.completedAt.getTime() - progress.startedAt.getTime()) / 1000)
          : 0;
        const rate = elapsed > 0 && progress.processed > 0
          ? Math.round(progress.processed / elapsed)
          : 0;

        console.log(`\n   ✅ Generation ${progress.status}`);
        console.log(`   Processed: ${progress.processed}`);
        console.log(`   Succeeded: ${progress.succeeded}`);
        console.log(`   Failed: ${progress.failed}`);
        console.log(`   Time: ${elapsed}s (${rate} entries/sec)`);
        
        if (progress.error) {
          console.log(`   Error: ${progress.error}`);
        }

        // Check stats after
        console.log('\n4. Checking final stats...');
        const statsAfter = await getEmbeddingStats();
        console.log(`   Total entries: ${statsAfter.total}`);
        console.log(`   With embeddings: ${statsAfter.withEmbedding} (+${statsAfter.withEmbedding - statsBefore.withEmbedding})`);
        console.log(`   Coverage: ${statsAfter.coverage}%\n`);

        // Estimate time for full database
        if (rate > 0) {
          const remainingEntries = statsAfter.total - statsAfter.withEmbedding;
          const estimatedSeconds = Math.round(remainingEntries / rate);
          const estimatedMinutes = Math.round(estimatedSeconds / 60);
          const estimatedHours = Math.round(estimatedMinutes / 60);
          
          console.log('5. Full database estimate:');
          console.log(`   Remaining entries: ${remainingEntries.toLocaleString()}`);
          console.log(`   Estimated time: ~${estimatedHours}h ${estimatedMinutes % 60}m (at ${rate} entries/sec)`);
          console.log(`   Estimated cost: ~$${((remainingEntries * 50) / 1000000 * 0.02).toFixed(2)} (assuming ~50 tokens/entry)\n`);
        }

        console.log('✅ Large batch test complete!\n');
      }
    }, 2000); // Poll every 2 seconds

    // Timeout after 10 minutes
    setTimeout(() => {
      if (lastStatus === 'running') {
        clearInterval(pollInterval);
        console.log('\n⏱️  Test timeout (10 minutes). Process may still be running in background.\n');
        console.log(`   Check progress with: GET /api/tm/embedding-progress/${progressId}\n`);
      }
    }, 600000); // 10 minutes

  } catch (error: any) {
    console.error('\n❌ Test failed:', error.message);
    throw error;
  } finally {
    await prisma.$disconnect();
  }
}

testLargeBatch().catch((e) => {
  console.error('Fatal error:', e);
  process.exit(1);
});



