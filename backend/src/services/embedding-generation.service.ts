import { prisma } from '../db/prisma';
import { logger } from '../utils/logger';
import { generateEmbedding, generateEmbeddingsBatch } from './embedding.service';
import { storeEmbedding, storeEmbeddingsBatch, getEmbeddingStats, storeGlossaryEmbedding } from './vector-search.service';
import { env } from '../utils/env';

export interface EmbeddingGenerationProgress {
  total: number;
  processed: number;
  succeeded: number;
  failed: number;
  currentEntry?: {
    id: string;
    sourceText: string;
  };
  status: 'idle' | 'running' | 'completed' | 'cancelled' | 'error';
  error?: string;
  startedAt?: Date;
  completedAt?: Date;
}

// In-memory progress store (in production, use Redis or database)
const progressStore = new Map<string, EmbeddingGenerationProgress>();

// Cancellation flags
const cancellationFlags = new Set<string>();

/**
 * Generate embeddings for existing TM entries that don't have them
 * @param options - Generation options
 * @returns Progress ID for tracking
 */
export async function generateEmbeddingsForExistingEntries(options: {
  projectId?: string;
  batchSize?: number;
  limit?: number; // Max entries to process (for testing)
  onProgress?: (progress: EmbeddingGenerationProgress) => void;
}): Promise<string> {
  const progressId = `embedding-gen-${Date.now()}`;
  const batchSize = options.batchSize || 50; // Process 50 entries at a time
  const limit = options.limit;

  // Validate API key
  if (!env.openAiApiKey) {
    throw new Error('OPENAI_API_KEY is not configured. Please add it to your .env file.');
  }

  const progress: EmbeddingGenerationProgress = {
    total: 0,
    processed: 0,
    succeeded: 0,
    failed: 0,
    status: 'running',
    startedAt: new Date(),
  };

  progressStore.set(progressId, progress);

  // Run generation in background
  (async () => {
    try {
      // Count entries without embeddings using raw query (Prisma doesn't expose Unsupported types)
      let countQuery = `SELECT COUNT(*)::int as count FROM "TranslationMemoryEntry" WHERE "sourceEmbedding" IS NULL AND "sourceText" != ''`;
      const countParams: any[] = [];
      
      if (options.projectId) {
        countQuery += ` AND "projectId" = $1`;
        countParams.push(options.projectId);
      }

      const countResult = await prisma.$queryRawUnsafe<Array<{ count: number }>>(
        countQuery,
        ...countParams,
      );

      const totalCount = countResult[0].count;

      progress.total = limit ? Math.min(limit, totalCount) : totalCount;
      progressStore.set(progressId, { ...progress });

      if (progress.total === 0) {
        progress.status = 'completed';
        progress.completedAt = new Date();
        progressStore.set(progressId, { ...progress });
        if (options.onProgress) {
          options.onProgress({ ...progress });
        }
        return;
      }

      logger.info(`Starting embedding generation for ${progress.total} TM entries`);

      let processed = 0;
      let lastProcessedIds = new Set<string>(); // Track recently processed IDs to avoid duplicates
      let consecutiveEmptyBatches = 0;
      const MAX_CONSECUTIVE_EMPTY = 5;
      const MAX_TRACKED_IDS = 1000;

      // Keep processing until no more entries are found (don't rely on total count)
      while (!cancellationFlags.has(progressId)) {
        // Check cancellation
        if (cancellationFlags.has(progressId)) {
          progress.status = 'cancelled';
          progress.completedAt = new Date();
          progressStore.set(progressId, { ...progress });
          if (options.onProgress) {
            options.onProgress({ ...progress });
          }
          return;
        }

        // Always query from beginning - WHERE clause will skip entries that already have embeddings
        let fetchQuery = `SELECT id, "sourceText", "sourceLocale", "targetLocale" 
          FROM "TranslationMemoryEntry" 
          WHERE "sourceEmbedding" IS NULL 
          AND "sourceText" != ''`;
        const fetchParams: any[] = [];
        let paramIndex = 1;

        if (options.projectId) {
          fetchQuery += ` AND "projectId" = $${paramIndex}`;
          fetchParams.push(options.projectId);
          paramIndex += 1;
        }

        // Exclude recently processed IDs to avoid reprocessing the same entries
        if (lastProcessedIds.size > 0) {
          const excludedIds = Array.from(lastProcessedIds).slice(-100); // Only exclude last 100 to avoid huge IN clause
          if (excludedIds.length > 0) {
            fetchQuery += ` AND id NOT IN (${excludedIds.map((_, i) => `$${paramIndex + i}`).join(', ')})`;
            fetchParams.push(...excludedIds);
            paramIndex += excludedIds.length;
          }
        }

        fetchQuery += ` ORDER BY "createdAt" DESC LIMIT $${paramIndex}`;
        fetchParams.push(batchSize);

        logger.debug(
          {
            processed,
            total: progress.total,
            batchSize,
            trackedIds: lastProcessedIds.size,
            consecutiveEmpty: consecutiveEmptyBatches,
          },
          'Fetching TM batch',
        );

        const entriesResult = await prisma.$queryRawUnsafe<Array<{
          id: string;
          sourceText: string;
          sourceLocale: string;
          targetLocale: string;
        }>>(fetchQuery, ...fetchParams);

        const entries = entriesResult;

        logger.info(
          {
            processed,
            total: progress.total,
            entriesFound: entries.length,
            batchSize,
            trackedIds: lastProcessedIds.size,
          },
          `TM batch query: found ${entries.length} entries`,
        );

        if (entries.length === 0) {
          consecutiveEmptyBatches++;
          
          // Check if there are actually more entries without embeddings
          let remainingCheckQuery = `SELECT COUNT(*)::int as count FROM "TranslationMemoryEntry" WHERE "sourceEmbedding" IS NULL AND "sourceText" != ''`;
          const remainingParams: any[] = [];
          let remainingParamIndex = 1;
          
          if (options.projectId) {
            remainingCheckQuery += ` AND "projectId" = $${remainingParamIndex}`;
            remainingParams.push(options.projectId);
            remainingParamIndex += 1;
          }
          
          const remainingCheck = await prisma.$queryRawUnsafe<Array<{ count: number }>>(
            remainingCheckQuery,
            ...remainingParams
          );
          
          const remaining = remainingCheck[0].count;
          
          logger.info(
            {
              processed,
              total: progress.total,
              remaining,
              consecutiveEmptyBatches,
              trackedIds: lastProcessedIds.size,
            },
            'No TM entries found in batch, checking remaining count',
          );
          
          if (remaining > 0) {
            if (consecutiveEmptyBatches > MAX_CONSECUTIVE_EMPTY) {
              // Too many empty batches - clear tracked IDs and try again
              logger.warn(
                {
                  remaining,
                  processed,
                  consecutiveEmptyBatches,
                },
                'Too many consecutive empty TM batches. Clearing tracked IDs and retrying...',
              );
              lastProcessedIds.clear();
              consecutiveEmptyBatches = 0;
              await new Promise((resolve) => setTimeout(resolve, 1000));
              continue;
            }
            
            // Clear some tracked IDs to allow querying those entries again
            if (lastProcessedIds.size > MAX_TRACKED_IDS / 2) {
              const idsArray = Array.from(lastProcessedIds);
              lastProcessedIds = new Set(idsArray.slice(-MAX_TRACKED_IDS / 2));
            }
            
            // Update total to reflect actual remaining count
            progress.total = processed + remaining;
            progressStore.set(progressId, { ...progress });
            
            await new Promise((resolve) => setTimeout(resolve, 200));
            continue;
          } else {
            // No more entries without embeddings - we're done!
            logger.info(
              {
                processed,
                total: progress.total,
                succeeded: progress.succeeded,
                failed: progress.failed,
              },
              'No more TM entries without embeddings found. Generation complete.',
            );
            break;
          }
        }
        
        // Reset consecutive empty batches counter when we find entries
        consecutiveEmptyBatches = 0;

        // Update current entry
        progress.currentEntry = {
          id: entries[0].id,
          sourceText: entries[0].sourceText.substring(0, 50) + '...',
        };

        logger.info(
          {
            batchNumber: Math.floor(processed / batchSize) + 1,
            entriesInBatch: entries.length,
            processed,
            total: progress.total,
          },
          `Processing TM batch ${Math.floor(processed / batchSize) + 1}`,
        );

        try {
          // Generate embeddings in batch
          logger.debug(`Generating embeddings for ${entries.length} TM entries`);
          const texts = entries.map((e) => e.sourceText);
          const embeddings = await generateEmbeddingsBatch(texts, true);

          logger.debug(
            {
              entriesCount: entries.length,
              embeddingsCount: embeddings.length,
              embeddingsValid: embeddings.filter(e => e && e.length === 1536).length,
            },
            'Generated embeddings for TM batch',
          );

          // Store embeddings
          const embeddingEntries = entries
            .map((entry, index) => ({
              entryId: entry.id,
              embedding: embeddings[index],
              model: 'text-embedding-3-small',
            }))
            .filter((e) => e.embedding && e.embedding.length === 1536);

          if (embeddingEntries.length > 0) {
            logger.debug(`Storing ${embeddingEntries.length} TM embeddings`);
            await storeEmbeddingsBatch(embeddingEntries);
            progress.succeeded += embeddingEntries.length;
            logger.info(
              {
                stored: embeddingEntries.length,
                batchTotal: entries.length,
                totalSucceeded: progress.succeeded,
              },
              'Stored TM embeddings batch',
            );
          }

          // Count failed (entries without valid embeddings)
          const failedCount = entries.length - embeddingEntries.length;
          progress.failed += failedCount;

          // Track processed IDs
          entries.forEach(entry => {
            lastProcessedIds.add(entry.id);
            if (lastProcessedIds.size > MAX_TRACKED_IDS) {
              const idsArray = Array.from(lastProcessedIds);
              lastProcessedIds = new Set(idsArray.slice(-MAX_TRACKED_IDS));
            }
          });

          processed += entries.length;
          progress.processed = processed;

          logger.info(
            {
              processed,
              total: progress.total,
              succeeded: progress.succeeded,
              failed: progress.failed,
              percentage: progress.total > 0 ? Math.round((processed / progress.total) * 100) : 0,
            },
            `TM batch completed: ${processed}/${progress.total} (${progress.succeeded} succeeded, ${progress.failed} failed)`,
          );

          // Update progress
          progressStore.set(progressId, { ...progress });
          if (options.onProgress) {
            options.onProgress({ ...progress });
          }

          // Rate limiting: small delay between batches to avoid overwhelming OpenAI API
          await new Promise((resolve) => setTimeout(resolve, 100));
        } catch (error: any) {
          logger.error(
            {
              error: error.message,
              batchSize: entries.length,
              processed,
              stack: error.stack?.substring(0, 300),
            },
            'Error processing TM batch',
          );

          // Track failed entries too
          entries.forEach(entry => {
            lastProcessedIds.add(entry.id);
            if (lastProcessedIds.size > MAX_TRACKED_IDS) {
              const idsArray = Array.from(lastProcessedIds);
              lastProcessedIds = new Set(idsArray.slice(-MAX_TRACKED_IDS));
            }
          });

          progress.failed += entries.length;
          processed += entries.length;
          progress.processed = processed;

          // Continue with next batch even if this one failed
          progressStore.set(progressId, { ...progress });
          if (options.onProgress) {
            options.onProgress({ ...progress });
          }
        }

        // If we've reached the limit, stop
        if (limit && processed >= limit) {
          logger.info(`Reached processing limit: ${processed}/${limit}`);
          break;
        }
      }

      // Final check: verify we actually processed all entries
      const finalRemainingCheck = await prisma.$queryRawUnsafe<Array<{ count: number }>>(
        `SELECT COUNT(*)::int as count FROM "TranslationMemoryEntry" WHERE "sourceEmbedding" IS NULL AND "sourceText" != ''${options.projectId ? ` AND "projectId" = $1` : ''}`,
        ...(options.projectId ? [options.projectId] : [])
      );
      const finalRemaining = finalRemainingCheck[0].count;
      
      logger.info(
        {
          processed,
          total: progress.total,
          succeeded: progress.succeeded,
          failed: progress.failed,
          finalRemaining,
        },
        'TM embedding generation loop finished',
      );
      
      if (finalRemaining > 0 && processed < progress.total) {
        // There are still entries remaining but we stopped processing
        logger.error(
          {
            processed,
            total: progress.total,
            finalRemaining,
            succeeded: progress.succeeded,
            failed: progress.failed,
          },
          'TM embedding generation stopped but entries remain without embeddings!',
        );
        progress.status = 'error';
        progress.error = `Generation stopped prematurely. ${finalRemaining} entries still need embeddings. Processed: ${processed}/${progress.total}`;
      } else {
        // Mark as completed
        progress.status = cancellationFlags.has(progressId) ? 'cancelled' : 'completed';
      }
      
      progress.completedAt = new Date();
      progress.currentEntry = undefined;
      progressStore.set(progressId, { ...progress });

      if (options.onProgress) {
        options.onProgress({ ...progress });
      }

      logger.info(
        {
          processed,
          total: progress.total,
          succeeded: progress.succeeded,
          failed: progress.failed,
          finalRemaining,
          status: progress.status,
        },
        'TM embedding generation completed',
      );
    } catch (error: any) {
      logger.error(
        {
          error: error.message,
          stack: error.stack,
        },
        'Embedding generation failed',
      );

      progress.status = 'error';
      progress.error = error.message;
      progress.completedAt = new Date();
      progressStore.set(progressId, { ...progress });

      if (options.onProgress) {
        options.onProgress({ ...progress });
      }
    } finally {
      // Clean up cancellation flag
      cancellationFlags.delete(progressId);
    }
  })();

  return progressId;
}

/**
 * Cancel embedding generation
 */
export function cancelEmbeddingGeneration(progressId: string): void {
  cancellationFlags.add(progressId);
  logger.info(`Cancellation requested for embedding generation: ${progressId}`);
}

/**
 * Get progress for embedding generation
 */
export function getEmbeddingGenerationProgress(progressId: string): EmbeddingGenerationProgress | null {
  return progressStore.get(progressId) || null;
}

/**
 * Generate embedding for a single TM entry (used when new entry is created)
 */
export async function generateEmbeddingForEntry(entryId: string): Promise<void> {
  try {
    // Check if entry has embedding using raw query (Prisma doesn't expose Unsupported types)
    const hasEmbeddingResult = await prisma.$queryRawUnsafe<Array<{ has_embedding: boolean }>>(
      `SELECT "sourceEmbedding" IS NOT NULL as has_embedding FROM "TranslationMemoryEntry" WHERE id = $1`,
      entryId,
    );

    if (hasEmbeddingResult.length === 0) {
      throw new Error(`TM entry not found: ${entryId}`);
    }

    // Skip if already has embedding
    if (hasEmbeddingResult[0].has_embedding) {
      logger.debug(`Entry ${entryId} already has embedding, skipping`);
      return;
    }

    // Get entry text
    const entry = await prisma.translationMemoryEntry.findUnique({
      where: { id: entryId },
      select: {
        id: true,
        sourceText: true,
      },
    });

    if (!entry) {
      throw new Error(`TM entry not found: ${entryId}`);
    }

    // Skip if empty text
    if (!entry.sourceText || !entry.sourceText.trim()) {
      logger.debug(`Entry ${entryId} has empty source text, skipping`);
      return;
    }

    // Validate API key
    if (!env.openAiApiKey) {
      logger.warn('OPENAI_API_KEY not configured, skipping embedding generation');
      return;
    }

    // Generate embedding
    const embedding = await generateEmbedding(entry.sourceText, true);

    // Store embedding
    await storeEmbedding(entryId, embedding, 'text-embedding-3-small');

    logger.debug(`Generated embedding for entry: ${entryId}`);
  } catch (error: any) {
    logger.error(
      {
        entryId,
        error: error.message,
      },
      'Failed to generate embedding for entry',
    );
    // Don't throw - we don't want to fail the entire operation if embedding fails
  }
}

/**
 * Generate embeddings for multiple entries (batch)
 */
export async function generateEmbeddingsForEntries(entryIds: string[]): Promise<{
  succeeded: number;
  failed: number;
}> {
  if (entryIds.length === 0) {
    return { succeeded: 0, failed: 0 };
  }

  // Validate API key
  if (!env.openAiApiKey) {
    throw new Error('OPENAI_API_KEY is not configured');
  }

  let succeeded = 0;
  let failed = 0;

  try {
    // Fetch entries without embeddings using raw query (Prisma doesn't expose Unsupported types)
    const entriesResult = await prisma.$queryRawUnsafe<Array<{ id: string; sourceText: string }>>(
      `SELECT id, "sourceText" FROM "TranslationMemoryEntry" 
       WHERE id = ANY($1::uuid[]) 
       AND "sourceEmbedding" IS NULL 
       AND "sourceText" != ''`,
      entryIds,
    );

    const entries = entriesResult;

    if (entries.length === 0) {
      return { succeeded: 0, failed: 0 };
    }

    // Generate embeddings in batch
    const texts = entries.map((e) => e.sourceText);
    const embeddings = await generateEmbeddingsBatch(texts, true);

    // Store embeddings
    const embeddingEntries = entries
      .map((entry, index) => ({
        entryId: entry.id,
        embedding: embeddings[index],
        model: 'text-embedding-3-small',
      }))
      .filter((e) => e.embedding && e.embedding.length === 1536);

    if (embeddingEntries.length > 0) {
      await storeEmbeddingsBatch(embeddingEntries);
      succeeded = embeddingEntries.length;
    }

    failed = entries.length - succeeded;

    logger.info(`Generated embeddings for ${succeeded} entries (${failed} failed)`);
  } catch (error: any) {
    logger.error(
      {
        error: error.message,
        entryCount: entryIds.length,
      },
      'Failed to generate embeddings for entries',
    );
    failed = entryIds.length;
  }

  return { succeeded, failed };
}

/**
 * Get all active progress IDs
 */
export function getActiveProgressIds(): string[] {
  return Array.from(progressStore.keys()).filter(
    (id) => progressStore.get(id)?.status === 'running',
  );
}

/**
 * Clean up old progress entries (older than 1 hour)
 */
export function cleanupOldProgress(): void {
  const oneHourAgo = Date.now() - 60 * 60 * 1000;

  for (const [id, progress] of progressStore.entries()) {
    if (
      progress.completedAt &&
      progress.completedAt.getTime() < oneHourAgo
    ) {
      progressStore.delete(id);
    }
  }
}

// Clean up old progress every 10 minutes
setInterval(cleanupOldProgress, 10 * 60 * 1000);

/**
 * Generate embedding for a single glossary entry (used when new entry is created/updated)
 */
export async function generateEmbeddingForGlossaryEntry(entryId: string): Promise<void> {
  try {
    // Check if entry has embedding using raw query (Prisma doesn't expose Unsupported types)
    const hasEmbeddingResult = await prisma.$queryRawUnsafe<Array<{ has_embedding: boolean }>>(
      `SELECT "sourceEmbedding" IS NOT NULL as has_embedding FROM "GlossaryEntry" WHERE id = $1`,
      entryId,
    );

    if (hasEmbeddingResult.length === 0) {
      throw new Error(`Glossary entry not found: ${entryId}`);
    }

    // Skip if already has embedding (unless we want to regenerate)
    if (hasEmbeddingResult[0].has_embedding) {
      logger.debug(`Glossary entry ${entryId} already has embedding, skipping`);
      return;
    }

    // Get entry text
    const entry = await prisma.glossaryEntry.findUnique({
      where: { id: entryId },
      select: {
        id: true,
        sourceTerm: true,
      },
    });

    if (!entry) {
      throw new Error(`Glossary entry not found: ${entryId}`);
    }

    // Skip if empty text
    if (!entry.sourceTerm || !entry.sourceTerm.trim()) {
      logger.debug(`Glossary entry ${entryId} has empty source term, skipping`);
      return;
    }

    // Validate API key
    if (!env.openAiApiKey) {
      logger.warn('OPENAI_API_KEY not configured, skipping glossary embedding generation');
      return;
    }

    // Generate embedding for the source term (phrase)
    const embedding = await generateEmbedding(entry.sourceTerm, true);

    // Store embedding
    await storeGlossaryEmbedding(entryId, embedding, 'text-embedding-3-small');

    logger.debug(`Generated embedding for glossary entry: ${entryId}`);
  } catch (error: any) {
    logger.error(
      {
        entryId,
        error: error.message,
      },
      'Failed to generate embedding for glossary entry',
    );
    // Don't throw - we don't want to fail the entire operation if embedding fails
  }
}

/**
 * Generate embeddings for existing glossary entries that don't have them
 * @param options - Generation options
 * @returns Progress ID for tracking
 */
export async function generateEmbeddingsForExistingGlossaryEntries(options: {
  projectId?: string;
  batchSize?: number;
  limit?: number; // Max entries to process (for testing)
  onProgress?: (progress: EmbeddingGenerationProgress) => void;
}): Promise<string> {
  const progressId = `glossary-embedding-gen-${Date.now()}`;
  const batchSize = options.batchSize || 50; // Process 50 entries at a time
  const limit = options.limit;

  // Validate API key
  if (!env.openAiApiKey) {
    throw new Error('OPENAI_API_KEY is not configured. Please add it to your .env file.');
  }

  const progress: EmbeddingGenerationProgress = {
    total: 0,
    processed: 0,
    succeeded: 0,
    failed: 0,
    status: 'running',
    startedAt: new Date(),
  };

  progressStore.set(progressId, progress);

  // Run generation in background
  (async () => {
    try {
      // Count entries without embeddings using raw query (Prisma doesn't expose Unsupported types)
      let countQuery = `SELECT COUNT(*)::int as count FROM "GlossaryEntry" WHERE "sourceEmbedding" IS NULL AND "sourceTerm" != ''`;
      const countParams: any[] = [];
      
      if (options.projectId) {
        countQuery += ` AND "projectId" = $1`;
        countParams.push(options.projectId);
      }

      const countResult = await prisma.$queryRawUnsafe<Array<{ count: number }>>(
        countQuery,
        ...countParams,
      );

      const totalCount = countResult[0].count;

      progress.total = limit ? Math.min(limit, totalCount) : totalCount;
      progressStore.set(progressId, { ...progress });

      if (progress.total === 0) {
        progress.status = 'completed';
        progress.completedAt = new Date();
        progressStore.set(progressId, { ...progress });
        if (options.onProgress) {
          options.onProgress({ ...progress });
        }
        return;
      }

      logger.info(`Starting embedding generation for ${progress.total} glossary entries`);

      let processed = 0;
      let lastProcessedIds = new Set<string>(); // Track recently processed IDs to avoid duplicates
      let consecutiveEmptyBatches = 0; // Track consecutive empty batches
      const MAX_CONSECUTIVE_EMPTY = 5; // Max consecutive empty batches before giving up
      const MAX_TRACKED_IDS = 1000; // Max IDs to track (to avoid memory issues)

      // Keep processing until no more entries are found (don't rely on total count)
      while (!cancellationFlags.has(progressId)) {
        // Check cancellation
        if (cancellationFlags.has(progressId)) {
          progress.status = 'cancelled';
          progress.completedAt = new Date();
          progressStore.set(progressId, { ...progress });
          if (options.onProgress) {
            options.onProgress({ ...progress });
          }
          return;
        }

        // Always query from beginning - WHERE clause will skip entries that already have embeddings
        // This is simpler and more reliable than cursor pagination
        let fetchQuery = `SELECT id, "sourceTerm" 
          FROM "GlossaryEntry" 
          WHERE "sourceEmbedding" IS NULL 
          AND "sourceTerm" != ''`;
        const fetchParams: any[] = [];
        let paramIndex = 1;

        if (options.projectId) {
          fetchQuery += ` AND "projectId" = $${paramIndex}`;
          fetchParams.push(options.projectId);
          paramIndex += 1;
        }

        // Exclude recently processed IDs to avoid reprocessing the same entries
        if (lastProcessedIds.size > 0) {
          const excludedIds = Array.from(lastProcessedIds).slice(-100); // Only exclude last 100 to avoid huge IN clause
          if (excludedIds.length > 0) {
            fetchQuery += ` AND id NOT IN (${excludedIds.map((_, i) => `$${paramIndex + i}`).join(', ')})`;
            fetchParams.push(...excludedIds);
            paramIndex += excludedIds.length;
          }
        }

        fetchQuery += ` ORDER BY "id" LIMIT $${paramIndex}`;
        fetchParams.push(batchSize);

        const entriesResult = await prisma.$queryRawUnsafe<Array<{
          id: string;
          sourceTerm: string;
        }>>(fetchQuery, ...fetchParams);

        const entries = entriesResult;
        
        // Log query details for debugging (especially when we hit issues)
        if (processed % 500 === 0 || entries.length === 0 || (processed > 0 && processed % 1000 === 0)) {
          logger.debug(
            {
              processed,
              total: progress.total,
              batchSize,
              entriesFound: entries.length,
              lastId,
              hasLastId: !!lastId,
              query: fetchQuery.substring(0, 200),
            },
            'Glossary batch query result',
          );
        }

        if (entries.length === 0) {
          consecutiveEmptyBatches++;
          
          // Check if there are actually more entries without embeddings
          let remainingCheckQuery = `SELECT COUNT(*)::int as count FROM "GlossaryEntry" WHERE "sourceEmbedding" IS NULL AND "sourceTerm" != ''`;
          const remainingParams: any[] = [];
          let remainingParamIndex = 1;
          
          if (options.projectId) {
            remainingCheckQuery += ` AND "projectId" = $${remainingParamIndex}`;
            remainingParams.push(options.projectId);
            remainingParamIndex += 1;
          }
          
          const remainingCheck = await prisma.$queryRawUnsafe<Array<{ count: number }>>(
            remainingCheckQuery,
            ...remainingParams
          );
          
          const remaining = remainingCheck[0].count;
          
          logger.info(
            {
              processed,
              total: progress.total,
              remaining,
              consecutiveEmptyBatches,
              trackedIds: lastProcessedIds.size,
            },
            'No entries found in batch, checking remaining count',
          );
          
          if (remaining > 0) {
            if (consecutiveEmptyBatches > MAX_CONSECUTIVE_EMPTY) {
              // Too many empty batches - clear tracked IDs and try again
              logger.warn(
                {
                  remaining,
                  processed,
                  consecutiveEmptyBatches,
                },
                'Too many consecutive empty batches. Clearing tracked IDs and retrying...',
              );
              lastProcessedIds.clear();
              consecutiveEmptyBatches = 0;
              await new Promise((resolve) => setTimeout(resolve, 1000));
              continue;
            }
            
            // Clear some tracked IDs to allow querying those entries again
            // Keep only the most recent ones
            if (lastProcessedIds.size > MAX_TRACKED_IDS / 2) {
              const idsArray = Array.from(lastProcessedIds);
              lastProcessedIds = new Set(idsArray.slice(-MAX_TRACKED_IDS / 2));
            }
            
            // Update total to reflect actual remaining count
            progress.total = processed + remaining;
            progressStore.set(progressId, { ...progress });
            
            await new Promise((resolve) => setTimeout(resolve, 200));
            continue;
          } else {
            // No more entries without embeddings - we're done!
            logger.info(
              {
                processed,
                total: progress.total,
                succeeded: progress.succeeded,
                failed: progress.failed,
              },
              'No more entries without embeddings found. Generation complete.',
            );
            break;
          }
        }
        
        // Reset consecutive empty batches counter when we find entries
        consecutiveEmptyBatches = 0;

        // Update current entry
        progress.currentEntry = {
          id: entries[0].id,
          sourceText: entries[0].sourceTerm.substring(0, 50) + '...',
        };

        try {
          // Generate embeddings in batch with retry logic
          const texts = entries.map((e) => e.sourceTerm);
          let embeddings: number[][];
          
          // Retry logic for rate limits and transient errors
          let retries = 3;
          let lastError: any = null;
          
          while (retries > 0) {
            try {
              embeddings = await generateEmbeddingsBatch(texts, true);
              lastError = null;
              break;
            } catch (error: any) {
              lastError = error;
              
              // Check if it's a quota error (should stop immediately) vs rate limit (can retry)
              const isQuotaError = error.message?.includes('quota') || 
                                   error.message?.includes('billing') || 
                                   error.message?.includes('exceeded your current quota');
              
              if (isQuotaError) {
                // Quota exceeded - don't retry, stop immediately
                logger.error('OpenAI API quota exceeded. Stopping embedding generation.');
                throw new Error('OpenAI API quota exceeded. Please check your billing and add credits to your OpenAI account.');
              } else if (error.message?.includes('rate limit') || error.status === 429) {
                // Rate limit - can retry with backoff
                const waitTime = (4 - retries) * 2000; // Exponential backoff: 2s, 4s, 6s
                logger.warn(`Rate limit hit, waiting ${waitTime}ms before retry (${retries} retries left)`);
                await new Promise((resolve) => setTimeout(resolve, waitTime));
                retries--;
              } else {
                // For other errors, don't retry
                throw error;
              }
            }
          }
          
          if (lastError) {
            throw lastError;
          }

          // Validate that we got embeddings for all entries
          if (embeddings!.length !== entries.length) {
            logger.warn(
              {
                expected: entries.length,
                received: embeddings!.length,
              },
              'Mismatch between entries and embeddings count',
            );
          }

          // Store embeddings - map entries to embeddings by index
          // Track which entries have valid embeddings
          const embeddingEntries: Array<{
            entryId: string;
            embedding: number[];
            model: string;
          }> = [];
          const entriesWithoutValidEmbeddings: string[] = [];

          entries.forEach((entry, index) => {
            const embedding = embeddings![index];
            
            // Check if embedding is valid (exists, is array, has correct length)
            if (embedding && Array.isArray(embedding) && embedding.length === 1536) {
              embeddingEntries.push({
                entryId: entry.id,
                embedding: embedding,
                model: 'text-embedding-3-small',
              });
            } else {
              // Entry failed to generate valid embedding
              entriesWithoutValidEmbeddings.push(entry.id);
              logger.debug(
                {
                  entryId: entry.id,
                  sourceTerm: entry.sourceTerm.substring(0, 50),
                  hasEmbedding: !!embedding,
                  embeddingLength: embedding?.length || 0,
                },
                'Entry failed to generate valid embedding',
              );
            }
          });

          // Count entries that failed to generate valid embeddings
          const entriesWithoutEmbeddings = entriesWithoutValidEmbeddings.length;
          
          if (embeddingEntries.length > 0) {
            // Store glossary embeddings one by one (since storeGlossaryEmbedding is separate from storeEmbeddingsBatch)
            // Handle individual failures gracefully
            let storedCount = 0;
            let storageFailedCount = 0;
            
            for (const entry of embeddingEntries) {
              try {
                await storeGlossaryEmbedding(entry.entryId, entry.embedding!, entry.model || 'text-embedding-3-small');
                storedCount++;
              } catch (storeError: any) {
                storageFailedCount++;
                logger.warn(
                  {
                    entryId: entry.entryId,
                    error: storeError.message,
                  },
                  'Failed to store individual glossary embedding, continuing...',
                );
                // Continue with next entry even if this one fails
              }
            }
            
            progress.succeeded += storedCount;
            // Count both: entries that didn't generate embeddings + entries that generated but failed to store
            const totalFailedInBatch = entriesWithoutEmbeddings + storageFailedCount;
            progress.failed += totalFailedInBatch;
            
            logger.debug(
              {
                batchSize: entries.length,
                generatedEmbeddings: embeddingEntries.length,
                stored: storedCount,
                storageFailed: storageFailedCount,
                noEmbeddings: entriesWithoutEmbeddings,
                totalFailed: totalFailedInBatch,
                expectedTotal: entries.length,
                actualTotal: storedCount + totalFailedInBatch,
              },
              'Batch processing summary',
            );
            
            // Sanity check: stored + failed should equal entries processed
            if (storedCount + totalFailedInBatch !== entries.length) {
              logger.warn(
                {
                  batchSize: entries.length,
                  stored: storedCount,
                  failed: totalFailedInBatch,
                  sum: storedCount + totalFailedInBatch,
                  difference: entries.length - (storedCount + totalFailedInBatch),
                },
                'Mismatch in batch counting - some entries may not have been counted',
              );
              // Fix the count by adding the difference to failed
              const missing = entries.length - (storedCount + totalFailedInBatch);
              progress.failed += missing;
            }
          } else {
            // All entries failed to generate valid embeddings
            progress.failed += entries.length;
            logger.warn(
              {
                batchSize: entries.length,
              },
              'All entries in batch failed to generate valid embeddings',
            );
          }

          processed += entries.length;
          progress.processed = processed;

          logger.debug(`Processed batch: ${processed}/${progress.total} (${progress.succeeded} succeeded, ${progress.failed} failed)`);

          // Update progress
          progressStore.set(progressId, { ...progress });
          if (options.onProgress) {
            options.onProgress({ ...progress });
          }

          // Rate limiting: longer delay between batches to avoid overwhelming OpenAI API
          // Increased from 100ms to 500ms to be more conservative
          await new Promise((resolve) => setTimeout(resolve, 500));
        } catch (error: any) {
          logger.error(
            {
              error: error.message,
              batchSize: entries.length,
              stack: error.stack?.substring(0, 200),
            },
            'Error processing glossary batch',
          );

          // Check if it's a fatal error that should stop the process
          const isQuotaError = error.message?.includes('quota') || 
                              error.message?.includes('billing') || 
                              error.message?.includes('exceeded your current quota');
          const isFatalError = 
            error.message?.includes('API key') || 
            error.message?.includes('Invalid') ||
            error.status === 401 ||
            isQuotaError;

          if (isFatalError) {
            progress.status = 'error';
            progress.error = isQuotaError 
              ? 'OpenAI API quota exceeded. Please check your billing and add credits to your OpenAI account.'
              : error.message;
            progress.completedAt = new Date();
            progressStore.set(progressId, { ...progress });
            if (options.onProgress) {
              options.onProgress({ ...progress });
            }
            logger.error(
              {
                error: progress.error,
                isQuotaError,
              },
              'Fatal error encountered, stopping generation'
            );
            return;
          }

          // For non-fatal errors, mark batch as failed but continue
          progress.failed += entries.length;
          processed += entries.length;
          progress.processed = processed;

          // Continue with next batch even if this one failed
          progressStore.set(progressId, { ...progress });
          if (options.onProgress) {
            options.onProgress({ ...progress });
          }
          
          // Wait a bit longer after errors before continuing
          await new Promise((resolve) => setTimeout(resolve, 1000));
        }

        // Track processed IDs to avoid reprocessing
        entries.forEach(entry => {
          lastProcessedIds.add(entry.id);
          // Limit the size of tracked IDs set
          if (lastProcessedIds.size > MAX_TRACKED_IDS) {
            // Remove oldest IDs (first in set)
            const idsArray = Array.from(lastProcessedIds);
            lastProcessedIds = new Set(idsArray.slice(-MAX_TRACKED_IDS));
          }
        });

        // If we've reached the limit, stop
        if (limit && processed >= limit) {
          break;
        }
      }

      // Final check: verify we actually processed all entries
      const finalRemainingCheck = await prisma.$queryRawUnsafe<Array<{ count: number }>>(
        `SELECT COUNT(*)::int as count FROM "GlossaryEntry" WHERE "sourceEmbedding" IS NULL AND "sourceTerm" != ''${options.projectId ? ` AND "projectId" = $1` : ''}`,
        ...(options.projectId ? [options.projectId] : [])
      );
      const finalRemaining = finalRemainingCheck[0].count;
      
      if (finalRemaining > 0 && processed < progress.total) {
        // There are still entries remaining but we stopped processing
        logger.error(
          {
            processed,
            total: progress.total,
            finalRemaining,
            succeeded: progress.succeeded,
            failed: progress.failed,
          },
          'Generation stopped but entries remain without embeddings!',
        );
        progress.status = 'error';
        progress.error = `Generation stopped prematurely. ${finalRemaining} entries still need embeddings. Processed: ${processed}/${progress.total}`;
      } else {
        // Mark as completed
        progress.status = cancellationFlags.has(progressId) ? 'cancelled' : 'completed';
      }
      
      progress.completedAt = new Date();
      progress.currentEntry = undefined;
      progressStore.set(progressId, { ...progress });

      if (options.onProgress) {
        options.onProgress({ ...progress });
      }

      logger.info(
        {
          processed,
          total: progress.total,
          succeeded: progress.succeeded,
          failed: progress.failed,
          finalRemaining,
          status: progress.status,
        },
        'Glossary embedding generation completed'
      );
    } catch (error: any) {
      logger.error(
        {
          error: error.message,
          stack: error.stack,
        },
        'Glossary embedding generation failed',
      );

      progress.status = 'error';
      progress.error = error.message;
      progress.completedAt = new Date();
      progressStore.set(progressId, { ...progress });

      if (options.onProgress) {
        options.onProgress({ ...progress });
      }
    } finally {
      // Clean up cancellation flag
      cancellationFlags.delete(progressId);
    }
  })();

  return progressId;
}

