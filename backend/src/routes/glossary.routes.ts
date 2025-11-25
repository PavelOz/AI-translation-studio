import { Router } from 'express';
import multer from 'multer';
import { z } from 'zod';
import { asyncHandler } from '../utils/asyncHandler';
import { requireAuth } from '../utils/authMiddleware';
import { listGlossaryEntries, upsertGlossaryEntry, getGlossaryEntry, deleteGlossaryEntry, importGlossaryCsv } from '../services/glossary.service';
import { ApiError } from '../utils/apiError';

const upsertSchema = z.object({
  id: z.string().uuid().optional(),
  projectId: z.string().uuid().optional(),
  sourceTerm: z.string(),
  targetTerm: z.string(),
  sourceLocale: z.string(),
  targetLocale: z.string(),
  description: z.string().optional(),
  status: z.enum(['PREFERRED', 'DEPRECATED']).optional(),
  forbidden: z.boolean().optional(),
  notes: z.string().optional(),
});

const importSchema = z.object({
  projectId: z.string().uuid().optional(),
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
    const payload = upsertSchema.parse(req.body);
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

