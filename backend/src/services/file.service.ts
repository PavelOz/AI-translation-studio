import fs from 'fs/promises';
import path from 'path';
import type { Express } from 'express';
import type { DocumentFileType } from '@prisma/client';
import { resolveHandler } from '../utils/file-handlers';
import { ApiError } from '../utils/apiError';
import { env } from '../utils/env';
import { logger } from '../utils/logger';
import { prisma } from '../db/prisma';
import { createDocument, getDocument } from './document.service';
import { bulkUpsertSegments, getDocumentSegments } from './segment.service';
import {
  generateDocumentEmbedding,
  generateDocumentSummary,
  assignDocumentToCluster,
  updateClusterSummary,
} from './document-clustering.service';

export type ImportDocumentInput = {
  projectId: string;
  sourceLocale: string;
  targetLocale: string;
};

export const importDocumentFile = async (
  file: Express.Multer.File,
  input: ImportDocumentInput,
) => {
  if (!file) {
    throw ApiError.badRequest('File is required');
  }

  const handler = resolveHandler(file.originalname, file.mimetype);
  if (!handler) {
    throw ApiError.badRequest('Unsupported file format');
  }

  let parsed;
  try {
    parsed = await handler.parse(file.buffer);
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logger.error({ error: errorMessage, filename: file.originalname }, 'Failed to parse document file');
    throw ApiError.badRequest(`Failed to parse document: ${errorMessage}`);
  }
  
  if (!parsed.segments || parsed.segments.length === 0) {
    throw ApiError.badRequest('File does not contain any segments to translate');
  }

  // Preserve original filename encoding (including Cyrillic characters)
  // Use Buffer to ensure proper UTF-8 encoding
  const sanitizedFilename = Buffer.from(file.originalname, 'latin1').toString('utf8');
  const storagePath = path.join(env.fileStorageDir, `${Date.now()}_${sanitizedFilename}`);

  await fs.mkdir(path.dirname(storagePath), { recursive: true });
  await fs.writeFile(storagePath, file.buffer);

  const extension = path.extname(file.originalname).toLowerCase();
  const fileType: DocumentFileType =
    extension === '.docx'
      ? 'DOCX'
      : extension === '.xliff' || extension === '.xlf'
        ? 'XLIFF'
        : 'XLSX';
  const totalSegments = parsed.segments.length;
  const totalWords =
    parsed.totalWords ??
    parsed.segments.reduce((acc, segment) => acc + segment.sourceText.split(/\s+/).filter(Boolean).length, 0);

  // Preserve original filename with proper encoding
  const originalFilename = Buffer.from(file.originalname, 'latin1').toString('utf8');
  
  const document = await createDocument({
    projectId: input.projectId,
    name: originalFilename,
    filename: originalFilename,
    fileType,
    sourceLocale: input.sourceLocale,
    targetLocale: input.targetLocale,
    storagePath,
    wordCount: totalWords,
    totalSegments,
    totalWords,
  });

  try {
    await bulkUpsertSegments(
      parsed.segments.map((segment) => ({
        documentId: document.id,
        segmentIndex: segment.index,
        sourceText: segment.sourceText,
        targetMt: segment.targetMt ?? null,
        segmentType: segment.type || 'paragraph', // Save segment type
      })),
    );
  } catch (error) {
    // If segment creation fails, log error but don't fail the upload
    console.error('Error creating segments:', error);
    throw ApiError.badRequest('Failed to create segments from file. Please check the file format.');
  }

  // Generate document summary and embedding asynchronously (don't block upload)
  // This runs in the background to avoid slowing down the upload process
  // All operations are wrapped in try-catch to prevent any errors from crashing the process
  (async () => {
    try {
      logger.info(
        { documentId: document.id, documentName: document.name },
        'Starting document clustering process (background)',
      );

      // Generate document summary
      try {
        logger.info({ documentId: document.id }, 'Generating document summary...');
        const summary = await generateDocumentSummary(
          parsed.segments.map((s) => ({ sourceText: s.sourceText })),
          input.sourceLocale,
        );

        if (summary) {
          await prisma.document.update({
            where: { id: document.id },
            data: {
              summary,
              summaryGeneratedAt: new Date(),
            },
          });
          logger.info(
            { documentId: document.id, summaryLength: summary.length },
            '✅ Document summary generated',
          );
        }
      } catch (summaryError: any) {
        logger.error(
          {
            documentId: document.id,
            error: summaryError.message,
          },
          'Failed to generate document summary (non-critical)',
        );
        // Continue with embedding generation even if summary fails
      }

      // Generate document embedding
      try {
        logger.info({ documentId: document.id }, 'Generating document embedding...');
        await generateDocumentEmbedding(document.id);
        logger.info({ documentId: document.id }, '✅ Document embedding generated');
      } catch (embeddingError: any) {
        logger.error(
          {
            documentId: document.id,
            error: embeddingError.message,
          },
          'Failed to generate document embedding (non-critical)',
        );
        // Continue with clustering even if embedding fails (will skip clustering)
        return;
      }

      // Assign to cluster (only if embedding was successful)
      try {
        logger.info({ documentId: document.id }, 'Assigning document to cluster...');
        const clusterId = await assignDocumentToCluster(document.id, input.projectId);
        if (clusterId) {
          logger.info(
            { documentId: document.id, clusterId },
            '✅ Document assigned to cluster',
          );
          // Update cluster summary if cluster has multiple documents
          try {
            await updateClusterSummary(clusterId, input.projectId);
            logger.info({ clusterId }, '✅ Cluster summary updated');
          } catch (summaryError: any) {
            logger.warn(
              {
                clusterId,
                error: summaryError.message,
              },
              'Failed to update cluster summary (non-critical)',
            );
          }
        } else {
          logger.info({ documentId: document.id }, '⚠️ No cluster assignment (no similar documents found)');
        }

        logger.info(
          { documentId: document.id },
          '✅ Document clustering process completed',
        );
      } catch (clusterError: any) {
        logger.error(
          {
            documentId: document.id,
            error: clusterError.message,
          },
          'Failed to assign document to cluster (non-critical)',
        );
      }
    } catch (error: any) {
      // Log but don't fail - summary/embedding generation is optional
      // Final catch-all to prevent any unhandled errors from crashing the process
      logger.error(
        {
          documentId: document.id,
          error: error.message,
          stack: error.stack,
        },
        'Unexpected error in background document clustering process (non-critical)',
      );
    }
  })();

  return {
    document,
    importedSegments: parsed.segments.length,
  };
};

export const exportDocumentFile = async (documentId: string): Promise<Buffer> => {
  const document = await getDocument(documentId);
  if (!document) {
    throw ApiError.notFound('Document not found');
  }

  const handler = resolveHandler(document.filename ?? document.name, undefined);
  if (!handler || !handler.export) {
    throw ApiError.badRequest('Export not supported for this file format');
  }

  const originalBuffer = await fs.readFile(document.storagePath);
  const segments = await getDocumentSegments(documentId, 1, 10000);

  const exportSegments = segments.segments.map((seg) => ({
    index: seg.segmentIndex,
    targetText: seg.targetFinal ?? seg.targetMt ?? seg.sourceText,
  }));

  return handler.export({
    segments: exportSegments,
    originalBuffer,
    metadata: {
      documentId: document.id,
      filename: document.filename ?? document.name,
    },
  });
};

