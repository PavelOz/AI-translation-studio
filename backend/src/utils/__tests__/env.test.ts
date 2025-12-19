/**
 * Tests for env utility functions
 */

import { env } from '../env';

// Mock process.env before importing
const originalEnv = process.env;

describe('env utilities', () => {
  beforeEach(() => {
    // Reset process.env before each test
    process.env = { ...originalEnv };
  });

  afterAll(() => {
    // Restore original process.env after all tests
    process.env = originalEnv;
  });

  describe('numberFromEnv', () => {
    // This is a private function, but we can test it through env object
    // Testing PORT parsing as an example
    it('should parse valid number from env', () => {
      process.env.PORT = '8080';
      // Reload env module to get new value
      delete require.cache[require.resolve('../env')];
      const { env: newEnv } = require('../env');
      expect(newEnv.port).toBe(8080);
    });

    it('should use fallback for invalid number', () => {
      process.env.PORT = 'invalid';
      delete require.cache[require.resolve('../env')];
      const { env: newEnv } = require('../env');
      expect(newEnv.port).toBe(4000); // default fallback
    });

    it('should use fallback for missing env var', () => {
      delete process.env.PORT;
      delete require.cache[require.resolve('../env')];
      const { env: newEnv } = require('../env');
      expect(newEnv.port).toBe(4000); // default fallback
    });

    it('should parse zero as valid number', () => {
      process.env.PORT = '0';
      delete require.cache[require.resolve('../env')];
      const { env: newEnv } = require('../env');
      expect(newEnv.port).toBe(0);
    });
  });

  describe('env object', () => {
    it('should have required properties', () => {
      expect(env).toHaveProperty('nodeEnv');
      expect(env).toHaveProperty('port');
      expect(env).toHaveProperty('databaseUrl');
      expect(env).toHaveProperty('jwtSecret');
    });

    it('should have default values for optional properties', () => {
      expect(typeof env.port).toBe('number');
      expect(env.port).toBeGreaterThan(0);
    });
  });
});







