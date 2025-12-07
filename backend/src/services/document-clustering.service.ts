import { prisma } from '../db/prisma';
import { logger } from '../utils/logger';
import { generateEmbedding } from './embedding.service';
import { getDocumentSegments } from './segment.service';
import { env } from '../utils/env';
import OpenAI from 'openai';

const openai = new OpenAI({
  apiKey: env.openAiApiKey || undefined,
});

const EMBEDDING_MODEL = 'text-embedding-3-small';
const EMBEDDING_DIMENSIONS = 1536;
const MAX_TEXT_LENGTH = 8000; // Limit text for embedding generation

/**
 * Generate document embedding from all segments
 */
export async function generateDocumentEmbedding(documentId: string): Promise<number[]> {
  try {
    const segments = await getDocumentSegments(documentId, 1, 10000);
    
    if (!segments.segments || segments.segments.length === 0) {
      throw new Error(`No segments found for document ${documentId}`);
    }

    // Combine all segment texts
    const combinedText = segments.segments
      .map((s) => s.sourceText)
      .join('\n')
      .substring(0, MAX_TEXT_LENGTH);

    if (!combinedText.trim()) {
      throw new Error(`No text content found in document ${documentId}`);
    }

    logger.info(
      { documentId, textLength: combinedText.length, segmentCount: segments.segments.length },
      'Generating document embedding...',
    );
    
    const embedding = await generateEmbedding(combinedText, true);
    
    // Store embedding in database
    await storeDocumentEmbedding(documentId, embedding);
    
    logger.info({ documentId }, '✅ Document embedding generated and stored');
    
    return embedding;
  } catch (error: any) {
    logger.error(
      {
        documentId,
        error: error.message,
      },
      'Failed to generate document embedding',
    );
    throw error;
  }
}

/**
 * Store document embedding in database
 */
async function storeDocumentEmbedding(documentId: string, embedding: number[]): Promise<void> {
  if (!embedding || embedding.length !== EMBEDDING_DIMENSIONS) {
    throw new Error(`Invalid embedding: must be ${EMBEDDING_DIMENSIONS} dimensions`);
  }

  const embeddingStr = `[${embedding.join(',')}]`;

  try {
    await prisma.$executeRawUnsafe(
      `
      UPDATE "Document"
      SET 
        "documentEmbedding" = $1::vector,
        "embeddingModel" = $2,
        "embeddingUpdatedAt" = NOW()
      WHERE "id" = $3
    `,
      embeddingStr,
      EMBEDDING_MODEL,
      documentId,
    );

    logger.debug(`Stored document embedding for document: ${documentId}`);
  } catch (error: any) {
    logger.error(
      {
        error: error.message,
        documentId,
      },
      'Failed to store document embedding',
    );

    if (error.message?.includes('type "vector" does not exist')) {
      throw new Error(
        'pgvector extension not installed. Please run: CREATE EXTENSION IF NOT EXISTS vector;',
      );
    }

    throw new Error(`Failed to store document embedding: ${error.message}`);
  }
}

/**
 * Find similar documents using vector similarity
 */
export async function findSimilarDocuments(
  documentEmbedding: number[],
  projectId: string,
  options: {
    limit?: number;
    minSimilarity?: number;
    excludeDocumentId?: string;
  } = {},
): Promise<Array<{ documentId: string; similarity: number; name: string }>> {
  if (!documentEmbedding || documentEmbedding.length !== EMBEDDING_DIMENSIONS) {
    throw new Error(`Invalid embedding: must be ${EMBEDDING_DIMENSIONS} dimensions`);
  }

  const limit = options.limit || 10;
  const minSimilarity = options.minSimilarity ?? 0.7; // Default 70% similarity
  const embeddingStr = `[${documentEmbedding.join(',')}]`;

  try {
    let whereClause = `
      "documentEmbedding" IS NOT NULL 
      AND "projectId" = $${1}
    `;
    const params: any[] = [projectId];
    let paramIndex = 2;

    if (options.excludeDocumentId) {
      whereClause += ` AND "id" != $${paramIndex}`;
      params.push(options.excludeDocumentId);
      paramIndex += 1;
    }

    const query = `
      SELECT 
        id,
        name,
        1 - ("documentEmbedding" <=> $${paramIndex}::vector) as similarity
      FROM "Document"
      WHERE ${whereClause}
        AND (1 - ("documentEmbedding" <=> $${paramIndex}::vector)) >= $${paramIndex + 1}
      ORDER BY "documentEmbedding" <=> $${paramIndex}::vector
      LIMIT $${paramIndex + 2}::int
    `;
    params.push(embeddingStr, minSimilarity, limit);

    const results = await prisma.$queryRawUnsafe<Array<{ id: string; name: string; similarity: number }>>(
      query,
      ...params,
    );

    logger.debug(`Found ${results.length} similar documents for project ${projectId}`);

    return results.map((r) => ({
      documentId: r.id,
      similarity: Number(r.similarity),
      name: r.name,
    }));
  } catch (error: any) {
    logger.error(
      {
        error: error.message,
        projectId,
      },
      'Failed to find similar documents',
    );
    throw new Error(`Failed to find similar documents: ${error.message}`);
  }
}

/**
 * Generate document summary using AI
 */
export async function generateDocumentSummary(
  segments: Array<{ sourceText: string }>,
  sourceLocale: string,
): Promise<string> {
  if (!env.openAiApiKey) {
    logger.warn('OPENAI_API_KEY not configured, skipping document summary generation');
    return '';
  }

  try {
    // Sample segments: first 5, middle 5, last 5
    const totalSegments = segments.length;
    const sampleSize = Math.min(15, totalSegments);
    const sampleIndices = new Set<number>();

    // Add first segments
    for (let i = 0; i < Math.min(5, totalSegments); i++) {
      sampleIndices.add(i);
    }

    // Add middle segments
    if (totalSegments > 10) {
      const middleStart = Math.floor(totalSegments / 2) - 2;
      for (let i = middleStart; i < middleStart + 5 && i < totalSegments; i++) {
        sampleIndices.add(i);
      }
    }

    // Add last segments
    for (let i = Math.max(0, totalSegments - 5); i < totalSegments; i++) {
      sampleIndices.add(i);
    }

    const sampleSegments = Array.from(sampleIndices)
      .sort((a, b) => a - b)
      .map((idx) => segments[idx])
      .slice(0, sampleSize);

    const sampleText = sampleSegments
      .map((s) => s.sourceText)
      .join('\n\n')
      .substring(0, 4000); // Limit to avoid token limits

    const prompt = `Analyze this document sample and create a concise summary (2-3 sentences) describing:
- Document type/category (e.g., contract, report, specification)
- Main subject/topic
- Key characteristics or purpose

Document sample:
${sampleText}

Summary:`;

    const response = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        {
          role: 'system',
          content: 'You are a document analysis assistant. Create concise, informative summaries.',
        },
        {
          role: 'user',
          content: prompt,
        },
      ],
      temperature: 0.3,
      max_tokens: 200,
    });

    const summary = response.choices[0]?.message?.content?.trim() || '';
    
    logger.debug(`Generated document summary (${summary.length} chars)`);
    
    return summary;
  } catch (error: any) {
    logger.error(
      {
        error: error.message,
        segmentCount: segments.length,
      },
      'Failed to generate document summary',
    );
    // Don't throw - summary generation is optional
    return '';
  }
}

/**
 * Generate cluster summary using AI
 */
export async function generateClusterSummary(
  documentIds: string[],
  projectId: string,
): Promise<string> {
  if (!env.openAiApiKey) {
    logger.warn('OPENAI_API_KEY not configured, skipping cluster summary generation');
    return '';
  }

  if (documentIds.length === 0) {
    return '';
  }

  try {
    // Get sample segments from all documents in cluster
    const allSamples: Array<{ text: string; documentName: string }> = [];

    for (const docId of documentIds.slice(0, 5)) {
      // Limit to 5 documents to avoid token limits
      const segments = await getDocumentSegments(docId, 1, 100);
      const document = await prisma.document.findUnique({
        where: { id: docId },
        select: { name: true },
      });

      if (segments.segments && segments.segments.length > 0) {
        // Sample first 3 segments from each document
        const sample = segments.segments.slice(0, 3).map((s) => s.sourceText).join('\n');
        allSamples.push({
          text: sample,
          documentName: document?.name || 'Unknown',
        });
      }
    }

    const combinedSamples = allSamples
      .map((s) => `Document: ${s.documentName}\n${s.text}`)
      .join('\n\n---\n\n')
      .substring(0, 4000);

    // Fetch project glossary entries to provide context
    const glossaryEntries = await prisma.glossaryEntry.findMany({
      where: {
        projectId,
        status: 'PREFERRED',
      },
      select: {
        sourceTerm: true,
        targetTerm: true,
        sourceLocale: true,
        targetLocale: true,
        notes: true,
      },
      take: 50, // Limit to top 50 entries to avoid token limits
    });

    // Build glossary context string
    let glossaryContext = '';
    if (glossaryEntries.length > 0) {
      const glossaryList = glossaryEntries
        .map((entry) => {
          const notes = entry.notes ? ` (${entry.notes})` : '';
          return `- ${entry.sourceTerm} → ${entry.targetTerm}${notes}`;
        })
        .join('\n');
      glossaryContext = `\n\nImportant Terminology (from project glossary):\n${glossaryList}\n\nPay special attention to these terms and their correct translations when analyzing the documents.`;
    }

    const prompt = `Analyze these similar documents and create a structured summary describing:
- Common document type/category
- Shared terminology patterns
- Typical translation style characteristics
- Key domain concepts
- Common structure/format patterns

Document samples:
${combinedSamples}${glossaryContext}

Structured summary:`;

    const response = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        {
          role: 'system',
          content: 'You are a document analysis assistant. Create structured summaries that help translators understand document patterns. Pay special attention to domain-specific terminology and abbreviations.',
        },
        {
          role: 'user',
          content: prompt,
        },
      ],
      temperature: 0.3,
      max_tokens: 500, // Increased from 300 to allow more detailed summaries
    });

    const summary = response.choices[0]?.message?.content?.trim() || '';
    
    logger.debug(`Generated cluster summary for ${documentIds.length} documents (${summary.length} chars)`);
    
    return summary;
  } catch (error: any) {
    logger.error(
      {
        error: error.message,
        documentCount: documentIds.length,
      },
      'Failed to generate cluster summary',
    );
    // Don't throw - cluster summary generation is optional
    return '';
  }
}

/**
 * Simple clustering: assign document to cluster based on similarity
 * If similar documents exist, assign to their cluster
 * Otherwise, create new cluster
 */
export async function assignDocumentToCluster(
  documentId: string,
  projectId: string,
  minSimilarity: number = 0.75,
): Promise<string | null> {
  try {
    // Check if document exists and get clusterId (can't select documentEmbedding directly)
    const document = await prisma.document.findUnique({
      where: { id: documentId },
      select: {
        clusterId: true,
      },
    });

    if (!document) {
      logger.warn({ documentId }, 'Document not found');
      return null;
    }

    // If already has cluster, keep it
    if (document.clusterId) {
      logger.debug({ documentId, clusterId: document.clusterId }, 'Document already has cluster');
      return document.clusterId;
    }

    // Check if embedding exists using raw query (Prisma can't read vector types directly)
    const embeddingCheck = await prisma.$queryRawUnsafe<Array<{ has_embedding: boolean }>>(
      `SELECT "documentEmbedding" IS NOT NULL as has_embedding FROM "Document" WHERE id = $1`,
      documentId,
    );

    if (embeddingCheck.length === 0 || !embeddingCheck[0].has_embedding) {
      logger.debug({ documentId }, 'Document has no embedding, skipping cluster assignment');
      return null;
    }

    // Find similar documents
    const embeddingResult = await prisma.$queryRawUnsafe<Array<{ embedding: string }>>(
      `SELECT "documentEmbedding"::text as embedding FROM "Document" WHERE id = $1`,
      documentId,
    );

    if (embeddingResult.length === 0) {
      return null;
    }

    // Parse embedding from text format
    const embeddingText = embeddingResult[0].embedding;
    if (!embeddingText || embeddingText === 'null' || embeddingText.trim() === '') {
      logger.warn({ documentId }, 'Embedding text is empty or null');
      return null;
    }

    const embedding = embeddingText
      .replace(/[\[\]]/g, '')
      .split(',')
      .map((v) => parseFloat(v.trim()))
      .filter((v) => !isNaN(v));

    if (embedding.length !== EMBEDDING_DIMENSIONS) {
      logger.error(
        {
          documentId,
          embeddingLength: embedding.length,
          expectedLength: EMBEDDING_DIMENSIONS,
        },
        'Invalid embedding dimensions',
      );
      return null;
    }

    logger.info(
      { documentId, minSimilarity },
      'Searching for similar documents...',
    );

    const similarDocs = await findSimilarDocuments(embedding, projectId, {
      limit: 5,
      minSimilarity,
      excludeDocumentId: documentId,
    });

    logger.info(
      { documentId, similarCount: similarDocs.length },
      `Found ${similarDocs.length} similar document(s)`,
    );

    if (similarDocs.length > 0) {
      // Find cluster of most similar document
      const mostSimilar = similarDocs[0];
      logger.info(
        {
          documentId,
          similarDocumentId: mostSimilar.documentId,
          similarity: Math.round(mostSimilar.similarity * 100),
        },
        `Most similar document: ${mostSimilar.name} (${Math.round(mostSimilar.similarity * 100)}% similar)`,
      );

      const similarDoc = await prisma.document.findUnique({
        where: { id: mostSimilar.documentId },
        select: { clusterId: true },
      });

      if (similarDoc?.clusterId) {
        // Assign to existing cluster
        await prisma.document.update({
          where: { id: documentId },
          data: { clusterId: similarDoc.clusterId },
        });

        logger.info(
          { documentId, clusterId: similarDoc.clusterId, clusterSize: similarDocs.length + 1 },
          `✅ Assigned to existing cluster (${similarDocs.length + 1} documents)`,
        );
        return similarDoc.clusterId;
      } else {
        // Create new cluster with both documents
        const clusterId = `cluster_${Date.now()}_${Math.random().toString(36).substring(7)}`;
        await prisma.document.updateMany({
          where: {
            id: { in: [documentId, mostSimilar.documentId] },
          },
          data: { clusterId },
        });

        logger.info(
          { clusterId, documentIds: [documentId, mostSimilar.documentId] },
          `✅ Created new cluster with 2 documents`,
        );
        return clusterId;
      }
    }

    // No similar documents found - create new cluster
    const clusterId = `cluster_${Date.now()}_${Math.random().toString(36).substring(7)}`;
    await prisma.document.update({
      where: { id: documentId },
      data: { clusterId },
    });

    logger.info(
      { documentId, clusterId },
      `✅ Created new cluster (no similar documents found)`,
    );
    return clusterId;
  } catch (error: any) {
    logger.error(
      {
        error: error.message,
        documentId,
      },
      'Failed to assign document to cluster',
    );
    return null;
  }
}

/**
 * Update cluster summary for a cluster
 */
export async function updateClusterSummary(clusterId: string, projectId: string): Promise<void> {
  try {
    // Get all documents in cluster
    const documents = await prisma.document.findMany({
      where: {
        clusterId,
        projectId,
      },
      select: { id: true },
    });

    if (documents.length === 0) {
      return;
    }

    const documentIds = documents.map((d) => d.id);
    const clusterSummary = await generateClusterSummary(documentIds, projectId);

    if (clusterSummary) {
      // Update all documents in cluster with the summary
      await prisma.document.updateMany({
        where: {
          clusterId,
          projectId,
        },
        data: { clusterSummary },
      });

      logger.debug(`Updated cluster summary for cluster ${clusterId} (${documents.length} documents)`);
    }
  } catch (error: any) {
    logger.error(
      {
        error: error.message,
        clusterId,
      },
      'Failed to update cluster summary',
    );
  }
}

