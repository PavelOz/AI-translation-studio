import { Router } from 'express';
import multer from 'multer';
import { z } from 'zod';
import fs from 'fs/promises';
import path from 'path';
import { asyncHandler } from '../utils/asyncHandler';
import { requireAuth } from '../utils/authMiddleware';
import { listDocuments, getDocument, updateDocumentStatus, updateDocument, deleteDocument } from '../services/document.service';
import { importDocumentFile, exportDocumentFile } from '../services/file.service';
import { ApiError } from '../utils/apiError';
import { getDocumentSegments } from '../services/segment.service';
import { runDocumentMachineTranslation, pretranslateDocument } from '../services/ai.service';
import { getDocumentMetricsSummary, runDocumentQualityCheck } from '../services/quality.service';
import { getProgress, cancelProgress, clearProgress } from '../services/pretranslateProgress';

// Configure multer to preserve UTF-8 encoding for filenames (including Cyrillic)
// Multer handles UTF-8 filenames correctly when sent from modern browsers
const upload = multer({ 
  storage: multer.memoryStorage(),
  limits: { fileSize: 100 * 1024 * 1024 }, // 100MB limit for documents
});

const statusSchema = z.object({
  status: z.enum(['NEW', 'IN_PROGRESS', 'COMPLETED']),
});

const updateDocumentSchema = z.object({
  name: z.string().optional(),
  filename: z.string().optional(),
  sourceLocale: z.string().optional(),
  targetLocale: z.string().optional(),
  status: z.enum(['NEW', 'IN_PROGRESS', 'COMPLETED']).optional(),
});

const batchTranslationSchema = z.object({
  mode: z.enum(['translate_all', 'pre_translate']),
  options: z
    .object({
      applyTm: z.boolean().optional(),
      minScore: z.number().min(0).max(100).optional(),
      mtOnlyEmpty: z.boolean().optional(),
      glossaryMode: z.enum(['off', 'strict_source', 'strict_semantic']).optional(),
    })
    .optional(),
});

const pretranslateSchema = z.object({
  applyAiToLowMatches: z.boolean().optional(), // Apply AI to segments with < 100% matches
  applyAiToEmptyOnly: z.boolean().optional(), // Apply AI only to empty segments (no matches at all)
  rewriteConfirmed: z.boolean().optional(), // Rewrite confirmed segments
  rewriteNonConfirmed: z.boolean().optional(), // Rewrite non-confirmed but not empty segments
  glossaryMode: z.enum(['off', 'strict_source', 'strict_semantic']).optional(),
  useCritic: z.boolean().optional(), // Use critic AI workflow for higher quality (slower)
});

const uploadSchema = z.object({
  projectId: z.string().uuid(),
  sourceLocale: z.string(),
  targetLocale: z.string(),
});

export const documentRoutes = Router();

documentRoutes.use(requireAuth);

documentRoutes.get(
  '/',
  asyncHandler(async (req, res) => {
    const documents = await listDocuments(req.query.projectId as string | undefined);
    res.json(documents);
  }),
);

documentRoutes.post(
  '/upload',
  (req, res, next) => {
    upload.single('file')(req, res, (err) => {
      if (err) {
        if (err.code === 'LIMIT_FILE_SIZE') {
          return next(ApiError.badRequest('File too large. Maximum size is 100MB.'));
        }
        if (err.code === 'LIMIT_UNEXPECTED_FILE') {
          return next(ApiError.badRequest('Unexpected file field. Use "file" as the field name.'));
        }
        return next(ApiError.badRequest(err.message || 'File upload error'));
      }
      if (!req.file) {
        return next(ApiError.badRequest('No file uploaded. Please select a file.'));
      }
      next();
    });
  },
  asyncHandler(async (req, res) => {
    const payload = uploadSchema.parse(req.body);
    const result = await importDocumentFile(req.file!, payload);
    res.status(201).json(result);
  }),
);

documentRoutes.get(
  '/:documentId',
  asyncHandler(async (req, res) => {
    const document = await getDocument(req.params.documentId);
    res.json(document);
  }),
);

documentRoutes.get(
  '/:documentId/segments',
  asyncHandler(async (req, res) => {
    const page = req.query.page ? Number(req.query.page) : 1;
    const pageSize = req.query.pageSize ? Number(req.query.pageSize) : 200;
    const segments = await getDocumentSegments(req.params.documentId, page, pageSize);
    res.json(segments);
  }),
);

documentRoutes.patch(
  '/:documentId',
  asyncHandler(async (req, res) => {
    const payload = updateDocumentSchema.parse(req.body);
    const document = await updateDocument(req.params.documentId, payload);
    res.json(document);
  }),
);

documentRoutes.post(
  '/:documentId/mt-batch',
  asyncHandler(async (req, res) => {
    const payload = batchTranslationSchema.parse(req.body);
    const result = await runDocumentMachineTranslation(req.params.documentId, payload.mode, payload.options);
    res.json(result);
  }),
);

documentRoutes.post(
  '/:documentId/pretranslate',
  asyncHandler(async (req, res) => {
    const payload = pretranslateSchema.parse(req.body);
    const { clearProgress } = await import('../services/pretranslateProgress');
    
    // Clear any old progress before starting
    clearProgress(req.params.documentId);
    
    // Start pretranslation asynchronously
    pretranslateDocument(req.params.documentId, {
      ...payload,
      glossaryMode: payload.glossaryMode ?? 'strict_source', // Default to strict_source if not provided
    })
      .then(() => {
        // Success - progress will be marked as completed
      })
      .catch((error) => {
        // Error already handled in pretranslateDocument
        console.error('Pretranslation error:', error);
      });
    // Return immediately with status
    res.json({ status: 'started', documentId: req.params.documentId });
  }),
);

documentRoutes.get(
  '/:documentId/pretranslate/progress',
  asyncHandler(async (req, res) => {
    const progress = getProgress(req.params.documentId);
    if (!progress) {
      return res.status(404).json({ error: 'No progress found for this document' });
    }
    res.json(progress);
  }),
);

documentRoutes.post(
  '/:documentId/pretranslate/cancel',
  asyncHandler(async (req, res) => {
    try {
      cancelProgress(req.params.documentId);
      const progress = getProgress(req.params.documentId);
      res.json({ 
        status: 'cancelled', 
        documentId: req.params.documentId,
        message: 'Cancellation requested. Processing will stop at the next segment.',
        currentProgress: progress,
      });
    } catch (error: any) {
      console.error('Error cancelling pretranslation:', error);
      res.status(500).json({ 
        error: 'Failed to cancel pretranslation',
        message: error.message,
      });
    }
  }),
);

documentRoutes.post(
  '/:documentId/qa',
  asyncHandler(async (req, res) => {
    const report = await runDocumentQualityCheck(req.params.documentId);
    res.json(report);
  }),
);

documentRoutes.get(
  '/:documentId/metrics-summary',
  asyncHandler(async (req, res) => {
    const summary = await getDocumentMetricsSummary(req.params.documentId);
    res.json(summary);
  }),
);

documentRoutes.patch(
  '/:documentId/status',
  asyncHandler(async (req, res) => {
    const payload = statusSchema.parse(req.body);
    const document = await updateDocumentStatus(req.params.documentId, payload.status);
    res.json(document);
  }),
);

documentRoutes.delete(
  '/:documentId',
  asyncHandler(async (req, res) => {
    const document = await getDocument(req.params.documentId);
    try {
      await fs.unlink(document.storagePath);
    } catch (error) {
      // File may not exist, continue with deletion
    }
    await deleteDocument(req.params.documentId);
    res.status(204).send();
  }),
);

documentRoutes.get(
  '/:documentId/download',
  asyncHandler(async (req, res) => {
    const document = await getDocument(req.params.documentId);
    const useExport = req.query.export === 'true' || req.query.export === '1';

    if (useExport) {
      try {
        const exportedBuffer = await exportDocumentFile(req.params.documentId);
        const filename = document.filename ?? document.name;
        res.setHeader('Content-Type', 'application/octet-stream');
        // Properly encode filename for Content-Disposition header (RFC 5987 for UTF-8)
        const encodedFilename = encodeURIComponent(filename);
        res.setHeader('Content-Disposition', `attachment; filename="${encodedFilename}"; filename*=UTF-8''${encodedFilename}`);
        res.send(exportedBuffer);
      } catch (error) {
        if ((error as Error).message.includes('Export not supported')) {
          const filePath = path.resolve(document.storagePath);
          await fs.access(filePath);
          // Preserve filename encoding for download (including Cyrillic)
          const encodedFilename = encodeURIComponent(document.name);
          res.setHeader('Content-Disposition', `attachment; filename="${encodedFilename}"; filename*=UTF-8''${encodedFilename}`);
          res.download(filePath, document.name);
        } else {
          throw error;
        }
      }
    } else {
      const filePath = path.resolve(document.storagePath);
      try {
        await fs.access(filePath);
        // Preserve filename encoding for download (including Cyrillic)
        const encodedFilename = encodeURIComponent(document.name);
        res.setHeader('Content-Disposition', `attachment; filename="${encodedFilename}"; filename*=UTF-8''${encodedFilename}`);
        res.download(filePath, document.name);
      } catch {
        throw ApiError.notFound('File not found on disk');
      }
    }
  }),
);

