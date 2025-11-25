import { distance as levenshteinDistance } from 'fastest-levenshtein';

const normalizeText = (text: string) => text.toLowerCase().replace(/\s+/g, ' ').trim();

const tokenize = (text: string) => {
  const normalized = normalizeText(text);
  if (!normalized) {
    return new Set<string>();
  }
  return new Set(normalized.split(' ').filter(Boolean));
};

export type FuzzyScoreBreakdown = {
  score: number;
  levenshteinRatio: number;
  tokenOverlapRatio: number;
};

export const computeFuzzyScore = (source: string, candidate: string): FuzzyScoreBreakdown => {
  const normalizedSource = normalizeText(source);
  const normalizedCandidate = normalizeText(candidate);

  if (!normalizedSource || !normalizedCandidate) {
    return { score: 0, levenshteinRatio: 0, tokenOverlapRatio: 0 };
  }

  if (normalizedSource === normalizedCandidate) {
    return { score: 100, levenshteinRatio: 1, tokenOverlapRatio: 1 };
  }

  const maxLength = Math.max(normalizedSource.length, normalizedCandidate.length, 1);
  const levenshtein = levenshteinDistance(normalizedSource, normalizedCandidate);
  const levenshteinRatio = Math.max(0, 1 - levenshtein / maxLength);

  const sourceTokens = tokenize(normalizedSource);
  const candidateTokens = tokenize(normalizedCandidate);

  let intersectionSize = 0;
  sourceTokens.forEach((token) => {
    if (candidateTokens.has(token)) {
      intersectionSize += 1;
    }
  });

  const unionSize = new Set([...sourceTokens, ...candidateTokens]).size || 1;
  const tokenOverlapRatio = intersectionSize / unionSize;

  const score = Math.round((levenshteinRatio * 0.7 + tokenOverlapRatio * 0.3) * 100);

  return {
    score,
    levenshteinRatio,
    tokenOverlapRatio,
  };
};



