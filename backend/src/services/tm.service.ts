import { XMLParser } from 'fast-xml-parser';
import { prisma } from '../db/prisma';
// Type definition - Prisma client should export this, but using workaround if not available
type TranslationMemoryEntry = {
  id: string;
  projectId: string | null;
  tmxFileId: string | null;
  createdById: string;
  sourceLocale: string;
  targetLocale: string;
  sourceText: string;
  targetText: string;
  clientName: string | null;
  domain: string | null;
  matchRate: number | null;
  usageCount: number;
  createdAt: Date;
  sourceEmbedding?: unknown;
  embeddingModel?: string | null;
  embeddingVersion?: string | null;
  embeddingUpdatedAt?: Date | null;
  tmxFile?: { filename?: string; name?: string; lastImportedAt?: Date | null } | null;
};
import { ApiError } from '../utils/apiError';
import { computeFuzzyScore, type FuzzyScoreBreakdown } from '../utils/fuzzy';
import { generateEmbedding } from './embedding.service';
import { searchByVector } from './vector-search.service';
import { logger } from '../utils/logger';
import { generateEmbeddingForEntry } from './embedding-generation.service';

const tmxParser = new XMLParser({ ignoreAttributes: false });

// Simple in-memory cache for recent searches (LRU-style, max 100 entries)
const searchCache = new Map<string, { results: TmSearchResult[]; timestamp: number }>();
const CACHE_TTL = 30000; // 30 seconds
const MAX_CACHE_SIZE = 100;

const getCacheKey = (sourceText: string, sourceLocale: string, targetLocale: string, projectId?: string) => {
  return `${projectId || 'global'}:${sourceLocale}:${targetLocale}:${sourceText.toLowerCase().trim()}`;
};

const getCachedResults = (key: string): TmSearchResult[] | null => {
  const cached = searchCache.get(key);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
    return cached.results;
  }
  if (cached) {
    searchCache.delete(key); // Remove expired entry
  }
  return null;
};

const setCachedResults = (key: string, results: TmSearchResult[]) => {
  // Evict oldest entries if cache is full
  if (searchCache.size >= MAX_CACHE_SIZE) {
    const oldestKey = searchCache.keys().next().value;
    if (oldestKey !== undefined) {
      searchCache.delete(oldestKey);
    }
  }
  searchCache.set(key, { results, timestamp: Date.now() });
};

type TmSearchOptions = {
  sourceText: string;
  sourceLocale: string;
  targetLocale: string;
  projectId?: string;
  limit?: number;
  minScore?: number;
  vectorSimilarity?: number; // Vector search similarity threshold (0-100)
  mode?: 'basic' | 'extended'; // Search mode: 'basic' = strict thresholds, 'extended' = relaxed thresholds
  useVectorSearch?: boolean; // Whether to use semantic (vector) search
};

type SearchScope = 'project' | 'global';

export type TmSearchResult = TranslationMemoryEntry & {
  fuzzyScore: number;
  scope: SearchScope;
  similarity: FuzzyScoreBreakdown;
  tmxFileName?: string;
  tmxFileSource?: 'imported' | 'linked';
  searchMethod?: 'fuzzy' | 'vector' | 'hybrid'; // How this result was found
};

const fetchScopedEntries = async (
  sourceLocale: string,
  targetLocale: string,
  scope: SearchScope,
  projectId?: string,
  take = 200,
  allowAnyLocale = false,
) => {
  if (scope === 'project' && !projectId) {
    return [];
  }

  const whereClause: any = {};

  // Handle wildcard locales or allow any locale if no matches found
  if (!allowAnyLocale) {
    const localeConditions: any[] = [];
    
    // Handle target locale (skip if '*' or empty)
    if (targetLocale && targetLocale !== '*' && targetLocale.trim() !== '') {
      const normalizedTarget = targetLocale.trim().toLowerCase();
      // Flexible locale matching: match exact or prefix (e.g., "en" matches "en-GB", "en-GB")
      // Also handle reverse: "en-GB" should match "en" query
      localeConditions.push(
        { targetLocale: { equals: normalizedTarget, mode: 'insensitive' } },
        { targetLocale: { startsWith: `${normalizedTarget}-`, mode: 'insensitive' } },
        // Match if targetLocale in DB starts with query (e.g., query "en" matches DB "en-GB")
        // This is handled by startsWith above, but we also need to handle if DB has shorter locale
        // Actually, Prisma doesn't support "contains" well, so we rely on prefix matching
      );
    }
    
    // Handle source locale (skip if '*' or empty)
    if (sourceLocale && sourceLocale !== '*' && sourceLocale.trim() !== '') {
      const normalizedSource = sourceLocale.trim().toLowerCase();
      // Flexible locale matching: match exact or prefix (e.g., "ru" matches "ru-RU")
      const sourceConditions: any[] = [
        { sourceLocale: { equals: normalizedSource, mode: 'insensitive' } },
        { sourceLocale: { startsWith: `${normalizedSource}-`, mode: 'insensitive' } },
      ];
      
      if (localeConditions.length > 0) {
        // Both source and target locales specified - need AND logic
        whereClause.AND = [
          { OR: localeConditions },
          { OR: sourceConditions },
        ];
      } else {
        // Only source locale specified
        whereClause.OR = sourceConditions;
      }
    } else if (localeConditions.length > 0) {
      // Only target locale specified
      whereClause.OR = localeConditions;
    }
    // If both are '*' or empty, no locale filtering (search all locales)
  }

  if (scope === 'project') {
    whereClause.projectId = projectId;
  } else {
    whereClause.projectId = null;
  }

  // Debug logging for locale matching
  if (sourceLocale !== '*' || targetLocale !== '*') {
    logger.debug({
      sourceLocale,
      targetLocale,
      allowAnyLocale,
      whereClause: JSON.stringify(whereClause, null, 2),
      scope,
      projectId,
      take,
    }, 'fetchScopedEntries query');
  }

  const results = await prisma.translationMemoryEntry.findMany({
    where: whereClause,
    include: {
      tmxFile: {
        select: {
          id: true,
          name: true,
          filename: true,
          lastImportedAt: true,
        },
      },
    },
    // Order by creation date (newest first) to ensure all entries are considered
    // Relevance will be determined by fuzzy scoring, not by usage count
    // This ensures new/unused entries can still be found and suggested
    orderBy: [{ createdAt: 'desc' }],
    take,
  });

  logger.debug({
    sourceLocale,
    targetLocale,
    scope,
    resultCount: results.length,
    sampleLocales: results.slice(0, 3).map((r: TranslationMemoryEntry) => ({ 
      sourceLocale: r.sourceLocale, 
      targetLocale: r.targetLocale,
      sourceText: r.sourceText.substring(0, 40) 
    })),
  }, 'fetchScopedEntries results');

  return results;
};

/**
 * Search Translation Memory with configurable search parameters
 * 
 * @param mode - Search mode: 'basic' uses strict thresholds (lengthDiff 0.4, wordOverlap 0.3),
 *               'extended' uses relaxed thresholds (lengthDiff 0.6, wordOverlap 0.15)
 * @param useVectorSearch - If false, skips semantic search and uses fuzzy-only
 * @param minScore - Minimum fuzzy match score (0-100) for filtering results
 * @param vectorSimilarity - Vector search similarity threshold (0-100), defaults to 0.5 if not provided
 */
export const searchTranslationMemory = async ({
  sourceText,
  sourceLocale,
  targetLocale,
  projectId,
  limit = 25,
  minScore = 50, // Default changed to 50 to match frontend default
  vectorSimilarity,
  mode = 'basic', // Default to 'basic' to preserve current behavior
  useVectorSearch = true, // Default to true to preserve current behavior
}: TmSearchOptions): Promise<TmSearchResult[]> => {
  if (!sourceText || !sourceText.trim()) {
    return [];
  }

  // Check cache first
  const cacheKey = getCacheKey(sourceText, sourceLocale ?? '', targetLocale ?? '', projectId ?? undefined);
  const cached = getCachedResults(cacheKey);
  if (cached) {
    return cached.slice(0, limit);
  }

  const normalizedLimit = Math.max(1, Math.min(100, limit));
  
  // Determine pre-filter thresholds based on mode
  const lengthThreshold = mode === 'extended' ? 0.6 : 0.4;
  const wordOverlapThreshold = mode === 'extended' ? 0.15 : 0.3;
  
  // HYBRID SEARCH: Try vector search first (if embeddings available and enabled), then fallback to fuzzy
  let vectorResults: TmSearchResult[] = [];
  
  try {
    if (useVectorSearch) {
      // Generate embedding for query text
      const queryEmbedding = await generateEmbedding(sourceText, true);
      
      // Vector similarity threshold: use provided value or default to 0.5 (50%)
      // This is independent of fuzzy minScore to allow separate control
      const minSimilarity = vectorSimilarity !== undefined 
        ? vectorSimilarity / 100 
        : 0.5;
      
  logger.info({
    sourceText: sourceText.substring(0, 50),
    sourceLocale,
    targetLocale,
    projectId: projectId || 'none',
    vectorSimilarity,
    minScore,
    minSimilarity,
    mode,
    useVectorSearch,
    lengthThreshold,
    wordOverlapThreshold,
  }, 'Starting TM search');
      
      // Search using vector similarity
      const vectorMatches = await searchByVector(queryEmbedding, {
        projectId,
        sourceLocale,
        targetLocale,
        limit: normalizedLimit * 2, // Get more candidates for merging
        minSimilarity,
      });
      
      logger.info(`Vector search returned ${vectorMatches.length} raw matches`);
      
      // Convert vector results to TmSearchResult format
      vectorResults = vectorMatches.map((entry) => {
        // Convert similarity (0-1) to fuzzyScore (0-100)
        const fuzzyScore = Math.round(entry.similarity * 100);
        
        // Determine scope
        const scope: SearchScope = entry.projectId ? 'project' : 'global';
        
        // Create similarity breakdown (for compatibility)
        const similarity: FuzzyScoreBreakdown = {
          score: fuzzyScore,
          levenshteinRatio: entry.similarity, // Use similarity as approximation
          tokenOverlapRatio: entry.similarity,
        };
        
        return {
          ...entry,
          scope,
          fuzzyScore,
          similarity,
          tmxFileName: undefined, // Vector results don't include tmxFile relation
          tmxFileSource: undefined,
          searchMethod: 'vector' as const,
        };
      });
      
      logger.info(`Vector search found ${vectorResults.length} matches after conversion`);
    }
  } catch (error: any) {
    // If vector search fails (e.g., no embeddings yet), fallback to fuzzy search
    logger.warn(
      {
        error: error.message,
        stack: error.stack?.substring(0, 200),
      },
      'Vector search failed, falling back to fuzzy search',
    );
    useVectorSearch = false;
  }

  // FUZZY SEARCH: Traditional fuzzy matching (always runs as fallback or complement)
  // Fetch enough candidates to ensure we consider all entries, not just frequently-used ones
  // Increased limit to ensure new/unused entries are also considered for matching
  const candidateTake = Math.min(100, Math.max(50, normalizedLimit * 5));

  const candidateScopes: Array<{ scope: SearchScope; entries: TranslationMemoryEntry[] }> = [];
  
  // First try with exact locale matching
  if (projectId) {
    const [projectEntries, globalEntries] = await Promise.all([
      fetchScopedEntries(sourceLocale, targetLocale, 'project', projectId, candidateTake, false),
      fetchScopedEntries(sourceLocale, targetLocale, 'global', undefined, candidateTake, false),
    ]);
    candidateScopes.push({ scope: 'project', entries: projectEntries }, { scope: 'global', entries: globalEntries });
  } else {
    const globalEntries = await fetchScopedEntries(sourceLocale, targetLocale, 'global', undefined, candidateTake * 2, false);
    candidateScopes.push({ scope: 'global', entries: globalEntries });
  }

  // If no matches found with exact locales, try searching across all locales
  const totalMatches = candidateScopes.reduce((sum, scope) => sum + scope.entries.length, 0);
  logger.debug({
    totalMatches,
    sourceLocale,
    targetLocale,
    projectId: projectId || 'none',
    candidateScopes: candidateScopes.map(s => ({ scope: s.scope, count: s.entries.length })),
  }, 'Fuzzy search candidate fetch results');
  
  // If no matches and locales were specified (not empty or '*'), try searching all locales
  const hasSpecifiedLocales = sourceLocale && sourceLocale !== '*' && sourceLocale.trim() !== '' &&
                               targetLocale && targetLocale !== '*' && targetLocale.trim() !== '';
  
  if (totalMatches === 0 && hasSpecifiedLocales) {
    logger.info(`No matches found for locales ${sourceLocale}->${targetLocale}, trying all locales`);
    if (projectId) {
      const [projectEntriesAny, globalEntriesAny] = await Promise.all([
        fetchScopedEntries(sourceLocale, targetLocale, 'project', projectId, candidateTake, true),
        fetchScopedEntries(sourceLocale, targetLocale, 'global', undefined, candidateTake, true),
      ]);
      logger.debug({
        projectEntriesAny: projectEntriesAny.length,
        globalEntriesAny: globalEntriesAny.length,
      }, 'Fuzzy search with allowAnyLocale=true');
      candidateScopes.push({ scope: 'project', entries: projectEntriesAny }, { scope: 'global', entries: globalEntriesAny });
    } else {
      const globalEntriesAny = await fetchScopedEntries(sourceLocale, targetLocale, 'global', undefined, candidateTake * 2, true);
      logger.debug({ globalEntriesAny: globalEntriesAny.length }, 'Fuzzy search with allowAnyLocale=true');
      candidateScopes.push({ scope: 'global', entries: globalEntriesAny });
    }
  }

  // Helper to normalize entry text (handle potential encoding issues)
  // Some entries in DB may have double-encoded UTF-8 (stored as latin1 but should be UTF-8)
  const normalizeEntryText = (text: string): string => {
    if (!text || typeof text !== 'string') {
      return '';
    }
    
    try {
      // Check if text appears to be double-encoded UTF-8 (common issue with Cyrillic)
      // Pattern: ╨╗, ╨║, ╤А, etc. (mojibake for Cyrillic)
      // Check for common mojibake box-drawing characters that appear when UTF-8 is misread as latin1
      // These characters are in the range U+2550-U+256C (box drawing) and U+0400-U+04FF (Cyrillic when double-encoded)
      const hasMojibake = /[╨╤╨╡╨╗╨║╨╛╨┐╨░╨▓╨│╨┤╨╢╨╖╨╕╨╣╨╝╨╜╤А╤Б╤В╤Г╤Д╤Е╤Ж╤З╤И╤Й╤К╤Л╤М╤Н╤О╤П╤Р╤С╤Т╤У╤Ф╤Х╤Ц╤Ч╤Ш╤Щ╤Ъ╤Ы╤Ь╤Э╤Ю╤Я┬л┬╗тАУтАФтАХтАЦтАЧтАШтАЩтАЪтАЫтАЬтАЭтАЮтАЯ]/.test(text);
      
      if (hasMojibake) {
        // Likely double-encoded: was UTF-8, stored as latin1, read as UTF-8 again
        // Try to convert back: latin1 -> UTF-8 bytes -> UTF-8 string
        try {
          const buffer = Buffer.from(text, 'latin1');
          const fixed = buffer.toString('utf8');
          
          // Validate the fix: check if it contains valid Cyrillic or other expected characters
          // and is not just more mojibake
          const hasValidCyrillic = /[а-яёА-ЯЁ]/.test(fixed);
          const hasNoMojibake = !/[╨╤╨╡╨╗╨║╨╛╨┐╨░╨▓╨│╨┤╨╢╨╖╨╕╨╣╨╝╨╜╤А╤Б╤В╤Г╤Д╤Е╤Ж╤З╤И╤Й╤К╤Л╤М╤Н╤О╤П╤Р╤С╤Т╤У╤Ф╤Х╤Ц╤Ч╤Ш╤Щ╤Ъ╤Ы╤Ь╤Э╤Ю╤Я]/.test(fixed);
          
          if (hasValidCyrillic && hasNoMojibake) {
            // Successfully fixed - use the corrected version
            return fixed.trim().toLowerCase();
          }
          
          // If fixed version is significantly shorter, it might be correct (encoding fixes often reduce length)
          if (fixed.length < text.length * 0.7 && hasNoMojibake) {
            return fixed.trim().toLowerCase();
          }
        } catch (e) {
          // If conversion fails, continue with original
        }
      }
      
      return text.trim().toLowerCase();
    } catch {
      return text.trim().toLowerCase();
    }
  };
  
  // Optimize: Quick pre-filter before expensive fuzzy scoring
  // Normalize text: trim, lowercase, and ensure proper UTF-8 encoding
  // Also normalize source text to handle potential encoding issues
  const normalizedSource = normalizeEntryText(sourceText.trim());
  const sourceLength = normalizedSource.length;
  const sourceWords = normalizedSource.split(/\s+/).filter(Boolean);
  
  // Optimize: Score entries and filter in one pass, early termination for high scores
  let scored: TmSearchResult[] = [];
  
  // IMPORTANT: Also score entries found by vector search to enable hybrid matches
  // Vector search finds semantically similar entries, but we need to score them with fuzzy algorithm too
  if (vectorResults.length > 0) {
    logger.debug({
      vectorResultsCount: vectorResults.length,
      message: 'Scoring vector results with fuzzy algorithm for hybrid matching',
    }, 'Adding vector results to fuzzy candidates');
    
    // Add vector results to candidate scopes so they can be scored with fuzzy algorithm
    // This allows us to find hybrid matches (same entry found by both methods)
    for (const vectorResult of vectorResults) {
      // Find the entry in candidateScopes or add it
      let found = false;
      for (const { entries } of candidateScopes) {
        if (entries.some(e => e.id === vectorResult.id)) {
          found = true;
          break;
        }
      }
      
      // If not found in candidates, we need to fetch it or add it manually
      // For now, we'll score it directly
      const similarity = computeFuzzyScore(sourceText, vectorResult.sourceText);
      if (similarity.score >= minScore) {
        scored.push({
          ...vectorResult,
          fuzzyScore: similarity.score,
          similarity,
          searchMethod: 'fuzzy' as const, // Will be changed to 'hybrid' in merge if also found by vector
        });
      }
    }
  }
  
  for (const { scope, entries } of candidateScopes) {
    for (const entry of entries as Array<TranslationMemoryEntry & { tmxFile?: { filename?: string; name?: string; lastImportedAt?: Date | null } | null }>) {
      // Normalize entry text (handle potential encoding issues)
      const entryText = normalizeEntryText(entry.sourceText);
      
      // Debug: Log encoding fixes for first few entries to verify normalization works
      if (scored.length < 2 && entryText !== entry.sourceText.trim().toLowerCase()) {
        logger.debug({
          original: entry.sourceText.substring(0, 60),
          normalized: entryText.substring(0, 60),
          sourceNormalized: normalizedSource.substring(0, 60),
        }, 'Encoding normalization applied');
      }
      
      // Quick pre-filter: exact match check (fastest)
      if (normalizedSource === entryText) {
        scored.push({
          ...entry,
          scope,
          fuzzyScore: 100,
          similarity: { score: 100, levenshteinRatio: 1, tokenOverlapRatio: 1 },
          tmxFileName: entry.tmxFile?.filename || entry.tmxFile?.name,
          tmxFileSource: entry.tmxFile ? (entry.tmxFile.lastImportedAt ? 'imported' : 'linked') : undefined,
          searchMethod: 'fuzzy' as const,
        });
        // If we found a perfect match, we can stop early
        if (scored.length >= normalizedLimit) {
          break;
        }
        continue;
      }
      
      // Quick pre-filter: length check (very fast)
      // Threshold is mode-dependent: 'basic' = 0.4 (40%), 'extended' = 0.6 (60%)
      const lengthDiff = Math.abs(sourceLength - entryText.length) / Math.max(sourceLength, entryText.length);
      if (lengthDiff > lengthThreshold) {
        // Debug: log why entries are being filtered
        if (scored.length < 3) {
          logger.debug({
            reason: 'length_diff',
            sourceLength,
            entryLength: entryText.length,
            lengthDiff,
            lengthThreshold,
            mode,
            entryText: entryText.substring(0, 60),
          }, 'Fuzzy pre-filter: length check failed');
        }
        continue; // Skip if length difference exceeds threshold
      }
      
      // Quick pre-filter: word overlap check (fast)
      // Threshold is mode-dependent: 'basic' = 0.3 (30%), 'extended' = 0.15 (15%)
      const entryWords = entryText.split(/\s+/).filter(Boolean);
      // Normalize words for comparison (remove punctuation, handle encoding)
      // Use the already-normalized source words (from normalizedSource)
      const normalizedSourceWords = sourceWords.map(w => w.replace(/[^\p{L}\p{N}]/gu, '').toLowerCase()).filter(Boolean);
      const normalizedEntryWords = entryWords.map(w => w.replace(/[^\p{L}\p{N}]/gu, '').toLowerCase()).filter(Boolean);
      
      // Calculate word overlap ratio
      const commonWords = normalizedSourceWords.filter((w) => w && normalizedEntryWords.includes(w)).length;
      const wordOverlapRatio = commonWords / Math.max(normalizedSourceWords.length, normalizedEntryWords.length, 1);
      
      if (wordOverlapRatio < wordOverlapThreshold) {
        // Debug: log why entries are being filtered (only for first few to avoid spam)
        if (scored.length < 3) {
          logger.debug({
            reason: 'word_overlap',
            sourceWords: normalizedSourceWords.length,
            entryWords: normalizedEntryWords.length,
            commonWords,
            wordOverlapRatio,
            wordOverlapThreshold,
            mode,
            entryText: entryText.substring(0, 60),
            normalizedEntryText: entryText.substring(0, 60), // Show normalized version
            sampleSourceWords: normalizedSourceWords.slice(0, 3),
            sampleEntryWords: normalizedEntryWords.slice(0, 3),
            sourceTextSample: normalizedSource.substring(0, 60),
          }, 'Fuzzy pre-filter: word overlap check failed');
        }
        continue; // Skip if word overlap is below threshold
      }
      
      // Only do expensive fuzzy scoring if pre-filters pass
      // Use normalized entry text for fuzzy scoring to handle encoding issues
      const entrySourceTextForScoring = normalizeEntryText(entry.sourceText);
      const similarity = computeFuzzyScore(sourceText, entrySourceTextForScoring);
      
      // Debug logging for first few entries to see scores
      if (scored.length < 5) {
        logger.debug({
          sourceText: sourceText.substring(0, 60),
          entryText: entry.sourceText.substring(0, 60),
          fuzzyScore: similarity.score,
          minScore,
          passed: similarity.score >= minScore,
          levenshteinRatio: similarity.levenshteinRatio,
          tokenOverlapRatio: similarity.tokenOverlapRatio,
        }, 'Fuzzy scoring sample');
      }
      
      if (similarity.score >= minScore) {
        scored.push({
          ...entry,
          scope,
          fuzzyScore: similarity.score,
          similarity,
          tmxFileName: entry.tmxFile?.filename || entry.tmxFile?.name,
          tmxFileSource: entry.tmxFile ? (entry.tmxFile.lastImportedAt ? 'imported' : 'linked') : undefined,
          searchMethod: 'fuzzy' as const,
        });
      }
      
      // Early termination: if we have enough high-quality matches, stop scoring
      if (scored.length >= normalizedLimit * 2 && scored.some((s) => s.fuzzyScore >= 95)) {
        break;
      }
    }
    // Early termination check
    if (scored.length >= normalizedLimit * 2 && scored.some((s) => s.fuzzyScore >= 95)) {
      break;
    }
  }
  
  // HYBRID MERGE: Combine vector and fuzzy results
  // Create a map to deduplicate by entry ID (prefer higher score)
  const resultMap = new Map<string, TmSearchResult>();
  
  // Calculate vector similarity threshold for filtering vector results
  // Vector similarity is independent of fuzzy minScore (stabilized default: 0.5)
  const minVectorSimilarity = vectorSimilarity !== undefined 
    ? vectorSimilarity / 100 
    : 0.5; // Default 50% similarity (independent of minScore)
  
  logger.info({
    vectorResultsCount: vectorResults.length,
    fuzzyResultsCount: scored.length,
    minScore,
    vectorSimilarity,
    minVectorSimilarity,
    mode,
    useVectorSearch,
  }, 'Merging vector and fuzzy results');
  
  // Add vector results first (they have semantic similarity)
  // Filter by vector similarity threshold, not fuzzy minScore
  let vectorIncluded = 0;
  vectorResults.forEach((result) => {
    // Convert fuzzyScore back to similarity (0-1) for comparison
    const vectorSimilarityValue = result.fuzzyScore / 100;
    // Include if it meets vector similarity threshold OR if it also meets fuzzy threshold
    // This ensures vector matches aren't excluded by high fuzzy thresholds
    if (vectorSimilarityValue >= minVectorSimilarity || result.fuzzyScore >= minScore) {
      resultMap.set(result.id, result);
      vectorIncluded++;
    }
  });
  
  logger.info(`Included ${vectorIncluded} vector results in merge`);
  
  // Add fuzzy results (may override vector results if fuzzy score is higher)
  // Fuzzy results are already filtered by minScore in the scoring loop above
  scored.forEach((result) => {
    const existing = resultMap.get(result.id);
    if (!existing) {
      // New result from fuzzy search
      resultMap.set(result.id, result);
    } else {
      // Result exists from both searches - mark as hybrid
      if (result.fuzzyScore > existing.fuzzyScore) {
        // Prefer the higher score, but mark as hybrid
        resultMap.set(result.id, {
          ...result,
          searchMethod: 'hybrid' as const,
        });
      } else {
        // Keep existing but mark as hybrid
        resultMap.set(result.id, {
          ...existing,
          searchMethod: 'hybrid' as const,
        });
      }
    }
  });
  
  // Convert map back to array
  const hybridResults = Array.from(resultMap.values());
  
  // Sort by scope (project first) then by score
  hybridResults.sort((a, b) => {
    if (a.scope !== b.scope) {
      return a.scope === 'project' ? -1 : 1;
    }
    return b.fuzzyScore - a.fuzzyScore;
  });
  
  logger.info({
    totalResults: hybridResults.length,
    vectorOnly: hybridResults.filter(r => r.searchMethod === 'vector').length,
    fuzzyOnly: hybridResults.filter(r => r.searchMethod === 'fuzzy').length,
    hybrid: hybridResults.filter(r => r.searchMethod === 'hybrid').length,
    topScores: hybridResults.slice(0, 5).map(r => ({ 
      score: r.fuzzyScore, 
      method: r.searchMethod,
      text: r.sourceText.substring(0, 40) 
    })),
  }, 'Final hybrid search results');
  
  // Use hybrid results instead of just scored
  scored = hybridResults;

  // MAJOR PERFORMANCE OPTIMIZATION: Skip linked TMX files entirely if we have good matches
  // Linked file parsing is extremely slow (can take 10+ seconds per file)
  // Only query linked files if we have NO matches at all from database
  let linkedResults: TmSearchResult[] = [];
  const hasAnyMatches = scored.length > 0;
  
  // Only query linked files if we have NO matches from database
  // This prevents the 60+ second delays when DB already has results
  if (!hasAnyMatches) {
    try {
      // Check if prisma is available and has the translationMemoryFile model
      if (!prisma) {
        // Skip
      } else if (!('translationMemoryFile' in prisma)) {
        // Skip
      } else {
        const linkedTmxFiles = await prisma.translationMemoryFile.findMany({
          where: {
            OR: [
              { projectId: projectId ?? null },
              { projectId: null }, // Global files
            ],
            lastImportedAt: null, // Only linked files (not imported)
          },
          take: 2, // Reduced to 2 linked files max for performance
        });

        // Query linked TMX files with aggressive timeout
        const linkedPromises = linkedTmxFiles.map((tmxFile: { id: string }) => {
          const timeoutPromise = new Promise<TmSearchResult[]>((resolve) => {
            setTimeout(() => resolve([]), 1000); // Aggressive 1 second timeout per file
          });
          
          return Promise.race([
            queryLinkedTmxFile(tmxFile.id, sourceText, sourceLocale, targetLocale, minScore),
            timeoutPromise,
          ]).catch((err) => {
            console.error(`Error querying linked TMX file ${tmxFile.id}:`, err);
            return []; // Return empty array on error
          });
        });
        
        const linkedResultsArrays = await Promise.all(linkedPromises);
        linkedResults = linkedResultsArrays.flat();
      }
    } catch (error) {
      // If linked TMX query fails, continue with imported entries only
      console.error('Error querying linked TMX files:', error);
    }
  }

  // Combine and sort all results
  const allResults = [...scored, ...linkedResults];
  allResults.sort((a, b) => {
    if (a.scope !== b.scope) {
      return a.scope === 'project' ? -1 : 1;
    }
    return b.fuzzyScore - a.fuzzyScore;
  });

  const finalResults = allResults.slice(0, normalizedLimit);
  
  // Cache the results
  setCachedResults(cacheKey, finalResults);
  
  return finalResults;
};

export const addTranslationMemoryEntry = (data: {
  projectId?: string;
  sourceLocale: string;
  targetLocale: string;
  sourceText: string;
  targetText: string;
  createdById: string;
  clientName?: string;
  domain?: string;
  matchRate?: number;
}) =>
  prisma.translationMemoryEntry.create({
    data: {
      ...data,
      matchRate: data.matchRate ?? 1,
    },
  });

// Upsert TM entry: update if exists (same source text, locale, project), otherwise create
export const upsertTranslationMemoryEntry = async (data: {
  projectId?: string;
  sourceLocale: string;
  targetLocale: string;
  sourceText: string;
  targetText: string;
  createdById: string;
  clientName?: string;
  domain?: string;
  matchRate?: number;
}) => {
  // Normalize source text for comparison (trim and lowercase)
  const normalizedSource = data.sourceText.trim().toLowerCase();
  
  // Try to find existing entry with same source text, locale, and project
  const existing = await prisma.translationMemoryEntry.findFirst({
    where: {
      sourceLocale: data.sourceLocale,
      targetLocale: data.targetLocale,
      projectId: data.projectId ?? null,
      sourceText: {
        equals: data.sourceText,
        mode: 'insensitive',
      },
    },
  });

  let entry;
  if (existing) {
    // Update existing entry (this is the "Update" flag behavior)
    entry = await prisma.translationMemoryEntry.update({
      where: { id: existing.id },
      data: {
        targetText: data.targetText,
        matchRate: data.matchRate ?? 1,
        clientName: data.clientName ?? existing.clientName,
        domain: data.domain ?? existing.domain,
        usageCount: existing.usageCount + 1,
      },
    });
  } else {
    // Create new entry
    entry = await prisma.translationMemoryEntry.create({
      data: {
        ...data,
        matchRate: data.matchRate ?? 1,
      },
    });
  }

  // Auto-generate embedding for new/updated entry (in background, don't block)
  // Only generate if entry doesn't have embedding yet
  // Check using raw query since Prisma doesn't expose Unsupported types
  const hasEmbeddingResult = (await prisma.$queryRawUnsafe(
    `SELECT "sourceEmbedding" IS NOT NULL as has_embedding FROM "TranslationMemoryEntry" WHERE id = $1`,
    entry.id,
  )) as Array<{ has_embedding: boolean }>;

  if (!hasEmbeddingResult[0]?.has_embedding && entry.sourceText && entry.sourceText.trim()) {
    generateEmbeddingForEntry(entry.id).catch((error) => {
      // Log but don't throw - embedding generation is non-critical
      logger.debug(
        {
          entryId: entry.id,
          error: error.message,
        },
        'Background embedding generation failed',
      );
    });
  }

  return entry;
};

export const listTranslationMemoryEntries = async (
  projectId?: string,
  page = 1,
  limit = 50,
  globalOnly = false,
) => {
  const skip = (page - 1) * limit;
  
  // Build where clause
  let whereClause: any = undefined;
  if (globalOnly) {
    // Filter for global entries only (projectId is null)
    whereClause = { projectId: null };
  } else if (projectId) {
    // Filter for specific project
    whereClause = { projectId };
  }
  // If neither projectId nor globalOnly, return all entries (whereClause remains undefined)
  
  const [entries, total] = await Promise.all([
    prisma.translationMemoryEntry.findMany({
      where: whereClause,
      skip,
      take: limit,
      orderBy: { createdAt: 'desc' },
      include: { createdBy: { select: { id: true, name: true, email: true } } },
    }),
    prisma.translationMemoryEntry.count({
      where: whereClause,
    }),
  ]);
  return { entries, total, page, limit, totalPages: Math.ceil(total / limit) };
};

export const getTranslationMemoryEntry = async (entryId: string) => {
  const entry = await prisma.translationMemoryEntry.findUnique({
    where: { id: entryId },
    include: { createdBy: { select: { id: true, name: true, email: true } } },
  });
  if (!entry) {
    throw ApiError.notFound('Translation memory entry not found');
  }
  return entry;
};

export const updateTranslationMemoryEntry = async (
  entryId: string,
  data: { sourceText?: string; targetText?: string; matchRate?: number },
) => {
  const entry = await prisma.translationMemoryEntry.findUnique({ where: { id: entryId } });
  if (!entry) {
    throw ApiError.notFound('Translation memory entry not found');
  }
  return prisma.translationMemoryEntry.update({
    where: { id: entryId },
    data,
  });
};

export const deleteTranslationMemoryEntry = async (entryId: string) => {
  const entry = await prisma.translationMemoryEntry.findUnique({ where: { id: entryId } });
  if (!entry) {
    throw ApiError.notFound('Translation memory entry not found');
  }
  return prisma.translationMemoryEntry.delete({ where: { id: entryId } });
};

type ImportTmxOptions = {
  projectId?: string;
  clientName?: string;
  domain?: string;
  createdById: string;
  filename?: string;
  storagePath?: string;
  externalUrl?: string;
};

export const importTmxEntries = async (buffer: Buffer, options: ImportTmxOptions) => {
  const xml = buffer.toString('utf-8');
  const parsed = tmxParser.parse(xml);
  const tus = parsed?.tmx?.body?.tu;
  const units: Array<any> = Array.isArray(tus) ? tus : tus ? [tus] : [];

  // Create or find TranslationMemoryFile record
  let tmxFile: { id: string } | null = null;
  if (options.filename) {
    const storagePath = options.storagePath || null;
    tmxFile = await prisma.translationMemoryFile.create({
      data: {
        name: options.filename,
        filename: options.filename,
        storagePath,
        externalUrl: options.externalUrl,
        projectId: options.projectId,
        clientName: options.clientName,
        domain: options.domain,
        createdById: options.createdById,
        entryCount: units.length,
        lastImportedAt: new Date(),
      },
    });
  }

  const entries = units
    .map((unit) => {
      const tuvs = Array.isArray(unit.tuv) ? unit.tuv : unit.tuv ? [unit.tuv] : [];
      if (tuvs.length < 2) {
        return null;
      }
      const [source, target] = tuvs;
      const sourceLocale = source?.['@_xml:lang'] ?? source?.['@_lang'] ?? 'source';
      const targetLocale = target?.['@_xml:lang'] ?? target?.['@_lang'] ?? 'target';
      
      // Extract text from seg element - it can be a string or an object with nested text
      const extractText = (seg: unknown): string => {
        if (typeof seg === 'string') {
          return seg;
        }
        if (typeof seg === 'object' && seg !== null) {
          // Handle array of text nodes
          if (Array.isArray(seg)) {
            return seg.map((item) => (typeof item === 'string' ? item : item?.['#text'] ?? '')).join('');
          }
          // Handle object with #text property
          if ('#text' in seg) {
            return String((seg as any)['#text'] ?? '');
          }
          // Try to find text in nested structure
          const text = (seg as any)?.['#text'] ?? (seg as any)?.text ?? '';
          return typeof text === 'string' ? text : '';
        }
        return '';
      };
      
      const sourceText = extractText(source?.seg);
      const targetText = extractText(target?.seg);
      
      if (!sourceText || !targetText) {
        return null;
      }
      return {
        projectId: options.projectId,
        tmxFileId: tmxFile?.id,
        sourceLocale,
        targetLocale,
        sourceText,
        targetText,
        clientName: options.clientName,
        domain: options.domain,
        createdById: options.createdById,
        matchRate: 1,
      };
    })
    .filter(Boolean) as Array<{
      projectId?: string;
      sourceLocale: string;
      targetLocale: string;
      sourceText: string;
      targetText: string;
      clientName?: string;
      domain?: string;
      createdById: string;
      matchRate: number;
    }>;

  if (entries.length === 0) {
    throw ApiError.badRequest('TMX file does not contain any translation units');
  }

  await prisma.translationMemoryEntry.createMany({
    data: entries.map((entry) => ({
      ...entry,
      tmxFileId: tmxFile?.id,
    })),
  });

  return { imported: entries.length, tmxFileId: tmxFile?.id };
};

// Link an external TMX file without importing entries (query on-demand)
export const linkTmxFile = async (options: {
  filename: string;
  externalUrl?: string;
  storagePath?: string;
  projectId?: string;
  clientName?: string;
  domain?: string;
  createdById: string;
}) => {
  // Validate that either externalUrl or storagePath is provided
  if (!options.externalUrl && !options.storagePath) {
    throw ApiError.badRequest('Either externalUrl or storagePath must be provided');
  }

  // If storagePath is provided, verify file exists
  if (options.storagePath) {
    try {
      const fs = await import('fs/promises');
      await fs.access(options.storagePath);
    } catch {
      throw ApiError.badRequest('TMX file not found at the specified path');
    }
  }

  // Count entries in the file (for metadata)
  let entryCount = 0;
  if (options.storagePath) {
    try {
      const fs = await import('fs/promises');
      const buffer = await fs.readFile(options.storagePath);
      const xml = buffer.toString('utf-8');
      const parsed = tmxParser.parse(xml);
      const tus = parsed?.tmx?.body?.tu;
      entryCount = Array.isArray(tus) ? tus.length : tus ? 1 : 0;
    } catch {
      // If we can't read the file, entryCount stays 0
    }
  }

  const tmxFile = await prisma.translationMemoryFile.create({
    data: {
      name: options.filename,
      filename: options.filename,
      storagePath: options.storagePath,
      externalUrl: options.externalUrl,
      projectId: options.projectId,
      clientName: options.clientName,
      domain: options.domain,
      createdById: options.createdById,
      entryCount,
      lastImportedAt: null, // Not imported, just linked
    },
  });

  return { tmxFile, linked: true, entryCount };
};

// Query a linked TMX file on-demand
const queryLinkedTmxFile = async (
  tmxFileId: string,
  sourceText: string,
  sourceLocale: string,
  targetLocale: string,
  minScore: number = 60,
): Promise<TmSearchResult[]> => {
  const tmxFile = await prisma.translationMemoryFile.findUnique({
    where: { id: tmxFileId },
    select: {
      id: true,
      name: true,
      filename: true,
      lastImportedAt: true,
      storagePath: true,
      externalUrl: true,
      projectId: true,
      clientName: true,
      domain: true,
      createdById: true,
      createdAt: true,
      updatedAt: true,
    },
  });

  if (!tmxFile) {
    return [];
  }

  // Determine file source
  let buffer: Buffer;
  if (tmxFile.storagePath) {
    const fs = await import('fs/promises');
    buffer = await fs.readFile(tmxFile.storagePath);
  } else if (tmxFile.externalUrl) {
    // Fetch from external URL
    const response = await fetch(tmxFile.externalUrl);
    if (!response.ok) {
      console.error(`Failed to fetch TMX from ${tmxFile.externalUrl}`);
      return [];
    }
    const arrayBuffer = await response.arrayBuffer();
    buffer = Buffer.from(arrayBuffer);
  } else {
    return [];
  }

  // Parse TMX file
  const xml = buffer.toString('utf-8');
  const parsed = tmxParser.parse(xml);
  const tus = parsed?.tmx?.body?.tu;
  const units: Array<any> = Array.isArray(tus) ? tus : tus ? [tus] : [];

  // Extract text helper
  const extractText = (seg: unknown): string => {
    if (typeof seg === 'string') {
      return seg;
    }
    if (typeof seg === 'object' && seg !== null) {
      if (Array.isArray(seg)) {
        return seg.map((item) => (typeof item === 'string' ? item : item?.['#text'] ?? '')).join('');
      }
      if ('#text' in seg) {
        return String((seg as any)['#text'] ?? '');
      }
      const text = (seg as any)?.['#text'] ?? (seg as any)?.text ?? '';
      return typeof text === 'string' ? text : '';
    }
    return '';
  };

      // Find matching entries - optimized with early termination and pre-filtering
      const matches: TmSearchResult[] = [];
      const maxMatches = 20; // Limit matches per linked file to prevent slowdown
      
      for (const unit of units) {
        // Early termination if we have enough high-quality matches
        if (matches.length >= maxMatches && matches.some((m) => m.fuzzyScore >= 95)) {
          break;
        }

        const tuvs = Array.isArray(unit.tuv) ? unit.tuv : unit.tuv ? [unit.tuv] : [];
        if (tuvs.length < 2) continue;

        const [source, target] = tuvs;
        const unitSourceLocale = source?.['@_xml:lang'] ?? source?.['@_lang'] ?? 'source';
        const unitTargetLocale = target?.['@_xml:lang'] ?? target?.['@_lang'] ?? 'target';

        // Match locales (case-insensitive, or allow any if wildcard)
        const sourceMatches = sourceLocale === '*' || 
          unitSourceLocale.toLowerCase() === sourceLocale.toLowerCase() ||
          unitSourceLocale.toLowerCase().startsWith(sourceLocale.toLowerCase().split('-')[0]);
        
        const targetMatches = targetLocale === '*' ||
          unitTargetLocale.toLowerCase() === targetLocale.toLowerCase() ||
          unitTargetLocale.toLowerCase().startsWith(targetLocale.toLowerCase().split('-')[0]);
        
        if (!sourceMatches || !targetMatches) {
          continue;
        }

        const unitSourceText = extractText(source?.seg);
        const unitTargetText = extractText(target?.seg);

        if (!unitSourceText || !unitTargetText) continue;

        // Quick pre-filter: skip if source text length is too different (simple optimization)
        const lengthDiff = Math.abs(sourceText.length - unitSourceText.length) / Math.max(sourceText.length, unitSourceText.length);
        if (lengthDiff > 0.5) {
          continue; // Skip if length difference is > 50%
        }

        const similarity = computeFuzzyScore(sourceText, unitSourceText);
        const fuzzyScore = similarity.score;

        if (fuzzyScore >= minScore) {
          matches.push({
            id: `linked-${tmxFileId}-${matches.length}`,
            projectId: tmxFile.projectId,
            tmxFileId: tmxFile.id,
            sourceLocale: unitSourceLocale,
            targetLocale: unitTargetLocale,
            sourceText: unitSourceText,
            targetText: unitTargetText,
            matchRate: fuzzyScore / 100,
            usageCount: 0,
            clientName: tmxFile.clientName,
            domain: tmxFile.domain,
            createdById: tmxFile.createdById,
            createdAt: tmxFile.createdAt,
            updatedAt: tmxFile.updatedAt,
            fuzzyScore,
            scope: tmxFile.projectId ? 'project' : 'global',
            similarity,
            tmxFileName: tmxFile.filename || tmxFile.name,
            tmxFileSource: 'linked' as const,
            searchMethod: 'fuzzy' as const,
          } as TmSearchResult);
        }
      }

      // Sort by score descending and limit
      matches.sort((a, b) => b.fuzzyScore - a.fuzzyScore);
      return matches.slice(0, maxMatches);
};

