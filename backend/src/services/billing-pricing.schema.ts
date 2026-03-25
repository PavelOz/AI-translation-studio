import { z } from 'zod';

const pricingLineSchema = z.object({
  inputPer1M: z.number().nonnegative(),
  outputPer1M: z.number().nonnegative(),
  tier: z.enum(['standard', 'expensive']),
});

export const pricingFileSchema = z.object({
  version: z.number().int().positive(),
  currency: z.string().min(1).max(16),
  defaultPer1M: pricingLineSchema,
  models: z.record(z.string(), pricingLineSchema),
});

export type PricingFile = z.infer<typeof pricingFileSchema>;

export function parsePricingFile(data: unknown): PricingFile {
  return pricingFileSchema.parse(data);
}

export function safeParsePricingFile(data: unknown) {
  return pricingFileSchema.safeParse(data);
}
