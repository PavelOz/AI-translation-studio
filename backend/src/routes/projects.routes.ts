import { Router } from 'express';
import multer from 'multer';
import { z } from 'zod';
import { asyncHandler } from '../utils/asyncHandler';
import { requireAuth, AuthenticatedRequest } from '../utils/authMiddleware';
import {
  createProject,
  getProject,
  listProjects,
  updateProjectStatus,
  updateProject,
  deleteProject,
  addProjectMember,
  removeProjectMember,
  getProjectMembers,
} from '../services/project.service';
import { getProjectDna, upsertProjectDna } from '../services/analysis.service';
import { validateDocumentDnaPayload, validateDnaForCycles } from '../services/dnaValidation';
import { validateDnaContract, formatValidationReport } from '../services/validate-dna';
import { getTranslationDirection } from '../services/dnaPrompts';
import { normalizeDocumentDnaPayload, sanitizeDocumentDnaPayloadForPut } from '../services/dnaSchema';
import { prisma } from '../db/prisma';
import { logger } from '../utils/logger';
import { listDocuments } from '../services/document.service';
import { importDocumentFile } from '../services/file.service';
import { ApiError } from '../utils/apiError';

const createProjectSchema = z.object({
  name: z.string(),
  description: z.string().optional(),
  clientName: z.string().optional(),
  sourceLocale: z.string().optional(),
  sourceLang: z.string().optional(),
  targetLocales: z.array(z.string()).optional(),
  targetLang: z.string().optional(),
  domain: z.string().optional(),
  dueDate: z.string().datetime().optional(),
}).refine(
  (v) => v.sourceLocale ?? v.sourceLang,
  { message: 'sourceLocale or sourceLang is required' },
).refine(
  (v) => (v.targetLocales?.length ?? 0) > 0 || v.targetLang,
  { message: 'targetLocales (non-empty) or targetLang is required' },
);

const updateProjectSchema = z.object({
  name: z.string().optional(),
  description: z.string().optional(),
  clientName: z.string().optional(),
  sourceLocale: z.string().optional(),
  sourceLang: z.string().optional(),
  targetLocales: z.array(z.string()).min(1).optional(),
  targetLang: z.string().optional(),
  domain: z.string().optional(),
  dueDate: z.string().datetime().optional(),
});

const statusSchema = z.object({
  status: z.enum(['PLANNING', 'IN_PROGRESS', 'COMPLETED', 'ON_HOLD']),
});

const addMemberSchema = z.object({
  userId: z.string().uuid(),
  role: z.enum(['ADMIN', 'PROJECT_MANAGER', 'LINGUIST']),
});

const projectUploadSchema = z.object({
  sourceLocale: z.string(),
  targetLocale: z.string(),
});

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } });

/** Same shape as document DNA; optional project defaults merged under document DNA at runtime. */
const projectDnaSchema = z.object({
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

export const projectRoutes = Router();

projectRoutes.use(requireAuth);

projectRoutes.get(
  '/',
  asyncHandler(async (req: AuthenticatedRequest, res) => {
    const projects = await listProjects(req.user!.userId);
    res.json(projects);
  }),
);

projectRoutes.post(
  '/',
  asyncHandler(async (req: AuthenticatedRequest, res) => {
    const payload = createProjectSchema.parse(req.body);
    const sourceLocale = payload.sourceLocale ?? payload.sourceLang ?? 'ru';
    const targetLocales = (payload.targetLocales?.length ? payload.targetLocales : [payload.targetLang ?? 'en']) as string[];
    const project = await createProject({
      name: payload.name,
      description: payload.description,
      clientName: payload.clientName,
      sourceLocale,
      sourceLang: payload.sourceLang ?? sourceLocale,
      targetLocales,
      targetLang: payload.targetLang ?? targetLocales[0],
      domain: payload.domain,
      dueDate: payload.dueDate ? new Date(payload.dueDate) : undefined,
      createdById: req.user!.userId,
    });
    res.status(201).json(project);
  }),
);

projectRoutes.get(
  '/:projectId/dna',
  asyncHandler(async (req, res) => {
    await getProject(req.params.projectId);
    const dna = await getProjectDna(req.params.projectId);
    res.json(dna);
  }),
);

projectRoutes.get(
  '/:projectId/dna/validate',
  asyncHandler(async (req, res) => {
    await getProject(req.params.projectId);
    const dna = await getProjectDna(req.params.projectId);
    const result = validateDocumentDnaPayload(dna ?? null);
    const abbreviationCount =
      dna?.abbreviationLogic && typeof dna.abbreviationLogic === 'object'
        ? Object.keys(dna.abbreviationLogic).length
        : 0;
    const project = await prisma.project.findUnique({
      where: { id: req.params.projectId },
      select: { sourceLocale: true, targetLocales: true },
    });
    let contractValidation = null;
    if (project?.sourceLocale && project.targetLocales?.length) {
      const direction = getTranslationDirection(project.sourceLocale, project.targetLocales[0]);
      contractValidation = validateDnaContract(dna ?? null, direction);
    }
    res.json({
      valid: result.valid,
      errors: result.errors,
      abbreviationCount,
      contractValidation: contractValidation
        ? {
            status: contractValidation.status,
            issues: contractValidation.issues,
            suggestions: contractValidation.suggestions,
            report: formatValidationReport(contractValidation),
          }
        : null,
    });
  }),
);

projectRoutes.put(
  '/:projectId/dna',
  asyncHandler(async (req, res) => {
    const projectId = req.params.projectId;
    await getProject(projectId);
    const parsed = projectDnaSchema.safeParse(req.body);
    if (!parsed.success) {
      const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`);
      res.status(400).json({ error: 'Invalid Project DNA payload', details: issues });
      return;
    }
    const sanitized = sanitizeDocumentDnaPayloadForPut(parsed.data as Record<string, unknown>);
    let normalized: ReturnType<typeof normalizeDocumentDnaPayload>;
    try {
      normalized = normalizeDocumentDnaPayload(sanitized);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(400).json({ error: 'Invalid Project DNA structure', details: [msg] });
      return;
    }
    const cycleCheck = validateDnaForCycles(normalized);
    if (!cycleCheck.valid) {
      res.status(400).json({ error: 'Project DNA recursion risk', details: cycleCheck.errors });
      return;
    }
    try {
      const project = await prisma.project.findUnique({
        where: { id: projectId },
        select: { sourceLocale: true, targetLocales: true },
      });
      if (project?.sourceLocale && project.targetLocales?.length) {
        const direction = getTranslationDirection(project.sourceLocale, project.targetLocales[0]);
        const contractValidation = validateDnaContract(normalized, direction);
        if (contractValidation.status === 'ERROR') {
          const errorMessages = contractValidation.issues.filter((i) => i.type === 'error').map((i) => i.message);
          res.status(400).json({
            error: 'Project DNA validation failed',
            details: errorMessages,
            report: formatValidationReport(contractValidation),
          });
          return;
        }
        if (contractValidation.status === 'WARNING') {
          logger.warn({ projectId, validation: contractValidation }, 'Project DNA validation warnings');
        }
      }
    } catch (validationErr: unknown) {
      logger.error(
        { projectId, error: validationErr instanceof Error ? validationErr.message : String(validationErr) },
        'Project DNA contract validation error',
      );
    }
    const updated = await upsertProjectDna(projectId, normalized);
    res.json(updated);
  }),
);

projectRoutes.get(
  '/:projectId',
  asyncHandler(async (req, res) => {
    const project = await getProject(req.params.projectId);
    res.json(project);
  }),
);

projectRoutes.patch(
  '/:projectId',
  asyncHandler(async (req, res) => {
    const payload = updateProjectSchema.parse(req.body);
    const project = await updateProject(req.params.projectId, {
      name: payload.name,
      description: payload.description,
      clientName: payload.clientName,
      sourceLocale: payload.sourceLocale,
      sourceLang: payload.sourceLang,
      targetLocales: payload.targetLocales,
      targetLang: payload.targetLang,
      domain: payload.domain,
      dueDate: payload.dueDate ? new Date(payload.dueDate) : undefined,
    });
    res.json(project);
  }),
);

projectRoutes.patch(
  '/:projectId/status',
  asyncHandler(async (req, res) => {
    const payload = statusSchema.parse(req.body);
    const project = await updateProjectStatus(req.params.projectId, payload.status);
    res.json(project);
  }),
);

projectRoutes.delete(
  '/:projectId',
  asyncHandler(async (req, res) => {
    await deleteProject(req.params.projectId);
    res.status(204).send();
  }),
);

projectRoutes.get(
  '/:projectId/members',
  asyncHandler(async (req, res) => {
    const members = await getProjectMembers(req.params.projectId);
    res.json(members);
  }),
);

projectRoutes.post(
  '/:projectId/members',
  asyncHandler(async (req, res) => {
    const payload = addMemberSchema.parse(req.body);
    const member = await addProjectMember(req.params.projectId, payload.userId, payload.role);
    res.status(201).json(member);
  }),
);

projectRoutes.delete(
  '/:projectId/members/:userId',
  asyncHandler(async (req, res) => {
    await removeProjectMember(req.params.projectId, req.params.userId);
    res.status(204).send();
  }),
);

projectRoutes.get(
  '/:projectId/documents',
  asyncHandler(async (req, res) => {
    const documents = await listDocuments(req.params.projectId);
    res.json(documents);
  }),
);

projectRoutes.post(
  '/:projectId/documents/upload',
  upload.single('file'),
  asyncHandler(async (req, res) => {
    if (!req.file) {
      throw ApiError.badRequest('File is required');
    }
    const payload = projectUploadSchema.parse(req.body);
    const document = await importDocumentFile(req.file, {
      projectId: req.params.projectId,
      sourceLocale: payload.sourceLocale,
      targetLocale: payload.targetLocale,
    });
    res.status(201).json(document);
  }),
);

