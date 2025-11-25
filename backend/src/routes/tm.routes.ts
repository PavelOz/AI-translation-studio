import { Router } from 'express';
import multer from 'multer';
import { z } from 'zod';
import fs from 'fs/promises';
import path from 'path';
import { asyncHandler } from '../utils/asyncHandler';
import { requireAuth, AuthenticatedRequest } from '../utils/authMiddleware';
import {
  addTranslationMemoryEntry,
  searchTranslationMemory,
  listTranslationMemoryEntries,
  getTranslationMemoryEntry,
  updateTranslationMemoryEntry,
  deleteTranslationMemoryEntry,
  importTmxEntries,
  linkTmxFile,
} from '../services/tm.service';
import {
  generateEmbeddingsForExistingEntries,
  getEmbeddingGenerationProgress,
  cancelEmbeddingGeneration,
  getActiveProgressIds,
} from '../services/embedding-generation.service';
import { getEmbeddingStats } from '../services/vector-search.service';
import { ApiError } from '../utils/apiError';
import { env } from '../utils/env';

const searchSchema = z.object({
  sourceText: z.string(),
  sourceLocale: z.string(),
  targetLocale: z.string(),
  projectId: z.string().uuid().optional(),
  limit: z.number().int().min(1).max(100).optional(),
  minScore: z.number().int().min(0).max(100).optional(),
  vectorSimilarity: z.number().int().min(0).max(100).optional(), // Vector search similarity threshold
  mode: z.enum(['basic', 'extended']).optional(), // Search mode: 'basic' = strict, 'extended' = relaxed thresholds
  useVectorSearch: z.boolean().optional(), // Whether to use semantic (vector) search
});

const entrySchema = z.object({
  projectId: z.string().uuid().optional(),
  sourceLocale: z.string(),
  targetLocale: z.string(),
  sourceText: z.string(),
  targetText: z.string(),
  clientName: z.string().optional(),
  domain: z.string().optional(),
});

const updateEntrySchema = z.object({
  sourceText: z.string().optional(),
  targetText: z.string().optional(),
  matchRate: z.number().min(0).max(1).optional(),
});

const importSchema = z.object({
  projectId: z.string().uuid().optional(),
  clientName: z.string().optional(),
  domain: z.string().optional(),
});

const linkTmxSchema = z.object({
  filename: z.string().optional(),
  externalUrl: z.string().url().optional(),
  storagePath: z.string().optional(),
  projectId: z.string().uuid().optional(),
  clientName: z.string().optional(),
  domain: z.string().optional(),
});

// Configure multer to preserve UTF-8 encoding for filenames (including Cyrillic)
// Multer handles UTF-8 filenames correctly when sent from modern browsers
const upload = multer({ 
  storage: multer.memoryStorage(),
  limits: { fileSize: 200 * 1024 * 1024 }, // 200MB limit for TMX files
});

export const tmRoutes = Router();

tmRoutes.use(requireAuth);

tmRoutes.post(
  '/import-tmx',
  (req, res, next) => {
    upload.single('file')(req, res, (err) => {
      if (err) {
        if (err.code === 'LIMIT_FILE_SIZE') {
          return next(ApiError.badRequest('File too large. Maximum size is 200MB.'));
        }
        return next(ApiError.badRequest(err.message || 'File upload error'));
      }
      next();
    });
  },
  asyncHandler(async (req: AuthenticatedRequest, res) => {
    if (!req.file) {
      throw ApiError.badRequest('TMX file is required');
    }
    const payload = importSchema.parse(req.body);
    
    // Store the TMX file
    // Preserve original filename encoding (including Cyrillic characters)
    const sanitizedFilename = Buffer.from(req.file.originalname, 'latin1').toString('utf8');
    const storagePath = path.join(env.fileStorageDir, 'tmx', `${Date.now()}_${sanitizedFilename}`);
    await fs.mkdir(path.dirname(storagePath), { recursive: true });
    await fs.writeFile(storagePath, req.file.buffer);
    
    const result = await importTmxEntries(req.file.buffer, {
      ...payload,
      createdById: req.user!.userId,
      filename: Buffer.from(req.file.originalname, 'latin1').toString('utf8'),
      storagePath,
    });
    res.status(201).json(result);
  }),
);

tmRoutes.get(
  '/search',
  asyncHandler(async (req, res) => {
    const sourceText = req.query.source_text as string | undefined;
    if (!sourceText) {
      throw ApiError.badRequest('source_text is required');
    }
    const projectId = req.query.project_id as string | undefined;
    const sourceLocale = (req.query.source_locale as string) ?? 'source';
    const targetLocale = (req.query.target_locale as string) ?? 'target';
    const limit = req.query.limit ? Number(req.query.limit) : 25;
    const minScore = req.query.min_score ? Number(req.query.min_score) : 60;

    const matches = await searchTranslationMemory({
      sourceText,
      sourceLocale,
      targetLocale,
      projectId,
      limit,
      minScore,
    });
    res.json(matches);
  }),
);

tmRoutes.post(
  '/add',
  asyncHandler(async (req: AuthenticatedRequest, res) => {
    const payload = entrySchema.parse(req.body);
    const entry = await addTranslationMemoryEntry({
      ...payload,
      createdById: req.user!.userId,
    });
    res.status(201).json(entry);
  }),
);

tmRoutes.get(
  '/entries',
  asyncHandler(async (req, res) => {
    const projectId = req.query.projectId as string | undefined;
    const globalOnly = req.query.globalOnly === 'true';
    const page = parseInt(req.query.page as string, 10) || 1;
    const limit = parseInt(req.query.limit as string, 10) || 50;
    const result = await listTranslationMemoryEntries(projectId, page, limit, globalOnly);
    res.json(result);
  }),
);

tmRoutes.post(
  '/search',
  asyncHandler(async (req, res) => {
    const payload = searchSchema.parse(req.body);
    const matches = await searchTranslationMemory({
      ...payload,
      vectorSimilarity: payload.vectorSimilarity,
      mode: payload.mode,
      useVectorSearch: payload.useVectorSearch,
    });
    res.json(matches);
  }),
);

tmRoutes.post(
  '/entries',
  asyncHandler(async (req: AuthenticatedRequest, res) => {
    const payload = entrySchema.parse(req.body);
    const entry = await addTranslationMemoryEntry({
      ...payload,
      createdById: req.user!.userId,
    });
    res.status(201).json(entry);
  }),
);

tmRoutes.get(
  '/entries/:entryId',
  asyncHandler(async (req, res) => {
    const entry = await getTranslationMemoryEntry(req.params.entryId);
    res.json(entry);
  }),
);

tmRoutes.patch(
  '/entries/:entryId',
  asyncHandler(async (req, res) => {
    const payload = updateEntrySchema.parse(req.body);
    const entry = await updateTranslationMemoryEntry(req.params.entryId, payload);
    res.json(entry);
  }),
);

tmRoutes.delete(
  '/entries/:entryId',
  asyncHandler(async (req, res) => {
    await deleteTranslationMemoryEntry(req.params.entryId);
    res.status(204).send();
  }),
);

// Link external TMX file (without importing entries)
tmRoutes.post(
  '/link-tmx',
  (req, res, next) => {
    upload.single('file')(req, res, (err) => {
      if (err) {
        if (err.code === 'LIMIT_FILE_SIZE') {
          return next(ApiError.badRequest('File too large. Maximum size is 200MB.'));
        }
        return next(ApiError.badRequest(err.message || 'File upload error'));
      }
      next();
    });
  },
  asyncHandler(async (req: AuthenticatedRequest, res) => {
    const payload = linkTmxSchema.parse(req.body);
    
    // If file is uploaded, store it and use storagePath
    // Otherwise, require externalUrl or storagePath
    let storagePath: string | undefined;
    let filename: string | undefined;
    
    if (req.file) {
      // Preserve original filename encoding (including Cyrillic characters)
      const sanitizedFilename = Buffer.from(req.file.originalname, 'latin1').toString('utf8');
      filename = sanitizedFilename;
      storagePath = path.join(env.fileStorageDir, 'tmx', `${Date.now()}_${sanitizedFilename}`);
      await fs.mkdir(path.dirname(storagePath), { recursive: true });
      await fs.writeFile(storagePath, req.file.buffer);
    } else if (!payload.externalUrl && !payload.storagePath) {
      throw ApiError.badRequest('Either a file, externalUrl, or storagePath must be provided');
    } else {
      filename = payload.filename;
      storagePath = payload.storagePath;
    }

    const result = await linkTmxFile({
      filename: filename || payload.filename || 'linked-tmx.tmx',
      externalUrl: payload.externalUrl,
      storagePath,
      projectId: payload.projectId,
      clientName: payload.clientName,
      domain: payload.domain,
      createdById: req.user!.userId,
    });
    
    res.status(201).json(result);
  }),
);

// Embedding generation routes
tmRoutes.post(
  '/generate-embeddings',
  asyncHandler(async (req: AuthenticatedRequest, res) => {
    const schema = z.object({
      projectId: z.string().uuid().optional(),
      batchSize: z.number().int().min(1).max(200).optional(),
      limit: z.number().int().min(1).optional(), // For testing
    });
    
    const payload = schema.parse(req.body);
    
    const progressId = await generateEmbeddingsForExistingEntries({
      projectId: payload.projectId,
      batchSize: payload.batchSize,
      limit: payload.limit,
    });
    
    res.json({ progressId });
  }),
);

tmRoutes.get(
  '/embedding-progress/:progressId',
  asyncHandler(async (req, res) => {
    const { progressId } = req.params;
    const progress = getEmbeddingGenerationProgress(progressId);
    
    if (!progress) {
      throw ApiError.notFound('Progress not found');
    }
    
    res.json(progress);
  }),
);

tmRoutes.post(
  '/embedding-progress/:progressId/cancel',
  asyncHandler(async (req, res) => {
    const { progressId } = req.params;
    cancelEmbeddingGeneration(progressId);
    res.json({ message: 'Cancellation requested' });
  }),
);

tmRoutes.get(
  '/embedding-stats',
  asyncHandler(async (req, res) => {
    const projectId = req.query.projectId as string | undefined;
    const stats = await getEmbeddingStats(projectId ? { projectId } : undefined);
    res.json(stats);
  }),
);

tmRoutes.get(
  '/embedding-progress',
  asyncHandler(async (req, res) => {
    const activeIds = getActiveProgressIds();
    const progress = activeIds.map((id) => getEmbeddingGenerationProgress(id)).filter(Boolean);
    res.json(progress);
  }),
);

