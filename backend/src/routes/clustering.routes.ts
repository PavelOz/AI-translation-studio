import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../utils/asyncHandler';
import { requireAuth } from '../utils/authMiddleware';
import { prisma } from '../db/prisma';
import { ApiError } from '../utils/apiError';
import { logger } from '../utils/logger';
import {
  generateDocumentEmbedding,
  assignDocumentToCluster,
  updateClusterSummary,
  findSimilarDocuments,
} from '../services/document-clustering.service';

export const clusteringRoutes = Router();

clusteringRoutes.use(requireAuth);

/**
 * Get all clusters for a project
 */
clusteringRoutes.get(
  '/projects/:projectId/clusters',
  asyncHandler(async (req, res) => {
    const { projectId } = req.params;

    // Get all documents with cluster information
    const documents = await prisma.document.findMany({
      where: { projectId },
      select: {
        id: true,
        name: true,
        summary: true,
        clusterId: true,
        clusterSummary: true,
        embeddingUpdatedAt: true,
        summaryGeneratedAt: true,
        createdAt: true,
      },
      orderBy: { createdAt: 'desc' },
    });

    // Group documents by cluster
    const clustersMap = new Map<string, typeof documents>();
    const unclustered: typeof documents = [];

    documents.forEach((doc) => {
      if (doc.clusterId) {
        if (!clustersMap.has(doc.clusterId)) {
          clustersMap.set(doc.clusterId, []);
        }
        clustersMap.get(doc.clusterId)!.push(doc);
      } else {
        unclustered.push(doc);
      }
    });

    // Convert to array format
    const clusters = Array.from(clustersMap.entries()).map(([clusterId, docs]) => ({
      clusterId,
      documentCount: docs.length,
      documents: docs,
      clusterSummary: docs[0]?.clusterSummary || null,
    }));

    res.json({
      clusters,
      unclustered,
      totalClusters: clusters.length,
      totalUnclustered: unclustered.length,
    });
  }),
);

/**
 * Get cluster details
 */
clusteringRoutes.get(
  '/clusters/:clusterId',
  asyncHandler(async (req, res) => {
    const { clusterId } = req.params;

    const documents = await prisma.document.findMany({
      where: { clusterId },
      select: {
        id: true,
        name: true,
        summary: true,
        clusterSummary: true,
        projectId: true,
        createdAt: true,
        embeddingUpdatedAt: true,
      },
      orderBy: { createdAt: 'asc' },
    });

    if (documents.length === 0) {
      throw ApiError.notFound('Cluster not found');
    }

    res.json({
      clusterId,
      documentCount: documents.length,
      clusterSummary: documents[0]?.clusterSummary || null,
      documents,
    });
  }),
);

/**
 * Get similar documents for a document
 */
clusteringRoutes.get(
  '/documents/:documentId/similar',
  asyncHandler(async (req, res) => {
    const { documentId } = req.params;
    const minSimilarity = req.query.minSimilarity ? parseFloat(req.query.minSimilarity as string) : 0.7;

    const document = await prisma.document.findUnique({
      where: { id: documentId },
      select: {
        id: true,
        projectId: true,
        documentEmbedding: true,
      },
    });

    if (!document) {
      throw ApiError.notFound('Document not found');
    }

    if (!document.documentEmbedding) {
      res.json({
        similarDocuments: [],
        message: 'Document embedding not yet generated',
      });
      return;
    }

    // Parse embedding from database
    const embeddingResult = await prisma.$queryRawUnsafe<Array<{ embedding: string }>>(
      `SELECT "documentEmbedding"::text as embedding FROM "Document" WHERE id = $1`,
      documentId,
    );

    if (embeddingResult.length === 0) {
      res.json({ similarDocuments: [], message: 'Embedding not found' });
      return;
    }

    const embeddingText = embeddingResult[0].embedding;
    const embedding = embeddingText
      .replace(/[\[\]]/g, '')
      .split(',')
      .map((v) => parseFloat(v.trim()));

    const similarDocs = await findSimilarDocuments(embedding, document.projectId, {
      limit: 10,
      minSimilarity,
      excludeDocumentId: documentId,
    });

    res.json({
      documentId,
      similarDocuments: similarDocs,
      minSimilarity,
    });
  }),
);

/**
 * Manually trigger clustering for a document
 */
clusteringRoutes.post(
  '/documents/:documentId/cluster',
  asyncHandler(async (req, res) => {
    const { documentId } = req.params;

    const document = await prisma.document.findUnique({
      where: { id: documentId },
      select: {
        id: true,
        projectId: true,
        name: true,
        clusterId: true,
      },
    });

    if (!document) {
      throw ApiError.notFound('Document not found');
    }

    // Check if embedding exists using raw query (Prisma can't read vector types directly)
    const embeddingCheck = await prisma.$queryRawUnsafe<Array<{ has_embedding: boolean }>>(
      `SELECT "documentEmbedding" IS NOT NULL as has_embedding FROM "Document" WHERE id = $1`,
      documentId,
    );

    const hasEmbedding = embeddingCheck.length > 0 && embeddingCheck[0].has_embedding;

    try {
      // Generate embedding if not exists
      if (!hasEmbedding) {
        logger.info({ documentId }, 'Generating embedding for document...');
        try {
          await generateDocumentEmbedding(documentId);
        } catch (embeddingError: any) {
          logger.error(
            {
              error: embeddingError.message,
              documentId,
            },
            'Failed to generate embedding',
          );
          // Check if it's because document has no segments
          const segments = await prisma.segment.count({
            where: { documentId },
          });
          if (segments === 0) {
            throw ApiError.badRequest(
              'Document has no segments. Please ensure the document was uploaded correctly.',
            );
          }
          throw ApiError.internalServerError(
            `Failed to generate embedding: ${embeddingError.message}`,
          );
        }
      }

      // Verify embedding was generated
      const embeddingCheckAfter = await prisma.$queryRawUnsafe<Array<{ has_embedding: boolean }>>(
        `SELECT "documentEmbedding" IS NOT NULL as has_embedding FROM "Document" WHERE id = $1`,
        documentId,
      );

      const hasEmbeddingAfter = embeddingCheckAfter.length > 0 && embeddingCheckAfter[0].has_embedding;

      if (!hasEmbeddingAfter) {
        throw ApiError.internalServerError(
          'Failed to generate document embedding. Please ensure the document has segments and try again.',
        );
      }

      // Assign to cluster
      logger.info({ documentId }, 'Assigning document to cluster...');
      const clusterId = await assignDocumentToCluster(documentId, document.projectId);

      if (clusterId) {
        // Update cluster summary
        logger.info({ clusterId }, 'Updating cluster summary...');
        try {
          await updateClusterSummary(clusterId, document.projectId);
        } catch (summaryError: any) {
          // Don't fail if cluster summary update fails - it's optional
          logger.warn(
            {
              error: summaryError.message,
              clusterId,
            },
            'Failed to update cluster summary (non-critical)',
          );
        }
      }

      const finalDocument = await prisma.document.findUnique({
        where: { id: documentId },
        select: {
          id: true,
          name: true,
          clusterId: true,
          clusterSummary: true,
        },
      });

      res.json({
        success: true,
        document: finalDocument,
        message: clusterId
          ? `Assigned to cluster ${clusterId}`
          : 'Created new cluster or no similar documents found',
      });
    } catch (error: any) {
      logger.error(
        {
          error: error.message,
          stack: error.stack,
          documentId,
        },
        'Failed to cluster document',
      );
      
      // If it's already an ApiError, re-throw it
      if (error instanceof ApiError || error.status) {
        throw error;
      }
      
      throw ApiError.internalServerError(
        `Failed to cluster document: ${error.message}`,
      );
    }
  }),
);

/**
 * Get clustering statistics for a project
 */
clusteringRoutes.get(
  '/projects/:projectId/stats',
  asyncHandler(async (req, res) => {
    const { projectId } = req.params;

    const stats = await prisma.$queryRawUnsafe<Array<{
      total_documents: bigint;
      documents_with_embeddings: bigint;
      documents_with_summaries: bigint;
      clustered_documents: bigint;
      total_clusters: bigint;
    }>>(
      `
      SELECT 
        COUNT(*)::bigint as total_documents,
        COUNT("documentEmbedding")::bigint as documents_with_embeddings,
        COUNT("summary")::bigint as documents_with_summaries,
        COUNT("clusterId")::bigint as clustered_documents,
        COUNT(DISTINCT "clusterId")::bigint as total_clusters
      FROM "Document"
      WHERE "projectId" = $1
    `,
      projectId,
    );

    const result = stats[0];

    res.json({
      projectId,
      totalDocuments: Number(result.total_documents),
      documentsWithEmbeddings: Number(result.documents_with_embeddings),
      documentsWithSummaries: Number(result.documents_with_summaries),
      clusteredDocuments: Number(result.clustered_documents),
      totalClusters: Number(result.total_clusters),
      clusteringProgress: result.total_documents > 0n
        ? Math.round((Number(result.clustered_documents) / Number(result.total_documents)) * 100)
        : 0,
    });
  }),
);

/**
 * Update cluster summary manually
 */
clusteringRoutes.patch(
  '/clusters/:clusterId/summary',
  asyncHandler(async (req, res) => {
    const { clusterId } = req.params;
    const { summary } = z.object({
      summary: z.string().min(1).max(5000),
    }).parse(req.body);

    // Verify cluster exists and get projectId
    const documents = await prisma.document.findMany({
      where: { clusterId },
      select: { projectId: true },
      take: 1,
    });

    if (documents.length === 0) {
      throw ApiError.notFound('Cluster not found');
    }

    const projectId = documents[0].projectId;

    // Update all documents in cluster with the new summary
    await prisma.document.updateMany({
      where: {
        clusterId,
        projectId,
      },
      data: { clusterSummary: summary },
    });

    logger.info({ clusterId, summaryLength: summary.length }, 'Updated cluster summary manually');

    res.json({
      success: true,
      clusterId,
      summary,
      message: 'Cluster summary updated successfully',
    });
  }),
);

/**
 * Regenerate cluster summary using AI
 */
clusteringRoutes.post(
  '/clusters/:clusterId/regenerate-summary',
  asyncHandler(async (req, res) => {
    const { clusterId } = req.params;

    // Get all documents in cluster
    const documents = await prisma.document.findMany({
      where: { clusterId },
      select: {
        id: true,
        projectId: true,
      },
    });

    if (documents.length === 0) {
      throw ApiError.notFound('Cluster not found');
    }

    const projectId = documents[0].projectId;
    const documentIds = documents.map((d) => d.id);

    // Regenerate summary
    logger.info({ clusterId, documentCount: documentIds.length }, 'Regenerating cluster summary...');
    
    try {
      await updateClusterSummary(clusterId, projectId);
    } catch (error: any) {
      logger.error(
        {
          error: error.message,
          clusterId,
        },
        'Failed to regenerate cluster summary',
      );
      throw ApiError.internalServerError(`Failed to regenerate cluster summary: ${error.message}`);
    }

    // Get updated summary
    const updatedDocument = await prisma.document.findFirst({
      where: { clusterId },
      select: { clusterSummary: true },
    });

    res.json({
      success: true,
      clusterId,
      summary: updatedDocument?.clusterSummary || null,
      message: 'Cluster summary regenerated successfully',
    });
  }),
);

