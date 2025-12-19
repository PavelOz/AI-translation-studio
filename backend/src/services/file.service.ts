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
  segmentationMode?: 'paragraphs' | 'sentences';
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
  const parseOptions = { segmentationMode: input.segmentationMode || 'paragraphs' };
  
  try {
    parsed = await handler.parse(file.buffer, parseOptions);
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

  // Store segmentation mode in document metadata (if available)
  // This will be used during export to properly reconstruct paragraphs from sentences
  if (parsed.metadata?.segmentationMode) {
    // Store in a way that can be retrieved during export
    // For now, we'll pass it through metadata in export options
  }

  try {
    await bulkUpsertSegments(
      parsed.segments.map((segment) => {
        return {
          documentId: document.id,
          segmentIndex: segment.index,
          sourceText: segment.sourceText,
          targetMt: segment.targetMt ?? null,
          // Note: segmentType is not stored in DB (Segment model doesn't have this field)
          // Segment type information is only used during parsing/export, not persisted
        };
      }),
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
    segmentType: 'paragraph' as const, // Segment model doesn't store segmentType, default to 'paragraph'
    metadata: {
      sourceText: seg.sourceText, // Include sourceText for verification matching
    },
    // Note: documentParagraphIndex metadata is not stored in DB,
    // Export will use heuristic approach to group sentence segments
  }));

  



  // Check if document was segmented by sentences by looking at segment types and patterns
  // Improved heuristic: check multiple indicators
  // 1. Average segment length (sentences are typically shorter)
  // 2. Number of segments relative to document size
  // 3. Pattern of segment lengths (sentences have more uniform, shorter lengths)
  const avgSegmentLength = exportSegments.length > 0
    ? exportSegments.reduce((sum, seg) => sum + seg.targetText.length, 0) / exportSegments.length
    : 0;
  
  // Calculate variance in segment lengths (sentences tend to have lower variance)
  const segmentLengths = exportSegments.map(seg => seg.targetText.length);
  const variance = segmentLengths.length > 1
    ? segmentLengths.reduce((sum, len) => sum + Math.pow(len - avgSegmentLength, 2), 0) / segmentLengths.length
    : 0;
  const stdDev = Math.sqrt(variance);
  
  // More reliable heuristic:
  // - Average length < 80 chars (sentences are typically shorter than paragraphs)
  // - Standard deviation < 100 (sentences have more uniform lengths)
  // - At least 10 segments (to avoid false positives on very short documents)
  // - At least 3 segments per 1000 chars of total text (sentences create more segments)
  const totalTextLength = exportSegments.reduce((sum, seg) => sum + seg.targetText.length, 0);
  const segmentsPer1000Chars = totalTextLength > 0 ? (exportSegments.length / totalTextLength) * 1000 : 0;
  
  const likelySentenceSegmented = 
    avgSegmentLength < 80 && 
    stdDev < 100 && 
    exportSegments.length >= 10 &&
    segmentsPer1000Chars >= 3;
  

  try {
    
    
    const exportedBuffer = await handler.export({
      segments: exportSegments,
      originalBuffer,
      metadata: {
        documentId: document.id,
        filename: document.filename ?? document.name,
        likelySentenceSegmented, // Pass hint to export handler
      },
    });
    
    
    
    return exportedBuffer;
  } catch (error) {
    
    const errorMessage = error instanceof Error ? error.message : String(error);
    logger.error({ 
      error: errorMessage, 
      documentId: document.id,
      filename: document.filename ?? document.name,
      stack: error instanceof Error ? error.stack : undefined
    }, 'Failed to export document file');
    throw ApiError.internalServerError(`Failed to export document: ${errorMessage}`);
  }
};

