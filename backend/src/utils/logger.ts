import pino from 'pino';
import pretty from 'pino-pretty';
import { env } from './env';

const stream = env.nodeEnv === 'development'
  ? pretty({
      colorize: true,
      translateTime: 'SYS:standard',
      ignore: 'pid,hostname', // Cleaner output
    })
  : undefined;

export const logger = pino(
  {
    name: 'ai-translation-studio',
    level: env.nodeEnv === 'production' ? 'info' : 'debug',
  },
  stream,
);

// Helper function to safely log text that may contain non-ASCII characters
// This ensures UTF-8 encoding is preserved in logs
export const safeLogText = (text: string, maxLength = 100): string => {
  if (!text) return '';
  const truncated = text.length > maxLength ? text.substring(0, maxLength) + '...' : text;
  // Ensure proper UTF-8 encoding
  try {
    return Buffer.from(truncated, 'utf8').toString('utf8');
  } catch {
    // Fallback: replace problematic characters
    return truncated.replace(/[^\x00-\x7F]/g, '?');
  }
};

/**
 * Log the start of an operation with context
 * 
 * @param operation - Name of the operation (e.g., 'document-analysis', 'docx-export')
 * @param context - Additional context object (documentId, userId, etc.)
 */
export function logOperationStart(operation: string, context: Record<string, any> = {}): void {
  logger.info(
    {
      operation,
      ...context,
      timestamp: new Date().toISOString(),
    },
    `Starting operation: ${operation}`,
  );
}

/**
 * Log the end of an operation with duration and result
 * 
 * @param operation - Name of the operation
 * @param context - Additional context object
 * @param duration - Duration in milliseconds
 * @param success - Whether the operation succeeded
 */
export function logOperationEnd(
  operation: string,
  context: Record<string, any> = {},
  duration?: number,
  success: boolean = true,
): void {
  const logData: Record<string, any> = {
    operation,
    ...context,
    timestamp: new Date().toISOString(),
    success,
  };

  if (duration !== undefined) {
    logData.durationMs = duration;
    logData.durationSeconds = Math.round(duration / 1000 * 100) / 100;
  }

  if (success) {
    logger.info(logData, `Completed operation: ${operation}`);
  } else {
    logger.warn(logData, `Operation failed: ${operation}`);
  }
}

/**
 * Log an error with full context for debugging
 * 
 * @param error - Error object or error message
 * @param context - Additional context (documentId, userId, operation, etc.)
 * @param operation - Name of the operation that failed
 */
export function logErrorWithContext(
  error: Error | string,
  context: Record<string, any> = {},
  operation?: string,
): void {
  const errorMessage = error instanceof Error ? error.message : error;
  const errorStack = error instanceof Error ? error.stack : undefined;  logger.error(
    {
      error: errorMessage,
      stack: errorStack,
      operation: operation || context.operation,
      ...context,
      timestamp: new Date().toISOString(),
    },
    `Error in ${operation || 'operation'}: ${errorMessage}`,
  );
}/**
 * Log progress of a long-running operation
 * 
 * @param operation - Name of the operation
 * @param stage - Current stage/step name
 * @param progress - Progress percentage (0-100)
 * @param context - Additional context
 */
export function logProgress(
  operation: string,
  stage: string,
  progress: number,
  context: Record<string, any> = {},
): void {
  logger.debug(
    {
      operation,
      stage,
      progress,
      progressPercent: `${progress}%`,
      ...context,
      timestamp: new Date().toISOString(),
    },
    `Progress: ${operation} - ${stage} (${progress}%)`,
  );
}
