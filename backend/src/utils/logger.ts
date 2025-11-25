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

