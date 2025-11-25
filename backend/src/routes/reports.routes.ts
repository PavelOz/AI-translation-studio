import { Router } from 'express';
import { asyncHandler } from '../utils/asyncHandler';
import { requireAuth } from '../utils/authMiddleware';
import {
  getProjectReportsOverview,
  getProjectPerformanceReport,
  getUserPerformanceReport,
} from '../services/report.service';

export const reportRoutes = Router();

reportRoutes.use(requireAuth);

reportRoutes.get(
  '/projects',
  asyncHandler(async (req, res) => {
    const client = req.query.client as string | undefined;
    const domain = req.query.domain as string | undefined;
    const dateFrom = req.query.date_from ? new Date(String(req.query.date_from)) : undefined;
    const dateTo = req.query.date_to ? new Date(String(req.query.date_to)) : undefined;
    const reports = await getProjectReportsOverview({ client, domain, dateFrom, dateTo });
    res.json(reports);
  }),
);

reportRoutes.get(
  '/projects/:projectId',
  asyncHandler(async (req, res) => {
    const report = await getProjectPerformanceReport(req.params.projectId);
    res.json(report);
  }),
);

reportRoutes.get(
  '/users/:userId',
  asyncHandler(async (req, res) => {
    const report = await getUserPerformanceReport(req.params.userId);
    res.json(report);
  }),
);

