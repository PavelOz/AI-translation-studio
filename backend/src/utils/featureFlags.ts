/**
 * Feature Flags System
 * 
 * Centralized feature flag management to enable/disable features
 * without code deployment. Flags are controlled via environment variables.
 * 
 * Usage:
 *   import { featureFlags } from './utils/featureFlags';
 *   
 *   if (featureFlags.newAnalysisUI) {
 *     // Use new UI
 *   } else {
 *     // Use old UI
 *   }
 */

import { env } from './env';

/**
 * Feature flags configuration
 * 
 * To add a new feature flag:
 * 1. Add the flag here with a default value (usually false)
 * 2. Document it in .env.example
 * 3. Use it in the code with proper fallback
 * 4. Update CHANGELOG.md when enabling by default
 */
export const featureFlags = {
  /**
   * Enable new analysis UI with improved stage indicators
   * Default: false (use old UI)
   */
  newAnalysisUI: process.env.ENABLE_NEW_ANALYSIS_UI === 'true',

  /**
   * Enable enhanced DOCX export with better formatting preservation
   * Default: false (use standard export)
   */
  enhancedDocxExport: process.env.ENABLE_ENHANCED_DOCX === 'true',

  /**
   * Enable detailed logging for debugging
   * Default: true in development, false in production
   */
  detailedLogging: env.nodeEnv === 'development' || process.env.ENABLE_DETAILED_LOGGING === 'true',

  /**
   * Enable experimental features (use with caution)
   * Default: false
   */
  experimentalFeatures: process.env.ENABLE_EXPERIMENTAL === 'true',
} as const;

/**
 * Type-safe feature flag names
 */
export type FeatureFlagName = keyof typeof featureFlags;

/**
 * Check if a feature flag is enabled
 * 
 * @param flagName - Name of the feature flag
 * @returns true if enabled, false otherwise
 */
export function isFeatureEnabled(flagName: FeatureFlagName): boolean {
  return featureFlags[flagName];
}

/**
 * Get all enabled feature flags (for debugging/logging)
 */
export function getEnabledFlags(): FeatureFlagName[] {
  return (Object.keys(featureFlags) as FeatureFlagName[]).filter(
    (flag) => featureFlags[flag]
  );
}







