import fs from 'fs';
import path from 'path';
import { parsePricingFile, type PricingFile } from './billing-pricing.schema';

export function bundledPricingFilePath(): string {
  return path.join(__dirname, '../../config/billing-pricing.v1.json');
}

export function readBundledPricingFile(): PricingFile {
  const raw = fs.readFileSync(bundledPricingFilePath(), 'utf-8');
  return parsePricingFile(JSON.parse(raw));
}

/** Writes the valid pricing registry to the bundled JSON path (admin-only via API). */
export function writeBundledPricingFile(data: PricingFile): void {
  const file = bundledPricingFilePath();
  const pretty = `${JSON.stringify(data, null, 2)}\n`;
  fs.writeFileSync(file, pretty, 'utf-8');
}
