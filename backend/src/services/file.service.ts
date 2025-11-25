import fs from 'fs/promises';
import path from 'path';
import type { Express } from 'express';
import type { DocumentFileType } from '@prisma/client';
import { resolveHandler } from '../utils/file-handlers';
import { ApiError } from '../utils/apiError';
import { env } from '../utils/env';
import { logger } from '../utils/logger';
import { createDocument, getDocument } from './document.service';
import { bulkUpsertSegments, getDocumentSegments } from './segment.service';

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

