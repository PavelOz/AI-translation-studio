import { Router } from 'express';
import { z } from 'zod';
import type { AuthenticatedRequest } from '../utils/authMiddleware';
import { requireAdmin, requireAuth } from '../utils/authMiddleware';
import { getBillingTodayForUser } from '../services/billing-manager.service';
import { getBillingConfig, getBillingSettingsForAdmin, updateBillingSettings } from '../services/billing-config.service';
import { ApiError } from '../utils/apiError';

export const billingRoutes = Router();

const settingsBodySchema = z.object({
  enabled: z.boolean(),
  dailyCapUsd: z.number().positive().max(1_000_000),
  proMinRemainingUsd: z.number().min(0).max(1_000_000),
  warnInputTokens: z.number().int().min(100).max(10_000_000),
  maxPromptChars: z.number().int().min(10_000).max(50_000_000),
  powerRoles: z.array(z.enum(['ADMIN', 'PROJECT_MANAGER', 'LINGUIST'])).min(1),
});

billingRoutes.get('/settings', requireAuth, requireAdmin, async (_req, res, next) => {
  try {
    const s = await getBillingSettingsForAdmin();
    res.json(s);
  } catch (error) {
    next(error);
  }
});

billingRoutes.put('/settings', requireAuth, requireAdmin, async (req, res, next) => {
  try {
    const parsed = settingsBodySchema.safeParse(req.body);
    if (!parsed.success) {
      return next(ApiError.badRequest(parsed.error.issues.map((i) => i.message).join('; ')));
    }
    const s = await updateBillingSettings(parsed.data);
    res.json(s);
  } catch (error) {
    next(error);
  }
});

billingRoutes.get('/today', requireAuth, (req: AuthenticatedRequest, res) => {
  const userId = req.user!.userId;
  const status = getBillingTodayForUser(userId);
  const cfg = getBillingConfig();
  res.json({
    ...status,
    userId,
    minRemainingForExpensiveUsd: cfg.proMinRemainingUsd,
    powerRoles: cfg.powerRoles,
  });
});
