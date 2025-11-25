import type { ErrorRequestHandler } from 'express';
import { ApiError } from './apiError';
import { logger } from './logger';
import { Prisma } from '@prisma/client';

export const errorHandler: ErrorRequestHandler = (err, _req, res, _next) => {
  if (err instanceof ApiError) {
    return res.status(err.status).json({ error: err.message });
  }

  // Handle Prisma foreign key constraint errors
  if (err instanceof Prisma.PrismaClientKnownRequestError) {
    if (err.code === 'P2003') {
      logger.error(err, 'Foreign key constraint violation');
      return res.status(400).json({
        error: 'Invalid reference: The referenced record does not exist',
        details: err.meta,
      });
    }
    // Handle other Prisma errors
    logger.error(err, 'Prisma error');
    return res.status(400).json({
      error: 'Database error',
      code: err.code,
      details: err.meta,
    });
  }

  logger.error(err, 'Unhandled error');
  return res.status(500).json({ error: 'Internal server error' });
};

