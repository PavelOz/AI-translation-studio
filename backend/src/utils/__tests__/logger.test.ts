/**
 * Tests for logger utility functions
 */

import { safeLogText, logOperationStart, logOperationEnd, logErrorWithContext, logProgress } from '../logger';

// Mock the logger to avoid console output during tests
jest.mock('../logger', () => {
  const originalModule = jest.requireActual('../logger');
  return {
    ...originalModule,
    logger: {
      info: jest.fn(),
      debug: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
    },
  };
});

import { logger } from '../logger';

describe('logger utilities', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('safeLogText', () => {
    it('should return empty string for empty input', () => {
      expect(safeLogText('')).toBe('');
      expect(safeLogText(null as any)).toBe('');
      expect(safeLogText(undefined as any)).toBe('');
    });

    it('should return text as-is if within maxLength', () => {
      const text = 'Hello World';
      expect(safeLogText(text, 100)).toBe(text);
    });

    it('should truncate text longer than maxLength', () => {
      const text = 'A'.repeat(150);
      const result = safeLogText(text, 100);
      expect(result.length).toBe(103); // 100 + '...'
      expect(result).toEndWith('...');
    });

    it('should handle non-ASCII characters', () => {
      const text = 'Привет мир 你好世界';
      const result = safeLogText(text, 100);
      expect(result).toBe(text);
    });

    it('should use default maxLength of 100', () => {
      const text = 'A'.repeat(150);
      const result = safeLogText(text);
      expect(result.length).toBe(103); // 100 + '...'
    });
  });

  describe('logOperationStart', () => {
    it('should log operation start with context', () => {
      logOperationStart('test-operation', { documentId: '123', userId: '456' });
      
      expect(logger.info).toHaveBeenCalledWith(
        expect.objectContaining({
          operation: 'test-operation',
          documentId: '123',
          userId: '456',
          timestamp: expect.any(String),
        }),
        'Starting operation: test-operation',
      );
    });

    it('should log operation start without context', () => {
      logOperationStart('test-operation');
      
      expect(logger.info).toHaveBeenCalledWith(
        expect.objectContaining({
          operation: 'test-operation',
          timestamp: expect.any(String),
        }),
        'Starting operation: test-operation',
      );
    });
  });

  describe('logOperationEnd', () => {
    it('should log successful operation end with duration', () => {
      logOperationEnd('test-operation', { documentId: '123' }, 1500, true);
      
      expect(logger.info).toHaveBeenCalledWith(
        expect.objectContaining({
          operation: 'test-operation',
          documentId: '123',
          durationMs: 1500,
          durationSeconds: 1.5,
          success: true,
          timestamp: expect.any(String),
        }),
        'Completed operation: test-operation',
      );
    });

    it('should log failed operation end', () => {
      logOperationEnd('test-operation', { documentId: '123' }, 500, false);
      
      expect(logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({
          operation: 'test-operation',
          documentId: '123',
          success: false,
          timestamp: expect.any(String),
        }),
        'Operation failed: test-operation',
      );
    });

    it('should log operation end without duration', () => {
      logOperationEnd('test-operation', {}, undefined, true);
      
      expect(logger.info).toHaveBeenCalledWith(
        expect.objectContaining({
          operation: 'test-operation',
          success: true,
        }),
        'Completed operation: test-operation',
      );
      expect(logger.info).not.toHaveBeenCalledWith(
        expect.objectContaining({
          durationMs: expect.anything(),
        }),
        expect.anything(),
      );
    });
  });

  describe('logErrorWithContext', () => {
    it('should log error with Error object', () => {
      const error = new Error('Test error');
      logErrorWithContext(error, { documentId: '123' }, 'test-operation');
      
      expect(logger.error).toHaveBeenCalledWith(
        expect.objectContaining({
          error: 'Test error',
          stack: expect.any(String),
          operation: 'test-operation',
          documentId: '123',
          timestamp: expect.any(String),
        }),
        'Error in test-operation: Test error',
      );
    });

    it('should log error with string message', () => {
      logErrorWithContext('Test error message', { documentId: '123' });
      
      expect(logger.error).toHaveBeenCalledWith(
        expect.objectContaining({
          error: 'Test error message',
          documentId: '123',
          timestamp: expect.any(String),
        }),
        expect.stringContaining('Test error message'),
      );
    });

    it('should use context.operation if operation not provided', () => {
      const error = new Error('Test error');
      logErrorWithContext(error, { documentId: '123', operation: 'context-operation' });
      
      expect(logger.error).toHaveBeenCalledWith(
        expect.objectContaining({
          operation: 'context-operation',
        }),
        expect.any(String),
      );
    });
  });

  describe('logProgress', () => {
    it('should log progress with all parameters', () => {
      logProgress('test-operation', 'parsing', 45, { documentId: '123' });
      
      expect(logger.debug).toHaveBeenCalledWith(
        expect.objectContaining({
          operation: 'test-operation',
          stage: 'parsing',
          progress: 45,
          progressPercent: '45%',
          documentId: '123',
          timestamp: expect.any(String),
        }),
        'Progress: test-operation - parsing (45%)',
      );
    });

    it('should log progress without context', () => {
      logProgress('test-operation', 'processing', 75);
      
      expect(logger.debug).toHaveBeenCalledWith(
        expect.objectContaining({
          operation: 'test-operation',
          stage: 'processing',
          progress: 75,
          progressPercent: '75%',
        }),
        'Progress: test-operation - processing (75%)',
      );
    });
  });
});










