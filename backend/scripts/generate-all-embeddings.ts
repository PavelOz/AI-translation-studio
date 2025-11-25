/**
 * Script to generate embeddings for ALL TM entries
 * This will process all entries that don't have embeddings yet
 */

import { generateEmbeddingsForExistingEntries, getEmbeddingGenerationProgress } from '../src/services/embedding-generation.service';
import { logger } from '../src/utils/logger';

async function main() {
  logger.info('Starting embedding generation for ALL TM entries...');
  
  try {
    // Start generation without limit (processes all entries)
    const progressId = await generateEmbeddingsForExistingEntries({
      batchSize: 50, // Process 50 entries at a time
      // No limit - process all entries
    });
    
    logger.info(`Embedding generation started. Progress ID: ${progressId}`);
    logger.info('Monitoring progress...');
    
    // Monitor progress
    let lastProcessed = 0;
    const startTime = Date.now();
    
    while (true) {
      await new Promise(resolve => setTimeout(resolve, 2000)); // Check every 2 seconds
      
      const progress = getEmbeddingGenerationProgress(progressId);
      
      if (!progress) {
        logger.error('Progress not found. Generation may have failed.');
        break;
      }
      
      // Log progress updates
      if (progress.processed !== lastProcessed) {
        const elapsed = (Date.now() - startTime) / 1000;
        const rate = progress.processed / elapsed;
        const remaining = progress.total > 0 
          ? Math.max(0, (progress.total - progress.processed) / rate)
          : 0;
        
        logger.info({
          processed: progress.processed,
          total: progress.total,
          succeeded: progress.succeeded,
          failed: progress.failed,
          status: progress.status,
          rate: `${rate.toFixed(2)} entries/sec`,
          eta: remaining > 0 ? `${Math.round(remaining)}s` : 'calculating...',
        }, 'Progress update');
        
        lastProcessed = progress.processed;
      }
      
      // Check if completed
      if (progress.status === 'completed') {
        logger.info({
          total: progress.total,
          succeeded: progress.succeeded,
          failed: progress.failed,
          duration: progress.completedAt && progress.startedAt
            ? `${Math.round((progress.completedAt.getTime() - progress.startedAt.getTime()) / 1000)}s`
            : 'unknown',
        }, 'Embedding generation completed!');
        break;
      }
      
      if (progress.status === 'cancelled') {
        logger.warn('Embedding generation was cancelled');
        break;
      }
      
      if (progress.status === 'error') {
        logger.error({ error: progress.error }, 'Embedding generation failed');
        break;
      }
    }
    
    process.exit(0);
  } catch (error: any) {
    logger.error({ error: error.message }, 'Failed to generate embeddings');
    process.exit(1);
  }
}

main();



