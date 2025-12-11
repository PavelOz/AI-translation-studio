import http from 'http';
import { createApp } from './app';
import { env } from './utils/env';
import { logger } from './utils/logger';
import { DocxHandler } from './utils/file-handlers/docx.handler';
import { cleanupStaleAnalyses } from './services/analysis.service';

const app = createApp();
const server = http.createServer(app);

// Check LibreOffice availability on startup
const checkLibreOffice = async () => {
  if (env.useLibreOffice) {
    const docxHandler = new DocxHandler();
    const status = await docxHandler.getLibreOfficeStatus();
    
    if (status.available) {
      logger.info(
        { 
          command: status.command,
          configuredPath: status.configuredPath 
        },
        '✅ LibreOffice is available and will be used for DOCX parsing'
      );
    } else {
      logger.warn(
        { configuredPath: status.configuredPath },
        '⚠️  LibreOffice is enabled but not found. DOCX files will be parsed using XML parsing (fallback).'
      );
    }
  } else {
    logger.debug('LibreOffice is disabled. DOCX files will be parsed using XML parsing.');
  }
};

server.listen(env.port, async () => {
  logger.info(`AI Translation Studio backend listening on port ${env.port}`);
  
  // Cleanup stale analyses (RUNNING statuses from before server restart)
  cleanupStaleAnalyses().catch((error) => {
    logger.error({ error }, 'Failed to cleanup stale analyses');
  });
  
  // Check LibreOffice asynchronously (don't block server startup)
  checkLibreOffice().catch((error) => {
    logger.error({ error }, 'Failed to check LibreOffice status');
  });
});

