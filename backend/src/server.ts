import http from 'http';
import { createApp } from './app';
import { env } from './utils/env';
import { logger } from './utils/logger';

const app = createApp();
const server = http.createServer(app);

server.listen(env.port, () => {
  logger.info(`AI Translation Studio backend listening on port ${env.port}`);
});

