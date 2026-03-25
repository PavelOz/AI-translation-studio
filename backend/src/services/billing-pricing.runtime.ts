import { readBundledPricingFile } from './billing-pricing.fs';
import type { PricingFile } from './billing-pricing.schema';

let dbOverride: PricingFile | null = null;
let fileCache: PricingFile | null = null;

export function setPricingDbOverride(pricing: PricingFile | null) {
  dbOverride = pricing;
  fileCache = null;
}

export function getPricingDbOverride(): PricingFile | null {
  return dbOverride;
}

export function getActivePricing(): PricingFile {
  if (dbOverride) return dbOverride;
  if (!fileCache) fileCache = readBundledPricingFile();
  return fileCache;
}
