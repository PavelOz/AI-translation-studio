import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../utils/asyncHandler';
import { requireAuth } from '../utils/authMiddleware';
import { logger } from '../utils/logger';
import {
  generateSegmentSuggestions,
  runQualityAssurance,
  createAIRequest,
  getAIRequest,
  listAIRequests,
  updateAIRequestStatus,
  listAIProviders,
  getProjectAISettings,
  upsertProjectAISettings,
  getProjectGuidelines,
  upsertProjectGuidelines,
  translateTextDirectly,
  testAICredentials,
  runPostEditQA,
  generateDraftTranslation,
  runCritiqueCheck,
  fixTranslationWithErrors,
} from '../services/ai.service';

const documentSchema = z.object({
  documentId: z.string().uuid(),
});

const createRequestSchema = z.object({
  documentId: z.string().uuid(),
  type: z.enum(['TRANSLATION', 'QA', 'SUMMARY']),
  payload: z.record(z.string(), z.unknown()),
});

const updateStatusSchema = z.object({
  status: z.enum(['QUEUED', 'RUNNING', 'COMPLETED', 'FAILED']),
  result: z.record(z.string(), z.unknown()).optional(),
});

const aiSettingsSchema = z.object({
  provider: z.enum(['gemini', 'openai', 'yandex']),
  model: z.string(),
  temperature: z.number().min(0).max(1).optional(),
  maxTokens: z.number().positive().optional(),
  config: z.record(z.string(), z.unknown()).optional(),
});

const guidelineSchema = z.object({
  rules: z
    .array(
      z.object({
        title: z.string(),
        description: z.string().optional(),
        instruction: z.string().optional(),
      }),
    )
    .optional(),
});

export const aiRoutes = Router();

aiRoutes.use(requireAuth);

aiRoutes.get(
  '/providers',
  asyncHandler(async (_req, res) => {
    res.json(listAIProviders());
  }),
);

aiRoutes.get(
  '/projects/:projectId/ai-settings',
  asyncHandler(async (req, res) => {
    const settings = await getProjectAISettings(req.params.projectId);
    res.json(settings ?? null);
  }),
);

aiRoutes.post(
  '/projects/:projectId/ai-settings',
  asyncHandler(async (req, res) => {
    const payload = aiSettingsSchema.parse(req.body);
    
    // Log payload for debugging
    logger.debug({
      projectId: req.params.projectId,
      provider: payload.provider,
      model: payload.model,
      hasConfig: !!payload.config,
      configType: typeof payload.config,
      configKeys: payload.config ? Object.keys(payload.config) : [],
      configPreview: payload.config ? JSON.stringify(payload.config).substring(0, 200) : 'none',
    }, 'Saving project AI settings');
    
    const settings = await upsertProjectAISettings(req.params.projectId, payload);
    
    // Log saved settings for debugging
    logger.debug({
      projectId: req.params.projectId,
      provider: settings.provider,
      hasConfig: !!settings.config,
      configType: typeof settings.config,
      configIsNull: settings.config === null,
      configValue: settings.config ? JSON.stringify(settings.config).substring(0, 200) : 'none',
    }, 'Project AI settings saved');
    
    res.json(settings);
  }),
);

aiRoutes.get(
  '/projects/:projectId/guidelines',
  asyncHandler(async (req, res) => {
    const guidelines = await getProjectGuidelines(req.params.projectId);
    res.json(guidelines);
  }),
);

aiRoutes.post(
  '/projects/:projectId/guidelines',
  asyncHandler(async (req, res) => {
    const payload = guidelineSchema.parse(req.body);
    const guidelines = await upsertProjectGuidelines(req.params.projectId, payload.rules ?? []);
    res.json(guidelines);
  }),
);

aiRoutes.get(
  '/requests',
  asyncHandler(async (req, res) => {
    const documentId = req.query.documentId as string | undefined;
    const requests = await listAIRequests(documentId);
    res.json(requests);
  }),
);

aiRoutes.post(
  '/requests',
  asyncHandler(async (req, res) => {
    const payload = createRequestSchema.parse(req.body);
    const request = await createAIRequest(payload.documentId, payload.type, payload.payload);
    res.status(201).json(request);
  }),
);

aiRoutes.get(
  '/requests/:requestId',
  asyncHandler(async (req, res) => {
    const request = await getAIRequest(req.params.requestId);
    res.json(request);
  }),
);

aiRoutes.patch(
  '/requests/:requestId/status',
  asyncHandler(async (req, res) => {
    const payload = updateStatusSchema.parse(req.body);
    const request = await updateAIRequestStatus(req.params.requestId, payload.status, payload.result);
    res.json(request);
  }),
);

aiRoutes.post(
  '/suggestions',
  asyncHandler(async (req, res) => {
    const payload = documentSchema.parse(req.body);
    const suggestions = await generateSegmentSuggestions(payload.documentId);
    res.json(suggestions);
  }),
);

aiRoutes.post(
  '/qa',
  asyncHandler(async (req, res) => {
    const payload = documentSchema.parse(req.body);
    const report = await runQualityAssurance(payload.documentId);
    res.json(report);
  }),
);

const translateSchema = z.object({
  sourceText: z.string().min(1),
  sourceLocale: z.string(),
  targetLocale: z.string(),
  projectId: z.string().uuid().optional(),
  provider: z.enum(['gemini', 'openai', 'yandex']).optional(),
  model: z.string().optional(),
  temperature: z.number().min(0).max(1).optional(),
  maxTokens: z.number().positive().optional(),
  glossaryMode: z.enum(['off', 'strict_source', 'strict_semantic']).optional(),
});

aiRoutes.post(
  '/translate',
  asyncHandler(async (req, res) => {
    const payload = translateSchema.parse(req.body);
    const result = await translateTextDirectly(payload);
    res.json(result);
  }),
);

const testCredentialsSchema = z.object({
  provider: z.enum(['gemini', 'openai', 'yandex']),
  apiKey: z.string().optional(),
  yandexFolderId: z.string().optional(), // Required for YandexGPT
});

aiRoutes.post(
  '/test-credentials',
  asyncHandler(async (req, res) => {
    const payload = testCredentialsSchema.parse(req.body);
    const result = await testAICredentials(payload.provider, payload.apiKey, payload.yandexFolderId);
    res.json(result);
  }),
);

const postEditQASchema = z.object({
  sourceText: z.string().min(1),
  targetText: z.string().min(1),
  sourceLocale: z.string().min(2),
  targetLocale: z.string().min(2),
  projectId: z.string().uuid().optional(),
  provider: z.enum(['gemini', 'openai', 'yandex']).optional(),
  model: z.string().optional(),
  glossary: z.array(z.object({
    sourceTerm: z.string(),
    targetTerm: z.string(),
    forbidden: z.boolean().optional(),
  })).optional(),
});

aiRoutes.post(
  '/post-edit-qa',
  asyncHandler(async (req, res) => {
    const payload = postEditQASchema.parse(req.body);
    // Map 'forbidden' to 'isForbidden' for internal use
    const glossary = payload.glossary?.map((g) => ({
      sourceTerm: g.sourceTerm,
      targetTerm: g.targetTerm,
      isForbidden: g.forbidden ?? false,
    }));

    const result = await runPostEditQA({
      sourceText: payload.sourceText,
      targetText: payload.targetText,
      sourceLocale: payload.sourceLocale,
      targetLocale: payload.targetLocale,
      projectId: payload.projectId,
      provider: payload.provider,
      model: payload.model,
      glossary,
    });
    res.json(result);
  }),
);

// Interactive Critic Workflow - Step 1: Generate Draft
const step1DraftSchema = z.object({
  sourceText: z.string().min(1),
  projectId: z.string().uuid().optional(),
  sourceLocale: z.string().optional(),
  targetLocale: z.string().optional(),
  provider: z.enum(['gemini', 'openai', 'yandex']).optional(),
  model: z.string().optional(),
  apiKey: z.string().optional(),
  temperature: z.number().min(0).max(1).optional(),
  maxTokens: z.number().positive().optional(),
});

aiRoutes.post(
  '/step1-draft',
  asyncHandler(async (req, res) => {
    const payload = step1DraftSchema.parse(req.body);
    const result = await generateDraftTranslation(payload);
    res.json(result);
  }),
);

// Interactive Critic Workflow - Step 2: Run Critique
const step2CritiqueSchema = z.object({
  sourceText: z.string().min(1),
  draftText: z.string().min(1),
  projectId: z.string().uuid().optional(),
  sourceLocale: z.string().optional(),
  targetLocale: z.string().optional(),
  provider: z.enum(['gemini', 'openai', 'yandex']).optional(),
  model: z.string().optional(),
  apiKey: z.string().optional(),
});

aiRoutes.post(
  '/step2-critique',
  asyncHandler(async (req, res) => {
    const payload = step2CritiqueSchema.parse(req.body);
    const result = await runCritiqueCheck(payload);
    res.json(result);
  }),
);

// Interactive Critic Workflow - Step 3: Fix Translation
const step3FixSchema = z.object({
  sourceText: z.string().min(1),
  draftText: z.string().min(1),
  errors: z.array(
    z.object({
      term: z.string().min(1),
      expected: z.string().min(1),
      found: z.string().min(1),
      severity: z.string().optional().default('error'),
    }),
  ).refine(
    (errors) => errors.every((e) => e.term && e.expected && e.found),
    { message: 'All error objects must have term, expected, and found fields' }
  ),
  projectId: z.string().uuid().optional(),
  sourceLocale: z.string().optional(),
  targetLocale: z.string().optional(),
  provider: z.enum(['gemini', 'openai', 'yandex']).optional(),
  model: z.string().optional(),
  apiKey: z.string().optional(),
  temperature: z.number().min(0).max(1).optional(),
  maxTokens: z.number().positive().optional(),
});

aiRoutes.post(
  '/step3-fix',
  asyncHandler(async (req, res) => {
    const payload = step3FixSchema.parse(req.body);
    const result = await fixTranslationWithErrors(payload);
    res.json(result);
  }),
);

