import { PrismaClient } from '@prisma/client';
import { logger } from '../utils/logger';

export const prisma = new PrismaClient();

prisma
  .$connect()
  .then(() => logger.info('Connected to PostgreSQL via Prisma'))
  .catch((error) => {
    logger.error(error, 'Failed to connect to database');
    process.exit(1);
  });

