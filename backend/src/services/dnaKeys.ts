/**
 * DNA key normalization and alias resolution for matching segment text to abbreviationLogic.
 * Used so "ПУЛ РЭМ" and "пул рем" map to the same entry; optional Russian ending stripping for lookup.
 */

/** Common Russian word endings to strip for lookup only (optional). */
const RUSSIAN_ENDINGS = /(?:ов|ам|ом|ово|ами|ах|ами|ей|ем|ях|ии|ий|ие|ия|ью)\s*$/i;

/**
 * Normalize a DNA key for lookup: lowercase, trim, collapse spaces.
 * Optionally strip common Russian endings so "диспетчерского центра" can match "диспетчерский центр".
 */
export function normalizeDnaKey(key: string): string {
  if (!key || typeof key !== 'string') return '';
  let n = key.replace(/\s+/g, ' ').trim().toLowerCase();
  n = n.replace(RUSSIAN_ENDINGS, '').trim();
  return n;
}

export type DnaEntry = { originalKey: string; value: unknown };

/**
 * Build a map from normalized key (and normalized aliases) to { originalKey, value }.
 * Used when applying DNA so we can match "пул рем" to the entry for "ПУЛ РЭМ".
 */
export function buildNormalizedDnaMap(
  abbreviationLogic: Record<string, unknown> | null | undefined,
): Map<string, DnaEntry> {
  const map = new Map<string, DnaEntry>();
  if (!abbreviationLogic || typeof abbreviationLogic !== 'object') return map;

  for (const [originalKey, value] of Object.entries(abbreviationLogic)) {
    if (!originalKey || /^\s*$/.test(originalKey)) continue;
    const entry: DnaEntry = { originalKey, value };
    const norm = normalizeDnaKey(originalKey);
    if (norm) map.set(norm, entry);

    if (value != null && typeof value === 'object' && 'aliases' in value) {
      const aliases = (value as { aliases?: unknown }).aliases;
      if (Array.isArray(aliases)) {
        for (const a of aliases) {
          if (typeof a === 'string') {
            const an = normalizeDnaKey(a);
            if (an && !map.has(an)) map.set(an, entry);
          }
        }
      }
    }
  }
  return map;
}
