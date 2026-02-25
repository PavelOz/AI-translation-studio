/**
 * Heuristic detection of abbreviation patterns in document text.
 * Scans for "X (ABBR)", "X – ABBR", "ABBR – X", "X (далее – ABBR)" to suggest candidates for DNA.
 * Optional / lower priority; results can be suggested for DNA or flagged for human review.
 */

export type AbbreviationCandidate = { fullForm: string; abbr: string; pattern: string };

/** Match "Full Form (ABBR)" - ABBR is uppercase letters/numbers in parens. */
const PATTERN_IN_PARENS = /([^\n(]+?)\s*\(\s*([A-Z][A-Z0-9]{1,})\s*\)/g;

/** Match "Full Form – ABBR" or "Full Form - ABBR" (dash). */
const PATTERN_DASH_ABBR = /([^\n–-]+?)\s+[–-]\s+([A-Z][A-Z0-9]{1,})\s*$/gm;

/** Match "ABBR – Full Form" (abbreviation first). */
const PATTERN_ABBR_DASH = /^\s*([A-Z][A-Z0-9]{1,})\s+[–-]\s+([^\n]+?)\s*$/gm;

/** Match "X (далее – ABBR)" or similar "further – ABBR" in parens. */
const PATTERN_DALEE = /([^\n(]+?)\s*\(\s*(?:далее|далее по тексту|hereinafter)\s*[–-]\s*([A-Z][A-Z0-9]{1,})\s*\)/gi;

function* runAll( re: RegExp, text: string ): Generator<RegExpExecArray> {
  const r = new RegExp(re.source, re.flags);
  let m: RegExpExecArray | null;
  while ((m = r.exec(text)) !== null) yield m;
}

/**
 * Extract candidate (fullForm, abbr) pairs from document text using regex patterns.
 * Deduplicates by normalized key (abbr lowercase).
 */
export function extractAbbreviationCandidates(text: string): AbbreviationCandidate[] {
  if (!text || typeof text !== 'string') return [];

  const seen = new Set<string>();
  const candidates: AbbreviationCandidate[] = [];

  const add = (fullForm: string, abbr: string, pattern: string) => {
    const f = fullForm.trim();
    const a = abbr.trim();
    if (!f || !a) return;
    const key = `${a.toLowerCase()}`;
    if (seen.has(key)) return;
    seen.add(key);
    candidates.push({ fullForm: f, abbr: a, pattern });
  };

  for (const m of runAll(PATTERN_IN_PARENS, text)) {
    add(m[1].trim(), m[2], 'X (ABBR)');
  }
  for (const m of runAll(PATTERN_DASH_ABBR, text)) {
    add(m[1].trim(), m[2], 'X – ABBR');
  }
  for (const m of runAll(PATTERN_ABBR_DASH, text)) {
    add(m[2].trim(), m[1], 'ABBR – X');
  }
  for (const m of runAll(PATTERN_DALEE, text)) {
    add(m[1].trim(), m[2], 'X (далее – ABBR)');
  }

  return candidates;
}
