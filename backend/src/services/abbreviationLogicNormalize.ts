/**
 * Normalize abbreviationLogic: convert plain string values to { longForm, shortForm } objects.
 * Ensures first-mention vs subsequent use is enforceable by the orchestrator.
 */

/** Technical indices: Russian key (normalized for match) → preferred English shortForm. */
const TECHNICAL_INDEX_SHORT_FORMS: Record<string, string> = {
  руст: 'Pinst',
  рраб: 'Pwork',
  ррасп: 'Pavail',
};

function normalizeKeyForMap(key: string): string {
  return key.replace(/\s+/g, ' ').trim().toLowerCase();
}

/**
 * Extract abbreviation from string: (ABBR) or standalone ABBR, or build from English words.
 */
function extractShortFormFromString(fullString: string, key: string): string {
  const trimmed = fullString.trim();
  const inParens = trimmed.match(/\(([A-Za-z][A-Za-z0-9]{0,})\)/);
  if (inParens) return inParens[1].toUpperCase();
  if (/^[A-Za-z][A-Za-z0-9]{1,}$/.test(trimmed)) return trimmed.toUpperCase();
  const words = trimmed.split(/\s+/).filter(Boolean);
  if (words.length === 0) return trimmed.slice(0, 8) || key;
  const acronym = words
    .map((w) => w[0])
    .filter((c) => /[A-Za-z]/.test(c))
    .join('')
    .toUpperCase();
  return acronym || trimmed.slice(0, 8) || key;
}

/**
 * Convert a single abbreviationLogic value to { longForm, shortForm }.
 * - If value is already an object with longForm/shortForm, return it (optionally normalized).
 * - If value is a string: longForm = value, shortForm = special map by key, or from (ABBR), or acronym.
 */
export function normalizeAbbreviationLogicValue(
  key: string,
  value: unknown,
): { longForm: string; shortForm: string } | null {
  if (value == null) return null;

  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    const o = value as Record<string, unknown>;
    const long = typeof o.longForm === 'string' ? o.longForm : typeof o.value === 'string' ? o.value : null;
    const short = typeof o.shortForm === 'string' ? o.shortForm : long ? extractShortFormFromString(long, key) : null;
    if (long && short) return { longForm: long, shortForm: short };
    if (long) return { longForm: long, shortForm: extractShortFormFromString(long, key) };
  }

  if (typeof value === 'string') {
    const longForm = value.trim();
    if (!longForm) return null;
    const keyNorm = normalizeKeyForMap(key);
    const specialShort = TECHNICAL_INDEX_SHORT_FORMS[keyNorm];
    const shortForm =
      specialShort ?? extractShortFormFromString(longForm, key);
    return { longForm, shortForm };
  }

  return null;
}

/**
 * Normalize entire abbreviationLogic: all string values become { longForm, shortForm };
 * values that are already objects are kept or normalized to ensure longForm/shortForm shape.
 */
export function normalizeAbbreviationLogic(
  abbreviationLogic: Record<string, unknown> | null | undefined,
): Record<string, { longForm: string; shortForm: string }> {
  const out: Record<string, { longForm: string; shortForm: string }> = {};
  if (!abbreviationLogic || typeof abbreviationLogic !== 'object') return out;

  for (const [key, value] of Object.entries(abbreviationLogic)) {
    if (!key || /^\s*$/.test(key)) continue;
    const normalized = normalizeAbbreviationLogicValue(key, value);
    if (normalized) out[key] = normalized;
  }

  return out;
}
