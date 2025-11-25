import { prisma } from '../db/prisma';
import { logger } from '../utils/logger';
import type { TranslationMemoryEntry } from '@prisma/client';

/**
 * Convert embedding array to PostgreSQL vector format string
 */
function embeddingToVectorString(embedding: number[]): string {
  return `[${embedding.join(',')}]`;
}

/**
 * Search Translation Memory using vector similarity
 * @param queryEmbedding - The embedding vector to search for
 * @param options - Search options
 * @returns Array of TM entries with similarity scores
 */
export async function searchByVector(
  queryEmbedding: number[],
  options: {
    projectId?: string;
    sourceLocale?: string;
    targetLocale?: string;
    limit?: number;
    minSimilarity?: number; // Cosine similarity threshold (0-1)
  },
): Promise<Array<TranslationMemoryEntry & { similarity: number }>> {
  if (!queryEmbedding || queryEmbedding.length !== 1536) {
    throw new Error('Invalid embedding: must be 1536 dimensions');
  }

  const limit = options.limit || 10;
  const minSimilarity = options.minSimilarity ?? 0.7; // Default 70% similarity
  const embeddingStr = embeddingToVectorString(queryEmbedding);

  try {
    // Build WHERE clause dynamically
    // Parameters: $1 = embedding, $2 = minSimilarity, $3 = limit
    const whereConditions: string[] = ['"sourceEmbedding" IS NOT NULL'];
    const params: any[] = [];

    // Add base parameters first
    params.push(embeddingStr); // $1 - vector embedding string
    params.push(Number(minSimilarity)); // $2 - minSimilarity as number
    params.push(Number(limit)); // $3 - limit as integer

    let paramIndex = 4; // Start after $1, $2, $3

    if (options.projectId) {
      // Include both project-specific and global (null projectId) entries
      // Cast both column and parameter to text to avoid type mismatch
      // PostgreSQL UUID columns need explicit casting when comparing with text parameters
      whereConditions.push(`("projectId"::text = $${paramIndex}::text OR "projectId" IS NULL)`);
      params.push(String(options.projectId));
      paramIndex += 1;
    }

    if (options.sourceLocale && options.sourceLocale !== '*') {
      // More flexible locale matching: match exact or prefix (e.g., "ru" matches "ru-RU")
      const sourceLocaleParam = String(options.sourceLocale);
      whereConditions.push(`(
        LOWER("sourceLocale"::text) = LOWER($${paramIndex}::text) 
        OR LOWER("sourceLocale"::text) LIKE LOWER($${paramIndex}::text || '-%')
        OR LOWER($${paramIndex}::text) LIKE LOWER("sourceLocale"::text || '-%')
      )`);
      params.push(sourceLocaleParam);
      paramIndex += 1;
    }

    if (options.targetLocale && options.targetLocale !== '*') {
      // More flexible locale matching: match exact or prefix (e.g., "en" matches "en-GB")
      const targetLocaleParam = String(options.targetLocale);
      whereConditions.push(`(
        LOWER("targetLocale"::text) = LOWER($${paramIndex}::text) 
        OR LOWER("targetLocale"::text) LIKE LOWER($${paramIndex}::text || '-%')
        OR LOWER($${paramIndex}::text) LIKE LOWER("targetLocale"::text || '-%')
      )`);
      params.push(targetLocaleParam);
      paramIndex += 1;
    }

    const whereClause = whereConditions.join(' AND ');

    // Use cosine distance (1 - cosine similarity)
    // Lower distance = higher similarity
    // We calculate similarity as: 1 - (sourceEmbedding <=> $1::vector)
    // Note: PostgreSQL column names are case-sensitive when quoted
    // Parameters: $1 = embedding, $2 = minSimilarity, $3 = limit, $4+ = optional filters
    // Note: Don't select sourceEmbedding directly - Prisma can't deserialize vector type
    const query = `
      SELECT 
        id,
        "projectId",
        "tmxFileId",
        "createdById",
        "sourceLocale",
        "targetLocale",
        "sourceText",
        "targetText",
        "clientName",
        "domain",
        "matchRate",
        "usageCount",
        "createdAt",
        "embeddingModel",
        "embeddingVersion",
        "embeddingUpdatedAt",
        1 - ("sourceEmbedding" <=> $1::vector) as similarity
      FROM "TranslationMemoryEntry"
      WHERE ${whereClause}
        AND (1 - ("sourceEmbedding" <=> $1::vector)) >= $2
      ORDER BY "sourceEmbedding" <=> $1::vector
      LIMIT $3::int
    `;

    logger.debug(
      {
        limit,
        minSimilarity,
        projectId: options.projectId,
        locales: `${options.sourceLocale}->${options.targetLocale}`,
        whereClause,
        paramCount: params.length,
        params: params.map((p, i) => ({ index: i + 1, type: typeof p, value: typeof p === 'string' ? p.substring(0, 50) : p })),
      },
      'Executing vector search',
    );

    const results = await prisma.$queryRawUnsafe<Array<TranslationMemoryEntry & { similarity: number }>>(
      query,
      ...params,
    );

    logger.debug(`Vector search returned ${results.length} results`);

    return results;
  } catch (error: any) {
    logger.error(
      {
        error: error.message,
        stack: error.stack,
      },
      'Vector search failed',
    );

    // Check if pgvector extension is available
    if (error.message?.includes('operator does not exist') || error.message?.includes('<=>')) {
      throw new Error(
        'pgvector extension not properly installed or vector type not available. Please ensure pgvector is installed.',
      );
    }

    throw new Error(`Vector search failed: ${error.message}`);
  }
}

/**
 * Store embedding for a TranslationMemoryEntry
 * @param entryId - The TM entry ID
 * @param embedding - The embedding vector (1536 dimensions)
 * @param model - The embedding model used (e.g., "text-embedding-3-small")
 */
export async function storeEmbedding(
  entryId: string,
  embedding: number[],
  model: string = 'text-embedding-3-small',
): Promise<void> {
  if (!embedding || embedding.length !== 1536) {
    throw new Error('Invalid embedding: must be 1536 dimensions');
  }

  const embeddingStr = embeddingToVectorString(embedding);
  const version = '1.0'; // Track version for future migrations

  try {
    await prisma.$executeRawUnsafe(
      `
      UPDATE "TranslationMemoryEntry"
      SET 
        "sourceEmbedding" = $1::vector,
        "embeddingModel" = $2,
        "embeddingVersion" = $3,
        "embeddingUpdatedAt" = NOW()
      WHERE "id" = $4
    `,
      embeddingStr,
      model,
      version,
      entryId,
    );

    logger.debug(`Stored embedding for TM entry: ${entryId}`);
  } catch (error: any) {
    logger.error(
      {
        error: error.message,
        entryId,
      },
      'Failed to store embedding',
    );

    if (error.message?.includes('type "vector" does not exist')) {
      throw new Error(
        'pgvector extension not installed. Please run: CREATE EXTENSION IF NOT EXISTS vector;',
      );
    }

    throw new Error(`Failed to store embedding: ${error.message}`);
  }
}

/**
 * Store embeddings for multiple entries in batch
 * More efficient than calling storeEmbedding multiple times
 */
export async function storeEmbeddingsBatch(
  entries: Array<{ entryId: string; embedding: number[]; model?: string }>,
): Promise<void> {
  if (entries.length === 0) {
    return;
  }

  const model = entries[0].model || 'text-embedding-3-small';
  const version = '1.0';

  try {
    // Use a transaction for batch updates
    await prisma.$transaction(async (tx) => {
      for (const { entryId, embedding } of entries) {
        if (!embedding || embedding.length !== 1536) {
          logger.warn(`Skipping invalid embedding for entry ${entryId}`);
          continue;
        }

        const embeddingStr = embeddingToVectorString(embedding);

        await tx.$executeRawUnsafe(
          `
          UPDATE "TranslationMemoryEntry"
          SET 
            "sourceEmbedding" = $1::vector,
            "embeddingModel" = $2,
            "embeddingVersion" = $3,
            "embeddingUpdatedAt" = NOW()
          WHERE "id" = $4
        `,
          embeddingStr,
          model,
          version,
          entryId,
        );
      }
    });

    logger.debug(`Stored ${entries.length} embeddings in batch`);
  } catch (error: any) {
    logger.error(
      {
        error: error.message,
        batchSize: entries.length,
      },
      'Failed to store embeddings batch',
    );

    if (error.message?.includes('type "vector" does not exist')) {
      throw new Error(
        'pgvector extension not installed. Please run: CREATE EXTENSION IF NOT EXISTS vector;',
      );
    }

    throw new Error(`Failed to store embeddings batch: ${error.message}`);
  }
}

/**
 * Check if an entry has an embedding
 */
export async function hasEmbedding(entryId: string): Promise<boolean> {
  const result = await prisma.$queryRawUnsafe<Array<{ has_embedding: boolean }>>(
    `
    SELECT "sourceEmbedding" IS NOT NULL as has_embedding
    FROM "TranslationMemoryEntry"
    WHERE "id" = $1
  `,
    entryId,
  );

  return result[0]?.has_embedding ?? false;
}

/**
 * Get embedding statistics for a project or globally
 */
export async function getEmbeddingStats(options?: { projectId?: string }): Promise<{
  total: number;
  withEmbedding: number;
  withoutEmbedding: number;
  coverage: number; // Percentage with embeddings
}> {
  let query = `
    SELECT 
      COUNT(*) as total,
      COUNT("sourceEmbedding") as with_embedding,
      COUNT(*) - COUNT("sourceEmbedding") as without_embedding
    FROM "TranslationMemoryEntry"
  `;

  const params: any[] = [];

  if (options?.projectId) {
    query += ` WHERE "projectId" = $1`;
    params.push(options.projectId);
  }

  const result = await prisma.$queryRawUnsafe<Array<{
    total: bigint;
    with_embedding: bigint;
    without_embedding: bigint;
  }>>(query, ...params);

  const stats = result[0];
  const total = Number(stats.total);
  const withEmbedding = Number(stats.with_embedding);
  const withoutEmbedding = Number(stats.without_embedding);
  const coverage = total > 0 ? (withEmbedding / total) * 100 : 0;

  return {
    total,
    withEmbedding,
    withoutEmbedding,
    coverage: Math.round(coverage * 100) / 100, // Round to 2 decimal places
  };
}

