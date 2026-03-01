import { Router } from 'express';
import multer from 'multer';
import { z } from 'zod';
import fs from 'fs/promises';
import path from 'path';
import { asyncHandler } from '../utils/asyncHandler';
import { requireAuth } from '../utils/authMiddleware';
import { listDocuments, listDocumentsPaginated, getDocument, updateDocumentStatus, updateDocument, deleteDocument } from '../services/document.service';
import { importDocumentFile, exportDocumentFile } from '../services/file.service';
import { exportDocumentToTmx } from '../services/tmx.service';
import { ApiError } from '../utils/apiError';
import { logger } from '../utils/logger';
import { getDocumentSegments, findSegmentIdsContainingTerms } from '../services/segment.service';
import { runDocumentMachineTranslation, pretranslateDocument, patchTranslate } from '../services/ai.service';
import { runValidatorJanitor } from '../services/validatorJanitor';
import { UniversalJanitor } from '../services/universalJanitor';
import { getDocumentMetricsSummary, runDocumentQualityCheck } from '../services/quality.service';
import { getProgress, cancelProgress, clearProgress } from '../services/pretranslateProgress';
import { runFullAnalysis, getAnalysisResults, cancelAnalysis, resetAnalysisStatus, getStageMonitoringData, listDocumentGlossary, updateDocumentGlossaryEntry, translateSingleTerm, getDocumentDna, updateDocumentDna, generateDocumentDna, refineDocumentDna } from '../services/analysis.service';
import { validateDocumentDnaPayload, validateDnaForCycles } from '../services/dnaValidation';
import { validateDnaContract, formatValidationReport } from '../services/validate-dna';
import { getTranslationDirection } from '../services/dnaPrompts';
import { normalizeAbbreviationLogic } from '../services/abbreviationLogicNormalize';
import { computeDnaDelta } from '../services/dnaDiff';
import { normalizeDocumentDnaPayload, sanitizeDocumentDnaPayloadForPut } from '../services/dnaSchema';
import { getProfile } from '../services/profile.service';
import { prisma } from '../db/prisma';
import { enrichDocumentDnaFromCSV } from '../services/dnaEnrichment.service';
import { getProgress as getEnrichmentProgress, getAllActiveProgress } from '../services/enrichmentProgress';

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
  profileId: z.string().uuid().nullable().optional(),
});

const batchTranslationSchema = z.object({
  mode: z.enum(['translate_all', 'pre_translate']),
  options: z
    .object({
      applyTm: z.boolean().optional(),
      minScore: z.number().min(0).max(100).optional(),
      mtOnlyEmpty: z.boolean().optional(),
      mtOnlyNonEmpty: z.boolean().optional(), // Only translate non-empty segments
      glossaryMode: z.enum(['off', 'strict_source', 'strict_semantic']).optional(),
      useCritic: z.boolean().optional(), // Use critic AI workflow for higher quality (slower)
      rewriteNonConfirmed: z.boolean().optional(), // Rewrite non-confirmed segments (ignore text, check status)
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
  provider: z.enum(['gemini', 'openai', 'yandex', 'deepseek']).optional(), // Override project AI provider
  model: z.string().optional(), // Override project AI model
  temperature: z.number().min(0).max(1).optional(), // Override AI temperature
  skipTm: z.boolean().optional(), // Skip Phase 1 (TM matching)
});

const patchTranslateSchema = z.object({
  segmentIds: z.array(z.string().uuid()),
  glossaryMode: z.enum(['off', 'strict_source', 'strict_semantic']).optional(),
  provider: z.enum(['gemini', 'openai', 'yandex', 'deepseek']).optional(),
  model: z.string().optional(),
  temperature: z.number().min(0).max(1).optional(),
});

const uploadSchema = z.object({
  projectId: z.string().uuid(),
  sourceLocale: z.string(),
  targetLocale: z.string(),
  segmentationMode: z.enum(['paragraphs', 'sentences']).optional(),
});

export const documentRoutes = Router();

documentRoutes.use(requireAuth);

documentRoutes.get(
  '/',
  asyncHandler(async (req, res) => {
    const projectId = req.query.projectId as string | undefined;
    const page = req.query.page != null ? Number(req.query.page) : undefined;
    const pageSize = req.query.pageSize != null ? Number(req.query.pageSize) : undefined;

    if (projectId && page != null && pageSize != null && !Number.isNaN(page) && !Number.isNaN(pageSize) && page >= 1 && pageSize >= 1) {
      const result = await listDocumentsPaginated(projectId, page, Math.min(pageSize, 100));
      res.json(result);
      return;
    }

    const documents = await listDocuments(projectId);
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

documentRoutes.get(
  '/:documentId/export-tmx',
  asyncHandler(async (req, res) => {
    const document = await getDocument(req.params.documentId);
    if (!document) throw ApiError.notFound('Document not found');
    const buffer = await exportDocumentToTmx(req.params.documentId);
    const baseName = (document.filename ?? document.name ?? 'export').replace(
      /\.(docx|xlsx|xliff|xlf)$/i,
      '',
    );
    const filename = `${baseName}.tmx`;
    const encoded = encodeURIComponent(filename);
    res.setHeader('Content-Type', 'application/xml');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${encoded}"; filename*=UTF-8''${encoded}`,
    );
    res.send(buffer);
  }),
);

documentRoutes.patch(
  '/:documentId',
  asyncHandler(async (req, res) => {
    const payload = updateDocumentSchema.parse(req.body);
    if (payload.profileId !== undefined && payload.profileId !== null) {
      await getProfile(payload.profileId);
    }
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
  '/:documentId/mt-batch/cancel',
  asyncHandler(async (req, res) => {
    const { cancelBatchTranslation } = await import('../services/ai.service');
    cancelBatchTranslation(req.params.documentId);
    res.json({ status: 'cancelled', documentId: req.params.documentId });
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
      provider: payload.provider,
      model: payload.model,
      temperature: payload.temperature,
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

documentRoutes.post(
  '/:documentId/patch-translate',
  asyncHandler(async (req, res) => {
    const payload = patchTranslateSchema.parse(req.body);
    const documentId = req.params.documentId;
    const { clearProgress } = await import('../services/pretranslateProgress');
    clearProgress(documentId);
    patchTranslate(documentId, payload.segmentIds, {
      glossaryMode: payload.glossaryMode ?? 'strict_source',
      provider: payload.provider,
      model: payload.model,
      temperature: payload.temperature,
    })
      .then(() => {})
      .catch((error) => {
        console.error('Patch translation error:', error);
      });
    res.json({ status: 'started', documentId });
  }),
);

const validatorJanitorSchema = z.object({
  dryRun: z.boolean().optional(),
});

documentRoutes.post(
  '/:documentId/validator-janitor',
  asyncHandler(async (req, res, next): Promise<void> => {
    const documentId = req.params.documentId;
    const body = validatorJanitorSchema.safeParse(req.body ?? {});
    const dryRun = body.success && body.data.dryRun === false ? false : true;
    const report = await runValidatorJanitor(documentId, { dryRun });
    res.json(report);
    return;
  }),
);

documentRoutes.get(
  '/:documentId/pretranslate/progress',
  asyncHandler(async (req, res, _next) => {
    const progress = getProgress(req.params.documentId);
    if (!progress) {
      res.status(404).json({ error: 'No progress found for this document' });
      return;
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

// Analysis routes
const analyzeSchema = z.object({
  forceReset: z.boolean().optional(),
  glossaryMode: z.enum(['fast', 'deep']).optional(),
  provider: z.string().optional(), // AI provider for glossary extraction (e.g., 'deepseek')
  model: z.string().optional(), // AI model for glossary extraction (e.g., 'deepseek-reasoner')
});

documentRoutes.post(
  '/:documentId/analyze',
  asyncHandler(async (req, res) => {
    const payload = analyzeSchema.parse(req.body ?? {});
    const forceReset = payload.forceReset === true;
    const glossaryMode = (payload.glossaryMode === 'deep' ? 'deep' : 'fast') as 'fast' | 'deep';
    const provider = payload.provider;
    const model = payload.model;
    runFullAnalysis(req.params.documentId, forceReset, glossaryMode, provider, model)
      .then(() => {})
      .catch((error) => {
        logger.error({ documentId: req.params.documentId, error }, 'Analysis failed');
      });
    res.json({ status: 'started', documentId: req.params.documentId, glossaryMode, provider, model });
  }),
);

documentRoutes.get(
  '/:documentId/analysis',
  asyncHandler(async (req, res) => {
    const results = await getAnalysisResults(req.params.documentId);
    res.json(results);
  }),
);

documentRoutes.delete(
  '/:documentId/analysis',
  asyncHandler(async (req, res) => {
    await cancelAnalysis(req.params.documentId);
    res.json({ message: 'Analysis cancelled' });
  }),
);

documentRoutes.post(
  '/:documentId/analysis/reset',
  asyncHandler(async (req, res) => {
    const result = await resetAnalysisStatus(req.params.documentId);
    res.json(result);
  }),
);

documentRoutes.get(
  '/:documentId/analysis/monitoring',
  asyncHandler(async (req, res) => {
    const result = await getStageMonitoringData(req.params.documentId);
    res.json(result);
  }),
);

// Document Glossary routes
documentRoutes.get(
  '/:documentId/glossary',
  asyncHandler(async (req, res) => {
    const entries = await listDocumentGlossary(req.params.documentId);
    res.json(entries);
  }),
);

documentRoutes.patch(
  '/:documentId/glossary/:entryId',
  asyncHandler(async (req, res) => {
    const payload = req.body;
    const result = await updateDocumentGlossaryEntry(
      req.params.documentId,
      req.params.entryId,
      payload,
    );
    res.json(result);
  }),
);

// Document DNA (Project Knowledge Base) routes
const documentDnaSchema = z.object({
  technicalSchema: z.record(z.string(), z.unknown()).nullable().optional(),
  namingConventions: z.record(z.string(), z.unknown()).nullable().optional(),
  abbreviationLogic: z.record(z.string(), z.unknown()).nullable().optional(),
  entityGroups: z.record(z.string(), z.unknown()).nullable().optional(),
}).refine(
  (data) => {
    if (data.abbreviationLogic && typeof data.abbreviationLogic === 'object') {
      return !Object.keys(data.abbreviationLogic).some((k) => k === '' || /^\s+$/.test(k));
    }
    return true;
  },
  { message: 'abbreviationLogic must not have empty or whitespace-only keys' },
);

documentRoutes.get(
  '/:documentId/dna',
  asyncHandler(async (req, res) => {
    const dna = await getDocumentDna(req.params.documentId);
    if (dna === null) {
      res.status(404).json({ error: 'Document DNA not found. Run analysis or regenerate after import.' });
      return;
    }
    res.json(dna);
  }),
);

documentRoutes.get(
  '/:documentId/dna/validate',
  asyncHandler(async (req, res) => {
    const dna = await getDocumentDna(req.params.documentId);
    const result = validateDocumentDnaPayload(dna ?? null);
    const abbreviationCount = dna?.abbreviationLogic && typeof dna.abbreviationLogic === 'object'
      ? Object.keys(dna.abbreviationLogic).length
      : 0;
    
    // Получаем направление перевода для расширенной валидации
    const document = await prisma.document.findUnique({
      where: { id: req.params.documentId },
      select: { sourceLocale: true, targetLocale: true },
    });
    
    let contractValidation = null;
    if (document) {
      const direction = getTranslationDirection(document.sourceLocale, document.targetLocale);
      contractValidation = validateDnaContract(dna ?? null, direction);
    }
    
    res.json({ 
      valid: result.valid, 
      errors: result.errors, 
      abbreviationCount,
      contractValidation: contractValidation ? {
        status: contractValidation.status,
        issues: contractValidation.issues,
        suggestions: contractValidation.suggestions,
        report: formatValidationReport(contractValidation),
      } : null,
    });
  }),
);

documentRoutes.put(
  '/:documentId/dna',
  asyncHandler(async (req, res) => {
    const documentId = req.params.documentId;
    const parsed = documentDnaSchema.safeParse(req.body);
    if (!parsed.success) {
      const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`);
      res.status(400).json({ error: 'Invalid Document DNA payload', details: issues });
      return;
    }
    const sanitized = sanitizeDocumentDnaPayloadForPut(parsed.data as Record<string, unknown>);
    let normalized: ReturnType<typeof normalizeDocumentDnaPayload>;
    try {
      normalized = normalizeDocumentDnaPayload(sanitized);
    } catch (err: any) {
      res.status(400).json({ error: 'Invalid Document DNA structure', details: [err?.message ?? String(err)] });
      return;
    }
    const cycleCheck = validateDnaForCycles(normalized);
    if (!cycleCheck.valid) {
      res.status(400).json({ error: 'Document DNA recursion risk', details: cycleCheck.errors });
      return;
    }
    
    // Расширенная валидация DNA-Contract-Validator
    try {
      const document = await prisma.document.findUnique({
        where: { id: documentId },
        select: { sourceLocale: true, targetLocale: true },
      });
      
      if (document) {
        const direction = getTranslationDirection(document.sourceLocale, document.targetLocale);
        const contractValidation = validateDnaContract(normalized, direction);
        
        // Блокируем перевод при наличии ошибок
        if (contractValidation.status === 'ERROR') {
          const errorMessages = contractValidation.issues
            .filter(i => i.type === 'error')
            .map(i => i.message);
          res.status(400).json({ 
            error: 'Document DNA validation failed', 
            details: errorMessages,
            report: formatValidationReport(contractValidation),
          });
          return;
        }
        
        // Предупреждения логируем, но не блокируем
        if (contractValidation.status === 'WARNING') {
          logger.warn({ documentId, validation: contractValidation }, 'Document DNA validation warnings');
        }
      }
    } catch (validationErr: any) {
      // Если валидация падает, логируем, но не блокируем сохранение
      logger.error({ documentId, error: validationErr?.message, stack: validationErr?.stack }, 'DNA contract validation error');
    }
    const previousDna = await getDocumentDna(documentId);
    const updated = await updateDocumentDna(documentId, normalized);
    const delta = computeDnaDelta(previousDna, normalized);
    const termsForLookup = [...delta.addedKeys, ...delta.changedKeys];
    const affectedSegments = termsForLookup.length > 0
      ? await findSegmentIdsContainingTerms(documentId, termsForLookup)
      : [];
    const affectedSegmentIds = [...new Set(affectedSegments.map((s) => s.id))];
    res.json({
      ...updated,
      affectedSegmentIds,
      affectedCount: affectedSegmentIds.length,
      delta: { addedKeys: delta.addedKeys, changedKeys: delta.changedKeys, removedKeys: delta.removedKeys },
    });
  }),
);

documentRoutes.post(
  '/:documentId/dna/regenerate',
  asyncHandler(async (req, res) => {
    try {
      const dna = await generateDocumentDna(req.params.documentId);
      res.json(dna);
    } catch (error: any) {
      // Log detailed error information
      logger.error(
        { 
          documentId: req.params.documentId, 
          error: error.message, 
          stack: error.stack,
          statusCode: error.statusCode,
          isApiError: error instanceof ApiError,
        },
        'Failed to regenerate Document DNA',
      );
      
      // If it's already an ApiError, it will have proper status code and message
      // Otherwise, wrap it in a generic error
      if (error instanceof ApiError) {
        throw error;
      }
      
      // For unexpected errors, provide a user-friendly message
      throw ApiError.internalServerError(
        `Failed to regenerate Document DNA: ${error.message || 'Unknown error'}. ` +
        `Please check the server logs for more details or try again later.`,
      );
    }
  }),
);

documentRoutes.post(
  '/:documentId/refine-dna',
  asyncHandler(async (req, res) => {
    const preview = req.body && typeof req.body === 'object' && req.body.preview === true;
    const dna = await refineDocumentDna(req.params.documentId, { preview });
    res.json(dna);
  }),
);

documentRoutes.post(
  '/:documentId/dna/normalize',
  asyncHandler(async (req, res) => {
    const dna = await getDocumentDna(req.params.documentId);
    if (!dna) {
      res.status(404).json({ error: 'Document has no DNA. Regenerate or create DNA first.' });
      return;
    }
    const abbrev = dna.abbreviationLogic && typeof dna.abbreviationLogic === 'object' ? dna.abbreviationLogic : {};
    const normalized = normalizeAbbreviationLogic(abbrev);
    const updated = await updateDocumentDna(req.params.documentId, {
      ...dna,
      abbreviationLogic: Object.keys(normalized).length > 0 ? normalized : dna.abbreviationLogic,
    });
    res.json(updated);
  }),
);

// DNA Enrichment from CSV
documentRoutes.post(
  '/:documentId/dna/enrich',
  upload.single('csvFile'),
  asyncHandler(async (req, res) => {
    if (!req.file) {
      res.status(400).json({ error: 'CSV file is required' });
      return;
    }

    const useLLM = req.body.useLLM !== 'false';
    const llmProvider = (req.body.llmProvider || 'gemini') as 'gemini' | 'openai' | 'yandex' | 'deepseek';

    // Start enrichment asynchronously (don't wait for completion)
    enrichDocumentDnaFromCSV(
      req.params.documentId,
      req.file.buffer,
      {
        useLLM,
        llmProvider,
      },
    ).catch((error) => {
      logger.error({ error, documentId: req.params.documentId }, 'Enrichment failed');
    });

    // Return immediately with progress tracking info
    res.json({
      success: true,
      message: 'Enrichment started. Use GET /documents/:documentId/dna/enrich/progress to track progress.',
    });
  }),
);

// Get enrichment progress
documentRoutes.get(
  '/:documentId/dna/enrich/progress',
  asyncHandler(async (req, res) => {
    try {
      const progress = getEnrichmentProgress(req.params.documentId);
      if (!progress) {
        res.status(404).json({ error: 'No enrichment progress found for this document' });
        return;
      }
      // Ensure all required fields exist with defaults
      const safeProgress = {
        ...progress,
        added: typeof progress.added === 'number' ? progress.added : 0,
        skipped: typeof progress.skipped === 'number' ? progress.skipped : 0,
        conflicts: typeof progress.conflicts === 'number' ? progress.conflicts : 0,
        errors: Array.isArray(progress.errors) ? progress.errors : [],
        current: typeof progress.current === 'number' ? progress.current : 0,
        total: typeof progress.total === 'number' ? progress.total : 0,
        batchNumber: typeof progress.batchNumber === 'number' ? progress.batchNumber : 0,
        totalBatches: typeof progress.totalBatches === 'number' ? progress.totalBatches : 0,
      };
      res.json(safeProgress);
    } catch (error) {
      logger.error({ error, documentId: req.params.documentId }, 'Failed to get enrichment progress');
      res.status(500).json({ error: 'Failed to get enrichment progress' });
    }
  }),
);

// Get all active enrichment progress
documentRoutes.get(
  '/dna/enrich/progress',
  asyncHandler(async (req, res) => {
    const allProgress = getAllActiveProgress();
    // Ensure all progress items have required fields
    const safeProgress = allProgress.map((p) => ({
      ...p,
      added: p.added ?? 0,
      skipped: p.skipped ?? 0,
      conflicts: p.conflicts ?? 0,
      errors: p.errors ?? [],
      current: p.current ?? 0,
      total: p.total ?? 0,
      batchNumber: p.batchNumber ?? 0,
      totalBatches: p.totalBatches ?? 0,
    }));
    res.json(safeProgress);
  }),
);

// Single term translation endpoint
const translateTermSchema = z.object({
  term: z.string().min(1),
  lang: z.string().optional(),
  sourceLang: z.string().optional(),
  projectId: z.string().uuid().optional(),
});

documentRoutes.post(
  '/translate-term',
  asyncHandler(async (req, res) => {
    const payload = translateTermSchema.parse(req.body);
    const translation = await translateSingleTerm(
      payload.term,
      payload.lang || 'ru',
      payload.sourceLang,
      payload.projectId,
    );
    res.json({ translation });
  }),
);

// ============================================
// UniversalJanitor Routes
// ============================================

const auditOptionsSchema = z.object({
  autoFix: z.boolean().optional(),
  strictMode: z.boolean().optional(),
  dryRun: z.boolean().optional(),
});

// Run audit
documentRoutes.post(
  '/:documentId/janitor/audit',
  asyncHandler(async (req, res) => {
    const documentId = req.params.documentId;
    const body = auditOptionsSchema.safeParse(req.body ?? {});
    
    if (!body.success) {
      res.status(400).json({ error: 'Invalid audit options', details: body.error.issues });
      return;
    }

    const janitor = new UniversalJanitor();
    const report = await janitor.auditSegments(documentId, {
      autoFix: body.data.autoFix ?? true,
      strictMode: body.data.strictMode ?? true,
      dryRun: body.data.dryRun ?? false,
    });

    res.json(report);
  }),
);

// Get audit report (if already run)
documentRoutes.get(
  '/:documentId/janitor/report',
  asyncHandler(async (req, res) => {
    const documentId = req.params.documentId;
    
    // Try to get the latest report from DocumentAnalysis executionLogs
    // For now, we'll run a fresh audit if no report is cached
    // TODO: Implement proper caching/storage of reports
    
    const janitor = new UniversalJanitor();
    const report = await janitor.auditSegments(documentId, {
      autoFix: false,
      strictMode: false,
      dryRun: true, // Don't save, just return report
    });

    res.json(report);
  }),
);
