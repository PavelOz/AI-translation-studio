import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../utils/asyncHandler';
import { requireAuth } from '../utils/authMiddleware';
import { sendChatMessage, getChatHistory, saveExtractedRules } from '../services/chat.service';

const chatMessageSchema = z.object({
  projectId: z.string().uuid(),
  documentId: z.string().uuid().optional(),
  segmentId: z.string().uuid().optional(),
  message: z.string().min(1).max(5000),
});

const getHistorySchema = z.object({
  documentId: z.string().uuid().optional(),
  segmentId: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});

const saveRulesSchema = z.object({
  rules: z.array(z.string()).min(1),
});

export const chatRoutes = Router();

chatRoutes.use(requireAuth);

chatRoutes.post(
  '/projects/:projectId/chat',
  asyncHandler(async (req, res) => {
    const payload = chatMessageSchema.parse({
      ...req.body,
      projectId: req.params.projectId,
    });
    const response = await sendChatMessage(payload, req.user!.userId);
    res.json(response);
  }),
);

chatRoutes.get(
  '/projects/:projectId/chat',
  asyncHandler(async (req, res) => {
    const params = getHistorySchema.parse(req.query);
    const history = await getChatHistory(
      req.params.projectId,
      params.documentId,
      params.segmentId,
      params.limit,
    );
    res.json(history);
  }),
);

chatRoutes.post(
  '/projects/:projectId/chat/save-rules',
  asyncHandler(async (req, res) => {
    const payload = saveRulesSchema.parse(req.body);
    await saveExtractedRules(req.params.projectId, payload.rules);
    res.json({ success: true, message: 'Rules saved to project guidelines' });
  }),
);

