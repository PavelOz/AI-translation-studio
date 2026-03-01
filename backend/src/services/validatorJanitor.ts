/**
 * Validator-Janitor: batch verification and programmatic correction of translation
 * by Document DNA rules. Direction-agnostic (config: forbiddenScripts, legalKeywords).
 */

import { prisma } from '../db/prisma';
import { getDocumentDna } from './analysis.service';
import { normalizeDocumentDnaPayloadOrNull } from './dnaSchema';
import {
  runJanitorCleaner,
  collapseConsecutiveDuplicateWords,
} from './translation.service';

export type ValidationConfig = {
  forbiddenScripts: string[];
  legalKeywords: string[];
};

export type JanitorErrorType = 'FORBIDDEN_SCRIPT' | 'SUSPICIOUS_ABBREV';

export type UnfixableEntry = {
  segmentId: string;
  segmentIndex?: number;
  errorType: JanitorErrorType;
  detail?: string;
};

export type JanitorCounts = {
  legalKeywordRemoved: number;
  bracketDupRemoved: number;
  spaceDupRemoved: number;
  identityProtectionFixed: number;
  forbiddenScriptSegments: number;
  suspiciousAbbrevCount: number;
};

export type JanitorReport = {
  documentId: string;
  documentName?: string;
  direction: string;
  totalSegments: number;
  counts: JanitorCounts;
  unfixable: UnfixableEntry[];
  spotCheckSegmentIds: string[];
  preflightFailed?: string;
};

const DEFINITION_LINE_REGEX = /^\s*(.+?)\s+[–-]\s+(.*)$/;
const CYRILLIC_REGEX = /[\u0400-\u04FF]/;
const BASIC_LATIN_REGEX = /[a-zA-Z]/;
const PREFLIGHT_SAMPLE_SIZE = 10;
const SPOT_CHECK_SIZE = 500;

/** Default config for RU→EN. For EN→RU use forbiddenScripts: ['latin'], legalKeywords: ['далее'] etc. */
export function getValidationConfig(
  sourceLocale: string,
  targetLocale: string,
  dna?: { namingConventions?: Record<string, unknown> } | null,
): ValidationConfig {
  const src = (sourceLocale || '').toLowerCase().split(/[-_]/)[0];
  const tgt = (targetLocale || '').toLowerCase().split(/[-_]/)[0];
  const fromConfig = dna?.namingConventions as Record<string, unknown> | undefined;
  const forbiddenScripts =
    (fromConfig?.forbiddenScripts as string[] | undefined) ??
    (tgt === 'en' || tgt === 'eng' ? ['cyrillic'] : src === 'en' || src === 'eng' ? ['latin'] : ['cyrillic']);
  const legalKeywords =
    (fromConfig?.legalKeywords as string[] | undefined) ??
    (tgt === 'en' || tgt === 'eng' ? ['hereinafter'] : ['далее']);
  return { forbiddenScripts, legalKeywords };
}

function buildForbiddenScriptRegex(forbiddenScripts: string[]): RegExp | null {
  if (!forbiddenScripts.length) return null;
  const parts: string[] = [];
  for (const s of forbiddenScripts) {
    const t = s.toLowerCase();
    if (t === 'cyrillic') parts.push('\\u0400-\\u04FF');
    else if (t === 'latin') parts.push('a-zA-Z');
  }
  if (parts.length === 0) return null;
  if (parts.length === 1 && parts[0] === 'a-zA-Z') return BASIC_LATIN_REGEX;
  if (parts.length === 1 && parts[0] === '\\u0400-\\u04FF') return CYRILLIC_REGEX;
  return new RegExp(`[${parts.join('')}]`);
}

/** Build map shortForm -> longForm from normalized abbreviationLogic for Identity Protection. */
function buildShortFormToLongFormMap(
  abbreviationLogic: Record<string, { longForm: string; shortForm: string }> | null | undefined,
): Map<string, string> {
  const map = new Map<string, string>();
  if (!abbreviationLogic || typeof abbreviationLogic !== 'object') return map;
  for (const [, v] of Object.entries(abbreviationLogic)) {
    if (v && typeof v.shortForm === 'string' && typeof v.longForm === 'string') {
      const s = v.shortForm.trim();
      const l = v.longForm.trim();
      if (s && l) map.set(s.toLowerCase(), l);
    }
  }
  return map;
}

/** Apply Identity Protection: "Key – Key" → "Key – longForm" using DNA. */
function applyIdentityProtection(
  text: string,
  shortToLong: Map<string, string>,
): { text: string; fixedCount: number } {
  if (shortToLong.size === 0) return { text, fixedCount: 0 };
  const lines = text.split(/\r?\n/);
  let fixedCount = 0;
  const out = lines.map((line) => {
    const m = line.match(DEFINITION_LINE_REGEX);
    if (!m) return line;
    const label = m[1].trim();
    const value = m[2].trim();
    const labelNorm = label.toLowerCase();
    const valueNorm = value.toLowerCase();
    if (labelNorm !== valueNorm) return line;
    const longForm = shortToLong.get(labelNorm);
    if (!longForm) return line;
    fixedCount++;
    const dash = line.includes('\u2013') ? '\u2013' : '-';
    return `${label} ${dash} ${longForm}`;
  });
  return { text: out.join('\n'), fixedCount };
}

/** Detect if text contains forbidden script. */
function hasForbiddenScript(text: string, regex: RegExp | null): boolean {
  if (!regex) return false;
  return regex.test(text);
}

/** Collect tokens that look like abbreviations but are not in DNA. */
function findSuspiciousAbbrevs(
  text: string,
  knownKeys: Set<string>,
  knownShortForms: Set<string>,
  whitelist: Set<string>,
): string[] {
  // Create normalized sets for case-insensitive comparison
  const knownKeysLower = new Set(Array.from(knownKeys).map(k => k.toLowerCase()));
  const knownShortFormsLower = new Set(Array.from(knownShortForms).map(sf => sf.toLowerCase()));
  
  const tokens = text.match(/\p{L}+/gu) ?? [];
  const suspicious: string[] = [];
  const seen = new Set<string>();
  for (const t of tokens) {
    if (t.length < 2 || t.length > 10) continue;
    if (whitelist.has(t.toLowerCase())) continue;
    
    // Case-insensitive check: check both original case and lowercase
    const tLower = t.toLowerCase();
    if (knownKeys.has(t) || knownKeysLower.has(tLower)) continue;
    if (knownShortForms.has(t) || knownShortFormsLower.has(tLower)) continue;
    
    if (seen.has(tLower)) continue;
    seen.add(tLower);
    suspicious.push(t);
  }
  return suspicious;
}

const COMMON_WORDS = new Set(
  'the and for are but not you all can had her was one our out day get has him his how man new now old see way who boy did its let put say she too use'.split(' '),
);

export async function runValidatorJanitor(
  documentId: string,
  options?: { dryRun?: boolean; preflightSampleSize?: number },
): Promise<JanitorReport> {
  const dryRun = options?.dryRun !== false;
  const preflightN = options?.preflightSampleSize ?? PREFLIGHT_SAMPLE_SIZE;

  const doc = await prisma.document.findUnique({
    where: { id: documentId },
    select: { id: true, name: true, sourceLocale: true, targetLocale: true },
  });
  if (!doc) {
    throw new Error(`Document not found: ${documentId}`);
  }

  const rawDna = await getDocumentDna(documentId);
  const dna = normalizeDocumentDnaPayloadOrNull(rawDna) ?? rawDna;
  const config = getValidationConfig(doc.sourceLocale ?? '', doc.targetLocale ?? '', dna);

  const forbiddenRegex = buildForbiddenScriptRegex(config.forbiddenScripts);
  const abbrevLogic = dna?.abbreviationLogic as Record<string, { longForm: string; shortForm: string }> | undefined;
  const shortToLong = buildShortFormToLongFormMap(abbrevLogic);
  const knownKeys = new Set(
    abbrevLogic && typeof abbrevLogic === 'object' ? Object.keys(abbrevLogic) : [],
  );
  const knownShortForms = new Set(
    abbrevLogic && typeof abbrevLogic === 'object'
      ? Object.values(abbrevLogic).map((v) => (v && typeof v.shortForm === 'string' ? v.shortForm : '')).filter(Boolean)
      : [],
  );

  const segments = await prisma.segment.findMany({
    where: { documentId },
    orderBy: { segmentIndex: 'asc' },
    select: { id: true, segmentIndex: true, targetMt: true, targetFinal: true },
  });

  const direction = `${doc.sourceLocale ?? 'ru'}→${doc.targetLocale ?? 'en'}`;
  const counts: JanitorCounts = {
    legalKeywordRemoved: 0,
    bracketDupRemoved: 0,
    spaceDupRemoved: 0,
    identityProtectionFixed: 0,
    forbiddenScriptSegments: 0,
    suspiciousAbbrevCount: 0,
  };
  const unfixable: UnfixableEntry[] = [];
  const segmentIds: string[] = [];
  const updates: { id: string; text: string }[] = [];

  const sample = segments.slice(0, preflightN);
  const sampleTexts = sample.map((s) => (s.targetFinal ?? s.targetMt ?? '').trim()).filter(Boolean);
  if (sampleTexts.length > 0 && forbiddenRegex) {
    const withForbidden = sampleTexts.filter((t) => hasForbiddenScript(t, forbiddenRegex));
    const ratio = withForbidden.length / sampleTexts.length;
    if (ratio > 0.8) {
      return {
        documentId,
        documentName: doc.name ?? undefined,
        direction,
        totalSegments: segments.length,
        counts,
        unfixable: [],
        spotCheckSegmentIds: [],
        preflightFailed: 'Direction in DNA does not match text (e.g. target should be Latin but sample is mostly Cyrillic).',
      };
    }
  }

  for (const seg of segments) {
    const original = (seg.targetFinal ?? seg.targetMt ?? '').trim();
    segmentIds.push(seg.id);

    let text = original;
    const beforeCleaner = text;
    text = runJanitorCleaner(text, { legalKeywords: config.legalKeywords });
    if (text !== beforeCleaner) {
      const beforeCollapse = beforeCleaner;
      const afterCollapse = collapseConsecutiveDuplicateWords(beforeCleaner);
      if (afterCollapse !== beforeCollapse) counts.spaceDupRemoved++;
      counts.legalKeywordRemoved++;
    }

    const { text: afterIdentity, fixedCount } = applyIdentityProtection(text, shortToLong);
    text = afterIdentity;
    counts.identityProtectionFixed += fixedCount;

    if (hasForbiddenScript(text, forbiddenRegex)) {
      counts.forbiddenScriptSegments++;
      unfixable.push({
        segmentId: seg.id,
        segmentIndex: seg.segmentIndex,
        errorType: 'FORBIDDEN_SCRIPT',
        detail: 'Contains characters from forbidden script',
      });
    }

    const suspicious = findSuspiciousAbbrevs(text, knownKeys, knownShortForms, COMMON_WORDS);
    if (suspicious.length > 0) {
      counts.suspiciousAbbrevCount += suspicious.length;
      unfixable.push({
        segmentId: seg.id,
        segmentIndex: seg.segmentIndex,
        errorType: 'SUSPICIOUS_ABBREV',
        detail: suspicious.slice(0, 5).join(', '),
      });
    }

    if (text !== original) {
      updates.push({ id: seg.id, text });
    }
  }

  const spotCheckSegmentIds = [...segmentIds]
    .sort(() => Math.random() - 0.5)
    .slice(0, SPOT_CHECK_SIZE);

  if (!dryRun && updates.length > 0) {
    for (const u of updates) {
      await prisma.segment.update({
        where: { id: u.id },
        data: { targetMt: u.text, targetFinal: u.text },
      });
    }
  }

  return {
    documentId,
    documentName: doc.name ?? undefined,
    direction,
    totalSegments: segments.length,
    counts,
    unfixable,
    spotCheckSegmentIds,
  };
}
