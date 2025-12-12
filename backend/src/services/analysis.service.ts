import { prisma } from '../db/prisma';
import { ApiError } from '../utils/apiError';
import { logger } from '../utils/logger';
import type { Prisma } from '@prisma/client';

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
export const cancelAnalysis = (documentId: string): void => {
  analysisCancellationFlags.add(documentId);
  logger.info({ documentId }, 'Analysis cancellation requested');
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
 * Helper function to extract frequent terms from text using n-gram analysis
 * Returns phrases (unigrams, bigrams, trigrams) that appear 2+ times
 */
const extractFrequentTerms = (text: string): string[] => {
  // Common stop words to filter out
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

  // Helper function to check if a phrase is relevant
  const isRelevant = (phrase: string) => {
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

  // Filter: return phrases that appear 2+ times (frequent) AND unique terms that look like technical terms
  const frequentPhrases = Array.from(phraseFrequency.entries())
    .filter(([_, count]) => count >= 2)
    .map(([phrase]) => phrase)
    .filter((phrase) => isRelevant(phrase)); // Final filter pass

  // Also include unique terms (appearing once) that look like technical terms, proper nouns, or acronyms
  // This helps capture important terms that only appear once
  const uniqueTechnicalTerms = Array.from(phraseFrequency.entries())
    .filter(([phrase, count]) => {
      if (count !== 1) return false; // Only unique terms
      if (!isRelevant(phrase)) return false;
      
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
const translateTermWithAI = async (
  sourceTerm: string,
  sourceLocale: string,
  targetLocale: string,
  provider: any,
  model: string,
): Promise<string> => {
  const translationPrompt = `Translate the following technical term from ${sourceLocale} to ${targetLocale}. Return ONLY the translation, no explanation, no markdown, just the translated term.

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

    const translated = response.outputText.trim();
    
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
    // Silently fail progress updates - don't break the analysis
    logger.debug({ documentId, error: error.message }, 'Failed to update progress');
  }
};

/**
 * Extracts glossary terms using Hybrid approach: Algorithmic Frequency Counting + AI Filtering
 * Implements waterfall lookup: Global Glossary -> Project Glossary -> AI Translation
 */
export const extractGlossary = async (documentId: string): Promise<{ count: number }> => {
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
    
    // Extract frequent terms from confirmed source text
    const confirmedFrequentTerms = extractFrequentTerms(confirmedSourceText);
    
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
  // Prepare source text from remaining (non-confirmed) segments
  const remainingSourceText = remainingSegments
    .map((segment) => segment.sourceText)
    .filter((text) => text.trim().length > 0)
    .join(' ');

  if (!remainingSourceText.trim() && confirmedTermsMap.size === 0) {
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

  // Extract frequent terms from remaining segments (excluding confirmed)
  await updateProgress(documentId, 'frequency_analysis', 15, 'Analyzing term frequency in remaining segments...', true);
  const rawFrequentTerms = remainingSourceText.trim() ? extractFrequentTerms(remainingSourceText) : [];
  
  // Filter out terms already found in confirmed segments
  const filteredFrequentTerms = rawFrequentTerms.filter((term) => {
    const normalized = term.toLowerCase();
    return !confirmedTermsMap.has(normalized);
  });
  
  // CRITICAL: If we have very few frequent terms, this might indicate the frequency threshold is too high
  // For large documents, we should still extract terms even if they appear only once (unique terms)
  const hasLowTermCount = filteredFrequentTerms.length < 10 && remainingSegments.length > 100;
  
  logger.info(
    {
      documentId,
      remainingSourceTextLength: remainingSourceText.length,
      remainingSegmentsCount: remainingSegments.length,
      rawFrequentTermsCount: rawFrequentTerms.length,
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
  
  const provider = getProvider(aiSettings?.provider, apiKey, yandexFolderId);
  let model = aiSettings?.model ?? provider.defaultModel;
  
  // For glossary extraction, prefer gemini-2.5-pro over gemini-2.5-flash
  // Flash models use too many tokens for "thoughts" which causes truncation
  if (provider.name === 'gemini' && (model === 'gemini-pro' || model.includes('flash'))) {
    const originalModel = model;
    model = 'gemini-2.5-pro'; // Use pro model which uses fewer thoughts tokens
    logger.info(
      {
        documentId,
        originalModel,
        switchedTo: model,
        reason: 'Flash models use too many thoughts tokens causing truncation',
      },
      'Switching to gemini-2.5-pro for glossary extraction',
    );
  }

  // Step 4: Call AI for filtering and hunting
  const systemPrompt = `You are a strict Senior Terminologist and Linguist.

I will provide a list of "Raw Frequent N-grams" found in a source text.

Many of these are **fragments** (cut off) or in **oblique cases** (grammatically declined).

YOUR TASK:

Produce a clean, professional glossary based on these inputs.

STRICT RULES for TERM EXTRACTION:

1. 🧩 **REPAIR FRAGMENTS (Critical):**

   - The input list only contains up to 3-word phrases.

   - If you see a fragment like "Joint Stock Company Kazakh" (truncated), you MUST search the **Source Text** to find the **FULL Legal Name** (e.g., "Joint Stock Company Kazakhstan Electricity Grid Operating Company").

   - Use the FULL name as the \`sourceTerm\`.

2. ⚖️ **NORMALIZE GRAMMAR (Critical):**

   - Convert all source terms to their **Dictionary Form** (Nominative case / Singular).

   - Example: Change "акционерным обществом" -> "акционерное общество".

   - Example: Change "работниками" -> "работники".

3. 🧹 **FILTERING:**

   - Delete verbs, generic adjectives, and sentence connectors.

   - Delete dates and raw numbers.

   - **STRICTLY IGNORE table artifacts**: Terms that appear to be table row/column artifacts (e.g., "user 4 1", "document 15", "table 3 2"). These are NOT glossary terms.

INPUT: Source Text + List of Raw Candidates.

OUTPUT FORMAT: JSON array [{"sourceTerm": "string", "targetTerm": "string", "frequency": number}]
- "sourceTerm": The extracted term in source language (in normalized dictionary form, full name if fragment was found)
- "targetTerm": The translation of the term in target language (if you can determine it from context, otherwise use the source term)
- "frequency": The number of times it appears in the text (use 1 for unique terms you hunt)

CRITICAL REQUIREMENTS:
- Return ONLY the JSON array, no markdown code blocks, no additional text
- Do NOT wrap the response in \`\`\`json code blocks
- Include both filtered frequent terms AND hunted unique terms
- Terms should be in their normalized dictionary form (nominative case, singular)`;

  // Truncate source text if too long (keep first 50000 chars for AI processing)
  // But warn if we're truncating a large document
  const isTruncated = remainingSourceText.length > 50000;
  const sourceTextForAI = isTruncated ? remainingSourceText.substring(0, 50000) + '...' : remainingSourceText;
  
  if (isTruncated) {
    logger.warn(
      {
        documentId,
        originalLength: remainingSourceText.length,
        truncatedLength: 50000,
        segmentsCount: remainingSegments.length,
      },
      'WARNING: Source text truncated for AI processing - may miss terms in later segments',
    );
  }
  
  // CRITICAL: If filtering removed too many terms, use raw frequent terms instead
  // This ensures we always have candidates for AI to analyze
  const termsToSendToAI = filteredFrequentTerms.length >= 20 
    ? filteredFrequentTerms 
    : rawFrequentTerms.slice(0, 400); // Fallback to raw terms if filtering was too aggressive
  
  if (filteredFrequentTerms.length < 20 && rawFrequentTerms.length > filteredFrequentTerms.length) {
    logger.warn(
      {
        documentId,
        filteredCount: filteredFrequentTerms.length,
        rawCount: rawFrequentTerms.length,
      },
      'WARNING: Filtering removed too many terms - using raw frequent terms instead to ensure AI has candidates',
    );
  }

  // Build user prompt - exclude terms already found in confirmed segments
  // Include more context about the document size
  const userPrompt = `Source Text (from ${remainingSegments.length} non-confirmed segments, ${isTruncated ? 'truncated to first 50000 chars' : 'full text'}):
${sourceTextForAI}

Frequent Phrases (appearing 2+ times, or unique technical terms):
${termsToSendToAI.slice(0, 400).join('\n')}

${termsToSendToAI.length < 50 ? 'CRITICAL: Very few candidate phrases found. You MUST extract unique terms (appearing only once) that are technical terms, proper nouns, acronyms, or domain-specific jargon. Scan the entire source text carefully.' : ''}

IMPORTANT: 
- Do NOT extract terms that are already confirmed (if any were provided).
- Focus on new terms not found in confirmed segments.
- Extract BOTH frequent terms (2+ times) AND unique critical terms (proper nouns, acronyms, technical jargon).
- For a document with ${remainingSegments.length} segments, you MUST extract a substantial number of terms (at least 20-50 terms, preferably more).
- If you see proper nouns, company names, technical terms, or acronyms, extract them even if they appear only once.

Analyze the source text thoroughly and return a JSON array of terms with their frequencies.`;

  logger.info(
    {
      documentId,
      segmentsCount: document.segments.length,
      provider: provider.name,
      model,
      frequentTermsCount: rawFrequentTerms.length,
    },
    'Calling AI for glossary term filtering and hunting',
  );

  // Log before AI call: number of candidates sent
  console.log('Sending to AI:', termsToSendToAI.length, 'candidates (filtered:', filteredFrequentTerms.length, 'raw:', rawFrequentTerms.length, 'confirmed:', confirmedTermsMap.size, ')');

  // Validate input before calling AI
  if (filteredFrequentTerms.length === 0 && remainingSourceText.trim().length < 100) {
    logger.warn(
      {
        documentId,
        filteredFrequentTermsCount: filteredFrequentTerms.length,
        remainingSourceTextLength: remainingSourceText.length,
      },
      'WARNING: Very few candidates and short text - AI may return empty results',
    );
  }

  // Call AI with retry logic for stability
  await updateProgress(documentId, 'ai_glossary', 30, `Calling ${provider.name} to filter and extract terms...`, true);
  let aiResponse;
  let responseText: string;
  const maxRetries = 2;
  let attempt = 0;
  
  while (attempt < maxRetries) {
    try {
      attempt++;
      logger.info(
        {
          documentId,
          attempt,
          maxRetries,
          candidatesCount: filteredFrequentTerms.length,
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
      // #region agent log
      fetch('http://127.0.0.1:7242/ingest/7f529324-455d-4ca1-81c1-cbc867a5b6ab',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'analysis.service.ts:815',message:'Before AI call for glossary',data:{model,promptLength:userPrompt.length,systemPromptLength:systemPrompt.length,requestedMaxTokens:8192},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'I'})}).catch(()=>{});
      // #endregion
      
      // Use higher maxTokens for glossary extraction to avoid truncation
      // gemini-2.5-flash uses thoughts which can consume most tokens, so we need more headroom
      const aiCallPromise = provider.callModel({
        prompt: userPrompt,
        systemPrompt,
        model,
        temperature: 0,
        maxTokens: 8192, // Increased from 4096 to handle large term lists and thoughts
        segments: [],
      });

      const timeoutPromise = new Promise<never>((_, reject) => {
        setTimeout(() => {
          reject(new Error(`AI call timeout after 90 seconds (attempt ${attempt}/${maxRetries})`));
        }, 90000); // 90 second timeout for large documents
      });

      logger.info(
        {
          documentId,
          attempt,
          model,
          provider: provider.name,
          promptLength: userPrompt.length,
          candidatesCount: termsToSendToAI.length,
        },
        `Starting AI call for glossary extraction (with 90s timeout)`,
      );

      // Start heartbeat progress updates during AI call
      const heartbeatInterval = setInterval(async () => {
        const elapsed = Date.now() - aiCallStartTime;
        const elapsedSeconds = Math.floor(elapsed / 1000);
        // Progress from 35% to 40% during AI call (5% range over 90 seconds)
        const progress = 35 + Math.min(5, Math.floor((elapsed / 90000) * 5));
        await updateProgress(
          documentId,
          'ai_glossary',
          progress,
          `Waiting for ${provider.name} response... (${elapsedSeconds}s elapsed)`,
          true,
        );
      }, 2000); // Update every 2 seconds for more frequent feedback

      try {
        aiResponse = await Promise.race([aiCallPromise, timeoutPromise]) as any;
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
      } catch (timeoutError: any) {
        clearInterval(heartbeatInterval); // Stop heartbeat on error
        const aiCallDuration = Date.now() - aiCallStartTime;
        logger.error(
          {
            documentId,
            attempt,
            durationMs: aiCallDuration,
            error: timeoutError.message,
          },
          `AI call failed or timed out`,
        );
        throw timeoutError;
      }

      responseText = aiResponse.outputText.trim();

      // Log after AI call: raw response
        // #region agent log
        fetch('http://127.0.0.1:7242/ingest/7f529324-455d-4ca1-81c1-cbc867a5b6ab',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'analysis.service.ts:910',message:'After AI call for glossary',data:{responseLength:responseText.length,usage:aiResponse.usage,thoughtsTokenCount:aiResponse.usage?.thoughtsTokenCount,actualOutputTokens:aiResponse.usage?.candidatesTokenCount,requestedMaxTokens:8192},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'I'})}).catch(()=>{});
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
  await updateProgress(documentId, 'parsing_glossary', 43, 'Parsing AI response and extracting terms...', true);
  let aiTerms: Array<{ term: string; frequency: number }> = [];
  let parsedArrayLength = 0;
  
  try {
    // Clean markdown code blocks before parsing
    await updateProgress(documentId, 'parsing_glossary', 44, 'Cleaning JSON response...', true);
    const cleanedResponse = cleanJsonOutput(responseText);
    logger.debug(
      {
        documentId,
        originalLength: responseText.length,
        cleanedLength: cleanedResponse.length,
        wasCleaned: responseText !== cleanedResponse,
      },
      'Cleaned JSON output from markdown code blocks (glossary)',
    );

    await updateProgress(documentId, 'parsing_glossary', 45, 'Parsing JSON array...', true);
    const parsed = parseJsonArray(cleanedResponse, documentId);
    parsedArrayLength = parsed.length;

    // #region agent log
    fetch('http://127.0.0.1:7242/ingest/7f529324-455d-4ca1-81c1-cbc867a5b6ab',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'analysis.service.ts:1018',message:'Parsed JSON array from AI',data:{parsedArrayLength,responseLength:responseText.length},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'J'})}).catch(()=>{});
    // #endregion

    await updateProgress(documentId, 'parsing_glossary', 46, `Parsed ${parsedArrayLength} items, validating...`, true);

    // Enhanced validation with detailed logging
    if (parsedArrayLength === 0) {
      logger.error(
        {
          documentId,
          cleanedResponseLength: cleanedResponse.length,
          cleanedResponsePreview: cleanedResponse.substring(0, 500),
          originalResponseLength: responseText.length,
          originalResponsePreview: responseText.substring(0, 500),
        },
        'CRITICAL: Parsed array is empty - AI may have returned empty array or parsing failed',
      );
    }

    // Validate and normalize AI response format: [{"sourceTerm": "...", "targetTerm": "...", "frequency": number}]
    // Also supports legacy format: [{"term": "...", "frequency": number}]
    let validCount = 0;
    let invalidCount = 0;
    
    aiTerms = parsed
      .map((item: any, index: number) => {
        if (!item || typeof item !== 'object') {
          invalidCount++;
          logger.debug({ documentId, index, item }, 'Skipping invalid item (not an object)');
          return null;
        }
        
        const term = String(item.sourceTerm || item.term || '').trim();
        const frequency = typeof item.frequency === 'number' ? item.frequency : 1;
        
        if (!term) {
          invalidCount++;
          logger.debug({ documentId, index, item }, 'Skipping item with empty term');
          return null;
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

    // #region agent log
    fetch('http://127.0.0.1:7242/ingest/7f529324-455d-4ca1-81c1-cbc867a5b6ab',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'analysis.service.ts:1028',message:'After validation',data:{parsedArrayLength,validCount:aiTerms.length,invalidCount},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'J'})}).catch(()=>{});
    // #endregion

    // Log validation results
    logger.info(
      {
        documentId,
        parsedArrayLength,
        validItemsCount: validCount,
        invalidItemsCount: invalidCount,
        finalAiTermsCount: aiTerms.length,
      },
      'AI response validation complete',
    );

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

  // Step 6: Waterfall Lookup for each term
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
      termsToProcess: aiTerms.length,
    },
    'Starting waterfall lookup for extracted terms',
  );

  let processedCount = 0;
  const totalTerms = aiTerms.length;
  
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
        // #region agent log
        const isNotTranslated = globalEntry.targetTerm.trim() === sourceTerm.trim();
        fetch('http://127.0.0.1:7242/ingest/7f529324-455d-4ca1-81c1-cbc867a5b6ab',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'analysis.service.ts:1193',message:'Found in Global Glossary',data:{sourceTerm,targetTerm:globalEntry.targetTerm,targetTermLength:globalEntry.targetTerm.length,isNotTranslated},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'C'})}).catch(()=>{});
        // #endregion
        
        // If term is not translated (targetTerm === sourceTerm), translate it with AI
        // But first check if the term is already in the target language (e.g., English terms when target is English)
        let targetTerm = globalEntry.targetTerm;
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
        
        // If term is in Global Glossary, treat it as APPROVED regardless of DB status
        // CANDIDATE status in DB is for internal tracking (newly extracted terms),
        // but once in global glossary, it should be trusted for document translation
        finalTerms.push({
          sourceTerm: globalEntry.sourceTerm,
          targetTerm,
          frequency,
          status: 'APPROVED', // All terms from global glossary are APPROVED
          source: 'GLOBAL',
        });
        logger.debug(
          { documentId, sourceTerm, targetTerm },
          'Found term in Global Glossary',
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
        finalTerms.push({
          sourceTerm: projectEntry.sourceTerm,
          targetTerm,
          frequency,
          status: 'APPROVED', // All terms from project glossary are APPROVED
          source: 'PROJECT',
        });
        logger.debug(
          { documentId, sourceTerm, targetTerm },
          'Found term in Project Glossary',
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
            sourceTerm,
            targetTerm,
            sourceLocale: document.sourceLocale,
            targetLocale: document.targetLocale,
          },
          'Skipping term save: targetTerm equals sourceTerm (translation failed or term already in target language)',
        );
        
        // Still add to finalTerms but mark as not translated
        finalTerms.push({
          sourceTerm,
          targetTerm,
          frequency,
          status: 'CANDIDATE',
          source: 'AI',
        });
        continue;
      }

      // Save to Global Glossary as CANDIDATE
      try {
        // #region agent log
        fetch('http://127.0.0.1:7242/ingest/7f529324-455d-4ca1-81c1-cbc867a5b6ab',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'analysis.service.ts:1335',message:'Before DB save',data:{sourceTerm,targetTerm,targetTermLength:targetTerm.length},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'B'})}).catch(()=>{});
        // #endregion
        
        await prisma.glossaryEntry.create({
          data: {
            sourceTerm,
            targetTerm,
            sourceLocale: document.sourceLocale,
            targetLocale: document.targetLocale,
            direction: `${document.sourceLocale}-${document.targetLocale}`,
            projectId: null, // Global entry
            status: 'CANDIDATE',
          },
        });
        
        // #region agent log
        fetch('http://127.0.0.1:7242/ingest/7f529324-455d-4ca1-81c1-cbc867a5b6ab',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'analysis.service.ts:1260',message:'After DB save',data:{sourceTerm,targetTerm,targetTermLength:targetTerm.length},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'B'})}).catch(()=>{});
        // #endregion
        
        logger.info(
          { documentId, sourceTerm, targetTerm },
          'Saved new term to Global Glossary as CANDIDATE',
        );
      } catch (createError: any) {
        // Handle duplicate key error (term might have been added by another process)
        if (createError.code === 'P2002') {
          logger.debug(
            { documentId, sourceTerm },
            'Term already exists in Global Glossary (race condition)',
          );
          // Try to fetch it
          const existingEntry = await prisma.glossaryEntry.findFirst({
            where: {
              projectId: null,
              sourceTerm: { equals: sourceTerm, mode: 'insensitive' },
              sourceLocale: document.sourceLocale,
              targetLocale: document.targetLocale,
            },
          });
          if (existingEntry) {
            finalTerms.push({
              sourceTerm: existingEntry.sourceTerm,
              targetTerm: existingEntry.targetTerm,
              frequency,
              status: existingEntry.status === 'PREFERRED' ? 'APPROVED' : 'CANDIDATE',
              source: 'GLOBAL',
            });
            continue;
          }
        }
        logger.warn(
          { documentId, sourceTerm, error: createError.message },
          'Failed to save term to Global Glossary, continuing anyway',
        );
      }

      // Note: isNotTranslated check already done above, term already added to finalTerms if not translated
      // This code path is only reached if translation was successful and saved to DB
      // #region agent log
      fetch('http://127.0.0.1:7242/ingest/7f529324-455d-4ca1-81c1-cbc867a5b6ab',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'analysis.service.ts:1375',message:'Adding successfully translated term to finalTerms',data:{sourceTerm,targetTerm,source:'AI'},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'K'})}).catch(()=>{});
      // #endregion

      finalTerms.push({
        sourceTerm,
        targetTerm,
        frequency,
        status: 'CANDIDATE',
        source: 'AI',
      });
    } catch (error: any) {
      logger.error(
        { documentId, sourceTerm, error: error.message },
        'Error processing term in waterfall lookup',
      );
      // Continue with next term even if one fails
    }
  }

  if (finalTerms.length === 0) {
    logger.warn({ documentId }, 'No terms processed successfully after waterfall lookup');
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
        confirmedFinalTerms.push({
          sourceTerm: globalEntry.sourceTerm,
          targetTerm: globalEntry.targetTerm,
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
  // ===================================================================
  await updateProgress(documentId, 'saving_glossary', 70, 'Merging terms with existing entries (respecting approved status)...', true);
  
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

  for (const term of allFoundTerms) {
    const key = term.sourceTerm.toLowerCase();
    const existing = uniqueTermsMap.get(key);
    if (existing) {
      // Sum frequencies if duplicate
      existing.frequency += term.frequency;
      // If either is APPROVED, keep APPROVED status
      if (term.status === 'APPROVED' || existing.status === 'APPROVED') {
        existing.status = 'APPROVED';
      }
    } else {
      uniqueTermsMap.set(key, { ...term });
    }
  }

  const uniqueTerms = Array.from(uniqueTermsMap.values());
  
  // Count approved vs candidate after deduplication
  const preMergeApproved = uniqueTerms.filter((t) => t.status === 'APPROVED').length;
  const preMergeCandidate = uniqueTerms.filter((t) => t.status === 'CANDIDATE').length;
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
      select: { status: true },
    });

    if (glossaryEntry?.status === 'PREFERRED') {
      approvedTermsSet.add(entry.sourceTerm.toLowerCase());
    }
  }

  // Smart Merge: Process each unique term
  let createdCount = 0;
  let updatedCount = 0;
  let skippedCount = 0;
  let approvedCount = 0;
  let candidateCount = 0;

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
      logger.debug(
        { documentId, sourceTerm: term.sourceTerm },
        'Skipping APPROVED entry (preserving human decision)',
      );
      continue;
    }

    // If entry exists but is CANDIDATE, update it
    if (existingEntry && !isApproved) {
      await prisma.documentGlossaryEntry.update({
        where: { id: existingEntry.id },
        data: {
          targetTerm: term.targetTerm,
          occurrenceCount: term.frequency,
        },
      });
      updatedCount++;
      logger.debug(
        { documentId, sourceTerm: term.sourceTerm },
        'Updated CANDIDATE entry',
      );
      
      // If the term is now APPROVED (from confirmed segments or global glossary),
      // ensure GlossaryEntry exists with PREFERRED status
      if (term.status === 'APPROVED') {
        try {
          // Determine if this should be a global entry (GLOBAL or CONFIRMED sources)
          const isGlobalEntry = term.source === 'GLOBAL' || term.source === 'CONFIRMED';
          
          const existingGlossaryEntry = await prisma.glossaryEntry.findFirst({
            where: {
              OR: [
                { projectId: null },
                { projectId: document.projectId },
              ],
              sourceTerm: { equals: term.sourceTerm, mode: 'insensitive' },
              sourceLocale: document.sourceLocale,
              targetLocale: document.targetLocale,
            },
          });
          
          if (!existingGlossaryEntry) {
            await prisma.glossaryEntry.create({
              data: {
                sourceTerm: term.sourceTerm,
                targetTerm: term.targetTerm,
                sourceLocale: document.sourceLocale,
                targetLocale: document.targetLocale,
                direction: `${document.sourceLocale}-${document.targetLocale}`,
                projectId: isGlobalEntry ? null : document.projectId,
                status: 'PREFERRED',
              },
            });
            logger.info(
              { 
                documentId, 
                sourceTerm: term.sourceTerm, 
                source: term.source,
                isGlobalEntry,
              },
              'Created GlossaryEntry with PREFERRED status for APPROVED term (during update)',
            );
          } else if (existingGlossaryEntry.status !== 'PREFERRED') {
            await prisma.glossaryEntry.update({
              where: { id: existingGlossaryEntry.id },
              data: { status: 'PREFERRED' },
            });
            logger.info(
              { documentId, sourceTerm: term.sourceTerm, entryId: existingGlossaryEntry.id },
              'Updated GlossaryEntry to PREFERRED status for APPROVED term (during update)',
            );
          }
        } catch (error: any) {
          logger.warn(
            { documentId, sourceTerm: term.sourceTerm, source: term.source, error: error.message },
            'Failed to create/update GlossaryEntry for APPROVED term (non-critical)',
          );
        }
      }
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
    
    // CRITICAL: If term is APPROVED (from confirmed segments or global glossary), 
    // ensure a GlossaryEntry exists with status PREFERRED so listDocumentGlossary can find it
    if (term.status === 'APPROVED') {
      try {
        // Determine if this should be a global entry (GLOBAL or CONFIRMED sources)
        // CONFIRMED terms come from confirmed segments and should be in global glossary
        const isGlobalEntry = term.source === 'GLOBAL' || term.source === 'CONFIRMED';
        
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
          // Create GlossaryEntry with PREFERRED status so it shows as APPROVED in the table
          // CONFIRMED and GLOBAL terms go to global glossary (projectId: null)
          await prisma.glossaryEntry.create({
            data: {
              sourceTerm: term.sourceTerm,
              targetTerm: term.targetTerm,
              sourceLocale: document.sourceLocale,
              targetLocale: document.targetLocale,
              direction: `${document.sourceLocale}-${document.targetLocale}`,
              projectId: isGlobalEntry ? null : document.projectId,
              status: 'PREFERRED', // This will make it show as APPROVED in listDocumentGlossary
            },
          });
          logger.info(
            { 
              documentId, 
              sourceTerm: term.sourceTerm, 
              source: term.source,
              isGlobalEntry,
              projectId: isGlobalEntry ? null : document.projectId,
            },
            'Created GlossaryEntry with PREFERRED status for APPROVED term',
          );
        } else if (existingGlossaryEntry.status !== 'PREFERRED') {
          // Update existing entry to PREFERRED if it's not already
          await prisma.glossaryEntry.update({
            where: { id: existingGlossaryEntry.id },
            data: { status: 'PREFERRED' },
          });
          logger.info(
            { documentId, sourceTerm: term.sourceTerm, entryId: existingGlossaryEntry.id },
            'Updated GlossaryEntry to PREFERRED status for APPROVED term',
          );
        } else {
          logger.debug(
            { documentId, sourceTerm: term.sourceTerm, entryId: existingGlossaryEntry.id },
            'GlossaryEntry already has PREFERRED status for APPROVED term',
          );
        }
      } catch (error: any) {
        // Non-critical: if GlossaryEntry creation fails, log but continue
        logger.warn(
          { documentId, sourceTerm: term.sourceTerm, source: term.source, error: error.message },
          'Failed to create/update GlossaryEntry for APPROVED term (non-critical)',
        );
      }
    }
  }

  // CRITICAL FIX: Query actual database count (includes preserved APPROVED entries)
  // This ensures consistency with getAnalysisResults
  await updateProgress(documentId, 'saving_glossary', 90, 'Finalizing glossary extraction...', true);
  
  const actualDbCount = await prisma.documentGlossaryEntry.count({
    where: { documentId },
  });

  const finalCount = actualDbCount; // Use actual DB count, not just created+updated

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
        rawFrequentTermsCount: rawFrequentTerms.length,
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
  fetch('http://127.0.0.1:7242/ingest/7f529324-455d-4ca1-81c1-cbc867a5b6ab',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'analysis.service.ts:1870',message:'Final glossary extraction summary',data:{totalSegments,aiTermsCount:aiTerms.length,finalTermsCount:finalCount,createdCount,updatedCount},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'J'})}).catch(()=>{});
  // #endregion

  return { count: finalCount };
};

/**
 * Extracts style rules from document source text
 * Analyzes formatting patterns like date formats, number formats, list styles, etc.
 */
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
  try {
    aiResponse = await provider.callModel({
      prompt: userPrompt,
      systemPrompt,
      model,
      temperature: 0.1, // Low temperature for consistent extraction
      maxTokens: 4096, // Allow for large rule sets
      segments: [], // Not needed for style rule extraction
    });

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

  // Query actual database count (includes preserved existing rules)
  const actualDbCount = await prisma.documentStyleRule.count({
    where: { documentId },
  });

  const result = { count: actualDbCount }; // Return actual DB count

  // Update or create DocumentAnalysis record
  await updateProgress(documentId, 'completed', 100, `Style rule extraction completed: ${actualDbCount} rules (${createdCount} created, ${updatedCount} updated)`, false);
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
      currentMessage: `Style rule extraction completed: ${actualDbCount} rules (${createdCount} created, ${updatedCount} updated). Glossary extraction in progress...`,
    },
    update: {
      // Do NOT change status to COMPLETED - keep it RUNNING until glossary is done
      styleRulesExtracted: true,
      currentStage: 'saving_style',
      progressPercentage: 85, // Style rules are 50% of the work, so 85% when style rules done
      currentMessage: `Style rule extraction completed: ${actualDbCount} rules (${createdCount} created, ${updatedCount} updated). Glossary extraction in progress...`,
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
export const runFullAnalysis = async (documentId: string, forceReset: boolean = false): Promise<{
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
      progressPercentage: 0,
      currentMessage: 'Initializing analysis...',
    },
    update: {
      status: 'RUNNING',
      glossaryExtracted: false,
      styleRulesExtracted: false,
      completedAt: null,
      currentStage: 'initializing',
      progressPercentage: 0,
      currentMessage: 'Initializing analysis...',
    },
  });

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
        select: { status: true },
      });

      if (glossaryEntry?.status === 'PREFERRED') {
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

    // Run both extractions in parallel
    // CRITICAL: Do NOT catch errors here - let them propagate so the analysis fails properly
    // This ensures rate limits, API errors, etc. are reported to the user instead of silently returning 0
    const [glossaryResult, styleRulesResult] = await Promise.all([
      extractGlossary(documentId),
      extractStyleRules(documentId),
    ]);

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
          select: { status: true },
        });
        
        if (glossaryEntry?.status === 'PREFERRED') {
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
    await prisma.documentAnalysis.update({
      where: { documentId },
      data: {
        status: 'COMPLETED',
        completedAt: new Date(),
        currentStage: 'completed',
        progressPercentage: 100,
        currentMessage: `Analysis completed: ${finalGlossaryCount} terms (${approvedFinalCount} approved, ${candidateFinalCount} candidate), ${finalStyleRulesCount} style rules`,
      },
    });

    logger.info(
      {
        documentId,
        glossaryCount: finalGlossaryCount,
        styleRulesCount: finalStyleRulesCount,
        glossaryCreatedUpdated: glossaryResult.count,
        styleRulesCreatedUpdated: styleRulesResult.count,
      },
      'Full document analysis completed',
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
    let approvedCount = 0;
    let candidateCount = 0;
    
    if (glossaryEntries.length > 0 && analysis.document) {
      for (const entry of glossaryEntries) {
        const glossaryEntry = await prisma.glossaryEntry.findFirst({
          where: {
            OR: [
              { projectId: null },
              { projectId: analysis.document.projectId || undefined },
            ],
            sourceTerm: { equals: entry.sourceTerm, mode: 'insensitive' },
            sourceLocale: analysis.document.sourceLocale,
            targetLocale: analysis.document.targetLocale,
          },
          select: { status: true },
        });
        
        if (glossaryEntry?.status === 'PREFERRED') {
          approvedCount++;
        } else {
          candidateCount++;
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

    // Lookup status from GlossaryEntry for each matching term
    const termsWithStatus = await Promise.all(
      matchingTerms.map(async (entry) => {
        // Find matching GlossaryEntry to get status
        const glossaryEntry = await prisma.glossaryEntry.findFirst({
          where: {
            sourceTerm: entry.sourceTerm,
            sourceLocale: document.sourceLocale,
            targetLocale: document.targetLocale,
          },
          select: {
            status: true,
          },
        });

        const status = glossaryEntry?.status || 'CANDIDATE';

        return {
          sourceTerm: entry.sourceTerm,
          targetTerm: entry.targetTerm,
          status,
          occurrenceCount: entry.occurrenceCount,
        };
      }),
    );

    // Sort: PREFERRED first, then by occurrenceCount descending
    termsWithStatus.sort((a, b) => {
      // Priority: PREFERRED > CANDIDATE > DEPRECATED
      const statusPriority = { PREFERRED: 3, CANDIDATE: 2, DEPRECATED: 1 };
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

