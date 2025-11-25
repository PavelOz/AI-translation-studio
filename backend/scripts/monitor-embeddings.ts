/**
 * Simple script to monitor embedding generation progress
 * Run this in a separate terminal window to watch progress
 */

import { getActiveProgressIds, getEmbeddingGenerationProgress } from '../src/services/embedding-generation.service';
import { getEmbeddingStats } from '../src/services/vector-search.service';

async function monitor() {
  console.clear();
  console.log('╔══════════════════════════════════════════════════════════════╗');
  console.log('║     Embedding Generation Progress Monitor                    ║');
  console.log('╚══════════════════════════════════════════════════════════════╝');
  console.log('');
  
  const activeIds = getActiveProgressIds();
  
  if (activeIds.length === 0) {
    console.log('❌ No active embedding generation jobs found.\n');
    console.log('💡 To start generation, run:');
    console.log('   npx ts-node scripts/generate-all-embeddings.ts\n');
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
        
        const hours = Math.floor(remaining / 3600);
        const minutes = Math.floor((remaining % 3600) / 60);
        const seconds = remaining % 60;
        
        // Progress bar
        const barWidth = 50;
        const filled = Math.round((progress.processed / progress.total) * barWidth);
        const bar = '█'.repeat(filled) + '░'.repeat(barWidth - filled);
        
        console.log(`📊 Progress ID: ${progressId}`);
        console.log(`   Status: ${progress.status.toUpperCase()}`);
        console.log(`   ┌────────────────────────────────────────────────────────┐`);
        console.log(`   │ ${bar} │`);
        console.log(`   └────────────────────────────────────────────────────────┘`);
        console.log(`   Progress: ${progress.processed.toLocaleString()} / ${progress.total.toLocaleString()} (${percentage}%)`);
        console.log(`   ✅ Succeeded: ${progress.succeeded.toLocaleString()}`);
        console.log(`   ❌ Failed: ${progress.failed.toLocaleString()}`);
        console.log(`   ⏱️  Elapsed: ${elapsed}s`);
        console.log(`   📈 Rate: ${rate} entries/sec`);
        if (remaining > 0) {
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
  const stats = await getEmbeddingStats();
  console.log('📈 Overall Statistics:');
  console.log(`   Total TM entries: ${stats.total.toLocaleString()}`);
  console.log(`   With embeddings: ${stats.withEmbedding.toLocaleString()}`);
  console.log(`   Coverage: ${stats.coverage.toFixed(1)}%`);
  console.log(`   Remaining: ${(stats.total - stats.withEmbedding).toLocaleString()}\n`);
  
  console.log('💡 Press Ctrl+C to exit. This will refresh every 2 seconds.\n');
}

// Monitor every 2 seconds
const interval = setInterval(() => {
  monitor().catch(console.error);
}, 2000);

// Initial run
monitor().catch(console.error);

// Handle Ctrl+C
process.on('SIGINT', () => {
  clearInterval(interval);
  console.log('\n\n👋 Monitoring stopped.\n');
  process.exit(0);
});



