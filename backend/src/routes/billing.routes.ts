import { Router, type Request, type Response, type NextFunction } from 'express';
import { z } from 'zod';
import type { AuthenticatedRequest } from '../utils/authMiddleware';
import { requireAdmin, requireAuth } from '../utils/authMiddleware';
import { getBillingTodayForUser } from '../services/billing-manager.service';
import { getBillingConfig, getBillingSettingsForAdmin, updateBillingSettings } from '../services/billing-config.service';
import {
  estimatePretranslateTranslationCost,
  estimateBatchTranslationCost,
} from '../services/translation-cost-estimate.service';
import { readBundledPricingFile, writeBundledPricingFile } from '../services/billing-pricing.fs';
import { pricingFileSchema } from '../services/billing-pricing.schema';
import { invalidateBundledFileCache } from '../services/billing-pricing.runtime';
import { ApiError } from '../utils/apiError';

export const billingRoutes = Router();

const estimateTranslationBodySchema = z.discriminatedUnion('workflow', [
  z.object({
    workflow: z.literal('pretranslate'),
    documentId: z.string().uuid(),
    applyAiToLowMatches: z.boolean().optional(),
    applyAiToEmptyOnly: z.boolean().optional(),
    rewriteConfirmed: z.boolean().optional(),
    rewriteNonConfirmed: z.boolean().optional(),
    useCritic: z.boolean().optional(),
    provider: z.enum(['gemini', 'openai', 'yandex', 'deepseek']).optional(),
    model: z.string().optional(),
    skipTm: z.boolean().optional(),
  }),
  z.object({
    workflow: z.literal('batch'),
    documentId: z.string().uuid(),
    mode: z.enum(['translate_all', 'pre_translate']),
    options: z
      .object({
        applyTm: z.boolean().optional(),
        minScore: z.number().min(0).max(100).optional(),
        mtOnlyEmpty: z.boolean().optional(),
        mtOnlyNonEmpty: z.boolean().optional(),
        rewriteNonConfirmed: z.boolean().optional(),
        useCritic: z.boolean().optional(),
        glossaryMode: z.enum(['off', 'strict_source', 'strict_semantic']).optional(),
      })
      .optional(),
  }),
]);

const settingsBodySchema = z.object({
  enabled: z.boolean(),
  dailyCapUsd: z.number().positive().max(1_000_000),
  proMinRemainingUsd: z.number().min(0).max(1_000_000),
  warnInputTokens: z.number().int().min(100).max(10_000_000),
  maxPromptChars: z.number().int().min(10_000).max(50_000_000),
  powerRoles: z.array(z.enum(['ADMIN', 'PROJECT_MANAGER', 'LINGUIST'])).min(1),
  /** Omit to leave unchanged; null = use bundled billing-pricing.v1.json on disk */
  pricingJson: z.union([pricingFileSchema, z.null()]).optional(),
});

const sendBundledPricing = (_req: Request, res: Response, next: NextFunction) => {
  try {
    res.json(readBundledPricingFile());
  } catch (error) {
    next(error);
  }
};

/** Current on-disk registry (same path as backend/config/billing-pricing.v1.json). */
billingRoutes.get('/bundled-pricing', requireAuth, requireAdmin, sendBundledPricing);
/** @deprecated Use GET /bundled-pricing */
billingRoutes.get('/pricing-template', requireAuth, requireAdmin, sendBundledPricing);

billingRoutes.put('/bundled-pricing', requireAuth, requireAdmin, async (req, res, next) => {
  try {
    const parsed = pricingFileSchema.safeParse(req.body);
    if (!parsed.success) {
      return next(ApiError.badRequest(parsed.error.issues.map((i) => i.message).join('; ')));
    }
    writeBundledPricingFile(parsed.data);
    invalidateBundledFileCache();
    const active = await getBillingSettingsForAdmin();
    res.json({
      pricing: parsed.data,
      activePricingSource: active.pricingSource,
      hint:
        active.pricingSource === 'database'
          ? 'Saved to disk. Runtime still uses the database copy until you clear it (use “Server file” mode and save settings, or set pricingJson to null).'
          : undefined,
    });
  } catch (error) {
    next(error);
  }
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

billingRoutes.post('/estimate-translation', requireAuth, async (req: AuthenticatedRequest, res, next) => {
  try {
    const parsed = estimateTranslationBodySchema.safeParse(req.body);
    if (!parsed.success) {
      return next(
        ApiError.badRequest(
          parsed.error.issues.map((i: z.ZodIssue) => i.message).join('; '),
        ),
      );
    }
    const userId = req.user!.userId;
    const payload = parsed.data;
    if (payload.workflow === 'pretranslate') {
      const est = await estimatePretranslateTranslationCost(payload.documentId, userId, {
        applyAiToLowMatches: payload.applyAiToLowMatches,
        applyAiToEmptyOnly: payload.applyAiToEmptyOnly,
        rewriteConfirmed: payload.rewriteConfirmed,
        rewriteNonConfirmed: payload.rewriteNonConfirmed,
        useCritic: payload.useCritic,
        provider: payload.provider,
        model: payload.model,
        skipTm: payload.skipTm,
      });
      return res.json(est);
    }
    const est = await estimateBatchTranslationCost(payload.documentId, userId, payload.mode, payload.options);
    res.json(est);
  } catch (error) {
    next(error);
  }
});
