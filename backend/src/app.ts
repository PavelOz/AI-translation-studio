import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import compression from 'compression';
import { apiV1 } from './api/v1';
import { errorHandler } from './utils/errorHandler';
import { logger } from './utils/logger';

export const createApp = () => {
  const app = express();

  app.use(helmet());
  app.use(
    cors({
      origin: '*',
      credentials: true,
    }),
  );
  app.use(express.json({ limit: '10mb' }));
  app.use(express.urlencoded({ extended: true }));
  app.use(compression());
  app.use((req, _res, next) => {
    logger.debug({ method: req.method, url: req.originalUrl }, 'Incoming request');
    next();
  });

  app.get('/health', (_req, res) => {
    res.json({ status: 'ok' });
  });

  app.use('/api', apiV1);

  app.use(errorHandler);

  return app;
};

