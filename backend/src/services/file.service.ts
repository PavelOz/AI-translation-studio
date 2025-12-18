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
  // #region agent log
  logger.debug({ 
    fileName: file?.originalname, 
    hasBuffer: !!file?.buffer, 
    bufferLength: file?.buffer?.length, 
    inputSegmentationMode: input.segmentationMode 
  }, 'importDocumentFile: entry');
  // #endregion
  
  if (!file) {
    throw ApiError.badRequest('File is required');
  }

  const handler = resolveHandler(file.originalname, file.mimetype);
  
  // #region agent log
  logger.debug({ 
    hasHandler: !!handler, 
    handlerType: handler?.constructor?.name 
  }, 'importDocumentFile: handler resolved');
  // #endregion
  
  if (!handler) {
    throw ApiError.badRequest('Unsupported file format');
  }

  let parsed;
  const parseOptions = { segmentationMode: input.segmentationMode || 'paragraphs' };
  
  // #region agent log
  logger.debug({ 
    parseOptions, 
    hasParseMethod: typeof handler.parse === 'function' 
  }, 'importDocumentFile: calling handler.parse');
  // #endregion
  
  try {
    parsed = await handler.parse(file.buffer, parseOptions);
    
    // #region agent log
    logger.debug({ 
      segmentsCount: parsed?.segments?.length, 
      hasMetadata: !!parsed?.metadata, 
      metadataSegmentationMode: parsed?.metadata?.segmentationMode 
    }, 'importDocumentFile: handler.parse succeeded');
    // #endregion
  } catch (error) {
    // #region agent log
    logger.error({ 
      errorMessage: error instanceof Error ? error.message : String(error), 
      errorStack: error instanceof Error ? error.stack?.substring(0, 500) : undefined 
    }, 'importDocumentFile: handler.parse failed');
    // #endregion
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
    // #region agent log
    // Log first 20 segments to verify type is being saved correctly
    const segmentsToLog = parsed.segments.slice(0, 20);
    logger.debug({
      totalSegments: parsed.segments.length,
      segmentsWithType: parsed.segments.filter(s => s.type).length,
      segmentsWithTableCellType: parsed.segments.filter(s => s.type === 'table-cell').length,
      segmentsWithParagraphType: parsed.segments.filter(s => s.type === 'paragraph').length,
      firstFewSegments: segmentsToLog.map(s => ({
        index: s.index,
        type: s.type,
        textPreview: s.sourceText.substring(0, 30)
      }))
    }, 'Import: preparing segments for database save');
    // #endregion
    
    // #region agent log
    const segmentsWithTargetMt = parsed.segments.filter(s => s.targetMt).length;
    fetch('http://127.0.0.1:7242/ingest/7f529324-455d-4ca1-81c1-cbc867a5b6ab',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'file.service.ts:152',message:'Import: before bulkUpsertSegments',data:{totalSegments:parsed.segments.length,segmentsWithTargetMt,firstFewTargetMt:parsed.segments.slice(0,5).map((s,i)=>({index:s.index,hasTargetMt:!!s.targetMt,targetMtPreview:s.targetMt?.substring(0,30)}))},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'D'})}).catch(()=>{});
    // #endregion

    await bulkUpsertSegments(
      parsed.segments.map((segment) => {
        const segmentType = segment.type || 'paragraph';
        
        // #region agent log
        // Log first 20 segments to verify type is being saved
        if (segment.index < 20) {
          logger.debug({
            segmentIndex: segment.index,
            segmentTypeFromParse: segment.type,
            segmentTypeToSave: segmentType,
            textPreview: segment.sourceText.substring(0, 30)
          }, 'Import: saving segment to database');
        }
        // #endregion
        
        // #region agent log
        if (segment.index < 5 && segment.targetMt) {
          fetch('http://127.0.0.1:7242/ingest/7f529324-455d-4ca1-81c1-cbc867a5b6ab',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'file.service.ts:175',message:'Import: segment with targetMt',data:{index:segment.index,targetMt:segment.targetMt,targetMtLength:segment.targetMt.length},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'D'})}).catch(()=>{});
        }
        // #endregion
        
        return {
          documentId: document.id,
          segmentIndex: segment.index,
          sourceText: segment.sourceText,
          targetMt: segment.targetMt ?? null,
          segmentType, // Save segment type
        };
      }),
    );

    // #region agent log
    fetch('http://127.0.0.1:7242/ingest/7f529324-455d-4ca1-81c1-cbc867a5b6ab',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'file.service.ts:180',message:'Import: after bulkUpsertSegments',data:{documentId:document.id,totalSegments:parsed.segments.length},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'D'})}).catch(()=>{});
    // #endregion
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

  // #region agent log
  logger.debug({ 
    totalSegments: segments.segments.length,
    segmentsWithTargetFinal: segments.segments.filter(s => s.targetFinal).length,
    segmentsWithTargetMt: segments.segments.filter(s => s.targetMt && !s.targetFinal).length,
    segmentsWithSourceOnly: segments.segments.filter(s => !s.targetFinal && !s.targetMt).length
  }, 'Export: preparing segments');
  // #endregion

  // #region agent log
  const segmentsWithTargetMt = segments.segments.filter(s => s.targetMt && !s.targetFinal);
  fetch('http://127.0.0.1:7242/ingest/7f529324-455d-4ca1-81c1-cbc867a5b6ab',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'file.service.ts:313',message:'Export: segments from DB',data:{totalSegments:segments.segments.length,segmentsWithTargetMt:segmentsWithTargetMt.length,segmentsWithTargetFinal:segments.segments.filter(s=>s.targetFinal).length,firstFewTargetMt:segmentsWithTargetMt.slice(0,5).map((s,i)=>({index:s.segmentIndex,targetMt:s.targetMt?.substring(0,30),targetMtLength:s.targetMt?.length||0}))},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'E'})}).catch(()=>{});
  // #endregion

  const exportSegments = segments.segments.map((seg) => ({
    index: seg.segmentIndex,
    targetText: seg.targetFinal ?? seg.targetMt ?? seg.sourceText,
    segmentType: seg.segmentType || 'paragraph',
    metadata: {
      sourceText: seg.sourceText, // Include sourceText for verification matching
    },
    // Note: documentParagraphIndex metadata is not stored in DB,
    // Export will use heuristic approach to group sentence segments
  }));

  // #region agent log
  const exportSegmentsUsingTargetMt = exportSegments.filter((es, i) => {
    const orig = segments.segments.find(s => s.segmentIndex === es.index);
    return orig && !orig.targetFinal && orig.targetMt && es.targetText === orig.targetMt;
  });
  fetch('http://127.0.0.1:7242/ingest/7f529324-455d-4ca1-81c1-cbc867a5b6ab',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'file.service.ts:328',message:'Export: exportSegments created',data:{totalExportSegments:exportSegments.length,exportSegmentsUsingTargetMt:exportSegmentsUsingTargetMt.length,firstFewExportSegments:exportSegments.slice(0,5).map((es,i)=>({index:es.index,targetTextPreview:es.targetText.substring(0,30),isUsingTargetMt:!!segments.segments.find(s=>s.segmentIndex===es.index)?.targetMt&&!segments.segments.find(s=>s.segmentIndex===es.index)?.targetFinal}))},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'E'})}).catch(()=>{});
  // #endregion
  
  // #region agent log
  logger.debug({ 
    exportSegmentsCount: exportSegments.length,
    segmentsUsingSource: exportSegments.filter(s => s.targetText === segments.segments.find(orig => orig.segmentIndex === s.index)?.sourceText).length
  }, 'Export: exportSegments created');
  // #endregion

  // #region agent log
  logger.debug({ 
    documentId,
    totalSegments: segments.segments.length,
    firstFewSegments: segments.segments.slice(0, 3).map(s => ({
      index: s.segmentIndex,
      hasTargetFinal: !!s.targetFinal,
      hasTargetMt: !!s.targetMt,
      targetFinal: s.targetFinal?.substring(0, 30),
      targetMt: s.targetMt?.substring(0, 30),
      sourceText: s.sourceText.substring(0, 30)
    })),
    segmentsWithTargetFinal: segments.segments.filter(s => s.targetFinal).length,
    segmentsWithTargetMt: segments.segments.filter(s => s.targetMt).length
  }, 'Export: fetched segments from database');
  // #endregion

  // #region agent log
  logger.debug({ 
    totalExportSegments: exportSegments.length,
    firstFewExportSegments: exportSegments.slice(0, 3).map(s => ({
      index: s.index,
      targetText: s.targetText.substring(0, 30),
      targetTextLength: s.targetText.length
    })),
    segmentsWithNonSourceText: exportSegments.filter(s => s.targetText !== segments.segments.find(orig => orig.segmentIndex === s.index)?.sourceText).length
  }, 'Export: created exportSegments array');
  // #endregion

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
  
  // #region agent log
  logger.debug({
    avgSegmentLength,
    stdDev,
    totalSegments: exportSegments.length,
    totalTextLength,
    segmentsPer1000Chars,
    likelySentenceSegmented,
    heuristic: {
      avgLengthCheck: avgSegmentLength < 80,
      stdDevCheck: stdDev < 100,
      minSegmentsCheck: exportSegments.length >= 10,
      densityCheck: segmentsPer1000Chars >= 3
    }
  }, 'Export: segmentation mode detection');
  // #endregion

  try {
    // #region agent log
    logger.debug({
      documentId: document.id,
      filename: document.filename ?? document.name,
      totalSegments: exportSegments.length,
      likelySentenceSegmented,
      handlerType: handler.constructor.name
    }, 'Export: calling handler.export');
    // #endregion
    
    const exportedBuffer = await handler.export({
      segments: exportSegments,
      originalBuffer,
      metadata: {
        documentId: document.id,
        filename: document.filename ?? document.name,
        likelySentenceSegmented, // Pass hint to export handler
      },
    });
    
    // #region agent log
    logger.debug({
      documentId: document.id,
      exportedBufferSize: exportedBuffer.length,
      success: true
    }, 'Export: handler.export succeeded');
    // #endregion
    
    return exportedBuffer;
  } catch (error) {
    // #region agent log
    logger.error({
      documentId: document.id,
      filename: document.filename ?? document.name,
      errorMessage: error instanceof Error ? error.message : String(error),
      errorStack: error instanceof Error ? error.stack?.substring(0, 1000) : undefined,
      totalSegments: exportSegments.length,
      likelySentenceSegmented,
      handlerType: handler.constructor.name
    }, 'Export: handler.export failed');
    // #endregion
    
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

