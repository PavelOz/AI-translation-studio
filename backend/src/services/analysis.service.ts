import { prisma } from '../db/prisma';
import { ApiError } from '../utils/apiError';
import { logger } from '../utils/logger';
import { getLanguageName } from '../utils/languages';
import {
  buildDnaGenerateSystemPrompt,
  buildDnaGenerateUserPrompt,
  buildDnaQcJudgeSystemPrompt,
  buildDnaQcJudgeUserPrompt,
  buildDnaRefineSystemPrompt,
  buildDnaRefineUserPrompt,
  buildGlossaryExtractSystemPrompt,
  buildGlossaryExtractUserPrompt,
  DNA_QC_MIN_SCORE,
  DNA_QC_SAMPLE_SIZE,
  getTranslationDirection,
  type DnaQcTermEntry,
  type GlossaryExtractPair,
} from './dnaPrompts';
import { upsertGlossaryEntry } from './glossary.service';
import { stripFormattingTags } from '../utils/segmentation';
import { normalizeDocumentDnaPayload } from './dnaSchema';
import { Prisma } from '@prisma/client';
// @ts-ignore - compromise doesn't have TypeScript types
import nlp from 'compromise';

// In-memory cancellation flags for analysis (similar to pretranslation)
const analysisCancellationFlags = new Set<string>();

/**
 * Check if analysis is cancelled for a document
 */
export const isAnalysisCancelled = (documentId: string): boolean => {
  return analysisCancellationFlags.has(documentId);
};

/**
 * Cancel analysis for a document
 */
export const cancelAnalysis = async (documentId: string): Promise<void> => {
  analysisCancellationFlags.add(documentId);
  logger.info({ documentId }, 'Analysis cancellation requested');
  
  // Immediately update status in database to reflect cancellation
  try {
    await prisma.documentAnalysis.update({
      where: { documentId },
      data: {
        status: 'CANCELLED',
        currentMessage: 'Analysis cancelled by user',
        completedAt: new Date(),
      },
    });
    logger.info({ documentId }, 'Analysis status updated to CANCELLED in database');
  } catch (error: any) {
    // If analysis doesn't exist yet, that's okay - flag is still set
    logger.debug({ documentId, error: error.message }, 'Could not update analysis status (may not exist yet)');
  }
};

/**
 * Clear cancellation flag (called when starting new analysis)
 */
const clearAnalysisCancellation = (documentId: string): void => {
  analysisCancellationFlags.delete(documentId);
};

/**
 * Helper function to clean JSON output from markdown code blocks
 * Removes ```json and ``` markers from the response
 */
const cleanJsonOutput = (text: string): string => {
  if (!text || typeof text !== 'string') {
    return text;
  }

  let cleaned = text.trim();

  // Remove markdown code block markers at the start (```json or ```)
  cleaned = cleaned.replace(/^```(?:json)?\s*\n?/i, '');

  // Remove markdown code block markers at the end (```)
  cleaned = cleaned.replace(/\n?```\s*$/i, '');

  return cleaned.trim();
};

/**
 * Attempt to repair truncated DNA JSON (e.g. when the model hit max_tokens and stopped mid-string).
 * Closes an unterminated string and balances open brackets so we can parse the partial result.
 */
const repairTruncatedDnaJson = (text: string): string => {
  if (!text || text.length === 0) return text;
  let openBraces = 0;
  let openBrackets = 0;
  let inString = false;
  let escape = false;
  let quoteChar = '';
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (escape) {
      escape = false;
      continue;
    }
    if (c === '\\' && inString) {
      escape = true;
      continue;
    }
    if (inString) {
      if (c === quoteChar) inString = false;
      continue;
    }
    if (c === '"' || c === "'") {
      inString = true;
      quoteChar = c;
      continue;
    }
    if (c === '{') openBraces++;
    else if (c === '}') openBraces--;
    else if (c === '[') openBrackets++;
    else if (c === ']') openBrackets--;
  }
  let repaired = text;
  if (inString) repaired = repaired + quoteChar;
  repaired = repaired + ']'.repeat(openBrackets) + '}'.repeat(openBraces);
  return repaired;
};

/**
 * Relax JSON that uses single-quoted keys or trailing commas (common LLM output).
 * - Replaces 'key': with "key": (single-quoted property names -> double-quoted).
 * - Removes trailing commas before } or ].
 */
const repairRelaxedDnaJson = (text: string): string => {
  if (!text || text.length === 0) return text;
  let out = text;
  // Trailing commas before } or ]
  out = out.replace(/,(\s*[}\]])/g, '$1');
  // Single-quoted property names: after { or , we may have 'key': -> "key":
  out = out.replace(/([{,])\s*'([^']*)'\s*:/g, (_, before, key) =>
    before + ` "${key.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}": `
  );
  return out;
};

// Common stop words to filter out (shared between functions)
const stopWords = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for', 'of', 'with', 'by',
  'from', 'as', 'is', 'was', 'are', 'were', 'been', 'be', 'have', 'has', 'had', 'do', 'does', 'did',
  'will', 'would', 'should', 'could', 'may', 'might', 'must', 'can', 'this', 'that', 'these', 'those',
  'i', 'you', 'he', 'she', 'it', 'we', 'they', 'me', 'him', 'her', 'us', 'them',
  'what', 'which', 'who', 'whom', 'whose', 'where', 'when', 'why', 'how',
  'if', 'then', 'else', 'because', 'since', 'although', 'though', 'while', 'until', 'unless',
  'not', 'no', 'yes', 'all', 'each', 'every', 'some', 'any', 'many', 'much', 'more', 'most', 'few', 'little',
  'very', 'too', 'so', 'such', 'just', 'only', 'also', 'even', 'still', 'yet', 'already',
  'here', 'there', 'where', 'when', 'why', 'how', 'now', 'then', 'today', 'yesterday', 'tomorrow',
  'up', 'down', 'out', 'off', 'over', 'under', 'above', 'below', 'through', 'across', 'between', 'among',
  'about', 'into', 'onto', 'upon', 'within', 'without', 'during', 'before', 'after', 'during',
  'table', 'of', 'contents', 'page', 'section', 'chapter', 'figure', 'table', 'list', 'item',
  'report', 'document', 'page', 'section', 'chapter', 'paragraph', 'sentence', 'word',
]);

// Russian stopwords for filtering candidates (Prepositions, Conjunctions, Common Words)
const RUSSIAN_STOPWORDS = new Set([
  'для', 'на', 'по', 'из', 'от', 'до', 'с', 'со', 'в', 'во', 'об', 'обо', 
  'при', 'под', 'над', 'без', 'через', 'год', 'года', 'лет', 'г', 
  'или', 'и', 'но', 'а', 'как', 'так', 'что', 'бы', 'ли', 'же', 
  'то', 'те', 'эти', 'этом', 'того', 'тем', 'чем', 'кем',
  'не', 'ни', 'быть', 'был', 'была', 'были', 'будет',
  'менее', 'более', 'случае', 'порядке', // Common bureaucratic noise
  'он', 'она', 'оно', 'они', 'мы', 'вы', 'я', 'ты', 'все', 'всё', 'это',
  'тот', 'свой', 'ваш', 'наш'
]);

/**
 * Helper function to check if a phrase is relevant for glossary extraction
 * 
 * This function filters out garbage terms like "User 4 1" (table artifacts) and "Page 15",
 * while preserving important acronyms like "HV" (High Voltage) and standard technical terms.
 * 
 * @param phrase - The phrase to check
 * @returns true if the phrase should be included in glossary extraction, false otherwise
 */
export const isRelevant = (phrase: string): boolean => {
    // 1. Length check & Acronym Rescue
    if (phrase.length < 3) {
      // RESCUE: Allow if it's a 2-character, all-uppercase acronym
      // This checks for Latin and Cyrillic uppercase letters.
      if (phrase.length === 2 && phrase === phrase.toUpperCase() && /[A-ZА-Я]/.test(phrase)) {
        
        // Anti-Noise Check: Block common 2-letter words like "ON" or "AS" that might be capitalized.
        // NOTE: The stopWords set already handles much of this, but this adds a final safeguard.
        const minimalAcronymStoplist = new Set(['no', 'in', 'of', 'as', 'at', 'on', 'if', 'or', 'by', 'up']);
        if (!minimalAcronymStoplist.has(phrase.toLowerCase())) {
          return true; // Acronym Rescued (e.g., HV, MV, ID)
        }
      }
      return false; // Otherwise, block all phrases shorter than 3
    }

    // 2. Stop words check (Original Logic)
    if (stopWords.has(phrase.toLowerCase())) return false;
    
    // 3a. Reject phrases starting with numbers
    if (/^\d/.test(phrase)) return false;
    
    // 3b. Reject phrases with no letters
    if (!/[a-zA-Zа-яА-Я]/.test(phrase)) return false;
    
    // 3c. Reject "Word Number Number" pattern (Table Artifact)
    if (/^[a-zA-Zа-яА-Я]+\s+\d+(\s+\d+)*$/.test(phrase)) return false;
    
    // 3d. Reject if more digits than letters
    const letterCount = (phrase.match(/[a-zA-Zа-яА-Я]/g) || []).length;
    const digitCount = (phrase.match(/\d/g) || []).length;
    if (digitCount > letterCount && digitCount > 0) return false;
    
    // 3e. Reject common table artifact prefixes (e.g., user 4)
    const lowerPhrase = phrase.toLowerCase();
    if (/^(user|document|table|row|column|item|entry)\s+\d+/.test(lowerPhrase)) return false;

    return true;
};

/**
 * Helper function to extract frequent terms from text using n-gram analysis
 * Returns phrases (unigrams, bigrams, trigrams) that appear 2+ times (or 1+ in deep mode for long terms)
 */
/**
 * Helper function to detect if a term contains verbs or is a sentence fragment
 * Returns true if the term should be REJECTED (contains verb or is fragment)
 */
const isVerbOrFragment = (term: string, targetTerm: string): boolean => {
  const lowerTerm = term.toLowerCase();
  const lowerTarget = targetTerm.toLowerCase();
  
  // Common verbs in English (target language) - EXPANDED list
  const englishVerbs = /\b(is|are|was|were|be|been|being|have|has|had|do|does|did|will|would|shall|should|may|might|can|could|must|signed|drawn|up|ensure|monitor|provide|provides|provided|establish|established|execute|executed|formalize|formalized|sent|send|sends|payable|undergoing|undergo|directed|consider|considers|considers|passage|passages|forwarded|forward|forwards|set|sets)\b/i;
  
  // Common verbs in Russian (source language patterns) - EXPANDED list
  const russianVerbPatterns = /(выплачиваемая|направляется|оформляется|оформляются|подписанным|подписан|обеспечением|обеспечивается|устанавливаются|устанавливается|рассматривать|рассматривает|прохождения|прохождение|предусмотренные|предусмотренных)/i;
  
  // Sentence fragment indicators - EXPANDED list
  const fragmentIndicators = /\b(by the|due to|in accordance with|in order to|for the|of the|to the|from the|with the|by a|by an|is sent to|are sent to|payable by|executed by|formalized by|is forwarded to|are forwarded to|provided in|provided for|provided by|with equipment|with tools|from representatives|to representatives)\b/i;
  
  // Check target term (English) for verbs and fragments
  if (englishVerbs.test(lowerTarget) || fragmentIndicators.test(lowerTarget)) {
    return true;
  }
  
  // Check source term (Russian) for verb patterns
  if (russianVerbPatterns.test(lowerTerm)) {
    return true;
  }
  
  // Check for sentence-like structures (contains prepositions that suggest fragments)
  const prepositionCount = (lowerTarget.match(/\b(by|to|from|with|for|of|in|on|at|under|over)\b/g) || []).length;
  if (prepositionCount >= 2 && lowerTarget.split(' ').length <= 6) {
    // Likely a sentence fragment like "by the legislation of" or "employees with equipment and tools"
    return true;
  }
  
  // Check for verb-like patterns: "X with Y" or "X from Y" where X is a noun and Y suggests action
  if (lowerTarget.includes(' with ') && lowerTarget.split(' ').length <= 5) {
    // "employees with equipment and tools" - fragment
    return true;
  }
  
  // Check for infinitive verbs at start: "consider", "provide", "establish", etc.
  const infinitiveVerbs = /^(consider|provide|establish|execute|formalize|forward|send|set|monitor|ensure)/i;
  if (infinitiveVerbs.test(lowerTarget)) {
    return true;
  }
  
  return false;
};

/**
 * Extract n-grams (1-4 words) from text with frequency counts
 * Returns array of objects with term and count
 */
const extractNGrams = (text: string): Array<{ term: string; count: number }> => {
  // Normalize text: lowercase, remove punctuation (keep spaces and alphanumeric)
  const normalized = text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ') // Remove punctuation, keep letters, numbers, spaces
    .replace(/\s+/g, ' ') // Normalize whitespace
    .trim();

  if (!normalized) {
    return [];
  }

  const words = normalized.split(' ').filter((word) => word.length > 0);
  const phraseFrequency = new Map<string, number>();

  // Generate unigrams (1-word), bigrams (2-word), trigrams (3-word), and 4-grams (4-word) phrases
  for (let i = 0; i < words.length; i++) {
    // Unigram
    const unigram = words[i];
    if (isRelevant(unigram)) {
      phraseFrequency.set(unigram, (phraseFrequency.get(unigram) || 0) + 1);
    }

    // Bigram
    if (i < words.length - 1) {
      const bigram = `${words[i]} ${words[i + 1]}`;
      // Only include if neither word is a stop word (or if it's a meaningful phrase)
      if (!stopWords.has(words[i]) || !stopWords.has(words[i + 1])) {
        if (isRelevant(bigram)) {
          phraseFrequency.set(bigram, (phraseFrequency.get(bigram) || 0) + 1);
        }
      }
    }

    // Trigram
    if (i < words.length - 2) {
      const trigram = `${words[i]} ${words[i + 1]} ${words[i + 2]}`;
      // Include if at least one word is not a stop word
      const hasNonStopWord = [words[i], words[i + 1], words[i + 2]].some((w) => !stopWords.has(w));
      if (hasNonStopWord && isRelevant(trigram)) {
        phraseFrequency.set(trigram, (phraseFrequency.get(trigram) || 0) + 1);
      }
    }

    // 4-gram
    if (i < words.length - 3) {
      const fourgram = `${words[i]} ${words[i + 1]} ${words[i + 2]} ${words[i + 3]}`;
      // Include if at least one word is not a stop word
      const hasNonStopWord = [words[i], words[i + 1], words[i + 2], words[i + 3]].some((w) => !stopWords.has(w));
      if (hasNonStopWord && isRelevant(fourgram)) {
        phraseFrequency.set(fourgram, (phraseFrequency.get(fourgram) || 0) + 1);
      }
    }
  }

  // Convert to array of objects with term and count
  return Array.from(phraseFrequency.entries())
    .map(([term, count]) => ({ term, count }))
    .sort((a, b) => {
      // Sort by count (descending), then by length (longer first), then alphabetically
      if (b.count !== a.count) return b.count - a.count;
      const lengthDiff = b.term.length - a.term.length;
      if (lengthDiff !== 0) return lengthDiff;
      return a.term.localeCompare(b.term);
    });
};

const extractFrequentTerms = (text: string, mode: 'fast' | 'deep' = 'fast'): string[] => {
  // Normalize text: lowercase, remove punctuation (keep spaces and alphanumeric)
  const normalized = text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ') // Remove punctuation, keep letters, numbers, spaces
    .replace(/\s+/g, ' ') // Normalize whitespace
    .trim();

  if (!normalized) {
    return [];
  }

  const words = normalized.split(' ').filter((word) => word.length > 0);
  const phraseFrequency = new Map<string, number>();

  // Generate unigrams (1-word), bigrams (2-word), and trigrams (3-word) phrases
  for (let i = 0; i < words.length; i++) {
    // Unigram
    const unigram = words[i];
    if (isRelevant(unigram)) {
      phraseFrequency.set(unigram, (phraseFrequency.get(unigram) || 0) + 1);
    }

    // Bigram
    if (i < words.length - 1) {
      const bigram = `${words[i]} ${words[i + 1]}`;
      // Only include if neither word is a stop word (or if it's a meaningful phrase)
      if (!stopWords.has(words[i]) || !stopWords.has(words[i + 1])) {
        if (isRelevant(bigram)) {
          phraseFrequency.set(bigram, (phraseFrequency.get(bigram) || 0) + 1);
        }
      }
    }

    // Trigram
    if (i < words.length - 2) {
      const trigram = `${words[i]} ${words[i + 1]} ${words[i + 2]}`;
      // Include if at least one word is not a stop word
      const hasNonStopWord = [words[i], words[i + 1], words[i + 2]].some((w) => !stopWords.has(w));
      if (hasNonStopWord && isRelevant(trigram)) {
        phraseFrequency.set(trigram, (phraseFrequency.get(trigram) || 0) + 1);
      }
    }
  }

  // Dynamic minimum frequency based on mode
  // Deep mode: Allow single-occurrence terms, especially long compound nouns (3+ words)
  // Fast mode: Require 2+ occurrences (traditional frequency threshold)
  const minFrequency = mode === 'deep' ? 1 : 2;
  
  // #region agent log
  fetch('http://127.0.0.1:7242/ingest/7f529324-455d-4ca1-81c1-cbc867a5b6ab',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'analysis.service.ts:186',message:'Frequency filtering params',data:{mode,minFrequency,totalPhrases:phraseFrequency.size},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'B'})}).catch(()=>{});
  // #endregion
  
  // Filter: return phrases that meet frequency threshold
  const frequentPhrases = Array.from(phraseFrequency.entries())
    .filter(([phrase, count]) => {
      if (count >= minFrequency) return true;
      
      // BRUTE FORCE DEEP MODE: Accept ANY phrase with 2+ words, even if it appears only once.
      // This ensures we catch specific table rows like "Arc Flash Suit" (3 words, freq 1).
      if (mode === 'deep' && count === 1) {
        const wordCount = phrase.split(/\s+/).length;
        if (wordCount >= 2) {
          // #region agent log
          fetch('http://127.0.0.1:7242/ingest/7f529324-455d-4ca1-81c1-cbc867a5b6ab',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'analysis.service.ts:195',message:'Deep mode: Accepting 1-freq phrase',data:{mode,phrase,wordCount,count,isRelevant:isRelevant(phrase)},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'B'})}).catch(()=>{});
          // #endregion
          return isRelevant(phrase);
        }
      }
      
      return false;
    })
    .map(([phrase]) => phrase)
    .filter((phrase) => isRelevant(phrase)); // Final filter pass

  // Also include unique terms (appearing once) that look like technical terms, proper nouns, or acronyms
  // This helps capture important terms that only appear once
  // In deep mode, this is more permissive (already handled above for 3+ word phrases)
  const uniqueTechnicalTerms = Array.from(phraseFrequency.entries())
    .filter(([phrase, count]) => {
      if (count !== 1) return false; // Only unique terms
      if (!isRelevant(phrase)) return false;
      
      // In deep mode, be more permissive with unique terms
      if (mode === 'deep') {
        // Include if it's a long compound noun (already handled above, but keep for 2-word phrases)
        const wordCount = phrase.split(' ').length;
        if (wordCount >= 2) {
          // 2+ word phrases are more likely to be technical terms
          return true;
        }
      }
      
      // Check if it looks like a technical term:
      // - All caps (likely acronym)
      // - Starts with capital (likely proper noun)
      // - Contains numbers (likely technical identifier)
      // - Longer than 5 chars (likely not a common word)
      const isAllCaps = phrase === phrase.toUpperCase() && phrase.length >= 2;
      const startsWithCapital = /^[A-ZА-Я]/.test(phrase);
      const containsNumbers = /\d/.test(phrase);
      const isLongEnough = phrase.length > 5;
      
      return isAllCaps || (startsWithCapital && isLongEnough) || containsNumbers;
    })
    .map(([phrase]) => phrase);

  // Combine and sort
  const allPhrases = [...frequentPhrases, ...uniqueTechnicalTerms]
    .sort((a, b) => {
      // Sort by length (longer phrases first) then alphabetically
      const lengthDiff = b.length - a.length;
      if (lengthDiff !== 0) return lengthDiff;
      return a.localeCompare(b);
    });

  return allPhrases;
};

/**
 * Helper function to parse JSON array from AI response (handles incomplete JSON)
 * Shared between extractStyleRules and extractGlossary
 */
const parseJsonArray = (responseText: string, documentId: string): any[] => {
  // Remove markdown code block markers if present (```json ... ``` or ``` ... ```)
  let cleanedText = responseText.replace(/^```(?:json)?\s*\n?/i, '').replace(/\n?```\s*$/i, '');
  
  // Try to extract JSON array from response (in case AI adds extra text)
  let jsonText = cleanedText.trim();
  
  // Find the start of the array
  const arrayStart = jsonText.indexOf('[');
  if (arrayStart === -1) {
    throw new Error('No JSON array found in response');
  }
  
  // Find the end of the array - need to balance brackets properly
  let bracketCount = 0;
  let inString = false;
  let escapeNext = false;
  let arrayEnd = -1;
  
  for (let i = arrayStart; i < jsonText.length; i++) {
    const char = jsonText[i];
    
    if (escapeNext) {
      escapeNext = false;
      continue;
    }
    
    if (char === '\\') {
      escapeNext = true;
      continue;
    }
    
    if (char === '"' && !escapeNext) {
      inString = !inString;
      continue;
    }
    
    if (!inString) {
      if (char === '[') {
        bracketCount++;
      } else if (char === ']') {
        bracketCount--;
        if (bracketCount === 0) {
          arrayEnd = i;
          break;
        }
      }
    }
  }
  
  // If array is not properly closed, try to fix it
  if (arrayEnd === -1 || bracketCount !== 0) {
    logger.warn(
      {
        documentId,
        bracketCount,
        arrayStart,
        arrayEnd,
        jsonTextLength: jsonText.length,
      },
      'JSON array appears incomplete, attempting to fix',
    );
    
    // Find all complete objects by parsing forward
    inString = false;
    escapeNext = false;
    let braceDepth = 0;
    let objectStart = -1;
    const completeObjects: Array<{ start: number; end: number }> = [];
    
    // Parse forward to find all complete objects
    for (let i = arrayStart + 1; i < jsonText.length; i++) {
      const char = jsonText[i];
      
      if (escapeNext) {
        escapeNext = false;
        continue;
      }
      
      if (char === '\\') {
        escapeNext = true;
        continue;
      }
      
      if (char === '"' && !escapeNext) {
        inString = !inString;
        continue;
      }
      
      if (!inString) {
        if (char === '{') {
          if (braceDepth === 0) {
            objectStart = i;
          }
          braceDepth++;
        } else if (char === '}') {
          braceDepth--;
          if (braceDepth === 0 && objectStart >= 0) {
            // Found a complete object
            completeObjects.push({ start: objectStart, end: i });
            objectStart = -1;
          }
        }
      }
    }
    
    if (completeObjects.length > 0) {
      // Reconstruct JSON array from complete objects
      const objectStrings = completeObjects.map((obj) => jsonText.substring(obj.start, obj.end + 1));
      jsonText = '[' + objectStrings.join(',\n') + '\n]';
      logger.info(
        {
          documentId,
          completeObjectsCount: completeObjects.length,
          fixedLength: jsonText.length,
        },
        'Fixed incomplete JSON by reconstructing array from complete objects',
      );
    } else {
      // Fallback: try to find any } that might be an object end
      const simpleLastBrace = jsonText.lastIndexOf('}');
      if (simpleLastBrace > arrayStart) {
        let fixedJson = jsonText.substring(arrayStart, simpleLastBrace + 1);
        fixedJson = fixedJson.trim().replace(/,\s*$/, '') + '\n]';
        jsonText = fixedJson;
        logger.warn(
          { documentId, simpleLastBrace },
          'Using fallback method to fix incomplete JSON',
        );
      } else {
        throw new Error('JSON array is incomplete and cannot be fixed - no complete objects found');
      }
    }
  } else {
    // Extract the complete array
    jsonText = jsonText.substring(arrayStart, arrayEnd + 1);
  }
  
  const parsed = JSON.parse(jsonText);
  
  if (!Array.isArray(parsed)) {
    throw new Error('Response is not an array');
  }
  
  return parsed;
};

/**
 * Helper function to translate a term using AI
 */
/**
 * Cleans targetTerm from JSON array format (for backward compatibility with old mock responses)
 * If targetTerm is a JSON array, extracts target_mt from first item
 * Otherwise returns the term as-is
 */
const cleanTargetTerm = (targetTerm: string): string => {
  if (!targetTerm || typeof targetTerm !== 'string') {
    return targetTerm;
  }
  
  const trimmed = targetTerm.trim();
  
  // Check if it's a JSON array
  if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
    try {
      const parsed = JSON.parse(trimmed);
      if (Array.isArray(parsed) && parsed.length > 0) {
        // Try to extract target_mt from first item
        if (parsed[0].target_mt) {
          const extracted = parsed[0].target_mt.trim();
          // #region agent log
          fetch('http://127.0.0.1:7242/ingest/7f529324-455d-4ca1-81c1-cbc867a5b6ab',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'analysis.service.ts:352',message:'Cleaned targetTerm from JSON array',data:{originalLength:targetTerm.length,extractedLength:extracted.length,originalPreview:targetTerm.substring(0,50)},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'N'})}).catch(()=>{});
          // #endregion
          return extracted;
        }
      }
    } catch (e) {
      // If JSON parsing fails, return original
      // #region agent log
      fetch('http://127.0.0.1:7242/ingest/7f529324-455d-4ca1-81c1-cbc867a5b6ab',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'analysis.service.ts:365',message:'Failed to parse targetTerm as JSON, using original',data:{error:String(e)},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'N'})}).catch(()=>{});
      // #endregion
    }
  }
  
  return targetTerm;
};

const translateTermWithAI = async (
  sourceTerm: string,
  sourceLocale: string,
  targetLocale: string,
  provider: any,
  model: string,
): Promise<string> => {
  const translationPrompt = `🚨 CRITICAL: OUTPUT MUST BE RAW TRANSLATION ONLY.
1. DO NOT output "Thinking...", "THINK:", "Here is...", or any explanation.
2. DISABLE "Chain of Thought" logging. Just return the translation.
3. NO EXPLANATIONS, NO REASONING, NO METADATA. ONLY THE TRANSLATED TERM.

Translate the following technical term from ${sourceLocale} to ${targetLocale}. Return ONLY the translation, no explanation, no markdown, just the translated term.

Term: ${sourceTerm}`;

  // Use a model without thoughts for simple translation tasks
  // gemini-2.5-pro uses too many tokens for thoughts (499 out of 500), leaving no room for output
  // Try gemini-2.0-flash or gemini-pro-latest which may not use thoughts, or significantly increase maxTokens
  let translationModel = model;
  if (model.includes('2.5-pro') || model.includes('2.5-flash')) {
    // Try gemini-2.0-flash first (may not use thoughts), fallback to gemini-2.5-pro with very high maxTokens
    translationModel = 'gemini-2.0-flash';
  }

  // #region agent log
  fetch('http://127.0.0.1:7242/ingest/7f529324-455d-4ca1-81c1-cbc867a5b6ab',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'analysis.service.ts:364',message:'Calling AI for term translation',data:{sourceTerm,sourceTermLength:sourceTerm.length,originalModel:model,translationModel,maxTokens:200},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'D'})}).catch(()=>{});
  // #endregion

  try {
    const response = await provider.callModel({
      prompt: translationPrompt,
      systemPrompt: 'You are a professional translator. Translate technical terms accurately and concisely.',
      model: translationModel,
      temperature: 0.1,
      // Use very high maxTokens for models with thoughts (2.5-pro), normal for others
      maxTokens: translationModel.includes('2.5-pro') ? 2000 : (translationModel.includes('2.5-flash') ? 1000 : 200),
      segments: [],
    });

    // #region agent log
    fetch('http://127.0.0.1:7242/ingest/7f529324-455d-4ca1-81c1-cbc867a5b6ab',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'analysis.service.ts:376',message:'AI translation response received',data:{sourceTerm,rawResponse:response.outputText,rawResponseLength:response.outputText.length,trimmedResponse:response.outputText.trim(),trimmedLength:response.outputText.trim().length},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'D'})}).catch(()=>{});
    // #endregion

    let translated = response.outputText.trim();
    
    // CRITICAL FIX: Remove "THINK:" and "Chain of Thought" leakage
    if (translated.includes('THINK:') || translated.includes('Thinking:')) {
      // Extract only the actual translation (usually the last line or after "THINK:")
      const lines = translated.split('\n');
      // Find the last line that doesn't start with "THINK:" or "Thinking:"
      let cleanedTranslation = '';
      for (let i = lines.length - 1; i >= 0; i--) {
        const line = lines[i].trim();
        if (line && !line.startsWith('THINK:') && !line.startsWith('Thinking:') && !line.toLowerCase().includes('the user wants')) {
          // Check if this line looks like a translation (not explanation)
          if (line.length < 200 && !line.includes('means') && !line.includes('refers to')) {
            cleanedTranslation = line;
            break;
          }
        }
      }
      if (cleanedTranslation) {
        translated = cleanedTranslation;
        // #region agent log
        fetch('http://127.0.0.1:7242/ingest/7f529324-455d-4ca1-81c1-cbc867a5b6ab',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'analysis.service.ts:493',message:'Cleaned THINK: leakage from translation',data:{sourceTerm,originalResponse:response.outputText.substring(0,200),cleanedTranslation:translated},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'E'})}).catch(()=>{});
        // #endregion
      } else {
        // Fallback: try to extract text after quotes or last meaningful sentence
        const quoteMatch = translated.match(/"([^"]+)"/);
        if (quoteMatch) {
          translated = quoteMatch[1];
        }
      }
    }
    
    // Handle JSON response format (for backward compatibility with mock responses)
    // If response is a JSON array, try to extract target_mt from first item
    if (translated.startsWith('[') && translated.endsWith(']')) {
      try {
        const parsed = JSON.parse(translated);
        if (Array.isArray(parsed) && parsed.length > 0 && parsed[0].target_mt) {
          translated = parsed[0].target_mt.trim();
          // #region agent log
          fetch('http://127.0.0.1:7242/ingest/7f529324-455d-4ca1-81c1-cbc867a5b6ab',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'analysis.service.ts:391',message:'Extracted target_mt from JSON response',data:{sourceTerm,extractedTranslation:translated},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'M'})}).catch(()=>{});
          // #endregion
        }
      } catch (e) {
        // If JSON parsing fails, use original response
        // #region agent log
        fetch('http://127.0.0.1:7242/ingest/7f529324-455d-4ca1-81c1-cbc867a5b6ab',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'analysis.service.ts:397',message:'JSON parsing failed, using original response',data:{sourceTerm,error:String(e)},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'M'})}).catch(()=>{});
        // #endregion
      }
    }
    
    // #region agent log
    const isNotTranslated = translated === sourceTerm || translated.trim() === sourceTerm.trim();
    fetch('http://127.0.0.1:7242/ingest/7f529324-455d-4ca1-81c1-cbc867a5b6ab',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'analysis.service.ts:381',message:'AI translation result',data:{sourceTerm,translated,isNotTranslated,rawResponse:response.outputText},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'K'})}).catch(()=>{});
    // #endregion
    
    return translated;
  } catch (error: any) {
    // #region agent log
    fetch('http://127.0.0.1:7242/ingest/7f529324-455d-4ca1-81c1-cbc867a5b6ab',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'analysis.service.ts:390',message:'AI translation failed, using fallback',data:{sourceTerm,error:error.message},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'K'})}).catch(()=>{});
    // #endregion
    
    logger.warn(
      {
        sourceTerm,
        error: error.message,
      },
      'Failed to translate term with AI, using source term as fallback',
    );
    return sourceTerm; // Fallback to source term if translation fails
  }
};

/**
 * Helper function to update analysis progress
 * For parallel execution, we track glossary (0-50%) and style (50-100%) separately
 */
const updateProgress = async (
  documentId: string,
  stage: string,
  percentage: number,
  message: string,
  isGlossary: boolean = true, // true for glossary (0-50%), false for style (50-100%)
) => {
  try {
    // Get current progress to merge with parallel task
    const current = await prisma.documentAnalysis.findUnique({
      where: { documentId },
      select: { progressPercentage: true, currentStage: true },
    });
    
    let finalPercentage = percentage;
    if (current) {
      if (isGlossary) {
        // Glossary: 0-50%, merge with style progress (50-100%)
        const styleProgress = current.progressPercentage > 50 ? (current.progressPercentage - 50) : 0;
        finalPercentage = Math.min(percentage, 50) + styleProgress;
      } else {
        // Style: 50-100%, merge with glossary progress (0-50%)
        const glossaryProgress = current.progressPercentage <= 50 ? current.progressPercentage : 50;
        finalPercentage = glossaryProgress + Math.min(percentage, 50);
      }
    }
    
    await prisma.documentAnalysis.update({
      where: { documentId },
      data: {
        currentStage: stage,
        progressPercentage: finalPercentage,
        currentMessage: message,
      },
    });
  } catch (error: any) {
    // Log progress update failures but don't break the analysis
    logger.warn(
      { documentId, stage, percentage, message, error: error.message, stack: error.stack },
      'Failed to update progress - continuing analysis',
    );
  }
};

/**
 * REFACTOR: Distinct Sampling Strategies
 * Reconstructs FULL text for Deep Mode to ensure tables at the end are captured
 */
/**
 * REFACTOR: Distinct Sampling Strategies
 * This function must reconstruct the FULL text for Deep Mode to ensure tables at the end are captured.
 * 
 * Stage 1: Text Sampling & Preparation
 * - Full text reconstruction preserves document structure
 * - Deep Mode captures last 25k chars (Annex Hunter)
 * - Sampling includes table/annex sections reliably
 */
const getSampledText = (allSegments: Array<{ sourceText: string; orderIndex: number | null }>, mode: 'fast' | 'deep', documentId?: string): string => {
  // 1. Reconstruct Full Text (Sorted)
  // CRITICAL: Do not use 'remainingSegments' here. We need the raw original order.
  const totalSegments = allSegments.length;
  const filteredSegments = allSegments.filter(s => s.sourceText && s.sourceText.trim().length > 0);
  
  const fullText = filteredSegments
    .sort((a, b) => (a.orderIndex ?? 0) - (b.orderIndex ?? 0))
    .map(s => stripFormattingTags(s.sourceText))
    .join('\n');

  const totalLen = fullText.length;
  
  // Stage 1 Validation: Log sampled text metrics
  const hasAnnex = fullText.toLowerCase().includes('annex') || 
                   fullText.toLowerCase().includes('приложение') || 
                   fullText.toLowerCase().includes('таблица');
  const last10kChars = fullText.slice(-10000);
  const hasAnnexInLast10k = last10kChars.toLowerCase().includes('annex') || 
                             last10kChars.toLowerCase().includes('приложение') || 
                             last10kChars.toLowerCase().includes('таблица');
  
  logger.info(
    {
      documentId,
      stage: 'Stage 1: Text Sampling',
      mode,
      totalSegments,
      filteredSegments: filteredSegments.length,
      fullTextLength: totalLen,
      hasAnnex,
      hasAnnexInLast10k,
    },
    'Stage 1: Text sampling metrics',
  );
  
  // Add to execution logs (fire-and-forget, don't await in sync function)
  if (documentId) {
    addExecutionLog(documentId, {
      stage: 'Stage 1: Text Sampling',
      level: 'info',
      message: `Text sampling: ${totalSegments} total segments, ${filteredSegments.length} filtered, ${totalLen} chars, annex detected: ${hasAnnex}`,
      data: {
        mode,
        totalSegments,
        filteredSegments: filteredSegments.length,
        fullTextLength: totalLen,
        hasAnnex,
        hasAnnexInLast10k,
      },
    }).catch((err) => {
      // Log errors so we can see what's wrong
      logger.warn(
        { documentId, error: err.message, stage: 'Stage 1: Text Sampling' },
        'Failed to add execution log for text sampling',
      );
    });
  }

  // PATHWAY A: FAST MODE (Efficiency)
  // Logic: First 7k (Definitions) + Last 8k (Signatures/Basic Annex)
  if (mode === 'fast') {
    if (totalLen <= 15000) {
    logger.info(
      {
        documentId,
        stage: 'Stage 1: Text Sampling',
        mode: 'fast',
        result: 'full_text',
        sampledLength: totalLen,
      },
      'Stage 1: Fast mode - using full text (<= 15k chars)',
    );
    
    // Add execution log for fast mode full text
    if (documentId) {
      addExecutionLog(documentId, {
        stage: 'Stage 1: Text Sampling',
        level: 'info',
        message: `Fast mode: Using full text (${totalLen} chars, <= 15k limit)`,
        data: {
          mode: 'fast',
          result: 'full_text',
          sampledLength: totalLen,
          totalSegments,
          filteredSegments: filteredSegments.length,
        },
      }).catch(() => {});
    }
    
    return fullText;
    }
    const start = fullText.substring(0, 7000);
    const end = fullText.slice(-8000);
    const sampled = `${start}\n\n...[MIDDLE SKIPPED]...\n\n${end}`;
    
    // Validation: Check if annex detected in sampled text
    const sampledHasAnnex = sampled.toLowerCase().includes('annex') || 
                           sampled.toLowerCase().includes('приложение') || 
                           sampled.toLowerCase().includes('таблица');
    
    logger.info(
      {
        documentId,
        stage: 'Stage 1: Text Sampling',
        mode: 'fast',
        result: 'sampled',
        startLength: start.length,
        endLength: end.length,
        sampledLength: sampled.length,
        sampledHasAnnex,
        hasAnnexInLast8k: end.toLowerCase().includes('annex') || end.toLowerCase().includes('приложение'),
      },
      'Stage 1: Fast mode - sampled text (first 7k + last 8k)',
    );
    
    // Add execution log for fast mode sampling
    if (documentId) {
      addExecutionLog(documentId, {
        stage: 'Stage 1: Text Sampling',
        level: 'info',
        message: `Fast mode: Sampled text (first ${start.length} chars + last ${end.length} chars = ${sampled.length} total). Annex in sample: ${sampledHasAnnex}`,
        data: {
          mode: 'fast',
          result: 'sampled',
          startLength: start.length,
          endLength: end.length,
          sampledLength: sampled.length,
          sampledHasAnnex,
          hasAnnexInLast8k: end.toLowerCase().includes('annex') || end.toLowerCase().includes('приложение'),
        },
      }).catch(() => {});
    }
    
    return sampled;
  }

  // PATHWAY B: DEEP MODE (Forensic/Table Hunter - "Annex Hunter")
  // Logic: First 10k (Intro/Definitions) + Last 25k (INCREASED to catch Annex 1-4)
  // Total ~35k chars (fits in GPT-4o-mini context easily)
  if (totalLen <= 35000) {
    logger.info(
      {
        documentId,
        stage: 'Stage 1: Text Sampling',
        mode: 'deep',
        result: 'full_text',
        sampledLength: totalLen,
        hasAnnex,
      },
      'Stage 1: Deep mode - using full text (<= 35k chars)',
    );
    
    // Add execution log for deep mode full text
    if (documentId) {
      addExecutionLog(documentId, {
        stage: 'Stage 1: Text Sampling',
        level: 'info',
        message: `Deep mode: Using full text (${totalLen} chars, <= 35k limit). Annex detected: ${hasAnnex}`,
        data: {
          mode: 'deep',
          result: 'full_text',
          sampledLength: totalLen,
          hasAnnex,
          totalSegments,
          filteredSegments: filteredSegments.length,
        },
      }).catch(() => {});
    }
    
    return fullText;
  }
  
  // SMART ANCHORING: Find the last occurrence of Annex/Table to ensure we capture headers
  const fullTextLower = fullText.toLowerCase();
  const annexKeywords = ['приложение', 'annex', 'таблица', 'table'];
  
  let anchorIndex = -1;
  let anchorKeyword = '';
  
  // Find the last occurrence of any annex/table keyword
  for (const keyword of annexKeywords) {
    const lastIndex = fullTextLower.lastIndexOf(keyword);
    // #region agent log
    fetch('http://127.0.0.1:7242/ingest/7f529324-455d-4ca1-81c1-cbc867a5b6ab',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'analysis.service.ts:940',message:'Smart Anchor search',data:{keyword,lastIndex,fullTextLength:fullText.length,fullTextSample:fullText.slice(Math.max(0,lastIndex-100),Math.min(fullText.length,lastIndex+100))},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'H1'})}).catch(()=>{});
    // #endregion
    if (lastIndex > anchorIndex) {
      anchorIndex = lastIndex;
      anchorKeyword = keyword;
    }
  }
  
  // #region agent log
  fetch('http://127.0.0.1:7242/ingest/7f529324-455d-4ca1-81c1-cbc867a5b6ab',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'analysis.service.ts:950',message:'Smart Anchor result',data:{anchorIndex,anchorKeyword,found:anchorIndex>=0,fullTextLength:fullText.length},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'H1'})}).catch(()=>{});
  // #endregion
  
  let start: string;
  let end: string;
  let sampled: string;
  let smartSliceUsed = false;
  
  if (anchorIndex >= 0) {
    // EXTREME DIET: Smart Anchoring - Return ONLY the Annex section (ignore document start)
    // This reduces input from 50k chars to ~20k chars, doubling space for output
    const startIndex = Math.max(0, anchorIndex - 2000); // Include 2k chars before anchor for context
    const endIndex = Math.min(fullText.length, startIndex + 20000); // Capture 20k chars from anchor
    start = ''; // Extreme Diet: No start text, only annex section
    end = fullText.substring(startIndex, endIndex);
    // Return ONLY endText (Annexes), ignore document start to reduce context crowding
    sampled = end;
    smartSliceUsed = true;
    
    // #region agent log
    fetch('http://127.0.0.1:7242/ingest/7f529324-455d-4ca1-81c1-cbc867a5b6ab',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'analysis.service.ts:970',message:'Extreme Diet executed',data:{anchorIndex,anchorKeyword,startIndex,endIndex,endLength:end.length,sampledLength:sampled.length,fullTextLength:fullText.length},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'H1'})}).catch(()=>{});
    // #endregion
    
    logger.info(
      {
        documentId,
        stage: 'Stage 1: Text Sampling',
        mode: 'deep',
        smartSlice: true,
        extremeDiet: true,
        anchorKeyword,
        anchorIndex,
        startIndex,
        endIndex,
        endLength: end.length,
        sampledLength: sampled.length,
      },
      `[Stage 1] Extreme Diet: Found ${anchorKeyword} at index ${anchorIndex}. Returning ONLY Annex section (${end.length} chars, ignoring document start).`,
    );
    
    // Add execution log for extreme diet
    if (documentId) {
      addExecutionLog(documentId, {
        stage: 'Stage 1: Text Sampling',
        level: 'info',
        message: `[Stage 1] Extreme Diet: Found ${anchorKeyword} at index ${anchorIndex}. Returning ONLY Annex section (${end.length} chars, ignoring document start).`,
        data: {
          mode: 'deep',
          smartSlice: true,
          extremeDiet: true,
          anchorKeyword,
          anchorIndex,
          startIndex,
          endIndex,
          endLength: end.length,
          sampledLength: sampled.length,
        },
      }).catch(() => {});
    }
  } else {
    // Fallback: Last 25k chars (original behavior)
    start = fullText.substring(0, 10000); // Intro/Definitions
    end = fullText.slice(-25000); // Last 25k chars
    sampled = `${start}\n\n...[MIDDLE SKIPPED]...\n\n${end}`;
    
    logger.info(
      {
        documentId,
        stage: 'Stage 1: Text Sampling',
        mode: 'deep',
        smartSlice: false,
        fallback: 'last_25k',
      },
      '[Stage 1] Smart Slice: No annex/table anchor found. Using fallback: last 25k chars.',
    );
    
    // Add execution log for fallback
    if (documentId) {
      addExecutionLog(documentId, {
        stage: 'Stage 1: Text Sampling',
        level: 'info',
        message: '[Stage 1] Smart Slice: No annex/table anchor found. Using fallback: last 25k chars.',
        data: {
          mode: 'deep',
          smartSlice: false,
          fallback: 'last_25k',
          startLength: start.length,
          endLength: end.length,
          sampledLength: sampled.length,
        },
      }).catch(() => {});
    }
  }
  
  // Stage 1 Validation: Verify annex is captured in the sampled text
  const endHasAnnex = end.toLowerCase().includes('annex') || 
                      end.toLowerCase().includes('приложение') || 
                      end.toLowerCase().includes('таблица');
  
  if (mode === 'deep' && !endHasAnnex && hasAnnex && !smartSliceUsed) {
    logger.warn(
      {
        documentId,
        stage: 'Stage 1: Text Sampling',
        mode: 'deep',
        warning: 'Annex detected in full text but not captured in sampled text',
        hasAnnex,
        endHasAnnex,
        smartSliceUsed,
        lastChars: end.substring(0, 200),
      },
      'Stage 1: Deep mode - WARNING: Annex may not be captured',
    );
  }
  
  logger.info(
    {
      documentId,
      stage: 'Stage 1: Text Sampling',
      mode: 'deep',
      result: 'sampled',
      startLength: start.length,
      endLength: end.length,
      sampledLength: sampled.length,
      endHasAnnex,
      hasAnnexInLast10k,
      smartSliceUsed,
    },
    'Stage 1: Deep mode - sampled text (smart anchoring)',
  );
  
  // Add execution log for deep mode sampling
  if (documentId) {
    addExecutionLog(documentId, {
      stage: 'Stage 1: Text Sampling',
      level: 'info',
      message: `Deep mode: Sampled text (first ${start.length} chars + end ${end.length} chars = ${sampled.length} total). Smart slice: ${smartSliceUsed}, Annex in end: ${endHasAnnex}`,
      data: {
        mode: 'deep',
        result: 'sampled',
        startLength: start.length,
        endLength: end.length,
        sampledLength: sampled.length,
        endHasAnnex,
        smartSliceUsed,
      },
    }).catch(() => {});
  }

  return sampled;
};

/**
 * REFACTOR: Candidate Filtering
 * Filters out stopwords, dangling prepositions, and generic terms
 * 
 * Stage 3: Candidate Filtering
 * - Long phrases (3+ words) preserved even with frequency === 1 (Golden Ticket)
 * - Prepositions allowed in long phrases (3+ words) in Deep Mode
 * - Fragments and garbage properly filtered
 */
const filterCandidates = (phrases: Array<{ term: string; count: number }>, mode: 'fast' | 'deep', documentId?: string): string[] => {
  const inputCount = phrases.length;
  const rejectionReasons = {
    pureStopword: 0,
    stopword: 0,
    danglingPreposition: 0,
    genericVerb: 0,
    singleCommonWord: 0,
    frequency: 0,
  };
  let goldenTicketCount = 0;
  let deepModePrepositionAllowed = 0;
  let longPhrasesPreserved = 0;
  
  const filtered = phrases
    .filter(p => {
      const term = p.term.toLowerCase().trim();
      const words = term.split(' ');
      const wordCount = words.length;

      // RULE 1: Kill Pure Stopwords (e.g., "для", "года")
      if (RUSSIAN_STOPWORDS.has(term)) {
        rejectionReasons.pureStopword++;
        return false;
      }

      // RULE 2: Standard Stopwords (Keep this for FAST mode)
      // In DEEP mode, allow prepositions IF the phrase is long (3+ words)
      // This saves "Suit for protection..." and other long technical phrases
      const hasStopword = words.some(w => RUSSIAN_STOPWORDS.has(w));
      if (mode === 'deep' && wordCount >= 3) {
         // Allow it! Long technical phrases often contain "for"/"with"
         deepModePrepositionAllowed++;
      } else if (hasStopword) {
         rejectionReasons.stopword++;
         return false; // Reject short phrases with stopwords
      }

      // RULE 3: Dangling Prepositions (Start/End)
      // Still reject if it STARTS with a preposition ("For protection...")
      // But allow if it ends with one IF it's long? No, bad ending is usually bad.
      const firstWord = words[0];
      const lastWord = words[words.length - 1];
      
      if (RUSSIAN_STOPWORDS.has(firstWord)) {
        rejectionReasons.danglingPreposition++;
        return false;
      }
      if (RUSSIAN_STOPWORDS.has(lastWord)) {
        rejectionReasons.danglingPreposition++;
        return false;
      }

      // RULE 4: Reject if contains "generic" verbs or adverbs
      if (term.includes('является') || term.includes('может')) {
        rejectionReasons.genericVerb++;
        return false;
      }

      // RULE 5: Kill Single Common Words (unless Entity)
      // "работников" (employees) is generic. "KEGOC" is good.
      if (words.length === 1 && !isLikelyEntity(p.term)) {
         // In Deep Mode, we generally hate single nouns unless they are strictly capitalized proper nouns
         if (mode === 'deep' && p.term[0] !== p.term[0].toUpperCase()) {
           rejectionReasons.singleCommonWord++;
           return false;
         }
      }

      // RULE 6: "Golden Ticket" Bypass for Deep Mode
      // If Deep Mode AND Long Phrase (3+ words, likely a table row), KEEP IT even if frequency === 1
      if (mode === 'deep' && wordCount >= 3) {
        goldenTicketCount++;
        if (p.count === 1) {
          longPhrasesPreserved++;
        }
        return true; // BYPASS: Table items only appear once, but they're long technical descriptions
      }

      // RULE 7: Mode Specifics
      if (mode === 'deep') {
        // BRUTE FORCE: Keep almost everything 2+ words
        if (words.length >= 2) return true;
        // Keep capitalized Entities (1 word)
        if (words.length === 1 && p.term[0] === p.term[0].toUpperCase()) return true;
        rejectionReasons.singleCommonWord++;
        return false;
      }

      // Fast Mode Default
      if (p.count < 2) {
        rejectionReasons.frequency++;
        return false;
      }
      return true;
    })
    .map(p => p.term);
  
  const filteredCount = filtered.length;
  const rejectionRate = inputCount > 0 ? ((inputCount - filteredCount) / inputCount * 100).toFixed(1) : '0.0';
  
  // Stage 3 Validation: Log detailed filtering metrics
  logger.info(
    {
      documentId,
      stage: 'Stage 3: Candidate Filtering',
      mode,
      inputCount,
      filteredCount,
      rejectionRate: `${rejectionRate}%`,
      rejectionReasons,
      goldenTicketCount,
      deepModePrepositionAllowed,
      longPhrasesPreserved,
      sampleFiltered: filtered.slice(0, 10).map(t => ({
        term: t.substring(0, 60),
        length: t.length,
        wordCount: t.split(/\s+/).length,
      })),
    },
    'Stage 3: Candidate filtering metrics',
  );
  
  // Add to execution logs (fire-and-forget, don't await in sync function)
  if (documentId) {
    addExecutionLog(documentId, {
      stage: 'Stage 3: Candidate Filtering',
      level: 'info',
      message: `Filtered ${filteredCount}/${inputCount} candidates (${rejectionRate}% rejected). Golden tickets: ${goldenTicketCount}, Long phrases preserved: ${longPhrasesPreserved}`,
      data: {
        mode,
        inputCount,
        filteredCount,
        rejectionRate: `${rejectionRate}%`,
        rejectionReasons,
        goldenTicketCount,
        longPhrasesPreserved,
      },
    }).catch(() => {}); // Ignore errors
  }
  
  // Stage 3 Validation: Warn if > 50% candidates rejected
  if (parseFloat(rejectionRate) > 50) {
    logger.warn(
      {
        documentId,
        stage: 'Stage 3: Candidate Filtering',
        mode,
        warning: `More than 50% candidates rejected (${rejectionRate}%)`,
        rejectionRate,
        rejectionReasons,
        inputCount,
        filteredCount,
      },
      'Stage 3: WARNING - High rejection rate',
    );
  }
  
  return filtered;
};

/**
 * Clean candidates by removing noise, fragments, and duplicates
 * 
 * 1. Remove table artifacts, form fields, sentence fragments, and header noise
 * 2. "Fuzzy Russian Doll" Deduplication (remove substrings if longer version exists, using normalized comparison)
 * 
 * Goal: Reduce term count from 117 to ~50 High-Quality items
 */
const cleanCandidates = (candidates: string[]): string[] => {
  const originalCount = candidates.length;
  console.log(`[Cleaner] Starting with ${originalCount} raw candidates`);
  
  const normalize = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');

  let clean = candidates
    .map(c => c.trim())
    .filter(c => {
      const lower = c.toLowerCase();

      // 1. REJECT SHORT/EMPTY
      if (c.length < 5) return false;

      // 2. REJECT IF STARTS WITH LOWERCASE (Unless it's a specific chemical/unit)
      // Real glossary terms (Questions/Titles) usually start with Uppercase.
      // Fragments usually start with lowercase because they were cut from the middle of a sentence.
      if (/^[a-z]/.test(c)) return false; 

      // 3. REJECT BAD ENDINGS (Fragments)
      // If it ends with " is", " are", " the", " and", " or", " of", " in", " to"
      if (/( is| are| the| and| or| of| in| to| for| with)$/i.test(c)) return false;

      // 4. REJECT BAD STARTS (Conjunctions)
      // If it starts with "and ", "or ", "of ", "the "
      if (/^(and|or|of|the|in|to|with)\s/i.test(c)) return false;

      // 5. REJECT FORM NOISE
      if (/signature|occupant|inspector|auditor|date of|phone contact|verified by/i.test(c)) return false;
      if (/_{3,}/.test(c)) return false;

      // 6. REJECT TABLE STATUS
      if (/^(yes|no|n\/a|remarks|action|status)\b/i.test(c)) return false;
      if (lower.includes('remarks') && lower.includes('corrective')) return false;

      // 7. REJECT GENERIC SHORT PHRASES (< 3 words)
      // "Safe drinking water" (3 words) -> OK
      // "Water available" (2 words) -> Reject if < 20 chars
      const words = c.split(/\s+/).length;
      if (words < 3 && c.length < 20) return false;

      return true;
    })
    .map(c => c.replace(/\s+\d+$/, '').trim());

  // Step B: "Fuzzy Russian Doll" Deduplication
  const uniqueSet = Array.from(new Set(clean));
  uniqueSet.sort((a, b) => a.length - b.length); 
  
  const finalKeep: string[] = [];
  for (let i = 0; i < uniqueSet.length; i++) {
    const shortTerm = uniqueSet[i];
    const shortNorm = normalize(shortTerm);
    let isFragment = false;
    if (shortTerm.length < 60) {
      for (let j = i + 1; j < uniqueSet.length; j++) {
        if (normalize(uniqueSet[j]).includes(shortNorm)) {
          isFragment = true; break; 
        }
      }
    }
    if (!isFragment) finalKeep.push(shortTerm);
  }

  const finalCount = finalKeep.length;
  console.log(`[Cleaner] Reduced from ${originalCount} to ${finalCount} clean candidates`);
  
  // Log cleaning statistics
  if (originalCount !== finalCount) {
    logger.debug(
      {
        originalCount,
        finalCount,
        removed: originalCount - finalCount,
        reductionRate: ((originalCount - finalCount) / originalCount * 100).toFixed(1) + '%',
      },
      'Candidate cleaning pipeline: noise and fragments removed',
    );
  }

  return finalKeep;
};

/**
 * REFACTOR: Distinct Candidate Selection
 * This function selects which terms to send to the AI. Deep Mode must be "Brute Force."
 * 
 * Stage 2: Candidate Generation
 * - Whole table rows (3-20 words, 20-150 chars) appear as candidates
 * - N-grams complement whole lines (not replace them)
 * - Candidate list prioritized: table rows first, then N-grams
 */
/**
 * Fast Mode: NLP-Based Extraction using compromise
 * Uses part-of-speech tagging to extract noun phrases (research-based approach)
 * Target: High-level keywords like "Waste Management", "PPE", "Safety Officer"
 */
const extractFastCandidatesWithNLP = (text: string): Array<{ term: string; count: number }> => {
  try {
    const doc = nlp(text);
    
    // Extract noun phrases: matches patterns like "Technical Safety", "Safety Officer", "Department of Defense"
    // Pattern: (#Adjective|#Noun)+ (of #Noun)? - captures noun phrases with optional "of" preposition
    const nounPhrases = doc.match('(#Adjective|#Noun)+ (of #Noun)?').out('array');
    
    // Statistical filter: count frequency and filter noise
    const frequency: Record<string, number> = {};
    const stopWords = new Set(['the', 'and', 'or', 'of', 'in', 'to', 'for', 'with', 'a', 'an']);
    
    nounPhrases.forEach((term: string) => {
      const clean = term.toLowerCase().trim();
      
      // Filter noise
      if (clean.length < 4) return; // Too short
      if (stopWords.has(clean)) return; // Just a stopword
      
      // Re-check for hidden verbs (compromise might miss some)
      try {
        const termDoc = nlp(clean);
        if (termDoc.has('#Verb')) return; // Reject if contains verbs
      } catch (e) {
        // If NLP parsing fails, continue (better to include than exclude)
      }
      
      frequency[clean] = (frequency[clean] || 0) + 1;
    });
    
    // Convert to array format compatible with existing filterCandidates function
    return Object.entries(frequency).map(([term, count]) => ({
      term,
      count,
    }));
  } catch (error: any) {
    logger.warn({ error: error?.message }, 'NLP extraction failed, falling back to N-grams');
    // Fallback to traditional N-grams if compromise fails
    return extractNGrams(text);
  }
};

const selectCandidates = (text: string, mode: 'fast' | 'deep', documentId?: string): string[] => {
  // #region agent log
  fetch('http://127.0.0.1:7242/ingest/7f529324-455d-4ca1-81c1-cbc867a5b6ab',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'analysis.service.ts:1268',message:'selectCandidates entry',data:{mode,textLength:text.length,hasNewlines:text.includes('\n'),newlineCount:(text.match(/\n/g)||[]).length,textSample:text.slice(0,500)},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'H1'})}).catch(()=>{});
  // #endregion
  console.log('[Stage 2 Debug] Raw Text Sample:', text.slice(0, 500));
  // #region agent log
  fetch('http://127.0.0.1:7242/ingest/7f529324-455d-4ca1-81c1-cbc867a5b6ab',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'analysis.service.ts:1269',message:'Raw text sample logged to console',data:{textSample:text.slice(0,500)},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'H1'})}).catch(()=>{});
  // #endregion
  
  // 1. Candidate Extraction: Use NLP for Fast Mode, N-grams for Deep Mode
  let allPhrases: Array<{ term: string; count: number }>;
  if (mode === 'fast') {
    // Fast Mode: Use compromise NLP for research-based linguistic extraction
    allPhrases = extractFastCandidatesWithNLP(text);
    logger.info(
      { documentId, mode, nlpCandidatesCount: allPhrases.length },
      'Fast Mode: Using NLP-based extraction (compromise)',
    );
  } else {
    // Deep Mode: Keep existing N-grams approach (works well for table rows)
    allPhrases = extractNGrams(text);
  }
  
  let candidates = filterCandidates(allPhrases, mode, documentId);
  
  // Stage 2 Metrics: Count candidates by type
  const ngramCount = candidates.length;
  let tableRowCount = 0;

  // 2. DEEP MODE INJECTION: "Whole Line" Candidates
  if (mode === 'deep') {
    // Split text into lines to catch Table Rows
    const lines = text.split(/\n+/);
    // #region agent log
    fetch('http://127.0.0.1:7242/ingest/7f529324-455d-4ca1-81c1-cbc867a5b6ab',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'analysis.service.ts:1280',message:'After split by newlines',data:{totalLines:lines.length,first10Lines:lines.slice(0,10).map((l,i)=>({index:i,length:l.length,trimmedLength:l.trim().length,startsWith:l.trim().substring(0,20),hasContent:l.trim().length>0}))},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'H1'})}).catch(()=>{});
    // #endregion
    
    // Helper: Strip formatting tags ({{0}}, {{/0}}, etc.) to get actual content
    const stripFormattingTags = (text: string): string => {
      return text.replace(/\{\{\/?\d+\}\}/g, '').trim();
    };
    
    // Permissive Vacuum Strategy: Content Density Check (no strict regex)
    // A line is a "Candidate Row" if it has sufficient content density (after stripping formatting tags)
    const tableRowCandidates = lines
      .map(line => line.trim())
      .filter((line, index) => {
        // #region agent log
        fetch('http://127.0.0.1:7242/ingest/7f529324-455d-4ca1-81c1-cbc867a5b6ab',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'analysis.service.ts:1294',message:'Filtering line (pre-check)',data:{index,originalLength:line.length,trimmedLength:line.trim().length,isEmpty:line.trim().length===0,lineSample:line.trim().substring(0,60)},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'H5'})}).catch(()=>{});
        // #endregion
        if (line.trim().length === 0) return false; // Skip empty lines
        
        // Strip formatting tags before checking content density
        const cleanLine = stripFormattingTags(line);
        if (cleanLine.length === 0) return false; // Skip if nothing left after stripping tags
        
        // QUANTITY FILTER: Reject "Quantity Rows" (e.g., "1 pair", "1 item", "24 pairs")
        // These are noise that crowd the candidate list without adding value
        if (/^\d/.test(cleanLine) && cleanLine.length < 15) {
          return false; // Reject short lines starting with numbers
        }
        
        const wordCount = cleanLine.split(/\s+/).filter(w => w.length > 0).length;
        const length = cleanLine.length;
        // Content Density Check: 13-300 chars (reduced to catch "Очки защитные"=13 chars), at least 2 words (reduced to catch "Каска защитная")
        const isCandidate = length >= 13 && length <= 300 && wordCount >= 2;
        
        // #region agent log
        fetch('http://127.0.0.1:7242/ingest/7f529324-455d-4ca1-81c1-cbc867a5b6ab',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'analysis.service.ts:1302',message:'Content density check (with tag stripping)',data:{index,originalLength:line.length,cleanLength:length,wordCount,isCandidate,originalSample:line.substring(0,60),cleanSample:cleanLine.substring(0,60),firstChar:cleanLine.substring(0,1),first3Chars:cleanLine.substring(0,3)},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'H2'})}).catch(()=>{});
        // #endregion
        
        return isCandidate;
      })
      .map(line => stripFormattingTags(line)); // Return clean lines without formatting tags
    // #region agent log
    fetch('http://127.0.0.1:7242/ingest/7f529324-455d-4ca1-81c1-cbc867a5b6ab',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'analysis.service.ts:1296',message:'Table row candidates result',data:{tableRowCount:tableRowCandidates.length,first5Candidates:tableRowCandidates.slice(0,5).map(c=>c.substring(0,80))},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'ALL'})}).catch(()=>{});
    // #endregion
    
    // Clean table row candidates before merging
    const cleanedTableRows = cleanCandidates(tableRowCandidates);
    tableRowCount = cleanedTableRows.length;

    // Merge: Put Table Rows AT THE TOP of the list
    candidates = [...cleanedTableRows, ...candidates];
    
    // Final cleaning pass: Clean the entire merged list to remove any remaining noise/fragments
    // This catches cases where N-grams might be fragments of table rows or vice versa
    candidates = cleanCandidates(candidates);
  }

  // Stage 2 Validation: Log candidate metrics
  const totalCandidates = candidates.length;
  const sampleCandidates = candidates.slice(0, 20);
  
  logger.info(
    {
      documentId,
      stage: 'Stage 2: Candidate Generation',
      mode,
      totalCandidates,
      tableRowCandidates: tableRowCount,
      ngramCandidates: ngramCount,
      sampleCandidates: sampleCandidates.map(c => ({
        term: c.substring(0, 60),
        length: c.length,
        wordCount: c.split(/\s+/).length,
        isTableRow: mode === 'deep' && /^[A-ZА-Я]/.test(c) && c.length > 20 && c.length < 150,
      })),
    },
    'Stage 2: Candidate generation metrics',
  );
  
  // Add to execution logs (fire-and-forget, don't await in sync function)
  if (documentId) {
    addExecutionLog(documentId, {
      stage: 'Stage 2: Candidate Generation',
      level: 'info',
      message: `Found ${totalCandidates} candidates (${tableRowCount} table rows, ${ngramCount} N-grams)`,
      data: {
        mode,
        totalCandidates,
        tableRowCandidates: tableRowCount,
        ngramCandidates: ngramCount,
        sampleCandidates: sampleCandidates.slice(0, 20).map(c => c.substring(0, 100)),
      },
    }).catch(() => {}); // Ignore errors
  }
  
  // Stage 2 Validation: Warn if Deep Mode has few table row candidates
  if (mode === 'deep' && tableRowCount < 10 && text.length > 20000) {
    logger.warn(
      {
        documentId,
        stage: 'Stage 2: Candidate Generation',
        mode: 'deep',
        warning: 'Deep mode found < 10 table row candidates - may miss annex table items',
        tableRowCount,
        textLength: text.length,
        last1kChars: text.slice(-1000).substring(0, 200),
      },
      'Stage 2: Deep mode - WARNING: Few table row candidates found',
    );
  }

  // 3. Filter & Slice (Dynamic Limits)
  if (mode === 'fast') {
    // PATHWAY A: STRICT
    // Max 100 items.
    const sliced = candidates.slice(0, 100);
    logger.info(
      {
        documentId,
        stage: 'Stage 2: Candidate Generation',
        mode: 'fast',
        totalCandidates,
        slicedCount: sliced.length,
      },
      'Stage 2: Fast mode - sliced to 100 candidates',
    );
    return sliced;
  }

  // PATHWAY B: BRUTE FORCE (Deep)
  // Max 500 items.
  const sliced = candidates.slice(0, 500);
  logger.info(
    {
      documentId,
      stage: 'Stage 2: Candidate Generation',
      mode: 'deep',
      totalCandidates,
      slicedCount: sliced.length,
    },
    'Stage 2: Deep mode - sliced to 500 candidates',
  );
  return sliced;
};

/**
 * Helper to check if a term is likely a proper noun/entity (for candidate selection)
 */
const isLikelyEntity = (term: string): boolean => {
  // Check for proper noun patterns: starts with capital, all caps (acronym), or contains numbers
  const startsWithCapital = /^[A-ZА-Я]/.test(term);
  const isAllCaps = term === term.toUpperCase() && /[A-ZА-Я]/.test(term) && term.length >= 2;
  const containsNumbers = /\d/.test(term);
  
  return startsWithCapital || isAllCaps || containsNumbers;
};

/**
 * REFACTOR: Distinct Prompt Generation
 * Strictly enforces "No Verbs" and "Nominative Case"
 * 
 * Stage 4: AI Prompt Construction
 * - Clear instructions for table row handling
 * - Consistent guidance on verbatim extraction vs normalization
 * - Effective fragment repair instructions
 */
// Helper function to build user prompt for a specific chunk of candidates
const buildUserPromptForChunk = (
  mode: 'fast' | 'deep',
  chunkCandidates: string[],
  chunkIndex: number,
  totalChunks: number,
  sourceTextForAI: string,
  allSegments: any[],
  samplingDescription: string,
  totalCandidatesCount: number,
): string => {
  const chunkPrompt = `${mode === 'deep' 
    ? `🚨🚨🚨 BATCH ${chunkIndex + 1}/${totalChunks}: EXTRACT 15-20 TERMS FROM THIS BATCH 🚨🚨🚨

**LIST PROCESSOR MINDSET: YOU ARE A WORKER, NOT AN EXPLORER**
This is Batch ${chunkIndex + 1} of ${totalChunks}. I have provided **${chunkCandidates.length} Raw Candidates** below (sorted by length, longest first). Your job is to filter and translate them.

**MANDATORY BATCH PROCESSING WORKFLOW:**
1. **PROCESS EACH CANDIDATE ONE BY ONE** - Start with candidate #1, then #2, then #3... continue through ALL ${chunkCandidates.length} candidates in this batch
2. For EACH candidate in the list:
   - Check if it appears VERBATIM in the Source Text
   - If YES and it's a valid technical term (PPE, job title, equipment, etc.), extract it
   - If NO, skip it and move to the next candidate
3. **DO NOT STOP** after extracting 2, 5, or 10 terms - you MUST process ALL ${chunkCandidates.length} candidates in this batch
4. **MINIMUM OUTPUT:** You must extract at least 15 terms from these ${chunkCandidates.length} candidates
5. **TARGET OUTPUT:** Aim for 20 terms from this batch (use your full 8192 token budget!)

**CRITICAL: YOU HAVE 8192 OUTPUT TOKENS AVAILABLE - USE THEM!**
- Each term takes ~50-100 tokens - you can easily fit 15-20 terms from this batch
- This is Batch ${chunkIndex + 1} of ${totalChunks} - focus on extracting terms from THIS batch only

**MANDATORY TARGET:** Extract at least 15+ terms from this batch. Do NOT stop at 2, 5, or 10 terms. 
**YOU HAVE ${chunkCandidates.length} CANDIDATE TERMS BELOW - PROCESS ALL OF THEM TO REACH 15+ EXTRACTED TERMS.**
**PRIORITIZE items from the CANDIDATE LIST over random words in the text.**

This is DEEP MODE - comprehensive extraction is required. Continue extracting until you have at least 15 terms from this batch.

**COUNT YOUR TERMS:** Before finishing, count how many terms you've extracted. If you have fewer than 15, continue extracting more terms from the candidate list below.

═══════════════════════════════════════════════════════════════════════════════
` : `**LIST PROCESSOR MINDSET: YOU ARE A WORKER, NOT AN EXPLORER**
I have provided a list of **${chunkCandidates.length} Raw Candidates** below. Your job is to filter and translate them.

**YOUR WORKFLOW:**
1. Iterate through the Candidate List systematically (line by line)
2. For every valid technical term in the list, extract it and translate it
3. Do NOT be lazy. Aim for 10+ items minimum from this batch

**CRITICAL: You are required to extract a MINIMUM of 10 terms from this batch.**
**MANDATORY QUOTA:** You must extract at least 10 distinct technical terms if the candidate list supports it.
**PRIORITIZE items from the CANDIDATE LIST over random words in the text.**
**DO NOT STOP AFTER THE FIRST PAGE** - continue through the entire candidate list.

═══════════════════════════════════════════════════════════════════════════════
`}Source Text (from ${allSegments.length} segments, ${samplingDescription}):
${sourceTextForAI}

═══════════════════════════════════════════════════════════════════════════════
📋 CANDIDATE LIST - REVIEW THESE TERMS FIRST (Batch ${chunkIndex + 1}/${totalChunks}, ${chunkCandidates.length} candidates):
═══════════════════════════════════════════════════════════════════════════════
${chunkCandidates.join('\n')}
${totalCandidatesCount > chunkCandidates.length ? `\n... and ${totalCandidatesCount - chunkCandidates.length} more candidates in other batches (total: ${totalCandidatesCount})` : ''}

${mode === 'deep' 
    ? `🚨 REMINDER: EXTRACT 15-20 TERMS FROM THIS BATCH (Batch ${chunkIndex + 1}/${totalChunks})
You have ${chunkCandidates.length} candidate terms in the CANDIDATE LIST above. 
**ITERATE THROUGH THE ENTIRE LIST** - extract at least 15+ of them (aim for 20).
**PRIORITIZE THE CANDIDATE LIST** - these are pre-filtered, high-quality technical terms.
**For every valid PPE item (Boots, Suits, Gloves, Helmets), output it. Do not be lazy.**

═══════════════════════════════════════════════════════════════════════════════
`     : `**REMINDER: EXTRACT AT LEAST 10 TERMS FROM THIS BATCH (MINIMUM)**
You have ${chunkCandidates.length} candidate terms in the CANDIDATE LIST above. Extract at least 10 of them.
**PRIORITIZE THE CANDIDATE LIST** - these are pre-filtered, high-quality technical terms.
**If you see a numbered list (1, 2, 3...), extract EVERY item in that list.**

═══════════════════════════════════════════════════════════════════════════════
`}═══════════════════════════════════════════════════════════════════════════════
🔍 CRITICAL EXTRACTION INSTRUCTIONS
═══════════════════════════════════════════════════════════════════════════════

**STEP 0: PRIORITIZE THE CANDIDATE LIST (MOST IMPORTANT)**
- Start with the CANDIDATE LIST provided above
- For each term in the candidate list, check if it appears VERBATIM in the Source Text
- If it appears verbatim and is a valid technical term, extract it
- Do NOT skip candidate list items in favor of random words from the text
- The candidate list contains "Golden Ticket" terms - prioritize them

**CRITICAL: You are required to extract a MINIMUM of ${mode === 'deep' ? '15' : '10'} terms from this batch.**
- Do NOT stop after the first few matches
- Do not stop after the first page. Process the ENTIRE provided text.
- Scan the ENTIRE provided text snippet (including all Annexes/Tables)
- Continue extracting until you have processed the entire candidate list
- Minimum extraction target: ${mode === 'deep' ? '15' : '10'} terms from this batch

**STEP 1: SCAN STRUCTURED SECTIONS FIRST**
1. Tables, Annexes, Appendices (highest-value vocabulary - scan these FIRST)
2. **NUMBERED LISTS:** If you see a numbered list (1, 2, 3...), extract EVERY item in that list
3. Definitions sections, Glossary sections
4. Technical specifications, Safety norms
5. Organizational charts, Job descriptions

**STEP 2: VERIFY EVERY TERM WITH CTRL+F (MANDATORY)**
- Before adding ANY term to your output, verify it appears VERBATIM in the Source Text above.
- Use Ctrl+F (or equivalent search) to find the EXACT string.
- If you cannot find the EXACT string, DO NOT extract it.
- Do NOT create combinations like "Professional publications" if only "Professional" appears separately.
- **SCAN THE ENTIRE TEXT:** Do not stop after the first few matches. Continue scanning through all Annexes and Tables.
- **NUMBERED LISTS:** When you encounter numbered lists (1. Item, 2. Item, 3. Item...), extract EVERY numbered item as a separate term

**STEP 3: PRIORITIZE HIGH-VALUE TARGETS (TIER 1-2)**
Focus your extraction budget on these categories (in priority order):
1. **Proper Nouns:** Organization names, Company names, Institution names, Geographic locations
2. **Acronyms & Initialisms:** All acronyms with their full forms (if provided)
3. **Defined Terms:** Terms explicitly defined (look for "is defined as", "means", "refers to")
4. **Job Titles & Roles:** Specific positions from organizational charts, tables, job descriptions
5. **Technical Equipment & Tools:** Equipment names, PPE items, Tools, Instruments
6. **Domain-Specific Metrics & Units:** Measurement units, Calculation methods, Indexes

**OUTPUT FORMAT:**
Return JSON array: [{"sourceTerm": "string", "targetTerm": "string", "frequency": number, "category": "string"}]
- "sourceTerm": **MUST BE VERBATIM**. Extract the term EXACTLY as it appears in the text (keep Plural/Case). Do NOT normalize it yet. This is required to pass the verification check.
- "targetTerm": **ENGLISH TRANSLATION**. Translate the term to Nominative Singular English (e.g., "Leather boots...", "Protective suit...").
- "category" should be one of: "proper_noun", "acronym", "defined_term", "job_title", "equipment", "metric", "process", "legal", "technical", "other"
- Return ONLY the JSON array, no markdown code blocks, no additional text

${mode === 'deep' 
    ? `🚨 FINAL INSTRUCTION - CRITICAL (Batch ${chunkIndex + 1}/${totalChunks}):
I have prioritized the Candidate List above. These ${chunkCandidates.length} items are the most important (sorted by length, longest first).

**YOU MUST PROCESS ALL ${chunkCandidates.length} CANDIDATES IN THIS BATCH:**
- Start with candidate #1, then #2, then #3... continue through ALL ${chunkCandidates.length} candidates
- For EACH candidate, check if it appears VERBATIM in the Source Text and extract it if valid
- The candidates are sorted by length (longest first) - these are the most valuable terms

**MANDATORY OUTPUT REQUIREMENTS:**
- Minimum: 15 terms extracted from this batch
- Target: 20 terms extracted from this batch
- Token Budget: You have 8192 output tokens - USE THEM! 
- Each term takes ~50-100 tokens - you can easily fit 15-20 terms from this batch

**BEFORE YOU FINISH:**
1. Count how many terms you've extracted (you should have 15+)
2. If you have fewer than 15 terms, you MUST continue extracting
3. **GO BACK TO THE CANDIDATE LIST** - keep extracting from it until you reach at least 15 terms
4. Do NOT stop at 2, 3, 5, or 10 terms - that is insufficient
5. **PRIORITIZE CANDIDATE LIST ITEMS** - do not ignore them in favor of random text words
6. **FOCUS ON LONG DESCRIPTIONS** - the longest items in the candidate list are the most valuable (PPE items, job titles, equipment names)

**REMEMBER: You are a WORKER, not an explorer. Process ALL ${chunkCandidates.length} candidates in this batch systematically.`
    : `**FINAL REMINDER: EXTRACT AT LEAST 10 TERMS FROM THIS BATCH (MINIMUM)**
**BEFORE YOU FINISH:**
1. Count how many terms you've extracted
2. If you have fewer than 10 terms, you MUST continue extracting
3. **GO BACK TO THE CANDIDATE LIST** - keep extracting from it until you reach at least 10 terms
4. **IF YOU SEE NUMBERED LISTS (1, 2, 3...), extract EVERY item in that list**
5. You have ${chunkCandidates.length} candidate terms in the CANDIDATE LIST - prioritize them
6. **PRIORITIZE CANDIDATE LIST ITEMS** - do not ignore them in favor of random text words
7. **Do not stop after the first page. Process the ENTIRE provided text.**`}

**REMINDER:** Check the very end of the provided text for Tables/Annexes containing PPE and Equipment. These are High Priority.

Return a JSON array of terms that pass ALL checks above.`;
  
  return chunkPrompt;
};

/**
 * Helper function to detect if a model is a reasoning model (DeepSeek R1)
 */
const isReasoningModel = (providerName?: string, modelName?: string): boolean => {
  if (!providerName || !modelName) return false;
  const providerLower = providerName.toLowerCase();
  const modelLower = modelName.toLowerCase();
  
  // DeepSeek R1 (reasoner) models
  if (providerLower === 'deepseek' && (modelLower.includes('reasoner') || modelLower.includes('r1'))) {
    return true;
  }
  
  return false;
};

const getSystemPrompt = (
  mode: 'fast' | 'deep', 
  domain?: string | null,
  providerName?: string,
  modelName?: string
): string => {
  const isReasoning = isReasoningModel(providerName, modelName);
  
  // DeepSeek R1 Reasoning Model Prompt
  if (isReasoning) {
    const reasoningBaseInstructions = `
You are a Forensic Terminologist (Deep Analysis Mode). Your PRIMARY GOAL is to analyze the provided CANDIDATE LIST against the source text context and extract valid technical terms with high precision.

🧠 REASONING MODE ENABLED:
- You are encouraged to use your reasoning capabilities to analyze each candidate term.
- Think through whether each candidate is a valid technical term, proper noun, or domain-specific terminology.
- Use your reasoning to filter out false positives (common words, fragments, non-technical phrases).
- Consider the context and domain when making extraction decisions.
- Focus on PRECISION over speed - better to extract fewer high-quality terms than many low-quality ones.

🚨 OUTPUT FORMAT: After your reasoning process, return RAW JSON ONLY. NO Markdown formatting around the JSON.

**CRITICAL: ANALYTICAL MINDSET**
- I have provided a list of **Raw Candidates** below. Your job is to ANALYZE and FILTER them.
- You are an ANALYST, not just a processor. Use your reasoning to evaluate each candidate.
- For each candidate, reason about:
  1. Is it a valid technical term, proper noun, or domain-specific phrase?
  2. Does it appear VERBATIM in the Source Text?
  3. Is it a complete term (not a fragment like "of the" or "by the")?
  4. Would this term benefit from consistent translation across the document?
- Extract terms that pass ALL your reasoning checks.
- The candidate list contains pre-filtered terms - use your reasoning to validate and refine them.
`;

    const reasoningDeepInstructions = `
🚀 DEEP MODE + REASONING: CONTEXT EXPANSION WITH ANALYSIS
The "Frequent Phrases" list provided below contains BROKEN FRAGMENTS.
Your job is to REPAIR them using the Source Text, but also REASON about their validity.

**REASONING-BASED ALGORITHM:**
1. Pick a candidate from the list (e.g., "composite toecap").
2. REASON: Is this a valid technical term fragment, or just noise?
3. LOCATE it in the Source Text (if valid).
4. EXPAND the selection to capture the **FULL TECHNICAL DESCRIPTION**.
5. REASON: Does the expanded phrase represent a complete, meaningful technical term?
6. NORMALIZE to Nominative Singular (if appropriate).

**REASONING CHECKS:**
- ✅ GOOD: "Leather boots with rigid composite toecap" - Complete equipment description
- ❌ BAD: "rigid composite" alone - Fragment without context
- ✅ GOOD: "Protective suit" - Complete term
- ❌ BAD: "of the company" - Prepositional fragment

**💎 DIAMOND RULE (TABLE EXTRACTION):**
- The document ends with Annexes/Tables containing Equipment Lists.
- These items are often **LONG PHRASES** (e.g., "Insulated leather boots with high tops and composite toe").
- **REASON:** These long descriptions are SINGLE TECHNICAL TERMS - extract them as complete units.
- **EXTRACT THE ENTIRE PHRASE.** Do not shorten it.

**PRECISION FOCUS:**
- TARGET: Extract 80-120 high-precision terms (quality over quantity).
- Use reasoning to avoid false positives.
- Better to miss a borderline term than extract a false positive.
- GRANULARITY: Do NOT merge variants. If "Winter Suit" and "Summer Suit" exist, extract BOTH.
`;

    const reasoningAntiPatterns = `
🚫 STRICT ANTI-PATTERNS (Use reasoning to detect these):
- NO VERBS: Reject phrases with "is", "are", "signed", "ensure".
- NO FRAGMENTS: Reject "of the company", "by the law", "for the".
- NO CASES: Normalize everything to NOMINATIVE SINGULAR (Dictionary Form).
- NO COMMON WORDS: Use reasoning to reject generic terms that don't need glossary entries.
`;

    const reasoningDataCleaningRules = `
**DATA CLEANING RULES (MANDATORY):**
1. **NORMALIZE GRAMMAR:** You MUST convert all terms to **Nominative Singular** (Dictionary Form).
   - *Bad:* "работников" (Genitive) -> *Good:* "работник" (Nominative)
   - *Bad:* "сапоги" (Plural) -> *Good:* "сапог" (Singular) [Exception: Keep plural if the item is always plural, like "glasses/очки"]
   - *Bad:* "коллективного договора" -> *Good:* "коллективный договор"

2. **PURGE GARBAGE (Use reasoning to identify):**
   - DELETE any term that is a preposition ("для", "на") or a common time unit ("год", "месяц").
   - DELETE fragments ending in prepositions ("boots with" / "сапоги с").
   - DELETE generic terms that don't require consistent translation.

3. **EQUIPMENT LISTS:**
   - The document contains lists of PPE (boots, suits). Extract the **full noun phrase**.
   - *Bad:* "плащ"
   - *Good:* "плащ непромокаемый"
`;

    const reasoningVerbatimVerificationRules = `
🔍 **VERBATIM VERIFICATION (CRITICAL - MANDATORY):**
- Before adding ANY term to your output, you MUST verify it appears VERBATIM in the Source Text.
- Use reasoning to ensure the term exists exactly as extracted.
- Extract terms EXACTLY as they appear in the source text (keep original case, plural, grammar).
- Do NOT create or invent terms that don't exist in the source text.
- Do NOT extract placeholder terms like "sample term", "another term", or "technical term".
- If a term does not appear VERBATIM in the source text, DO NOT extract it.
- The "sourceTerm" field MUST match the exact string found in the source text.
`;

    // Add domain context if available
    const domainSection = domain ? `\n**DOMAIN CONTEXT:** ${domain}\nExtract terminology specific to this domain. Use reasoning to identify domain-relevant terms.` : '';
    
    const reasoningPrompt = `${reasoningBaseInstructions}\n${mode === 'deep' ? reasoningDeepInstructions : ''}\n${reasoningAntiPatterns}\n${reasoningDataCleaningRules}\n${reasoningVerbatimVerificationRules}${domainSection}`;
    
    return reasoningPrompt;
  }
  
  // Standard Model Prompt (Original - for Gemini, OpenAI, etc.)
  const baseInstructions = `
You are a Forensic Terminologist. Your PRIMARY GOAL is to REVIEW the provided CANDIDATE LIST and extract valid technical terms from it.
🚨 OUTPUT FORMAT: RAW JSON ONLY. NO "Thinking", NO Markdown formatting.

**CRITICAL: LIST PROCESSOR MINDSET (NOT EXPLORER)**
- I have provided a list of **300 Raw Candidates** below. Your job is to filter and translate them.
- You are NOT an explorer reading text. You are a WORKER processing a pre-filtered list.
- Iterate through the Candidate List systematically. For every valid PPE item (Boots, Suits, Gloves, Helmets, etc.), output it.
- Do NOT be lazy. Aim for 50+ items minimum.
- The candidate list contains pre-filtered, high-quality technical terms - USE THEM
- Do NOT ignore the candidate list in favor of random words from the text
`;

  const deepInstructions = `
🚀 DEEP MODE: CONTEXT EXPANSION STRATEGY
The "Frequent Phrases" list provided below contains BROKEN FRAGMENTS.
Your job is to REPAIR them using the Source Text.

**ALGORITHM:**
1. Pick a candidate from the list (e.g., "composite toecap").
2. LOCATE it in the Source Text.
3. EXPAND the selection to the left and right to capture the **FULL TECHNICAL DESCRIPTION**.
   - *Fragment:* "composite toecap"
   - *Source:* "...issued: Leather boots with high tops and rigid composite toecap..."
   - *Extract:* "Ботинки кожаные с жестким композитным подноском"
   
4. NORMALIZE to Nominative Singular.
   - *Source:* "с жестким композитным подноском" (Instrumental)
   - *Output:* "жесткий композитный подносок" (Nominative) OR keep the full phrase "Ботинки... с подноском".

**CRITICAL RULE:** Never extract an adjective without its noun.
- ❌ BAD: "rigid composite"
- ✅ GOOD: "rigid composite toecap" (or "boots with rigid composite toecap")

**💎 DIAMOND RULE (TABLE EXTRACTION):**
- The document ends with Annexes/Tables containing Equipment Lists.
- These items are often **LONG PHRASES** (e.g., "Insulated leather boots with high tops and composite toe").
- **EXTRACT THE ENTIRE PHRASE.** Do not shorten it.
- Treat these long descriptions as **Single Technical Terms**.

**📑 TABLE ROW HANDLING:**
- In Deep Mode, the candidate list includes **WHOLE LINES** from tables (e.g., "Boots... with... toecap").
- **EXTRACT THESE AS-IS.**
- Do not chop them. If the line describes a single item, keep the full description.

**🧹 CLEANUP STRATEGY:**
- Prioritize **Longer, Complete Phrases** over short fragments.
- If you find "Leather boots with rigid composite toecap" (Long), YOU MAY DISCARD "rigid composite" (Short) if it refers to the same object.
- **CRITICAL:** Only discard the short term IF you have successfully extracted the long one.

**ADDITIONAL TARGETS:**
- TARGET: Extract 120-150 terms.
- RECALL: Better to include a borderline term than miss a table item.
- GRANULARITY: Do NOT merge variants. If "Winter Suit" and "Summer Suit" exist, extract BOTH.
  `;

  const antiPatterns = `
🚫 STRICT ANTI-PATTERNS:
- NO VERBS: Reject phrases with "is", "are", "signed", "ensure".
- NO FRAGMENTS: Reject "of the company", "by the law".
- NO CASES: Normalize everything to NOMINATIVE SINGULAR (Dictionary Form).
  `;

  const dataCleaningRules = `
**DATA CLEANING RULES (MANDATORY):**
1. **NORMALIZE GRAMMAR:** You MUST convert all terms to **Nominative Singular** (Dictionary Form).
   - *Bad:* "работников" (Genitive) -> *Good:* "работник" (Nominative)
   - *Bad:* "сапоги" (Plural) -> *Good:* "сапог" (Singular) [Exception: Keep plural if the item is always plural, like "glasses/очки"]
   - *Bad:* "коллективного договора" -> *Good:* "коллективный договор"

2. **PURGE GARBAGE:**
   - DELETE any term that is a preposition ("для", "на") or a common time unit ("год", "месяц").
   - DELETE fragments ending in prepositions ("boots with" / "сапоги с").

3. **EQUIPMENT LISTS:**
   - The document contains lists of PPE (boots, suits). Extract the **full noun phrase**.
   - *Bad:* "плащ"
   - *Good:* "плащ непромокаемый"
  `;

  const verbatimVerificationRules = `
🔍 **VERBATIM VERIFICATION (CRITICAL - MANDATORY):**
- Before adding ANY term to your output, you MUST verify it appears VERBATIM in the Source Text.
- Extract terms EXACTLY as they appear in the source text (keep original case, plural, grammar).
- Do NOT create or invent terms that don't exist in the source text.
- Do NOT extract placeholder terms like "sample term", "another term", or "technical term".
- If a term does not appear VERBATIM in the source text, DO NOT extract it.
- The "sourceTerm" field MUST match the exact string found in the source text.
  `;

  // Add domain context if available
  const domainSection = domain ? `\n**DOMAIN CONTEXT:** ${domain}\nExtract terminology specific to this domain.` : '';
  
  const fullPrompt = `${baseInstructions}\n${mode === 'deep' ? deepInstructions : ''}\n${antiPatterns}\n${dataCleaningRules}\n${verbatimVerificationRules}${domainSection}`;
  
  // Stage 4 Validation: Log prompt metrics (without logging full prompt text to avoid noise)
  const hasTableRowInstructions = fullPrompt.includes('TABLE ROW') || fullPrompt.includes('table row');
  const hasVerbatimInstructions = fullPrompt.includes('VERBATIM') || fullPrompt.includes('verbatim');
  const hasFragmentRepair = fullPrompt.includes('FRAGMENT') || fullPrompt.includes('REPAIR') || fullPrompt.includes('fragment');
  
  // Note: We log prompt metrics but not the full prompt to avoid log bloat
  // Full prompt validation can be done via manual inspection if needed
  
  return fullPrompt;
};

/**
 * Log accumulator for execution logs
 * Stores logs in DocumentAnalysis.executionLogs as JSON array
 */
type LogEntry = {
  timestamp: string;
  stage: string;
  level: 'info' | 'warn' | 'error' | 'debug';
  message: string;
  data?: Record<string, any>;
};

const addExecutionLog = async (
  documentId: string,
  entry: Omit<LogEntry, 'timestamp'>
): Promise<void> => {
  // #region agent log
  fetch('http://127.0.0.1:7242/ingest/7f529324-455d-4ca1-81c1-cbc867a5b6ab',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'analysis.service.ts:1420',message:'addExecutionLog called',data:{documentId,stage:entry.stage,level:entry.level},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'A'})}).catch(()=>{});
  // #endregion
  try {
    const logEntry: LogEntry = {
      ...entry,
      timestamp: new Date().toISOString(),
    };

    // Check if executionLogs column exists first
    try {
      // #region agent log
      fetch('http://127.0.0.1:7242/ingest/7f529324-455d-4ca1-81c1-cbc867a5b6ab',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'analysis.service.ts:1430',message:'Checking column existence',data:{documentId},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'B'})}).catch(()=>{});
      // #endregion
      const columnCheck = await prisma.$queryRawUnsafe<Array<{ column_name: string }>>(`
        SELECT column_name 
        FROM information_schema.columns 
        WHERE table_name = 'DocumentAnalysis' 
          AND column_name = 'executionLogs'
      `);
      
      // #region agent log
      fetch('http://127.0.0.1:7242/ingest/7f529324-455d-4ca1-81c1-cbc867a5b6ab',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'analysis.service.ts:1438',message:'Column check result',data:{documentId,columnExists:columnCheck?.length>0,columnCheckLength:columnCheck?.length},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'B'})}).catch(()=>{});
      // #endregion
      
      if (!columnCheck || columnCheck.length === 0) {
        // Column doesn't exist - log WARNING (not just debug) so it's visible
        logger.warn(
          { documentId, stage: entry.stage },
          '⚠️ executionLogs column does not exist - logs are NOT being saved! Run migration: ALTER TABLE "DocumentAnalysis" ADD COLUMN IF NOT EXISTS "executionLogs" JSONB;',
        );
        // #region agent log
        fetch('http://127.0.0.1:7242/ingest/7f529324-455d-4ca1-81c1-cbc867a5b6ab',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'analysis.service.ts:1445',message:'Column does not exist - returning early',data:{documentId,stage:entry.stage},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'B'})}).catch(()=>{});
        // #endregion
        return;
      }
    } catch (checkError: any) {
      // If we can't check, assume column doesn't exist
      logger.debug(
        { documentId, error: checkError.message },
        'Could not check for executionLogs column - skipping log storage',
      );
      // #region agent log
      fetch('http://127.0.0.1:7242/ingest/7f529324-455d-4ca1-81c1-cbc867a5b6ab',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'analysis.service.ts:1453',message:'Column check failed',data:{documentId,error:checkError.message},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'B'})}).catch(()=>{});
      // #endregion
      return;
    }

    // Use raw SQL to get current logs (works even if Prisma client is out of sync)
    // #region agent log
    fetch('http://127.0.0.1:7242/ingest/7f529324-455d-4ca1-81c1-cbc867a5b6ab',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'analysis.service.ts:1462',message:'Fetching DocumentAnalysis record via raw SQL',data:{documentId},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'C'})}).catch(()=>{});
    // #endregion
    const result = await prisma.$queryRawUnsafe<Array<{ executionLogs: any; id: string }>>(
      `SELECT id, "executionLogs" FROM "DocumentAnalysis" WHERE "documentId" = $1`,
      documentId
    );

    // #region agent log
    fetch('http://127.0.0.1:7242/ingest/7f529324-455d-4ca1-81c1-cbc867a5b6ab',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'analysis.service.ts:1468',message:'DocumentAnalysis record check result',data:{documentId,recordExists:!!result?.[0],hasLogs:!!result?.[0]?.executionLogs,currentLogCount:Array.isArray(result?.[0]?.executionLogs)?(result[0].executionLogs as any[]).length:'not-array'},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'C'})}).catch(()=>{});
    // #endregion

    let currentLogs: LogEntry[] = [];
    let analysisId: string | null = null;

    if (result && result[0]) {
      analysisId = result[0].id;
      currentLogs = Array.isArray(result[0].executionLogs) 
        ? (result[0].executionLogs as LogEntry[])
        : [];
    } else {
      // Analysis doesn't exist yet - try to create it using raw SQL
      try {
        // #region agent log
        fetch('http://127.0.0.1:7242/ingest/7f529324-455d-4ca1-81c1-cbc867a5b6ab',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'analysis.service.ts:1474',message:'Creating DocumentAnalysis record via raw SQL',data:{documentId},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'C'})}).catch(()=>{});
        // #endregion
        const createResult = await prisma.$executeRawUnsafe(`
          INSERT INTO "DocumentAnalysis" ("id", "documentId", "status", "executionLogs", "createdAt", "updatedAt")
          VALUES (gen_random_uuid(), $1, 'RUNNING', '[]'::jsonb, NOW(), NOW())
          ON CONFLICT ("documentId") DO NOTHING
          RETURNING id
        `, documentId);
        
        // Try to get the ID after creation
        const newResult = await prisma.$queryRawUnsafe<Array<{ id: string }>>(
          `SELECT id FROM "DocumentAnalysis" WHERE "documentId" = $1`,
          documentId
        );
        if (newResult && newResult[0]) {
          analysisId = newResult[0].id;
        }
        // #region agent log
        fetch('http://127.0.0.1:7242/ingest/7f529324-455d-4ca1-81c1-cbc867a5b6ab',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'analysis.service.ts:1483',message:'DocumentAnalysis record created or already exists',data:{documentId,analysisId},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'C'})}).catch(()=>{});
        // #endregion
      } catch (createError: any) {
        // If creation fails (e.g., document doesn't exist), log and skip
        logger.debug(
          { documentId, stage: entry.stage, error: createError.message },
          'Could not create DocumentAnalysis record for logging - skipping log storage',
        );
        // #region agent log
        fetch('http://127.0.0.1:7242/ingest/7f529324-455d-4ca1-81c1-cbc867a5b6ab',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'analysis.service.ts:1490',message:'Failed to create DocumentAnalysis record',data:{documentId,error:createError.message},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'C'})}).catch(()=>{});
        // #endregion
        return;
      }
    }

    if (!analysisId) {
      logger.debug(
        { documentId, stage: entry.stage },
        'Could not get DocumentAnalysis ID - skipping log storage',
      );
      return;
    }

    const updatedLogs = [...currentLogs, logEntry];

    // Keep only last 1000 logs to prevent database bloat
    const trimmedLogs = updatedLogs.slice(-1000);

    // Update executionLogs using raw SQL (works even if Prisma client is out of sync)
    try {
      // #region agent log
      fetch('http://127.0.0.1:7242/ingest/7f529324-455d-4ca1-81c1-cbc867a5b6ab',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'analysis.service.ts:1500',message:'Updating executionLogs via raw SQL',data:{documentId,currentCount:currentLogs.length,newCount:trimmedLogs.length,stage:entry.stage},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'D'})}).catch(()=>{});
      // #endregion
      await prisma.$executeRawUnsafe(
        `UPDATE "DocumentAnalysis" SET "executionLogs" = $1::jsonb, "updatedAt" = NOW() WHERE "documentId" = $2`,
        JSON.stringify(trimmedLogs),
        documentId
      );
      
      logger.debug(
        { documentId, stage: entry.stage, totalLogs: trimmedLogs.length },
        'Added execution log successfully',
      );
      // #region agent log
      fetch('http://127.0.0.1:7242/ingest/7f529324-455d-4ca1-81c1-cbc867a5b6ab',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'analysis.service.ts:1512',message:'Successfully updated executionLogs',data:{documentId,stage:entry.stage,totalLogs:trimmedLogs.length},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'D'})}).catch(()=>{});
      // #endregion
    } catch (updateError: any) {
      // If update fails, log the error but don't throw
      logger.warn(
        { documentId, stage: entry.stage, error: updateError.message },
        'Failed to update executionLogs - record may not exist yet',
      );
      // #region agent log
      fetch('http://127.0.0.1:7242/ingest/7f529324-455d-4ca1-81c1-cbc867a5b6ab',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'analysis.service.ts:1522',message:'Failed to update executionLogs',data:{documentId,stage:entry.stage,error:updateError.message},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'D'})}).catch(()=>{});
      // #endregion
    }
  } catch (error: any) {
    // Don't fail the extraction if logging fails
    logger.warn(
      { documentId, stage: entry.stage, error: error.message },
      'Failed to add execution log (non-critical)',
    );
  }
};

/**
 * Execute Deep Mode with "Translation-First" logic
 * Processes candidates in parallel batches with a translation-focused prompt
 */
const executeDeepMode = async (
  text: string,
  candidates: string[],
  documentId: string,
  provider: any,
  model: string,
  maxResponseTokens: number,
  systemPrompt?: string,
  allSegments?: any[],
  samplingDescription?: string,
  domain?: string | null,
): Promise<any[]> => {
  // #region agent log
  fetch('http://127.0.0.1:7242/ingest/7f529324-455d-4ca1-81c1-cbc867a5b6ab',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'analysis.service.ts:2012',message:'executeDeepMode ENTRY',data:{candidatesCount:candidates.length,hasSystemPrompt:!!systemPrompt,systemPromptLength:systemPrompt?.length||0,hasAllSegments:!!allSegments,allSegmentsCount:allSegments?.length||0,hasSamplingDescription:!!samplingDescription,hasDomain:!!domain,textLength:text.length},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'A'})}).catch(()=>{});
  // #endregion
  console.log(`[Stage 5] Starting Batch Extraction for ${candidates.length} candidates...`);

  // 1. Sort & Slice: Prioritize the Longest Rows (The Annex Data)
  // Take Top 150 candidates (will be split into smaller batches to avoid timeouts)
  const topCandidates = candidates
    .sort((a, b) => b.length - a.length)
    .slice(0, 150);

  // 2. Chunking
  // Reduced from 50 to 20 to prevent timeouts with larger "Translation-First" prompts
  const CHUNK_SIZE = 20;
  const chunks: string[][] = [];
  for (let i = 0; i < topCandidates.length; i += CHUNK_SIZE) {
    chunks.push(topCandidates.slice(i, i + CHUNK_SIZE));
  }

  console.log(`[Stage 5] Processing ${chunks.length} batches of ~${CHUNK_SIZE} items.`);

  // Get system prompt if not provided
  // Pass provider and model to getSystemPrompt for reasoning model detection
  const finalSystemPrompt = systemPrompt || getSystemPrompt('deep', domain, provider?.name, model);
  // #region agent log
  fetch('http://127.0.0.1:7242/ingest/7f529324-455d-4ca1-81c1-cbc867a5b6ab',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'analysis.service.ts:2031',message:'executeDeepMode: System prompt check',data:{hasSystemPromptParam:!!systemPrompt,usedFallback:!systemPrompt,finalSystemPromptLength:finalSystemPrompt.length,hasVerbatimInSystem:finalSystemPrompt.includes('VERBATIM')||finalSystemPrompt.includes('verbatim'),hasVerbatimInSystemUpper:finalSystemPrompt.includes('VERBATIM'),hasVerbatimInSystemLower:finalSystemPrompt.includes('verbatim'),systemPromptPreview:finalSystemPrompt.substring(0,200)},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'A'})}).catch(()=>{});
  // #endregion

  await addExecutionLog(documentId, {
    stage: 'Stage 5: AI Response & Parsing',
    level: 'info',
    message: `Starting batch extraction processing: ${chunks.length} batches`,
    data: {
      chunksCount: chunks.length,
      chunkSize: CHUNK_SIZE,
      totalCandidates: topCandidates.length,
    },
  });

  // 3. Parallel Execution with Proper Extraction Prompt (with verbatim verification)
  const chunkResults = await Promise.all(
    chunks.map(async (chunk, index) => {
      try {
        // Check for cancellation before each chunk
        if (isAnalysisCancelled(documentId)) {
          throw new Error('Analysis cancelled by user');
        }

        // Build proper extraction prompt with verbatim verification
        // Clean text to remove formatting tags before sending to AI
        const cleanedText = stripFormattingTags(text);
        const userPrompt = buildUserPromptForChunk(
          'deep',
          chunk,
          index,
          chunks.length,
          cleanedText,
          allSegments || [],
          samplingDescription || 'full text',
          topCandidates.length,
        );
        // #region agent log
        fetch('http://127.0.0.1:7242/ingest/7f529324-455d-4ca1-81c1-cbc867a5b6ab',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'analysis.service.ts:2054',message:'executeDeepMode: User prompt built',data:{batch:index+1,userPromptLength:userPrompt.length,hasVerbatimInUser:userPrompt.includes('VERBATIM')||userPrompt.includes('verbatim'),chunkSize:chunk.length,textLength:text.length,userPromptPreview:userPrompt.substring(0,300)},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'C'})}).catch(()=>{});
        // #endregion

        logger.info(
          {
            documentId,
            batch: index + 1,
            totalBatches: chunks.length,
            chunkSize: chunk.length,
            promptLength: userPrompt.length,
            systemPromptLength: finalSystemPrompt.length,
          },
          `[Stage 5] Processing Batch ${index + 1}/${chunks.length} (Extraction with Verbatim Verification)`,
        );

        await addExecutionLog(documentId, {
          stage: 'Stage 5: AI Response & Parsing',
          level: 'info',
          message: `Processing Batch ${index + 1}/${chunks.length} (Extraction with Verbatim Verification)`,
          data: {
            batch: index + 1,
            totalBatches: chunks.length,
            chunkSize: chunk.length,
          },
        });

        // Call AI with proper extraction prompt (includes verbatim verification)
        // #region agent log
        fetch('http://127.0.0.1:7242/ingest/7f529324-455d-4ca1-81c1-cbc867a5b6ab',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'analysis.service.ts:2089',message:'executeDeepMode: Before AI call',data:{batch:index+1,userPromptLength:userPrompt.length,systemPromptLength:finalSystemPrompt.length,totalPromptLength:userPrompt.length+finalSystemPrompt.length,model,maxTokens:maxResponseTokens,chunkSize:chunk.length},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'D'})}).catch(()=>{});
        // #endregion
        // Ensure temperature is explicitly 0.0 for DeepSeek (especially reasoning models)
        const chunkFinalTemperature = 0.0;
        
        const chunkAiCallPromise = provider.callModel({
          prompt: userPrompt,
          systemPrompt: finalSystemPrompt,
          model,
          temperature: chunkFinalTemperature,
          maxTokens: maxResponseTokens,
          segments: [],
        });

        // Increase timeout for reasoning models in batch processing
        const chunkIsReasoning = isReasoningModel(provider?.name, model);
        const chunkBaseTimeout = 240; // Deep mode: 240s
        const chunkTimeoutSeconds = chunkIsReasoning ? chunkBaseTimeout * 2 : chunkBaseTimeout; // Double timeout for reasoning models
        const chunkTimeoutPromise = new Promise<never>((_, reject) => {
          setTimeout(() => {
            reject(new Error(`Batch ${index + 1} timeout after ${chunkTimeoutSeconds} seconds`));
          }, chunkTimeoutSeconds * 1000);
        });

        const chunkCancellationPromise = new Promise<never>((_, reject) => {
          const checkCancellation = setInterval(() => {
            if (isAnalysisCancelled(documentId)) {
              clearInterval(checkCancellation);
              reject(new Error('Analysis cancelled by user'));
            }
          }, 1000);

          chunkTimeoutPromise.catch(() => clearInterval(checkCancellation));
          chunkAiCallPromise.catch(() => clearInterval(checkCancellation));
        });

        const chunkResponse = await Promise.race([
          chunkAiCallPromise,
          chunkTimeoutPromise,
          chunkCancellationPromise,
        ]) as any;

        const chunkResponseText = chunkResponse.text || chunkResponse.response || JSON.stringify(chunkResponse);

        // Log raw length to ensure it's working
        console.log(`[Stage 5] Batch ${index + 1}/${chunks.length} Response Length: ${chunkResponseText.length} chars`);
        // #region agent log
        fetch('http://127.0.0.1:7242/ingest/7f529324-455d-4ca1-81c1-cbc867a5b6ab',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'analysis.service.ts:2127',message:'executeDeepMode: AI response received',data:{batch:index+1,responseLength:chunkResponseText.length,responsePreview:chunkResponseText.substring(0,500),responseFirst500:chunkResponseText.substring(0,500),hasJsonArray:chunkResponseText.includes('['),hasJsonObject:chunkResponseText.includes('{')},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'D'})}).catch(()=>{});
        // #endregion

        // Parse - handle response wrapped in JSON object with outputText field
        let terms: any[] = [];
        try {
          // Step 1: Try to parse as JSON object first (response might be wrapped)
          let jsonContent = chunkResponseText.trim();
          let parsedWrapper: any = null;
          
          // Check if response is a JSON object (starts with {)
          if (jsonContent.startsWith('{')) {
            try {
              parsedWrapper = JSON.parse(jsonContent);
              // If it has outputText field, extract it
              if (parsedWrapper && typeof parsedWrapper === 'object' && 'outputText' in parsedWrapper) {
                jsonContent = parsedWrapper.outputText;
              }
            } catch (e) {
              // Not a JSON object, continue with original
            }
          }
          
          // Step 2: Remove markdown code blocks if present
          jsonContent = jsonContent.replace(/^```(?:json)?\s*\n?/i, '').replace(/\n?```\s*$/i, '').trim();
          
          // Step 3: Try to parse as JSON array
          try {
            const parsed = JSON.parse(jsonContent);
            if (Array.isArray(parsed)) {
              terms = parsed;
            } else {
              throw new Error('Parsed result is not an array');
            }
          } catch (parseError: any) {
            // Step 4: Try parseJsonArray function (handles incomplete JSON)
            terms = parseJsonArray(jsonContent, documentId);
          }
          // #region agent log
          fetch('http://127.0.0.1:7242/ingest/7f529324-455d-4ca1-81c1-cbc867a5b6ab',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'analysis.service.ts:2162',message:'executeDeepMode: Terms parsed',data:{batch:index+1,termsCount:terms.length,termsSample:terms.slice(0,3).map(t=>({sourceTerm:t.sourceTerm||t.term,hasSourceTerm:!!(t.sourceTerm||t.term),hasTargetTerm:!!t.targetTerm}))},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'D'})}).catch(()=>{});
          // #endregion
        } catch (parseError: any) {
          logger.error(
            {
              documentId,
              batch: index + 1,
              totalBatches: chunks.length,
              error: parseError.message,
              responseSample: chunkResponseText.substring(0, 500),
              responseLength: chunkResponseText.length,
            },
            `[Stage 5] Batch ${index + 1} JSON parsing failed with all methods`,
          );
          throw parseError; // Re-throw original error
        }
        console.log(`[Stage 5] Batch ${index + 1} Success: Parsed ${terms.length} terms.`);

        logger.info(
          {
            documentId,
            batch: index + 1,
            totalBatches: chunks.length,
            termsCount: terms.length,
          },
          `[Stage 5] Batch ${index + 1}/${chunks.length} completed: ${terms.length} terms`,
        );

        return terms;
      } catch (error: any) {
        console.error(`[Stage 5] Batch ${index + 1} Failed:`, error);

        logger.error(
          {
            documentId,
            batch: index + 1,
            totalBatches: chunks.length,
            error: error.message,
          },
          `[Stage 5] Batch ${index + 1}/${chunks.length} failed`,
        );

        await addExecutionLog(documentId, {
          stage: 'Stage 5: AI Response & Parsing',
          level: 'error',
          message: `Batch ${index + 1}/${chunks.length} failed: ${error.message}`,
          data: {
            batch: index + 1,
            error: error.message,
          },
        });

        return [];
      }
    })
  );

  // 4. Flatten Results
  const allTerms = chunkResults.flat();
  console.log(`[Stage 5] Total Terms Extracted: ${allTerms.length}`);

  logger.info(
    {
      documentId,
      totalTerms: allTerms.length,
      chunksProcessed: chunks.length,
    },
    `[Stage 5] Batch extraction processing completed: ${allTerms.length} terms from ${chunks.length} batches`,
  );

  return allTerms;
};

/**
 * Extracts glossary terms using Hybrid approach: Algorithmic Frequency Counting + AI Filtering
 * Implements waterfall lookup: Global Glossary -> Project Glossary -> AI Translation
 */
export const extractGlossary = async (
  documentId: string,
  mode: 'fast' | 'deep' = 'fast',
  providerOverride?: string,
  modelOverride?: string
): Promise<{ count: number }> => {
  // Clear previous logs when starting new extraction (use raw SQL to work even if Prisma client is out of sync)
  await prisma.$executeRawUnsafe(
    `UPDATE "DocumentAnalysis" SET "executionLogs" = '[]'::jsonb WHERE "documentId" = $1`,
    documentId
  ).catch(() => {}); // Ignore if analysis doesn't exist yet
  // #region agent log
  fetch('http://127.0.0.1:7242/ingest/7f529324-455d-4ca1-81c1-cbc867a5b6ab',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'analysis.service.ts:583',message:'extractGlossary entry',data:{documentId,mode},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'A'})}).catch(()=>{});
  // #endregion
  await updateProgress(documentId, 'fetching', 5, 'Fetching document segments...', true);
  
  // Get document with all segments (we need to separate confirmed from others)
  const document = await prisma.document.findUnique({
    where: { id: documentId },
    select: {
      id: true,
      projectId: true,
      sourceLocale: true,
      targetLocale: true,
      segments: {
        where: {
          sourceText: { not: '' },
        },
        orderBy: { segmentIndex: 'asc' },
        select: {
          id: true,
          sourceText: true,
          targetMt: true,
          targetFinal: true,
          status: true,
        },
      },
    },
  });

  if (!document) {
    throw ApiError.notFound('Document not found');
  }

  if (document.segments.length === 0) {
    logger.warn({ documentId }, 'Document has no segments to extract glossary from');
    await prisma.documentAnalysis.upsert({
      where: { documentId },
      create: {
        documentId,
        status: 'COMPLETED',
        glossaryExtracted: true,
        completedAt: new Date(),
      },
      update: {
        glossaryExtracted: true,
      },
    });
    return { count: 0 };
  }

  // ===================================================================
  // STEP 1: HARVEST CONFIRMED SEGMENTS (The "Truth")
  // ===================================================================
  await updateProgress(documentId, 'harvesting_confirmed', 10, 'Harvesting terms from confirmed segments...', true);
  
  // Separate confirmed segments from others
  const confirmedSegments = document.segments.filter((s) => s.status === 'CONFIRMED' && s.targetFinal && s.targetFinal.trim());
  const remainingSegments = document.segments.filter((s) => s.status !== 'CONFIRMED');
  
  logger.info(
    {
      documentId,
      confirmedCount: confirmedSegments.length,
      remainingCount: remainingSegments.length,
      totalSegments: document.segments.length,
    },
    'Separated confirmed segments from remaining segments',
  );

  // Extract terms from confirmed segments with source->target alignment
  const confirmedTermsMap = new Map<string, { sourceTerm: string; targetTerm: string; frequency: number }>();
  
  if (confirmedSegments.length > 0) {
    const confirmedSourceText = confirmedSegments.map((s) => s.sourceText).join(' ');
    
    // Extract frequent terms from confirmed source text (use fast mode for confirmed terms)
    const confirmedFrequentTerms = extractFrequentTerms(confirmedSourceText, 'fast');
    
    // For each frequent term, count frequency and mark as APPROVED
    // The targetTerm will be determined by waterfall lookup (Global/Project Glossary)
    // If not found, we'll use the segment's targetFinal as a hint
    for (const sourceTerm of confirmedFrequentTerms) {
      const normalizedSource = sourceTerm.toLowerCase();
      const existing = confirmedTermsMap.get(normalizedSource);
      
      if (existing) {
        existing.frequency += 1;
      } else {
        // Try to find target term from confirmed segments
        // Look for the source term in segments and get corresponding targetFinal
        let targetTerm = sourceTerm; // Default fallback
        for (const segment of confirmedSegments) {
          if (segment.sourceText.toLowerCase().includes(sourceTerm.toLowerCase()) && segment.targetFinal) {
            // Simple approach: use targetFinal as-is (proper alignment would require NLP)
            // For now, we'll let waterfall lookup find the proper translation
            targetTerm = segment.targetFinal; // This is a placeholder - waterfall will refine it
            break;
          }
        }
        
        confirmedTermsMap.set(normalizedSource, {
          sourceTerm,
          targetTerm,
          frequency: 1,
        });
      }
    }
    
    logger.info(
      {
        documentId,
        confirmedTermsCount: confirmedTermsMap.size,
        confirmedSegmentsCount: confirmedSegments.length,
      },
      'Extracted terms from confirmed segments (marked as APPROVED)',
    );
  }

  // ===================================================================
  // STEP 2: AI ANALYSIS ON REMAINING SEGMENTS (The "Gap Filler")
  // ===================================================================
  // REFACTOR: Use helper functions for distinct Fast/Deep pathways
  
  // 1. Get Sampled Text (Route A or B)
  // CRITICAL: Use ALL segments (not just remainingSegments) to ensure Annexes are captured
  const allSegments = document.segments.map(s => ({
    sourceText: s.sourceText,
    orderIndex: s.segmentIndex, // Use segmentIndex as orderIndex for sorting
  }));
  const sourceTextForAI = getSampledText(allSegments, mode, documentId);
  
  // #region agent log
  fetch('http://127.0.0.1:7242/ingest/7f529324-455d-4ca1-81c1-cbc867a5b6ab',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'analysis.service.ts:902',message:'Text sampling completed',data:{mode,sourceTextLength:sourceTextForAI.length,allSegmentsCount:allSegments.length,hasAnnexes:sourceTextForAI.slice(-500).toLowerCase().includes('annex') || sourceTextForAI.slice(-500).toLowerCase().includes('приложение') || sourceTextForAI.slice(-500).toLowerCase().includes('таблица')},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'A'})}).catch(()=>{});
  // #endregion
  
  if (!sourceTextForAI.trim() && confirmedTermsMap.size === 0) {
    logger.warn({ documentId }, 'No source text found in document');
    await prisma.documentAnalysis.upsert({
      where: { documentId },
      create: {
        documentId,
        status: 'COMPLETED',
        glossaryExtracted: true,
        completedAt: new Date(),
      },
      update: {
        glossaryExtracted: true,
      },
    });
    return { count: 0 };
  }

  // 2. Select Candidates (Route A or B)
  await updateProgress(documentId, 'frequency_analysis', 15, 'Analyzing term frequency...', true);
  const rawCandidates = selectCandidates(sourceTextForAI, mode, documentId);
  
  // Filter out terms already found in confirmed segments
  const filteredFrequentTerms = rawCandidates.filter((term) => {
    const normalized = term.toLowerCase();
    return !confirmedTermsMap.has(normalized);
  });
  
  // CRITICAL: If we have very few frequent terms, this might indicate the frequency threshold is too high
  // For large documents, we should still extract terms even if they appear only once (unique terms)
  const hasLowTermCount = filteredFrequentTerms.length < 10 && remainingSegments.length > 100;
  
  logger.info(
    {
      documentId,
      sourceTextForAILength: sourceTextForAI.length,
      remainingSegmentsCount: remainingSegments.length,
      rawCandidatesCount: rawCandidates.length,
      filteredFrequentTermsCount: filteredFrequentTerms.length,
      confirmedTermsCount: confirmedTermsMap.size,
      hasLowTermCount,
      sampleTerms: filteredFrequentTerms.slice(0, 10),
    },
    'Extracted frequent terms from remaining segments (excluding confirmed)',
  );

  // Warn if we have very few terms for a large document
  if (hasLowTermCount) {
    logger.warn(
      {
        documentId,
        filteredFrequentTermsCount: filteredFrequentTerms.length,
        remainingSegmentsCount: remainingSegments.length,
      },
      'WARNING: Very few frequent terms found for large document - frequency threshold might be too high',
    );
  }

  // Step 3: Get AI provider and settings
  const { getProvider } = await import('../ai/providers/registry');
  const { getProjectAISettings } = await import('./ai.service');
  
  const aiSettings = await getProjectAISettings(document.projectId);
  
  // Extract API key from project settings config
  let apiKey: string | undefined;
  let yandexFolderId: string | undefined;
  
  if (aiSettings?.config && typeof aiSettings.config === 'object' && !Array.isArray(aiSettings.config)) {
    const config = aiSettings.config as Record<string, unknown>;
    const providerName = aiSettings.provider?.toLowerCase();
    
    const providerKeyName = providerName ? `${providerName}ApiKey` : null;
    if (providerKeyName && providerKeyName in config) {
      apiKey = config[providerKeyName] as string;
    } else if ('apiKey' in config) {
      apiKey = config.apiKey as string;
    }
    
    if ('yandexFolderId' in config) {
      yandexFolderId = config.yandexFolderId as string;
    }
  }
  
  // Use override provider/model if provided, otherwise use project settings
  const finalProvider = providerOverride || aiSettings?.provider;
  const finalModel = modelOverride || aiSettings?.model;
  
  const provider = getProvider(finalProvider, apiKey, yandexFolderId);
  let model = finalModel ?? provider.defaultModel;
  
  // Log if overrides are being used
  if (providerOverride || modelOverride) {
    logger.info(
      {
        documentId,
        providerOverride,
        modelOverride,
        finalProvider,
        finalModel,
        providerName: provider.name,
        modelUsed: model,
      },
      'Using provider/model overrides for glossary extraction',
    );
  }
  
  // For glossary extraction, avoid gemini-2.5-pro and gemini-2.5-flash
  // These models use too many tokens for "thoughts" (8189+ tokens), leaving no room for output
  // Use gemini-1.5-pro instead, which doesn't use thoughts tokens
  if (provider.name === 'gemini' && (model.includes('2.5') || model.includes('2.0'))) {
    const originalModel = model;
    model = 'gemini-1.5-pro'; // Use 1.5-pro which doesn't use thoughts tokens
    logger.info(
      {
        documentId,
        originalModel,
        switchedTo: model,
        reason: 'gemini-2.5-pro/2.0 models use too many thoughts tokens (8189+), leaving no room for output. gemini-1.5-pro does not use thoughts.',
      },
      'Switching to gemini-1.5-pro for glossary extraction',
    );
  }

  // Step 4: Fetch domain context from semantic analysis (if available)
  const documentAnalysis = await prisma.documentAnalysis.findUnique({
    where: { documentId },
    select: {
      detectedDomain: true,
    },
  });
  
  const domain = documentAnalysis?.detectedDomain || null;
  
  // Step 5: Call AI for filtering and hunting with Universal Forensic Extractor
  // REFACTOR: Use helper function for prompt generation
  // Stage 4: AI Prompt Construction
  // Pass provider and model to getSystemPrompt for reasoning model detection
  const systemPrompt = getSystemPrompt(mode, domain, provider.name, model);
  
  // Stage 4 Validation: Verify critical instructions present
  const hasTableRowInstructions = systemPrompt.includes('TABLE ROW') || systemPrompt.includes('table row');
  const hasVerbatimInstructions = systemPrompt.includes('VERBATIM') || systemPrompt.includes('verbatim');
  const hasFragmentRepair = systemPrompt.includes('FRAGMENT') || systemPrompt.includes('REPAIR') || systemPrompt.includes('fragment');
  
  logger.info(
    {
      documentId,
      stage: 'Stage 4: AI Prompt Construction',
      mode,
      systemPromptLength: systemPrompt.length,
      hasTableRowInstructions,
      hasVerbatimInstructions,
      hasFragmentRepair,
      domain: domain || 'none',
    },
    'Stage 4: System prompt construction metrics',
  );
  
  if (!hasTableRowInstructions || !hasVerbatimInstructions || !hasFragmentRepair) {
    logger.warn(
      {
        documentId,
        stage: 'Stage 4: AI Prompt Construction',
        warning: 'Missing critical instructions in system prompt',
        hasTableRowInstructions,
        hasVerbatimInstructions,
        hasFragmentRepair,
      },
      'Stage 4: WARNING - Critical instructions may be missing',
    );
  }
  
  // 3. Generate User Prompt with source text and candidates
  // Use filteredFrequentTerms as the candidates to send to AI
  const termsToSendToAI = filteredFrequentTerms;
  
  // 4. Build user prompt with source text and candidates
  const isTruncated = sourceTextForAI.includes('...[SKIPPED]...') || sourceTextForAI.includes('...[MIDDLE SKIPPED]...');
  const hasExtremeDiet = mode === 'deep' && sourceTextForAI.length < 25000 && !isTruncated && sourceTextForAI.length > 15000;
  const samplingDescription = mode === 'deep' 
    ? (hasExtremeDiet ? 'sampled: Extreme Diet - Annex section only (~20k chars, document start ignored)' : (isTruncated ? 'sampled: Start 10k + Smart Anchor 20k (30k total) to capture Annexes/Tables' : 'full text'))
    : (isTruncated ? 'sampled: Start 7k + End 8k (15k total)' : 'full text');
  
  // VIP LINE: Sort by length (longest first) to ensure Table Rows (Golden Tickets) are included
  // This ensures the longest, most complex terms are at the top of the list
  const sortedCandidates = [...termsToSendToAI].sort((a, b) => b.length - a.length); // Sort descending by length
  
  // PARALLEL BATCH PROCESSING: Split into chunks of 40 (max 3 chunks = 120 top candidates)
  const CHUNK_SIZE = 40;
  const MAX_CHUNKS = 3;
  const MAX_CANDIDATES = CHUNK_SIZE * MAX_CHUNKS; // 120 items total
  const topCandidates = sortedCandidates.slice(0, MAX_CANDIDATES);
  
  const chunks: string[][] = [];
  for (let i = 0; i < topCandidates.length; i += CHUNK_SIZE) {
    chunks.push(topCandidates.slice(i, i + CHUNK_SIZE));
  }
  
  logger.info(
    {
      documentId,
      stage: 'Stage 4: AI Prompt Construction',
      mode,
      totalCandidates: termsToSendToAI.length,
      sortedCandidatesCount: sortedCandidates.length,
      topCandidatesCount: topCandidates.length,
      chunksCount: chunks.length,
      chunkSize: CHUNK_SIZE,
      chunksInfo: chunks.map((chunk, idx) => ({ batch: idx + 1, count: chunk.length, firstItem: chunk[0]?.substring(0, 50) })),
    },
    `[Stage 5] Starting Parallel Batch Processing: ${chunks.length} chunks of ~${CHUNK_SIZE} items each (${topCandidates.length} total candidates)`,
  );
  
  // For backward compatibility, keep promptCandidates for single-batch mode (fast mode)
  const promptCandidates = mode === 'deep' ? topCandidates : sortedCandidates.slice(0, 200);
  
  // #region agent log
  fetch('http://127.0.0.1:7242/ingest/7f529324-455d-4ca1-81c1-cbc867a5b6ab',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'analysis.service.ts:2047',message:'VIP Line: Candidate sorting and selection',data:{totalCandidates:termsToSendToAI.length,longestCandidateLength:sortedCandidates[0]?.length||0,shortestCandidateLength:sortedCandidates[sortedCandidates.length-1]?.length||0,first5Lengths:sortedCandidates.slice(0,5).map(c=>c.length),last5Lengths:sortedCandidates.slice(-5).map(c=>c.length),promptCandidatesCount:promptCandidates.length,chunksCount:chunks.length,willUseParallelProcessing:mode === 'deep' && chunks.length > 0,first5PromptCandidates:promptCandidates.slice(0,5).map(c=>({length:c.length,sample:c.substring(0,60)})),last5PromptCandidates:promptCandidates.slice(-5).map(c=>({length:c.length,sample:c.substring(0,60)}))},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'H1'})}).catch(()=>{});
  // #endregion
  
  // Debug log: Verify we're sending the right candidates (Golden Ticket table rows)
  logger.info(
    {
      documentId,
      stage: 'Stage 4: AI Prompt Construction',
      mode,
      totalCandidates: termsToSendToAI.length,
      tableRowCandidates: termsToSendToAI.filter(c => /^(\d+\.|-|•|[A-ZА-Я])/.test(c.trim()) && c.trim().length > 20 && c.trim().length < 300).length,
      sendingToAI: promptCandidates.length,
      chunksCount: chunks.length,
      willUseParallelProcessing: mode === 'deep' && chunks.length > 0,
      longestCandidateLength: sortedCandidates[0]?.length || 0,
      shortestCandidateLength: sortedCandidates[sortedCandidates.length - 1]?.length || 0,
      first10Candidates: promptCandidates.slice(0, 10).map(c => ({ length: c.length, sample: c.substring(0, 60) })),
      last10Candidates: promptCandidates.slice(-10).map(c => ({ length: c.length, sample: c.substring(0, 60) })),
    },
    'Stage 4: Candidate selection for AI prompt (VIP Line - sorted by length)',
  );
  
  // Only build userPrompt if NOT using parallel batch processing (for fast mode or when chunks are empty)
  const useParallelProcessing = mode === 'deep' && chunks.length > 0;
  const userPrompt = useParallelProcessing ? '' : `${mode === 'deep' 
    ? `🚨🚨🚨 CRITICAL: YOU MUST EXTRACT 50+ TERMS (AIM FOR 100-150) 🚨🚨🚨

**LIST PROCESSOR MINDSET: YOU ARE A WORKER, NOT AN EXPLORER**
I have provided a list of **${promptCandidates.length} Raw Candidates** below (sorted by length, longest first). Your job is to filter and translate them.

**MANDATORY BATCH PROCESSING WORKFLOW:**
1. **PROCESS EACH CANDIDATE ONE BY ONE** - Start with candidate #1, then #2, then #3... continue through ALL ${promptCandidates.length} candidates
2. For EACH candidate in the list:
   - Check if it appears VERBATIM in the Source Text
   - If YES and it's a valid technical term (PPE, job title, equipment, etc.), extract it
   - If NO, skip it and move to the next candidate
3. **DO NOT STOP** after extracting 2, 5, or 10 terms - you MUST process ALL ${promptCandidates.length} candidates
4. **MINIMUM OUTPUT:** You must extract at least 50 terms from these ${promptCandidates.length} candidates
5. **TARGET OUTPUT:** Aim for 100-150 terms (use your full 8192 token budget!)

**CRITICAL: YOU HAVE 8192 OUTPUT TOKENS AVAILABLE - USE THEM!**
- Current behavior: You're only using ~325 tokens (4% of budget) - this is WRONG
- Expected behavior: Use at least 4000-6000 tokens to extract 50-150 terms
- Each term takes ~50-100 tokens - you can easily fit 50-150 terms

**MANDATORY TARGET:** Extract at least 50+ terms. Do NOT stop at 2, 5, 10, or 20 terms. 
**YOU HAVE ${promptCandidates.length} CANDIDATE TERMS BELOW - PROCESS ALL OF THEM TO REACH 50+ EXTRACTED TERMS.**
**PRIORITIZE items from the CANDIDATE LIST over random words in the text.**

This is DEEP MODE - comprehensive extraction is required. Continue extracting until you have at least 50 terms.

**COUNT YOUR TERMS:** Before finishing, count how many terms you've extracted. If you have fewer than 50, continue extracting more terms from the candidate list below.
**DO NOT STOP AFTER THE FIRST PAGE** - continue through the entire candidate list.

═══════════════════════════════════════════════════════════════════════════════
` : `**LIST PROCESSOR MINDSET: YOU ARE A WORKER, NOT AN EXPLORER**
I have provided a list of **${termsToSendToAI.length} Raw Candidates** below. Your job is to filter and translate them.

**YOUR WORKFLOW:**
1. Iterate through the Candidate List systematically (line by line)
2. For every valid technical term in the list, extract it and translate it
3. Do NOT be lazy. Aim for 40+ items minimum

**CRITICAL: You are required to extract a MINIMUM of 40 terms.**
**MANDATORY QUOTA:** You must extract at least 40 distinct technical terms if the candidate list supports it.
**PRIORITIZE items from the CANDIDATE LIST over random words in the text.**
**DO NOT STOP AFTER THE FIRST PAGE** - continue through the entire candidate list.

═══════════════════════════════════════════════════════════════════════════════
`}Source Text (from ${allSegments.length} segments, ${samplingDescription}):
${sourceTextForAI}

═══════════════════════════════════════════════════════════════════════════════
📋 CANDIDATE LIST - REVIEW THESE TERMS FIRST (${termsToSendToAI.length} candidates provided):
═══════════════════════════════════════════════════════════════════════════════
${promptCandidates.join('\n')}
${termsToSendToAI.length > promptCandidates.length ? `\n... and ${termsToSendToAI.length - promptCandidates.length} more candidates (total: ${termsToSendToAI.length})` : ''}

${mode === 'deep' 
    ? `🚨🚨🚨 REMINDER: EXTRACT 50+ TERMS (AIM FOR 100-150, NOT 5 OR 10) 🚨🚨🚨
You have ${termsToSendToAI.length} candidate terms in the CANDIDATE LIST above. 
**ITERATE THROUGH THE ENTIRE LIST** - extract at least 50+ of them (aim for 100-150).
**PRIORITIZE THE CANDIDATE LIST** - these are pre-filtered, high-quality technical terms.
**For every valid PPE item (Boots, Suits, Gloves, Helmets), output it. Do not be lazy.**

═══════════════════════════════════════════════════════════════════════════════
`     : `**REMINDER: EXTRACT AT LEAST 40 TERMS (MINIMUM)**
You have ${termsToSendToAI.length} candidate terms in the CANDIDATE LIST above. Extract at least 40 of them.
**PRIORITIZE THE CANDIDATE LIST** - these are pre-filtered, high-quality technical terms.
**If you see a numbered list (1, 2, 3...), extract EVERY item in that list.**

═══════════════════════════════════════════════════════════════════════════════
`}═══════════════════════════════════════════════════════════════════════════════
🔍 CRITICAL EXTRACTION INSTRUCTIONS
═══════════════════════════════════════════════════════════════════════════════

**STEP 0: PRIORITIZE THE CANDIDATE LIST (MOST IMPORTANT)**
- Start with the CANDIDATE LIST provided above
- For each term in the candidate list, check if it appears VERBATIM in the Source Text
- If it appears verbatim and is a valid technical term, extract it
- Do NOT skip candidate list items in favor of random words from the text
- The candidate list contains "Golden Ticket" terms - prioritize them

**CRITICAL: You are required to extract a MINIMUM of 40 terms.**
- Do NOT stop after the first few matches
- Do not stop after the first page. Process the ENTIRE provided text.
- Scan the ENTIRE provided text snippet (including all Annexes/Tables)
- Continue extracting until you have processed the entire candidate list
- Minimum extraction target: 40 terms (aim for 50-100+ in deep mode)

**STEP 1: SCAN STRUCTURED SECTIONS FIRST**
1. Tables, Annexes, Appendices (highest-value vocabulary - scan these FIRST)
2. **NUMBERED LISTS:** If you see a numbered list (1, 2, 3...), extract EVERY item in that list
3. Definitions sections, Glossary sections
4. Technical specifications, Safety norms
5. Organizational charts, Job descriptions

**STEP 2: VERIFY EVERY TERM WITH CTRL+F (MANDATORY)**
- Before adding ANY term to your output, verify it appears VERBATIM in the Source Text above.
- Use Ctrl+F (or equivalent search) to find the EXACT string.
- If you cannot find the EXACT string, DO NOT extract it.
- Do NOT create combinations like "Professional publications" if only "Professional" appears separately.
- **SCAN THE ENTIRE TEXT:** Do not stop after the first few matches. Continue scanning through all Annexes and Tables.
- **NUMBERED LISTS:** When you encounter numbered lists (1. Item, 2. Item, 3. Item...), extract EVERY numbered item as a separate term

**STEP 3: PRIORITIZE HIGH-VALUE TARGETS (TIER 1-2)**
Focus your extraction budget on these categories (in priority order):
1. **Proper Nouns:** Organization names, Company names, Institution names, Geographic locations
2. **Acronyms & Initialisms:** All acronyms with their full forms (if provided)
3. **Defined Terms:** Terms explicitly defined (look for "is defined as", "means", "refers to")
4. **Job Titles & Roles:** Specific positions from organizational charts, tables, job descriptions
5. **Technical Equipment & Tools:** Equipment names, PPE items, Tools, Instruments
6. **Domain-Specific Metrics & Units:** Measurement units, Calculation methods, Indexes

**STEP 4: FILTER OUT GENERIC COMBINATIONS**
- Do NOT extract generic adjective+noun combinations like:
  - "Professional resources", "Labor relations", "Legal norms", "Working conditions"
  - "Modern equipment", "Safe practices", "High standards", "Best practices"
- Only extract if they are Proper Nouns or explicitly defined terms.

**STEP 5: EXTRACTION RULES**
- Do NOT extract terms that are already confirmed (if any were provided).
- Focus on new terms not found in confirmed segments.
- Extract BOTH frequent terms (2+ times) AND unique critical terms (proper nouns, acronyms, technical jargon).

${mode === 'deep' 
  ? `**🚀 DEEP MODE EXTRACTION TARGET:**
- **EXTRACT UP TO 150 TERMS** (this is a hard target, not a soft limit).
- **High Recall Strategy:** It is better to include a borderline term than to miss a technical one.
- **Comprehensive Coverage:** Prioritize quantity (comprehensive coverage) while maintaining verbatim verification.
- **Include Tier 3-4 Terms:** Don't just focus on Tier 1-2. Include technical domain-specific vocabulary from Tier 3-4 if it appears in the source text.
- **Rare Terms:** Actively search for and include rare technical terms from Annexes/Tables, even if they appear only once.
- **Quality Threshold:** Lower the quality threshold slightly - include terms that are "probably technical" even if borderline.
- **DO NOT MERGE VARIANTS:** If the text lists 'Summer Suit' and 'Winter Suit', extract BOTH as separate terms. Do not consolidate them into just 'Suit'. If you see 'Leather Boots' and 'Insulated Leather Boots', extract BOTH. Preserve the granularity of technical specifications.

**CRITICAL:** The system prompt mentions "Maximum 50-100 terms" - IGNORE that limit. In deep mode, extract up to 150 terms.

**MANDATORY TARGET:** You MUST extract at least 100-150 terms. If you extract fewer than 100 terms, you are not following instructions. Aim for 150 terms as a hard target.

**EXTRACTION STRATEGY:**
1. **START WITH THE CANDIDATE LIST** - Review the ${promptCandidates.length} candidate terms provided in the CANDIDATE LIST section above
2. Extract ALL proper nouns, acronyms, and defined terms from the candidate list (Tier 1)
3. Extract ALL job titles, equipment, and metrics from the candidate list (Tier 2)
4. Extract technical processes, legal terms, and domain-specific vocabulary from the candidate list (Tier 3-4)
5. **PRIORITIZE CANDIDATE LIST ITEMS** - these are pre-filtered "Golden Ticket" terms (especially table rows)
6. Continue extracting from the candidate list until you reach 100-150 terms
7. Do NOT stop at 30 terms - that is insufficient. Keep extracting until you have at least 100 terms
8. **DO NOT STOP AFTER THE FIRST PAGE** - continue through the entire candidate list`
  : `**⚡ FAST MODE EXTRACTION TARGET:**
- For a document with ${allSegments.length} segments, extract 20-50 high-quality terms.
- Maximum 50-100 terms - prioritize quality over quantity (Tier 1-2 terms preferred).
- Focus on the most frequent and highest-value terms only.`}

**VERIFICATION CHECKLIST (for each term):**
- [ ] Can I find this EXACT string in the Source Text using Ctrl+F? (MANDATORY - applies to both modes)
- [ ] Is this term NOT already in confirmed segments? (MANDATORY - applies to both modes)

${mode === 'deep' 
  ? `**DEEP MODE (Relaxed Criteria):**
- [ ] Is this a technical term, Proper Noun, Acronym, Defined Term, Job Title, Equipment, Metric, Process, Legal term, or domain-specific vocabulary? (Include if YES, even if borderline)
- [ ] Is this NOT a generic adjective+noun combination? (Relaxed - include if it appears in technical context)
- [ ] Is this NOT a grammatical artifact or table artifact? (Still apply, but be more lenient)

**Note:** In deep mode, if a term passes verbatim verification and appears to be domain-specific, include it even if it's borderline.`
  : `**FAST MODE (Strict Criteria - ALL must pass):**
- [ ] Is this a Proper Noun, Acronym, Defined Term, Job Title, Equipment, or Metric? (High-Value - Tier 1-2 only)
- [ ] Is this NOT a generic adjective+noun combination? (Strict enforcement)
- [ ] Is this NOT a grammatical artifact or table artifact? (Strict enforcement)`}

**OUTPUT FORMAT:**
Return JSON array: [{"sourceTerm": "string", "targetTerm": "string", "frequency": number, "category": "string"}]
- "sourceTerm": **MUST BE VERBATIM**. Extract the term EXACTLY as it appears in the text (keep Plural/Case). Do NOT normalize it yet. This is required to pass the verification check.
- "targetTerm": **ENGLISH TRANSLATION**. Translate the term to Nominative Singular English (e.g., "Leather boots...", "Protective suit...").
- "category" should be one of: "proper_noun", "acronym", "defined_term", "job_title", "equipment", "metric", "process", "legal", "technical", "other"
- Return ONLY the JSON array, no markdown code blocks, no additional text

${mode === 'deep' 
    ? `🚨 FINAL INSTRUCTION - CRITICAL:
I have prioritized the Candidate List above. The first ${promptCandidates.length} items are the most important (sorted by length, longest first).

**YOU MUST PROCESS ALL ${promptCandidates.length} CANDIDATES:**
- Start with candidate #1, then #2, then #3... continue through ALL ${promptCandidates.length} candidates
- For EACH candidate, check if it appears VERBATIM in the Source Text and extract it if valid
- The candidates are sorted by length (longest first) - these are the most valuable terms

**MANDATORY OUTPUT REQUIREMENTS:**
- Minimum: 50 terms extracted
- Target: 100-150 terms extracted
- Token Budget: You have 8192 output tokens - USE THEM! (Currently you're only using ~325 tokens - this is WRONG)
- Each term takes ~50-100 tokens - you can easily fit 50-150 terms

**BEFORE YOU FINISH:**
1. Count how many terms you've extracted (you should have 50+)
2. If you have fewer than 50 terms, you MUST continue extracting
3. **GO BACK TO THE CANDIDATE LIST** - keep extracting from it until you reach at least 50 terms
4. The target is 100-150 terms - aim for that number
5. Do NOT stop at 2, 3, 5, 10, or 20 terms - that is insufficient
6. You have ${promptCandidates.length} candidate terms in the CANDIDATE LIST - prioritize them to reach 50+ extracted terms
7. **PRIORITIZE CANDIDATE LIST ITEMS** - do not ignore them in favor of random text words
8. **FOCUS ON LONG DESCRIPTIONS** - the longest items in the candidate list are the most valuable (PPE items, job titles, equipment names)

**REMEMBER: You are a WORKER, not an explorer. Process ALL ${promptCandidates.length} candidates systematically.`
    : `**FINAL REMINDER: EXTRACT AT LEAST 40 TERMS (MINIMUM)**
**BEFORE YOU FINISH:**
1. Count how many terms you've extracted
2. If you have fewer than 40 terms, you MUST continue extracting
3. **GO BACK TO THE CANDIDATE LIST** - keep extracting from it until you reach at least 40 terms
4. **IF YOU SEE NUMBERED LISTS (1, 2, 3...), extract EVERY item in that list**
5. You have ${promptCandidates.length} candidate terms in the CANDIDATE LIST - prioritize them
6. **PRIORITIZE CANDIDATE LIST ITEMS** - do not ignore them in favor of random text words
7. **Do not stop after the first page. Process the ENTIRE provided text.**`}

**REMINDER:** Check the very end of the provided text for Tables/Annexes containing PPE and Equipment. These are High Priority.

Return a JSON array of terms that pass ALL checks above.`;

  // Stage 4 Validation: Log user prompt metrics (only if userPrompt was built)
  const userPromptHasVerbatim = userPrompt ? (userPrompt.includes('VERBATIM') || userPrompt.includes('verbatim')) : false;
  const userPromptHasTableRows = userPrompt ? (userPrompt.includes('table') || userPrompt.includes('Table') || userPrompt.includes('Annex')) : false;
  
  logger.info(
    {
      documentId,
      stage: 'Stage 4: AI Prompt Construction',
      mode,
      systemPromptLength: systemPrompt.length,
      userPromptLength: userPrompt ? userPrompt.length : 0,
      totalPromptLength: systemPrompt.length + (userPrompt ? userPrompt.length : 0),
      userPromptHasVerbatim,
      userPromptHasTableRows,
      termsToSendToAICount: termsToSendToAI.length,
      useParallelProcessing,
      chunksCount: chunks.length,
    },
    useParallelProcessing 
      ? 'Stage 4: Parallel batch processing mode - user prompt will be built per chunk'
      : 'Stage 4: User prompt construction complete',
  );
  
  // Add to execution logs (after userPrompt is defined)
  await addExecutionLog(documentId, {
    stage: 'Stage 4: AI Prompt Construction',
    level: 'info',
    message: useParallelProcessing
      ? `Parallel batch processing mode: ${chunks.length} chunks, System (${systemPrompt.length} chars). User prompts will be built per chunk.`
      : `Built prompts: System (${systemPrompt.length} chars), User (${userPrompt ? userPrompt.length : 0} chars). Domain: ${domain || 'none'}`,
    data: {
      mode,
      systemPromptLength: systemPrompt.length,
      userPromptLength: userPrompt ? userPrompt.length : 0,
      useParallelProcessing,
      chunksCount: chunks.length,
      hasTableRowInstructions,
      hasVerbatimInstructions,
      hasFragmentRepair,
      domain: domain || 'none',
    },
  });

  logger.info(
    {
      documentId,
      segmentsCount: document.segments.length,
      provider: provider.name,
      model,
      frequentTermsCount: rawCandidates.length,
    },
    'Calling AI for glossary term filtering and hunting',
  );

  // Log before AI call: number of candidates sent
  console.log('Sending to AI:', termsToSendToAI.length, 'candidates (filtered:', filteredFrequentTerms.length, 'raw:', rawCandidates.length, 'confirmed:', confirmedTermsMap.size, ')');

  // Validate input before calling AI
  if (filteredFrequentTerms.length === 0 && sourceTextForAI.trim().length < 100) {
    logger.warn(
      {
        documentId,
        filteredFrequentTermsCount: filteredFrequentTerms.length,
        sourceTextForAILength: sourceTextForAI.length,
      },
      'WARNING: Very few candidates and short text - AI may return empty results',
    );
  }

  // Call AI with retry logic for stability
  await updateProgress(documentId, 'ai_glossary', 30, `Calling ${provider.name} to filter and extract terms...`, true);
  let aiResponse: any;
  let responseText: string = '';
  const maxRetries = 2;
  let attempt = 0;
  
  // Calculate maxResponseTokens once (used in both main call and multi-pass)
  const maxResponseTokens = provider.name === 'openai' ? 16384 : 8192; // OpenAI supports 16k, others 8k
  
  while (attempt < maxRetries) {
    try {
      // Check for cancellation before each attempt
      if (isAnalysisCancelled(documentId)) {
        throw new Error('Analysis cancelled by user');
      }

      attempt++;
      logger.info(
        {
          documentId,
          attempt,
          maxRetries,
          filteredFrequentTermsCount: filteredFrequentTerms.length,
          termsToSendToAI: termsToSendToAI.length,
          sourceTextLength: sourceTextForAI.length,
        },
        `Calling AI for glossary extraction (attempt ${attempt}/${maxRetries})`,
      );

      // Update progress before AI call
      await updateProgress(
        documentId,
        'ai_glossary',
        35,
        `Calling ${provider.name} (${model}) - this may take 30-90 seconds...`,
        true,
      );

      // Add timeout wrapper for AI call (90 seconds max for large documents)
      const aiCallStartTime = Date.now();
      
      // PARALLEL BATCH PROCESSING: Process chunks in parallel (deep mode only)
      if (useParallelProcessing) {
        // Deep mode: Use Translation-First approach
        logger.info(
          {
            documentId,
            attempt,
            chunksCount: chunks.length,
            chunkSize: CHUNK_SIZE,
            totalCandidatesInChunks: topCandidates.length,
          },
          `[Stage 5] Starting Batch Extraction Processing: ${chunks.length} batches of ~${CHUNK_SIZE} items each`,
        );
        
        // Call executeDeepMode with proper extraction prompt (includes verbatim verification)
        // #region agent log
        fetch('http://127.0.0.1:7242/ingest/7f529324-455d-4ca1-81c1-cbc867a5b6ab',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'analysis.service.ts:2939',message:'Before executeDeepMode call',data:{attempt,topCandidatesCount:topCandidates.length,hasSystemPrompt:!!systemPrompt,systemPromptLength:systemPrompt?.length||0,hasAllSegments:!!allSegments,allSegmentsCount:allSegments?.length||0,sourceTextLength:sourceTextForAI.length},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'B'})}).catch(()=>{});
        // #endregion
        const allParsedTerms = await executeDeepMode(
          sourceTextForAI,
          topCandidates,
          documentId,
          provider,
          model,
          maxResponseTokens,
          systemPrompt,
          allSegments,
          samplingDescription,
          domain,
        );
        // #region agent log
        fetch('http://127.0.0.1:7242/ingest/7f529324-455d-4ca1-81c1-cbc867a5b6ab',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'analysis.service.ts:2951',message:'After executeDeepMode call',data:{attempt,allParsedTermsCount:allParsedTerms.length,termsSample:allParsedTerms.slice(0,3).map(t=>({sourceTerm:t.sourceTerm||t.term,hasSourceTerm:!!(t.sourceTerm||t.term)}))},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'B'})}).catch(()=>{});
        // #endregion
        
        // Create a merged response object
        responseText = JSON.stringify(allParsedTerms);
        aiResponse = {
          text: responseText,
          usage: {
            inputTokens: 0, // Will be calculated if needed
            outputTokens: 0, // Will be calculated if needed
          },
        };
        
        logger.info(
          {
            documentId,
            totalBatches: chunks.length,
            totalTermsExtracted: allParsedTerms.length,
            batchesProcessed: chunks.length,
          },
          `[Stage 5] Batch extraction processing completed: ${allParsedTerms.length} terms extracted from ${chunks.length} batches`,
        );
        
        await addExecutionLog(documentId, {
          stage: 'Stage 5: AI Response & Parsing',
          level: 'info',
          message: `Batch extraction processing completed: ${allParsedTerms.length} terms from ${chunks.length} batches`,
          data: {
            totalBatches: chunks.length,
            totalTermsExtracted: allParsedTerms.length,
            batchesProcessed: chunks.length,
          },
        });
      } else {
        // Fast mode or no chunks: Use single batch (original behavior)
      // Calculate approximate token count (rough estimate: 1 token ≈ 4 chars)
      const estimatedPromptTokens = Math.ceil((userPrompt.length + systemPrompt.length) / 4);
      
      // #region agent log
        fetch('http://127.0.0.1:7242/ingest/7f529324-455d-4ca1-81c1-cbc867a5b6ab',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'analysis.service.ts:815',message:'Before AI call for glossary (single batch)',data:{model,promptLength:userPrompt.length,systemPromptLength:systemPrompt.length,estimatedPromptTokens,requestedMaxTokens:maxResponseTokens},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'I'})}).catch(()=>{});
      // #endregion
      
      logger.info(
        {
          documentId,
          attempt,
          estimatedPromptTokens,
          maxResponseTokens,
          provider: provider.name,
        },
        `AI call parameters: ~${estimatedPromptTokens} prompt tokens, ${maxResponseTokens} max response tokens`,
      );
      
      // Ensure temperature is explicitly 0.0 for DeepSeek (especially reasoning models)
      const finalTemperature = 0.0;
      
      const aiCallPromise = provider.callModel({
        prompt: userPrompt,
        systemPrompt,
        model,
        temperature: finalTemperature,
        maxTokens: maxResponseTokens,
        segments: [],
      });

      // Increase timeout for reasoning models (DeepSeek R1 is slower)
      const isReasoning = isReasoningModel(provider.name, model);
      const baseTimeout = mode === 'deep' ? 240 : 180;
      const timeoutSeconds = isReasoning ? baseTimeout * 2 : baseTimeout; // Double timeout for reasoning models
      
      if (isReasoning) {
        logger.info(
          {
            documentId,
            provider: provider.name,
            model,
            timeoutSeconds,
            reason: 'Reasoning model detected - using extended timeout',
          },
          'Using extended timeout for reasoning model',
        );
      }
      
      // #region agent log
        fetch('http://127.0.0.1:7242/ingest/7f529324-455d-4ca1-81c1-cbc867a5b6ab',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'analysis.service.ts:1327',message:'Before AI call (single batch)',data:{mode,timeoutSeconds,termsToSendToAICount:termsToSendToAI.length,sourceTextLength:sourceTextForAI.length,estimatedPromptTokens,maxResponseTokens,providerName:provider?.name,providerType:typeof provider,hasProvider:!!provider,hasCallModel:!!provider?.callModel,model,hasModel:!!model},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'E'})}).catch(()=>{});
      // #endregion
      
      // Validate provider and model before making call
      if (!provider) {
        const errorMsg = 'Provider is null or undefined';
        logger.error({ documentId, attempt, provider }, errorMsg);
        throw new Error(errorMsg);
      }
      if (!provider.callModel) {
        const errorMsg = 'Provider.callModel is not a function';
        logger.error({ documentId, attempt, providerName: provider.name, providerType: typeof provider }, errorMsg);
        throw new Error(errorMsg);
      }
      if (!model) {
        const errorMsg = 'Model is null or undefined';
        logger.error({ documentId, attempt, model }, errorMsg);
        throw new Error(errorMsg);
      }
      
      const timeoutPromise = new Promise<never>((_, reject) => {
        setTimeout(() => {
          reject(new Error(`AI call timeout after ${timeoutSeconds} seconds (attempt ${attempt}/${maxRetries})`));
        }, timeoutSeconds * 1000);
      });

      // Cancellation promise - rejects if analysis is cancelled
      const cancellationPromise = new Promise<never>((_, reject) => {
        const checkCancellation = setInterval(() => {
          if (isAnalysisCancelled(documentId)) {
            clearInterval(checkCancellation);
            reject(new Error('Analysis cancelled by user'));
          }
        }, 1000); // Check every second
        
        // Clean up interval when promise resolves/rejects
        timeoutPromise.catch(() => clearInterval(checkCancellation));
        aiCallPromise.catch(() => clearInterval(checkCancellation));
      });

      logger.info(
        {
          documentId,
          attempt,
          model,
          provider: provider.name,
          promptLength: userPrompt.length,
          systemPromptLength: systemPrompt.length,
          termsToSendToAI: termsToSendToAI.length,
          sourceTextLength: sourceTextForAI.length,
          estimatedPromptTokens: Math.ceil((userPrompt.length + systemPrompt.length) / 4),
        },
        `Starting AI call for glossary extraction (with 120s timeout and cancellation check)`,
      );
      
      // CRITICAL: If estimated tokens are too high, warn and potentially fail early
      const estimatedTokens = Math.ceil((userPrompt.length + systemPrompt.length) / 4);
      if (estimatedTokens > 15000) {
        logger.error(
          {
            documentId,
            estimatedTokens,
            promptLength: userPrompt.length,
            systemPromptLength: systemPrompt.length,
            termsCount: termsToSendToAI.length,
            sourceTextLength: sourceTextForAI.length,
            maxAllowed: 15000,
          },
          'CRITICAL: Estimated prompt tokens exceed 15k limit - this will likely timeout or fail',
        );
        throw ApiError.badRequest(
          `Prompt too large (estimated ${estimatedTokens} tokens, max 15k). Please reduce document size or contact support.`,
        );
      }
      
      // Log if we're close to the limit
      if (estimatedTokens > 12000) {
        logger.warn(
          {
            documentId,
            estimatedTokens,
            termsCount: termsToSendToAI.length,
            sourceTextLength: sourceTextForAI.length,
          },
          'WARNING: Estimated prompt tokens are high (>12k) - close to 15k limit',
        );
      }

      // Start heartbeat progress updates during AI call
      let heartbeatInterval: NodeJS.Timeout | null = null;
      heartbeatInterval = setInterval(async () => {
        // Check for cancellation in heartbeat
        if (isAnalysisCancelled(documentId)) {
          if (heartbeatInterval) clearInterval(heartbeatInterval);
          return;
        }
        
        const elapsed = Date.now() - aiCallStartTime;
        const elapsedSeconds = Math.floor(elapsed / 1000);
        // Progress from 35% to 40% during AI call (5% range over timeout duration)
        const progress = 35 + Math.min(5, Math.floor((elapsed / (timeoutSeconds * 1000)) * 5));
        await updateProgress(
          documentId,
          'ai_glossary',
          progress,
          `Waiting for ${provider.name} response... (${elapsedSeconds}s elapsed)`,
          true,
        );
      }, 2000); // Update every 2 seconds for more frequent feedback

      try {
        // Race between AI call, timeout, and cancellation
        aiResponse = await Promise.race([aiCallPromise, timeoutPromise, cancellationPromise]) as any;
        clearInterval(heartbeatInterval); // Stop heartbeat when done
        const aiCallDuration = Date.now() - aiCallStartTime;
        
        // Final progress update after AI call completes
        await updateProgress(
          documentId,
          'ai_glossary',
          40,
          `Received response from ${provider.name} (${Math.floor(aiCallDuration / 1000)}s)`,
          true,
        );
        
        logger.info(
          {
            documentId,
            attempt,
            durationMs: aiCallDuration,
          },
          `AI call completed successfully`,
        );
          
          // Extract response text
          responseText = aiResponse.text || aiResponse.response || JSON.stringify(aiResponse);
      } catch (error: any) {
        if (heartbeatInterval) clearInterval(heartbeatInterval); // Stop heartbeat on error
        const aiCallDuration = Date.now() - aiCallStartTime;
        
        // #region agent log
        fetch('http://127.0.0.1:7242/ingest/7f529324-455d-4ca1-81c1-cbc867a5b6ab',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'analysis.service.ts:1503',message:'First AI call error caught',data:{attempt,maxRetries,errorMessage:error?.message,errorName:error?.name,errorStack:error?.stack,errorCode:error?.code,errorCause:error?.cause,aiCallDuration,providerName:provider?.name,model},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'F'})}).catch(()=>{});
        // #endregion
        
        // Stage 5: Enhanced crash logging
        const isTimeout = error.message?.includes('timeout') || 
                         error.message?.includes('Timeout') ||
                         error.name === 'TimeoutError' ||
                         aiCallDuration >= (timeoutSeconds * 1000 * 0.9); // Within 90% of timeout
        
        const errorContext = {
          documentId,
          stage: 'Stage 5: AI Response & Parsing',
          attempt,
          durationMs: aiCallDuration,
          timeoutSeconds,
          isTimeout,
          error: error.message,
          errorName: error.name,
          errorStack: error.stack,
          errorCode: error.code,
          errorCause: error.cause,
          provider: provider?.name,
          model,
          promptLength: userPrompt.length,
          systemPromptLength: systemPrompt.length,
          totalPromptLength: userPrompt.length + systemPrompt.length,
          estimatedTokens: Math.ceil((userPrompt.length + systemPrompt.length) / 4),
          termsCount: termsToSendToAI.length,
          sourceTextLength: sourceTextForAI.length,
        };
        
        // Log explicit Stage 5 error
        logger.error(
          errorContext,
          `[ERROR] Stage 5 AI Call Failed: ${error.message}`,
        );
        
        // Add to execution logs with explicit error message
        await addExecutionLog(documentId, {
          stage: 'Stage 5: AI Response & Parsing',
          level: 'error',
          message: `[ERROR] Stage 5 AI Call Failed: ${error.message}${isTimeout ? ' (Timeout - Payload too large?)' : ''}`,
          data: errorContext,
        }).catch(() => {}); // Ignore logging errors
        
        // If cancelled, throw cancellation error immediately
        if (error.message?.includes('cancelled')) {
          logger.info(
            {
              documentId,
              attempt,
              durationMs: aiCallDuration,
            },
            `AI call cancelled by user`,
          );
          throw error;
        }
        
        // Log specific timeout warning
        if (isTimeout) {
        logger.error(
          {
              ...errorContext,
              warning: 'Payload too large?',
            },
            `[ERROR] Stage 5 AI Call Failed: Timeout detected. Payload too large? (${userPrompt.length + systemPrompt.length} chars, ~${Math.ceil((userPrompt.length + systemPrompt.length) / 4)} tokens)`,
          );
        }
        
        throw error;
      }

        // Extract response text
        responseText = aiResponse.text || aiResponse.response || aiResponse.outputText || JSON.stringify(aiResponse);
        responseText = responseText.trim();
      
      // #region agent log
      fetch('http://127.0.0.1:7242/ingest/7f529324-455d-4ca1-81c1-cbc867a5b6ab',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'analysis.service.ts:1477',message:'AI response received',data:{mode,responseTextLength:responseText.length,responsePreview:responseText.substring(0,500),usage:aiResponse.usage},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'E'})}).catch(()=>{});
      // #endregion
      
      // Check if response was truncated
      const wasTruncated = aiResponse.finishReason === 'length' || 
                          (aiResponse.usage?.completionTokens && 
                           aiResponse.usage.completionTokens >= (provider.name === 'openai' ? 16384 : 8192) * 0.95);
      
      if (wasTruncated) {
        logger.warn(
          {
            documentId,
            attempt,
            finishReason: aiResponse.finishReason,
            responseLength: responseText.length,
            completionTokens: aiResponse.usage?.completionTokens,
            maxTokens: provider.name === 'openai' ? 16384 : 8192,
          },
          'WARNING: AI response was truncated due to token limit - some terms may be missing',
        );
      }

      // Log after AI call: raw response
        // #region agent log
        fetch('http://127.0.0.1:7242/ingest/7f529324-455d-4ca1-81c1-cbc867a5b6ab',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'analysis.service.ts:910',message:'After AI call for glossary',data:{responseLength:responseText.length,usage:aiResponse.usage,thoughtsTokenCount:aiResponse.usage?.thoughtsTokenCount,actualOutputTokens:aiResponse.usage?.candidatesTokenCount,requestedMaxTokens:provider.name === 'openai' ? 16384 : 8192,wasTruncated},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'I'})}).catch(()=>{});
        // #endregion
        
        logger.info(
          {
            documentId,
            attempt,
            responseLength: responseText.length,
            responsePreview: responseText.substring(0, 200),
          },
          `AI Raw Output received (attempt ${attempt})`,
        );
        console.log(`AI Raw Output (attempt ${attempt}):`, responseText);
      
      // Validate response is not empty
      if (!responseText || responseText.length < 10) {
        throw new Error('AI returned empty or very short response');
      }
      
      // Immediate progress update after receiving response
      await updateProgress(
        documentId,
        'parsing_glossary',
        42,
        'Received AI response, starting to parse...',
        true,
      );
      
      // If we got a response, break out of retry loop
      break;
      }
    } catch (error: any) {
      logger.error(
        {
          documentId,
          attempt,
          maxRetries,
          error: error.message,
        },
        `AI call failed (attempt ${attempt}/${maxRetries})`,
      );

      // Don't retry for these errors - they won't succeed on retry
      if (error.message?.includes('API key not valid') || error.message?.includes('API_KEY_INVALID')) {
        throw ApiError.badRequest(
          `Invalid ${provider.name} API key. Please check your AI settings.`,
        );
      }
      if (error.message?.includes('quota') || error.message?.includes('rate limit')) {
        throw ApiError.badRequest(
          `API quota or rate limit exceeded. Please try again later.`,
        );
      }

      if (attempt >= maxRetries) {
        // Last attempt failed - rethrow with better error message
        throw ApiError.badRequest(
          `Failed to extract glossary after ${maxRetries} attempts: ${error.message || 'Unknown error occurred'}.`,
        );
      }
      
      // Wait a bit before retry
      await new Promise((resolve) => setTimeout(resolve, 1000 * attempt));
    }
  }

  // Log the final response
  logger.debug(
    {
      documentId,
      responseLength: responseText.length,
      rawResponse: responseText,
    },
    'RAW AI RESPONSE received for glossary extraction',
  );

  // Step 5: Parse AI response to get terms with frequencies
  // Stage 5: AI Response & Parsing
  await updateProgress(documentId, 'parsing_glossary', 43, 'Parsing AI response and extracting terms...', true);
  let aiTerms: Array<{ term: string; frequency: number }> = [];
  let parsedArrayLength = 0;
  
  // Stage 5: Log raw response for debugging
  logger.info(
    {
      documentId,
      stage: 'Stage 5: AI Response & Parsing',
      responseLength: responseText.length,
      responsePreview: responseText.substring(0, 300),
      sourceTextForAILength: sourceTextForAI.length,
    },
    'Stage 5: Received AI response, starting parsing',
  );
  
  // Add to execution logs
  await addExecutionLog(documentId, {
    stage: 'Stage 5: AI Response & Parsing',
    level: 'info',
    message: `Received AI response: ${responseText.length} chars`,
    data: {
      responseLength: responseText.length,
      responsePreview: responseText.substring(0, 200),
    },
  });
  
  try {
    // Clean markdown code blocks before parsing
    await updateProgress(documentId, 'parsing_glossary', 44, 'Cleaning JSON response...', true);
    const cleanedResponse = cleanJsonOutput(responseText);
    const wasCleaned = responseText !== cleanedResponse;
    
    logger.info(
      {
        documentId,
        stage: 'Stage 5: AI Response & Parsing',
        originalLength: responseText.length,
        cleanedLength: cleanedResponse.length,
        wasCleaned,
      },
      'Stage 5: Cleaned JSON output from markdown code blocks',
    );

    await updateProgress(documentId, 'parsing_glossary', 45, 'Parsing JSON array...', true);
    const parsed = parseJsonArray(cleanedResponse, documentId);
    parsedArrayLength = parsed.length;
    
    logger.info(
      {
        documentId,
        stage: 'Stage 5: AI Response & Parsing',
        parsedArrayLength,
        parsedSample: parsed.slice(0, 3),
      },
      'Stage 5: Parsed JSON array successfully',
    );
    
    // Add to execution logs
    await addExecutionLog(documentId, {
      stage: 'Stage 5: AI Response & Parsing',
      level: 'info',
      message: `Parsed ${parsedArrayLength} terms from AI response`,
      data: {
        parsedArrayLength,
        parsedSample: parsed.slice(0, 5).map((p: any) => ({
          sourceTerm: (p.sourceTerm || p.term || 'N/A').substring(0, 50),
          hasTargetTerm: !!(p.targetTerm),
        })),
      },
    });

    // #region agent log
    fetch('http://127.0.0.1:7242/ingest/7f529324-455d-4ca1-81c1-cbc867a5b6ab',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'analysis.service.ts:1018',message:'Parsed JSON array from AI',data:{parsedArrayLength,responseLength:responseText.length},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'J'})}).catch(()=>{});
    // #endregion

    await updateProgress(documentId, 'parsing_glossary', 46, `Parsed ${parsedArrayLength} items, validating...`, true);

    // Stage 5: Enhanced validation with detailed logging
    if (parsedArrayLength === 0) {
      logger.error(
        {
          documentId,
          stage: 'Stage 5: AI Response & Parsing',
          cleanedResponseLength: cleanedResponse.length,
          cleanedResponsePreview: cleanedResponse.substring(0, 1000),
          originalResponseLength: responseText.length,
          originalResponsePreview: responseText.substring(0, 1000),
          sourceTextForAILength: sourceTextForAI.length,
          domain: domain || 'General',
        },
        'Stage 5: CRITICAL - Parsed array is empty - AI may have returned empty array or parsing failed',
      );
      
      // If parsing failed but we have source text, this is a critical issue
      if (sourceTextForAI.trim().length > 100) {
        logger.error(
          {
            documentId,
            sourceTextForAILength: sourceTextForAI.length,
            message: 'AI returned empty array despite substantial source text - this indicates a prompt or API issue',
          },
          'CRITICAL: Empty extraction result for document with content',
        );
      }
    } else {
      logger.info(
        {
          documentId,
          stage: 'Stage 5: AI Response & Parsing',
          parsedArrayLength,
          sampleTerms: parsed.slice(0, 5).map((p: any) => ({
            sourceTerm: (p.sourceTerm || p.term || 'N/A').substring(0, 50),
            hasTargetTerm: !!(p.targetTerm),
            frequency: p.frequency || 1,
          })),
          domain: domain || 'General',
        },
        'Stage 5: Successfully parsed terms from AI response',
      );
    }

    // Stage 5: Validate and normalize AI response format: [{"sourceTerm": "...", "targetTerm": "...", "frequency": number, "category": "string"}]
    // Also supports legacy format: [{"term": "...", "frequency": number}]
    let validCount = 0;
    let invalidCount = 0;
    let hallucinationCount = 0;
    const invalidReasons: Record<string, number> = {
      notObject: 0,
      emptyTerm: 0,
      missingFields: 0,
    };
    
    // ===================================================================
    // VERBATIM SAFETY NET: Final firewall against hallucinations
    // Get full source text for verbatim verification (case-insensitive)
    // In deep mode, use FULL document text (including confirmed segments) for more lenient checking
    // ===================================================================
    // For deep mode, include confirmed segments to be more lenient (terms might appear there)
    // For fast mode, only check sourceTextForAI (stricter)
    // Store in a variable accessible to multi-pass logic
    const fullSourceText = mode === 'deep' 
      ? document.segments.map(s => s.sourceText).join(' ').toLowerCase()
      : sourceTextForAI.toLowerCase();
    
    // #region agent log
    fetch('http://127.0.0.1:7242/ingest/7f529324-455d-4ca1-81c1-cbc867a5b6ab',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'analysis.service.ts:1660',message:'Before verbatim safety net',data:{mode,parsedArrayLength,fullSourceTextLength:fullSourceText.length,sourceTextForAILength:sourceTextForAI.length},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'D'})}).catch(()=>{});
    // #endregion
    
    aiTerms = parsed
      .map((item: any, index: number) => {
        if (!item || typeof item !== 'object') {
          invalidCount++;
          invalidReasons.notObject++;
          logger.debug({ documentId, stage: 'Stage 5', index, item }, 'Skipping invalid item (not an object)');
          return null;
        }
        
        const term = String(item.sourceTerm || item.term || '').trim();
        const frequency = typeof item.frequency === 'number' ? item.frequency : 1;
        
        // Stage 5: Validate required fields
        const hasSourceTerm = !!(item.sourceTerm || item.term);
        const hasTargetTerm = !!item.targetTerm;
        
        if (!term) {
          invalidCount++;
          invalidReasons.emptyTerm++;
          logger.debug({ documentId, stage: 'Stage 5', index, item }, 'Skipping item with empty term');
          return null;
        }
        
        if (!hasSourceTerm) {
          invalidCount++;
          invalidReasons.missingFields++;
        }
        
        // ===================================================================
        // VERBATIM SAFETY NET: Code-Level Rule
        // If term doesn't exist verbatim in source text, DROP it silently
        // More lenient: normalize whitespace and punctuation for matching
        // ===================================================================
        const termLower = term.toLowerCase().trim();
        // Normalize whitespace (multiple spaces to single space) for both term and source
        const normalizedTerm = termLower.replace(/\s+/g, ' ');
        const normalizedSource = fullSourceText.replace(/\s+/g, ' ');
        
        // Check for exact match (after normalization)
        const foundExact = normalizedSource.includes(normalizedTerm);
        
        // Also check for word-boundary match (handles punctuation differences)
        // This allows "term" to match "term." or "term," or "(term)"
        const wordBoundaryPattern = new RegExp(`\\b${normalizedTerm.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
        const foundWordBoundary = wordBoundaryPattern.test(normalizedSource);
        
        // In deep mode, also check for partial matches (if term is 2+ words, check if all words appear)
        let foundPartial = false;
        if (mode === 'deep' && !foundExact && !foundWordBoundary) {
          const termWords = normalizedTerm.split(/\s+/).filter(w => w.length > 2); // Filter out very short words
          if (termWords.length >= 2) {
            // For multi-word terms (2+ words), check if all significant words appear in source (more lenient)
            // This helps catch terms that might have slight punctuation or case differences
            const allWordsFound = termWords.every(word => {
              // Check if word appears as a whole word (not just as substring)
              // Use a more lenient pattern that handles Cyrillic and punctuation
              const escapedWord = word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
              // Try word boundary first
              const wordPattern = new RegExp(`\\b${escapedWord}\\b`, 'i');
              if (wordPattern.test(normalizedSource)) return true;
              // Also try without word boundary (in case of punctuation issues)
              return normalizedSource.includes(word);
            });
            foundPartial = allWordsFound;
          }
        }
        
        // Stage 6: Verbatim Verification - Log rejection details
        if (!foundExact && !foundWordBoundary && !foundPartial) {
          hallucinationCount++;
          
          // #region agent log
          fetch('http://127.0.0.1:7242/ingest/7f529324-455d-4ca1-81c1-cbc867a5b6ab',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'analysis.service.ts:1725',message:'VERBATIM SAFETY NET: Dropping term',data:{mode,term,normalizedTerm,index,foundExact,foundWordBoundary,foundPartial,termLength:term.length,wordCount:term.split(' ').length},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'D'})}).catch(()=>{});
          // #endregion
          
          logger.warn(
            {
              documentId,
              stage: 'Stage 6: Verbatim Verification',
              term,
              normalizedTerm,
              index,
              mode,
              foundExact,
              foundWordBoundary,
              foundPartial,
              reason: 'Term not found verbatim in source text (hallucination detected)',
              sourceTextSnippet: normalizedSource.substring(0, 200),
              termLength: term.length,
              wordCount: term.split(' ').length,
            },
            'Stage 6: VERBATIM SAFETY NET - Dropping hallucinated term',
          );
          return null; // Silently drop the term
        }
        
        validCount++;
        // Note: targetTerm from AI response is optional - waterfall lookup will handle translation
        const suggestedTargetTerm = item.targetTerm ? String(item.targetTerm).trim() : undefined;
        
        // #region agent log
        if (suggestedTargetTerm) {
          fetch('http://127.0.0.1:7242/ingest/7f529324-455d-4ca1-81c1-cbc867a5b6ab',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'analysis.service.ts:1024',message:'Parsed targetTerm from AI response',data:{term,suggestedTargetTerm,suggestedTargetTermLength:suggestedTargetTerm.length,rawTargetTerm:item.targetTerm,rawTargetTermLength:String(item.targetTerm).length},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'E'})}).catch(()=>{});
        }
        // #endregion
        
        return { term, frequency, suggestedTargetTerm };
      })
      .filter((item): item is { term: string; frequency: number; suggestedTargetTerm?: string | undefined } => item !== null);
    
    // Stage 6: Log verbatim safety net results
    const verificationPassRate = parsedArrayLength > 0 ? (((parsedArrayLength - hallucinationCount) / parsedArrayLength) * 100).toFixed(1) : '0.0';
    
    if (hallucinationCount > 0) {
      logger.warn(
        {
          documentId,
          stage: 'Stage 6: Verbatim Verification',
          hallucinationCount,
          validCount,
          totalParsed: parsedArrayLength,
          verificationPassRate: `${verificationPassRate}%`,
          rejectionRate: `${((hallucinationCount / parsedArrayLength) * 100).toFixed(1)}%`,
        },
        `Stage 6: VERBATIM SAFETY NET - Dropped ${hallucinationCount} hallucinated term(s) that did not appear verbatim in source text`,
      );
      
      // Add to execution logs
      await addExecutionLog(documentId, {
        stage: 'Stage 6: Verbatim Verification',
        level: 'warn',
        message: `Verbatim check: Dropped ${hallucinationCount} hallucinated terms. ${validCount} terms verified (${verificationPassRate}% pass rate)`,
        data: {
          hallucinationCount,
          validCount,
          totalParsed: parsedArrayLength,
          verificationPassRate: `${verificationPassRate}%`,
        },
      });
    } else {
      logger.info(
        {
          documentId,
          stage: 'Stage 6: Verbatim Verification',
          verifiedCount: validCount,
          totalParsed: parsedArrayLength,
          verificationPassRate: `${verificationPassRate}%`,
        },
        'Stage 6: All terms passed verbatim verification',
      );
      
      // Add to execution logs
      await addExecutionLog(documentId, {
        stage: 'Stage 6: Verbatim Verification',
        level: 'info',
        message: `All ${validCount} terms passed verbatim verification (${verificationPassRate}% pass rate)`,
        data: {
          verifiedCount: validCount,
          totalParsed: parsedArrayLength,
          verificationPassRate: `${verificationPassRate}%`,
        },
      });
    }
    
    // Stage 6 Validation: Warn if > 30% terms rejected
    const rejectionRate = parsedArrayLength > 0 ? (hallucinationCount / parsedArrayLength * 100) : 0;
    if (rejectionRate > 30) {
      logger.warn(
        {
          documentId,
          stage: 'Stage 6: Verbatim Verification',
          warning: `High rejection rate: ${rejectionRate.toFixed(1)}% of terms rejected`,
          rejectionRate: `${rejectionRate.toFixed(1)}%`,
          hallucinationCount,
          totalParsed: parsedArrayLength,
          mode,
        },
        'Stage 6: WARNING - High verbatim rejection rate',
      );
    }

    // #region agent log
    fetch('http://127.0.0.1:7242/ingest/7f529324-455d-4ca1-81c1-cbc867a5b6ab',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'analysis.service.ts:1028',message:'After validation',data:{parsedArrayLength,validCount:aiTerms.length,invalidCount},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'J'})}).catch(()=>{});
    // #endregion

    // Stage 5: Log validation results (including verbatim safety net)
    const expectedMinTerms = mode === 'deep' ? 80 : 20;
    const isLowTermCount = aiTerms.length < expectedMinTerms;
    const parsingSuccessRate = parsedArrayLength > 0 ? ((validCount / parsedArrayLength) * 100).toFixed(1) : '0.0';
    
    if (isLowTermCount) {
      logger.warn(
        {
          documentId,
          stage: 'Stage 5: AI Response & Parsing',
          mode,
          parsedArrayLength,
          validItemsCount: validCount,
          invalidItemsCount: invalidCount,
          hallucinationCount,
          finalAiTermsCount: aiTerms.length,
          expectedMinTerms,
          candidatesSentToAI: termsToSendToAI.length,
          parsingSuccessRate: `${parsingSuccessRate}%`,
          invalidReasons,
          domain: domain || 'General',
          warning: `AI returned only ${aiTerms.length} terms, expected at least ${expectedMinTerms} in ${mode} mode`,
        },
        'Stage 5: AI response validation - LOW TERM COUNT WARNING',
      );
    } else {
      logger.info(
        {
          documentId,
          stage: 'Stage 5: AI Response & Parsing',
          mode,
          parsedArrayLength,
          validItemsCount: validCount,
          invalidItemsCount: invalidCount,
          hallucinationCount,
          finalAiTermsCount: aiTerms.length,
          expectedMinTerms,
          candidatesSentToAI: termsToSendToAI.length,
          parsingSuccessRate: `${parsingSuccessRate}%`,
          invalidReasons,
          domain: domain || 'General',
        },
        'Stage 5: AI response validation complete (with verbatim safety net)',
      );
    }

    // Progress update after validation
    await updateProgress(
      documentId,
      'parsing_glossary',
      48,
      `Validated ${aiTerms.length} terms from AI response`,
      true,
    );

    // Log after parsing: first 3 items
    console.log('Parsed Terms (First 3):', JSON.stringify(aiTerms.slice(0, 3), null, 2));

      // #region agent log
      fetch('http://127.0.0.1:7242/ingest/7f529324-455d-4ca1-81c1-cbc867a5b6ab',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'analysis.service.ts:2055',message:'Parsed AI response for glossary terms',data:{parsedArrayLength,aiTermsCount:aiTerms.length,sampleTerms:aiTerms.slice(0,10).map(t=>({sourceTerm:t.term.substring(0,60),frequency:t.frequency})),hasInstrumentalCase:aiTerms.some(t=>t.term.includes('ым')||t.term.includes('ом')||t.term.includes('ем')||t.term.includes('ами')),instrumentalCaseTerms:aiTerms.filter(t=>t.term.includes('ым')||t.term.includes('ом')||t.term.includes('ем')||t.term.includes('ами')).slice(0,5).map(t=>t.term)},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'G'})}).catch(()=>{});
      // #endregion
      
      logger.info(
        {
          documentId,
          parsedArrayLength,
          aiTermsCount: aiTerms.length,
          sampleTerms: aiTerms.slice(0, 5),
        },
        'Parsed AI response for glossary terms',
      );
  } catch (error: any) {
    logger.error(
      {
        documentId,
        error: error.message,
        errorStack: error.stack,
        responsePreview: responseText.substring(0, 500),
      },
      'Failed to parse AI response as JSON (glossary)',
    );
    throw ApiError.badRequest(`Failed to parse glossary extraction response: ${error.message}`);
  }

  // CRITICAL: Enhanced validation - throw error if no terms extracted for large documents
  if (aiTerms.length === 0) {
    // If we have confirmed terms, continue with those (this is acceptable)
    if (confirmedTermsMap.size > 0) {
      logger.info(
        {
          documentId,
          confirmedTermsCount: confirmedTermsMap.size,
        },
        'AI extraction returned 0 terms, but confirmed terms exist - continuing with confirmed terms only',
      );
      // Continue with confirmed terms only - they will be processed in Step 3
    } else {
      // No confirmed terms AND no AI terms - this is a failure for documents with substantial content
      const totalSegments = document.segments.length;
      if (totalSegments > 10 || remainingSegments.length > 10) {
        // Large document with no terms = failure
        logger.error(
          {
            documentId,
            totalSegments,
            remainingSegmentsCount: remainingSegments.length,
            parsedArrayLength,
            responseTextLength: responseText.length,
            responsePreview: responseText.substring(0, 1000),
          },
          'CRITICAL: No terms extracted from AI for document with substantial content - this indicates an error',
        );
        
        throw ApiError.badRequest(
          `Glossary extraction failed: AI returned no terms for a document with ${totalSegments} segments. ` +
          `This may indicate an API error, rate limit, or parsing issue. Please check the logs and try again.`,
        );
      } else {
        // Very small document - might legitimately have no terms
        logger.warn(
          {
            documentId,
            totalSegments,
            remainingSegmentsCount: remainingSegments.length,
          },
          'No terms extracted, but document is very small - this may be acceptable',
        );
        // Continue - will return 0 count which is acceptable for tiny documents
      }
    }
  } else if (aiTerms.length < 10 && remainingSegments.length > 100) {
    // Warning: Very few terms for a large document
    logger.warn(
      {
        documentId,
        aiTermsCount: aiTerms.length,
        remainingSegmentsCount: remainingSegments.length,
        parsedArrayLength,
        responseTextLength: responseText.length,
      },
      'WARNING: Very few terms extracted from AI for a large document - may indicate parsing or AI issues',
    );
  }
  
  // MULTI-PASS EXTRACTION FOR DEEP MODE: If first pass returned too few terms, make additional passes
  // Get fullSourceText for verbatim checking in additional passes (same logic as before)
  const fullSourceTextForMultiPass = mode === 'deep' 
    ? document.segments.map(s => s.sourceText).join(' ').toLowerCase()
    : sourceTextForAI.toLowerCase();
  
  // #region agent log
  fetch('http://127.0.0.1:7242/ingest/7f529324-455d-4ca1-81c1-cbc867a5b6ab',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'analysis.service.ts:1975',message:'Checking multi-pass condition',data:{mode,aiTermsLength:aiTerms.length,targetTerms:100,termsToSendToAILength:termsToSendToAI.length,condition1:mode === 'deep',condition2:aiTerms.length < 100,condition3:termsToSendToAI.length > aiTerms.length * 2,willTrigger:mode === 'deep' && aiTerms.length < 100 && termsToSendToAI.length > aiTerms.length * 2},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'C'})}).catch(()=>{});
  // #endregion
  
  // #region agent log
  fetch('http://127.0.0.1:7242/ingest/7f529324-455d-4ca1-81c1-cbc867a5b6ab',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'analysis.service.ts:1979',message:'Multi-pass check',data:{mode,aiTermsLength:aiTerms.length,targetTerms:100,termsToSendToAILength:termsToSendToAI?.length || 0,conditionCheck:mode === 'deep' && aiTerms.length < 100 && (termsToSendToAI?.length || 0) > aiTerms.length * 2},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'C'})}).catch(()=>{});
  // #endregion
  
  if (mode === 'deep' && aiTerms.length < 100 && termsToSendToAI && termsToSendToAI.length > aiTerms.length * 2) {
    // #region agent log
    fetch('http://127.0.0.1:7242/ingest/7f529324-455d-4ca1-81c1-cbc867a5b6ab',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'analysis.service.ts:1984',message:'Multi-pass triggered',data:{mode,aiTermsLength:aiTerms.length,targetTerms:100,termsToSendToAILength:termsToSendToAI.length},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'C'})}).catch(()=>{});
    // #endregion
    
    logger.info(
      {
        documentId,
        firstPassTerms: aiTerms.length,
        targetTerms: 100,
        remainingCandidates: termsToSendToAI.length,
      },
      'Deep mode: First pass returned too few terms, attempting additional passes to reach 100 terms',
    );
    
    // Track already extracted terms to avoid duplicates
    const extractedTermsSet = new Set(aiTerms.map(t => t.term.toLowerCase()));
    
    // Get remaining candidates (exclude already extracted terms)
    const remainingCandidates = termsToSendToAI.filter(term => !extractedTermsSet.has(term.toLowerCase()));
    
    // #region agent log
    fetch('http://127.0.0.1:7242/ingest/7f529324-455d-4ca1-81c1-cbc867a5b6ab',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'analysis.service.ts:2008',message:'Multi-pass setup',data:{mode,aiTermsLength:aiTerms.length,targetTerms:100,remainingCandidatesLength:remainingCandidates.length,extractedTermsSetSize:extractedTermsSet.size},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'C'})}).catch(()=>{});
    // #endregion
    
    // Make additional passes until we reach 100 terms or run out of candidates
    let passNumber = 2;
    const maxPasses = 5; // Limit to 5 passes to avoid infinite loops
    const targetTerms = 100;
    
    // #region agent log
    fetch('http://127.0.0.1:7242/ingest/7f529324-455d-4ca1-81c1-cbc867a5b6ab',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'analysis.service.ts:2014',message:'Before while loop',data:{mode,aiTermsLength:aiTerms.length,targetTerms,remainingCandidatesLength:remainingCandidates.length,passNumber,maxPasses,willEnterLoop:aiTerms.length < targetTerms && remainingCandidates.length > 0 && passNumber <= maxPasses},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'C'})}).catch(()=>{});
    // #endregion
    
    while (aiTerms.length < targetTerms && remainingCandidates.length > 0 && passNumber <= maxPasses) {
      // #region agent log
      fetch('http://127.0.0.1:7242/ingest/7f529324-455d-4ca1-81c1-cbc867a5b6ab',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'analysis.service.ts:2020',message:'Inside while loop',data:{mode,passNumber,aiTermsLength:aiTerms.length,targetTerms,remainingCandidatesLength:remainingCandidates.length},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'C'})}).catch(()=>{});
      // #endregion
      // Take next batch of candidates (200 per pass)
      const batchSize = 200;
      const batchCandidates = remainingCandidates.slice(0, batchSize);
      const batchRemaining = remainingCandidates.slice(batchSize);
      
      if (batchCandidates.length === 0) break;
      
      logger.info(
        {
          documentId,
          passNumber,
          currentTerms: aiTerms.length,
          targetTerms,
          batchCandidates: batchCandidates.length,
          remainingAfterBatch: batchRemaining.length,
        },
        `Deep mode: Starting pass ${passNumber} with ${batchCandidates.length} candidates`,
      );
      
      // Build a simpler prompt for additional passes (focus on extraction, less explanation)
      const additionalPassPrompt = `🚨 CRITICAL: OUTPUT MUST BE RAW JSON ONLY.
1. DO NOT output "Thinking...", "THINK:", "Here is...", or any explanation.
2. DISABLE "Chain of Thought" logging. Just return the JSON array.
3. NO EXPLANATIONS, NO REASONING, NO METADATA. ONLY THE JSON ARRAY.

🚨🚨🚨 CONTINUE EXTRACTING TERMS 🚨🚨🚨

You already extracted ${aiTerms.length} terms. You need to extract MORE terms to reach at least 100 total terms.

Source Text (same as before):
${sourceTextForAI.substring(0, 15000)}${sourceTextForAI.length > 15000 ? '\n...(truncated for additional pass)...' : ''}

Additional Candidate Terms (${batchCandidates.length} candidates):
${batchCandidates.join('\n')}

**INSTRUCTIONS:**
1. Extract terms from the candidate list above that appear VERBATIM in the source text
2. Do NOT extract terms you already extracted in previous passes
3. Extract at least ${Math.max(20, targetTerms - aiTerms.length)} more terms to help reach the target of 100 terms
4. Return JSON array: [{"sourceTerm": "string", "targetTerm": "string", "frequency": number, "category": "string"}]
5. Return ONLY the JSON array, no markdown code blocks, no explanations, no "THINK:" text

**VERBATIM VERIFICATION:** Every term MUST appear exactly in the source text above.`;

      try {
        await updateProgress(
          documentId,
          'ai_glossary',
          40 + (passNumber * 2),
          `Additional extraction pass ${passNumber}/${maxPasses}...`,
          true,
        );
        
        // #region agent log
        fetch('http://127.0.0.1:7242/ingest/7f529324-455d-4ca1-81c1-cbc867a5b6ab',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'analysis.service.ts:2070',message:'Before additional pass AI call',data:{passNumber,providerName:provider?.name,providerType:typeof provider,hasProvider:!!provider,hasCallModel:!!provider?.callModel,model,hasModel:!!model,maxResponseTokens,batchCandidatesLength:batchCandidates.length,additionalPassPromptLength:additionalPassPrompt.length},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'C'})}).catch(()=>{});
        // #endregion
        
        if (!provider) {
          logger.error(
            {
              documentId,
              passNumber,
              hasProvider: false,
            },
            'Multi-pass: provider is null or undefined',
          );
          break;
        }
        if (!provider.callModel) {
          logger.error(
            {
              documentId,
              passNumber,
              providerName: provider.name,
              providerType: typeof provider,
              hasCallModel: false,
            },
            'Multi-pass: provider.callModel is not a function',
          );
          break;
        }
        if (!model) {
          logger.error(
            {
              documentId,
              passNumber,
              hasModel: false,
            },
            'Multi-pass: model is null or undefined',
          );
          break;
        }
        
        const additionalResponse = await provider.callModel({
          prompt: additionalPassPrompt,
          systemPrompt: `You are extracting domain-specific terminology. Extract terms that appear VERBATIM in the source text. Return JSON array only.`,
          model,
          temperature: 0,
          maxTokens: maxResponseTokens,
          segments: [],
        });
        
        if (!additionalResponse || !additionalResponse.outputText) {
          logger.warn(
            {
              documentId,
              passNumber,
              hasResponse: !!additionalResponse,
              hasOutputText: !!additionalResponse?.outputText,
            },
            `Multi-pass: Pass ${passNumber} returned invalid response`,
          );
          break;
        }
        
        const additionalResponseText = additionalResponse.outputText.trim();
        if (!additionalResponseText || additionalResponseText.length < 10) {
          logger.warn(
            {
              documentId,
              passNumber,
              responseLength: additionalResponseText.length,
            },
            `Multi-pass: Pass ${passNumber} returned empty or very short response`,
          );
          break;
        }
        
        const cleanedAdditional = cleanJsonOutput(additionalResponseText);
        let parsedAdditional: any[] = [];
        
        try {
          parsedAdditional = parseJsonArray(cleanedAdditional, documentId);
        } catch (parseError: any) {
          // #region agent log
          fetch('http://127.0.0.1:7242/ingest/7f529324-455d-4ca1-81c1-cbc867a5b6ab',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'analysis.service.ts:2283',message:'Multi-pass JSON parse failed, continuing',data:{passNumber,errorMessage:parseError?.message,responsePreview:additionalResponseText.substring(0,500),responseLength:additionalResponseText.length},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'C'})}).catch(()=>{});
          // #endregion
          logger.warn(
            {
              documentId,
              passNumber,
              error: parseError?.message,
              responsePreview: additionalResponseText.substring(0, 500),
            },
            `Multi-pass: Pass ${passNumber} failed to parse JSON, continuing to next pass`,
          );
          // Continue to next pass instead of breaking
          remainingCandidates.splice(0, batchSize);
          passNumber++;
          continue;
        }
        
        // #region agent log
        fetch('http://127.0.0.1:7242/ingest/7f529324-455d-4ca1-81c1-cbc867a5b6ab',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'analysis.service.ts:2115',message:'Additional pass response parsed',data:{passNumber,responseLength:additionalResponseText.length,parsedCount:parsedAdditional.length},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'C'})}).catch(()=>{});
        // #endregion
        
        // Filter out duplicates and apply verbatim safety net
        const newTerms = parsedAdditional
          .map((item: any) => {
            if (!item || typeof item !== 'object') return null;
            const term = String(item.sourceTerm || item.term || '').trim();
            if (!term) return null;
            
            // Skip if already extracted
            if (extractedTermsSet.has(term.toLowerCase())) return null;
            
            // Apply verbatim check
            const termLower = term.toLowerCase().trim();
            const normalizedTerm = termLower.replace(/\s+/g, ' ');
            const normalizedSource = fullSourceTextForMultiPass.replace(/\s+/g, ' ');
            const foundExact = normalizedSource.includes(normalizedTerm);
            const wordBoundaryPattern = new RegExp(`\\b${normalizedTerm.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
            const foundWordBoundary = wordBoundaryPattern.test(normalizedSource);
            
            // Partial match for long terms (3+ words) in deep mode
            let foundPartial = false;
            if (mode === 'deep' && !foundExact && !foundWordBoundary) {
              const termWords = normalizedTerm.split(/\s+/).filter(w => w.length > 2);
              if (termWords.length >= 3) {
                foundPartial = termWords.every(word => {
                  const wordPattern = new RegExp(`\\b${word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
                  return wordPattern.test(normalizedSource);
                });
              }
            }
            
            if (!foundExact && !foundWordBoundary && !foundPartial) return null;
            
            extractedTermsSet.add(term.toLowerCase());
            const frequency = typeof item.frequency === 'number' ? item.frequency : 1;
            const suggestedTargetTerm = item.targetTerm ? String(item.targetTerm).trim() : undefined;
            return { term, frequency, suggestedTargetTerm };
          })
          .filter((item): item is { term: string; frequency: number; suggestedTargetTerm?: string | undefined } => item !== null);
        
        aiTerms.push(...newTerms);
        
        logger.info(
          {
            documentId,
            passNumber,
            newTermsExtracted: newTerms.length,
            totalTermsNow: aiTerms.length,
            targetTerms,
          },
          `Deep mode: Pass ${passNumber} extracted ${newTerms.length} additional terms (total: ${aiTerms.length})`,
        );
        
        // Update remaining candidates for next pass
        remainingCandidates.splice(0, batchSize);
        passNumber++;
        
        // If we've reached the target, stop
        if (aiTerms.length >= targetTerms) {
          logger.info(
            {
              documentId,
              totalTerms: aiTerms.length,
              targetTerms,
              passesUsed: passNumber - 1,
            },
            'Deep mode: Reached target of 100+ terms with multi-pass extraction',
          );
          break;
        }
      } catch (error: any) {
        // #region agent log
        fetch('http://127.0.0.1:7242/ingest/7f529324-455d-4ca1-81c1-cbc867a5b6ab',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'analysis.service.ts:2205',message:'Multi-pass error caught',data:{passNumber,errorMessage:error?.message,errorName:error?.name,errorStack:error?.stack,errorCode:error?.code,errorCause:error?.cause,currentTerms:aiTerms.length,providerName:provider?.name,model},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'C'})}).catch(()=>{});
        // #endregion
        
        logger.warn(
          {
            documentId,
            passNumber,
            error: error?.message || String(error),
            errorName: error?.name,
            errorStack: error?.stack,
            errorCode: error?.code,
            errorCause: error?.cause,
            currentTerms: aiTerms.length,
            provider: provider?.name,
            model,
          },
          `Deep mode: Additional pass ${passNumber} failed, continuing with terms from previous passes`,
        );
        // Continue with terms we have so far
        break;
      }
    }
    
    logger.info(
      {
        documentId,
        finalTermCount: aiTerms.length,
        targetTerms,
        passesUsed: passNumber - 1,
      },
      `Deep mode: Multi-pass extraction completed with ${aiTerms.length} total terms`,
    );
  }

  // Step 6: Waterfall Lookup for each term
  // Stage 7: Translation Lookup & Generation
  await updateProgress(documentId, 'lookup_glossary', 50, 'Looking up terms in existing glossaries...', true);
  
  // Check for cancellation before starting lookup
  if (isAnalysisCancelled(documentId)) {
    throw new Error('Analysis cancelled by user');
  }

  const finalTerms: Array<{
    sourceTerm: string;
    targetTerm: string;
    frequency: number;
    status: 'APPROVED' | 'CANDIDATE';
    source: 'GLOBAL' | 'PROJECT' | 'AI';
  }> = [];

  logger.info(
    {
      documentId,
      stage: 'Stage 7: Translation Lookup',
      termsToProcess: aiTerms.length,
    },
    'Stage 7: Starting waterfall lookup for extracted terms',
  );

  let processedCount = 0;
  const totalTerms = aiTerms.length;
  
  // Stage 7 Metrics: Track translation sources
  const translationSources = {
    global: 0,
    project: 0,
    ai: 0,
    untranslated: 0,
  };
  
  for (const { term: sourceTerm, frequency, suggestedTargetTerm } of aiTerms) {
    // #region agent log
    fetch('http://127.0.0.1:7242/ingest/7f529324-455d-4ca1-81c1-cbc867a5b6ab',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'analysis.service.ts:1211',message:'Processing term from AI',data:{sourceTerm,frequency,hasSuggestedTargetTerm:!!suggestedTargetTerm,suggestedTargetTerm},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'K'})}).catch(()=>{});
    // #endregion
    // Check for cancellation during processing
    if (isAnalysisCancelled(documentId)) {
      throw new Error('Analysis cancelled by user');
    }
    
    processedCount++;
    // Update progress every 10 terms or at the end
    if (processedCount % 10 === 0 || processedCount === totalTerms) {
      const approvedSoFar = finalTerms.filter((t) => t.status === 'APPROVED').length;
      const candidateSoFar = finalTerms.filter((t) => t.status === 'CANDIDATE').length;
      const progress = 50 + Math.floor((processedCount / totalTerms) * 20); // 50-70% (within glossary's 0-50% range)
      await updateProgress(
        documentId,
        'lookup_glossary',
        progress,
        `Looking up terms: ${processedCount}/${totalTerms} (${approvedSoFar} approved, ${candidateSoFar} candidate)...`,
        true,
      );
    }
    try {
      // 6a. Check Global Glossary first (projectId = null)
      const globalEntry = await prisma.glossaryEntry.findFirst({
        where: {
          projectId: null,
          sourceTerm: { equals: sourceTerm, mode: 'insensitive' },
          sourceLocale: document.sourceLocale,
          targetLocale: document.targetLocale,
        },
      });

      if (globalEntry) {
        // Clean targetTerm from JSON array format (for backward compatibility)
        let targetTerm = cleanTargetTerm(globalEntry.targetTerm);
        const wasCleaned = targetTerm !== globalEntry.targetTerm;
        
        // If we cleaned the term, update it in the database
        if (wasCleaned) {
          try {
            await prisma.glossaryEntry.update({
              where: { id: globalEntry.id },
              data: { targetTerm },
            });
            logger.info(
              { documentId, sourceTerm, oldTargetTerm: globalEntry.targetTerm, newTargetTerm: targetTerm },
              'Cleaned and updated corrupted targetTerm in Global Glossary',
            );
          } catch (error: any) {
            logger.warn(
              { documentId, sourceTerm, error: error.message },
              'Failed to update cleaned targetTerm in Global Glossary, using cleaned value anyway',
            );
          }
        }
        
        // #region agent log
        const isNotTranslated = targetTerm.trim() === sourceTerm.trim();
        fetch('http://127.0.0.1:7242/ingest/7f529324-455d-4ca1-81c1-cbc867a5b6ab',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'analysis.service.ts:1193',message:'Found in Global Glossary',data:{sourceTerm,targetTerm,targetTermLength:targetTerm.length,isNotTranslated,wasCleaned},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'C'})}).catch(()=>{});
        // #endregion
        
        // If term is not translated (targetTerm === sourceTerm), translate it with AI
        // But first check if the term is already in the target language (e.g., English terms when target is English)
        if (isNotTranslated && document.sourceLocale !== document.targetLocale) {
          // Check if term is already in target language
          const hasCyrillic = /[А-Яа-яЁё]/.test(sourceTerm);
          const hasLatin = /[A-Za-z]/.test(sourceTerm);
          const targetIsEnglish = document.targetLocale.toLowerCase().startsWith('en');
          const targetIsRussian = document.targetLocale.toLowerCase().startsWith('ru');
          
          // If target is English and term has no Cyrillic (only Latin), it's already in target language
          // If target is Russian and term has Cyrillic, it's already in target language
          const isAlreadyInTargetLanguage = 
            (targetIsEnglish && !hasCyrillic && hasLatin) ||
            (targetIsRussian && hasCyrillic);
          
          if (isAlreadyInTargetLanguage) {
            // #region agent log
            fetch('http://127.0.0.1:7242/ingest/7f529324-455d-4ca1-81c1-cbc867a5b6ab',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'analysis.service.ts:1252',message:'Term already in target language, skipping translation',data:{sourceTerm,targetTerm:globalEntry.targetTerm,sourceLocale:document.sourceLocale,targetLocale:document.targetLocale,hasCyrillic,hasLatin},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'K'})}).catch(()=>{});
            // #endregion
            logger.debug({ documentId, sourceTerm, targetTerm }, 'Term already in target language, skipping translation');
          } else {
            logger.debug({ documentId, sourceTerm }, 'Term found in Global Glossary but not translated, translating with AI');
            
            // #region agent log
            fetch('http://127.0.0.1:7242/ingest/7f529324-455d-4ca1-81c1-cbc867a5b6ab',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'analysis.service.ts:1260',message:'Translating untranslated term from Global Glossary',data:{sourceTerm,originalTargetTerm:globalEntry.targetTerm},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'K'})}).catch(()=>{});
            // #endregion
            
            try {
              targetTerm = await translateTermWithAI(
                sourceTerm,
                document.sourceLocale,
                document.targetLocale,
                provider,
                model,
              );
              
              // Update the glossary entry with the translation
              if (targetTerm.trim() !== sourceTerm.trim()) {
                await prisma.glossaryEntry.update({
                  where: { id: globalEntry.id },
                  data: { targetTerm },
                });
                logger.info(
                  { documentId, sourceTerm, oldTargetTerm: globalEntry.targetTerm, newTargetTerm: targetTerm },
                  'Updated untranslated term in Global Glossary',
                );
              }
            } catch (error: any) {
              logger.warn(
                { documentId, sourceTerm, error: error.message },
                'Failed to translate untranslated term from Global Glossary, using original',
              );
              // Keep original targetTerm if translation fails
            }
          }
        }
        
        // If GlossaryEntry exists, status is APPROVED (since it's in the global/project glossary)
        const termStatus = 'APPROVED';
        translationSources.global++;
        finalTerms.push({
          sourceTerm: globalEntry.sourceTerm,
          targetTerm,
          frequency,
          status: termStatus,
          source: 'GLOBAL',
        });
        logger.debug(
          { documentId, stage: 'Stage 7', sourceTerm, targetTerm, source: 'GLOBAL' },
          'Stage 7: Found term in Global Glossary',
        );
        continue;
      }

      // 6b. Check Project Glossary
      const projectEntry = await prisma.glossaryEntry.findFirst({
        where: {
          projectId: document.projectId,
          sourceTerm: { equals: sourceTerm, mode: 'insensitive' },
          sourceLocale: document.sourceLocale,
          targetLocale: document.targetLocale,
        },
      });

      if (projectEntry) {
        // #region agent log
        const isNotTranslated = projectEntry.targetTerm.trim() === sourceTerm.trim();
        fetch('http://127.0.0.1:7242/ingest/7f529324-455d-4ca1-81c1-cbc867a5b6ab',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'analysis.service.ts:1272',message:'Found in Project Glossary',data:{sourceTerm,targetTerm:projectEntry.targetTerm,targetTermLength:projectEntry.targetTerm.length,isNotTranslated},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'K'})}).catch(()=>{});
        // #endregion

        // If term is not translated (targetTerm === sourceTerm), translate it with AI
        // But first check if the term is already in the target language
        let targetTerm = projectEntry.targetTerm;
        if (isNotTranslated && document.sourceLocale !== document.targetLocale) {
          // Check if term is already in target language
          const hasCyrillic = /[А-Яа-яЁё]/.test(sourceTerm);
          const hasLatin = /[A-Za-z]/.test(sourceTerm);
          const targetIsEnglish = document.targetLocale.toLowerCase().startsWith('en');
          const targetIsRussian = document.targetLocale.toLowerCase().startsWith('ru');
          
          // If target is English and term has no Cyrillic (only Latin), it's already in target language
          // If target is Russian and term has Cyrillic, it's already in target language
          const isAlreadyInTargetLanguage = 
            (targetIsEnglish && !hasCyrillic && hasLatin) ||
            (targetIsRussian && hasCyrillic);
          
          if (isAlreadyInTargetLanguage) {
            // #region agent log
            fetch('http://127.0.0.1:7242/ingest/7f529324-455d-4ca1-81c1-cbc867a5b6ab',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'analysis.service.ts:1305',message:'Term already in target language, skipping translation',data:{sourceTerm,targetTerm:projectEntry.targetTerm,sourceLocale:document.sourceLocale,targetLocale:document.targetLocale,hasCyrillic,hasLatin},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'K'})}).catch(()=>{});
            // #endregion
            logger.debug({ documentId, sourceTerm, targetTerm }, 'Term already in target language, skipping translation');
          } else {
            logger.debug({ documentId, sourceTerm }, 'Term found in Project Glossary but not translated, translating with AI');
            
            // #region agent log
            fetch('http://127.0.0.1:7242/ingest/7f529324-455d-4ca1-81c1-cbc867a5b6ab',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'analysis.service.ts:1313',message:'Translating untranslated term from Project Glossary',data:{sourceTerm,originalTargetTerm:projectEntry.targetTerm},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'K'})}).catch(()=>{});
            // #endregion
            
            try {
              targetTerm = await translateTermWithAI(
                sourceTerm,
                document.sourceLocale,
                document.targetLocale,
                provider,
                model,
              );
              
              // Update the glossary entry with the translation
              if (targetTerm.trim() !== sourceTerm.trim()) {
                await prisma.glossaryEntry.update({
                  where: { id: projectEntry.id },
                  data: { targetTerm },
                });
                logger.info(
                  { documentId, sourceTerm, oldTargetTerm: projectEntry.targetTerm, newTargetTerm: targetTerm },
                  'Updated untranslated term in Project Glossary',
                );
              }
            } catch (error: any) {
              logger.warn(
                { documentId, sourceTerm, error: error.message },
                'Failed to translate untranslated term from Project Glossary, using original',
              );
              // Keep original targetTerm if translation fails
            }
          }
        }

        // If term is in Project Glossary, treat it as APPROVED regardless of DB status
        // CANDIDATE status in DB is for internal tracking,
        // but once in project glossary, it should be trusted for document translation
        translationSources.project++;
        finalTerms.push({
          sourceTerm: projectEntry.sourceTerm,
          targetTerm,
          frequency,
          status: 'APPROVED', // All terms from project glossary are APPROVED
          source: 'PROJECT',
        });
        logger.debug(
          { documentId, stage: 'Stage 7', sourceTerm, targetTerm, source: 'PROJECT' },
          'Stage 7: Found term in Project Glossary',
        );
        continue;
      }

      // 6c. Not found - use suggestedTargetTerm from AI if available, otherwise translate with AI
      logger.debug({ documentId, sourceTerm }, 'Term not found in glossaries, translating with AI');
      
      let targetTerm: string;
      
      // Check if AI already provided a translation in the extraction response
      if (suggestedTargetTerm && suggestedTargetTerm.trim() !== sourceTerm.trim() && suggestedTargetTerm.trim().length > 0) {
        // #region agent log
        fetch('http://127.0.0.1:7242/ingest/7f529324-455d-4ca1-81c1-cbc867a5b6ab',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'analysis.service.ts:1289',message:'Using suggestedTargetTerm from AI response',data:{sourceTerm,suggestedTargetTerm,isNotTranslated:suggestedTargetTerm.trim()===sourceTerm.trim()},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'K'})}).catch(()=>{});
        // #endregion
        targetTerm = suggestedTargetTerm.trim();
      } else {
        // #region agent log
        fetch('http://127.0.0.1:7242/ingest/7f529324-455d-4ca1-81c1-cbc867a5b6ab',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'analysis.service.ts:1294',message:'Before AI translation (no suggestedTargetTerm)',data:{sourceTerm,sourceTermLength:sourceTerm.length,hasSuggestedTargetTerm:!!suggestedTargetTerm,suggestedTargetTerm},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'A'})}).catch(()=>{});
        // #endregion
        
        targetTerm = await translateTermWithAI(
          sourceTerm,
          document.sourceLocale,
          document.targetLocale,
          provider,
          model,
        );
      }

      // #region agent log
      fetch('http://127.0.0.1:7242/ingest/7f529324-455d-4ca1-81c1-cbc867a5b6ab',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'analysis.service.ts:1242',message:'After AI translation',data:{sourceTerm,targetTerm,targetTermLength:targetTerm.length,isTruncated:targetTerm.length<sourceTerm.length*0.5},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'A'})}).catch(()=>{});
      // #endregion

      // Validate translation before saving
      const isNotTranslated = targetTerm.trim() === sourceTerm.trim();
      if (isNotTranslated) {
        // #region agent log
        fetch('http://127.0.0.1:7242/ingest/7f529324-455d-4ca1-81c1-cbc867a5b6ab',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'analysis.service.ts:1310',message:'WARNING: targetTerm equals sourceTerm, skipping DB save',data:{sourceTerm,targetTerm,sourceLocale:document.sourceLocale,targetLocale:document.targetLocale},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'K'})}).catch(()=>{});
        // #endregion
        
        logger.warn(
          {
            documentId,
            stage: 'Stage 7',
            sourceTerm,
            targetTerm,
            sourceLocale: document.sourceLocale,
            targetLocale: document.targetLocale,
            reason: 'Translation failed or term already in target language',
          },
          'Stage 7: Skipping term save - targetTerm equals sourceTerm (translation failed or term already in target language)',
        );
        
        // Still add to finalTerms but mark as not translated
      translationSources.untranslated++;
        finalTerms.push({
          sourceTerm,
          targetTerm,
          frequency,
          status: 'CANDIDATE',
          source: 'AI',
        });
        continue;
      }

      // IMPORTANT: Do NOT save to Global Glossary here
      // Terms should only be saved to Global Glossary when approved in Glossary Review
      // They are saved to DocumentGlossaryEntry in the merge step below, which is correct
      // This ensures candidate terms from analysis don't automatically appear in global glossary
      
      // Note: isNotTranslated check already done above, term already added to finalTerms if not translated
      // This code path is only reached if translation was successful
      
      // CRITICAL FIX: Filter out verbs and sentence fragments before adding to finalTerms
      if (isVerbOrFragment(sourceTerm, targetTerm)) {
        // #region agent log
        fetch('http://127.0.0.1:7242/ingest/7f529324-455d-4ca1-81c1-cbc867a5b6ab',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'analysis.service.ts:2700',message:'REJECTED: Verb or sentence fragment detected',data:{sourceTerm,targetTerm,reason:'Contains verb or is sentence fragment'},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'F'})}).catch(()=>{});
        // #endregion
        logger.warn(
          { documentId, sourceTerm, targetTerm },
          'REJECTED term: Contains verb or is sentence fragment (post-processing filter)',
        );
        continue; // Skip this term
      }
      
      // #region agent log
      fetch('http://127.0.0.1:7242/ingest/7f529324-455d-4ca1-81c1-cbc867a5b6ab',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'analysis.service.ts:1375',message:'Adding successfully translated term to finalTerms',data:{sourceTerm,targetTerm,source:'AI'},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'K'})}).catch(()=>{});
      // #endregion

      translationSources.ai++;
      finalTerms.push({
        sourceTerm,
        targetTerm,
        frequency,
        status: 'CANDIDATE',
        source: 'AI',
      });
    } catch (error: any) {
      logger.error(
        { documentId, stage: 'Stage 7', sourceTerm, error: error.message },
        'Stage 7: Error processing term in waterfall lookup',
      );
      // Continue with next term even if one fails
    }
  }
  
  // Stage 7: Log translation lookup results
  const translationCoverage = totalTerms > 0 ? (((totalTerms - translationSources.untranslated) / totalTerms) * 100).toFixed(1) : '0.0';
  
      logger.info(
        {
          documentId,
          stage: 'Stage 7: Translation Lookup',
          totalTerms,
          translationCoverage: `${translationCoverage}%`,
          translationSources,
          untranslatedCount: translationSources.untranslated,
          untranslatedRate: totalTerms > 0 ? `${((translationSources.untranslated / totalTerms) * 100).toFixed(1)}%` : '0.0%',
        },
        'Stage 7: Translation lookup complete',
      );
      
      // Add to execution logs
      await addExecutionLog(documentId, {
        stage: 'Stage 7: Translation Lookup',
        level: 'info',
        message: `Translation lookup: ${translationCoverage}% coverage (Global: ${translationSources.global}, Project: ${translationSources.project}, AI: ${translationSources.ai}, Untranslated: ${translationSources.untranslated})`,
        data: {
          totalTerms,
          translationCoverage: `${translationCoverage}%`,
          translationSources,
        },
      });
  
  // Stage 7 Validation: Warn if > 10% terms untranslated
  const untranslatedRate = totalTerms > 0 ? (translationSources.untranslated / totalTerms * 100) : 0;
  if (untranslatedRate > 10) {
    logger.warn(
      {
        documentId,
        stage: 'Stage 7: Translation Lookup',
        warning: `High untranslated rate: ${untranslatedRate.toFixed(1)}% of terms not translated`,
        untranslatedRate: `${untranslatedRate.toFixed(1)}%`,
        untranslatedCount: translationSources.untranslated,
        totalTerms,
      },
      'Stage 7: WARNING - High untranslated rate',
    );
  }

  if (finalTerms.length === 0) {
    logger.warn({ documentId, stage: 'Stage 7' }, 'Stage 7: No terms processed successfully after waterfall lookup');
    await prisma.documentAnalysis.upsert({
      where: { documentId },
      create: {
        documentId,
        status: 'COMPLETED',
        glossaryExtracted: true,
        completedAt: new Date(),
      },
      update: {
        glossaryExtracted: true,
      },
    });
    return { count: 0 };
  }

  // ===================================================================
  // STEP 3: PROCESS CONFIRMED TERMS THROUGH WATERFALL LOOKUP
  // ===================================================================
  await updateProgress(documentId, 'lookup_confirmed', 65, 'Looking up translations for confirmed terms...', true);
  
  // Process confirmed terms through waterfall lookup (to get proper translations)
  // but mark them as APPROVED regardless of GlossaryEntry status
  const confirmedFinalTerms: Array<{
    sourceTerm: string;
    targetTerm: string;
    frequency: number;
    status: 'APPROVED' | 'CANDIDATE';
    source: 'CONFIRMED' | 'GLOBAL' | 'PROJECT' | 'AI';
  }> = [];

  for (const entry of Array.from(confirmedTermsMap.entries())) {
    const [normalized, term] = entry;
    try {
      // Check Global Glossary first
      const globalEntry = await prisma.glossaryEntry.findFirst({
        where: {
          projectId: null,
          sourceTerm: { equals: term.sourceTerm, mode: 'insensitive' },
          sourceLocale: document.sourceLocale,
          targetLocale: document.targetLocale,
        },
      });

      if (globalEntry) {
        // Clean targetTerm from JSON array format (for backward compatibility)
        const cleanedTargetTerm = cleanTargetTerm(globalEntry.targetTerm);
        
        confirmedFinalTerms.push({
          sourceTerm: globalEntry.sourceTerm,
          targetTerm: cleanedTargetTerm,
          frequency: term.frequency,
          status: 'APPROVED', // Always APPROVED for confirmed segments
          source: 'CONFIRMED',
        });
        continue;
      }

      // Check Project Glossary
      const projectEntry = await prisma.glossaryEntry.findFirst({
        where: {
          projectId: document.projectId,
          sourceTerm: { equals: term.sourceTerm, mode: 'insensitive' },
          sourceLocale: document.sourceLocale,
          targetLocale: document.targetLocale,
        },
      });

      if (projectEntry) {
        confirmedFinalTerms.push({
          sourceTerm: projectEntry.sourceTerm,
          targetTerm: projectEntry.targetTerm,
          frequency: term.frequency,
          status: 'APPROVED', // Always APPROVED for confirmed segments
          source: 'CONFIRMED',
        });
        continue;
      }

      // Not found in glossaries - use the term as-is (from confirmed segments)
      confirmedFinalTerms.push({
        sourceTerm: term.sourceTerm,
        targetTerm: term.targetTerm,
        frequency: term.frequency,
        status: 'APPROVED', // Always APPROVED for confirmed segments
        source: 'CONFIRMED',
      });
    } catch (error: any) {
      logger.error(
        { documentId, sourceTerm: term.sourceTerm, error: error.message },
        'Error processing confirmed term in waterfall lookup',
      );
      // Still add it as APPROVED
      confirmedFinalTerms.push({
        sourceTerm: term.sourceTerm,
        targetTerm: term.targetTerm,
        frequency: term.frequency,
        status: 'APPROVED',
        source: 'CONFIRMED',
      });
    }
  }

  // ===================================================================
  // STEP 4: SMART MERGE (Non-Destructive Upsert)
  // Stage 8: Merge & Persistence
  // ===================================================================
  await updateProgress(documentId, 'saving_glossary', 70, 'Merging terms with existing entries (respecting approved status)...', true);
  
  logger.info(
    {
      documentId,
      stage: 'Stage 8: Merge & Persistence',
      confirmedTermsCount: confirmedFinalTerms.length,
      aiTermsCount: finalTerms.length,
    },
    'Stage 8: Starting merge and persistence',
  );
  
  // Combine confirmed terms with AI-extracted terms
  const allFoundTerms: Array<{
    sourceTerm: string;
    targetTerm: string;
    frequency: number;
    status: 'APPROVED' | 'CANDIDATE';
    source: 'CONFIRMED' | 'GLOBAL' | 'PROJECT' | 'AI';
  }> = [];

  // Add confirmed terms (already processed through waterfall)
  for (const term of confirmedFinalTerms) {
    allFoundTerms.push(term);
  }

  // Add AI-extracted terms
  for (const term of finalTerms) {
    allFoundTerms.push(term);
  }

  // Remove duplicates and sum frequencies
  const uniqueTermsMap = new Map<string, {
    sourceTerm: string;
    targetTerm: string;
    frequency: number;
    status: 'APPROVED' | 'CANDIDATE';
    source: 'CONFIRMED' | 'GLOBAL' | 'PROJECT' | 'AI';
  }>();
  
  // Stage 8 Metrics: Track duplicate detection
  let duplicateCount = 0;
  let frequencySummedCount = 0;
  let statusUpgradedCount = 0;

  for (const term of allFoundTerms) {
    const key = term.sourceTerm.toLowerCase();
    const existing = uniqueTermsMap.get(key);
    if (existing) {
      duplicateCount++;
      // Sum frequencies if duplicate
      existing.frequency += term.frequency;
      frequencySummedCount++;
      // If either is APPROVED, keep APPROVED status
      if (term.status === 'APPROVED' && existing.status === 'CANDIDATE') {
        existing.status = 'APPROVED';
        statusUpgradedCount++;
      }
    } else {
      uniqueTermsMap.set(key, { ...term });
    }
  }

  const uniqueTerms = Array.from(uniqueTermsMap.values());
  
  // Count approved vs candidate after deduplication
  const preMergeApproved = uniqueTerms.filter((t) => t.status === 'APPROVED').length;
  const preMergeCandidate = uniqueTerms.filter((t) => t.status === 'CANDIDATE').length;
  
  logger.info(
    {
      documentId,
      stage: 'Stage 8: Merge & Persistence',
      inputTerms: allFoundTerms.length,
      uniqueTerms: uniqueTerms.length,
      duplicateCount,
      frequencySummedCount,
      statusUpgradedCount,
      preMergeApproved,
      preMergeCandidate,
    },
    'Stage 8: Deduplication complete',
  );
  await updateProgress(
    documentId, 
    'saving_glossary', 
    72, 
    `Merging ${uniqueTerms.length} terms (${preMergeApproved} approved, ${preMergeCandidate} candidate)...`, 
    true
  );

  // Fetch existing DocumentGlossaryEntry records for this document
  const existingEntries = await prisma.documentGlossaryEntry.findMany({
    where: { documentId },
  });

  // Create a map of existing entries by normalized source term
  const existingEntriesMap = new Map<string, typeof existingEntries[0]>();
  for (const entry of existingEntries) {
    const key = entry.sourceTerm.toLowerCase();
    existingEntriesMap.set(key, entry);
  }

  // For each existing entry, check if it's APPROVED (via GlossaryEntry lookup)
  const approvedTermsSet = new Set<string>();
  for (const entry of existingEntries) {
    // Check if corresponding GlossaryEntry has status PREFERRED (APPROVED)
    const glossaryEntry = await prisma.glossaryEntry.findFirst({
      where: {
        OR: [
          { projectId: null }, // Global
          { projectId: document.projectId }, // Project
        ],
        sourceTerm: { equals: entry.sourceTerm, mode: 'insensitive' },
        sourceLocale: document.sourceLocale,
        targetLocale: document.targetLocale,
      },
      select: { id: true },
    });

    // If a GlossaryEntry exists, the DocumentGlossaryEntry is considered APPROVED
    // (GlossaryEntry doesn't have a status field - that's only on DocumentGlossaryEntry)
    if (glossaryEntry) {
      approvedTermsSet.add(entry.sourceTerm.toLowerCase());
    }
  }

  // Smart Merge: Process each unique term
  // Stage 8 Metrics: Track merge operations
  let createdCount = 0;
  let updatedCount = 0;
  let skippedCount = 0;
  let approvedCount = 0;
  let candidateCount = 0;
  const skippedApprovedTerms: string[] = [];
  const statusChanges: Array<{ term: string; from: string; to: string }> = [];

  for (const term of uniqueTerms) {
    // Track approved vs candidate counts
    if (term.status === 'APPROVED') {
      approvedCount++;
    } else {
      candidateCount++;
    }
    const normalizedKey = term.sourceTerm.toLowerCase();
    const existingEntry = existingEntriesMap.get(normalizedKey);
    const isApproved = approvedTermsSet.has(normalizedKey);

    // If entry exists and is APPROVED, skip it (do not overwrite human decisions)
    if (existingEntry && isApproved) {
      skippedCount++;
      skippedApprovedTerms.push(term.sourceTerm);
      logger.debug(
        { documentId, stage: 'Stage 8', sourceTerm: term.sourceTerm },
        'Stage 8: Skipping APPROVED entry (preserving human decision)',
      );
      continue;
    }

    // If entry exists but is CANDIDATE, update it
    if (existingEntry && !isApproved) {
      const oldStatus = existingEntry.status || 'CANDIDATE';
      await prisma.documentGlossaryEntry.update({
        where: { id: existingEntry.id },
        data: {
          targetTerm: term.targetTerm,
          occurrenceCount: term.frequency,
        },
      });
      updatedCount++;
      if (term.status !== oldStatus) {
        statusChanges.push({ term: term.sourceTerm, from: oldStatus, to: term.status });
      }
      logger.debug(
        { documentId, stage: 'Stage 8', sourceTerm: term.sourceTerm },
        'Stage 8: Updated CANDIDATE entry',
      );
      
      // CRITICAL: Do NOT automatically create/update GlossaryEntry for terms that already existed in document glossary
      // This prevents automatic promotion to global glossary on repeated analysis runs
      // Only create GlossaryEntry for NEW terms (not existing ones being updated from CANDIDATE to APPROVED)
      // #region agent log
      fetch('http://127.0.0.1:7242/ingest/7f529324-455d-4ca1-81c1-cbc867a5b6ab',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'analysis.service.ts:1897',message:'Skipping automatic GlossaryEntry creation for existing document glossary term being updated',data:{sourceTerm:term.sourceTerm,source:term.source,existingEntryId:existingEntry.id,termStatus:term.status},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'O'})}).catch(()=>{});
      // #endregion
      logger.debug(
        { documentId, sourceTerm: term.sourceTerm, existingEntryId: existingEntry.id, termStatus: term.status },
        'Skipping automatic GlossaryEntry creation/update for existing document glossary term (preventing auto-promotion on repeated analysis)',
      );
      continue;
    }

    // If entry doesn't exist, create it
    await prisma.documentGlossaryEntry.create({
      data: {
        documentId,
        sourceTerm: term.sourceTerm,
        targetTerm: term.targetTerm,
        occurrenceCount: term.frequency,
      },
    });
    createdCount++;
    
    // CRITICAL: Do NOT automatically create/update GlossaryEntry for APPROVED terms on repeated analysis runs
    // This prevents automatic promotion to global glossary when terms are found in global glossary during analysis
    // Only create GlossaryEntry for CONFIRMED terms (from confirmed segments) - these should go to global glossary
    // GLOBAL and AI terms should NOT be automatically promoted to global glossary on repeated runs
    if (term.status === 'APPROVED' && term.source === 'CONFIRMED') {
      // Only CONFIRMED terms (from confirmed segments) should automatically create GlossaryEntry
      // This is the only case where we want automatic promotion to global glossary
      try {
        // CONFIRMED terms come from confirmed segments and should be in global glossary
        const isGlobalEntry = true; // CONFIRMED terms always go to global glossary
        
        // Check if GlossaryEntry already exists
        const existingGlossaryEntry = await prisma.glossaryEntry.findFirst({
          where: {
            OR: [
              { projectId: null }, // Global
              { projectId: document.projectId }, // Project
            ],
            sourceTerm: { equals: term.sourceTerm, mode: 'insensitive' },
            sourceLocale: document.sourceLocale,
            targetLocale: document.targetLocale,
          },
        });
        
        if (!existingGlossaryEntry) {
          // Create GlossaryEntry - CONFIRMED terms go to global glossary (projectId: null)
          // Note: GlossaryEntry doesn't have a status field - that's only on DocumentGlossaryEntry
          await prisma.glossaryEntry.create({
            data: {
              sourceTerm: term.sourceTerm,
              targetTerm: term.targetTerm,
              sourceLocale: document.sourceLocale,
              targetLocale: document.targetLocale,
              direction: `${document.sourceLocale}-${document.targetLocale}`,
              // Omit projectId to create global glossary entry (null)
            },
          });
          logger.info(
            { 
              documentId, 
              sourceTerm: term.sourceTerm, 
              source: term.source,
            },
            'Created GlossaryEntry for CONFIRMED term (global glossary)',
          );
        } else {
          // Entry already exists - no need to update (GlossaryEntry doesn't have status field)
          logger.debug(
            { documentId, sourceTerm: term.sourceTerm, entryId: existingGlossaryEntry.id },
            'GlossaryEntry already exists for CONFIRMED term',
          );
        }
      } catch (error: any) {
        // Non-critical: if GlossaryEntry creation fails, log but continue
        logger.warn(
          { documentId, sourceTerm: term.sourceTerm, source: term.source, error: error.message },
          'Failed to create/update GlossaryEntry for CONFIRMED term (non-critical)',
        );
      }
    } else if (term.status === 'APPROVED' && (term.source === 'GLOBAL' || term.source === 'AI')) {
      // #region agent log
      fetch('http://127.0.0.1:7242/ingest/7f529324-455d-4ca1-81c1-cbc867a5b6ab',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'analysis.service.ts:1923',message:'Skipping automatic GlossaryEntry creation for GLOBAL/AI term on repeated analysis',data:{sourceTerm:term.sourceTerm,source:term.source,termStatus:term.status},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'O'})}).catch(()=>{});
      // #endregion
      logger.debug(
        { documentId, sourceTerm: term.sourceTerm, source: term.source, termStatus: term.status },
        'Skipping automatic GlossaryEntry creation for GLOBAL/AI term (preventing auto-promotion on repeated analysis)',
      );
    }
  }

  // CRITICAL FIX: Query actual database count (includes preserved APPROVED entries)
  // This ensures consistency with getAnalysisResults
  await updateProgress(documentId, 'saving_glossary', 90, 'Finalizing glossary extraction...', true);
  
  // Stage 8: Final logging and validation
  logger.info(
    {
      documentId,
      stage: 'Stage 8: Merge & Persistence',
      createdCount,
      updatedCount,
      skippedCount,
      skippedApprovedCount: skippedApprovedTerms.length,
      skippedApprovedTerms: skippedApprovedTerms.slice(0, 10),
      statusChanges: statusChanges.slice(0, 10),
      finalApprovedCount: approvedCount,
      finalCandidateCount: candidateCount,
    },
    'Stage 8: Merge operations complete',
  );
  
  // Add to execution logs
  await addExecutionLog(documentId, {
    stage: 'Stage 8: Merge & Persistence',
    level: 'info',
    message: `Saved ${createdCount} new entries, updated ${updatedCount}, skipped ${skippedCount} approved entries. Final: ${approvedCount} approved, ${candidateCount} candidate`,
    data: {
      createdCount,
      updatedCount,
      skippedCount,
      finalApprovedCount: approvedCount,
      finalCandidateCount: candidateCount,
    },
  });
  
  const actualDbCount = await prisma.documentGlossaryEntry.count({
    where: { documentId },
  });

  const finalCount = actualDbCount; // Use actual DB count, not just created+updated

  // Stage 8 Validation: Verify all terms saved
  const expectedCount = uniqueTerms.length - skippedCount; // Should match created + updated
  const actualCreatedUpdated = createdCount + updatedCount;
  
  if (actualCreatedUpdated !== expectedCount && skippedCount === 0) {
    logger.warn(
      {
        documentId,
        stage: 'Stage 8: Merge & Persistence',
        warning: 'Created/Updated count does not match expected count',
        expectedCount,
        actualCreatedUpdated,
        createdCount,
        updatedCount,
        uniqueTermsCount: uniqueTerms.length,
      },
      'Stage 8: WARNING - Mismatch in merge counts',
    );
  } else {
    logger.info(
      {
        documentId,
        stage: 'Stage 8: Merge & Persistence',
        actualDbCount,
        expectedCount,
        actualCreatedUpdated,
        skippedCount,
      },
      'Stage 8: All terms saved successfully',
    );
  }

  logger.info(
    {
      documentId,
      actualDbCount,
      createdCount,
      updatedCount,
      skippedCount,
      totalTermsProcessed: uniqueTerms.length,
    },
    'Glossary extraction smart merge completed',
  );

  // Count final approved vs candidate terms from database
  const finalApprovedCount = uniqueTerms.filter((t) => t.status === 'APPROVED').length;
  const finalCandidateCount = uniqueTerms.filter((t) => t.status === 'CANDIDATE').length;
  
  // CRITICAL: Do NOT set status to COMPLETED here - style rules extraction may still be running in parallel
  // Only update glossaryExtracted flag and progress, but keep status as RUNNING
  // The final status update will happen in runFullAnalysis after both tasks complete
  const completionMessage = `Glossary extraction completed: ${actualDbCount} terms (${finalApprovedCount} approved, ${finalCandidateCount} candidate) - ${createdCount} created, ${updatedCount} updated, ${skippedCount} preserved. Style rules extraction in progress...`;
  await updateProgress(documentId, 'saving_glossary', 50, completionMessage, true);
  await prisma.documentAnalysis.upsert({
    where: { documentId },
    create: {
      documentId,
      status: 'RUNNING', // Keep as RUNNING - style rules may still be processing
      glossaryExtracted: true,
      currentStage: 'saving_glossary',
      progressPercentage: 50, // Glossary is 50% of the work
      currentMessage: completionMessage,
    },
    update: {
      // Do NOT change status to COMPLETED - keep it RUNNING until style rules are done
      glossaryExtracted: true,
      currentStage: 'saving_glossary',
      progressPercentage: 50, // Glossary is 50% of the work
      currentMessage: completionMessage,
      // Do NOT set completedAt or change status here
    },
  });

  // Final validation and summary
  const totalSegments = document.segments.length;
  const termsPerSegment = totalSegments > 0 ? (finalCount / totalSegments).toFixed(2) : '0';
  
  if (finalCount === 0 && totalSegments > 100) {
    logger.error(
      {
        documentId,
        totalSegments,
        confirmedSegmentsCount: confirmedSegments.length,
        remainingSegmentsCount: remainingSegments.length,
        confirmedTermsCount: confirmedTermsMap.size,
        aiTermsCount: aiTerms.length,
        filteredFrequentTermsCount: filteredFrequentTerms.length,
        rawCandidatesCount: rawCandidates.length,
      },
      'CRITICAL: Zero terms extracted for large document - investigation required',
    );
  } else if (finalCount < 10 && totalSegments > 100) {
    logger.warn(
      {
        documentId,
        totalSegments,
        finalCount,
        termsPerSegment,
        confirmedTermsCount: confirmedTermsMap.size,
        aiTermsCount: aiTerms.length,
      },
      'WARNING: Very few terms extracted for large document - may indicate issues',
    );
  }

  logger.info(
    {
      documentId,
      totalSegments,
      confirmedSegmentsCount: confirmedSegments.length,
      remainingSegmentsCount: remainingSegments.length,
      confirmedTermsCount: confirmedTermsMap.size,
      aiTermsCount: aiTerms.length,
      finalTermsCount: finalTerms.length,
      uniqueTermsCount: uniqueTerms.length,
      createdCount,
      updatedCount,
      skippedCount,
      totalProcessed: finalCount,
      termsPerSegment,
      approvedTerms: uniqueTerms.filter((t) => t.status === 'APPROVED').length,
      candidateTerms: uniqueTerms.filter((t) => t.status === 'CANDIDATE').length,
      globalFound: finalTerms.filter((t) => t.source === 'GLOBAL').length,
      projectFound: finalTerms.filter((t) => t.source === 'PROJECT').length,
      aiTranslated: finalTerms.filter((t) => t.source === 'AI').length,
      confirmedSource: allFoundTerms.filter((t) => t.source === 'CONFIRMED').length,
    },
    'Glossary extraction completed with incremental non-destructive approach',
  );

  // #region agent log
  fetch('http://127.0.0.1:7242/ingest/7f529324-455d-4ca1-81c1-cbc867a5b6ab',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'analysis.service.ts:1870',message:'Final glossary extraction summary',data:{totalSegments,aiTermsCount:aiTerms.length,finalTermsCount:finalCount,createdCount,updatedCount,sampleTerms:finalTerms.slice(0,10).map(t=>({sourceTerm:t.sourceTerm.substring(0,50),targetTerm:t.targetTerm.substring(0,50)})),hasInstrumentalCase:finalTerms.some(t=>t.sourceTerm.includes('ым')||t.sourceTerm.includes('ом')||t.sourceTerm.includes('ем')),hasFragments:finalTerms.some(t=>t.sourceTerm.length<10&&(t.sourceTerm.includes('of')||t.sourceTerm.includes('by')||t.sourceTerm.includes('the')))},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'J'})}).catch(()=>{});
  // #endregion

  return { count: finalCount };
};

/**
 * Extracts style rules from document source text
 * Analyzes formatting patterns like date formats, number formats, list styles, etc.
 */

/** Max characters to send for Document DNA; beyond this we use stride sampling */
const DOCUMENT_DNA_TOKEN_BUDGET = 300_000;
/** Number of evenly distributed excerpts when document exceeds budget (stride sampling) */
export const STRIDE_SAMPLE_COUNT = 150;
/** Size of each excerpt in characters */
export const STRIDE_CHUNK_SIZE = 2_000;

const DOCUMENT_DNA_SAMPLE_COUNT = STRIDE_SAMPLE_COUNT;
const DOCUMENT_DNA_CHUNK_SIZE = STRIDE_CHUNK_SIZE;

/**
 * Build stride-sampled text from full document text (same algorithm as Document DNA).
 * Use when you need to "see" the whole document in a bounded string (e.g. for clustering summary).
 * @param fullText - Concatenated document text
 * @param options - Optional overrides; default sampleCount=150, chunkSize=2000
 */
export function buildStrideSampledText(
  fullText: string,
  options?: { sampleCount?: number; chunkSize?: number },
): string {
  const sampleCount = options?.sampleCount ?? STRIDE_SAMPLE_COUNT;
  const chunkSize = options?.chunkSize ?? STRIDE_CHUNK_SIZE;
  if (fullText.length <= chunkSize) return fullText;
  const n = sampleCount;
  const L = fullText.length;
  const stride = (L - chunkSize) / Math.max(1, n - 1);
  const parts: string[] = [];
  for (let i = 0; i < n; i++) {
    const start = Math.min(Math.floor(i * stride), Math.max(0, L - chunkSize));
    const end = Math.min(start + chunkSize, L);
    parts.push(fullText.slice(start, end));
    if (i < n - 1) {
      parts.push('\n... [gap] ...\n');
    }
  }
  return parts.join('');
}

/**
 * Document DNA payload shape returned by AI and stored in DB
 */
export type DocumentDnaPayload = {
  technicalSchema?: Record<string, unknown> | null;
  namingConventions?: Record<string, unknown> | null;
  abbreviationLogic?: Record<string, unknown> | null;
  entityGroups?: Record<string, unknown> | null;
};

/**
 * LLM-as-judge: score a sample of DNA abbreviationLogic term pairs (1–5).
 * Returns a Map of source term key → score. Entries not in the map are left unchanged when filtering.
 */
async function runDnaTermQc(
  provider: import('../ai/providers/types').AIProvider,
  model: string,
  abbreviationLogic: Record<string, unknown>,
  sourceLocale: string,
  targetLocale: string,
): Promise<Map<string, number>> {
  const entries: DnaQcTermEntry[] = [];
  const keys = Object.keys(abbreviationLogic).slice(0, DNA_QC_SAMPLE_SIZE);
  for (const key of keys) {
    const val = abbreviationLogic[key];
    if (val && typeof val === 'object' && 'longForm' in val && 'shortForm' in val) {
      const obj = val as { longForm?: string; shortForm?: string };
      entries.push({
        key,
        longForm: typeof obj.longForm === 'string' ? obj.longForm : '',
        shortForm: typeof obj.shortForm === 'string' ? obj.shortForm : '',
      });
    }
  }
  if (entries.length === 0) return new Map();

  const systemPrompt = buildDnaQcJudgeSystemPrompt({ sourceLocale, targetLocale });
  const userPrompt = buildDnaQcJudgeUserPrompt({ entries, sourceLocale, targetLocale });
  let response: { outputText?: string };
  try {
    response = await provider.callModel({
      prompt: userPrompt,
      systemPrompt,
      model,
      temperature: 0.1,
      maxTokens: 1024,
      segments: [] as { segmentId: string; sourceText: string }[],
    });
  } catch (err) {
    logger.warn({ err: (err as Error).message }, 'Document DNA QC: judge call failed; skipping filter');
    return new Map();
  }
  const raw = (response?.outputText || '').trim();
  const cleaned = raw.replace(/^```(?:json)?\s*\n?/i, '').replace(/\n?```\s*$/i, '').trim();
  const scores = new Map<string, number>();
  try {
    const parsed = JSON.parse(cleaned);
    if (typeof parsed === 'object' && parsed !== null) {
      for (const key of keys) {
        const s = parsed[key];
        if (typeof s === 'number' && s >= 1 && s <= 5) scores.set(key, s);
      }
    }
  } catch {
    logger.warn('Document DNA QC: could not parse judge response; skipping filter');
  }
  return scores;
}

/**
 * Pre-flight analysis: generate Document DNA (technical schema, naming conventions,
 * abbreviations, entity groups) from document content. Uses all segments; for documents
 * exceeding the token budget (300k chars), uses stride sampling: 150 evenly distributed
 * excerpts of 2000 chars each, with separators "... [gap: ~N segments] ..." so the model
 * sees scale and structure. Covers the full document including the end.
 *
 * @param documentId - Document ID (must have segments)
 * @param options - Optional profileId and provider/model/apiKey override for the DNA generation call
 */
export const generateDocumentDna = async (
  documentId: string,
  options?: { profileId?: string | null; provider?: string; model?: string; apiKey?: string; yandexFolderId?: string },
): Promise<DocumentDnaPayload> => {
  const document = await prisma.document.findUnique({
    where: { id: documentId },
    select: { id: true, projectId: true, name: true, sourceLocale: true, targetLocale: true, profileId: true },
  });
  if (!document) {
    throw ApiError.notFound('Document not found');
  }

  const effectiveProfileId = options?.profileId ?? document.profileId ?? null;
  let profile: { name: string; expertRole: string; instructions: string; terminologyJSON: unknown } | null = null;
  if (effectiveProfileId) {
    const row = await prisma.profile.findUnique({
      where: { id: effectiveProfileId },
      select: { name: true, expertRole: true, instructions: true, terminologyJSON: true },
    });
    if (row) {
      profile = row;
      logger.info(
        { documentId, profileId: effectiveProfileId, profileName: profile.name },
        'Document DNA: using profile for expertRole and instructions',
      );
    }
  }

  const segments = await prisma.segment.findMany({
    where: { documentId },
    orderBy: { segmentIndex: 'asc' },
    select: { sourceText: true },
  });
  if (segments.length === 0) {
    logger.warn({ documentId }, 'Document has no segments; skipping Document DNA generation');
    return {};
  }

  const nonEmpty = segments
    .map((s) => s.sourceText.trim())
    .filter((t) => t.length > 0);
  const fullText = nonEmpty.join('\n\n');
  if (!fullText) {
    logger.warn({ documentId }, 'No source text in segments; skipping Document DNA generation');
    return {};
  }

  // Segment start offsets in fullText (for gap annotation in stride sampling)
  const segmentStarts: number[] = [];
  let offset = 0;
  for (let i = 0; i < nonEmpty.length; i++) {
    segmentStarts.push(offset);
    offset += nonEmpty[i].length + 2; // +2 for \n\n
  }
  const charOffsetToSegmentIndex = (pos: number): number => {
    let lo = 0;
    let hi = segmentStarts.length;
    while (lo < hi - 1) {
      const mid = (lo + hi) >> 1;
      if (segmentStarts[mid] <= pos) lo = mid;
      else hi = mid;
    }
    return lo;
  };

  // Use 150 fragments of 2000 chars distributed across the file whenever document exceeds one chunk,
  // so the analyst sees representative context and we stay within budget (~300k chars total).
  let textToAnalyze: string;
  if (fullText.length <= DOCUMENT_DNA_CHUNK_SIZE) {
    textToAnalyze = fullText;
  } else {
    const n = DOCUMENT_DNA_SAMPLE_COUNT;
    const chunkSize = DOCUMENT_DNA_CHUNK_SIZE;
    const L = fullText.length;
    const stride = (L - chunkSize) / Math.max(1, n - 1);
    const parts: string[] = [];
    for (let i = 0; i < n; i++) {
      const start = Math.min(Math.floor(i * stride), Math.max(0, L - chunkSize));
      const end = Math.min(start + chunkSize, L);
      parts.push(fullText.slice(start, end));
      if (i < n - 1) {
        const nextStart = Math.min(Math.floor((i + 1) * stride), Math.max(0, L - chunkSize));
        const segEnd = charOffsetToSegmentIndex(end);
        const segNext = charOffsetToSegmentIndex(nextStart);
        const gapSegments = Math.max(0, segNext - segEnd - 1);
        parts.push(`\n... [gap: ~${gapSegments} segments] ...\n`);
      }
    }
    textToAnalyze = parts.join('');
  }

  logger.info(
    { documentId, segmentCount: segments.length, fullLength: fullText.length, analyzedLength: textToAnalyze.length },
    'Generating Document DNA (pre-flight analysis)',
  );

  const sourceLocale = document.sourceLocale || 'en';
  const targetLocale = document.targetLocale || 'en';
  const sourceLangHint = getLanguageName(sourceLocale);
  const targetLangHint = getLanguageName(targetLocale);
  const direction = getTranslationDirection(sourceLocale, targetLocale);
  logger.info({ documentId, direction, sourceLocale, targetLocale }, 'Document DNA: building prompt for direction');

  const { getProvider } = await import('../ai/providers/registry');
  const { getProjectAISettings } = await import('./ai.service');
  const aiSettings = await getProjectAISettings(document.projectId);

  let apiKey: string | undefined = options?.apiKey;
  let yandexFolderId: string | undefined = options?.yandexFolderId;
  if (!apiKey && aiSettings?.config && typeof aiSettings.config === 'object' && !Array.isArray(aiSettings.config)) {
    const config = aiSettings.config as Record<string, unknown>;
    const providerName = (options?.provider ?? aiSettings?.provider)?.toLowerCase();
    const keyName = providerName ? `${providerName}ApiKey` : null;
    if (keyName && keyName in config) apiKey = config[keyName] as string;
    else if ('apiKey' in config) apiKey = config.apiKey as string;
    if ('yandexFolderId' in config) yandexFolderId = config.yandexFolderId as string;
  }

  const provider = getProvider(options?.provider ?? aiSettings?.provider, apiKey, yandexFolderId);
  const model = options?.model ?? aiSettings?.model ?? provider.defaultModel;

  // Get model's max context tokens (approximate)
  // OpenAI: gpt-4o-mini = 128k, gpt-4o = 128k, gpt-4-turbo = 128k
  // Gemini: gemini-1.5-pro = 1M, gemini-2.0-flash = 1M
  // Yandex: yandexgpt-lite = 8k
  // DeepSeek: deepseek-chat = 32k
  const getMaxContextTokens = (providerName: string, modelName: string): number => {
    if (providerName === 'openai') {
      if (modelName.includes('gpt-4o')) return 128_000;
      if (modelName.includes('gpt-4-turbo')) return 128_000;
      if (modelName.includes('gpt-4')) return 8_192;
      if (modelName.includes('gpt-3.5')) return 16_384;
      return 128_000; // Default for newer models
    }
    if (providerName === 'gemini') {
      if (modelName.includes('1.5') || modelName.includes('2.0')) return 1_000_000;
      return 32_768; // Older models
    }
    if (providerName === 'yandex') return 8_000;
    if (providerName === 'deepseek') return 32_000;
    return 128_000; // Safe default
  };

  const maxContextTokens = getMaxContextTokens(provider.name, model);
  // Reserve tokens for system prompt, user prompt structure, and response (estimate ~10k)
  const reservedTokens = 10_000;
  const availableTokens = maxContextTokens - reservedTokens;
  
  // Estimate tokens: ~1 token per 3.5 characters (more accurate for English/Russian mixed text)
  // OpenAI uses tiktoken which is roughly 1 token per 3.5-4 chars for English, but Russian can be denser
  const estimateTokens = (text: string): number => Math.ceil(text.length / 3.5);
  
  // Build prompts to check size
  const systemPrompt = buildDnaGenerateSystemPrompt({
    sourceLocale,
    targetLocale,
    sourceLangHint,
    targetLangHint,
    profile,
    profileContext: profile?.name,
  });
  
  // If textToAnalyze is too large, reduce it further
  let finalTextToAnalyze = textToAnalyze;
  let reducedSampleCount = DOCUMENT_DNA_SAMPLE_COUNT;
  let reducedChunkSize = DOCUMENT_DNA_CHUNK_SIZE;
  
  // Build a test user prompt to check size
  let testUserPrompt = buildDnaGenerateUserPrompt({
    sourceLocale,
    targetLocale,
    sourceLangHint,
    targetLangHint,
    profile,
    documentName: document.name,
    textToAnalyze: finalTextToAnalyze,
  });
  
  let estimatedTokens = estimateTokens(systemPrompt) + estimateTokens(testUserPrompt);
  
  // If estimated tokens exceed available tokens, reduce textToAnalyze
  if (estimatedTokens > availableTokens) {
    logger.warn(
      { documentId, estimatedTokens, availableTokens, maxContextTokens, model },
      'Prompt too large for model context, reducing text sample',
    );
    
    // Reduce sample count and chunk size progressively
    while (estimatedTokens > availableTokens && (reducedSampleCount > 10 || reducedChunkSize > 500)) {
      if (reducedSampleCount > 10) {
        reducedSampleCount = Math.max(10, Math.floor(reducedSampleCount * 0.7));
      } else if (reducedChunkSize > 500) {
        reducedChunkSize = Math.max(500, Math.floor(reducedChunkSize * 0.8));
      } else {
        break;
      }
      
      // Rebuild textToAnalyze with reduced parameters
      if (fullText.length > reducedChunkSize) {
        const n = reducedSampleCount;
        const chunkSize = reducedChunkSize;
        const L = fullText.length;
        const stride = (L - chunkSize) / Math.max(1, n - 1);
        const parts: string[] = [];
        for (let i = 0; i < n; i++) {
          const start = Math.min(Math.floor(i * stride), Math.max(0, L - chunkSize));
          const end = Math.min(start + chunkSize, L);
          parts.push(fullText.slice(start, end));
          if (i < n - 1) {
            const nextStart = Math.min(Math.floor((i + 1) * stride), Math.max(0, L - chunkSize));
            const segEnd = charOffsetToSegmentIndex(end);
            const segNext = charOffsetToSegmentIndex(nextStart);
            const gapSegments = Math.max(0, segNext - segEnd - 1);
            parts.push(`\n... [gap: ~${gapSegments} segments] ...\n`);
          }
        }
        finalTextToAnalyze = parts.join('');
      } else {
        finalTextToAnalyze = fullText;
      }
      
      testUserPrompt = buildDnaGenerateUserPrompt({
        sourceLocale,
        targetLocale,
        sourceLangHint,
        targetLangHint,
        profile,
        documentName: document.name,
        textToAnalyze: finalTextToAnalyze,
      });
      
      estimatedTokens = estimateTokens(systemPrompt) + estimateTokens(testUserPrompt);
    }
    
    logger.info(
      { documentId, finalLength: finalTextToAnalyze.length, estimatedTokens, availableTokens, reducedSampleCount, reducedChunkSize },
      'Reduced text sample to fit model context',
    );
    
    // If we had to reduce significantly, log a warning that will be visible to user
    if (reducedSampleCount < DOCUMENT_DNA_SAMPLE_COUNT * 0.5 || reducedChunkSize < DOCUMENT_DNA_CHUNK_SIZE * 0.5) {
      logger.warn(
        { documentId, model, originalSampleCount: DOCUMENT_DNA_SAMPLE_COUNT, reducedSampleCount, originalChunkSize: DOCUMENT_DNA_CHUNK_SIZE, reducedChunkSize },
        'Document DNA: Significantly reduced text sample due to model context limits. Results may be less comprehensive.',
      );
    }
  }
  
  const userPrompt = buildDnaGenerateUserPrompt({
    sourceLocale,
    targetLocale,
    sourceLangHint,
    targetLangHint,
    profile,
    documentName: document.name,
    textToAnalyze: finalTextToAnalyze,
  });

  // Calculate dynamic maxTokens based on available context
  // Reserve space for input tokens and leave room for response
  const inputTokens = estimateTokens(systemPrompt) + estimateTokens(userPrompt);
  // For models with small context, be more conservative with maxTokens
  // Leave at least 20% buffer for safety
  const safeAvailableTokens = Math.floor(availableTokens * 0.8);
  const responseTokens = Math.min(
    4096, // Max we want to generate
    Math.max(1024, safeAvailableTokens - inputTokens) // Leave room for input
  );
  
  // For models with very small context (< 20k), use even more conservative approach
  const finalMaxTokens = maxContextTokens < 20000 
    ? Math.min(responseTokens, Math.floor(safeAvailableTokens * 0.25)) // Use max 25% of safe context for response
    : responseTokens;
  
  logger.info(
    { documentId, model, inputTokens, availableTokens, safeAvailableTokens, finalMaxTokens, maxContextTokens },
    'Document DNA: calculated maxTokens for response',
  );
  
  // Double-check: if input tokens alone exceed available, we need to reduce more
  if (inputTokens > safeAvailableTokens) {
    logger.warn(
      { documentId, model, inputTokens, safeAvailableTokens, maxContextTokens },
      'Document DNA: Input tokens still exceed safe available tokens after reduction',
    );
    throw ApiError.badRequest(
      `Document is too large for the selected model (${model}). Even after reducing the text sample, ` +
      `the prompt requires approximately ${inputTokens} tokens, but the model only supports ${maxContextTokens} tokens. ` +
      `Please use a model with a larger context window (e.g., Gemini 1.5 Pro or GPT-4o).`,
    );
  }

  logger.info(
    { documentId, provider: provider.name, model, hasApiKey: !!apiKey, finalMaxTokens },
    'Document DNA: calling AI model',
  );

  let response;
  try {
    response = await provider.callModel({
      prompt: userPrompt,
      systemPrompt,
      model,
      temperature: 0.2,
      maxTokens: finalMaxTokens,
      segments: [],
    });
  } catch (error: any) {
    const errorMessage = error.message || 'Unknown error';
    logger.error(
      { documentId, provider: provider.name, model, error: errorMessage, stack: error.stack, estimatedTokens, availableTokens },
      'Document DNA: AI model call failed',
    );
    
    // Provide more specific error messages for common issues
    if (errorMessage.includes('context_length_exceeded') || errorMessage.includes('maximum context length')) {
      throw ApiError.badRequest(
        `Document is too large for the selected model (${model}). The document requires approximately ${estimatedTokens} tokens, but the model only supports ${maxContextTokens} tokens. ` +
        `Please try using a model with a larger context window (e.g., Gemini 1.5 Pro) or reduce the document size. ` +
        `The system attempted to reduce the text sample but it was still too large.`,
      );
    }
    
    if (errorMessage.includes('rate_limit') || errorMessage.includes('rate limit')) {
      throw ApiError.tooManyRequests(
        `Rate limit exceeded for ${provider.name}. Please wait a moment and try again.`,
      );
    }
    
    if (errorMessage.includes('invalid_api_key') || errorMessage.includes('authentication')) {
      throw ApiError.unauthorized(
        `Invalid API key for ${provider.name}. Please check your AI provider settings in project settings.`,
      );
    }
    
    throw ApiError.internalServerError(
      `Failed to generate Document DNA using ${provider.name} (${model}): ${errorMessage}. ` +
      `Please check your AI provider settings and API keys, or try a different model.`,
    );
  }

  const rawText = (response.outputText || '').trim();
  if (!rawText) {
    logger.error({ documentId, provider: provider.name, model }, 'Document DNA: AI returned empty response');
    throw ApiError.internalServerError('AI model returned empty response. Please try again or check your AI provider settings.');
  }

  const cleaned = cleanJsonOutput(rawText);
  let payload: DocumentDnaPayload = {};
  try {
    let parsed: unknown;
    try {
      parsed = JSON.parse(cleaned);
    } catch (parseError) {
      const msg = (parseError as Error).message || '';
      if (msg.includes('Unterminated') || msg.includes('Unexpected end of JSON')) {
        const repaired = repairTruncatedDnaJson(cleaned);
        parsed = JSON.parse(repaired);
        logger.warn({ documentId, repairedLength: repaired.length }, 'Document DNA: parsed after repairing truncated JSON');
      } else if (msg.includes('Expected') && (msg.includes('property name') || msg.includes('double-quoted'))) {
        const repaired = repairRelaxedDnaJson(cleaned);
        parsed = JSON.parse(repaired);
        logger.warn({ documentId }, 'Document DNA: parsed after relaxing single-quoted keys / trailing commas');
      } else {
        throw parseError;
      }
    }
    if (typeof parsed === 'object' && parsed !== null) {
      payload = {
        technicalSchema: (parsed as Record<string, unknown>).technicalSchema ?? null,
        namingConventions: (parsed as Record<string, unknown>).namingConventions ?? null,
        abbreviationLogic: (parsed as Record<string, unknown>).abbreviationLogic ?? null,
        entityGroups: (parsed as Record<string, unknown>).entityGroups ?? null,
      };
    } else {
      logger.warn({ documentId }, 'Document DNA: parsed result is not an object');
    }
  } catch (e) {
    const errMsg = (e as Error).message || '';
    logger.error(
      {
        documentId,
        error: errMsg,
        cleanedPreview: cleaned.substring(0, 500),
        cleanedLength: cleaned.length,
      },
      'Document DNA JSON parse failed',
    );
    throw ApiError.internalServerError(
      `Failed to parse DNA JSON from AI response: ${errMsg}. The AI model may have returned invalid JSON. Please try again.`,
    );
  }

  // Optional QC step (LLM-as-judge): filter low-scoring term pairs when dnaQcEnabled is set
  const config = aiSettings?.config && typeof aiSettings.config === 'object' && !Array.isArray(aiSettings.config)
    ? (aiSettings.config as Record<string, unknown>)
    : undefined;
  if (config?.dnaQcEnabled === true && payload.abbreviationLogic && typeof payload.abbreviationLogic === 'object') {
    const scores = await runDnaTermQc(provider, model, payload.abbreviationLogic, sourceLocale, targetLocale);
    if (scores.size > 0) {
      const filtered: Record<string, unknown> = {};
      for (const [key, val] of Object.entries(payload.abbreviationLogic!)) {
        const score = scores.get(key) ?? 5;
        if (score >= DNA_QC_MIN_SCORE) filtered[key] = val;
        else logger.debug({ documentId, key, score }, 'Document DNA QC: filtered out low-scoring term');
      }
      payload = { ...payload, abbreviationLogic: Object.keys(filtered).length > 0 ? filtered : {} };
    }
  }

  // Validate that we have some data before saving
  const hasData = payload.technicalSchema || payload.namingConventions || 
                  payload.abbreviationLogic || payload.entityGroups;
  
  if (!hasData) {
    logger.warn({ documentId, model }, 'Document DNA: Generated payload is empty, not saving');
    throw ApiError.internalServerError(
      'AI model returned empty DNA payload. The model may not have been able to analyze the document. ' +
      'Please try again or use a different model with a larger context window.',
    );
  }

  const toJson = (v: Record<string, unknown> | null | undefined): Prisma.InputJsonValue | undefined =>
    v === undefined ? undefined : v === null ? Prisma.JsonNull : (v as Prisma.InputJsonValue);

  await prisma.documentDna.upsert({
    where: { documentId },
    create: {
      documentId,
      technicalSchema: toJson(payload.technicalSchema ?? undefined),
      namingConventions: toJson(payload.namingConventions ?? undefined),
      abbreviationLogic: toJson(payload.abbreviationLogic ?? undefined),
      entityGroups: toJson(payload.entityGroups ?? undefined),
    },
    update: {
      technicalSchema: toJson(payload.technicalSchema ?? undefined),
      namingConventions: toJson(payload.namingConventions ?? undefined),
      abbreviationLogic: toJson(payload.abbreviationLogic ?? undefined),
      entityGroups: toJson(payload.entityGroups ?? undefined),
      updatedAt: new Date(),
    },
  });

  logger.info({ documentId, model, hasData: true }, 'Document DNA generated and saved');
  return payload;
};

/**
 * Get Document DNA for a document (for API / UI).
 */
export const getDocumentDna = async (documentId: string): Promise<DocumentDnaPayload | null> => {
  const row = await prisma.documentDna.findUnique({
    where: { documentId },
    select: {
      technicalSchema: true,
      namingConventions: true,
      abbreviationLogic: true,
      entityGroups: true,
    },
  });
  if (!row) return null;
  return {
    technicalSchema: row.technicalSchema as Record<string, unknown> | null | undefined,
    namingConventions: row.namingConventions as Record<string, unknown> | null | undefined,
    abbreviationLogic: row.abbreviationLogic as Record<string, unknown> | null | undefined,
    entityGroups: row.entityGroups as Record<string, unknown> | null | undefined,
  };
};

/** Max characters of document text to send to glossary extraction LLM. */
const GLOSSARY_EXTRACT_TEXT_LIMIT = 40_000;

/**
 * Extract glossary term pairs from document text via LLM and upsert as CANDIDATE entries (for review).
 * Uses project AI settings. Optional provider/model/apiKey override in options.
 */
export async function extractGlossaryFromDocument(
  documentId: string,
  options?: { provider?: string; model?: string; apiKey?: string; yandexFolderId?: string },
): Promise<{ added: number; entries: GlossaryExtractPair[] }> {
  const document = await prisma.document.findUnique({
    where: { id: documentId },
    select: { id: true, projectId: true, name: true, sourceLocale: true, targetLocale: true },
  });
  if (!document?.projectId) {
    throw ApiError.notFound('Document not found or has no project');
  }

  const segments = await prisma.segment.findMany({
    where: { documentId },
    orderBy: { segmentIndex: 'asc' },
    select: { sourceText: true },
  });
  const fullText = segments.map((s) => s.sourceText.trim()).filter(Boolean).join('\n\n');
  if (!fullText) {
    throw ApiError.badRequest('Document has no segment text to extract from');
  }
  const textSample = fullText.length > GLOSSARY_EXTRACT_TEXT_LIMIT
    ? fullText.slice(0, GLOSSARY_EXTRACT_TEXT_LIMIT) + '\n... [truncated]'
    : fullText;

  const sourceLocale = document.sourceLocale || 'en';
  const targetLocale = document.targetLocale || 'en';
  const { getProvider } = await import('../ai/providers/registry');
  const { getProjectAISettings } = await import('./ai.service');
  const aiSettings = await getProjectAISettings(document.projectId);
  let apiKey: string | undefined = options?.apiKey;
  let yandexFolderId: string | undefined = options?.yandexFolderId;
  if (!apiKey && aiSettings?.config && typeof aiSettings.config === 'object' && !Array.isArray(aiSettings.config)) {
    const config = aiSettings.config as Record<string, unknown>;
    const providerName = (options?.provider ?? aiSettings?.provider)?.toLowerCase();
    const keyName = providerName ? `${providerName}ApiKey` : null;
    if (keyName && keyName in config) apiKey = config[keyName] as string;
    else if ('apiKey' in config) apiKey = config.apiKey as string;
    if ('yandexFolderId' in config) yandexFolderId = config.yandexFolderId as string;
  }
  const provider = getProvider(options?.provider ?? aiSettings?.provider, apiKey, yandexFolderId);
  const model = options?.model ?? aiSettings?.model ?? provider.defaultModel;

  const systemPrompt = buildGlossaryExtractSystemPrompt({ sourceLocale, targetLocale });
  const userPrompt = buildGlossaryExtractUserPrompt({
    documentName: document.name,
    textSample,
    sourceLocale,
    targetLocale,
  });

  let rawText: string;
  try {
    const response = await provider.callModel({
      prompt: userPrompt,
      systemPrompt,
      model,
      temperature: 0.2,
      maxTokens: 4096,
      segments: [] as { segmentId: string; sourceText: string }[],
    });
    rawText = (response?.outputText || '').trim();
  } catch (err) {
    logger.error({ documentId, err: (err as Error).message }, 'Glossary extraction failed');
    throw ApiError.internalServerError(
      `Glossary extraction failed: ${(err as Error).message}. Check AI provider settings.`,
    );
  }

  const cleaned = rawText.replace(/^```(?:json)?\s*\n?/i, '').replace(/\n?```\s*$/i, '').trim();
  let pairs: GlossaryExtractPair[] = [];
  try {
    const parsed = JSON.parse(cleaned);
    if (Array.isArray(parsed)) {
      pairs = parsed
        .filter((item: unknown) => item && typeof item === 'object' && 'sourceTerm' in item && 'targetTerm' in item)
        .map((item: { sourceTerm?: string; targetTerm?: string }) => ({
          sourceTerm: String((item as { sourceTerm?: string }).sourceTerm ?? '').trim(),
          targetTerm: String((item as { targetTerm?: string }).targetTerm ?? '').trim(),
        }))
        .filter((p) => p.sourceTerm.length > 0 && p.targetTerm.length > 0);
    }
  } catch {
    logger.warn({ documentId }, 'Glossary extraction: could not parse LLM response as JSON array');
    return { added: 0, entries: [] };
  }

  let added = 0;
  for (const { sourceTerm, targetTerm } of pairs) {
    try {
      await upsertGlossaryEntry({
        projectId: document.projectId,
        sourceTerm,
        targetTerm,
        sourceLocale,
        targetLocale,
        status: 'CANDIDATE',
      });
      added += 1;
    } catch (e) {
      logger.debug({ documentId, sourceTerm, err: (e as Error).message }, 'Glossary extraction: skip duplicate or invalid');
    }
  }
  logger.info({ documentId, added, total: pairs.length }, 'Glossary extraction completed');
  return { added, entries: pairs };
}

/**
 * Build a short document summary string from Document DNA payload.
 * Used to fill document.summary so DNA is the single source of truth for context.
 */
export function summaryFromDna(payload: DocumentDnaPayload | null | undefined): string {
  if (!payload || (Object.keys(payload).length === 0)) {
    return '';
  }
  const parts: string[] = [];
  if (payload.technicalSchema && typeof payload.technicalSchema === 'object' && Object.keys(payload.technicalSchema).length > 0) {
    parts.push('Technical domain: ' + Object.keys(payload.technicalSchema).slice(0, 5).join(', '));
  }
  if (payload.abbreviationLogic && typeof payload.abbreviationLogic === 'object' && Object.keys(payload.abbreviationLogic).length > 0) {
    const abbrevs = Object.entries(payload.abbreviationLogic).slice(0, 8).map(([k, v]) => `${k}→${v}`).join('; ');
    parts.push('Key abbreviations: ' + abbrevs);
  }
  if (payload.namingConventions && typeof payload.namingConventions === 'object' && Object.keys(payload.namingConventions).length > 0) {
    parts.push('Naming conventions present.');
  }
  if (payload.entityGroups && typeof payload.entityGroups === 'object' && Object.keys(payload.entityGroups).length > 0) {
    parts.push('Entity groups defined.');
  }
  return parts.length ? parts.join(' ') : '';
}

/**
 * Update Document DNA manually (for API / UI).
 */
export const updateDocumentDna = async (
  documentId: string,
  payload: DocumentDnaPayload,
): Promise<DocumentDnaPayload> => {
  const toJson = (v: Record<string, unknown> | null | undefined): Prisma.InputJsonValue | undefined =>
    v === undefined ? undefined : v === null ? Prisma.JsonNull : (v as Prisma.InputJsonValue);

  await prisma.documentDna.upsert({
    where: { documentId },
    create: {
      documentId,
      technicalSchema: toJson(payload.technicalSchema ?? undefined),
      namingConventions: toJson(payload.namingConventions ?? undefined),
      abbreviationLogic: toJson(payload.abbreviationLogic ?? undefined),
      entityGroups: toJson(payload.entityGroups ?? undefined),
    },
    update: {
      technicalSchema: toJson(payload.technicalSchema ?? undefined),
      namingConventions: toJson(payload.namingConventions ?? undefined),
      abbreviationLogic: toJson(payload.abbreviationLogic ?? undefined),
      entityGroups: toJson(payload.entityGroups ?? undefined),
      updatedAt: new Date(),
    },
  });
  const updated = await getDocumentDna(documentId);
  return updated ?? payload;
};

/**
 * Refine Document DNA: review current DNA against full document text, fix term inaccuracies and fill nulls.
 * Uses project AI settings. Requires existing DNA in DB.
 * @param options.preview - If true, return refined payload without saving to DB (for comparison UI).
 */
export const refineDocumentDna = async (
  documentId: string,
  options?: { provider?: string; model?: string; apiKey?: string; yandexFolderId?: string; preview?: boolean },
): Promise<DocumentDnaPayload> => {
  const document = await prisma.document.findUnique({
    where: { id: documentId },
    select: { id: true, projectId: true, name: true, sourceLocale: true, targetLocale: true },
  });
  if (!document) {
    throw ApiError.notFound('Document not found');
  }

  const currentDna = await getDocumentDna(documentId);
  if (!currentDna || (Object.keys(currentDna).length === 0)) {
    throw ApiError.badRequest('Document has no DNA to refine. Run regenerate first.');
  }

  const segments = await prisma.segment.findMany({
    where: { documentId },
    orderBy: { segmentIndex: 'asc' },
    select: { sourceText: true },
  });
  if (segments.length === 0) {
    throw ApiError.badRequest('Document has no segments.');
  }

  const fullText = segments.map((s) => s.sourceText.trim()).filter(Boolean).join('\n\n');
  const textToUse =
    fullText.length <= DOCUMENT_DNA_CHUNK_SIZE
      ? fullText
      : buildStrideSampledText(fullText);

  const dnaJson = JSON.stringify(currentDna, null, 2);

  const sourceLocale = document.sourceLocale || 'en';
  const targetLocale = document.targetLocale || 'en';

  const systemPromptRefine = buildDnaRefineSystemPrompt({ sourceLocale, targetLocale });
  const userPromptRefine = buildDnaRefineUserPrompt({
    sourceLocale,
    targetLocale,
    documentName: document.name,
    currentDnaJson: dnaJson,
    textToUse,
  });

  const { getProvider } = await import('../ai/providers/registry');
  const { getProjectAISettings } = await import('./ai.service');
  const aiSettings = await getProjectAISettings(document.projectId);

  let apiKey: string | undefined = options?.apiKey;
  let yandexFolderId: string | undefined = options?.yandexFolderId;
  if (!apiKey && aiSettings?.config && typeof aiSettings.config === 'object' && !Array.isArray(aiSettings.config)) {
    const config = aiSettings.config as Record<string, unknown>;
    const providerName = (options?.provider ?? aiSettings?.provider)?.toLowerCase();
    const keyName = providerName ? `${providerName}ApiKey` : null;
    if (keyName && keyName in config) apiKey = config[keyName] as string;
    else if ('apiKey' in config) apiKey = config.apiKey as string;
    if ('yandexFolderId' in config) yandexFolderId = config.yandexFolderId as string;
  }

  const provider = getProvider(options?.provider ?? aiSettings?.provider, apiKey, yandexFolderId);
  const providerName = (options?.provider ?? aiSettings?.provider)?.toLowerCase() ?? 'gemini';
  const model =
    options?.model ??
    aiSettings?.model ??
    (providerName === 'openai' ? 'gpt-4o' : providerName === 'gemini' ? 'gemini-1.5-pro' : provider.defaultModel);

  const response = await provider.callModel({
    prompt: userPromptRefine,
    systemPrompt: systemPromptRefine,
    model,
    temperature: 0.2,
    maxTokens: 4096,
    segments: [],
  });

  const rawText = (response.outputText || '').trim();
  // Revisor may output DRAFT then "FINAL JSON:" + JSON; extract JSON part for parsing
  const finalJsonMarker = /FINAL JSON:\s*/i;
  const jsonPart = finalJsonMarker.test(rawText) ? rawText.replace(/^[\s\S]*?FINAL JSON:\s*/i, '').trim() : rawText;
  const cleaned = cleanJsonOutput(jsonPart);
  let payload: DocumentDnaPayload = {};
  try {
    const parsed = JSON.parse(cleaned);
    if (typeof parsed === 'object' && parsed !== null) {
      payload = {
        technicalSchema: parsed.technicalSchema ?? null,
        namingConventions: parsed.namingConventions ?? null,
        abbreviationLogic: parsed.abbreviationLogic ?? null,
        entityGroups: parsed.entityGroups ?? null,
      };
    }
  } catch (e) {
    logger.warn({ documentId, error: (e as Error).message }, 'Refine DNA JSON parse failed; keeping current DNA');
    return currentDna;
  }

  if (options?.preview) {
    // Return normalized payload so "Accept Refinement" (PUT /dna) always receives a valid shape.
    try {
      const normalized = normalizeDocumentDnaPayload(payload);
      logger.info({ documentId }, 'Document DNA refined (preview only, not saved)');
      return normalized;
    } catch (normErr: any) {
      logger.warn({ documentId, error: normErr?.message }, 'Refine DNA normalization failed; returning raw payload');
      return payload;
    }
  }

  const toJson = (v: Record<string, unknown> | null | undefined): Prisma.InputJsonValue | undefined =>
    v === undefined ? undefined : v === null ? Prisma.JsonNull : (v as Prisma.InputJsonValue);

  await prisma.documentDna.upsert({
    where: { documentId },
    create: {
      documentId,
      technicalSchema: toJson(payload.technicalSchema ?? undefined),
      namingConventions: toJson(payload.namingConventions ?? undefined),
      abbreviationLogic: toJson(payload.abbreviationLogic ?? undefined),
      entityGroups: toJson(payload.entityGroups ?? undefined),
    },
    update: {
      technicalSchema: toJson(payload.technicalSchema ?? undefined),
      namingConventions: toJson(payload.namingConventions ?? undefined),
      abbreviationLogic: toJson(payload.abbreviationLogic ?? undefined),
      entityGroups: toJson(payload.entityGroups ?? undefined),
      updatedAt: new Date(),
    },
  });

  logger.info({ documentId }, 'Document DNA refined and saved');
  return payload;
};

/**
 * Perform semantic analysis to extract domain, tone, and translation strategy
 * This provides global context that applies to the entire document
 * 
 * @param documentId - The document ID to analyze
 * @returns Object with detectedDomain, detectedTone, and translationStrategy
 */
export const performSemanticAnalysis = async (documentId: string): Promise<{
  detectedDomain: string | null;
  detectedTone: string | null;
  translationStrategy: string | null;
}> => {
  // Check for cancellation before starting
  if (isAnalysisCancelled(documentId)) {
    throw new Error('Analysis cancelled by user');
  }

  await updateProgress(documentId, 'semantic_analysis', 2, 'Performing semantic analysis...', false);
  
  // Get document with segments
  const document = await prisma.document.findUnique({
    where: { id: documentId },
    include: {
      segments: {
        where: {
          sourceText: { not: '' },
        },
        orderBy: { segmentIndex: 'asc' },
        take: 100, // Use first 100 segments for semantic analysis
        select: {
          sourceText: true,
        },
      },
    },
  });

  if (!document) {
    throw ApiError.notFound('Document not found');
  }

  if (document.segments.length === 0) {
    logger.warn({ documentId }, 'Document has no segments for semantic analysis');
    return {
      detectedDomain: null,
      detectedTone: null,
      translationStrategy: null,
    };
  }

  // Build document content: join source text segments
  const documentContent = document.segments
    .map((segment) => segment.sourceText)
    .filter((text) => text.trim().length > 0)
    .join('\n\n');

  if (!documentContent.trim()) {
    logger.warn({ documentId }, 'No source text found in document segments for semantic analysis');
    return {
      detectedDomain: null,
      detectedTone: null,
      translationStrategy: null,
    };
  }

  // Limit to ~3,000 tokens (approximately 12,000 characters, assuming ~4 chars per token)
  // This ensures we stay within token limits while getting enough context
  const maxChars = 12000;
  const sampleText = documentContent.length > maxChars 
    ? documentContent.substring(0, maxChars) + '...'
    : documentContent;

  logger.debug(
    {
      documentId,
      segmentsCount: document.segments.length,
      contentLength: documentContent.length,
      sampleLength: sampleText.length,
      samplePreview: sampleText.substring(0, 200),
    },
    'Sending text sample to AI for semantic analysis',
  );

  // Check for cancellation before AI call
  if (isAnalysisCancelled(documentId)) {
    throw new Error('Analysis cancelled by user');
  }

  await updateProgress(documentId, 'ai_semantic', 5, 'Calling AI for semantic analysis...', false);

  // Define specialized AI prompt for semantic analysis
  const systemPrompt = `You are a Localization Engineer and Translation Strategy Expert.

Analyze the provided source text sample to extract high-level semantic context for translation purposes.

Focus on:
1. **Domain**: Identify the specific industry, field, or topic (e.g., "Oil & Gas", "Aviation", "Legal", "Medical", "Marketing", "Technical Documentation").
2. **Tone**: Identify the register and style (e.g., "Formal, Technical", "Marketing, Persuasive", "Legal, Precise", "Informal, Conversational").
3. **Translation Strategy**: Provide 1-2 sentences of strategic advice for translators working on this document (e.g., "Use imperative mood for instructions; preserve acronyms; maintain formal register throughout").

Return ONLY a valid JSON object with this exact structure:
{
  "domain": "Oil & Gas",
  "tone": "Formal, Technical",
  "strategy": "Use imperative mood for instructions; preserve technical acronyms; maintain formal register throughout."
}

CRITICAL REQUIREMENTS:
- Return ONLY the JSON object, no markdown code blocks, no additional text before or after
- Do NOT wrap the response in \`\`\`json code blocks
- The object must have exactly "domain", "tone", and "strategy" fields
- "domain" should be a concise industry/topic identifier
- "tone" should describe the register and style
- "strategy" should be 1-2 sentences of actionable translation advice
- If you cannot determine a field, use null (but prefer making an educated inference)`;

  const userPrompt = `Here is a sample of the source text content:

${sampleText}

Analyze this text and extract the domain, tone, and translation strategy. Return a JSON object.`;

  // Get AI provider and settings
  const { getProvider } = await import('../ai/providers/registry');
  const { getProjectAISettings } = await import('./ai.service');
  
  const aiSettings = await getProjectAISettings(document.projectId);
  
  // Extract API key from project settings config
  let apiKey: string | undefined;
  let yandexFolderId: string | undefined;
  
  if (aiSettings?.config && typeof aiSettings.config === 'object' && !Array.isArray(aiSettings.config)) {
    const config = aiSettings.config as Record<string, unknown>;
    const providerName = aiSettings.provider?.toLowerCase();
    
    // Try provider-specific key first
    const providerKeyName = providerName ? `${providerName}ApiKey` : null;
    if (providerKeyName && providerKeyName in config) {
      apiKey = config[providerKeyName] as string;
    }
    // Fallback to legacy apiKey field
    else if ('apiKey' in config) {
      apiKey = config.apiKey as string;
    }
    
    // Extract Yandex Folder ID if available
    if ('yandexFolderId' in config) {
      yandexFolderId = config.yandexFolderId as string;
    }
  }
  
  const provider = getProvider(aiSettings?.provider, apiKey, yandexFolderId);
  const model = aiSettings?.model ?? provider.defaultModel;

  logger.info(
    {
      documentId,
      segmentsCount: document.segments.length,
      provider: provider.name,
      model,
    },
    'Performing semantic analysis on document',
  );

  // Call AI with custom systemPrompt and low temperature
  let aiResponse;
  let responseText: string;
  
  try {
    // Check for cancellation before AI call
    if (isAnalysisCancelled(documentId)) {
      throw new Error('Analysis cancelled by user');
    }

    const aiCallPromise = provider.callModel({
      prompt: userPrompt,
      systemPrompt,
      model,
      temperature: 0.1, // Low temperature for consistent extraction
      maxTokens: 512, // Semantic analysis should be concise
      segments: [], // Not needed for semantic analysis
    });

    // Add timeout for semantic analysis (30 seconds)
    const timeoutPromise = new Promise<never>((_, reject) => {
      setTimeout(() => {
        reject(new Error('AI call timeout after 30 seconds'));
      }, 30000);
    });

    // Cancellation promise - rejects if analysis is cancelled
    const cancellationPromise = new Promise<never>((_, reject) => {
      const checkCancellation = setInterval(() => {
        if (isAnalysisCancelled(documentId)) {
          clearInterval(checkCancellation);
          reject(new Error('Analysis cancelled by user'));
        }
      }, 1000); // Check every second
      
      // Clean up interval when promise resolves/rejects
      timeoutPromise.catch(() => clearInterval(checkCancellation));
      aiCallPromise.catch(() => clearInterval(checkCancellation));
    });

    aiResponse = await Promise.race([aiCallPromise, timeoutPromise, cancellationPromise]);
    responseText = aiResponse.outputText.trim();

    logger.debug(
      {
        documentId,
        responseLength: responseText.length,
        responsePreview: responseText.substring(0, 200),
      },
      'Received AI response for semantic analysis',
    );
  } catch (error: any) {
    logger.error(
      {
        documentId,
        error: error.message,
        errorStack: error.stack,
      },
      'AI call failed during semantic analysis',
    );

    // Provide user-friendly error messages
    if (error.message?.includes('API key not valid') || error.message?.includes('API_KEY_INVALID')) {
      throw ApiError.badRequest(
        `Invalid ${provider.name} API key. Please check your AI settings and ensure a valid API key is configured.`,
      );
    }
    if (error.message?.includes('API key')) {
      throw ApiError.badRequest(
        `API key error: ${error.message}. Please check your AI settings.`,
      );
    }
    if (error.message?.includes('quota') || error.message?.includes('rate limit')) {
      throw ApiError.badRequest(
        `API quota or rate limit exceeded. Please try again later or check your ${provider.name} account limits.`,
      );
    }

    // Generic error fallback
    throw ApiError.badRequest(
      `Failed to perform semantic analysis: ${error.message || 'Unknown error occurred'}. Please check your AI provider settings.`,
    );
  }

  // Parse JSON response
  let semanticData: {
    domain?: string | null;
    tone?: string | null;
    strategy?: string | null;
  } = {};
  
  try {
    // Clean markdown code blocks before parsing
    const cleanedResponse = cleanJsonOutput(responseText);
    
    logger.debug(
      {
        documentId,
        originalLength: responseText.length,
        cleanedLength: cleanedResponse.length,
        wasCleaned: responseText !== cleanedResponse,
      },
      'Cleaned JSON output from markdown code blocks (semantic analysis)',
    );

    const parsed = JSON.parse(cleanedResponse);
    
    if (typeof parsed === 'object' && parsed !== null) {
      semanticData = {
        domain: parsed.domain || null,
        tone: parsed.tone || null,
        strategy: parsed.strategy || null,
      };
    } else {
      throw new Error('Parsed result is not an object');
    }

    logger.debug(
      {
        documentId,
        detectedDomain: semanticData.domain,
        detectedTone: semanticData.tone,
        hasStrategy: !!semanticData.strategy,
      },
      'Successfully parsed semantic analysis from AI response',
    );
  } catch (parseError: any) {
    logger.error(
      {
        documentId,
        parseError: parseError.message,
        responseText: responseText.substring(0, 500),
      },
      'Failed to parse semantic analysis JSON from AI response',
    );
    
    // Return null values on parse error (non-fatal)
    return {
      detectedDomain: null,
      detectedTone: null,
      translationStrategy: null,
    };
  }

  // Save to DocumentAnalysis
  try {
    await prisma.documentAnalysis.upsert({
      where: { documentId },
      create: {
        documentId,
        detectedDomain: semanticData.domain || null,
        detectedTone: semanticData.tone || null,
        translationStrategy: semanticData.strategy || null,
        status: 'RUNNING', // Will be updated by runFullAnalysis
      },
      update: {
        detectedDomain: semanticData.domain || null,
        detectedTone: semanticData.tone || null,
        translationStrategy: semanticData.strategy || null,
      },
    });

    logger.info(
      {
        documentId,
        detectedDomain: semanticData.domain,
        detectedTone: semanticData.tone,
        hasStrategy: !!semanticData.strategy,
      },
      'Semantic analysis completed and saved',
    );
  } catch (dbError: any) {
    logger.error(
      {
        documentId,
        dbError: dbError.message,
      },
      'Failed to save semantic analysis to database',
    );
    // Non-fatal: continue even if save fails
  }

  return {
    detectedDomain: semanticData.domain || null,
    detectedTone: semanticData.tone || null,
    translationStrategy: semanticData.strategy || null,
  };
};

export const extractStyleRules = async (documentId: string): Promise<{ count: number }> => {
  // Check for cancellation before starting
  if (isAnalysisCancelled(documentId)) {
    throw new Error('Analysis cancelled by user');
  }

  await updateProgress(documentId, 'fetching', 5, 'Fetching document segments for style analysis...', false);
  
  // Get document with segments
  const document = await prisma.document.findUnique({
    where: { id: documentId },
    include: {
      segments: {
        where: {
          sourceText: { not: '' },
        },
        orderBy: { segmentIndex: 'asc' },
        take: 50, // Use first 50 segments for analysis (or could use random sample)
        select: {
          sourceText: true,
        },
      },
    },
  });

  if (!document) {
    throw ApiError.notFound('Document not found');
  }

  if (document.segments.length === 0) {
    throw ApiError.badRequest('Document has no segments to analyze');
  }

  // Build document content: join source text segments
  const documentContent = document.segments
    .map((segment) => segment.sourceText)
    .filter((text) => text.trim().length > 0)
    .join('\n\n');

  if (!documentContent.trim()) {
    throw ApiError.badRequest('No source text found in document segments');
  }

  // DEBUG: Log input length
  logger.debug(
    {
      documentId,
      segmentsCount: document.segments.length,
      contentLength: documentContent.length,
      contentPreview: documentContent.substring(0, 200),
    },
    `Sending ${documentContent.length} chars to AI for style rule analysis`,
  );

  // Check for cancellation before AI call
  if (isAnalysisCancelled(documentId)) {
    throw new Error('Analysis cancelled by user');
  }

  await updateProgress(documentId, 'ai_style', 30, 'Calling AI to extract style rules...', false);

  // Define specialized AI prompt for style rule extraction
  const systemPrompt = `You are a Localization Engineer and Style Guide Expert.

Analyze the provided source text samples to extract implicit formatting and style rules.

Focus on:
1. Date formats (e.g., DD.MM.YYYY vs MM/DD/YYYY, with dots vs slashes vs dashes).
2. Number formats (decimal commas vs points, thousand separators).
3. List handling (e.g., do lists start with verbs or nouns? Are they numbered or bulleted?).
4. Capitalization rules (titles, headers, sentence case vs title case).
5. Spacing rules (e.g., spaces before units like %, °C, or no spaces).
6. Time formats (24-hour vs 12-hour, with or without seconds).
7. Currency formats (symbol position, decimal places).
8. Address formats (order of components, punctuation).

Return ONLY a valid JSON array of objects with this exact structure:
[
  {
    "ruleType": "date_format",
    "pattern": "DD.MM.YYYY",
    "description": "Dates are formatted with dots, day first.",
    "examples": ["12.01.2023", "30.05.2024"]
  },
  {
    "ruleType": "list_style",
    "pattern": "verbs",
    "description": "Lists start with verbs in imperative form.",
    "examples": ["Check the settings", "Update the document"]
  }
]

CRITICAL REQUIREMENTS:
- Return ONLY the JSON array, no markdown code blocks, no additional text before or after
- Do NOT wrap the response in \`\`\`json code blocks
- Each object must have exactly "ruleType", "pattern", "description", and "examples" fields
- "ruleType" should be one of: date_format, number_format, list_style, capitalization, spacing, time_format, currency_format, address_format, or other
- "pattern" should be a concise description (e.g., "DD.MM.YYYY", "verbs", "sentence case")
- "description" should explain the rule clearly
- "examples" should be an array of strings showing examples from the text
- Only extract rules that are clearly present in the source text
- Do not make up rules that aren't evident from the text`;

  const userPrompt = `Here is the source text content:

${documentContent}

Analyze this text and extract all formatting and style rules. Return a JSON array of style rules.`;

  // Get AI provider and settings
  const { getProvider } = await import('../ai/providers/registry');
  const { getProjectAISettings } = await import('./ai.service');
  
  const aiSettings = await getProjectAISettings(document.projectId);
  
  // Extract API key from project settings config (same pattern as buildAiContext)
  let apiKey: string | undefined;
  let yandexFolderId: string | undefined;
  
  if (aiSettings?.config && typeof aiSettings.config === 'object' && !Array.isArray(aiSettings.config)) {
    const config = aiSettings.config as Record<string, unknown>;
    const providerName = aiSettings.provider?.toLowerCase();
    
    // Try provider-specific key first (e.g., geminiApiKey, openaiApiKey, yandexApiKey)
    const providerKeyName = providerName ? `${providerName}ApiKey` : null;
    if (providerKeyName && providerKeyName in config) {
      apiKey = config[providerKeyName] as string;
    }
    // Fallback to legacy apiKey field
    else if ('apiKey' in config) {
      apiKey = config.apiKey as string;
    }
    
    // Extract Yandex Folder ID if available
    if ('yandexFolderId' in config) {
      yandexFolderId = config.yandexFolderId as string;
    }
  }
  
  const provider = getProvider(aiSettings?.provider, apiKey, yandexFolderId);
  const model = aiSettings?.model ?? provider.defaultModel;

  logger.info(
    {
      documentId,
      segmentsCount: document.segments.length,
      provider: provider.name,
      model,
    },
    'Extracting style rules from document',
  );

  // Call AI with custom systemPrompt and low temperature
  let aiResponse;
  let responseText: string;
  let heartbeatInterval: NodeJS.Timeout | null = null;
  
  try {
    // Check for cancellation before AI call
    if (isAnalysisCancelled(documentId)) {
      throw new Error('Analysis cancelled by user');
    }

    const aiCallStartTime = Date.now();
    const aiCallPromise = provider.callModel({
      prompt: userPrompt,
      systemPrompt,
      model,
      temperature: 0.1, // Low temperature for consistent extraction
      maxTokens: 4096, // Allow for large rule sets
      segments: [], // Not needed for style rule extraction
    });

    // Add timeout for style rules extraction (60 seconds)
    const timeoutPromise = new Promise<never>((_, reject) => {
      setTimeout(() => {
        reject(new Error('AI call timeout after 60 seconds'));
      }, 60000);
    });

    // Cancellation promise - rejects if analysis is cancelled
    const cancellationPromise = new Promise<never>((_, reject) => {
      const checkCancellation = setInterval(() => {
        if (isAnalysisCancelled(documentId)) {
          clearInterval(checkCancellation);
          reject(new Error('Analysis cancelled by user'));
        }
      }, 1000); // Check every second
      
      // Clean up interval when promise resolves/rejects
      timeoutPromise.catch(() => clearInterval(checkCancellation));
      aiCallPromise.catch(() => clearInterval(checkCancellation));
    });

    // Start heartbeat progress updates during AI call
    heartbeatInterval = setInterval(async () => {
      // Check for cancellation in heartbeat
      if (isAnalysisCancelled(documentId)) {
        if (heartbeatInterval) clearInterval(heartbeatInterval);
        return;
      }
      
      const elapsed = Date.now() - aiCallStartTime;
      const elapsedSeconds = Math.floor(elapsed / 1000);
      await updateProgress(
        documentId,
        'ai_style',
        35,
        `Waiting for ${provider.name} response... (${elapsedSeconds}s elapsed)`,
        false,
      );
    }, 2000); // Update every 2 seconds

    // Race between AI call, timeout, and cancellation
    aiResponse = await Promise.race([aiCallPromise, timeoutPromise, cancellationPromise]) as any;
    
    if (heartbeatInterval) clearInterval(heartbeatInterval);
    const aiCallDuration = Date.now() - aiCallStartTime;
    logger.info(
      {
        documentId,
        durationMs: aiCallDuration,
      },
      `AI call for style rules completed successfully`,
    );

    responseText = aiResponse.outputText.trim();

    // DEBUG: Log raw AI response
    logger.debug(
      {
        documentId,
        responseLength: responseText.length,
        rawResponse: responseText,
      },
      'RAW AI RESPONSE received for style rule extraction',
    );
    console.log('RAW AI RESPONSE (Style Rules):', responseText);
    console.log('RAW AI RESPONSE LENGTH:', responseText.length);
  } catch (error: any) {
    // Clean up heartbeat if it exists
    if (heartbeatInterval) {
      clearInterval(heartbeatInterval);
    }
    
    // If cancelled, throw cancellation error immediately
    if (error.message?.includes('cancelled')) {
      logger.info(
        {
          documentId,
        },
        `Style rule extraction cancelled by user`,
      );
      throw error;
    }
    
    logger.error(
      {
        documentId,
        provider: provider.name,
        model,
        error: error.message,
        errorStack: error.stack,
      },
      'AI provider call failed during style rule extraction',
    );

    // Provide user-friendly error messages
    if (error.message?.includes('API key not valid') || error.message?.includes('API_KEY_INVALID')) {
      throw ApiError.badRequest(
        `Invalid ${provider.name} API key. Please check your AI settings and ensure a valid API key is configured.`,
      );
    }
    if (error.message?.includes('API key')) {
      throw ApiError.badRequest(
        `API key error: ${error.message}. Please check your AI settings.`,
      );
    }
    if (error.message?.includes('quota') || error.message?.includes('rate limit')) {
      throw ApiError.badRequest(
        `API quota or rate limit exceeded. Please try again later or check your ${provider.name} account limits.`,
      );
    }

    // Generic error fallback
    throw ApiError.badRequest(
      `Failed to extract style rules: ${error.message || 'Unknown error occurred'}. Please check your AI provider settings.`,
    );
  }

  // Parse JSON response
  let extractedRules: Array<{
    ruleType: string;
    pattern: string;
    description?: string;
    examples?: string[];
  }> = [];
  let parsedArrayLength = 0;
  try {
    logger.debug(
      {
        documentId,
        responseTextLength: responseText.length,
        responsePreview: responseText.substring(0, 300),
      },
      'Starting JSON parsing for style rules',
    );

    // Clean markdown code blocks before parsing
    const cleanedResponse = cleanJsonOutput(responseText);
    logger.debug(
      {
        documentId,
        originalLength: responseText.length,
        cleanedLength: cleanedResponse.length,
        wasCleaned: responseText !== cleanedResponse,
      },
      'Cleaned JSON output from markdown code blocks (style rules)',
    );

    const parsed = parseJsonArray(cleanedResponse, documentId);
    parsedArrayLength = parsed.length;

    logger.debug(
      {
        documentId,
        parsedArrayLength,
        firstItem: parsed[0],
        sampleItems: parsed.slice(0, 3),
      },
      'Successfully parsed JSON array from AI response (style rules)',
    );

    // Validate and normalize rules
    extractedRules = parsed
      .map((item: any, index: number) => {
        // #region agent log
        fetch('http://127.0.0.1:7242/ingest/7f529324-455d-4ca1-81c1-cbc867a5b6ab',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'analysis.service.ts:2062',message:'Processing style rule item',data:{index,itemKeys:Object.keys(item),hasRuleType:!!item.ruleType,hasPattern:!!item.pattern,hasSelector:!!item.selector,hasProperties:!!item.properties},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'A'})}).catch(()=>{});
        // #endregion
        
        if (!item || typeof item !== 'object') {
          logger.debug({ documentId, index, item }, 'Skipping invalid item (not an object)');
          return null;
        }
        
        // Try to extract ruleType and pattern - handle both expected format and AI variations
        let ruleType = String(item.ruleType || item.element_name || item.type || '').trim();
        let pattern = String(item.pattern || '').trim();
        
        // #region agent log
        fetch('http://127.0.0.1:7242/ingest/7f529324-455d-4ca1-81c1-cbc867a5b6ab',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'analysis.service.ts:2074',message:'After initial extraction',data:{ruleType,pattern,hasSelector:!!item.selector,hasProperties:!!item.properties,hasRuleName:!!item.rule_name,hasTextTransform:!!item.text_transform},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'A'})}).catch(()=>{});
        // #endregion
        
        // Handle format with rule_name and individual style fields (font_weight, text_transform, text_align) - NEW FIX
        if ((!ruleType || !pattern) && (item.rule_name || item.text_transform || item.font_weight || item.text_align)) {
          // #region agent log
          fetch('http://127.0.0.1:7242/ingest/7f529324-455d-4ca1-81c1-cbc867a5b6ab',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'analysis.service.ts:2080',message:'Detected rule_name/individual style fields format',data:{ruleName:item.rule_name,textTransform:item.text_transform,fontWeight:item.font_weight,textAlign:item.text_align},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'D'})}).catch(()=>{});
          // #endregion
          
          const styleParts: string[] = [];
          
          // Map individual style fields to ruleType and pattern
          if (item.text_transform) {
            if (!ruleType) ruleType = 'capitalization';
            styleParts.push(`text-transform: ${item.text_transform}`);
          }
          if (item.font_weight) {
            if (!ruleType && !item.text_transform) ruleType = 'other';
            styleParts.push(`font-weight: ${item.font_weight}`);
          }
          if (item.text_align) {
            if (!ruleType && !item.text_transform) ruleType = 'spacing';
            styleParts.push(`text-align: ${item.text_align}`);
          }
          if (item.font_size) {
            if (!ruleType && !item.text_transform) ruleType = 'other';
            styleParts.push(`font-size: ${item.font_size}`);
          }
          
          // Use rule_name as pattern if pattern is missing
          if (!pattern && item.rule_name) {
            pattern = String(item.rule_name).substring(0, 200).trim();
          }
          
          // If we have style parts, append them to pattern
          if (styleParts.length > 0) {
            const styleStr = styleParts.join(', ');
            if (pattern && !pattern.includes(styleStr)) {
              pattern = `${pattern} (${styleStr})`;
            } else if (!pattern) {
              pattern = styleStr;
            }
          }
          
          // Default ruleType if still missing
          if (!ruleType) {
            ruleType = 'other';
          }
          
          // #region agent log
          fetch('http://127.0.0.1:7242/ingest/7f529324-455d-4ca1-81c1-cbc867a5b6ab',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'analysis.service.ts:2120',message:'After rule_name format conversion',data:{ruleType,pattern,patternLength:pattern.length},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'D'})}).catch(()=>{});
          // #endregion
        }
        
        // Handle CSS-like format (selector + properties) - NEW FIX
        if ((!ruleType || !pattern) && item.selector && item.properties && typeof item.properties === 'object') {
          // #region agent log
          fetch('http://127.0.0.1:7242/ingest/7f529324-455d-4ca1-81c1-cbc867a5b6ab',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'analysis.service.ts:2078',message:'Detected selector/properties format',data:{selector:item.selector,propertiesKeys:Object.keys(item.properties)},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'B'})}).catch(()=>{});
          // #endregion
          
          const props = item.properties;
          const styleParts: string[] = [];
          
          // Map CSS properties to ruleType and pattern (handle both kebab-case and snake_case)
          const textTransform = props['text-transform'] || props['text_transform'];
          if (textTransform) {
            if (!ruleType) ruleType = 'capitalization';
            styleParts.push(`text-transform: ${textTransform}`);
          }
          const fontWeight = props['font-weight'] || props['font_weight'];
          if (fontWeight) {
            if (!ruleType && !textTransform) ruleType = 'other';
            styleParts.push(`font-weight: ${fontWeight}`);
          }
          const textAlign = props['text-align'] || props['text_align'];
          if (textAlign) {
            if (!ruleType && !textTransform) ruleType = 'spacing';
            styleParts.push(`text-align: ${textAlign}`);
          }
          const fontSize = props['font-size'] || props['font_size'];
          if (fontSize) {
            if (!ruleType && !textTransform) ruleType = 'other';
            styleParts.push(`font-size: ${fontSize}`);
          }
          
          // Use selector as pattern if pattern is missing
          if (!pattern) {
            pattern = String(item.selector).substring(0, 200).trim();
          }
          
          // If we have style parts, append them to pattern
          if (styleParts.length > 0 && !pattern.includes(styleParts[0])) {
            pattern = pattern ? `${pattern} (${styleParts.join(', ')})` : styleParts.join(', ');
          }
          
          // Default ruleType if still missing
          if (!ruleType) {
            ruleType = 'other';
          }
          
          // #region agent log
          fetch('http://127.0.0.1:7242/ingest/7f529324-455d-4ca1-81c1-cbc867a5b6ab',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'analysis.service.ts:2110',message:'After CSS format conversion',data:{ruleType,pattern,patternLength:pattern.length},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'B'})}).catch(()=>{});
          // #endregion
        }
        
        // If pattern is missing but we have styles object, try to extract from it
        if (!pattern && item.styles && typeof item.styles === 'object') {
          const styleParts: string[] = [];
          if (item.styles['font-size']) styleParts.push(`font-size: ${item.styles['font-size']}`);
          if (item.styles['font-weight']) styleParts.push(`font-weight: ${item.styles['font-weight']}`);
          if (item.styles['text-align']) styleParts.push(`text-align: ${item.styles['text-align']}`);
          if (item.styles['text-transform']) styleParts.push(`text-transform: ${item.styles['text-transform']}`);
          pattern = styleParts.join(', ') || 'See description';
        }
        
        // If still no pattern, use description or notes as fallback
        if (!pattern && item.description) {
          pattern = String(item.description).substring(0, 100).trim();
        }
        if (!pattern && item.notes) {
          pattern = String(item.notes).substring(0, 100).trim();
        }
        
        // If ruleType is missing, try to infer from rule_name, element_name, or use 'other'
        if (!ruleType && item.rule_name) {
          const ruleName = String(item.rule_name).toLowerCase();
          if (ruleName.includes('heading') || ruleName.includes('title')) {
            ruleType = 'capitalization';
          } else if (ruleName.includes('date') || ruleName.includes('time')) {
            ruleType = 'date_format';
          } else if (ruleName.includes('number') || ruleName.includes('currency')) {
            ruleType = 'number_format';
          } else if (ruleName.includes('list')) {
            ruleType = 'list_style';
          } else {
            ruleType = 'other';
          }
        }
        
        if (!ruleType && item.element_name) {
          const elementName = String(item.element_name).toLowerCase();
          if (elementName.includes('date') || elementName.includes('time')) {
            ruleType = 'date_format';
          } else if (elementName.includes('number') || elementName.includes('currency')) {
            ruleType = 'number_format';
          } else if (elementName.includes('list')) {
            ruleType = 'list_style';
          } else if (elementName.includes('capital') || elementName.includes('case')) {
            ruleType = 'capitalization';
          } else {
            ruleType = 'other';
          }
        }
        
        // Final fallback: ensure ruleType is set if we have a pattern
        if (!ruleType && pattern) {
          ruleType = 'other';
        }
        
        const description = item.description ? String(item.description).trim() : undefined;
        let examples: string[] | undefined = undefined;
        
        // Try to extract examples from various fields
        if (Array.isArray(item.examples)) {
          examples = item.examples.map((ex: any) => String(ex).trim()).filter((ex: string) => ex.length > 0);
        } else if (item.example) {
          // Handle singular 'example' field (from AI response format)
          examples = [String(item.example).trim()].filter((ex: string) => ex.length > 0);
        } else if (item.notes) {
          // Try to extract examples from notes field
          const notesStr = String(item.notes);
          const exampleMatch = notesStr.match(/Example:?\s*['"]([^'"]+)['"]/i);
          if (exampleMatch) {
            examples = [exampleMatch[1]];
          }
        }
        
        // #region agent log
        fetch('http://127.0.0.1:7242/ingest/7f529324-455d-4ca1-81c1-cbc867a5b6ab',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'analysis.service.ts:2250',message:'Final validation check',data:{ruleType,pattern,hasRuleType:!!ruleType,hasPattern:!!pattern,willBeFiltered:!ruleType||!pattern},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'C'})}).catch(()=>{});
        // #endregion
        
        if (!ruleType || !pattern) {
          logger.debug(
            { documentId, index, item, ruleType, pattern, itemKeys: Object.keys(item) },
            'Skipping item with empty ruleType or pattern after normalization',
          );
          return null;
        }
        
        // #region agent log
        fetch('http://127.0.0.1:7242/ingest/7f529324-455d-4ca1-81c1-cbc867a5b6ab',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'analysis.service.ts:2150',message:'Returning valid rule',data:{ruleType,pattern,description:!!description,examplesCount:examples?.length||0},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'C'})}).catch(()=>{});
        // #endregion
        
        return { ruleType, pattern, description, examples };
      })
      .filter((rule): rule is NonNullable<typeof rule> => rule !== null);

    logger.info(
      {
        documentId,
        parsedArrayLength,
        extractedRulesCount: extractedRules.length,
        sampleRules: extractedRules.slice(0, 3),
      },
      'Extracted style rules from AI response',
    );

    // DEBUG: Log if parsed array is empty
    if (parsedArrayLength === 0) {
      logger.warn(
        {
          documentId,
          responseText: responseText.substring(0, 1000),
        },
        'PARSING DEBUG: Parsed array is empty (0 items)',
      );
      console.log('PARSING DEBUG: Parsed array is empty. Full response:', responseText);
    }

    // DEBUG: Log if extracted rules is empty after validation
    if (extractedRules.length === 0 && parsedArrayLength > 0) {
      logger.warn(
        {
          documentId,
          parsedArrayLength,
          sampleParsedItems: parsed.slice(0, 3),
        },
        'PARSING DEBUG: All parsed items were filtered out during validation',
      );
      console.log('PARSING DEBUG: All items filtered. Sample items:', parsed.slice(0, 3));
      console.log('PARSING DEBUG: Full parsed array:', parsed);
    }
  } catch (error: any) {
    logger.error(
      {
        documentId,
        error: error.message,
        errorStack: error.stack,
        responsePreview: responseText.substring(0, 500),
        fullResponse: responseText.length < 2000 ? responseText : responseText.substring(0, 2000) + '...',
      },
      'PARSING DEBUG: Failed to parse AI response as JSON',
    );
    console.error('PARSING ERROR (Style Rules):', error);
    console.error('RESPONSE TEXT (Style Rules):', responseText);
    console.error('RESPONSE TEXT LENGTH:', responseText.length);
    throw ApiError.badRequest(`Failed to parse style rule extraction response: ${error.message}`);
  }

  if (extractedRules.length === 0) {
    // Check if this is a legitimate case (very small document) or an error
    const document = await prisma.document.findUnique({
      where: { id: documentId },
      select: { segments: { select: { id: true } } },
    });
    
    const segmentsCount = document?.segments.length || 0;
    
    if (segmentsCount > 20) {
      // Large document with no style rules = likely an error (parsing failure, empty response, etc.)
      logger.error(
        {
          documentId,
          segmentsCount,
          responsePreview: responseText.substring(0, 500),
          parsedArrayLength,
          responseTextLength: responseText.length,
        },
        'CRITICAL: No style rules extracted from document with substantial content - this indicates an error',
      );
      
      throw ApiError.badRequest(
        `Style rule extraction failed: AI returned no rules for a document with ${segmentsCount} segments. ` +
        `This may indicate an API error, rate limit, or parsing issue. Please check the logs and try again.`,
      );
    } else {
      // Small document - might legitimately have no style rules
      logger.info(
        {
          documentId,
          segmentsCount,
        },
        'No style rules extracted, but document is small - this may be acceptable',
      );
      // Continue - will return 0 count which is acceptable for tiny documents
    }
  }

  // Remove duplicates (same ruleType and pattern combination)
  await updateProgress(documentId, 'saving_style', 85, 'Saving extracted style rules to database...', false);
  const uniqueRules = Array.from(
    new Map(
      extractedRules.map((rule) => [
        `${rule.ruleType.toLowerCase()}|${rule.pattern.toLowerCase()}`,
        rule,
      ]),
    ).values(),
  );

  // NON-DESTRUCTIVE: Fetch existing style rules to preserve them
  const existingRules = await prisma.documentStyleRule.findMany({
    where: { documentId },
  });

  // Create a map of existing rules by ruleType|pattern key
  const existingRulesMap = new Map<string, typeof existingRules[0]>();
  for (const rule of existingRules) {
    const key = `${rule.ruleType.toLowerCase()}|${rule.pattern.toLowerCase()}`;
    existingRulesMap.set(key, rule);
  }

  // Smart merge: Update existing rules, create new ones
  let createdCount = 0;
  let updatedCount = 0;
  const rulesToCreate: Array<{
    documentId: string;
    ruleType: string;
    pattern: string;
    description: string | null;
    examples: Prisma.InputJsonValue | null;
    priority: number;
  }> = [];

  for (const rule of uniqueRules) {
    const key = `${rule.ruleType.toLowerCase()}|${rule.pattern.toLowerCase()}`;
    const existingRule = existingRulesMap.get(key);

    if (existingRule) {
      // Update existing rule (preserve it, but update description/examples if provided)
      await prisma.documentStyleRule.update({
        where: { id: existingRule.id },
        data: {
          description: rule.description || existingRule.description,
          examples: rule.examples && rule.examples.length > 0 ? (rule.examples as Prisma.InputJsonValue) : existingRule.examples,
        },
      });
      updatedCount++;
    } else {
      // Create new rule
      rulesToCreate.push({
        documentId,
        ruleType: rule.ruleType,
        pattern: rule.pattern,
        description: rule.description || null,
        examples: rule.examples && rule.examples.length > 0 ? (rule.examples as Prisma.InputJsonValue) : null,
        priority: 50, // Default priority
      });
    }
  }

  // Batch create new rules
  if (rulesToCreate.length > 0) {
    await prisma.documentStyleRule.createMany({
      data: rulesToCreate,
    });
    createdCount = rulesToCreate.length;
  }

  // CRITICAL: Delete rules that were not found in the new extraction
  // This prevents accumulation of old rules that AI no longer extracts
  const newRuleKeys = new Set(
    uniqueRules.map((rule) => `${rule.ruleType.toLowerCase()}|${rule.pattern.toLowerCase()}`)
  );
  const rulesToDelete = Array.from(existingRulesMap.entries())
    .filter(([key]) => !newRuleKeys.has(key))
    .map(([_, rule]) => rule.id);

  let deletedCount = 0;
  if (rulesToDelete.length > 0) {
    const deleteResult = await prisma.documentStyleRule.deleteMany({
      where: {
        documentId,
        id: { in: rulesToDelete },
      },
    });
    deletedCount = deleteResult.count;
    logger.info(
      {
        documentId,
        deletedRulesCount: deletedCount,
        deletedRuleIds: rulesToDelete,
      },
      'Deleted style rules that were not found in new extraction',
    );
  }

  // Query actual database count (after merge and cleanup)
  const actualDbCount = await prisma.documentStyleRule.count({
    where: { documentId },
  });

  const result = { count: actualDbCount }; // Return actual DB count

  // Update or create DocumentAnalysis record
  await updateProgress(
    documentId,
    'completed',
    100,
    `Style rule extraction completed: ${actualDbCount} rules (${createdCount} created, ${updatedCount} updated${deletedCount > 0 ? `, ${deletedCount} deleted` : ''})`,
    false,
  );
  // CRITICAL: Do NOT set status to COMPLETED here - glossary extraction may still be running in parallel
  // Only update styleRulesExtracted flag and progress, but keep status as RUNNING
  // The final status update will happen in runFullAnalysis after both tasks complete
  await prisma.documentAnalysis.upsert({
    where: { documentId },
    create: {
      documentId,
      status: 'RUNNING', // Keep as RUNNING - glossary may still be processing
      styleRulesExtracted: true,
      currentStage: 'saving_style',
      progressPercentage: 85, // Style rules are 50% of the work, so 85% when style rules done
      currentMessage: `Style rule extraction completed: ${actualDbCount} rules (${createdCount} created, ${updatedCount} updated${deletedCount > 0 ? `, ${deletedCount} deleted` : ''}). Glossary extraction in progress...`,
    },
    update: {
      // Do NOT change status to COMPLETED - keep it RUNNING until glossary is done
      styleRulesExtracted: true,
      currentStage: 'saving_style',
      progressPercentage: 85, // Style rules are 50% of the work, so 85% when style rules done
      currentMessage: `Style rule extraction completed: ${actualDbCount} rules (${createdCount} created, ${updatedCount} updated${deletedCount > 0 ? `, ${deletedCount} deleted` : ''}). Glossary extraction in progress...`,
      // Do NOT set completedAt or change status here
    },
  });

  logger.info(
    {
      documentId,
      extracted: extractedRules.length,
      newEntries: result.count,
      skipped: extractedRules.length - result.count,
    },
    'Style rule extraction completed',
  );

  return { count: result.count };
};

/**
 * Runs full document analysis (Stage 1: The Analyst)
 * Extracts both glossary terms and style rules in parallel
 * @param documentId - The document ID to analyze
 * @param forceReset - If true, deletes ALL existing entries (glossary and style rules) before extraction
 */
export const runFullAnalysis = async (
  documentId: string,
  forceReset: boolean = false,
  glossaryMode: 'fast' | 'deep' = 'fast',
  provider?: string,
  model?: string
): Promise<{
  glossaryCount: number;
  styleRulesCount: number;
  status: string;
}> => {
  // Clear any previous cancellation flag
  clearAnalysisCancellation(documentId);

  // Find or create DocumentAnalysis record and set status to RUNNING
  await prisma.documentAnalysis.upsert({
    where: { documentId },
    create: {
      documentId,
      status: 'RUNNING',
      glossaryExtracted: false,
      styleRulesExtracted: false,
      currentStage: 'initializing',
      progressPercentage: 1, // Start at 1% to show activity immediately
      currentMessage: 'Initializing analysis...',
    },
    update: {
      status: 'RUNNING',
      glossaryExtracted: false,
      styleRulesExtracted: false,
      completedAt: null,
      currentStage: 'initializing',
      progressPercentage: 1, // Start at 1% to show activity immediately
      currentMessage: 'Initializing analysis...',
    },
  });
  
  // Log immediately after setting status to help with debugging
  logger.info(
    { documentId, forceReset },
    'Analysis initialized with RUNNING status',
  );

  // Immediately update progress to show analysis has started
  await updateProgress(documentId, 'initializing', 1, 'Analysis started, initializing...', true);
  
  // Get document to access projectId, sourceLocale, targetLocale
  const document = await prisma.document.findUnique({
    where: { id: documentId },
    select: {
      id: true,
      projectId: true,
      sourceLocale: true,
      targetLocale: true,
    },
  });

  if (!document) {
    throw ApiError.notFound('Document not found');
  }

  // FORCE RESET: If forceReset is true, delete ALL entries (both glossary and style rules)
  if (forceReset) {
    logger.info(
      { documentId },
      'FORCE RESET: Deleting ALL glossary entries and style rules before analysis',
    );

    const deletedGlossaryCount = await prisma.documentGlossaryEntry.deleteMany({
      where: { documentId },
    });

    const deletedStyleRulesCount = await prisma.documentStyleRule.deleteMany({
      where: { documentId },
    });

    logger.info(
      {
        documentId,
        deletedGlossaryEntries: deletedGlossaryCount.count,
        deletedStyleRules: deletedStyleRulesCount.count,
      },
      'FORCE RESET: All existing data cleared, starting fresh analysis',
    );
  } else {
    // NON-DESTRUCTIVE: Style rules are now preserved in extractStyleRules
    // No need to delete them here - they will be updated/merged instead
    // This ensures consistency across runs

    // For glossary entries: Only delete CANDIDATE entries, preserve APPROVED entries
    // First, find all existing entries and check which are APPROVED
    const existingGlossaryEntries = await prisma.documentGlossaryEntry.findMany({
      where: { documentId },
    });

    // Check which entries are APPROVED (via GlossaryEntry lookup)
    const approvedEntryIds: string[] = [];
    for (const entry of existingGlossaryEntries) {
      const glossaryEntry = await prisma.glossaryEntry.findFirst({
        where: {
          OR: [
            { projectId: null }, // Global
            { projectId: document.projectId }, // Project
          ],
          sourceTerm: { equals: entry.sourceTerm, mode: 'insensitive' },
          sourceLocale: document.sourceLocale,
          targetLocale: document.targetLocale,
        },
        select: { id: true },
      });

      // If a GlossaryEntry exists, the DocumentGlossaryEntry is considered APPROVED
      if (glossaryEntry) {
        approvedEntryIds.push(entry.id);
      }
    }

    // Delete only CANDIDATE entries (not APPROVED)
    const deletedGlossaryCount = await prisma.documentGlossaryEntry.deleteMany({
      where: {
        documentId,
        id: { notIn: approvedEntryIds },
      },
    });

    logger.info(
      {
        documentId,
        deletedGlossaryEntries: deletedGlossaryCount.count,
        preservedApprovedEntries: approvedEntryIds.length,
        styleRulesPreserved: true, // Style rules are now preserved (non-destructive)
      },
      'Starting full document analysis (preserved APPROVED glossary entries, cleared CANDIDATE entries, preserving style rules)',
    );
  }

  try {
    // Check for cancellation before starting
    if (isAnalysisCancelled(documentId)) {
      await prisma.documentAnalysis.update({
        where: { documentId },
        data: {
          status: 'CANCELLED',
          completedAt: new Date(),
          currentStage: 'cancelled',
          currentMessage: 'Analysis cancelled by user',
        },
      });
      clearAnalysisCancellation(documentId);
      return {
        glossaryCount: 0,
        styleRulesCount: 0,
        status: 'CANCELLED',
      };
    }

    // Run semantic analysis first (quick, provides global context)
    // Then run glossary and style rules extractions in parallel
    let semanticResult: { detectedDomain: string | null; detectedTone: string | null; translationStrategy: string | null } | null = null;
    
    try {
      semanticResult = await performSemanticAnalysis(documentId);
      logger.info(
        {
          documentId,
          detectedDomain: semanticResult.detectedDomain,
          detectedTone: semanticResult.detectedTone,
          hasStrategy: !!semanticResult.translationStrategy,
        },
        'Semantic analysis completed',
      );
    } catch (semanticError: any) {
      // Non-fatal: log but continue with other extractions
      logger.warn(
        {
          documentId,
          error: semanticError.message,
        },
        'Semantic analysis failed, continuing with other extractions',
      );
    }

    // Run both extractions in parallel
    // CRITICAL: Use Promise.allSettled to allow one to fail while the other continues
    // This ensures that if one extraction fails (e.g., rate limit), the other can still complete
    // We'll handle partial failures gracefully and report what succeeded
    const [glossarySettlement, styleRulesSettlement] = await Promise.allSettled([
      extractGlossary(documentId, glossaryMode, provider, model), // Use provided mode (fast or deep) and AI provider/model
      extractStyleRules(documentId),
    ]);
    
    // Extract results from settlements
    let glossaryResult: { count: number } | null = null;
    let styleRulesResult: { count: number } | null = null;
    let hasErrors = false;
    const errorMessages: string[] = [];
    
    if (glossarySettlement.status === 'fulfilled') {
      glossaryResult = glossarySettlement.value;
    } else {
      const error = glossarySettlement.reason;
      const errorMsg = error?.message || 'Unknown error during glossary extraction';
      
      // If cancelled, update status and return immediately
      if (errorMsg.includes('cancelled')) {
        await prisma.documentAnalysis.update({
          where: { documentId },
          data: {
            status: 'CANCELLED',
            completedAt: new Date(),
            currentMessage: 'Analysis cancelled by user',
          },
        });
        clearAnalysisCancellation(documentId);
        return {
          glossaryCount: 0,
          styleRulesCount: 0,
          status: 'CANCELLED',
        };
      }
      
      hasErrors = true;
      errorMessages.push(`Glossary extraction failed: ${errorMsg}`);
      logger.error(
        { documentId, error: errorMsg, errorStack: error?.stack },
        'Glossary extraction failed during full analysis',
      );
    }
    
    if (styleRulesSettlement.status === 'fulfilled') {
      styleRulesResult = styleRulesSettlement.value;
    } else {
      const error = styleRulesSettlement.reason;
      const errorMsg = error?.message || 'Unknown error during style rules extraction';
      
      // If cancelled, update status and return immediately
      if (errorMsg.includes('cancelled')) {
        await prisma.documentAnalysis.update({
          where: { documentId },
          data: {
            status: 'CANCELLED',
            completedAt: new Date(),
            currentMessage: 'Analysis cancelled by user',
          },
        });
        clearAnalysisCancellation(documentId);
        return {
          glossaryCount: glossaryResult?.count || 0,
          styleRulesCount: 0,
          status: 'CANCELLED',
        };
      }
      
      hasErrors = true;
      errorMessages.push(`Style rules extraction failed: ${errorMsg}`);
      logger.error(
        { documentId, error: errorMsg, errorStack: error?.stack },
        'Style rules extraction failed during full analysis',
      );
    }
    
    // If both failed, throw an error
    if (!glossaryResult && !styleRulesResult) {
      throw new Error(`Both extractions failed: ${errorMessages.join('; ')}`);
    }
    
    // If one succeeded and one failed, log warning but continue
    if (hasErrors) {
      logger.warn(
        {
          documentId,
          glossarySucceeded: !!glossaryResult,
          styleRulesSucceeded: !!styleRulesResult,
          errors: errorMessages,
        },
        'Partial analysis completion - one extraction failed but analysis continues',
      );
    }
    
    // Use results or default to 0 if failed
    const finalGlossaryResult = glossaryResult || { count: 0 };
    const finalStyleRulesResult = styleRulesResult || { count: 0 };

    // Check for cancellation after parallel execution
    if (isAnalysisCancelled(documentId)) {
      await prisma.documentAnalysis.update({
        where: { documentId },
        data: {
          status: 'CANCELLED',
          completedAt: new Date(),
          currentStage: 'cancelled',
          currentMessage: 'Analysis cancelled by user',
        },
      });
      clearAnalysisCancellation(documentId);
      return {
        glossaryCount: 0,
        styleRulesCount: 0,
        status: 'CANCELLED',
      };
    }

    // CRITICAL: Query actual database counts after completion to ensure consistency
    // This ensures the return value matches what getAnalysisResults will return
    const finalGlossaryCount = await prisma.documentGlossaryEntry.count({
      where: { documentId },
    });
    const finalStyleRulesCount = await prisma.documentStyleRule.count({
      where: { documentId },
    });
    
    // Count approved vs candidate terms for final message
    const documentEntries = await prisma.documentGlossaryEntry.findMany({
      where: { documentId },
      select: { sourceTerm: true },
    });
    
    // Look up status for each term
    const document = await prisma.document.findUnique({
      where: { id: documentId },
      select: { sourceLocale: true, targetLocale: true, projectId: true },
    });
    
    let approvedFinalCount = 0;
    let candidateFinalCount = 0;
    
    if (document) {
      for (const entry of documentEntries) {
        const glossaryEntry = await prisma.glossaryEntry.findFirst({
          where: {
            OR: [
              { projectId: null },
              { projectId: document.projectId },
            ],
            sourceTerm: { equals: entry.sourceTerm, mode: 'insensitive' },
            sourceLocale: document.sourceLocale,
            targetLocale: document.targetLocale,
          },
          select: { id: true },
        });
        
        // If a GlossaryEntry exists, the DocumentGlossaryEntry is considered APPROVED
        // (GlossaryEntry doesn't have a status field - that's only on DocumentGlossaryEntry)
        if (glossaryEntry) {
          approvedFinalCount++;
        } else {
          candidateFinalCount++;
        }
      }
    } else {
      // Fallback: assume all are candidates if document not found
      candidateFinalCount = finalGlossaryCount;
    }

    // Update status to COMPLETED with actual counts
    // Include warning about partial failures if any occurred
    const completionMessage = hasErrors
      ? `Analysis completed with partial failures: ${finalGlossaryCount} terms (${approvedFinalCount} approved, ${candidateFinalCount} candidate), ${finalStyleRulesCount} style rules. Some extractions may have failed.`
      : `Analysis completed: ${finalGlossaryCount} terms (${approvedFinalCount} approved, ${candidateFinalCount} candidate), ${finalStyleRulesCount} style rules`;
    
    await prisma.documentAnalysis.update({
      where: { documentId },
      data: {
        status: 'COMPLETED',
        completedAt: new Date(),
        currentStage: 'completed',
        progressPercentage: 100,
        currentMessage: completionMessage,
      },
    });

    logger.info(
      {
        documentId,
        glossaryCount: finalGlossaryCount,
        styleRulesCount: finalStyleRulesCount,
        glossaryCreatedUpdated: finalGlossaryResult.count,
        styleRulesCreatedUpdated: finalStyleRulesResult.count,
        hadErrors: hasErrors,
        errorMessages: hasErrors ? errorMessages : undefined,
      },
      hasErrors 
        ? 'Full document analysis completed with partial failures' 
        : 'Full document analysis completed',
    );

    return {
      glossaryCount: finalGlossaryCount, // Use actual DB count for consistency
      styleRulesCount: finalStyleRulesCount, // Use actual DB count for consistency
      status: 'COMPLETED',
    };
  } catch (error: any) {
    // Determine error message based on error type
    let errorMessage = 'Analysis failed';
    let errorDetails = error.message || 'Unknown error';
    
    // Check for specific error types
    if (errorDetails.includes('rate limit') || errorDetails.includes('quota') || errorDetails.includes('429')) {
      errorMessage = 'AI Provider Rate Limit Exceeded';
      errorDetails = 'The AI provider has rate-limited your requests. Please wait a few minutes and try again.';
    } else if (errorDetails.includes('API key') || errorDetails.includes('API_KEY')) {
      errorMessage = 'AI Provider API Key Error';
      errorDetails = 'Invalid or missing API key. Please check your AI provider settings.';
    } else if (errorDetails.includes('Failed to extract glossary')) {
      errorMessage = 'Glossary Extraction Failed';
    } else if (errorDetails.includes('Failed to extract style rules')) {
      errorMessage = 'Style Rule Extraction Failed';
    } else if (errorDetails.includes('parse') || errorDetails.includes('JSON')) {
      errorMessage = 'AI Response Parsing Failed';
      errorDetails = 'The AI provider returned an invalid response. This may indicate a temporary issue. Please try again.';
    }
    
    // Update status to FAILED with detailed error message
    await prisma.documentAnalysis.update({
      where: { documentId },
      data: {
        status: 'FAILED',
        completedAt: new Date(),
        currentStage: 'failed',
        currentMessage: `${errorMessage}: ${errorDetails}`,
        progressPercentage: 0,
      },
    });

    logger.error(
      {
        documentId,
        errorType: errorMessage,
        errorMessage: errorDetails,
        errorStack: error.stack,
        originalError: error.message,
      },
      'Full document analysis failed - error propagated to user',
    );

    // Re-throw the error so it's visible to the user
    throw error;
  }
};

/**
 * Reset a specific analysis status (useful for manual fixes)
 * If status is RUNNING, resets it to FAILED
 * Otherwise, resets to PENDING
 */
export const resetAnalysisStatus = async (documentId: string): Promise<{ status: string }> => {
  try {
    const analysis = await prisma.documentAnalysis.findUnique({
      where: { documentId },
      select: { status: true },
    });

    if (!analysis) {
      throw ApiError.notFound('Analysis not found');
    }

    const newStatus = analysis.status === 'RUNNING' ? 'FAILED' : 'PENDING';
    
    await prisma.documentAnalysis.update({
      where: { documentId },
      data: {
        status: newStatus,
        currentMessage: newStatus === 'FAILED' 
          ? 'Analysis was manually reset (was stuck in RUNNING state)'
          : 'Analysis reset - ready to start',
        completedAt: newStatus === 'FAILED' ? new Date() : null,
        currentStage: null,
        progressPercentage: 0,
      },
    });

    logger.info(
      {
        documentId,
        oldStatus: analysis.status,
        newStatus,
      },
      'Manually reset analysis status',
    );

    return { status: newStatus };
  } catch (error: any) {
    logger.error(
      {
        documentId,
        error: error.message,
      },
      'Failed to reset analysis status',
    );
    throw ApiError.badRequest(`Failed to reset analysis status: ${error.message}`);
  }
};

/**
 * Cleanup stale RUNNING analyses on server startup
 * Resets any RUNNING analyses that haven't been updated in the last 30 minutes
 * (These are likely from before a server restart)
 */
export const cleanupStaleAnalyses = async (): Promise<number> => {
  try {
    // Check if documentAnalysis model exists in Prisma client
    // This handles the case where Prisma client hasn't been regenerated after schema changes
    if (!prisma.documentAnalysis) {
      logger.warn('DocumentAnalysis model not available in Prisma client. Please run: npx prisma generate');
      return 0;
    }

    const staleThreshold = 30 * 60 * 1000; // 30 minutes in milliseconds
    const cutoffTime = new Date(Date.now() - staleThreshold);

    const result = await prisma.documentAnalysis.updateMany({
      where: {
        status: 'RUNNING',
        updatedAt: {
          lt: cutoffTime, // Updated more than 30 minutes ago
        },
      },
      data: {
        status: 'FAILED',
        currentMessage: 'Analysis was interrupted (likely due to server restart or crash)',
        completedAt: new Date(),
      },
    });

    if (result.count > 0) {
      logger.info(
        {
          staleCount: result.count,
          cutoffTime: cutoffTime.toISOString(),
        },
        'Cleaned up stale RUNNING analyses on server startup',
      );
    }

    return result.count;
  } catch (error: any) {
    // If the error is about the model not existing, log a warning instead of error
    if (error.message?.includes('documentAnalysis') || error.message?.includes('Cannot read properties')) {
      logger.warn(
        {
          error: error.message,
        },
        'DocumentAnalysis model not available. Please run: npx prisma generate',
      );
      return 0;
    }
    
    logger.error(
      {
        error: error.message,
        errorStack: error.stack,
      },
      'Failed to cleanup stale analyses',
    );
    return 0;
  }
};

/**
 * Gets analysis results for a document
 * Returns analysis status, style rules, and glossary entries
 */
export const getAnalysisResults = async (documentId: string) => {
  try {
    // Check if documentAnalysis model exists in Prisma client
    // This handles the case where Prisma client hasn't been regenerated after schema changes
    if (!prisma.documentAnalysis) {
      logger.warn('DocumentAnalysis model not available in Prisma client. Please run: npx prisma generate');
      throw ApiError.badRequest('DocumentAnalysis model not available. Please run: npx prisma generate');
    }

    const analysis = await prisma.documentAnalysis.findUnique({
      where: { documentId },
      select: {
        id: true,
        documentId: true,
        status: true,
        glossaryExtracted: true,
        styleRulesExtracted: true,
        completedAt: true,
        currentStage: true,
        progressPercentage: true,
        currentMessage: true,
        updatedAt: true, // Add updatedAt to detect stale statuses
        document: {
          select: {
            id: true,
            name: true,
            sourceLocale: true,
            targetLocale: true,
            projectId: true,
          },
        },
      },
    });

    if (!analysis) {
      // Return default structure if no analysis exists
      return {
      status: 'PENDING',
      glossaryExtracted: false,
      styleRulesExtracted: false,
      completedAt: null,
      glossaryCount: 0,
      approvedCount: 0,
      candidateCount: 0,
      styleRulesCount: 0,
      styleRules: [],
      glossaryEntries: [],
      currentStage: null,
      progressPercentage: 0,
      currentMessage: null,
    };
  }

  // Check if status is RUNNING but the analysis is stale (not updated in last 30 minutes)
  // This handles cases where the server was restarted and the background process was killed
  if (analysis.status === 'RUNNING') {
    const updatedAt = analysis.updatedAt;
    const now = new Date();
    const staleThreshold = 30 * 60 * 1000; // 30 minutes in milliseconds
    const timeSinceUpdate = now.getTime() - updatedAt.getTime();

    if (timeSinceUpdate > staleThreshold) {
      // Mark as FAILED since the process was likely interrupted (server restart, crash, etc.)
      logger.warn(
        {
          documentId,
          timeSinceUpdateMinutes: Math.round(timeSinceUpdate / 60000),
          updatedAt: updatedAt.toISOString(),
        },
        'Detected stale RUNNING analysis status - marking as FAILED',
      );

      const updatedAnalysis = await prisma.documentAnalysis.update({
        where: { documentId },
        data: {
          status: 'FAILED',
          currentMessage: 'Analysis was interrupted (likely due to server restart or crash)',
          completedAt: new Date(),
        },
        select: {
          id: true,
          documentId: true,
          status: true,
          glossaryExtracted: true,
          styleRulesExtracted: true,
          completedAt: true,
          currentStage: true,
          progressPercentage: true,
          currentMessage: true,
        },
      });

      // Update the analysis object with the new values
      analysis.status = updatedAnalysis.status;
      analysis.currentMessage = updatedAnalysis.currentMessage;
      analysis.completedAt = updatedAnalysis.completedAt;
    }
  }

  // Get style rules
  const styleRules = await prisma.documentStyleRule.findMany({
      where: { documentId },
      orderBy: [{ priority: 'desc' }, { createdAt: 'asc' }],
    });

    // Get glossary entries
    const glossaryEntries = await prisma.documentGlossaryEntry.findMany({
      where: { documentId },
      orderBy: { createdAt: 'asc' },
    });

    // Count approved vs candidate terms
    // IMPORTANT: Terms are considered APPROVED if:
    // 1. They exist in Global Glossary (projectId: null) with status PREFERRED
    // 2. They exist in Project Glossary with status PREFERRED
    // Terms are CANDIDATE if:
    // 1. They exist in Global Glossary but status is not PREFERRED (CANDIDATE or DEPRECATED)
    // 2. They exist in Project Glossary but status is not PREFERRED
    // 3. They only exist in DocumentGlossaryEntry (not yet in global/project glossary)
    let approvedCount = 0;
    let candidateCount = 0;
    let candidateFromGlobalCount = 0;
    
    if (glossaryEntries.length > 0 && analysis.document) {
      for (const entry of glossaryEntries) {
        // First check Global Glossary (projectId: null)
        const globalEntry = await prisma.glossaryEntry.findFirst({
          where: {
            projectId: null, // Global only
            sourceTerm: { equals: entry.sourceTerm, mode: 'insensitive' },
            sourceLocale: analysis.document.sourceLocale,
            targetLocale: analysis.document.targetLocale,
          },
          select: { id: true },
        });
        
        if (globalEntry) {
          // Term exists in Global Glossary - considered APPROVED
          approvedCount++;
        } else {
          // Check Project Glossary
          const projectEntry = await prisma.glossaryEntry.findFirst({
            where: {
              projectId: analysis.document.projectId || undefined,
              sourceTerm: { equals: entry.sourceTerm, mode: 'insensitive' },
              sourceLocale: analysis.document.sourceLocale,
              targetLocale: analysis.document.targetLocale,
            },
            select: { id: true },
          });
          
          if (projectEntry) {
            // Term exists in Project Glossary with PREFERRED status - approved
            approvedCount++;
          } else {
            // Term only exists in DocumentGlossaryEntry (not in global/project glossary) - candidate
            candidateCount++;
          }
        }
      }
    } else {
      // If no entries, all counts are 0
      candidateCount = 0;
    }

    return {
      status: analysis.status,
      glossaryExtracted: analysis.glossaryExtracted,
      styleRulesExtracted: analysis.styleRulesExtracted,
      completedAt: analysis.completedAt,
      glossaryCount: glossaryEntries.length,
      approvedCount,
      candidateCount,
      candidateFromGlobalCount,
      styleRulesCount: styleRules.length,
      currentStage: analysis.currentStage || null,
      progressPercentage: analysis.progressPercentage || 0,
      currentMessage: analysis.currentMessage || null,
      styleRules: styleRules.map((rule) => ({
        id: rule.id,
        ruleType: rule.ruleType,
        pattern: rule.pattern,
        description: rule.description,
        examples: rule.examples,
        priority: rule.priority,
        createdAt: rule.createdAt,
      })),
      glossaryEntries: glossaryEntries.map((entry) => ({
        id: entry.id,
        sourceTerm: entry.sourceTerm,
        targetTerm: entry.targetTerm,
        createdAt: entry.createdAt,
      })),
    };
  } catch (error: any) {
    logger.error(
      { documentId, error: error.message, stack: error.stack },
      'Error in getAnalysisResults',
    );
    throw ApiError.badRequest(`Failed to fetch analysis results: ${error.message || 'Unknown error'}`);
  }
};

/**
 * Get detailed stage monitoring data for glossary extraction
 * Returns stage-specific metrics and progress information
 */
export const getStageMonitoringData = async (documentId: string) => {
  try {
    // Check if documentAnalysis model exists in Prisma client
    if (!prisma.documentAnalysis) {
      logger.warn('DocumentAnalysis model not available in Prisma client. Please run: npx prisma generate');
      throw ApiError.badRequest('DocumentAnalysis model not available. Please run: npx prisma generate');
    }

    // Query analysis - don't include executionLogs in select to avoid errors if field doesn't exist
    const analysis = await prisma.documentAnalysis.findUnique({
      where: { documentId },
      select: {
        id: true,
        documentId: true,
        status: true,
        currentStage: true,
        progressPercentage: true,
        currentMessage: true,
        glossaryExtracted: true,
        completedAt: true,
        updatedAt: true,
        document: {
          select: {
            id: true,
            name: true,
            totalSegments: true,
            sourceLocale: true,
            targetLocale: true,
          },
        },
      },
    });

    // Try to get executionLogs separately using raw query (won't fail if column doesn't exist)
    let executionLogs: LogEntry[] = [];
    try {
      // #region agent log
      fetch('http://127.0.0.1:7242/ingest/7f529324-455d-4ca1-81c1-cbc867a5b6ab',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'analysis.service.ts:6108',message:'getStageMonitoringData: Checking column for log retrieval',data:{documentId},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'E'})}).catch(()=>{});
      // #endregion
      // Check if column exists first
      const columnExists = await prisma.$queryRaw<Array<{ column_name: string }>>`
        SELECT column_name 
        FROM information_schema.columns 
        WHERE table_name = 'DocumentAnalysis' 
          AND column_name = 'executionLogs'
      `;
      
      // #region agent log
      fetch('http://127.0.0.1:7242/ingest/7f529324-455d-4ca1-81c1-cbc867a5b6ab',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'analysis.service.ts:6117',message:'getStageMonitoringData: Column check result',data:{documentId,columnExists:columnExists?.length>0,columnCheckLength:columnExists?.length},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'E'})}).catch(()=>{});
      // #endregion
      
      if (columnExists && columnExists.length > 0) {
        // Column exists, try to get logs
        // #region agent log
        fetch('http://127.0.0.1:7242/ingest/7f529324-455d-4ca1-81c1-cbc867a5b6ab',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'analysis.service.ts:6123',message:'getStageMonitoringData: Querying logs from database',data:{documentId},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'E'})}).catch(()=>{});
        // #endregion
        const result = await prisma.$queryRawUnsafe<Array<{ executionLogs: any }>>(
          `SELECT "executionLogs" FROM "DocumentAnalysis" WHERE "documentId" = $1`,
          documentId
        );
        // #region agent log
        fetch('http://127.0.0.1:7242/ingest/7f529324-455d-4ca1-81c1-cbc867a5b6ab',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'analysis.service.ts:6129',message:'getStageMonitoringData: Query result',data:{documentId,resultExists:!!result,resultLength:result?.length,hasExecutionLogs:!!result?.[0]?.executionLogs,executionLogsType:typeof result?.[0]?.executionLogs,isArray:Array.isArray(result?.[0]?.executionLogs),logCount:Array.isArray(result?.[0]?.executionLogs)?(result[0].executionLogs as any[]).length:'not-array'},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'E'})}).catch(()=>{});
        // #endregion
        if (result && result[0]?.executionLogs) {
          executionLogs = (result[0].executionLogs as LogEntry[]) || [];
          logger.debug(
            { documentId, logCount: executionLogs.length },
            'Retrieved execution logs from database',
          );
          // #region agent log
          fetch('http://127.0.0.1:7242/ingest/7f529324-455d-4ca1-81c1-cbc867a5b6ab',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'analysis.service.ts:6137',message:'getStageMonitoringData: Logs retrieved successfully',data:{documentId,logCount:executionLogs.length,stages:executionLogs.map((l:any)=>l.stage)},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'E'})}).catch(()=>{});
          // #endregion
        } else {
          logger.debug(
            { documentId },
            'No execution logs found in database (field is null or empty)',
          );
          // #region agent log
          fetch('http://127.0.0.1:7242/ingest/7f529324-455d-4ca1-81c1-cbc867a5b6ab',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'analysis.service.ts:6145',message:'getStageMonitoringData: No logs found in result',data:{documentId},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'E'})}).catch(()=>{});
          // #endregion
        }
      } else {
        logger.warn(
          { documentId },
          'executionLogs column does not exist - cannot retrieve logs',
        );
        // #region agent log
        fetch('http://127.0.0.1:7242/ingest/7f529324-455d-4ca1-81c1-cbc867a5b6ab',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'analysis.service.ts:6153',message:'getStageMonitoringData: Column does not exist',data:{documentId},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'E'})}).catch(()=>{});
        // #endregion
      }
    } catch (logError: any) {
      // Field doesn't exist or query failed - that's okay, just use empty array
      logger.debug(
        { documentId, error: logError.message },
        'executionLogs field not available (migration may not be run yet)',
      );
      executionLogs = [];
      // #region agent log
      fetch('http://127.0.0.1:7242/ingest/7f529324-455d-4ca1-81c1-cbc867a5b6ab',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'analysis.service.ts:6163',message:'getStageMonitoringData: Error retrieving logs',data:{documentId,error:logError.message},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'E'})}).catch(()=>{});
      // #endregion
    }

    if (!analysis) {
      return {
        documentId,
        status: 'PENDING',
        currentStage: null,
        stages: getStageDefinitions(),
        progress: {
          overall: 0,
          currentStage: null,
          message: 'Analysis not started',
        },
        logs: [],
      };
    }

    // Determine which stage we're currently in based on currentStage and progress
    const currentStageInfo = parseCurrentStage(analysis.currentStage, analysis.progressPercentage);
    const stages = getStageDefinitions().map((stage) => ({
      ...stage,
      status: getStageStatus(stage, analysis, currentStageInfo),
      progress: getStageProgress(stage, analysis.progressPercentage),
    }));

    // Get glossary counts if available
    const glossaryCount = await prisma.documentGlossaryEntry.count({
      where: { documentId },
    });

    return {
      documentId,
      documentName: analysis.document.name,
      status: analysis.status,
      currentStage: analysis.currentStage,
      currentStageInfo,
      stages,
      progress: {
        overall: analysis.progressPercentage,
        currentStage: analysis.currentStage,
        message: analysis.currentMessage || 'Processing...',
        updatedAt: analysis.updatedAt.toISOString(),
      },
      glossaryExtracted: analysis.glossaryExtracted,
      glossaryCount,
      totalSegments: analysis.document.totalSegments,
      sourceLocale: analysis.document.sourceLocale,
      targetLocale: analysis.document.targetLocale,
      logs: executionLogs,
    };
  } catch (error: any) {
    logger.error(
      {
        documentId,
        error: error.message,
        stack: error.stack,
      },
      'Error in getStageMonitoringData',
    );
    throw error;
  }
};

/**
 * Stage definitions for glossary extraction
 */
const getStageDefinitions = () => [
  {
    id: 'stage1',
    name: 'Stage 1: Text Sampling',
    description: 'Extracts and samples text from document segments',
    progressRange: [0, 15],
  },
  {
    id: 'stage2',
    name: 'Stage 2: Candidate Generation',
    description: 'Creates candidate terms via N-grams and whole-line extraction',
    progressRange: [15, 20],
  },
  {
    id: 'stage3',
    name: 'Stage 3: Candidate Filtering',
    description: 'Filters stopwords, fragments, and invalid terms',
    progressRange: [20, 25],
  },
  {
    id: 'stage4',
    name: 'Stage 4: AI Prompt Construction',
    description: 'Builds prompts for AI extraction',
    progressRange: [25, 30],
  },
  {
    id: 'stage5',
    name: 'Stage 5: AI Response & Parsing',
    description: 'Calls AI and parses JSON response',
    progressRange: [30, 45],
  },
  {
    id: 'stage6',
    name: 'Stage 6: Verbatim Verification',
    description: 'Verifies terms exist verbatim in source text',
    progressRange: [45, 48],
  },
  {
    id: 'stage7',
    name: 'Stage 7: Translation Lookup',
    description: 'Waterfall lookup (Global → Project → AI Translation)',
    progressRange: [50, 70],
  },
  {
    id: 'stage8',
    name: 'Stage 8: Merge & Persistence',
    description: 'Merges with existing entries and saves to database',
    progressRange: [70, 100],
  },
];

/**
 * Parse current stage from stage string and progress
 */
const parseCurrentStage = (currentStage: string | null, progress: number) => {
  if (!currentStage) {
    if (progress === 0) return { id: null, name: 'Not started' };
    return { id: null, name: 'Unknown' };
  }

  // Map stage names to stage IDs
  const stageMap: Record<string, string> = {
    fetching: 'stage1',
    frequency_analysis: 'stage2',
    ai_glossary: 'stage4',
    parsing_glossary: 'stage5',
    lookup_glossary: 'stage7',
    lookup_confirmed: 'stage7',
    saving_glossary: 'stage8',
    harvesting_confirmed: 'stage1',
  };

  const stageId = stageMap[currentStage] || null;
  const stages = getStageDefinitions();
  const stage = stageId ? stages.find((s) => s.id === stageId) : null;

  return {
    id: stageId,
    name: stage?.name || currentStage,
    description: stage?.description || null,
  };
};

/**
 * Get status of a specific stage
 */
const getStageStatus = (
  stage: { id: string; progressRange: number[] },
  analysis: { progressPercentage: number; status: string },
  currentStageInfo: { id: string | null }
): 'pending' | 'active' | 'completed' | 'error' => {
  if (analysis.status === 'FAILED') return 'error';
  if (analysis.status === 'CANCELLED') return 'pending';
  if (analysis.status === 'COMPLETED' && analysis.progressPercentage >= 100) return 'completed';

  const [start, end] = stage.progressRange;
  const isCurrentStage = currentStageInfo.id === stage.id;
  const isPast = analysis.progressPercentage > end;

  if (isPast) return 'completed';
  if (isCurrentStage) return 'active';
  if (analysis.progressPercentage >= start && analysis.progressPercentage < end) return 'active';
  return 'pending';
};

/**
 * Get progress percentage for a specific stage
 */
const getStageProgress = (
  stage: { progressRange: number[] },
  overallProgress: number
): number => {
  const [start, end] = stage.progressRange;
  const range = end - start;

  if (overallProgress < start) return 0;
  if (overallProgress >= end) return 100;

  const stageProgress = ((overallProgress - start) / range) * 100;
  return Math.round(stageProgress);
};

/**
 * Get document-specific glossary terms that match a segment's source text
 * Returns top 20 most relevant terms, prioritizing PREFERRED (APPROVED) status
 * Used for Stage 2: Context-Aware Translation ("The Drafter")
 */
export const getDocumentGlossaryForSegment = async (
  documentId: string,
  sourceText: string,
): Promise<Array<{ sourceTerm: string; targetTerm: string; status: string; occurrenceCount: number }>> => {
  try {
    // Get document to access locales
    const document = await prisma.document.findUnique({
      where: { id: documentId },
      select: {
        sourceLocale: true,
        targetLocale: true,
      },
    });

    if (!document) {
      logger.warn({ documentId }, 'Document not found for glossary lookup');
      return [];
    }

    // Fetch all DocumentGlossaryEntry records for this document
    const documentEntries = await prisma.documentGlossaryEntry.findMany({
      where: { documentId },
      orderBy: { occurrenceCount: 'desc' }, // Prioritize by frequency
      select: {
        sourceTerm: true,
        targetTerm: true,
        occurrenceCount: true,
      },
    });

    if (documentEntries.length === 0) {
      return [];
    }

    // Filter: Find terms whose sourceTerm appears in the segment source text
    // Use case-insensitive matching and word boundary awareness
    const matchingTerms = documentEntries.filter((entry) => {
      const sourceTerm = entry.sourceTerm.trim();
      if (!sourceTerm) return false;

      // Simple string match (case-insensitive)
      // Check if the term appears as a whole word or phrase in the source text
      const escapedTerm = sourceTerm.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const regex = new RegExp(`\\b${escapedTerm}\\b`, 'i');
      return regex.test(sourceText);
    });

    if (matchingTerms.length === 0) {
      return [];
    }

    // Get projectId for lookup
    const documentWithProject = await prisma.document.findUnique({
      where: { id: documentId },
      select: { projectId: true },
    });

    // Lookup status from GlossaryEntry for each matching term
    const termsWithStatus = await Promise.all(
      matchingTerms.map(async (entry) => {
        // Find matching GlossaryEntry to determine status
        // If GlossaryEntry exists, DocumentGlossaryEntry is APPROVED, otherwise CANDIDATE
        // First check global (projectId: null), then project-specific
        let glossaryEntry = await prisma.glossaryEntry.findFirst({
          where: {
            projectId: null, // Global first
            sourceTerm: { equals: entry.sourceTerm, mode: 'insensitive' },
            sourceLocale: document.sourceLocale,
            targetLocale: document.targetLocale,
          },
          select: {
            id: true,
          },
        });

        // If not found in global, check project-specific
        if (!glossaryEntry && documentWithProject?.projectId) {
          glossaryEntry = await prisma.glossaryEntry.findFirst({
            where: {
              projectId: documentWithProject.projectId,
              sourceTerm: { equals: entry.sourceTerm, mode: 'insensitive' },
              sourceLocale: document.sourceLocale,
              targetLocale: document.targetLocale,
            },
            select: {
              id: true,
            },
          });
        }

        // If GlossaryEntry exists, status is APPROVED (PREFERRED), otherwise CANDIDATE
        const status = glossaryEntry ? 'APPROVED' : 'CANDIDATE';

        return {
          sourceTerm: entry.sourceTerm,
          targetTerm: entry.targetTerm,
          status,
          occurrenceCount: entry.occurrenceCount,
        };
      }),
    );

    // Sort: APPROVED first, then by occurrenceCount descending
    termsWithStatus.sort((a, b) => {
      // Priority: APPROVED > CANDIDATE > DEPRECATED
      const statusPriority = { APPROVED: 3, CANDIDATE: 2, DEPRECATED: 1 };
      const aPriority = statusPriority[a.status as keyof typeof statusPriority] || 0;
      const bPriority = statusPriority[b.status as keyof typeof statusPriority] || 0;

      if (aPriority !== bPriority) {
        return bPriority - aPriority; // Higher priority first
      }

      // If same status, sort by occurrence count
      return b.occurrenceCount - a.occurrenceCount;
    });

    // Filter out DEPRECATED terms and limit to top 20
    const topTerms = termsWithStatus
      .filter((term) => term.status !== 'DEPRECATED')
      .slice(0, 20);

    logger.debug(
      {
        documentId,
        sourceTextLength: sourceText.length,
        totalDocumentEntries: documentEntries.length,
        matchingTerms: matchingTerms.length,
        topTermsReturned: topTerms.length,
      },
      'Document glossary lookup for segment',
    );

    return topTerms;
  } catch (error: any) {
    logger.error(
      { documentId, error: error.message, stack: error.stack },
      'Error in getDocumentGlossaryForSegment',
    );
    // Return empty array on error to not break translation flow
    return [];
  }
};

/**
 * Get all document-specific style rules
 * Used for Stage 2: Context-Aware Translation ("The Drafter")
 */
export const getDocumentStyleRules = async (
  documentId: string,
): Promise<Array<{ ruleType: string; pattern: string; description: string | null; examples: any }>> => {
  try {
    const styleRules = await prisma.documentStyleRule.findMany({
      where: { documentId },
      orderBy: { priority: 'desc' }, // Higher priority first
      select: {
        ruleType: true,
        pattern: true,
        description: true,
        examples: true,
      },
    });

    logger.debug(
      {
        documentId,
        styleRulesCount: styleRules.length,
      },
      'Fetched document style rules',
    );

    return styleRules;
  } catch (error: any) {
    logger.error(
      { documentId, error: error.message, stack: error.stack },
      'Error in getDocumentStyleRules',
    );
    // Return empty array on error to not break translation flow
    return [];
  }
};

/**
 * Get all document glossary entries for a document
 * Returns entries with status (APPROVED if exists in GlossaryEntry, CANDIDATE otherwise)
 * Used by frontend to display document glossary
 */
export const listDocumentGlossary = async (
  documentId: string,
): Promise<Array<{
  id: string;
  sourceTerm: string;
  targetTerm: string;
  frequency: number;
  status: 'CANDIDATE' | 'APPROVED' | 'DEPRECATED';
  source: 'global' | 'project' | 'new';
}>> => {
  try {
    // Check if documentGlossaryEntry model exists in Prisma client
    if (!prisma.documentGlossaryEntry) {
      logger.warn('DocumentGlossaryEntry model not available in Prisma client. Please run: npx prisma generate');
      throw ApiError.badRequest('DocumentGlossaryEntry model not available. Please run: npx prisma generate');
    }

    // Get document with project info
    const document = await prisma.document.findUnique({
      where: { id: documentId },
      select: {
        id: true,
        sourceLocale: true,
        targetLocale: true,
        projectId: true,
      },
    });

    if (!document) {
      throw ApiError.notFound('Document not found');
    }

    // Get all document glossary entries (including status field)
    // Note: Prisma client needs to be regenerated after adding status field to schema
    const documentEntries = await prisma.documentGlossaryEntry.findMany({
      where: { documentId },
      orderBy: { occurrenceCount: 'desc' },
    });

    // For each entry, check if it exists in GlossaryEntry to determine status
    // Priority: DocumentGlossaryEntry.status (user's review decision) > GlossaryEntry existence
    const entriesWithStatus = await Promise.all(
      documentEntries.map(async (entry) => {
        // Read status directly from database using raw SQL (since Prisma client may be out of sync)
        const statusResult = await prisma.$queryRawUnsafe<Array<{ status: string | null }>>(
          `SELECT "status" FROM "DocumentGlossaryEntry" WHERE "id" = $1`,
          entry.id
        );
        const entryStatus = statusResult[0]?.status as string | null | undefined;
        // If DocumentGlossaryEntry has an explicit status (from user review), use it
        // This allows rejected/approved/candidate terms to maintain their status even if GlossaryEntry exists
        if (entryStatus && (entryStatus === 'DEPRECATED' || entryStatus === 'APPROVED' || entryStatus === 'CANDIDATE')) {
          let source: 'global' | 'project' | 'new' = 'new';
          
          // Determine source based on GlossaryEntry existence
          let glossaryEntry = await prisma.glossaryEntry.findFirst({
            where: {
              projectId: null,
              sourceTerm: { equals: entry.sourceTerm, mode: 'insensitive' },
              sourceLocale: document.sourceLocale,
              targetLocale: document.targetLocale,
            },
            select: { id: true },
          });

          if (glossaryEntry) {
            source = 'global';
          } else if (document.projectId) {
            glossaryEntry = await prisma.glossaryEntry.findFirst({
              where: {
                projectId: document.projectId,
                sourceTerm: { equals: entry.sourceTerm, mode: 'insensitive' },
                sourceLocale: document.sourceLocale,
                targetLocale: document.targetLocale,
              },
              select: { id: true },
            });
            if (glossaryEntry) {
              source = 'project';
            }
          }

          return {
            id: entry.id,
            sourceTerm: entry.sourceTerm,
            targetTerm: entry.targetTerm,
            frequency: entry.occurrenceCount,
            status: entryStatus as 'CANDIDATE' | 'APPROVED' | 'DEPRECATED',
            source,
          };
        }

        // No explicit status - determine from GlossaryEntry existence
        // Check global glossary first
        let glossaryEntry = await prisma.glossaryEntry.findFirst({
          where: {
            projectId: null,
            sourceTerm: { equals: entry.sourceTerm, mode: 'insensitive' },
            sourceLocale: document.sourceLocale,
            targetLocale: document.targetLocale,
          },
          select: { id: true },
        });

        let source: 'global' | 'project' | 'new' = 'new';
        let status: 'CANDIDATE' | 'APPROVED' | 'DEPRECATED' = 'CANDIDATE';

        if (glossaryEntry) {
          // Exists in global glossary - APPROVED
          source = 'global';
          status = 'APPROVED';
        } else if (document.projectId) {
          // Check project glossary
          glossaryEntry = await prisma.glossaryEntry.findFirst({
            where: {
              projectId: document.projectId,
              sourceTerm: { equals: entry.sourceTerm, mode: 'insensitive' },
              sourceLocale: document.sourceLocale,
              targetLocale: document.targetLocale,
            },
            select: { id: true },
          });

          if (glossaryEntry) {
            // Exists in project glossary - APPROVED
            source = 'project';
            status = 'APPROVED';
          } else {
            // Only in document glossary - CANDIDATE
            source = 'new';
            status = 'CANDIDATE';
          }
        } else {
          // No project, not in global - CANDIDATE
          source = 'new';
          status = 'CANDIDATE';
        }

        return {
          id: entry.id,
          sourceTerm: entry.sourceTerm,
          targetTerm: entry.targetTerm,
          frequency: entry.occurrenceCount,
          status,
          source,
        };
      }),
    );

    return entriesWithStatus;
  } catch (error: any) {
    logger.error(
      { documentId, error: error.message, stack: error.stack },
      'Error in listDocumentGlossary',
    );
    throw ApiError.badRequest(`Failed to get document glossary: ${error.message}`);
  }
};

/**
 * Clear all document glossary entries for a document.
 * Does not touch style rules or DNA.
 */
export const clearDocumentGlossary = async (documentId: string): Promise<{ deleted: number }> => {
  if (!prisma.documentGlossaryEntry) {
    throw ApiError.badRequest('DocumentGlossaryEntry model not available. Please run: npx prisma generate');
  }
  const result = await prisma.documentGlossaryEntry.deleteMany({
    where: { documentId },
  });
  logger.info({ documentId, deleted: result.count }, 'Document glossary cleared');
  return { deleted: result.count };
};

/**
 * Update a document glossary entry
 * Used by frontend to update status or targetTerm
 */
export const updateDocumentGlossaryEntry = async (
  documentId: string,
  entryId: string,
  data: { status?: 'PREFERRED' | 'DEPRECATED' | 'CANDIDATE'; targetTerm?: string },
): Promise<{
  id: string;
  sourceTerm: string;
  targetTerm: string;
  status: 'CANDIDATE' | 'APPROVED' | 'DEPRECATED';
}> => {
  try {
    // Get the document glossary entry with document info
    const documentEntry = await prisma.documentGlossaryEntry.findFirst({
      where: {
        id: entryId,
        documentId,
      },
      include: {
        document: {
          select: {
            sourceLocale: true,
            targetLocale: true,
            projectId: true,
          },
        },
      },
    });

    if (!documentEntry) {
      throw ApiError.notFound('Document glossary entry not found');
    }

    const { document } = documentEntry;

    // Find or create the corresponding GlossaryEntry
    // When approving (PREFERRED), we want to save to Global Glossary (projectId: null)
    // When rejecting (DEPRECATED) or setting to CANDIDATE, we can save to project scope
    
    // First check global (projectId: null) - this is where approved terms should be
    let glossaryEntry = await prisma.glossaryEntry.findFirst({
      where: {
        projectId: null,
        sourceTerm: { equals: documentEntry.sourceTerm, mode: 'insensitive' },
        sourceLocale: document.sourceLocale,
        targetLocale: document.targetLocale,
      },
    });

    // If not found in global, check project-specific
    if (!glossaryEntry) {
      glossaryEntry = await prisma.glossaryEntry.findFirst({
        where: {
          projectId: document.projectId,
          sourceTerm: { equals: documentEntry.sourceTerm, mode: 'insensitive' },
          sourceLocale: document.sourceLocale,
          targetLocale: document.targetLocale,
        },
      });
    }

    // If still not found, create a new GlossaryEntry (only if status is being set)
    if (!glossaryEntry && data.status !== undefined) {
      // IMPORTANT: Only create in Global Glossary when approving (PREFERRED)
      // CANDIDATE terms go to project scope (if project exists)
      // DEPRECATED terms should NOT have a GlossaryEntry
      if (data.status === 'PREFERRED') {
        // Create in global glossary
        glossaryEntry = await prisma.glossaryEntry.create({
          data: {
            sourceTerm: documentEntry.sourceTerm,
            targetTerm: data.targetTerm || documentEntry.targetTerm,
            sourceLocale: document.sourceLocale,
            targetLocale: document.targetLocale,
            direction: `${document.sourceLocale}-${document.targetLocale}`,
            projectId: null, // Global scope
          },
        });
        logger.info(
          {
            documentId: documentEntry.documentId,
            sourceTerm: documentEntry.sourceTerm,
            targetTerm: data.targetTerm || documentEntry.targetTerm,
          },
          'Created term in Global Glossary after approval in Glossary Review',
        );
      } else if (data.status === 'CANDIDATE' && document.projectId) {
        // Create in project glossary when setting to CANDIDATE (if project exists)
        glossaryEntry = await prisma.glossaryEntry.create({
          data: {
            sourceTerm: documentEntry.sourceTerm,
            targetTerm: data.targetTerm || documentEntry.targetTerm,
            sourceLocale: document.sourceLocale,
            targetLocale: document.targetLocale,
            direction: `${document.sourceLocale}-${document.targetLocale}`,
            projectId: document.projectId, // Project scope
          },
        });
        logger.info(
          {
            documentId: documentEntry.documentId,
            sourceTerm: documentEntry.sourceTerm,
          },
          'Created term in Project Glossary after reset to candidate',
        );
      }
      // DEPRECATED status: do not create GlossaryEntry
    } else if (glossaryEntry && data.status !== undefined) {
      // Update existing GlossaryEntry
      const updateData: any = {};
      
      // If approving (PREFERRED) and entry is in project scope, move to global scope
      if (data.status === 'PREFERRED' && glossaryEntry.projectId !== null) {
        updateData.projectId = null; // Move to global
        logger.info(
          {
            documentId: documentEntry.documentId,
            sourceTerm: documentEntry.sourceTerm,
            previousProjectId: glossaryEntry.projectId,
          },
          'Moving term from project to Global Glossary after approval',
        );
      }
      
      // If rejecting (DEPRECATED), delete the GlossaryEntry so it's not used in translations
      if (data.status === 'DEPRECATED') {
        await prisma.glossaryEntry.delete({
          where: { id: glossaryEntry.id },
        });
        glossaryEntry = null; // Mark as deleted
        logger.info(
          {
            documentId: documentEntry.documentId,
            sourceTerm: documentEntry.sourceTerm,
          },
          'Deleted term from Glossary (rejected/deprecated)',
        );
      } else if (data.status === 'CANDIDATE') {
        // Setting to CANDIDATE: move from global to project scope if needed
        // #region agent log
        fetch('http://127.0.0.1:7242/ingest/7f529324-455d-4ca1-81c1-cbc867a5b6ab',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'analysis.service.ts:7895',message:'Setting status to CANDIDATE',data:{entryId,glossaryEntryId:glossaryEntry.id,currentProjectId:glossaryEntry.projectId,documentProjectId:document.projectId},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'E'})}).catch(()=>{});
        // #endregion
        if (glossaryEntry.projectId === null) {
          // If setting to CANDIDATE and entry is in global scope, move to project scope
          updateData.projectId = document.projectId; // Move to project scope
          logger.info(
            {
              documentId: documentEntry.documentId,
              sourceTerm: documentEntry.sourceTerm,
            },
            'Moving term from Global Glossary to project scope (set to candidate)',
          );
        }
        // If already in project scope, no change needed
      } else {
        // For other status changes, update the entry
        
        if (data.targetTerm !== undefined) {
          updateData.targetTerm = data.targetTerm;
        }

        if (Object.keys(updateData).length > 0) {
          glossaryEntry = await prisma.glossaryEntry.update({
            where: { id: glossaryEntry.id },
            data: updateData,
          });
        } else if (data.targetTerm !== undefined) {
          // Just update targetTerm if no other changes
          glossaryEntry = await prisma.glossaryEntry.update({
            where: { id: glossaryEntry.id },
            data: { targetTerm: data.targetTerm },
          });
        }
      }
    } else if (glossaryEntry && data.targetTerm !== undefined) {
      // Just update targetTerm if no status change
      glossaryEntry = await prisma.glossaryEntry.update({
        where: { id: glossaryEntry.id },
        data: { targetTerm: data.targetTerm },
      });
    }

    // Update the DocumentGlossaryEntry with status and/or targetTerm
    // Use raw SQL for status field until Prisma client is regenerated
    if (data.status !== undefined) {
      // Map PREFERRED to APPROVED for DocumentGlossaryEntry status
      const statusValue = data.status === 'PREFERRED' ? 'APPROVED' : data.status;
      await prisma.$executeRawUnsafe(
        `UPDATE "DocumentGlossaryEntry" SET "status" = $1 WHERE "id" = $2`,
        statusValue,
        entryId
      );
    }
    
    if (data.targetTerm !== undefined && data.targetTerm !== documentEntry.targetTerm) {
      await prisma.documentGlossaryEntry.update({
        where: { id: entryId },
        data: { targetTerm: data.targetTerm },
      });
    }

    // Determine final status based on GlossaryEntry location and requested status
    // Status mapping:
    // - Global Glossary (projectId: null) = APPROVED/PREFERRED
    // - Project Glossary (projectId: set) = CANDIDATE
    // - If status was explicitly set to DEPRECATED, return DEPRECATED
    let finalStatus: 'CANDIDATE' | 'APPROVED' | 'DEPRECATED';
    if (data.status === 'DEPRECATED') {
      finalStatus = 'DEPRECATED';
    } else if (glossaryEntry && glossaryEntry.projectId === null) {
      // In Global Glossary = APPROVED
      finalStatus = 'APPROVED';
    } else if (glossaryEntry && glossaryEntry.projectId !== null) {
      // In Project Glossary = CANDIDATE
      finalStatus = 'CANDIDATE';
    } else {
      // No GlossaryEntry exists = CANDIDATE
      finalStatus = 'CANDIDATE';
    }

    // Get updated document entry
    const updatedEntry = await prisma.documentGlossaryEntry.findUnique({
      where: { id: entryId },
    });

    if (!updatedEntry) {
      throw ApiError.notFound('Entry not found after update');
    }

    // Read status directly from database using raw SQL (since Prisma client may be out of sync)
    const statusResult = await prisma.$queryRawUnsafe<Array<{ status: string }>>(
      `SELECT "status" FROM "DocumentGlossaryEntry" WHERE "id" = $1`,
      entryId
    );
    const dbStatus = statusResult[0]?.status as 'CANDIDATE' | 'APPROVED' | 'DEPRECATED' | undefined;

    // Get the final target term (from GlossaryEntry if it exists, otherwise from DocumentGlossaryEntry)
    const finalTargetTerm = glossaryEntry?.targetTerm || updatedEntry.targetTerm;

    // Use status from database if available, otherwise fall back to logic-based finalStatus
    const returnStatus = dbStatus || finalStatus;

    return {
      id: updatedEntry.id,
      sourceTerm: updatedEntry.sourceTerm,
      targetTerm: finalTargetTerm,
      status: returnStatus,
    };
  } catch (error: any) {
    logger.error(
      { documentId, entryId, error: error.message, stack: error.stack },
      'Error in updateDocumentGlossaryEntry',
    );
    throw ApiError.badRequest(`Failed to update document glossary entry: ${error.message}`);
  }
};

/**
 * Translate a single term on-demand
 * 
 * @param sourceTerm - The term to translate
 * @param targetLang - Target language code (default: 'ru')
 * @param sourceLang - Source language code (optional, will try to auto-detect if not provided)
 * @param projectId - Optional project ID to use project-specific AI settings
 * @returns The translated term
 */
export const translateSingleTerm = async (
  sourceTerm: string,
  targetLang: string = 'ru',
  sourceLang?: string,
  projectId?: string,
): Promise<string> => {
  try {
    if (!sourceTerm || sourceTerm.trim().length === 0) {
      throw ApiError.badRequest('Source term is required');
    }

    // Auto-detect source language if not provided (simple heuristic)
    let detectedSourceLang = sourceLang;
    if (!detectedSourceLang) {
      // Check if text contains Cyrillic characters (Russian/Kazakh/etc)
      const hasCyrillic = /[а-яёА-ЯЁҚқҒғҢңҰұҮүӘәІіӨөҺһ]/.test(sourceTerm);
      const hasLatin = /[a-zA-Z]/.test(sourceTerm);
      detectedSourceLang = hasCyrillic && !hasLatin ? 'ru' : 'en';
    }

    // Get AI provider and settings
    const { getProvider } = await import('../ai/providers/registry');
    const { getProjectAISettings } = await import('./ai.service');
    
    let provider: any;
    let model: string;
    let apiKey: string | undefined;
    let yandexFolderId: string | undefined;

    if (projectId) {
      // Use project-specific settings
      const aiSettings = await getProjectAISettings(projectId);
      
      if (aiSettings?.provider && aiSettings?.model) {
        provider = getProvider(aiSettings.provider as 'gemini' | 'openai' | 'yandex' | 'deepseek', undefined, undefined);
        model = aiSettings.model;
        
        // Extract API key from project settings config
        if (aiSettings.config && typeof aiSettings.config === 'object' && !Array.isArray(aiSettings.config)) {
          const config = aiSettings.config as Record<string, unknown>;
          const providerName = aiSettings.provider?.toLowerCase();
          
          const providerKeyName = providerName ? `${providerName}ApiKey` : null;
          if (providerKeyName && providerKeyName in config) {
            apiKey = config[providerKeyName] as string;
          } else if ('apiKey' in config) {
            apiKey = config.apiKey as string;
          }
          
          if ('yandexFolderId' in config) {
            yandexFolderId = config.yandexFolderId as string;
          }
        }
        
        // Re-instantiate provider with API key if available
        if (apiKey || yandexFolderId) {
          provider = getProvider(aiSettings.provider as 'gemini' | 'openai' | 'yandex' | 'deepseek', apiKey, yandexFolderId);
        }
      } else {
        // Fallback to default provider
        provider = getProvider('gemini');
        model = 'gemini-2.0-flash';
      }
    } else {
      // Use default provider
      provider = getProvider('gemini');
      model = 'gemini-2.0-flash';
    }

    // Build translation prompt
    const translationPrompt = `You are a technical translator. Translate this technical term into ${targetLang}. Term: ${sourceTerm}. Return ONLY the translation.`;

    // Use a model without thoughts for simple translation tasks
    let translationModel = model;
    if (model.includes('2.5-pro') || model.includes('2.5-flash')) {
      translationModel = 'gemini-2.0-flash';
    }

    const response = await provider.callModel({
      prompt: translationPrompt,
      systemPrompt: 'You are a professional translator. Translate technical terms accurately and concisely. Return only the translation, no explanations.',
      model: translationModel,
      temperature: 0.1,
      maxTokens: translationModel.includes('2.5-pro') ? 2000 : (translationModel.includes('2.5-flash') ? 1000 : 200),
      segments: [],
    });

    let translated = response.outputText.trim();
    
    // Clean up response: remove "THINK:" leakage, explanations, etc.
    if (translated.includes('THINK:') || translated.includes('Thinking:')) {
      const lines = translated.split('\n');
      let cleanedTranslation = '';
      for (let i = lines.length - 1; i >= 0; i--) {
        const line = lines[i].trim();
        if (line && !line.startsWith('THINK:') && !line.startsWith('Thinking:') && !line.toLowerCase().includes('the user wants')) {
          if (line.length < 200 && !line.includes('means') && !line.includes('refers to')) {
            cleanedTranslation = line;
            break;
          }
        }
      }
      if (cleanedTranslation) {
        translated = cleanedTranslation;
      } else {
        // Fallback: try to extract text after quotes
        const quoteMatch = translated.match(/"([^"]+)"/);
        if (quoteMatch) {
          translated = quoteMatch[1];
        }
      }
    }
    
    // Handle JSON response format
    if (translated.startsWith('[') && translated.endsWith(']')) {
      try {
        const parsed = JSON.parse(translated);
        if (Array.isArray(parsed) && parsed.length > 0 && parsed[0].target_mt) {
          translated = parsed[0].target_mt.trim();
        }
      } catch (e) {
        // If JSON parsing fails, use original response
      }
    }

    // Final cleanup: remove markdown, quotes, etc.
    translated = translated
      .replace(/^["']|["']$/g, '') // Remove surrounding quotes
      .replace(/^\*\*|\*\*$/g, '') // Remove markdown bold
      .trim();

    if (!translated || translated.length === 0) {
      throw ApiError.badRequest('Translation failed: empty response from AI');
    }

    return translated;
  } catch (error: any) {
    logger.error(
      { sourceTerm, targetLang, sourceLang, projectId, error: error.message, stack: error.stack },
      'Error in translateSingleTerm',
    );
    throw ApiError.badRequest(`Failed to translate term: ${error.message}`);
  }
};

