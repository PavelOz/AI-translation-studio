import { prisma } from '../db/prisma';
import { logger } from '../utils/logger';
import { generateEmbedding, generateEmbeddingsBatch } from './embedding.service';
import { storeEmbedding, storeEmbeddingsBatch, getEmbeddingStats } from './vector-search.service';
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

      logger.info(`Starting embedding generation for ${progress.total} entries`);

      let processed = 0;
      let offset = 0;

      while (processed < progress.total && !cancellationFlags.has(progressId)) {
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

        // Fetch batch of entries without embeddings using raw query
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

        fetchQuery += ` ORDER BY "createdAt" DESC LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`;
        fetchParams.push(batchSize, offset);

        const entriesResult = await prisma.$queryRawUnsafe<Array<{
          id: string;
          sourceText: string;
          sourceLocale: string;
          targetLocale: string;
        }>>(fetchQuery, ...fetchParams);

        const entries = entriesResult;

        if (entries.length === 0) {
          break;
        }

        // Update current entry
        progress.currentEntry = {
          id: entries[0].id,
          sourceText: entries[0].sourceText.substring(0, 50) + '...',
        };

        try {
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
            progress.succeeded += embeddingEntries.length;
          }

          // Count failed (entries without valid embeddings)
          const failedCount = entries.length - embeddingEntries.length;
          progress.failed += failedCount;

          processed += entries.length;
          progress.processed = processed;

          logger.debug(`Processed batch: ${processed}/${progress.total} (${progress.succeeded} succeeded, ${progress.failed} failed)`);

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
            },
            'Error processing batch',
          );

          progress.failed += entries.length;
          processed += entries.length;
          progress.processed = processed;

          // Continue with next batch even if this one failed
          progressStore.set(progressId, { ...progress });
          if (options.onProgress) {
            options.onProgress({ ...progress });
          }
        }

        offset += batchSize;

        // If we've reached the limit, stop
        if (limit && processed >= limit) {
          break;
        }
      }

      // Mark as completed
      progress.status = cancellationFlags.has(progressId) ? 'cancelled' : 'completed';
      progress.completedAt = new Date();
      progress.currentEntry = undefined;
      progressStore.set(progressId, { ...progress });

      if (options.onProgress) {
        options.onProgress({ ...progress });
      }

      logger.info(`Embedding generation completed: ${progress.succeeded} succeeded, ${progress.failed} failed`);
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

