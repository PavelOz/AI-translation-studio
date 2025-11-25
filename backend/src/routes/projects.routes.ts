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
import { listDocuments } from '../services/document.service';
import { importDocumentFile } from '../services/file.service';
import { ApiError } from '../utils/apiError';

const createProjectSchema = z
  .object({
    name: z.string(),
    description: z.string().optional(),
    clientName: z.string().optional(),
    sourceLocale: z.string().optional(),
    sourceLang: z.string().optional(),
    targetLocales: z.array(z.string()).min(1).optional(),
    targetLang: z.string().optional(),
    domain: z.string().optional(),
    dueDate: z.string().datetime().optional(),
  })
  .refine(
    (value) => value.sourceLocale || value.sourceLang,
    'sourceLocale or sourceLang is required',
  )
  .refine(
    (value) => value.targetLocales || value.targetLang,
    'targetLocales or targetLang is required',
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
    const project = await createProject({
      name: payload.name,
      description: payload.description,
      clientName: payload.clientName,
      sourceLocale: payload.sourceLocale ?? payload.sourceLang!,
      sourceLang: payload.sourceLang ?? payload.sourceLocale!,
      targetLocales: payload.targetLocales ?? [payload.targetLang!],
      targetLang: payload.targetLang ?? payload.targetLocales![0],
      domain: payload.domain,
      dueDate: payload.dueDate ? new Date(payload.dueDate) : undefined,
      createdById: req.user!.userId,
    });
    res.status(201).json(project);
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

