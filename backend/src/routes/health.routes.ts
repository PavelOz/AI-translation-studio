import { Router } from 'express';
import { asyncHandler } from '../utils/asyncHandler';
import { prisma } from '../db/prisma';
import { logger } from '../utils/logger';

export const healthRoutes = Router();

/**
 * Health check endpoint that verifies database connection
 * Returns status: 'ok' if database is connected, 'error' otherwise
 */
healthRoutes.get(
  '/health',
  asyncHandler(async (_req, res) => {
    try {
      // Simple database query to verify connection
      await prisma.$queryRaw`SELECT 1`;
      
      res.json({
        status: 'ok',
        database: 'connected',
        timestamp: new Date().toISOString(),
      });
    } catch (error: any) {
      logger.error(error, 'Health check failed - database connection error');
      res.status(503).json({
        status: 'error',
        database: 'disconnected',
        error: error.message || 'Database connection failed',
        timestamp: new Date().toISOString(),
      });
    }
  }),
);

