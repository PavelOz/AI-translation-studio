/**
 * Strict Zod schema and normalization for Document DNA.
 * Ensures abbreviationLogic is always { longForm, shortForm } (no plain strings).
 */

import { z } from 'zod';

const MAX_KEY_LENGTH = 500;
const MAX_VALUE_LENGTH = 2000;

/** Single entry: object with longForm and shortForm. Strings are normalized to this shape. */
const abbreviationLogicEntrySchema = z
  .union([
    z.string().max(MAX_VALUE_LENGTH).trim(),
    z.object({
      longForm: z.string().max(MAX_VALUE_LENGTH).optional().nullable(),
      shortForm: z.string().max(MAX_VALUE_LENGTH).optional().nullable(),
      value: z.string().max(MAX_VALUE_LENGTH).optional().nullable(),
      aliases: z.array(z.string().max(MAX_KEY_LENGTH)).optional(),
    }),
  ])
  .transform((v): { longForm: string; shortForm: string; aliases?: string[] } => {
    if (typeof v === 'string') {
      const s = v.trim();
      return { longForm: s, shortForm: s };
    }
    const o = v as { longForm?: string | null; shortForm?: string | null; value?: string | null; aliases?: string[] };
    const long = (o.longForm ?? o.value ?? '').trim() || (o.shortForm ?? '').trim();
    const short = (o.shortForm ?? o.longForm ?? o.value ?? '').trim() || long;
    return {
      longForm: long || short,
      shortForm: short || long,
      ...(Array.isArray(o.aliases) && o.aliases.length > 0 ? { aliases: o.aliases } : undefined),
    };
  });

/** Full abbreviationLogic map: keys are strings, values are normalized to { longForm, shortForm }. */
export const abbreviationLogicSchema = z
  .record(z.string().max(MAX_KEY_LENGTH), abbreviationLogicEntrySchema)
  .nullable()
  .optional()
  .transform((v): Record<string, { longForm: string; shortForm: string; aliases?: string[] }> | null => {
    if (v == null || typeof v !== 'object') return null;
    const out: Record<string, { longForm: string; shortForm: string; aliases?: string[] }> = {};
    for (const [key, val] of Object.entries(v)) {
      if (key === '' || /^\s+$/.test(key)) continue;
      const parsed = abbreviationLogicEntrySchema.safeParse(val);
      if (parsed.success) out[key] = parsed.data;
    }
    return Object.keys(out).length > 0 ? out : null;
  });

/** Document DNA payload with strict abbreviationLogic. */
export const documentDnaPayloadSchema = z.object({
  technicalSchema: z.record(z.string(), z.unknown()).nullable().optional(),
  namingConventions: z.record(z.string(), z.unknown()).nullable().optional(),
  abbreviationLogic: abbreviationLogicSchema,
  entityGroups: z.record(z.string(), z.unknown()).nullable().optional(),
});

export type NormalizedDocumentDnaPayload = z.infer<typeof documentDnaPayloadSchema>;

/**
 * Normalize raw DNA payload: coerce abbreviationLogic values to { longForm, shortForm }.
 * Returns normalized payload or throws on invalid structure.
 */
export function normalizeDocumentDnaPayload(dna: unknown): NormalizedDocumentDnaPayload {
  const parsed = documentDnaPayloadSchema.safeParse(dna);
  if (!parsed.success) {
    const msg = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Invalid Document DNA: ${msg}`);
  }
  return parsed.data;
}

/**
 * Safe normalize: returns null if input is null/undefined, otherwise normalizes or throws.
 */
export function normalizeDocumentDnaPayloadOrNull(dna: unknown): NormalizedDocumentDnaPayload | null {
  if (dna == null) return null;
  return normalizeDocumentDnaPayload(dna);
}

/** Coerce abbreviationLogic values to string or object so Zod schema accepts them (e.g. after LLM refine). */
function coerceAbbreviationLogicValue(
  val: unknown,
): string | { longForm?: string | null; shortForm?: string | null; value?: string | null; aliases?: string[] } | null {
  if (typeof val === 'string') return val.trim() || null;
  if (val !== null && typeof val === 'object' && !Array.isArray(val)) return val as Record<string, unknown>;
  if (typeof val === 'number' || typeof val === 'boolean') return String(val);
  if (Array.isArray(val) && val.length > 0) {
    const first = val[0];
    if (typeof first === 'string') return first.trim() || null;
    if (first !== null && typeof first === 'object' && !Array.isArray(first)) return first as Record<string, unknown>;
  }
  return null;
}

/**
 * Sanitize raw payload so abbreviationLogic only has string or object values (for PUT /dna).
 * Use before normalizeDocumentDnaPayload when payload may come from LLM (e.g. Accept Refinement).
 */
export function sanitizeDocumentDnaPayloadForPut(
  data: Record<string, unknown>,
): Record<string, unknown> {
  const abbrev = data?.abbreviationLogic;
  if (abbrev == null || typeof abbrev !== 'object' || Array.isArray(abbrev)) return data;
  const out: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(abbrev)) {
    if (key === '' || /^\s+$/.test(key)) continue;
    const coerced = coerceAbbreviationLogicValue(val);
    if (coerced != null) out[key] = coerced;
  }
  return { ...data, abbreviationLogic: Object.keys(out).length > 0 ? out : abbrev };
}
