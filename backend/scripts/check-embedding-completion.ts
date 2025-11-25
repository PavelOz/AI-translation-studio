/**
 * Script to check if all embeddings are completed
 * Shows clear status: Complete, In Progress, or Not Started
 */

import { getActiveProgressIds, getEmbeddingGenerationProgress } from '../src/services/embedding-generation.service';
import { getEmbeddingStats } from '../src/services/vector-search.service';
import { logger } from '../src/utils/logger';

async function main() {
  console.log('\n╔══════════════════════════════════════════════════════════════╗');
  console.log('║        Embedding Generation Completion Status               ║');
  console.log('╚══════════════════════════════════════════════════════════════╝\n');
  
  try {
    // Get overall stats
    const stats = await getEmbeddingStats();
    
    // Check for active jobs
    const activeIds = getActiveProgressIds();
    let activeProgress = null;
    
    if (activeIds.length > 0) {
      activeProgress = getEmbeddingGenerationProgress(activeIds[0]);
    }
    
    // Determine status
    const remaining = stats.total - stats.withEmbedding;
    const coverage = stats.coverage;
    const isComplete = remaining === 0 && coverage === 100;
    const isInProgress = activeProgress && activeProgress.status === 'running';
    const hasActiveJob = activeIds.length > 0;
    
    // Display status
    if (isComplete) {
      console.log('✅ STATUS: COMPLETE\n');
      console.log('🎉 All TM entries have embeddings!\n');
      console.log(`   Total entries: ${stats.total.toLocaleString()}`);
      console.log(`   With embeddings: ${stats.withEmbedding.toLocaleString()}`);
      console.log(`   Coverage: ${stats.coverage.toFixed(1)}%\n`);
      console.log('✨ Vector search is now fully enabled for all entries!\n');
    } else if (isInProgress) {
      console.log('🔄 STATUS: IN PROGRESS\n');
      
      if (activeProgress) {
        const percentage = activeProgress.total > 0 
          ? Math.round((activeProgress.processed / activeProgress.total) * 100) 
          : 0;
        
        const elapsed = activeProgress.startedAt 
          ? Math.round((Date.now() - activeProgress.startedAt.getTime()) / 1000)
          : 0;
        
        const rate = elapsed > 0 && activeProgress.processed > 0
          ? (activeProgress.processed / elapsed).toFixed(2)
          : '0';
        
        const remainingTime = activeProgress.total > activeProgress.processed && parseFloat(rate) > 0
          ? Math.round((activeProgress.total - activeProgress.processed) / parseFloat(rate))
          : 0;
        
        const hours = Math.floor(remainingTime / 3600);
        const minutes = Math.floor((remainingTime % 3600) / 60);
        
        console.log(`   Current job progress: ${activeProgress.processed.toLocaleString()} / ${activeProgress.total.toLocaleString()} (${percentage}%)`);
        console.log(`   ✅ Succeeded: ${activeProgress.succeeded.toLocaleString()}`);
        console.log(`   ❌ Failed: ${activeProgress.failed.toLocaleString()}`);
        console.log(`   ⏱️  Elapsed: ${elapsed}s`);
        console.log(`   📈 Rate: ${rate} entries/sec`);
        if (remainingTime > 0) {
          console.log(`   ⏳ Remaining time: ${hours}h ${minutes}m`);
        }
        console.log('');
      }
      
      console.log(`   Overall progress:`);
      console.log(`   Total entries: ${stats.total.toLocaleString()}`);
      console.log(`   With embeddings: ${stats.withEmbedding.toLocaleString()}`);
      console.log(`   Remaining: ${remaining.toLocaleString()}`);
      console.log(`   Coverage: ${stats.coverage.toFixed(1)}%\n`);
      
      // Estimate completion
      if (activeProgress && activeProgress.startedAt && activeProgress.processed > 0) {
        const elapsed = (Date.now() - activeProgress.startedAt.getTime()) / 1000;
        const overallRate = elapsed > 0 ? activeProgress.processed / elapsed : 0;
        const totalRemaining = stats.total - stats.withEmbedding;
        const estimatedSeconds = overallRate > 0 ? Math.round(totalRemaining / overallRate) : 0;
        const estimatedHours = Math.floor(estimatedSeconds / 3600);
        const estimatedMinutes = Math.floor((estimatedSeconds % 3600) / 60);
        
        if (estimatedSeconds > 0) {
          console.log(`   📊 Estimated completion:`);
          console.log(`   Time remaining: ~${estimatedHours}h ${estimatedMinutes}m`);
          console.log(`   (at current rate: ${overallRate.toFixed(2)} entries/sec)\n`);
        }
      }
    } else if (hasActiveJob && activeProgress) {
      console.log('⚠️  STATUS: JOB EXISTS BUT NOT RUNNING\n');
      console.log(`   Job status: ${activeProgress.status}`);
      if (activeProgress.error) {
        console.log(`   Error: ${activeProgress.error}\n`);
      }
      console.log(`   Overall: ${stats.withEmbedding.toLocaleString()} / ${stats.total.toLocaleString()} (${stats.coverage.toFixed(1)}%)`);
      console.log(`   Remaining: ${remaining.toLocaleString()}\n`);
    } else {
      console.log('⏸️  STATUS: NOT STARTED\n');
      console.log(`   Total entries: ${stats.total.toLocaleString()}`);
      console.log(`   With embeddings: ${stats.withEmbedding.toLocaleString()}`);
      console.log(`   Coverage: ${stats.coverage.toFixed(1)}%`);
      console.log(`   Remaining: ${remaining.toLocaleString()}\n`);
      console.log('💡 To start generation, run:');
      console.log('   npx ts-node scripts/generate-all-embeddings.ts\n');
    }
    
    // Summary
    console.log('─'.repeat(60));
    console.log('Summary:');
    console.log(`  Coverage: ${stats.coverage.toFixed(1)}%`);
    console.log(`  Status: ${isComplete ? '✅ Complete' : isInProgress ? '🔄 In Progress' : '⏸️  Not Started'}`);
    console.log('─'.repeat(60));
    console.log('');
    
    process.exit(0);
  } catch (error: any) {
    console.error('❌ Error:', error.message);
    process.exit(1);
  }
}

main();

