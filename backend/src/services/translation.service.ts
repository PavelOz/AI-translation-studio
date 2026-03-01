/**
 * Translation post-processing: Total Cyrillic Ban and DNA-based replacements.
 * - Replaces (DNA_KEY) and whole-word DNA keys with English equivalent from DNA.
 * - Removes any remaining Cyrillic in the English translation.
 * - Key normalization and aliases (Phase 3): match normalized keys and value.aliases.
 */

import { normalizeDnaKey } from './dnaKeys';

/** Escape special regex characters in a string for use in RegExp. */
function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Regex that matches the key with flexible whitespace (for replacement). */
function keyToPattern(key: string): string {
  return key.split(/\s+/).map(escapeRegex).join('\\s+');
}

/** Cyrillic Unicode block. */
const CYRILLIC_REGEX = /[\u0400-\u04FF]/;

/** Locales where the target language is written in Cyrillic; do not strip Cyrillic from translation. */
const CYRILLIC_TARGET_LOCALES = new Set(['ru', 'rus', 'uk', 'ukr', 'kk', 'kaz', 'be', 'bel', 'ky', 'kir', 'mk', 'mkd', 'sr', 'srp', 'mn', 'mon']);

function isCyrillicTargetLocale(locale: string | undefined): boolean {
  if (!locale || !locale.trim()) return false;
  const code = locale.trim().toLowerCase().split(/[-_]/)[0];
  return CYRILLIC_TARGET_LOCALES.has(code) || code.startsWith('ru') || code.startsWith('uk') || code.startsWith('kk') || code.startsWith('be');
}

/** Levenshtein similarity in [0,1]; 1 = identical. */
function levenshteinSimilarity(a: string, b: string): number {
  if (a === b) return 1;
  if (!a || !b) return 0;
  const an = a.length;
  const bn = b.length;
  const maxLen = Math.max(an, bn);
  const prev: number[] = [];
  const curr: number[] = [];
  for (let j = 0; j <= bn; j++) prev[j] = j;
  for (let i = 1; i <= an; i++) {
    curr[0] = i;
    for (let j = 1; j <= bn; j++) {
      curr[j] = a[i - 1] === b[j - 1] ? prev[j - 1] : 1 + Math.min(prev[j - 1], prev[j], curr[j - 1]);
    }
    for (let j = 0; j <= bn; j++) prev[j] = curr[j];
  }
  const dist = prev[bn];
  return 1 - dist / maxLen;
}

const FUZZY_MATCH_THRESHOLD = 0.9;

/**
 * Extract target-language abbreviation from a DNA value. Prefers shortForm; else parses longForm/value string.
 */
function extractAbbreviationFromValue(v: unknown): string | null {
  if (v == null) return null;
  if (typeof v === 'object' && v !== null && 'shortForm' in v) {
    const s = (v as { shortForm?: unknown }).shortForm;
    if (typeof s === 'string' && s.trim()) return s.trim();
  }
  const str =
    typeof v === 'string'
      ? v
      : typeof v === 'object' && v !== null
        ? (typeof (v as { longForm?: unknown }).longForm === 'string'
            ? (v as { longForm: string }).longForm
            : typeof (v as { value?: unknown }).value === 'string'
              ? String((v as { value: unknown }).value)
              : null)
        : null;
  if (!str || typeof str !== 'string') return null;
  const inParens = str.match(/\(([A-Z][A-Z0-9]{1,})\)/);
  if (inParens) return inParens[1];
  if (/^[A-Z][A-Z0-9]{1,}$/.test(str.trim())) return str.trim();
  return null;
}

/**
 * Get the English string to use for replacement. Prefers shortForm for abbreviation; longForm or value for full form when already Latin.
 * When fallback is provided, returns it instead of null to avoid leaving gaps (e.g. untranslatable Cyrillic-only value).
 */
function getTargetEnglishValue(v: unknown, fallback?: string): string | null {
  if (v == null) return fallback ?? null;
  const abbr = extractAbbreviationFromValue(v);
  if (abbr) return abbr;
  const str =
    typeof v === 'string'
      ? v
      : typeof v === 'object' && v !== null
        ? (typeof (v as { longForm?: unknown }).longForm === 'string'
            ? (v as { longForm: string }).longForm
            : typeof (v as { value?: unknown }).value === 'string'
              ? String((v as { value: unknown }).value)
              : null)
        : null;
  if (!str || typeof str !== 'string') return fallback ?? null;
  if (!CYRILLIC_REGEX.test(str)) return str.trim();
  return fallback ?? null;
}

/**
 * Post-processing: remove any remaining Cyrillic in parentheses that matches DNA keys.
 * Replaces "(DNA_KEY)" with the target abbreviation from DNA.
 */
export function sanitizeCyrillicInTranslation(
  text: string,
  abbreviationLogic: Record<string, unknown> | null | undefined,
): string {
  if (!text || typeof text !== 'string') return text;
  if (!abbreviationLogic || typeof abbreviationLogic !== 'object') return text;

  let result = text;
  for (const [key, value] of Object.entries(abbreviationLogic)) {
    if (!key || /^\s*$/.test(key)) continue;
    const targetAbbr = extractAbbreviationFromValue(value);
    if (!targetAbbr) continue;
    const escapedKey = escapeRegex(key);
    const re = new RegExp(`\\(${escapedKey}\\)`, 'g');
    result = result.replace(re, `(${targetAbbr})`);
  }

  return result;
}

/**
 * Build (pattern, target) list for replacement and list of keys that have no English target (fallback used).
 * When target === key we used fallback; those keys must not be stripped so we don't leave gaps.
 */
function buildReplacementPairs(
  abbreviationLogic: Record<string, unknown> | null | undefined,
): { pairs: Array<{ pattern: string; target: string }>; untranslatableKeys: string[] } {
  const pairs: Array<{ pattern: string; target: string }> = [];
  const untranslatableKeys: string[] = [];
  const seenNorm = new Set<string>();
  if (!abbreviationLogic || typeof abbreviationLogic !== 'object') return { pairs, untranslatableKeys };
  for (const [originalKey, value] of Object.entries(abbreviationLogic)) {
    if (!originalKey || /^\s*$/.test(originalKey)) continue;
    const target = getTargetEnglishValue(value, originalKey);
    if (!target) continue;
    if (target === originalKey) untranslatableKeys.push(originalKey);
    const keysToTry: string[] = [originalKey];
    const norm = normalizeDnaKey(originalKey);
    if (norm && !seenNorm.has(norm)) {
      seenNorm.add(norm);
      if (norm !== originalKey) keysToTry.push(norm);
    }
    if (value != null && typeof value === 'object' && 'aliases' in value) {
      const aliases = (value as { aliases?: string[] }).aliases;
      if (Array.isArray(aliases)) {
        for (const a of aliases) {
          if (typeof a === 'string' && a.trim()) {
            const an = normalizeDnaKey(a);
            if (an && !seenNorm.has(an)) {
              seenNorm.add(an);
              keysToTry.push(a);
            }
          }
        }
      }
    }
    for (const k of keysToTry) {
      pairs.push({ pattern: k, target });
    }
  }
  pairs.sort((a, b) => b.pattern.length - a.pattern.length);
  return { pairs, untranslatableKeys };
}

/**
 * Build (longForm -> shortForm) pairs for post-processing: when the LLM outputs the full name
 * (e.g. "National Dispatch Center of the System Operator") replace it with the abbreviation ("NDC SO").
 * Only Latin longForms are used so we enforce abbreviationRedundancy programmatically.
 */
function buildLongFormToShortFormPairs(
  abbreviationLogic: Record<string, unknown> | null | undefined,
): Array<{ pattern: string; target: string }> {
  if (!abbreviationLogic || typeof abbreviationLogic !== 'object') return [];
  const pairs: Array<{ pattern: string; target: string }> = [];
  for (const [, value] of Object.entries(abbreviationLogic)) {
    const longForm = getLongFormForDedupe(value);
    const shortForm = extractAbbreviationFromValue(value);
    if (!longForm || !shortForm || longForm === shortForm) continue;
    if (CYRILLIC_REGEX.test(longForm)) continue; // only replace Latin (English) full form with shortForm
    pairs.push({ pattern: longForm.trim(), target: shortForm });
  }
  pairs.sort((a, b) => b.pattern.length - a.pattern.length);
  return pairs;
}

/**
 * Fuzzy-match remaining Cyrillic phrases to DNA keys (Cyrillic keys only) and replace. Threshold 0.9.
 */
function applyDnaFuzzyMatch(
  text: string,
  abbreviationLogic: Record<string, unknown> | null | undefined,
): string {
  if (!text || !abbreviationLogic || typeof abbreviationLogic !== 'object') return text;
  if (!CYRILLIC_REGEX.test(text)) return text;

  const cyrillicEntries: Array<{ norm: string; target: string }> = [];
  const cyrillicKeys = Object.keys(abbreviationLogic).filter((k) => k && CYRILLIC_REGEX.test(k));
  for (const key of cyrillicKeys) {
    const value = abbreviationLogic[key];
    const target = getTargetEnglishValue(value);
    if (!target) continue;
    const norm = normalizeDnaKey(key);
    if (norm) cyrillicEntries.push({ norm, target });
  }
  if (cyrillicEntries.length === 0) return text;

  const wordRanges: Array<{ start: number; end: number; word: string }> = [];
  const wordRe = /\S+/g;
  let m: RegExpExecArray | null;
  while ((m = wordRe.exec(text)) !== null) {
    wordRanges.push({ start: m.index, end: m.index + m[0].length, word: m[0] });
  }

  const maxKeyWords = Math.max(1, ...cyrillicKeys.map((k) => k.split(/\s+/).length));
  const replacements: Array<{ start: number; end: number; target: string }> = [];
  const used = new Set<number>();

  for (let len = maxKeyWords; len >= 1; len--) {
    for (let i = 0; i <= wordRanges.length - len; i++) {
      if (Array.from({ length: len }, (_, j) => i + j).some((j) => used.has(j))) continue;
      const slice = wordRanges.slice(i, i + len);
      const phrase = slice.map((r) => r.word).join(' ');
      if (!CYRILLIC_REGEX.test(phrase)) continue;
      const start = slice[0].start;
      const end = slice[slice.length - 1].end;
      const norm = normalizeDnaKey(phrase);
      if (!norm) continue;
      let best = 0;
      let bestTarget = '';
      for (const { norm: keyNorm, target } of cyrillicEntries) {
        const sim = levenshteinSimilarity(norm, keyNorm);
        if (sim >= FUZZY_MATCH_THRESHOLD && sim > best) {
          best = sim;
          bestTarget = target;
        }
      }
      if (best > 0 && bestTarget) {
        replacements.push({ start, end, target: bestTarget });
        for (let j = i; j < i + len; j++) used.add(j);
      }
    }
  }

  replacements.sort((a, b) => b.start - a.start);
  let result = text;
  for (const { start, end, target } of replacements) {
    result = result.slice(0, start) + target + result.slice(end);
  }
  return result;
}

/** Private Use placeholder for single-pass replacement: \uE000index\uE001 so inserted target is never re-matched. */
function replacementPlaceholder(index: number): string {
  return `\uE000${index}\uE001`;
}

type MatchSpan = { start: number; end: number; pairIndex: number };

/**
 * Unicode-aware word boundary: not preceded/followed by letter, number, or underscore.
 * JS \b is ASCII-only and does not match around Cyrillic, so Cyrillic keys (e.g. "НДЦ СО", "Руст") were never found.
 */
const UNICODE_WORD_BOUNDARY_BEFORE = '(?<=^|[^\\p{L}\\p{N}_])';
const UNICODE_WORD_BOUNDARY_AFTER = '(?=[^\\p{L}\\p{N}_]|$)';

/**
 * Find all non-overlapping match positions for one pattern: "(pattern)" and whole-word pattern.
 * Returns spans (start, end) in order of appearance.
 * Uses Unicode-aware boundaries ('u' flag) so Cyrillic keys (НДЦ СО, Руст, etc.) and Latin longForms are found.
 * JS \\b is ASCII-only; \\p{L} and 'u' flag are required for Cyrillic and other Unicode letters.
 */
function findPatternSpans(text: string, pattern: string): Array<{ start: number; end: number }> {
  const flexible = keyToPattern(pattern);
  const spans: Array<{ start: number; end: number }> = [];
  const seen = new Set<string>(); // avoid duplicate spans from same position

  try {
    // Parenthesized: (pattern) — 'u' flag for Unicode (Cyrillic keys and Latin phrases)
    const parenRe = new RegExp(`\\((${flexible})\\)`, 'giu');
    let m: RegExpExecArray | null;
    while ((m = parenRe.exec(text)) !== null) {
      const key = `${m.index},${m.index + m[0].length}`;
      if (!seen.has(key)) {
        seen.add(key);
        spans.push({ start: m.index, end: m.index + m[0].length });
      }
    }

    // Whole-word: Unicode-aware boundary (\\b does not work for Cyrillic in JS)
    const wordRe = new RegExp(`${UNICODE_WORD_BOUNDARY_BEFORE}(${flexible})${UNICODE_WORD_BOUNDARY_AFTER}`, 'giu');
    while ((m = wordRe.exec(text)) !== null) {
      const key = `${m.index},${m.index + m[0].length}`;
      if (!seen.has(key)) {
        seen.add(key);
        spans.push({ start: m.index, end: m.index + m[0].length });
      }
    }
  } catch (e) {
    // If RegExp fails (e.g. very long pattern or engine quirk), skip this pattern to avoid breaking replacement
  }

  return spans;
}

/**
 * Resolve overlapping spans: when two overlap, keep the one with longer length.
 * Returns non-overlapping spans sorted by start descending (for replace-from-end).
 */
function resolveOverlappingSpans(spans: MatchSpan[]): MatchSpan[] {
  if (spans.length === 0) return [];
  const byLength = [...spans].sort((a, b) => (b.end - b.start) - (a.end - a.start) || a.start - b.start);
  const filtered: MatchSpan[] = [];
  for (const s of byLength) {
    const overlaps = filtered.some((f) => s.start < f.end && s.end > f.start);
    if (!overlaps) filtered.push(s);
  }
  return filtered.sort((a, b) => b.start - a.start);
}

/**
 * Two-phase replacement (Step 1): (1) find all occurrences in original text, build position map;
 * (2) replace from end to start with placeholders, then substitute placeholders with targets.
 * Prevents "matryoshka" and ensures no re-matching of inserted text.
 */
function applyReplacementsWithPlaceholders(
  text: string,
  pairs: Array<{ pattern: string; target: string }>,
): string {
  if (pairs.length === 0) return text;

  const allSpans: MatchSpan[] = [];
  for (let i = 0; i < pairs.length; i++) {
    const spans = findPatternSpans(text, pairs[i].pattern).map((s) => ({ ...s, pairIndex: i }));
    allSpans.push(...spans);
  }
  const resolved = resolveOverlappingSpans(allSpans);

  let result = text;
  for (const { start, end, pairIndex } of resolved) {
    const ph = replacementPlaceholder(pairIndex);
    result = result.slice(0, start) + ph + result.slice(end);
  }

  for (let i = 0; i < pairs.length; i++) {
    const ph = replacementPlaceholder(i);
    const target = pairs[i].target;
    result = result.split(ph).join(target);
  }
  return result;
}

/**
 * Definition line pattern: "Label – Value" (glossary / Section 4).
 * En-dash U+2013 or hyphen-minus. Protects the value part from longForm→shortForm replacement to avoid "Pinst – Pinst".
 */
const DEFINITION_LINE_REGEX = /^\s*(.+?)\s+[–-]\s+(.*)$/;

/**
 * Apply longForm→shortForm replacement only where definitions are not affected.
 * For lines matching "Label – Value", replace longForm with shortForm only in the Label part; leave Value unchanged.
 * For other lines, apply replacement to the whole line.
 * This implements "Protected Definition" so glossary entries stay "Pinst – installed electric capacity", not "Pinst – Pinst".
 */
function applyLongFormToShortFormWithProtectedDefinitions(
  text: string,
  pairs: Array<{ pattern: string; target: string }>,
): string {
  if (pairs.length === 0) return text;

  const lines = text.split(/\r?\n/);
  const resultLines = lines.map((line) => {
    const defMatch = line.match(DEFINITION_LINE_REGEX);
    if (defMatch) {
      const labelPart = defMatch[1];
      const valuePart = defMatch[2];
      const dashChar = line.includes('\u2013') ? '\u2013' : '-';
      const replacedLabel = applyReplacementsWithPlaceholders(labelPart, pairs);
      return `${replacedLabel.trim()} ${dashChar} ${valuePart}`;
    }
    return applyReplacementsWithPlaceholders(line, pairs);
  });
  return resultLines.join('\n');
}

/** Unicode word of letters (use with flag 'u'). Matches any script (Latin, Cyrillic, etc.). */
const UNICODE_WORD_CAPTURE = '(?<![\\p{L}\\p{N}_])(\\p{L}+)(?![\\p{L}\\p{N}_])';

/**
 * Remove duplicate words: (1) same word with optional brackets/spaces "ERS (ERS)" or "UPS  UPS" → single "ERS"/"UPS";
 * (2) consecutive duplicates with spaces "AMRSD AMRSD" → "AMRSD".
 * Uses Unicode-aware patterns so it works for "ЕЭС ЕЭС" and "UPS UPS". Runs until no change.
 */
export function collapseConsecutiveDuplicateWords(text: string): string {
  if (!text || typeof text !== 'string') return text;
  const bracketDup = new RegExp(`${UNICODE_WORD_CAPTURE}\\s*[\\(\\[]?\\s*\\1\\s*[\\)\\]]?`, 'gu');
  const spaceDup = new RegExp(`${UNICODE_WORD_CAPTURE}(?:\\s+\\1)+`, 'gu');
  let result = text;
  let prev: string;
  do {
    prev = result;
    result = result.replace(bracketDup, '$1');
    result = result.replace(spaceDup, '$1');
  } while (result !== prev);
  return result;
}

/**
 * Remove redundant legal keyword constructions: "Word (hereinafter Word)" → "Word".
 * Keywords (e.g. "hereinafter", "далее") come from config so the same code works for any direction.
 */
export function removeLegalKeywordRedundant(text: string, legalKeywords: string[]): string {
  if (!text || typeof text !== 'string' || legalKeywords.length === 0) return text;
  const escaped = legalKeywords.map((k) => k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
  const re = new RegExp(`(?<![\\p{L}\\p{N}_])(\\p{L}+)\\s*\\(\\s*(?:${escaped})\\s+\\1\\s*\\)`, 'gu');
  let result = text;
  let prev: string;
  do {
    prev = result;
    result = result.replace(re, '$1');
  } while (result !== prev);
  return result;
}

/**
 * Single entry point for Janitor cleaner: legal keyword cleanup + duplicate word collapse.
 * Options.legalKeywords optional; when empty, only duplicate collapse runs.
 */
export function runJanitorCleaner(
  text: string,
  options?: { legalKeywords?: string[] },
): string {
  if (!text || typeof text !== 'string') return text;
  const keywords = options?.legalKeywords?.filter((k) => typeof k === 'string' && k.trim()) ?? [];
  let result = text;
  if (keywords.length > 0) {
    result = removeLegalKeywordRedundant(result, keywords);
  }
  return collapseConsecutiveDuplicateWords(result);
}

/**
 * Coerce abbreviationLogic values to { longForm, shortForm } so replacement and longForm→shortForm pairs work.
 * Handles raw DB/API shape (plain strings or mixed) so applyTotalCyrillicBan works even when caller passes non-normalized DNA.
 */
function normalizeAbbreviationLogicForReplacement(
  abbreviationLogic: Record<string, unknown> | null | undefined,
): Record<string, { longForm: string; shortForm: string }> | null {
  if (!abbreviationLogic || typeof abbreviationLogic !== 'object') return null;
  const out: Record<string, { longForm: string; shortForm: string }> = {};
  for (const [key, val] of Object.entries(abbreviationLogic)) {
    if (!key || /^\s*$/.test(key)) continue;
    if (typeof val === 'string') {
      const s = val.trim();
      if (!s) continue;
      const abbr = extractAbbreviationFromValue(s) ?? s;
      out[key] = { longForm: s, shortForm: abbr };
    } else if (val != null && typeof val === 'object' && !Array.isArray(val)) {
      const o = val as Record<string, unknown>;
      const long = (typeof o.longForm === 'string' ? o.longForm : typeof o.value === 'string' ? o.value : '').trim();
      const short = (typeof o.shortForm === 'string' ? o.shortForm : '').trim();
      if (long || short) out[key] = { longForm: long || short, shortForm: short || long };
    }
  }
  return Object.keys(out).length > 0 ? out : null;
}

/**
 * Total Cyrillic Ban: (1) Single-pass replace (key) and whole-word key with target from DNA (placeholders then targets);
 * (2) Fuzzy-match remaining Cyrillic to DNA keys (Cyrillic keys only); (3) Remove any remaining Cyrillic.
 * When targetLocale is a Cyrillic language (e.g. ru, uk), step (3) is skipped so the translation is not stripped.
 * Uses normalized abbreviationLogic (longForm/shortForm) so longForm→shortForm replacement (abbreviationRedundancy) works.
 */
export function applyTotalCyrillicBan(
  text: string,
  abbreviationLogic: Record<string, unknown> | null | undefined,
  targetLocale?: string,
): string {
  if (!text || typeof text !== 'string') return text;

  const skipCyrillicRemoval = isCyrillicTargetLocale(targetLocale);

  const normalized = normalizeAbbreviationLogicForReplacement(abbreviationLogic);
  const logic = normalized ?? (abbreviationLogic && typeof abbreviationLogic === 'object' ? abbreviationLogic : null);

  let result = text;
  let untranslatableKeys: string[] = [];
  if (logic && typeof logic === 'object') {
    const { pairs, untranslatableKeys: untrans } = buildReplacementPairs(logic);
    untranslatableKeys = untrans;
    result = applyReplacementsWithPlaceholders(result, pairs);
    result = applyDnaFuzzyMatch(result, logic);
    // Enforce abbreviationRedundancy: replace longForm with shortForm, but NEVER in definition lines ("Key – Value").
    // Protected Definition: in Section 4 (Glossary) only direct substitution is applied; longForm→shortForm is skipped for the value part.
    const longFormPairs = buildLongFormToShortFormPairs(logic);
    if (longFormPairs.length > 0) {
      result = applyLongFormToShortFormWithProtectedDefinitions(result, longFormPairs);
    }
    // Deterministic post-processing: remove consecutive duplicate abbreviations (e.g. "AMRSD AMRSD" → "AMRSD").
    result = collapseConsecutiveDuplicateWords(result);
  }

  if (skipCyrillicRemoval) {
    return result;
  }

  if (untranslatableKeys.length > 0) {
    const placeholder = '\uE000';
    let protectedResult = result;
    for (let i = 0; i < untranslatableKeys.length; i++) {
      const k = untranslatableKeys[i];
      const flexible = keyToPattern(k);
      protectedResult = protectedResult.replace(new RegExp(flexible, 'gi'), `${placeholder}${i}${placeholder}`);
    }
    protectedResult = protectedResult.replace(/[\u0400-\u04FF]+/g, '');
    for (let i = 0; i < untranslatableKeys.length; i++) {
      protectedResult = protectedResult.replace(`${placeholder}${i}${placeholder}`, untranslatableKeys[i]);
    }
    result = protectedResult;
  } else {
    result = result.replace(/[\u0400-\u04FF]+/g, '');
  }
  return result;
}

/**
 * Get long form (full string) for a DNA value for deduplication. Prefer longForm field, else full value string.
 */
function getLongFormForDedupe(v: unknown): string | null {
  if (v == null) return null;
  if (typeof v === 'string') return v.trim() || null;
  if (typeof v === 'object' && v !== null) {
    const o = v as Record<string, unknown>;
    if (typeof o.longForm === 'string') return o.longForm.trim() || null;
    if (typeof o.value === 'string') return o.value.trim() || null;
  }
  return null;
}

/**
 * Fix "Full Form – Full Form" duplication: when the same phrase appears on both sides of a dash,
 * replace the second with the abbreviation from DNA so output is "Full Form (ABBR) – ABBR".
 */
export function deduplicateFullFormDash(
  text: string,
  abbreviationLogic: Record<string, unknown> | null | undefined,
): string {
  if (!text || typeof text !== 'string') return text;
  if (!abbreviationLogic || typeof abbreviationLogic !== 'object') return text;

  let result = text;
  for (const [, value] of Object.entries(abbreviationLogic)) {
    const longForm = getLongFormForDedupe(value);
    const shortForm = extractAbbreviationFromValue(value);
    if (!longForm || !shortForm || longForm === shortForm) continue;
    const escaped = escapeRegex(longForm);
    const pattern = new RegExp(`(${escaped})\\s+[–-]\\s+\\1`, 'g');
    result = result.replace(pattern, `$1 – ${shortForm}`);
  }
  return result;
}
