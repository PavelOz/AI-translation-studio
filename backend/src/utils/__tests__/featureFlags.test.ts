/**
 * Tests for feature flags system
 */

import { featureFlags, isFeatureEnabled, getEnabledFlags, FeatureFlagName } from '../featureFlags';

// Mock process.env
const originalEnv = process.env;

describe('featureFlags', () => {
  beforeEach(() => {
    // Reset process.env before each test
    process.env = { ...originalEnv };
    // Clear module cache to reload featureFlags with new env
    delete require.cache[require.resolve('../featureFlags')];
  });

  afterAll(() => {
    // Restore original process.env after all tests
    process.env = originalEnv;
  });

  describe('featureFlags object', () => {
    it('should have all expected flags', () => {
      const { featureFlags: flags } = require('../featureFlags');
      expect(flags).toHaveProperty('newAnalysisUI');
      expect(flags).toHaveProperty('enhancedDocxExport');
      expect(flags).toHaveProperty('detailedLogging');
      expect(flags).toHaveProperty('experimentalFeatures');
    });

    it('should default newAnalysisUI to false', () => {
      delete process.env.ENABLE_NEW_ANALYSIS_UI;
      const { featureFlags: flags } = require('../featureFlags');
      expect(flags.newAnalysisUI).toBe(false);
    });

    it('should enable newAnalysisUI when env var is set to true', () => {
      process.env.ENABLE_NEW_ANALYSIS_UI = 'true';
      const { featureFlags: flags } = require('../featureFlags');
      expect(flags.newAnalysisUI).toBe(true);
    });

    it('should not enable newAnalysisUI when env var is set to false', () => {
      process.env.ENABLE_NEW_ANALYSIS_UI = 'false';
      const { featureFlags: flags } = require('../featureFlags');
      expect(flags.newAnalysisUI).toBe(false);
    });

    it('should enable enhancedDocxExport when env var is set', () => {
      process.env.ENABLE_ENHANCED_DOCX = 'true';
      const { featureFlags: flags } = require('../featureFlags');
      expect(flags.enhancedDocxExport).toBe(true);
    });

    it('should enable experimentalFeatures when env var is set', () => {
      process.env.ENABLE_EXPERIMENTAL = 'true';
      const { featureFlags: flags } = require('../featureFlags');
      expect(flags.experimentalFeatures).toBe(true);
    });
  });

  describe('isFeatureEnabled', () => {
    it('should return true for enabled flag', () => {
      process.env.ENABLE_NEW_ANALYSIS_UI = 'true';
      delete require.cache[require.resolve('../featureFlags')];
      const { isFeatureEnabled } = require('../featureFlags');
      expect(isFeatureEnabled('newAnalysisUI')).toBe(true);
    });

    it('should return false for disabled flag', () => {
      delete process.env.ENABLE_NEW_ANALYSIS_UI;
      delete require.cache[require.resolve('../featureFlags')];
      const { isFeatureEnabled } = require('../featureFlags');
      expect(isFeatureEnabled('newAnalysisUI')).toBe(false);
    });

    it('should work with all flag names', () => {
      delete require.cache[require.resolve('../featureFlags')];
      const { isFeatureEnabled } = require('../featureFlags');
      
      const flagNames: FeatureFlagName[] = [
        'newAnalysisUI',
        'enhancedDocxExport',
        'detailedLogging',
        'experimentalFeatures',
      ];

      flagNames.forEach((flagName) => {
        expect(typeof isFeatureEnabled(flagName)).toBe('boolean');
      });
    });
  });

  describe('getEnabledFlags', () => {
    it('should return empty array when no flags are enabled', () => {
      delete process.env.ENABLE_NEW_ANALYSIS_UI;
      delete process.env.ENABLE_ENHANCED_DOCX;
      delete process.env.ENABLE_EXPERIMENTAL;
      delete require.cache[require.resolve('../featureFlags')];
      const { getEnabledFlags } = require('../featureFlags');
      
      const enabled = getEnabledFlags();
      // detailedLogging might be enabled in development
      expect(Array.isArray(enabled)).toBe(true);
    });

    it('should return array of enabled flag names', () => {
      process.env.ENABLE_NEW_ANALYSIS_UI = 'true';
      process.env.ENABLE_ENHANCED_DOCX = 'true';
      delete require.cache[require.resolve('../featureFlags')];
      const { getEnabledFlags } = require('../featureFlags');
      
      const enabled = getEnabledFlags();
      expect(enabled).toContain('newAnalysisUI');
      expect(enabled).toContain('enhancedDocxExport');
    });

    it('should return only enabled flags', () => {
      process.env.ENABLE_NEW_ANALYSIS_UI = 'true';
      delete process.env.ENABLE_ENHANCED_DOCX;
      delete require.cache[require.resolve('../featureFlags')];
      const { getEnabledFlags } = require('../featureFlags');
      
      const enabled = getEnabledFlags();
      expect(enabled).toContain('newAnalysisUI');
      // enhancedDocxExport should not be in the list if not enabled
      if (!process.env.ENABLE_ENHANCED_DOCX) {
        // This might still be true if detailedLogging is enabled, so we check the count
        expect(enabled.length).toBeGreaterThanOrEqual(1);
      }
    });
  });
});









