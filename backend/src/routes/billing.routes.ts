import { Router } from 'express';
import type { AuthenticatedRequest } from '../utils/authMiddleware';
import { requireAuth } from '../utils/authMiddleware';
import { getBillingTodayForUser } from '../services/billing-manager.service';
import { env } from '../utils/env';

export const billingRoutes = Router();

billingRoutes.get('/today', requireAuth, (req: AuthenticatedRequest, res) => {
  const userId = req.user!.userId;
  const status = getBillingTodayForUser(userId);
  res.json({
    ...status,
    userId,
    minRemainingForExpensiveUsd: env.billingProMinRemainingUsd,
    powerRoles: env.billingPowerRoles,
  });
});
