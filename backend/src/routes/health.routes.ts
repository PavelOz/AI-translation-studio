import { Router } from 'express';
import { asyncHandler } from '../utils/asyncHandler';
import { prisma } from '../db/prisma';
import { logger } from '../utils/logger';
import { DocxHandler } from '../utils/file-handlers/docx.handler';

export const healthRoutes = Router();

/**
 * Health check endpoint that verifies database connection
 * Returns status: 'ok' if database is connected, 'error' otherwise
 */
healthRoutes.get(
  '/',
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

/**
 * System status endpoint that includes LibreOffice status
 */
healthRoutes.get(
  '/status',
  asyncHandler(async (_req, res) => {
    try {
      // Check database connection
      await prisma.$queryRaw`SELECT 1`;
      
      // Check LibreOffice status
      const docxHandler = new DocxHandler();
      const libreOfficeStatus = await docxHandler.getLibreOfficeStatus();
      
      res.json({
        status: 'ok',
        database: 'connected',
        libreOffice: libreOfficeStatus,
        timestamp: new Date().toISOString(),
      });
    } catch (error: any) {
      logger.error(error, 'Status check failed');
      res.status(503).json({
        status: 'error',
        error: error.message || 'Status check failed',
        timestamp: new Date().toISOString(),
      });
    }
  }),
);

