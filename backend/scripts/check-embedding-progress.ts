/**
 * Simple script to check embedding generation progress
 * Run this to see current status
 */

import { getActiveProgressIds, getEmbeddingGenerationProgress } from '../src/services/embedding-generation.service';
import { getEmbeddingStats } from '../src/services/vector-search.service';
import { logger } from '../src/utils/logger';

async function main() {
  console.log('\n🔍 Checking Embedding Generation Progress...\n');
  
  try {
    // Get active progress IDs
    const activeIds = getActiveProgressIds();
    
    if (activeIds.length === 0) {
      console.log('❌ No active embedding generation jobs found.\n');
      console.log('💡 To start generation, run: npx ts-node scripts/generate-all-embeddings.ts\n');
    } else {
      console.log(`✅ Found ${activeIds.length} active job(s):\n`);
      
      for (const progressId of activeIds) {
        const progress = getEmbeddingGenerationProgress(progressId);
        
        if (progress) {
          const percentage = progress.total > 0 
            ? Math.round((progress.processed / progress.total) * 100) 
            : 0;
          
          const elapsed = progress.startedAt 
            ? Math.round((Date.now() - progress.startedAt.getTime()) / 1000)
            : 0;
          
          const rate = elapsed > 0 && progress.processed > 0
            ? (progress.processed / elapsed).toFixed(2)
            : '0';
          
          const remaining = progress.total > progress.processed && parseFloat(rate) > 0
            ? Math.round((progress.total - progress.processed) / parseFloat(rate))
            : 0;
          
          console.log(`📊 Progress ID: ${progressId}`);
          console.log(`   Status: ${progress.status.toUpperCase()}`);
          console.log(`   Progress: ${progress.processed.toLocaleString()} / ${progress.total.toLocaleString()} (${percentage}%)`);
          console.log(`   ✅ Succeeded: ${progress.succeeded.toLocaleString()}`);
          console.log(`   ❌ Failed: ${progress.failed.toLocaleString()}`);
          console.log(`   ⏱️  Elapsed: ${elapsed}s`);
          console.log(`   📈 Rate: ${rate} entries/sec`);
          if (remaining > 0) {
            const hours = Math.floor(remaining / 3600);
            const minutes = Math.floor((remaining % 3600) / 60);
            const seconds = remaining % 60;
            console.log(`   ⏳ ETA: ${hours}h ${minutes}m ${seconds}s`);
          }
          if (progress.currentEntry) {
            const preview = progress.currentEntry.sourceText.substring(0, 60);
            console.log(`   📝 Current: ${preview}${progress.currentEntry.sourceText.length > 60 ? '...' : ''}`);
          }
          console.log('');
        }
      }
    }
    
    // Show overall stats
    console.log('📈 Overall Embedding Statistics:\n');
    const stats = await getEmbeddingStats();
    console.log(`   Total TM entries: ${stats.total.toLocaleString()}`);
    console.log(`   With embeddings: ${stats.withEmbedding.toLocaleString()}`);
    console.log(`   Coverage: ${stats.coverage.toFixed(1)}%`);
    console.log(`   Remaining: ${(stats.total - stats.withEmbedding).toLocaleString()}\n`);
    
    process.exit(0);
  } catch (error: any) {
    console.error('❌ Error:', error.message);
    process.exit(1);
  }
}

main();



