import { Router } from 'express';
import multer from 'multer';
import { z } from 'zod';
import { asyncHandler } from '../utils/asyncHandler';
import { requireAuth } from '../utils/authMiddleware';
import { listGlossaryEntries, upsertGlossaryEntry, getGlossaryEntry, deleteGlossaryEntry, importGlossaryCsv } from '../services/glossary.service';
import { findRelevantGlossaryEntries } from '../services/glossary-search.service';
import { getGlossaryEmbeddingStats } from '../services/vector-search.service';
import { ApiError } from '../utils/apiError';

const contextRulesSchema = z.object({
  useOnlyIn: z.array(z.string()).optional(),
  excludeFrom: z.array(z.string()).optional(),
  documentTypes: z.array(z.string()).optional(),
  requires: z.array(z.string()).optional(),
}).optional().nullable();

const upsertSchema = z.object({
  id: z.string().uuid().optional(),
  projectId: z.string().uuid().optional().nullable(),
  sourceTerm: z.string(),
  targetTerm: z.string(),
  sourceLocale: z.string(),
  targetLocale: z.string(),
  description: z.string().optional().nullable(),
  status: z.enum(['CANDIDATE', 'PREFERRED', 'DEPRECATED']).optional(),
  forbidden: z.boolean().optional(),
  notes: z.string().optional().nullable(),
  contextRules: contextRulesSchema,
});

const importSchema = z.object({
  projectId: z.string().uuid().optional(),
});

const searchSchema = z.object({
  sourceText: z.string().min(1),
  projectId: z.string().uuid().optional(),
  sourceLocale: z.string().optional(),
  targetLocale: z.string().optional(),
  minSimilarity: z.number().min(0).max(1).optional(),
});

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });

export const glossaryRoutes = Router();

glossaryRoutes.use(requireAuth);

glossaryRoutes.get(
  '/',
  asyncHandler(async (req, res) => {
    const entries = await listGlossaryEntries(
      req.query.projectId as string | undefined,
      req.query.sourceLocale as string | undefined,
      req.query.targetLocale as string | undefined,
    );
    res.json(entries);
  }),
);

glossaryRoutes.post(
  '/',
  asyncHandler(async (req, res) => {
    const payload = upsertSchema.parse(req.body);
    const entry = await upsertGlossaryEntry(payload);
    res.status(201).json(entry);
  }),
);

// Specific routes must come before parameterized routes (/:entryId)
glossaryRoutes.get(
  '/embedding-stats',
  asyncHandler(async (req, res) => {
    const stats = await getGlossaryEmbeddingStats(
      req.query.projectId as string | undefined,
    );
    res.json(stats);
  }),
);

glossaryRoutes.post(
  '/import',
  upload.single('file'),
  asyncHandler(async (req, res) => {
    if (!req.file) {
      throw ApiError.badRequest('Glossary file is required');
    }
    const payload = importSchema.parse(req.body);
    const result = await importGlossaryCsv(req.file.buffer, payload.projectId);
    res.status(201).json(result);
  }),
);

glossaryRoutes.post(
  '/search',
  asyncHandler(async (req, res) => {
    const payload = searchSchema.parse(req.body);

    const results = await findRelevantGlossaryEntries(payload.sourceText, {
      projectId: payload.projectId,
      sourceLocale: payload.sourceLocale,
      targetLocale: payload.targetLocale,
      minSimilarity: payload.minSimilarity,
    });

    res.json(results);
  }),
);

// Parameterized routes come last
glossaryRoutes.get(
  '/:entryId',
  asyncHandler(async (req, res) => {
    const entry = await getGlossaryEntry(req.params.entryId);
    res.json(entry);
  }),
);

glossaryRoutes.patch(
  '/:entryId',
  asyncHandler(async (req, res) => {
    // For PATCH, don't require id in body since it's in URL params
    // Also allow partial updates (make most fields optional)
    const patchSchema = upsertSchema.partial().extend({
      id: z.string().uuid().optional(), // ID is optional in body since it's in URL
      sourceTerm: z.string().optional(),
      targetTerm: z.string().optional(),
      sourceLocale: z.string().optional(),
      targetLocale: z.string().optional(),
    });
    const payload = patchSchema.parse(req.body);
    const entry = await upsertGlossaryEntry({ ...payload, id: req.params.entryId });
    res.json(entry);
  }),
);

glossaryRoutes.delete(
  '/:entryId',
  asyncHandler(async (req, res) => {
    await deleteGlossaryEntry(req.params.entryId);
    res.status(204).send();
  }),
);

