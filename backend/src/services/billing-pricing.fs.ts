import fs from 'fs';
import path from 'path';
import { parsePricingFile, type PricingFile } from './billing-pricing.schema';

export function readBundledPricingFile(): PricingFile {
  const file = path.join(__dirname, '../../config/billing-pricing.v1.json');
  const raw = fs.readFileSync(file, 'utf-8');
  return parsePricingFile(JSON.parse(raw));
}
