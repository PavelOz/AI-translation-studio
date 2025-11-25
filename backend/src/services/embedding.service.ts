import OpenAI from 'openai';
import { env } from '../utils/env';
import { logger } from '../utils/logger';

// Initialize OpenAI client
const openai = new OpenAI({
  apiKey: env.openAiApiKey || undefined,
});

// Embedding model configuration
const EMBEDDING_MODEL = 'text-embedding-3-small';
const EMBEDDING_DIMENSIONS = 1536;

// Cache for embeddings (in-memory, keyed by text)
// In production, consider using Redis for distributed caching
const embeddingCache = new Map<string, { embedding: number[]; timestamp: number }>();
const CACHE_TTL = 7 * 24 * 60 * 60 * 1000; // 7 days
const MAX_CACHE_SIZE = 10000; // Max 10,000 cached embeddings

/**
 * Generate a single embedding for text
 * @param text - Text to generate embedding for
 * @param useCache - Whether to use cache (default: true)
 * @returns Embedding vector (1536 dimensions)
 */
export async function generateEmbedding(
  text: string,
  useCache = true,
): Promise<number[]> {
  if (!text || !text.trim()) {
    throw new Error('Text cannot be empty');
  }

  const normalizedText = text.trim().toLowerCase();

  // Check cache first
  if (useCache) {
    const cached = embeddingCache.get(normalizedText);
    if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
      logger.debug(`Cache hit for embedding: ${normalizedText.substring(0, 50)}...`);
      return cached.embedding;
    }
  }

  // Validate API key
  if (!env.openAiApiKey || env.openAiApiKey.trim() === '') {
    throw new Error('OPENAI_API_KEY is not configured');
  }

  try {
    logger.debug(`Generating embedding for text: ${normalizedText.substring(0, 50)}...`);

    const response = await openai.embeddings.create({
      model: EMBEDDING_MODEL,
      input: normalizedText,
    });

    const embedding = response.data[0].embedding;

    // Validate embedding dimensions
    if (embedding.length !== EMBEDDING_DIMENSIONS) {
      throw new Error(
        `Unexpected embedding dimensions: expected ${EMBEDDING_DIMENSIONS}, got ${embedding.length}`,
      );
    }

    // Cache the embedding
    if (useCache) {
      // Evict oldest entries if cache is full
      if (embeddingCache.size >= MAX_CACHE_SIZE) {
        const oldestKey = embeddingCache.keys().next().value;
        if (oldestKey) {
          embeddingCache.delete(oldestKey);
        }
      }
      embeddingCache.set(normalizedText, {
        embedding,
        timestamp: Date.now(),
      });
    }

    return embedding;
  } catch (error: any) {
    logger.error(
      {
        error: error.message,
        text: normalizedText.substring(0, 100),
      },
      'Failed to generate embedding',
    );

    // Handle specific OpenAI API errors
    if (error.status === 401) {
      throw new Error('Invalid OpenAI API key. Please check your OPENAI_API_KEY.');
    }
    if (error.status === 429) {
      throw new Error('OpenAI API rate limit exceeded. Please try again later.');
    }
    if (error.status === 500) {
      throw new Error('OpenAI API server error. Please try again later.');
    }

    throw new Error(`Failed to generate embedding: ${error.message}`);
  }
}

/**
 * Generate embeddings for multiple texts in a single batch
 * More efficient than calling generateEmbedding multiple times
 * @param texts - Array of texts to generate embeddings for
 * @param useCache - Whether to use cache (default: true)
 * @returns Array of embedding vectors
 */
export async function generateEmbeddingsBatch(
  texts: string[],
  useCache = true,
): Promise<number[][]> {
  if (!texts || texts.length === 0) {
    return [];
  }

  // Validate API key
  if (!env.openAiApiKey || env.openAiApiKey.trim() === '') {
    throw new Error('OPENAI_API_KEY is not configured');
  }

  // Filter out empty texts and check cache
  const validTexts: string[] = [];
  const cachedEmbeddings: Map<number, number[]> = new Map();
  const textToIndex: Map<string, number[]> = new Map();

  texts.forEach((text, index) => {
    if (!text || !text.trim()) {
      return; // Skip empty texts
    }

    const normalizedText = text.trim().toLowerCase();

    // Check cache
    if (useCache) {
      const cached = embeddingCache.get(normalizedText);
      if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
        // Store cached embedding with original index
        if (!textToIndex.has(normalizedText)) {
          textToIndex.set(normalizedText, []);
        }
        textToIndex.get(normalizedText)!.push(index);
        cachedEmbeddings.set(index, cached.embedding);
        return;
      }
    }

    // Track texts that need embedding generation
    validTexts.push(normalizedText);
    if (!textToIndex.has(normalizedText)) {
      textToIndex.set(normalizedText, []);
    }
    textToIndex.get(normalizedText)!.push(index);
  });

  // If all texts were cached, return cached results
  if (validTexts.length === 0) {
    const results: number[][] = new Array(texts.length);
    cachedEmbeddings.forEach((embedding, index) => {
      results[index] = embedding;
    });
    return results;
  }

  try {
    logger.debug(`Generating embeddings batch: ${validTexts.length} texts`);

    const response = await openai.embeddings.create({
      model: EMBEDDING_MODEL,
      input: validTexts,
    });

    // Map responses back to original indices
    const results: number[][] = new Array(texts.length);
    const generatedEmbeddings: Map<string, number[]> = new Map();

    response.data.forEach((item, responseIndex) => {
      const text = validTexts[responseIndex];
      const embedding = item.embedding;

      // Validate dimensions
      if (embedding.length !== EMBEDDING_DIMENSIONS) {
        throw new Error(
          `Unexpected embedding dimensions: expected ${EMBEDDING_DIMENSIONS}, got ${embedding.length}`,
        );
      }

      // Cache the embedding
      if (useCache) {
        if (embeddingCache.size >= MAX_CACHE_SIZE) {
          const oldestKey = embeddingCache.keys().next().value;
          if (oldestKey) {
            embeddingCache.delete(oldestKey);
          }
        }
        embeddingCache.set(text, {
          embedding,
          timestamp: Date.now(),
        });
      }

      generatedEmbeddings.set(text, embedding);

      // Assign to all indices that have this text
      const indices = textToIndex.get(text) || [];
      indices.forEach((originalIndex) => {
        results[originalIndex] = embedding;
      });
    });

    // Fill in cached embeddings
    cachedEmbeddings.forEach((embedding, index) => {
      if (!results[index]) {
        results[index] = embedding;
      }
    });

    return results;
  } catch (error: any) {
    logger.error(
      {
        error: error.message,
        batchSize: validTexts.length,
      },
      'Failed to generate embeddings batch',
    );

    // Handle specific OpenAI API errors
    if (error.status === 401) {
      throw new Error('Invalid OpenAI API key. Please check your OPENAI_API_KEY.');
    }
    if (error.status === 429) {
      throw new Error('OpenAI API rate limit exceeded. Please try again later.');
    }
    if (error.status === 500) {
      throw new Error('OpenAI API server error. Please try again later.');
    }

    throw new Error(`Failed to generate embeddings batch: ${error.message}`);
  }
}

/**
 * Clear the embedding cache
 * Useful for testing or memory management
 */
export function clearEmbeddingCache(): void {
  embeddingCache.clear();
  logger.debug('Embedding cache cleared');
}

/**
 * Get cache statistics
 */
export function getCacheStats(): { size: number; maxSize: number } {
  return {
    size: embeddingCache.size,
    maxSize: MAX_CACHE_SIZE,
  };
}

/**
 * Get embedding model information
 */
export function getEmbeddingModelInfo(): {
  model: string;
  dimensions: number;
} {
  return {
    model: EMBEDDING_MODEL,
    dimensions: EMBEDDING_DIMENSIONS,
  };
}

