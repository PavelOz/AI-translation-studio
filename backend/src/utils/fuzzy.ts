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

/**
 * Extract all numbers from text (simple approach without complex regex)
 * Returns an array of all digit sequences found in the text
 */
const extractNumbers = (text: string): string[] => {
  const numbers: string[] = [];
  let currentNumber = '';
  
  // Simple character-by-character scan to find all digit sequences
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (/\d/.test(char)) {
      // Accumulate digits
      currentNumber += char;
    } else {
      // Non-digit character - if we have accumulated digits, save them
      if (currentNumber.length > 0) {
        numbers.push(currentNumber);
        currentNumber = '';
      }
    }
  }
  
  // Don't forget the last number if text ends with digits
  if (currentNumber.length > 0) {
    numbers.push(currentNumber);
  }
  
  return numbers;
};

/**
 * Extract critical factual data (numbers) from text
 * Returns an array of all numbers found in the text
 */
const extractFactualData = (text: string): string[] => {
  // Simply extract all numbers - no complex regex needed
  return extractNumbers(text);
};

/**
 * Check if there are critical factual differences between two texts
 * Returns true if critical data (numbers, dates) differ
 */
const hasCriticalFactualDifferences = (source: string, candidate: string): boolean => {
  const sourceFactual = new Set(extractFactualData(source));
  const candidateFactual = new Set(extractFactualData(candidate));
  
  // If one has factual data and the other doesn't, or counts differ, it's a critical difference
  if (sourceFactual.size !== candidateFactual.size) {
    return true;
  }
  
  // If no factual data in either, no critical difference
  if (sourceFactual.size === 0) {
    return false;
  }
  
  // Check if all factual data matches (order-independent)
  for (const item of sourceFactual) {
    if (!candidateFactual.has(item)) {
      return true; // Found a mismatch in factual data
    }
  }
  
  return false;
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

  // Check for critical factual differences (contract numbers, dates, etc.)
  // If factual data differs, cap the score at 95% even if text is otherwise very similar
  const hasCriticalDiff = hasCriticalFactualDifferences(source, candidate);

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

  let score = Math.round((levenshteinRatio * 0.7 + tokenOverlapRatio * 0.3) * 100);
  
  // Cap score at 95% if there are critical factual differences
  // This prevents 100% matches when contract numbers, dates, or other factual data differ
  if (hasCriticalDiff && score > 95) {
    score = 95;
  }

  return {
    score,
    levenshteinRatio,
    tokenOverlapRatio,
  };
};



