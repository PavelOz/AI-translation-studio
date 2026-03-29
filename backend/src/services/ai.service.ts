import type { Prisma } from '@prisma/client';
import { prisma } from '../db/prisma';
import { AIOrchestrator, type OrchestratorGlossaryEntry, type OrchestratorSegment, type TmExample, type TranslationProvider } from '../ai/orchestrator';
import { QAEngine } from '../ai/qaEngine';
import { searchTranslationMemory } from './tm.service';
import { ApiError } from '../utils/apiError';
import { getSegmentWithDocument, applyTmMatchWithNumberSubstitution, ensureLeadingSectionFromSegment } from './segment.service';
import { listProviders as listAvailableProviders, getProvider } from '../ai/providers/registry';
import { logger } from '../utils/logger';
import { matchesWithVariations } from '../utils/stemming';
import { generateEmbedding } from './embedding.service';
import { searchGlossaryByVector } from './vector-search.service';
import { validateAndRepairGlossaryCompliance } from './glossary-validator.service';
import { env } from '../utils/env';
import type { GlossaryMode } from '../types/glossary';
import type { ContextRules } from './glossary.service';
import { getDocumentGlossaryForSegment, getDocumentStyleRules, getEffectiveDocumentDna, getProjectDna } from './analysis.service';
import { mergeDna, prismaDnaRowToPayload } from './dnaMerge';
import { applyTotalCyrillicBan, deduplicateFullFormDash } from './translation.service';
import { validateDocumentDnaPayload, validateDnaForCycles } from './dnaValidation';
import { validateDnaContract } from './validate-dna';
import { getTranslationDirection } from './dnaPrompts';
import { normalizeDocumentDnaPayloadOrNull } from './dnaSchema';
import { splitIntoSentences, stripFormattingTags } from '../utils/segmentation';
import pLimit from 'p-limit';

const orchestrator = new AIOrchestrator();
const qaEngine = new QAEngine();

/** Project defaults + document row from Prisma include, normalized when possible (orchestrator / post-process). */
async function effectiveDnaForPrismaInclude(
  projectId: string,
  documentDna: {
    technicalSchema: unknown;
    namingConventions: unknown;
    abbreviationLogic: unknown;
    entityGroups: unknown;
  } | null | undefined,
) {
  const raw = prismaDnaRowToPayload(documentDna ?? null);
  const projectDna = await getProjectDna(projectId);
  const merged = mergeDna(projectDna, raw);
  if (!merged) return null;
  return normalizeDocumentDnaPayloadOrNull(merged) ?? merged;
}

// Cancellation tokens for batch translation jobs (keyed by documentId)
const batchTranslationCancellationTokens = new Map<string, boolean>();

/**
 * Cancel a running batch translation job
 * @param documentId - Document ID to cancel translation for
 */
export const cancelBatchTranslation = (documentId: string): void => {
  batchTranslationCancellationTokens.set(documentId, true);
  logger.info({ documentId }, 'Batch translation cancellation requested');
};

/**
 * Check if a batch translation job is cancelled
 * @param documentId - Document ID to check
 * @returns true if the job should be cancelled
 */
const isBatchTranslationCancelled = (documentId: string): boolean => {
  return batchTranslationCancellationTokens.get(documentId) === true;
};

/**
 * Clear cancellation flag for a document (called when job completes or starts)
 * @param documentId - Document ID to clear flag for
 */
const clearBatchTranslationCancellation = (documentId: string): void => {
  batchTranslationCancellationTokens.delete(documentId);
};

/**
 * Scatter-Gather TM Search: Split paragraph into sentences, search each sentence + full paragraph
 * 
 * Strategy:
 * 1. Split: Split paragraph into sentences
 * 2. Scatter: Search TM for full paragraph AND each sentence in parallel
 * 3. Gather: Combine and deduplicate results by entry ID
 * 
 * @param paragraphText - The full paragraph text to search
 * @param sourceLocale - Source locale
 * @param targetLocale - Target locale
 * @param projectId - Project ID
 * @param searchOptions - Search options (limit, minScore, vectorSimilarity)
 * @returns Deduplicated array of TM search results
 */
export async function scatterGatherTmSearch(
  paragraphText: string,
  sourceLocale: string,
  targetLocale: string,
  projectId: string | null,
  searchOptions: {
    limit?: number;
    minScore?: number;
    vectorSimilarity?: number;
    mode?: 'basic' | 'extended';
    useVectorSearch?: boolean;
  }
): Promise<Array<{
  id: string;
  sourceText: string;
  targetText: string;
  fuzzyScore: number;
  searchMethod?: 'fuzzy' | 'vector' | 'hybrid';
  entryType?: 'sentence' | 'paragraph' | null;
}>> {
  if (!paragraphText || !paragraphText.trim()) {
    return [];
  }

  // Strip formatting tags ({{0}}, {{/0}}, etc.) before searching
  // This ensures we match against clean text in TM, which is saved without formatting tags
  const cleanParagraphText = stripFormattingTags(paragraphText);
  
  // Step 1: Split paragraph into sentences
  const sentences = splitIntoSentences(cleanParagraphText, sourceLocale);
  
  // Step 2: Scatter - Search for full paragraph AND each sentence in parallel
  const searchPromises: Promise<Array<{
    id: string;
    sourceText: string;
    targetText: string;
    fuzzyScore: number;
    searchMethod?: 'fuzzy' | 'vector' | 'hybrid';
    entryType?: 'sentence' | 'paragraph' | null;
  }>>[] = [];

  // Always search for the full paragraph (for context)
  // Use clean text without formatting tags
  // CRITICAL: Only search paragraph-level entries when searching for paragraphs
  searchPromises.push(
    searchTranslationMemory({
      sourceText: cleanParagraphText,
      sourceLocale,
      targetLocale,
      projectId,
      limit: searchOptions.limit ?? 5,
      minScore: searchOptions.minScore ?? 50,
      vectorSimilarity: searchOptions.vectorSimilarity ?? 60,
      mode: searchOptions.mode ?? 'basic',
      useVectorSearch: searchOptions.useVectorSearch ?? true,
      entryType: 'paragraph', // CRITICAL: Only search paragraph-level entries when searching for paragraphs
    })
  );

  // Search for each sentence individually
  // Use a higher limit per sentence to ensure we capture all sentence-level matches
  // Since sentences are shorter, we can afford to get more candidates
  // Increase limit significantly for sentence searches to find all matches
  const perSentenceLimit = Math.max((searchOptions.limit ?? 5) * 3, 15);
  
  // For sentence searches, use a lower minScore since sentence-level entries should be exact matches
  // This ensures we find all sentence matches even if there are minor whitespace differences
  const sentenceMinScore = Math.min(searchOptions.minScore ?? 50, 40);
  
  for (const sentence of sentences) {
    // Only search if sentence is meaningful (more than just punctuation/whitespace)
    // Strip formatting tags to match how sentences are saved in TM
    const cleanSentence = stripFormattingTags(sentence).trim();
    if (cleanSentence.length > 10) {
      // Log for debugging: what sentence we're searching for
      logger.debug({
        sentenceLength: cleanSentence.length,
        sentencePreview: cleanSentence.substring(0, 80),
        entryTypeFilter: 'sentence',
      }, 'Searching for sentence with entryType filter');
      
      searchPromises.push(
        searchTranslationMemory({
          sourceText: cleanSentence, // Clean text without formatting tags, matching save behavior
          sourceLocale,
          targetLocale,
          projectId,
          limit: perSentenceLimit, // Higher limit for sentence searches
          minScore: sentenceMinScore, // Lower threshold for sentence searches
          vectorSimilarity: searchOptions.vectorSimilarity ?? 60,
          mode: searchOptions.mode ?? 'basic',
          useVectorSearch: searchOptions.useVectorSearch ?? true,
          entryType: 'sentence', // CRITICAL: Only search sentence-level entries when searching for sentences
        })
      );
    }
  }

  // Execute all searches in parallel
  const searchResults = await Promise.all(searchPromises);

  // Step 3: Gather - Flatten and Deduplicate with entryType preservation
  const resultsMap = new Map<string, {
    id: string;
    sourceText: string;
    targetText: string;
    fuzzyScore: number;
    searchMethod?: 'fuzzy' | 'vector' | 'hybrid';
    entryType?: 'sentence' | 'paragraph' | null;
  }>();

  for (const results of searchResults) {
    for (const result of results) {
      // Keep the result with the highest score if duplicate
      const existing = resultsMap.get(result.id);
      if (!existing || result.fuzzyScore > existing.fuzzyScore) {
        // Preserve entryType from the result - it should be included from the database query
        // Explicitly extract entryType to ensure it's preserved
        const entryType = result.entryType as 'sentence' | 'paragraph' | null | undefined;
        resultsMap.set(result.id, { 
          ...result, 
          entryType: entryType ?? undefined // Ensure entryType is explicitly set
        });
      }
    }
  }

  // Step 4: Separate Matches by Type
  const allResults = Array.from(resultsMap.values());
  const sentenceMatches = allResults.filter(r => r.entryType === 'sentence');
  const paragraphMatches = allResults.filter(r => r.entryType !== 'sentence');
  
  // Debug logging: verify entryType is preserved and check for data quality issues
  logger.debug({
    totalResults: allResults.length,
    sentenceMatches: sentenceMatches.length,
    paragraphMatches: paragraphMatches.length,
    sentenceMatchDetails: sentenceMatches.slice(0, 3).map(r => ({
      id: r.id,
      entryType: r.entryType,
      score: r.fuzzyScore,
      sourceLength: r.sourceText.length,
      sourcePreview: r.sourceText.substring(0, 100),
    })),
  }, 'Scatter-Gather results by entryType');

  let finalResults: typeof allResults;

  // Step 5: Apply "Gold Standard" Prioritization Strategy
  if (sentenceMatches.length > 0) {
    const bestSentenceScore = Math.max(...sentenceMatches.map(r => r.fuzzyScore), 0);
    
    // CRITICAL: Keep paragraph ONLY if it's Perfect (100%) OR significantly better than sentences
    const highQualityParagraphs = paragraphMatches.filter(
      p => p.fuzzyScore === 100 || (p.fuzzyScore >= 95 && p.fuzzyScore > bestSentenceScore + 5)
    );
    
    // SORT ORDER:
    // 1. Perfect Paragraphs (Gold Standard)
    // 2. Sentence Matches (The "Lego Blocks")
    // 3. Other High-Quality Paragraphs (Context)
    finalResults = [
      ...highQualityParagraphs.filter(p => p.fuzzyScore === 100),
      ...sentenceMatches.sort((a, b) => b.fuzzyScore - a.fuzzyScore),
      ...highQualityParagraphs.filter(p => p.fuzzyScore < 100).sort((a, b) => b.fuzzyScore - a.fuzzyScore),
    ];
    
    logger.debug({
      sentenceMatches: sentenceMatches.length,
      paragraphMatches: paragraphMatches.length,
      keptParagraphs: highQualityParagraphs.length,
      bestSentenceScore,
    }, 'Applied Scatter-Gather Prioritization');

  } else {
    // Fallback: Standard sort if no sentences found
    finalResults = allResults.sort((a, b) => b.fuzzyScore - a.fuzzyScore);
  }

  // Step 6: Cap results (allow more results to accommodate granular sentences)
  // For sentence-level matches, we want to ensure we get enough results per sentence
  // Multiply by sentence count but use a higher base limit for sentences
  const baseLimit = searchOptions.limit ?? 5;
  // For sentences, we want more results since they're more granular
  // If we have sentence matches, increase the limit to show more of them
  const sentenceMultiplier = sentenceMatches.length > 0 ? Math.max(2, sentences.length) : 1;
  const effectiveLimit = Math.min(
    baseLimit * sentenceMultiplier,
    50 // Increased from 25 to allow more sentence matches
  );
  
  const deduplicatedResults = finalResults.slice(0, effectiveLimit);

  logger.debug({
    paragraphLength: paragraphText.length,
    sentenceCount: sentences.length,
    totalSearches: searchPromises.length,
    uniqueResults: deduplicatedResults.length,
    effectiveLimit,
    originalLimit: searchOptions.limit ?? 5,
    resultsByScore: deduplicatedResults.map(r => ({ 
      id: r.id, 
      score: r.fuzzyScore, 
      entryType: r.entryType,
      text: r.sourceText.substring(0, 50) 
    })),
  }, 'Scatter-gather TM search completed');

  return deduplicatedResults;
}

type MachineTranslationOptions = {
  applyTm?: boolean;
  minScore?: number;
  glossaryMode?: GlossaryMode;
  temperature?: number; // Temperature for AI translation (0.0-1.0)
  useCritic?: boolean; // Use critic AI workflow for higher quality (slower)
  rewriteNonConfirmed?: boolean; // Rewrite non-confirmed segments (ignore text, check status)
  // Опции для синхронизации с TM Search Panel
  tmRagSettings?: {
    minScore?: number;
    vectorSimilarity?: number;
    mode?: 'basic' | 'extended';
    useVectorSearch?: boolean;
    limit?: number;
  };
};

/**
 * Get default temperature based on provider.
 * DeepSeek (especially reasoning models) defaults to 0.0 for stability.
 * Other providers default to 0.2 for natural fluency.
 */
function getDefaultTemperature(provider?: string | null): number {
  if (provider?.toLowerCase() === 'deepseek') {
    return 0.0;
  }
  return 0.2;
}

// Метаданные для прозрачности процесса перевода
export type TranslationMetadata = {
  stage: 'tm-direct' | 'ai-draft' | 'critic' | 'editor' | 'complete';
  priority: number; // 1 = highest priority
  source: 'tm-direct' | 'tm-rag' | 'glossary' | 'guidelines' | 'ai';
  tmDirectMatch?: {
    id: string;
    sourceText: string;
    targetText: string;
    fuzzyScore: number;
    searchMethod: 'fuzzy' | 'vector' | 'hybrid';
    numbersAdjusted?: boolean;
  };
  tmExamples?: Array<{
    sourceText: string;
    targetText: string;
    fuzzyScore: number;
    searchMethod: 'fuzzy' | 'vector' | 'hybrid';
  }>;
  glossaryEntries?: Array<{
    sourceTerm: string;
    targetTerm: string;
    mode: GlossaryMode;
    isForbidden: boolean;
  }>;
  glossaryMode?: GlossaryMode;
  guidelinesCount?: number;
  tmSearchSettings?: {
    minScore: number;
    vectorSimilarity: number;
    mode: 'basic' | 'extended';
    useVectorSearch: boolean;
    limit: number;
  };
  message?: string;
};

type ProjectAISettingsPayload = {
  provider: string;
  model: string;
  temperature?: number;
  maxTokens?: number;
  config?: Record<string, unknown>;
};

const toJsonValue = (value?: Record<string, unknown>): Prisma.InputJsonValue | undefined =>
  value ? (value as Prisma.InputJsonValue) : undefined;

const normalizeGuidelines = (rules: Prisma.JsonValue | null | undefined): string[] => {
  if (!rules) return [];
  if (Array.isArray(rules)) {
    return (rules as Prisma.JsonValue[]).map((rule) => {
      // Handle string format
      if (typeof rule === 'string') {
        return rule;
      }
      // Handle object format with title/instruction/description
      if (typeof rule === 'object' && rule !== null) {
        const ruleObj = rule as Record<string, unknown>;
        return (
          (ruleObj.title as string) ||
          (ruleObj.instruction as string) ||
          (ruleObj.description as string) ||
          ''
        );
      }
      return '';
    }).filter((rule): rule is string => typeof rule === 'string' && rule.length > 0);
  }
  return [];
};

/**
 * Map glossary entries and ensure correct translation direction
 * If entry direction matches document direction, use as-is
 * If entry direction is reversed (bidirectional), swap terms
 * If entry direction doesn't match, discard it
 */
const mapGlossaryEntries = (
  entries: Array<{ 
    sourceTerm: string; 
    targetTerm: string; 
    sourceLocale: string;
    targetLocale: string;
    isForbidden: boolean; 
    notes: string | null; 
    contextRules: any 
  }>,
  documentSourceLocale: string,
  documentTargetLocale: string,
): OrchestratorGlossaryEntry[] => {
  const normalizedDocSource = documentSourceLocale.toLowerCase().trim();
  const normalizedDocTarget = documentTargetLocale.toLowerCase().trim();
  
  return entries
    .filter((entry) => {
      const normalizedEntrySource = entry.sourceLocale.toLowerCase().trim();
      const normalizedEntryTarget = entry.targetLocale.toLowerCase().trim();
      
      // Check if entry direction matches document direction
      const directionMatches = normalizedEntrySource === normalizedDocSource && 
                               normalizedEntryTarget === normalizedDocTarget;
      
      // Check if entry direction is reversed (bidirectional match)
      const directionReversed = normalizedEntrySource === normalizedDocTarget && 
                                normalizedEntryTarget === normalizedDocSource;
      
      // Only include entries that match either direction
      return directionMatches || directionReversed;
    })
    .map((entry) => {
      const normalizedEntrySource = entry.sourceLocale.toLowerCase().trim();
      const normalizedEntryTarget = entry.targetLocale.toLowerCase().trim();
      
      // Check if entry direction matches document direction
      const directionMatches = normalizedEntrySource === normalizedDocSource && 
                               normalizedEntryTarget === normalizedDocTarget;
      
      // If direction matches, use as-is
      if (directionMatches) {
        return {
          term: entry.sourceTerm,
          translation: entry.targetTerm,
          forbidden: entry.isForbidden,
          notes: entry.notes,
          contextRules: entry.contextRules as ContextRules | undefined,
        };
      }
      
      // If direction is reversed, swap the terms
      // Entry: ru -> en, Document: en -> ru
      // So we swap: use entry.targetTerm as term, entry.sourceTerm as translation
      return {
        term: entry.targetTerm, // Swap: use target as source
        translation: entry.sourceTerm, // Swap: use source as target
        forbidden: entry.isForbidden,
        notes: entry.notes,
        contextRules: entry.contextRules as ContextRules | undefined,
      };
    });
};

type DocumentContext = {
  projectDomain?: string | null;
  projectClient?: string | null;
  documentName?: string | null;
  documentType?: string | null; // Could be extracted from document metadata
};

type AiContext = {
  projectMeta: {
    name?: string | null;
    client?: string | null;
    domain?: string | null;
    sourceLang?: string | null;
    targetLang?: string | null;
    summary?: string | null;
  };
  settings: Awaited<ReturnType<typeof getProjectAISettings>> | null;
  guidelines: string[];
  glossary: OrchestratorGlossaryEntry[];
  apiKey?: string; // Project-specific API key from config
  yandexFolderId?: string; // Project-specific Yandex Folder ID from config
};

/**
 * Check if a glossary entry matches the current context based on context rules
 */
const matchesContext = (entry: OrchestratorGlossaryEntry, context: DocumentContext): boolean => {
  const rules = entry.contextRules;
  if (!rules) {
    // No context rules = always match
    return true;
  }

  // Check excludeFrom first (if excluded, don't use)
  if (rules.excludeFrom && rules.excludeFrom.length > 0) {
    const currentContexts: string[] = [];
    if (context.projectDomain) currentContexts.push(context.projectDomain.toLowerCase());
    if (context.projectClient) currentContexts.push(context.projectClient.toLowerCase());
    if (context.documentType) currentContexts.push(context.documentType.toLowerCase());
    
    const excluded = rules.excludeFrom.some(excluded => 
      currentContexts.some(ctx => ctx.includes(excluded.toLowerCase()) || excluded.toLowerCase().includes(ctx))
    );
    if (excluded) {
      return false;
    }
  }

  // Check useOnlyIn (if specified, must match)
  if (rules.useOnlyIn && rules.useOnlyIn.length > 0) {
    const currentContexts: string[] = [];
    if (context.projectDomain) currentContexts.push(context.projectDomain.toLowerCase());
    if (context.projectClient) currentContexts.push(context.projectClient.toLowerCase());
    if (context.documentType) currentContexts.push(context.documentType.toLowerCase());
    
    const matches = rules.useOnlyIn.some(allowed => 
      currentContexts.some(ctx => ctx.includes(allowed.toLowerCase()) || allowed.toLowerCase().includes(ctx))
    );
    if (!matches) {
      return false;
    }
  }

  // Check documentTypes (if specified, must match)
  if (rules.documentTypes && rules.documentTypes.length > 0) {
    if (!context.documentType) {
      return false; // No document type available, can't match
    }
    const matches = rules.documentTypes.some(type => 
      context.documentType!.toLowerCase().includes(type.toLowerCase()) || 
      type.toLowerCase().includes(context.documentType!.toLowerCase())
    );
    if (!matches) {
      return false;
    }
  }

  // Check requires (if specified, all must be met)
  if (rules.requires && rules.requires.length > 0) {
    // For now, we'll check if project domain/client matches
    // This could be extended to check other conditions
    const currentContexts: string[] = [];
    if (context.projectDomain) currentContexts.push(context.projectDomain.toLowerCase());
    if (context.projectClient) currentContexts.push(context.projectClient.toLowerCase());
    
    const allMet = rules.requires.every(req => 
      currentContexts.some(ctx => ctx.includes(req.toLowerCase()) || req.toLowerCase().includes(ctx))
    );
    if (!allMet) {
      return false;
    }
  }

  return true;
};

/**
 * Filter glossary entries based on document context
 */
const filterGlossaryByContext = (glossary: OrchestratorGlossaryEntry[], context: DocumentContext): OrchestratorGlossaryEntry[] => {
  return glossary.filter(entry => matchesContext(entry, context));
};

type GlossaryEntryRaw = {
  id: string;
  sourceTerm: string;
  targetTerm: string;
  sourceLocale: string;
  targetLocale: string;
  isForbidden: boolean;
  notes: string | null;
  contextRules: any;
};

/** Cyrillic block used to detect non-Latin DNA values (we only inject Latin target terms into glossary). */
const CYRILLIC_REGEX = /[\u0400-\u04FF]/;

/**
 * Get the target (e.g. English) string from a DNA abbreviationLogic value for glossary injection.
 * Prefers shortForm, then longForm/value; returns null if the result would be Cyrillic (we want Latin only).
 */
function getDnaTargetForGlossary(v: unknown): string | null {
  if (v == null) return null;
  if (typeof v === 'string') {
    const t = v.trim();
    return t && !CYRILLIC_REGEX.test(t) ? t : null;
  }
  if (typeof v === 'object' && v !== null) {
    const o = v as Record<string, unknown>;
    if (typeof o.shortForm === 'string' && o.shortForm.trim()) return o.shortForm.trim();
    const str = typeof o.longForm === 'string' ? o.longForm : typeof o.value === 'string' ? o.value : null;
    if (str && str.trim() && !CYRILLIC_REGEX.test(str.trim())) return str.trim();
  }
  return null;
}

/**
 * Build glossary entries from Document DNA abbreviationLogic for keys that appear in the segment source.
 * Ensures the model receives explicit required terms (e.g. "РГП «Госэкспертиза»" → "RSE \"Gosexpertiza\"")
 * so DNA terms are not ignored when the model translates freely.
 */
function getGlossaryEntriesFromDnaInSource(
  sourceText: string,
  abbreviationLogic: Record<string, unknown> | null | undefined,
): OrchestratorGlossaryEntry[] {
  if (!sourceText || !abbreviationLogic || typeof abbreviationLogic !== 'object') return [];
  const cleaned = stripFormattingTags(sourceText);
  const entries: OrchestratorGlossaryEntry[] = [];
  for (const [key, value] of Object.entries(abbreviationLogic)) {
    if (!key || !key.trim()) continue;
    if (cleaned.indexOf(key) === -1) continue;
    const target = getDnaTargetForGlossary(value);
    if (!target) continue;
    entries.push({ term: key, translation: target, forbidden: false });
  }
  return entries;
}

/**
 * Get relevant glossary entries: exact match against full glossary first, then vector enrichment.
 * Ensures terms that literally appear in the source are never missed (recall fix).
 */
const getRelevantGlossaryEntries = async (
  sourceText: string,
  sourceLocale: string,
  targetLocale: string,
  projectId: string,
  documentContext: DocumentContext,
): Promise<OrchestratorGlossaryEntry[]> => {
  if (!sourceText || !sourceText.trim()) {
    return [];
  }

  // Step 1 — Exact match against full glossary (mandatory): project + global, no take limit
  const allEntries = await prisma.glossaryEntry.findMany({
    where: {
      OR: [{ projectId }, { projectId: null }],
      sourceLocale,
      targetLocale,
    },
    select: {
      id: true,
      sourceTerm: true,
      targetTerm: true,
      sourceLocale: true,
      targetLocale: true,
      isForbidden: true,
      notes: true,
      contextRules: true,
    },
  });

  const directionFilteredRaw = allEntries.filter(
    (e) => mapGlossaryEntries([e], sourceLocale, targetLocale).length > 0,
  );
  const mappedForExact = mapGlossaryEntries(
    directionFilteredRaw,
    sourceLocale,
    targetLocale,
  );
  const exactMatchesOrchestrator = filterGlossaryBySourceText(
    mappedForExact,
    sourceText,
    sourceLocale,
  );
  const exactMatchIndices = new Set<number>();
  exactMatchesOrchestrator.forEach((oe) => {
    const i = mappedForExact.findIndex(
      (m) => m.term === oe.term && m.translation === oe.translation,
    );
    if (i >= 0) exactMatchIndices.add(i);
  });
  const exactMatchesRaw: GlossaryEntryRaw[] = directionFilteredRaw.filter((_, i) =>
    exactMatchIndices.has(i),
  );

  const exactMatchCount = exactMatchesRaw.length;

  // Step 2 — Vector enrichment (optional): merge by id, never remove exact matches
  let vectorEnrichmentRaw: GlossaryEntryRaw[] = [];
  try {
    if (env.openAiApiKey) {
      const queryEmbedding = await generateEmbedding(sourceText, true);
      const vectorResults = await searchGlossaryByVector(queryEmbedding, {
        projectId,
        sourceLocale,
        targetLocale,
        limit: 50,
        minSimilarity: 0.6,
      });
      if (vectorResults.length > 0) {
        const vectorIds = vectorResults.map((r) => r.id);
        const fullEntries = await prisma.glossaryEntry.findMany({
          where: { id: { in: vectorIds } },
          select: {
            id: true,
            sourceTerm: true,
            targetTerm: true,
            sourceLocale: true,
            targetLocale: true,
            isForbidden: true,
            notes: true,
            contextRules: true,
          },
        });
        const entriesMap = new Map(fullEntries.map((e) => [e.id, e]));
        vectorEnrichmentRaw = vectorIds
          .map((id) => entriesMap.get(id))
          .filter((entry): entry is GlossaryEntryRaw => entry !== undefined);
      }
    }
  } catch (error: any) {
    logger.warn(
      { error: error.message, sourceText: sourceText.substring(0, 50) },
      'Vector search failed for glossary (enrichment), using exact matches only',
    );
  }

  const vectorEnrichmentCount = vectorEnrichmentRaw.length;

  // Step 4 — Fallback only if both exact and vector returned zero
  let mergedRaw: GlossaryEntryRaw[];
  if (exactMatchCount === 0 && vectorEnrichmentCount === 0) {
    logger.debug('No exact or vector glossary matches, using fallback: take 200');
    mergedRaw = await prisma.glossaryEntry.findMany({
      where: { OR: [{ projectId }, { projectId: null }] },
      orderBy: { createdAt: 'desc' },
      take: 200,
      select: {
        id: true,
        sourceTerm: true,
        targetTerm: true,
        sourceLocale: true,
        targetLocale: true,
        isForbidden: true,
        notes: true,
        contextRules: true,
      },
    });
  } else {
    const mergedById = new Map<string, GlossaryEntryRaw>();
    for (const e of exactMatchesRaw) mergedById.set(e.id, e);
    for (const e of vectorEnrichmentRaw) if (!mergedById.has(e.id)) mergedById.set(e.id, e);
    mergedRaw = Array.from(mergedById.values());
  }

  const mergedCount = mergedRaw.length;

  // Step 3 — Apply existing filters on merged set
  const directionFiltered = mapGlossaryEntries(mergedRaw, sourceLocale, targetLocale);
  const contextFiltered = filterGlossaryByContext(directionFiltered, documentContext);
  const finalFiltered = filterGlossaryBySourceText(
    contextFiltered,
    sourceText,
    sourceLocale,
  );

  logger.debug(
    {
      sourceText: sourceText.substring(0, 50),
      exactMatchCount,
      vectorEnrichmentCount,
      mergedCount,
      contextFilteredCount: contextFiltered.length,
      finalFilteredCount: finalFiltered.length,
    },
    'Glossary filtering pipeline results (exact-first)',
  );

  return finalFiltered;
};

/**
 * Filter glossary entries based on whether the source term appears in the source text
 * Uses stemming to handle word variations (plurals, case endings) for English and Russian
 */
const filterGlossaryBySourceText = (
  glossary: OrchestratorGlossaryEntry[], 
  sourceText: string,
  sourceLocale: string
): OrchestratorGlossaryEntry[] => {
  if (!sourceText) return [];
  
  return glossary.filter(entry => {
    return matchesWithVariations(entry.term, sourceText, sourceLocale);
  });
};

export const buildAiContext = async (
  projectId: string,
  documentSourceLocale?: string,
  documentTargetLocale?: string,
  sourceText?: string, // Optional: when provided, use vector search for relevant terms
): Promise<AiContext> => {
  // Fetch project, settings, and guidelines in parallel
  const [project, settings, guidelineRecord] = await Promise.all([
    prisma.project.findUnique({
      where: { id: projectId },
      select: {
        name: true,
        clientName: true,
        domain: true,
        description: true,
        sourceLang: true,
        sourceLocale: true,
        targetLang: true,
        targetLocales: true,
      },
    }),
    getProjectAISettings(projectId),
    prisma.projectGuideline.findUnique({ where: { projectId } }),
  ]);

  // Fetch glossary entries: use vector search if sourceText provided, otherwise fallback to newest 200
  let glossaryEntries: Array<{
    sourceTerm: string;
    targetTerm: string;
    sourceLocale: string;
    targetLocale: string;
    isForbidden: boolean;
    notes: string | null;
    contextRules: any;
  }> = [];

  if (sourceText && sourceText.trim() && documentSourceLocale && documentTargetLocale) {
    // Step 1 — Exact match against full glossary (mandatory): project + global entries
    const allEntries = await prisma.glossaryEntry.findMany({
      where: {
        OR: [{ projectId }, { projectId: null }],
        sourceLocale: documentSourceLocale,
        targetLocale: documentTargetLocale,
      },
      select: {
        id: true,
        sourceTerm: true,
        targetTerm: true,
        sourceLocale: true,
        targetLocale: true,
        isForbidden: true,
        notes: true,
      },
    });

    const exactMatched = filterGlossaryBySourceText(
      allEntries.map((e) => ({
        id: e.id,
        term: e.sourceTerm,
        translation: e.targetTerm,
        forbidden: e.isForbidden,
        notes: e.notes,
      })) as unknown as OrchestratorGlossaryEntry[],
      sourceText,
      documentSourceLocale,
    ) as unknown as Array<OrchestratorGlossaryEntry & { id: string }>;

    const exactMatchIds = new Set(exactMatched.map((m) => m.id));
    const exactMatchesRaw = allEntries.filter((e) => exactMatchIds.has(e.id));

    // Step 2 — Vector enrichment (optional): merge by id, never remove exact matches
    let vectorEnrichmentRaw: typeof allEntries = [];
    try {
      if (env.openAiApiKey) {
        const queryEmbedding = await generateEmbedding(sourceText, true);

        const vectorResults = await searchGlossaryByVector(queryEmbedding, {
          projectId,
          sourceLocale: documentSourceLocale,
          targetLocale: documentTargetLocale,
          limit: 50, // Top 50 candidates
          minSimilarity: 0.6, // Lower threshold to get more candidates for filtering
        });

        if (vectorResults.length > 0) {
          const vectorIds = vectorResults.map((r) => r.id);
          const fullEntries = await prisma.glossaryEntry.findMany({
            where: { id: { in: vectorIds } },
            select: {
              id: true,
              sourceTerm: true,
              targetTerm: true,
              sourceLocale: true,
              targetLocale: true,
              isForbidden: true,
              notes: true,
            },
          });

          // Preserve order from vector search results (most relevant first)
          const entriesMap = new Map(fullEntries.map((e) => [e.id, e]));
          vectorEnrichmentRaw = vectorIds
            .map((id) => entriesMap.get(id))
            .filter((entry): entry is NonNullable<typeof entry> => entry !== undefined);
        }
      }
    } catch (error: any) {
      logger.warn(
        {
          error: error.message,
          sourceText: sourceText.substring(0, 50),
        },
        'Vector search failed for glossary in buildAiContext (enrichment), continuing with exact matches only',
      );
      // Fallback handled below
    }

    const mergedById = new Map<string, (typeof allEntries)[number]>();
    for (const e of exactMatchesRaw) mergedById.set(e.id, e);
    for (const e of vectorEnrichmentRaw) if (!mergedById.has(e.id)) mergedById.set(e.id, e);
    const mergedRaw = Array.from(mergedById.values());

    let finalCountBeforeFilter: number;
    let finalFilteredCount: number;

    // Step 3 — Fallback only if both exact and vector are empty
    if (exactMatchesRaw.length === 0 && vectorEnrichmentRaw.length === 0) {
      logger.debug('Using fallback: traditional search with take: 200');
      const fallbackRaw = await prisma.glossaryEntry.findMany({
        where: {
          OR: [{ projectId }, { projectId: null }],
        },
        orderBy: { createdAt: 'desc' },
        take: 200,
        select: { sourceTerm: true, targetTerm: true, sourceLocale: true, targetLocale: true, isForbidden: true, notes: true },
      });
      glossaryEntries = fallbackRaw.map((e) => ({ ...e, contextRules: undefined }));
      finalCountBeforeFilter = 0;
      finalFilteredCount = glossaryEntries.length;
    } else {
      // Step 4 — Filter merged set so only entries that appear in source text are included (vector-only can leak otherwise)
      const mergedAsOrchestrator = mergedRaw.map((e) => ({
        id: e.id,
        term: e.sourceTerm,
        translation: e.targetTerm,
        forbidden: e.isForbidden,
        notes: e.notes,
      }));
      const filteredOrchestrator = filterGlossaryBySourceText(
        mergedAsOrchestrator as unknown as OrchestratorGlossaryEntry[],
        sourceText,
        documentSourceLocale,
      );
      const filteredIds = new Set((filteredOrchestrator as unknown as Array<{ id: string }>).map((x) => x.id));
      const filteredRaw = mergedRaw.filter((e) => filteredIds.has(e.id));
      glossaryEntries = filteredRaw.map(({ id, ...rest }) => ({ ...rest, contextRules: undefined }));
      finalCountBeforeFilter = mergedRaw.length;
      finalFilteredCount = glossaryEntries.length;
    }

    logger.debug({
      sourceText: sourceText.substring(0, 50),
      exactMatchCount: exactMatchesRaw.length,
      vectorEnrichmentCount: vectorEnrichmentRaw.length,
      finalCount: finalCountBeforeFilter,
      finalFilteredCount,
    }, 'Glossary retrieval (exact-first) in buildAiContext');
  }

  // Fallback: If vector search returned no results or sourceText not provided, use traditional search
  if (glossaryEntries.length === 0) {
    logger.debug('Using fallback: traditional search with take: 200');
    const fallbackRaw = await prisma.glossaryEntry.findMany({
      where: { 
        OR: [{ projectId }, { projectId: null }],
      },
      orderBy: { createdAt: 'desc' },
      take: 200,
      select: { sourceTerm: true, targetTerm: true, sourceLocale: true, targetLocale: true, isForbidden: true, notes: true },
    });
    glossaryEntries = fallbackRaw.map((e) => ({ ...e, contextRules: undefined }));
  }

  if (!project) {
    throw ApiError.notFound('Project not found for AI context');
  }

  // Extract API key and folderId from project settings config if available
  // Priority: provider-specific key (e.g., openaiApiKey) > legacy apiKey > undefined
  let apiKey: string | undefined;
  let yandexFolderId: string | undefined;
  
  // Log settings for debugging
  logger.debug({
    hasSettings: !!settings,
    hasConfig: !!(settings?.config),
    configType: typeof settings?.config,
    configIsNull: settings?.config === null,
    configIsUndefined: settings?.config === undefined,
    configValue: settings?.config ? JSON.stringify(settings.config).substring(0, 200) : 'none',
    provider: settings?.provider,
  }, 'Checking project settings for API key');
  
  // Handle config: it can be null (from database) or undefined, or a valid object
  // Skip if config is null or undefined - this means no API keys are configured
  if (settings?.config && typeof settings.config === 'object' && settings.config !== null && !Array.isArray(settings.config)) {
    const config = settings.config as Record<string, unknown>;
    const providerName = settings.provider?.toLowerCase();
    
    logger.debug({
      provider: providerName,
      configKeys: Object.keys(config),
      configKeysCount: Object.keys(config).length,
    }, 'Processing project settings config');
    
    // Try provider-specific key first (e.g., openaiApiKey, geminiApiKey, yandexApiKey)
    const providerKeyName = providerName ? `${providerName}ApiKey` : null;
    if (providerKeyName && providerKeyName in config) {
      apiKey = config[providerKeyName] as string;
      logger.debug({
        provider: providerName,
        keyFound: 'provider-specific',
        keyName: providerKeyName,
        keyLength: apiKey?.length ?? 0,
        hasKey: !!apiKey,
      }, 'Extracted provider-specific API key from project settings');
    }
    // Fallback to legacy apiKey field
    else if ('apiKey' in config) {
      apiKey = config.apiKey as string;
      logger.debug({
        provider: providerName,
        keyFound: 'legacy',
        keyLength: apiKey?.length ?? 0,
        hasKey: !!apiKey,
      }, 'Extracted legacy API key from project settings');
    } else {
      logger.warn({
        provider: providerName,
        configKeys: Object.keys(config),
        expectedKey: providerKeyName,
      }, 'No API key found in project settings config');
    }
    
    // Extract Yandex Folder ID if available
    if ('yandexFolderId' in config) {
      yandexFolderId = config.yandexFolderId as string;
      logger.debug({
        folderIdLength: yandexFolderId?.length ?? 0,
        hasFolderId: !!yandexFolderId,
      }, 'Extracted Yandex Folder ID from project settings');
    }
  } else {
    logger.warn({
      hasSettings: !!settings,
      hasConfig: !!(settings?.config),
      configType: typeof settings?.config,
      configIsNull: settings?.config === null,
      configIsUndefined: settings?.config === undefined,
      configIsArray: Array.isArray(settings?.config),
      provider: settings?.provider,
    }, 'Project settings config is not available or not an object');
  }

  // Map glossary entries to OrchestratorGlossaryEntry format
  const mappedGlossary = mapGlossaryEntries(
    glossaryEntries,
    documentSourceLocale ?? project.sourceLocale ?? project.sourceLang ?? '',
    documentTargetLocale ?? project.targetLocales?.[0] ?? project.targetLang ?? '',
  );

  // Apply strict filtering with stemming if sourceText is provided (RAG Architecture)
  // Vector search found the candidates, now filterGlossaryBySourceText confirms the matches
  const finalGlossary = sourceText && sourceText.trim() && documentSourceLocale
    ? filterGlossaryBySourceText(
        mappedGlossary,
        sourceText,
        documentSourceLocale,
      )
    : mappedGlossary;

  logger.debug({
    sourceText: sourceText ? sourceText.substring(0, 50) : 'none',
    rawEntriesCount: glossaryEntries.length,
    mappedCount: mappedGlossary.length,
    finalCount: finalGlossary.length,
    filteringApplied: !!(sourceText && sourceText.trim() && documentSourceLocale),
  }, 'Glossary processing in buildAiContext');

  return {
    projectMeta: {
      name: project.name,
      client: project.clientName,
      domain: project.domain,
      sourceLang: project.sourceLang ?? project.sourceLocale,
      targetLang: project.targetLang ?? project.targetLocales?.[0],
      summary: project.description,
    },
    settings,
    guidelines: normalizeGuidelines(guidelineRecord?.rules ?? null),
    glossary: finalGlossary,
    apiKey,
    yandexFolderId,
  };
};

const buildOrchestratorSegment = (
  segment: { id: string; sourceText: string; segmentIndex: number },
  previous?: { sourceText: string } | null,
  next?: { sourceText: string } | null,
  documentName?: string | null,
): OrchestratorSegment => ({
  segmentId: segment.id,
  sourceText: segment.sourceText,
  previousText: previous?.sourceText,
  nextText: next?.sourceText,
  documentName: documentName ?? undefined,
});

/** Max segments per translation unit to avoid token overflow (list blocks are split when larger). */
const MAX_UNIT_SEGMENTS = 12;

/** Max chars per unit (rough input token guard); units are split when exceeded. */
const MAX_UNIT_CHARS = 8000;

/**
 * Queued entry shape used when building translation units (same as pretranslate queuedForAI elements).
 */
export type QueuedEntry = {
  segment: { id: string; sourceText: string; segmentIndex: number };
  previous?: { sourceText: string } | null;
  next?: { sourceText: string } | null;
};

/** Colon at end of line (ASCII or fullwidth U+FF1A) for list lead-in. */
const LIST_LEAD_IN_ENDING = /[:\uFF1A]\s*$/;
/** Semicolon at end of line (ASCII, fullwidth U+FF1B, Greek ano teleia U+037E). */
const LIST_ITEM_ENDING_SEMICOLON = /[;\uFF1B\u037E]\s*$/;
/** Period at end (sentence end) for last list item. */
const LIST_ITEM_ENDING_PERIOD = /[.\uFF0E]\s*$/;
/** Sentence-ending punctuation: do not treat as list item when at end (avoid merging standalone sentences). */
const SENTENCE_END = /[.!?\uFF0E\uFF1F\uFF01]\s*$/;

/**
 * Detect list-block lead-in: short line ending with colon (e.g. "Проект позволит:").
 */
function looksLikeListLeadIn(text: string): boolean {
  const t = (text ?? '').trim();
  return t.length > 0 && t.length <= 200 && LIST_LEAD_IN_ENDING.test(t);
}

/**
 * Detect list item: ends with semicolon (or variants), starts with bullet/dash/number,
 * or is a short line that does not end with sentence punctuation (e.g. first item with no trailing semicolon).
 */
function looksLikeListItem(text: string): boolean {
  const t = (text ?? '').trim();
  if (!t.length) return false;
  if (LIST_ITEM_ENDING_SEMICOLON.test(t)) return true;
  if (/^[\s]*[•\-—]\s/.test(t)) return true;
  if (/^[\s]*\d+\.\s/.test(t)) return true;
  if (t.length <= 220 && !SENTENCE_END.test(t)) return true;
  return false;
}

/**
 * Detect likely closing list item: short line ending with period (e.g. "подключить дополнительных потребителей.").
 * Used to include the last list item when lists end with a period instead of semicolon.
 */
function looksLikeListClosingItem(text: string): boolean {
  const t = (text ?? '').trim();
  return t.length > 0 && t.length <= 250 && LIST_ITEM_ENDING_PERIOD.test(t);
}

/**
 * Build translation units from queued segments: list blocks (lead-in + items) are grouped,
 * other segments are single-segment units. Oversized blocks are split by max segments/chars.
 */
export function buildTranslationUnits(
  queued: QueuedEntry[],
  options: { maxUnitSegments?: number; maxUnitChars?: number } = {},
): QueuedEntry[][] {
  const maxSegs = options.maxUnitSegments ?? MAX_UNIT_SEGMENTS;
  const maxChars = options.maxUnitChars ?? MAX_UNIT_CHARS;
  const units: QueuedEntry[][] = [];
  let i = 0;
  while (i < queued.length) {
    const entry = queued[i];
    const raw = entry.segment.sourceText ?? '';
    const text = stripFormattingTags(raw).trim();
    const isLeadIn = looksLikeListLeadIn(text);
    const hasNext = i + 1 < queued.length;
    const nextRaw = hasNext ? (queued[i + 1].segment.sourceText ?? '') : '';
    const nextText = stripFormattingTags(nextRaw).trim();
    const nextIsItem = looksLikeListItem(nextText);

    if (isLeadIn && hasNext && nextIsItem) {
      const block: QueuedEntry[] = [entry];
      let chars = text.length;
      i += 1;
      while (i < queued.length) {
        const segRaw = queued[i].segment.sourceText ?? '';
        const segText = stripFormattingTags(segRaw).trim();
        if (!looksLikeListItem(segText)) break;
        if (block.length >= maxSegs || chars + segText.length > maxChars) break;
        block.push(queued[i]);
        chars += segText.length;
        i += 1;
      }
      // Include one closing list item (short line ending with period) if present
      if (i < queued.length && block.length > 1) {
        const closingRaw = queued[i].segment.sourceText ?? '';
        const closingText = stripFormattingTags(closingRaw).trim();
        if (looksLikeListClosingItem(closingText) && block.length < maxSegs && chars + closingText.length <= maxChars) {
          block.push(queued[i]);
          i += 1;
        }
      }
      units.push(block);
      continue;
    }
    units.push([entry]);
    i += 1;
  }
  return units;
}

/** Collect target-language abbreviations from Document DNA abbreviationLogic for Style Governor tracking. */
function getKnownTargetAbbreviations(abbreviationLogic: Record<string, unknown> | null | undefined): string[] {
  if (!abbreviationLogic || typeof abbreviationLogic !== 'object') return [];
  const out = new Set<string>();
  for (const v of Object.values(abbreviationLogic)) {
    const str = typeof v === 'string' ? v : (v && typeof v === 'object' && 'value' in v ? String((v as { value: unknown }).value) : null);
    if (!str) continue;
    const inParens = str.match(/\(([A-Z][A-Z0-9]{1,})\)/);
    if (inParens) out.add(inParens[1]);
    else if (/^[A-Z][A-Z0-9]{1,}$/.test(str.trim())) out.add(str.trim());
  }
  return Array.from(out);
}

export const listAIProviders = () => listAvailableProviders();

/**
 * Get available models for a specific AI provider
 */
export const getAvailableModels = (provider: 'gemini' | 'openai' | 'yandex' | 'deepseek' | 'claude'): string[] => {
  const models: Record<string, string[]> = {
    gemini: [
      'gemini-2.0-flash-exp',
      'gemini-2.0-flash-thinking-exp',
      'gemini-1.5-pro',
      'gemini-1.5-flash',
      'gemini-pro',
    ],
    openai: [
      'gpt-4o',
      'gpt-4o-mini',
      'gpt-4-turbo',
      'gpt-4',
      'gpt-3.5-turbo',
    ],
    yandex: [
      'yandexgpt',
      'yandexgpt-lite',
    ],
    deepseek: [
      'deepseek-reasoner',
      'deepseek-chat',
    ],
    claude: [
      'claude-sonnet-4-20250514',
      'claude-3-5-sonnet-20241022',
      'claude-3-opus-20240229',
      'claude-3-sonnet-20240229',
      'claude-3-haiku-20240307',
    ],
  };

  return models[provider] || [];
};

export const getProjectAISettings = (projectId: string) =>
  prisma.projectAISetting.findUnique({
    where: { projectId },
  });

export const upsertProjectAISettings = async (projectId: string, payload: ProjectAISettingsPayload) => {
  // Get existing settings to merge config
  const existing = await prisma.projectAISetting.findUnique({
    where: { projectId },
    select: { config: true },
  });

  // Merge config: preserve existing config and merge with new config
  let mergedConfig: Record<string, unknown> | undefined;
  if (payload.config && Object.keys(payload.config).length > 0) {
    mergedConfig = {
      ...(existing?.config && typeof existing.config === 'object' ? (existing.config as Record<string, unknown>) : {}),
      ...payload.config,
    };
  } else if (existing?.config && typeof existing.config === 'object') {
    // Preserve existing config if no new config provided
    mergedConfig = existing.config as Record<string, unknown>;
  }

  const configValue = mergedConfig && Object.keys(mergedConfig).length > 0 
    ? toJsonValue(mergedConfig) 
    : undefined;
  
  return prisma.projectAISetting.upsert({
    where: { projectId },
    update: {
      provider: payload.provider,
      model: payload.model,
      temperature: payload.temperature,
      maxTokens: payload.maxTokens,
      ...(configValue !== undefined ? { config: configValue } : {}),
    },
    create: {
      projectId,
      provider: payload.provider,
      model: payload.model,
      temperature: payload.temperature,
      maxTokens: payload.maxTokens,
      ...(configValue !== undefined ? { config: configValue } : {}),
    },
  });
};

export const getProjectGuidelines = async (projectId: string) => {
  const record = await prisma.projectGuideline.findUnique({ where: { projectId } });
  return record ?? { projectId, rules: [] };
};

export const upsertProjectGuidelines = (projectId: string, rules: unknown) =>
  prisma.projectGuideline.upsert({
    where: { projectId },
    update: { rules: rules as Prisma.InputJsonValue },
    create: { projectId, rules: rules as Prisma.InputJsonValue },
  });

type SegmentSuggestion = {
  segmentId: string;
  targetText: string;
  confidence: number;
  provider: TranslationProvider;
  source: 'memory' | 'llm' | 'rule';
};

export const generateSegmentSuggestions = async (documentId: string): Promise<SegmentSuggestion[]> => {
  const document = await prisma.document.findUnique({
    where: { id: documentId },
    include: {
      segments: {
        orderBy: { segmentIndex: 'asc' },
        select: { id: true, sourceText: true, segmentIndex: true },
      },
    },
  });
  if (!document) {
    throw ApiError.notFound('Document not found');
  }

  const context = await buildAiContext(document.projectId);
  const suggestionMap = new Map<string, SegmentSuggestion>();
  const segmentsNeedingAI: OrchestratorSegment[] = [];
  const tmThreshold = 85;

  for (let i = 0; i < document.segments.length; i += 1) {
    const segment = document.segments[i];
    const neighbors = {
      previous: i > 0 ? document.segments[i - 1] : null,
      next: i < document.segments.length - 1 ? document.segments[i + 1] : null,
    };

    const tmMatches = await searchTranslationMemory({
      sourceText: segment.sourceText,
      sourceLocale: document.sourceLocale,
      targetLocale: document.targetLocale,
      projectId: document.projectId,
      limit: 1,
      minScore: tmThreshold,
    });
    const bestTm = tmMatches[0];
    if (bestTm) {
      suggestionMap.set(segment.id, {
        segmentId: segment.id,
        targetText: bestTm.targetText,
        confidence: bestTm.fuzzyScore / 100,
        provider: bestTm.scope === 'project' ? 'project-tm' : 'global-tm',
        source: 'memory',
      });
    } else {
      segmentsNeedingAI.push(
        buildOrchestratorSegment(segment, neighbors.previous, neighbors.next, document.name ?? undefined),
      );
    }
  }

  if (segmentsNeedingAI.length > 0) {
    // Get relevant glossary entries using vector search + strict filtering (Hybrid Approach)
    // For batch processing, use combined source text for vector search
    const documentContext: DocumentContext = {
      projectDomain: context.projectMeta.domain,
      projectClient: context.projectMeta.client,
      documentName: document.name,
      documentType: undefined,
    };
    const combinedSourceText = segmentsNeedingAI.map(s => s.sourceText).join(' ');
    const filteredGlossary = await getRelevantGlossaryEntries(
      combinedSourceText,
      document.sourceLocale,
      document.targetLocale,
      document.projectId,
      documentContext,
    );

    // Fetch document with summary and Document DNA for PROJECT KNOWLEDGE BASE
    const documentWithSummary = await prisma.document.findUnique({
      where: { id: document.id },
      select: {
        name: true,
        summary: true,
        clusterSummary: true,
        documentDna: {
          select: {
            technicalSchema: true,
            namingConventions: true,
            abbreviationLogic: true,
            entityGroups: true,
          },
        },
      },
    });

    // Stage 2: Fetch document-specific context from Analyst Stage
    // Get style rules for the document (same for all segments)
    const documentStyleRules = await getDocumentStyleRules(document.id);
    
    // Get document glossary terms that match any segment in the batch
    // We'll collect all matching terms from all segments, then deduplicate and limit
    const documentGlossaryMap = new Map<string, { sourceTerm: string; targetTerm: string; status: string; occurrenceCount: number }>();
    
    // For each segment, find matching glossary terms
    for (const segment of segmentsNeedingAI) {
      const matchingTerms = await getDocumentGlossaryForSegment(document.id, segment.sourceText);
      // Add to map (deduplicate by sourceTerm, keeping highest priority)
      for (const term of matchingTerms) {
        const existing = documentGlossaryMap.get(term.sourceTerm);
        if (!existing || term.status === 'PREFERRED' || (term.status === 'CANDIDATE' && existing.status !== 'PREFERRED')) {
          documentGlossaryMap.set(term.sourceTerm, term);
        }
      }
    }
    
    // Convert to array and limit to top 20 (prioritize PREFERRED, then by occurrenceCount)
    const documentGlossary = Array.from(documentGlossaryMap.values())
      .sort((a, b) => {
        const statusPriority = { PREFERRED: 3, CANDIDATE: 2, DEPRECATED: 1 };
        const aPriority = statusPriority[a.status as keyof typeof statusPriority] || 0;
        const bPriority = statusPriority[b.status as keyof typeof statusPriority] || 0;
        if (aPriority !== bPriority) return bPriority - aPriority;
        return b.occurrenceCount - a.occurrenceCount;
      })
      .slice(0, 20)
      .filter(term => term.status !== 'DEPRECATED'); // Exclude deprecated

    logger.debug(
      {
        documentId: document.id,
        segmentsCount: segmentsNeedingAI.length,
        documentGlossaryCount: documentGlossary.length,
        documentStyleRulesCount: documentStyleRules.length,
      },
      'Stage 2: Document context fetched for translation',
    );

    const documentDnaPayload = documentWithSummary
      ? await effectiveDnaForPrismaInclude(document.projectId, documentWithSummary.documentDna)
      : null;

    const aiResults = await orchestrator.translateSegments({
      provider: context.settings?.provider,
      model: context.settings?.model,
      apiKey: context.apiKey,
      yandexFolderId: context.yandexFolderId,
      segments: segmentsNeedingAI,
      glossary: filteredGlossary,
      guidelines: context.guidelines,
      project: context.projectMeta,
      document: documentWithSummary ? {
        name: documentWithSummary.name,
        summary: documentWithSummary.summary ?? undefined,
        clusterSummary: documentWithSummary.clusterSummary ?? undefined,
      } : undefined,
      documentDna: documentDnaPayload ?? undefined,
      sourceLocale: document.sourceLocale, // Pass explicit source locale from document
      targetLocale: document.targetLocale, // Pass explicit target locale from document
      temperature: context.settings?.temperature ?? getDefaultTemperature(context.settings?.provider),
      maxTokens: context.settings?.maxTokens ?? 1024,
      // Stage 2: Document-specific context
      documentGlossary: documentGlossary.length > 0 ? documentGlossary : undefined,
      documentStyleRules: documentStyleRules.length > 0 ? documentStyleRules : undefined,
      documentId: document.id,
    });

    aiResults.forEach((result) => {
      suggestionMap.set(result.segmentId, {
        segmentId: result.segmentId,
        targetText: result.targetText,
        confidence: result.confidence,
        provider: result.provider,
        source: result.fallback ? 'rule' : 'llm',
      });
    });
  }

  return document.segments.map(
    (segment) =>
      suggestionMap.get(segment.id) ?? {
        segmentId: segment.id,
        targetText: segment.sourceText,
        confidence: 0.35,
        provider: 'rule-based',
        source: 'rule',
      },
  );
};

export const runQualityAssurance = async (documentId: string) => {
  const segments = await prisma.segment.findMany({
    where: { documentId },
    select: { id: true, sourceText: true, targetFinal: true },
  });

  return qaEngine.runChecks(
    segments.map((segment) => ({
      id: segment.id,
      sourceText: segment.sourceText,
      targetText: segment.targetFinal,
    })),
  );
};

export const runSegmentMachineTranslation = async (segmentId: string, options?: MachineTranslationOptions) => {
  const segment = await getSegmentWithDocument(segmentId);
  if (!segment || !segment.document) {
    throw ApiError.notFound('Segment not found');
  }

  const context = await buildAiContext(
    segment.document.projectId,
    segment.document.sourceLocale,
    segment.document.targetLocale,
  );
  const minScore = options?.minScore ?? 70;
  const tmAllowed = options?.applyTm ?? true;
  const glossaryMode = options?.glossaryMode ?? 'strict_source'; // Default to strict_source if not provided
  
  // Log glossary mode for debugging
  logger.info({
    segmentId: segment.id,
    glossaryMode,
  }, 'Using glossary mode for segment translation');

  let translationText: string | undefined;
  let fuzzyScore: number | null = null;
  let bestTmEntryId: string | null = null;
  let aiResult: { targetText: string; provider: string; model: string; confidence: number; usage?: any; fullPrompt?: string; analysis?: string } | null = null;
  const metadata: TranslationMetadata[] = [];
  let documentDnaPayload: Awaited<ReturnType<typeof getEffectiveDocumentDna>> | null = null;
  let filteredGlossary: OrchestratorGlossaryEntry[] = [];

  // Priority 1: Check for direct TM match (≥70%)
  if (tmAllowed) {
    const tmMatches = await searchTranslationMemory({
      sourceText: segment.sourceText,
      sourceLocale: segment.document.sourceLocale,
      targetLocale: segment.document.targetLocale,
      projectId: segment.document.projectId,
      limit: 1,
      minScore,
    });
    const bestMatch = tmMatches[0];
    if (bestMatch) {
      const substituted = applyTmMatchWithNumberSubstitution(
        bestMatch.targetText,
        bestMatch.sourceText,
        segment.sourceText,
        segment.document.targetLocale,
      );
      // Use TM only when substitution succeeded, or when it's a 100% match (exact). For <100% matches,
      // do not apply the raw target—it may be a different clause (e.g. 90% similar but wrong semantics).
      const useTm = substituted.applied || bestMatch.fuzzyScore === 100;
      if (useTm) {
        translationText = substituted.applied ? substituted.result : bestMatch.targetText;
        fuzzyScore = bestMatch.fuzzyScore;
        bestTmEntryId = bestMatch.id;
        metadata.push({
          stage: 'tm-direct',
          priority: 1,
          source: 'tm-direct',
          tmDirectMatch: {
            id: bestMatch.id,
            sourceText: bestMatch.sourceText,
            targetText: bestMatch.targetText,
            fuzzyScore: bestMatch.fuzzyScore,
            searchMethod: bestMatch.searchMethod || 'fuzzy',
            numbersAdjusted: substituted.applied,
          },
          message: substituted.applied
            ? `Using direct TM match (${bestMatch.fuzzyScore}% similarity) with numbers/dates adjusted`
            : `Using direct TM match (${bestMatch.fuzzyScore}% similarity)`,
        });
      }
    }
  }

  if (!translationText) {
    const neighborSegments = await prisma.segment.findMany({
      where: {
        documentId: segment.document.id,
        segmentIndex: {
          in: [segment.segmentIndex - 1, segment.segmentIndex + 1],
        },
      },
      select: { segmentIndex: true, sourceText: true },
    });
    const previous = neighborSegments.find((item) => item.segmentIndex === segment.segmentIndex - 1);
    const next = neighborSegments.find((item) => item.segmentIndex === segment.segmentIndex + 1);

    // Priority 3: Classic RAG - Retrieve TM examples for AI context (even if <70% threshold)
    // These examples help the AI learn translation style and terminology
    let tmExamples: TmExample[] = [];
    if (tmAllowed) {
      // Использовать настройки из TM Search Panel, если переданы, иначе использовать значения по умолчанию
      const ragMinScore = options?.tmRagSettings?.minScore ?? 50; // Default 50
      const ragVectorSimilarity = options?.tmRagSettings?.vectorSimilarity ?? 60; // Default 60
      const ragMode = options?.tmRagSettings?.mode ?? 'basic'; // Default basic
      const ragUseVectorSearch = options?.tmRagSettings?.useVectorSearch ?? true; // Default true
      const ragLimit = options?.tmRagSettings?.limit ?? 5; // Default 5

      // Use scatter-gather search: split paragraph, search sentences + full paragraph
      const exampleMatches = await scatterGatherTmSearch(
        segment.sourceText,
        segment.document.sourceLocale,
        segment.document.targetLocale,
        segment.document.projectId,
        {
          limit: ragLimit,
          minScore: ragMinScore,
          vectorSimilarity: ragVectorSimilarity,
          mode: ragMode,
          useVectorSearch: ragUseVectorSearch,
        }
      );
      
      tmExamples = exampleMatches.map((match) => ({
        sourceText: match.sourceText,
        targetText: match.targetText,
        fuzzyScore: match.fuzzyScore,
        searchMethod: match.searchMethod || 'fuzzy',
      }));

      // Add metadata for TM RAG examples
      if (tmExamples.length > 0) {
        metadata.push({
          stage: 'ai-draft',
          priority: 3,
          source: 'tm-rag',
          tmExamples: tmExamples.map(ex => ({
            sourceText: ex.sourceText,
            targetText: ex.targetText,
            fuzzyScore: ex.fuzzyScore,
            searchMethod: ex.searchMethod || 'fuzzy',
          })),
          tmSearchSettings: {
            minScore: ragMinScore,
            vectorSimilarity: ragVectorSimilarity,
            mode: ragMode,
            useVectorSearch: ragUseVectorSearch,
            limit: ragLimit,
          },
          message: `Using ${tmExamples.length} TM example(s) for RAG context (${ragMinScore}%+ similarity)`,
        });
        
        logger.info({
          segmentId: segment.id,
          sourceText: segment.sourceText.substring(0, 50),
          exampleCount: tmExamples.length,
          topExample: tmExamples[0] ? {
            source: tmExamples[0].sourceText.substring(0, 50),
            target: tmExamples[0].targetText.substring(0, 50),
            score: tmExamples[0].fuzzyScore,
            method: tmExamples[0].searchMethod,
          } : null,
        }, 'Retrieved TM examples for Classic RAG');
      } else {
        logger.debug({
          segmentId: segment.id,
          sourceText: segment.sourceText.substring(0, 50),
        }, 'No TM examples found for Classic RAG');
      }
    }

    // Priority 2: Glossary entries - find which terms are actually in the source text
    // Use vector search + strict filtering (RAG architecture)
    const glossaryDocumentContext: DocumentContext = {
      projectDomain: context.projectMeta.domain,
      projectClient: context.projectMeta.client,
      documentName: segment.document.name,
      documentType: undefined, // Could be extracted from document metadata in the future
    };
    
    const relevantGlossaryEntriesFromRAG = await getRelevantGlossaryEntries(
      segment.sourceText,
      segment.document.sourceLocale,
      segment.document.targetLocale,
      segment.document.projectId,
      glossaryDocumentContext,
    );
    
    if (relevantGlossaryEntriesFromRAG.length > 0) {
      const relevantGlossaryEntries = relevantGlossaryEntriesFromRAG.map(entry => ({
        sourceTerm: entry.term,
        targetTerm: entry.translation,
        mode: glossaryMode,
        isForbidden: entry.forbidden || false,
      }));

      if (relevantGlossaryEntries.length > 0) {
        metadata.push({
          stage: 'ai-draft',
          priority: 2,
          source: 'glossary',
          glossaryEntries: relevantGlossaryEntries,
          glossaryMode,
          message: `Found ${relevantGlossaryEntries.length} glossary term(s) in source text (mode: ${glossaryMode})`,
        });
      }
    }

    // Priority 4: Guidelines
    if (context.guidelines && context.guidelines.length > 0) {
      metadata.push({
        stage: 'ai-draft',
        priority: 4,
        source: 'guidelines',
        guidelinesCount: context.guidelines.length,
        message: `Using ${context.guidelines.length} guideline(s)`,
      });
    }

    // Priority 5: AI Translation
    metadata.push({
      stage: 'ai-draft',
      priority: 5,
      source: 'ai',
      message: `Generating AI translation using ${context.settings?.provider || 'default'} (${context.settings?.model || 'default model'})`,
    });

    // Get relevant glossary entries using vector search + strict filtering (Hybrid Approach)
    const documentContext: DocumentContext = {
      projectDomain: context.projectMeta.domain,
      projectClient: context.projectMeta.client,
      documentName: segment.document.name,
      documentType: undefined,
    };
    // Keep glossary entries available for downstream validation/repair before DB write.
    filteredGlossary = await getRelevantGlossaryEntries(
      segment.sourceText,
      segment.document.sourceLocale,
      segment.document.targetLocale,
      segment.document.projectId,
      documentContext,
    );

    // (document.name is already available on segment.document)

    // First Mention Only: load document DNA and already-expanded terms from previous segments.
    // Normalize DNA so abbreviationLogic entries are always { longForm, shortForm } for replacement and longForm→shortForm pairs.
    const rawDna = await getEffectiveDocumentDna(segment.document.id);
    documentDnaPayload = (rawDna && normalizeDocumentDnaPayloadOrNull(rawDna)) ?? rawDna ?? null;
    let introducedAbbreviations: string[] = [];
    if (documentDnaPayload?.abbreviationLogic && typeof documentDnaPayload.abbreviationLogic === 'object') {
      const knownAbbrevs = getKnownTargetAbbreviations(documentDnaPayload.abbreviationLogic);
      if (knownAbbrevs.length > 0) {
        const previousSegments = await prisma.segment.findMany({
          where: {
            documentId: segment.document.id,
            segmentIndex: { lt: segment.segmentIndex },
          },
          orderBy: { segmentIndex: 'asc' },
          select: { targetFinal: true, targetMt: true },
        });
        const newFromPrevious = new Set<string>();
        for (const s of previousSegments) {
          const text = (s.targetFinal ?? s.targetMt ?? '').trim();
          const re = /\(([A-Z][A-Z0-9]{1,})\)/g;
          let m: RegExpExecArray | null;
          while ((m = re.exec(text)) !== null) {
            if (knownAbbrevs.includes(m[1])) newFromPrevious.add(m[1]);
          }
        }
        introducedAbbreviations = Array.from(newFromPrevious);
      }
    }

    if (documentDnaPayload) {
      const segValidation = validateDocumentDnaPayload(documentDnaPayload);
      if (!segValidation.valid) {
        throw ApiError.badRequest(`Invalid Document DNA: ${segValidation.errors.join('; ')}`);
      }
      // Inject DNA terms that appear in the source into the glossary so the model uses them (e.g. "РГП «Госэкспертиза»" → "RSE \"Gosexpertiza\"").
      const dnaGlossaryEntries = getGlossaryEntriesFromDnaInSource(
        segment.sourceText,
        documentDnaPayload.abbreviationLogic as Record<string, unknown> | null | undefined,
      );
      if (dnaGlossaryEntries.length > 0) {
        const existingTerms = new Set(filteredGlossary.map((e) => e.term));
        for (const e of dnaGlossaryEntries) {
          if (!existingTerms.has(e.term)) {
            filteredGlossary = [...filteredGlossary, e];
            existingTerms.add(e.term);
          }
        }
      }
    }

    // Calculate dynamic maxTokens based on source text length
    // Rule of thumb: 1 token ≈ 4 characters, translation needs 2-3x input tokens
    // Add buffer for prompt, glossary, examples, etc.
    const sourceTextLength = segment.sourceText.length;
    const estimatedInputTokens = Math.ceil(sourceTextLength / 4);
    // Translation typically needs 1.5-2x input tokens, plus buffer for prompt/context
    const calculatedMaxTokens = Math.max(
      Math.ceil(estimatedInputTokens * 2.5) + 1000, // 2.5x for translation + 1000 for prompt/context
      context.settings?.maxTokens ?? 2048 // Minimum 2048 (increased from 1024)
    );
    // Cap at reasonable maximum (8192 for most models, 32768 for larger models)
    const maxTokens = Math.min(calculatedMaxTokens, 8192);

    logger.info({
      provider: context.settings?.provider,
      model: context.settings?.model,
      sourceTextLength,
      estimatedInputTokens,
      calculatedMaxTokens,
      finalMaxTokens: maxTokens,
      source: 'translateSegment:before-translateSingleSegment',
    }, 'translateSegment: Calling translateSingleSegment with dynamic maxTokens');

    aiResult = await orchestrator.translateSingleSegment(
      buildOrchestratorSegment(segment, previous, next, segment.document.name),
      {
        provider: context.settings?.provider,
        model: context.settings?.model,
        apiKey: context.apiKey,
        yandexFolderId: context.yandexFolderId,
        glossary: filteredGlossary,
        guidelines: context.guidelines,
        tmExamples, // Pass examples for RAG
        project: context.projectMeta,
        document: { name: segment.document.name },
        sourceLocale: segment.document.sourceLocale, // Pass explicit source locale from document
        targetLocale: segment.document.targetLocale, // Pass explicit target locale from document
        temperature: context.settings?.temperature ?? getDefaultTemperature(context.settings?.provider),
        maxTokens,
        glossaryMode, // Pass glossary mode to orchestrator
        documentDna: documentDnaPayload ?? undefined,
        introducedAbbreviations, // First Mention Only: already expanded in previous segments
      },
    );
    translationText = aiResult.targetText;
    fuzzyScore = Math.round((aiResult.confidence ?? 0.85) * 100);
    bestTmEntryId = null;
  }

  if (!translationText) {
    translationText = segment.sourceText;
  } else {
    translationText = ensureLeadingSectionFromSegment(translationText, segment.sourceText);
  }
  if (translationText && documentDnaPayload?.abbreviationLogic) {
    translationText = applyTotalCyrillicBan(translationText, documentDnaPayload.abbreviationLogic as Record<string, unknown>, segment.document.targetLocale);
    translationText = deduplicateFullFormDash(translationText, documentDnaPayload.abbreviationLogic as Record<string, unknown>);
  }

  // Validate glossary compliance and attempt one-shot repair (single-segment path only)
  let glossaryFlagged = false;
  if (aiResult && filteredGlossary && filteredGlossary.length > 0) {
    if (segmentId === '0125c6a1-9ed5-4905-95b3-0ba43e7b1b0a') {
      logger.debug(
        {
          segmentId,
          glossaryEntriesCount: filteredGlossary.length,
          glossaryEntries: filteredGlossary.map((e) => ({
            term: e.term,
            translation: e.translation,
            forbidden: e.forbidden ?? false,
          })),
        },
        'DEBUG validateAndRepairGlossaryCompliance: glossaryEntries passed in',
      );
    }
    const compliance = await validateAndRepairGlossaryCompliance({
      translatedText: translationText,
      sourceText: segment.sourceText,
      glossaryEntries: filteredGlossary,
      sourceLocale: segment.document.sourceLocale,
      targetLocale: segment.document.targetLocale,
      segmentId,
      repairFn: async (prompt: string) => {
        const repairResult = await orchestrator.translateSingleSegment(
          {
            segmentId,
            sourceText: prompt,
            previousText: null,
            nextText: null,
            documentName: segment.document.name ?? undefined,
          },
          {
            provider: context.settings?.provider,
            model: context.settings?.model,
            apiKey: context.apiKey,
            yandexFolderId: context.yandexFolderId,
            glossary: filteredGlossary,
            guidelines: context.guidelines,
            project: context.projectMeta,
            sourceLocale: segment.document.sourceLocale,
            targetLocale: segment.document.targetLocale,
            temperature: context.settings?.temperature ?? getDefaultTemperature(context.settings?.provider),
            maxTokens: context.settings?.maxTokens ?? 1024,
            glossaryMode,
            documentDna: documentDnaPayload ?? undefined,
          },
        );
        return repairResult.targetText || '';
      },
    });

    glossaryFlagged = compliance.flagForReview;
    if (compliance.wasRepaired && compliance.finalText && compliance.finalText.trim()) {
      translationText = compliance.finalText;
      // Re-apply post-processing to maintain required formatting constraints
      translationText = ensureLeadingSectionFromSegment(translationText, segment.sourceText);
      if (translationText && documentDnaPayload?.abbreviationLogic) {
        translationText = applyTotalCyrillicBan(translationText, documentDnaPayload.abbreviationLogic as Record<string, unknown>, segment.document.targetLocale);
        translationText = deduplicateFullFormDash(translationText, documentDnaPayload.abbreviationLogic as Record<string, unknown>);
      }
    }
  }

  const updatedSegment = await prisma.segment.update({
    where: { id: segmentId },
    data: {
      targetMt: translationText,
      fuzzyScore,
      bestTmEntryId,
      glossaryFlagged,
      status: 'MT',
      ...(aiResult && {
        mtFullPrompt: aiResult.fullPrompt ?? undefined,
        mtAnalysis: aiResult.analysis ?? undefined,
      }),
    },
    include: { document: true },
  });

  // Add metadata to the response (extend the Segment type in the API response)
  (updatedSegment as any).translationMetadata = metadata.sort((a, b) => a.priority - b.priority);
  
  // Add model information to the response if AI was used
  if (aiResult) {
    (updatedSegment as any)._metadata = {
      provider: aiResult.provider,
      model: aiResult.model,
      usage: aiResult.usage,
      fullPrompt: aiResult.fullPrompt,
      analysis: aiResult.analysis,
    };
  }

  return updatedSegment;
};

export const runSegmentMachineTranslationWithCritic = async (
  segmentId: string,
  options?: MachineTranslationOptions & { ignoreContext?: boolean },
  onProgress?: (stage: 'draft' | 'critic' | 'editor' | 'complete', message?: string) => void,
) => {
  const segment = await getSegmentWithDocument(segmentId);
  if (!segment || !segment.document) {
    throw ApiError.notFound('Segment not found');
  }

  const context = await buildAiContext(
    segment.document.projectId,
    segment.document.sourceLocale,
    segment.document.targetLocale,
  );
  const minScore = options?.minScore ?? 70;
  const tmAllowed = options?.applyTm ?? true;
  const glossaryMode = options?.glossaryMode ?? 'strict_source';

  logger.info(
    {
      segmentId: segment.id,
      glossaryMode,
    },
    'Using critic workflow for segment translation',
  );

  // Get neighbor segments for context
  const neighborSegments = await prisma.segment.findMany({
    where: {
      documentId: segment.document.id,
      segmentIndex: {
        in: [segment.segmentIndex - 1, segment.segmentIndex + 1],
      },
    },
    select: { segmentIndex: true, sourceText: true },
  });
  const previous = neighborSegments.find((item) => item.segmentIndex === segment.segmentIndex - 1);
  const next = neighborSegments.find((item) => item.segmentIndex === segment.segmentIndex + 1);

  // Get TM examples for RAG
  let tmExamples: TmExample[] = [];
  if (tmAllowed) {
    // Использовать настройки из TM Search Panel, если переданы, иначе использовать значения по умолчанию
    const ragMinScore = options?.tmRagSettings?.minScore ?? 50; // Default 50
    const ragVectorSimilarity = options?.tmRagSettings?.vectorSimilarity ?? 60; // Default 60
    const ragMode = options?.tmRagSettings?.mode ?? 'basic'; // Default basic
    const ragUseVectorSearch = options?.tmRagSettings?.useVectorSearch ?? true; // Default true
    const ragLimit = options?.tmRagSettings?.limit ?? 5; // Default 5

    const exampleMatches = await searchTranslationMemory({
      sourceText: segment.sourceText,
      sourceLocale: segment.document.sourceLocale,
      targetLocale: segment.document.targetLocale,
      projectId: segment.document.projectId,
      limit: ragLimit,
      minScore: ragMinScore,
      vectorSimilarity: ragVectorSimilarity,
      mode: ragMode,
      useVectorSearch: ragUseVectorSearch,
    });

    tmExamples = exampleMatches.map((match) => ({
      sourceText: match.sourceText,
      targetText: match.targetText,
      fuzzyScore: match.fuzzyScore,
      searchMethod: match.searchMethod || 'fuzzy',
    }));
  }

  // In critic mode, always generate fresh AI translation (don't use TM matches directly)
  // TM examples are still used for RAG, but we always generate a complete translation
  // This ensures the translation is complete and accurate, not just a partial TM match
  logger.info(
    { segmentId: segment.id },
    'Critic mode: Generating fresh AI translation (TM examples used for RAG only)',
  );

  // Always use full critic workflow with AI translation
  // TM examples are passed for RAG context, but we don't use TM matches directly
  // Log context for debugging YandexGPT
  if (context.settings?.provider?.toLowerCase() === 'yandex') {
    logger.debug({
      provider: context.settings?.provider,
      hasApiKey: !!context.apiKey,
      apiKeyLength: context.apiKey?.length ?? 0,
      hasYandexFolderId: !!context.yandexFolderId,
      yandexFolderIdLength: context.yandexFolderId?.length ?? 0,
      sourceLocale: segment.document.sourceLocale,
      targetLocale: segment.document.targetLocale,
    }, 'YandexGPT: Starting translation with critic workflow');
  }
  
  // Filter glossary by document context first
  const documentContext: DocumentContext = {
    projectDomain: context.projectMeta.domain,
    projectClient: context.projectMeta.client,
    documentName: segment.document.name,
    documentType: undefined,
  };
  // Get relevant glossary entries using vector search + strict filtering (Hybrid Approach)
  const filteredGlossary = await getRelevantGlossaryEntries(
    segment.sourceText,
    segment.document.sourceLocale,
    segment.document.targetLocale,
    segment.document.projectId,
    documentContext,
  );

  // Stage 2: Fetch document-specific context from Analyst Stage (unless ignoreContext is true)
  let documentStyleRules: Array<{ ruleType: string; pattern: string; description: string | null; examples: any }> = [];
  let documentGlossary: Array<{ sourceTerm: string; targetTerm: string; status: string; occurrenceCount: number }> = [];
  
  if (!options?.ignoreContext) {
    documentStyleRules = await getDocumentStyleRules(segment.document.id);
    documentGlossary = await getDocumentGlossaryForSegment(segment.document.id, segment.sourceText);
    
    logger.debug(
      {
        segmentId: segment.id,
        documentId: segment.document.id,
        documentGlossaryCount: documentGlossary.length,
        documentStyleRulesCount: documentStyleRules.length,
      },
      'Stage 2: Document context fetched for single segment translation',
    );
  } else {
    logger.info(
      { segmentId: segment.id },
      'Blind translation mode: Skipping document context (ignoreContext=true)',
    );
  }

  // Calculate dynamic maxTokens based on source text length
  // Rule of thumb: 1 token ≈ 4 characters, translation needs 2-3x input tokens
  // Add buffer for prompt, glossary, examples, etc.
  const sourceTextLength = segment.sourceText.length;
  const estimatedInputTokens = Math.ceil(sourceTextLength / 4);
  // Translation typically needs 1.5-2x input tokens, plus buffer for prompt/context
  const calculatedMaxTokens = Math.max(
    Math.ceil(estimatedInputTokens * 2.5) + 1000, // 2.5x for translation + 1000 for prompt/context
    context.settings?.maxTokens ?? 2048 // Minimum 2048 (increased from 1024)
  );
  // Cap at reasonable maximum (8192 for most models, 32768 for larger models)
  const maxTokens = Math.min(calculatedMaxTokens, 8192);

  logger.info({
    provider: context.settings?.provider,
    model: context.settings?.model,
    sourceTextLength,
    estimatedInputTokens,
    calculatedMaxTokens,
    finalMaxTokens: maxTokens,
    source: 'translateSegment:before-translateWithCritic',
  }, 'translateSegment: Calling translateWithCritic with dynamic maxTokens');

  // Fetch document with summary and Document DNA for context
  const documentWithSummary = await prisma.document.findUnique({
    where: { id: segment.document.id },
    select: {
      name: true,
      summary: true,
      clusterSummary: true,
      documentDna: {
        select: {
          technicalSchema: true,
          namingConventions: true,
          abbreviationLogic: true,
          entityGroups: true,
        },
      },
    },
  });

  const documentDnaPayload = documentWithSummary
    ? await effectiveDnaForPrismaInclude(segment.document.projectId, documentWithSummary.documentDna)
    : null;

  const aiResult = await orchestrator.translateWithCritic(
    buildOrchestratorSegment(segment, previous, next, segment.document.name),
    {
      provider: context.settings?.provider,
      model: context.settings?.model,
      apiKey: context.apiKey,
      yandexFolderId: context.yandexFolderId,
      glossary: filteredGlossary,
      guidelines: context.guidelines,
      tmExamples, // TM examples used for RAG, but we always generate fresh translation
      project: context.projectMeta,
      document: documentWithSummary ? {
        name: documentWithSummary.name,
        summary: documentWithSummary.summary ?? undefined,
        clusterSummary: documentWithSummary.clusterSummary ?? undefined,
      } : undefined,
      documentDna: documentDnaPayload ?? undefined,
      sourceLocale: segment.document.sourceLocale, // Pass explicit source locale from document
      targetLocale: segment.document.targetLocale, // Pass explicit target locale from document
      temperature: options?.temperature ?? context.settings?.temperature ?? getDefaultTemperature(context.settings?.provider),
      maxTokens,
      glossaryMode,
      // Stage 2: Document-specific context (only if not ignoring context)
      documentGlossary: !options?.ignoreContext && documentGlossary.length > 0 ? documentGlossary : undefined,
      documentStyleRules: !options?.ignoreContext && documentStyleRules.length > 0 ? documentStyleRules : undefined,
      documentId: segment.document.id,
    },
    onProgress,
  );

  let translationText = aiResult.targetText;
  const fuzzyScore = Math.round((aiResult.confidence ?? 0.95) * 100);
  const bestTmEntryId = null; // Not using TM match directly in critic mode

  if (!translationText) {
    translationText = segment.sourceText;
  } else {
    translationText = ensureLeadingSectionFromSegment(translationText, segment.sourceText);
  }

  const updatedSegment = await prisma.segment.update({
    where: { id: segmentId },
    data: {
      targetMt: translationText,
      fuzzyScore,
      bestTmEntryId,
      status: 'MT',
      ...(aiResult && {
        mtFullPrompt: aiResult.fullPrompt ?? undefined,
        mtAnalysis: aiResult.analysis ?? undefined,
      }),
    },
    include: { document: true },
  });

  // Add model information to the response (extend the segment object)
  return {
    ...updatedSegment,
    // Add model info as metadata (not stored in DB, but returned in API)
    _metadata: {
      provider: aiResult.provider,
      model: aiResult.model,
      usage: aiResult.usage,
      fullPrompt: aiResult.fullPrompt,
      analysis: aiResult.analysis,
    },
  } as typeof updatedSegment & { _metadata: { provider: string; model: string; usage?: any; fullPrompt?: string; analysis?: string } };
};

export const runDocumentMachineTranslation = async (
  documentId: string,
  mode: 'translate_all' | 'pre_translate',
  options?: MachineTranslationOptions & { mtOnlyEmpty?: boolean },
) => {
  // Clear any previous cancellation flag for this document
  clearBatchTranslationCancellation(documentId);

  // Check if embedding generation might be running (optimization warning)
  logger.warn(
    { documentId },
    'Batch translation started. If embedding generation is running concurrently, performance may be degraded.',
  );

  const document = await prisma.document.findUnique({
    where: { id: documentId },
    include: {
      segments: {
        orderBy: { segmentIndex: 'asc' },
        select: { 
          id: true, 
          sourceText: true, 
          segmentIndex: true, 
          targetMt: true, 
          targetFinal: true,
          status: true, // Include status for rewriteNonConfirmed check
        },
      },
    },
  });
  if (!document) {
    throw ApiError.notFound('Document not found');
  }

  // Robust empty check: A segment is "empty" if:
  // - targetText is null/undefined
  // - targetText is empty string ""
  // - targetText is just whitespace (trim() === '')
  // If rewriteNonConfirmed is true, ignore text and check status (non-CONFIRMED)
  const isSegmentEmpty = (segment: { targetMt: string | null; targetFinal: string | null; status: string }): boolean => {
    const targetText = segment.targetFinal || segment.targetMt;
    if (!targetText) return true;
    if (targetText.trim() === '') return true;
    return false;
  };

  const eligibleSegments = document.segments.filter((segment) => {
    if (mode === 'translate_all') {
      return true;
    }
    
    // If rewriteNonConfirmed is enabled, check status instead of text
    if (options?.rewriteNonConfirmed) {
      // Include segments that are not CONFIRMED (NEW, MT, EDITED)
      return segment.status !== 'CONFIRMED';
    }
    
    if (options?.mtOnlyEmpty) {
      // Robust empty check: handle null, empty string, and whitespace
      return isSegmentEmpty(segment);
    }
    
    if (options?.mtOnlyNonEmpty) {
      // Only translate segments that are NOT empty
      return !isSegmentEmpty(segment);
    }
    
    // Default: check if targetFinal is empty (robust check)
    return isSegmentEmpty({ targetMt: segment.targetMt, targetFinal: segment.targetFinal, status: segment.status });
  });

  if (eligibleSegments.length === 0) {
    return { documentId, processed: 0, results: [] };
  }

  // Check for cancellation before proceeding
  if (isBatchTranslationCancelled(documentId)) {
    logger.info({ documentId }, 'Batch translation cancelled before processing');
    clearBatchTranslationCancellation(documentId);
    return { documentId, processed: 0, results: [] };
  }

  const context = await buildAiContext(
    document.projectId,
    document.sourceLocale,
    document.targetLocale,
  );
  const tmAllowed = options?.applyTm ?? true;
  const minScore = options?.minScore ?? 70;
  const glossaryMode = options?.glossaryMode ?? 'strict_source'; // Default to strict_source if not provided
  const useCritic = options?.useCritic ?? false;
  
  // Log settings for debugging
  logger.info({
    documentId,
    mode,
    glossaryMode,
    useCritic,
    rewriteNonConfirmed: options?.rewriteNonConfirmed,
  }, 'Using settings for document translation');

  const updates: Prisma.PrismaPromise<unknown>[] = [];
  const queuedForAI: { segment: typeof eligibleSegments[number]; previous?: typeof eligibleSegments[number]; next?: typeof eligibleSegments[number] }[] =
    [];
  const responseLog: Array<{ segmentId: string; targetMt: string | null }> = [];

  for (let i = 0; i < eligibleSegments.length; i += 1) {
    // Check for cancellation during loop
    if (isBatchTranslationCancelled(documentId)) {
      logger.info({ documentId, processedSoFar: i }, 'Batch translation cancelled during TM matching');
      break;
    }

    const segment = eligibleSegments[i];
    const neighbors = {
      previous: i > 0 ? eligibleSegments[i - 1] : undefined,
      next: i < eligibleSegments.length - 1 ? eligibleSegments[i + 1] : undefined,
    };

    // For "retranslate" (mode === 'pre_translate' with mtOnlyEmpty), we want to force AI translation
    // Skip TM matching to ensure segments go to AI queue
    // This allows retranslating segments even if TM matches exist
    const shouldSkipTmForRetranslate = mode === 'pre_translate' && options?.mtOnlyEmpty;
    
    if (tmAllowed && !shouldSkipTmForRetranslate) {
      // eslint-disable-next-line no-await-in-loop
      const tmMatches = await searchTranslationMemory({
        sourceText: segment.sourceText,
        sourceLocale: document.sourceLocale,
        targetLocale: document.targetLocale,
        projectId: document.projectId,
        limit: 1,
        minScore,
      });
      const bestTm = tmMatches[0];
      if (bestTm) {
        updates.push(
          prisma.segment.update({
            where: { id: segment.id },
            data: {
              targetMt: bestTm.targetText,
              fuzzyScore: bestTm.fuzzyScore,
              bestTmEntryId: bestTm.id,
              status: 'MT',
            },
          }),
        );
        responseLog.push({ segmentId: segment.id, targetMt: bestTm.targetText });
        continue;
      }
    }

    // Segment has no TM match (or TM is disabled) - queue for AI translation
    queuedForAI.push({ segment, previous: neighbors.previous, next: neighbors.next });
  }

  if (queuedForAI.length > 0) {
    // Check for cancellation before AI processing
    if (isBatchTranslationCancelled(documentId)) {
      logger.info({ documentId }, 'Batch translation cancelled before AI processing');
      // Save any TM matches we already found
      if (updates.length > 0) {
        await prisma.$transaction(updates);
      }
      clearBatchTranslationCancellation(documentId);
      return {
        documentId,
        processed: responseLog.length,
        results: responseLog,
      };
    }

    if (useCritic) {
      // CRITIC MODE: Process each segment individually with 3-step workflow
      logger.info({ documentId, segmentCount: queuedForAI.length }, 'Using critic mode for batch translation');
      
      // Use p-limit to control concurrency (5 concurrent requests to avoid rate limits)
      const concurrencyLimit = 5;
      const limit = pLimit(concurrencyLimit);
      
      // Fetch document with summary fields (needed for critic mode)
      const documentWithSummary = await prisma.document.findUnique({
        where: { id: document.id },
        select: {
          name: true,
          summary: true,
          clusterSummary: true,
        },
      });

      // Process segments with critic mode
      const criticPromises = queuedForAI.map((entry) =>
        limit(async () => {
          // Check for cancellation before processing each segment
          if (isBatchTranslationCancelled(documentId)) {
            logger.info({ documentId, segmentId: entry.segment.id }, 'Batch translation cancelled, skipping segment');
            return null;
          }

          try {
            // Build orchestrator segment
            const orchestratorSegment = buildOrchestratorSegment(
              entry.segment,
              entry.previous,
              entry.next,
              document.name ?? undefined,
            );

            // Get TM examples for this segment (if TM is allowed)
            let tmExamples: TmExample[] = [];
            if (tmAllowed) {
              const exampleMatches = await scatterGatherTmSearch(
                entry.segment.sourceText,
                document.sourceLocale,
                document.targetLocale,
                document.projectId,
                {
                  limit: 5,
                  minScore: 50,
                  vectorSimilarity: 60,
                }
              );
              tmExamples = exampleMatches.map((match) => ({
                sourceText: match.sourceText,
                targetText: match.targetText,
                fuzzyScore: match.fuzzyScore,
                searchMethod: match.searchMethod || 'fuzzy',
              }));
            }

            // Filter glossary for this segment
            const documentContext: DocumentContext = {
              projectDomain: context.projectMeta.domain,
              projectClient: context.projectMeta.client,
              documentName: document.name,
              documentType: undefined,
            };
            const filteredGlossary = await getRelevantGlossaryEntries(
              entry.segment.sourceText,
              document.sourceLocale,
              document.targetLocale,
              document.projectId,
              documentContext,
            );

            // Get document-specific context for this segment
            const documentStyleRules = await getDocumentStyleRules(document.id);
            const documentGlossary = await getDocumentGlossaryForSegment(document.id, entry.segment.sourceText);

            // Calculate dynamic maxTokens
            const sourceTextLength = entry.segment.sourceText.length;
            const estimatedInputTokens = Math.ceil(sourceTextLength / 4);
            const calculatedMaxTokens = Math.max(
              Math.ceil(estimatedInputTokens * 2.5) + 1000,
              context.settings?.maxTokens ?? 2048
            );
            const maxTokens = Math.min(calculatedMaxTokens, 8192);

            // Call translateWithCritic for this segment
            const aiResult = await orchestrator.translateWithCritic(
              orchestratorSegment,
              {
                provider: context.settings?.provider,
                model: context.settings?.model,
                apiKey: context.apiKey,
                yandexFolderId: context.yandexFolderId,
                glossary: filteredGlossary,
                guidelines: context.guidelines,
                tmExamples,
                project: context.projectMeta,
                document: documentWithSummary ? {
                  name: documentWithSummary.name,
                  summary: documentWithSummary.summary ?? undefined,
                  clusterSummary: documentWithSummary.clusterSummary ?? undefined,
                } : undefined,
                sourceLocale: document.sourceLocale,
                targetLocale: document.targetLocale,
                temperature: context.settings?.temperature ?? getDefaultTemperature(context.settings?.provider),
                maxTokens,
                glossaryMode,
                documentGlossary: documentGlossary.length > 0 ? documentGlossary : undefined,
                documentStyleRules: documentStyleRules.length > 0 ? documentStyleRules : undefined,
                documentId: document.id,
              },
            );

            return {
              segmentId: entry.segment.id,
              targetText: aiResult?.targetText ?? entry.segment.sourceText,
              confidence: aiResult?.confidence ?? 0.85,
              fullPrompt: aiResult?.fullPrompt,
              analysis: aiResult?.analysis,
            };
          } catch (error: any) {
            logger.error(
              { documentId, segmentId: entry.segment.id, error: error?.message },
              'Error in critic mode translation for segment',
            );
            // Return fallback translation
            return {
              segmentId: entry.segment.id,
              targetText: entry.segment.sourceText,
              confidence: 0.5,
            };
          }
        }),
      );

      // Wait for all critic translations to complete
      const criticResults = await Promise.all(criticPromises);

      // Process results and add to updates
      criticResults.forEach((result) => {
        if (!result) return; // Skipped due to cancellation
        const { segmentId, targetText, confidence, fullPrompt, analysis } = result;
        updates.push(
          prisma.segment.update({
            where: { id: segmentId },
            data: {
              targetMt: targetText,
              fuzzyScore: Math.round(confidence * 100),
              bestTmEntryId: null,
              status: 'MT',
              ...(fullPrompt !== undefined && { mtFullPrompt: fullPrompt }),
              ...(analysis !== undefined && { mtAnalysis: analysis }),
            },
          }),
        );
        responseLog.push({ segmentId, targetMt: targetText });
      });
    } else {
      // STANDARD MODE: List-aware batching — group list blocks (lead-in + items), then process per unit
      const examplePromises = queuedForAI.map(async (entry) => {
        if (!tmAllowed) {
          return { segmentId: entry.segment.id, examples: [] };
        }
        const exampleMatches = await scatterGatherTmSearch(
          entry.segment.sourceText,
          document.sourceLocale,
          document.targetLocale,
          document.projectId,
          { limit: 5, minScore: 50, vectorSimilarity: 60 },
        );
        const examples: TmExample[] = exampleMatches.map((match) => ({
          sourceText: match.sourceText,
          targetText: match.targetText,
          fuzzyScore: match.fuzzyScore,
          searchMethod: match.searchMethod || 'fuzzy',
        }));
        return { segmentId: entry.segment.id, examples };
      });

      const exampleResults = await Promise.all(examplePromises);
      const examplesMap = new Map(exampleResults.map((r) => [r.segmentId, r.examples]));

      const translationUnits = buildTranslationUnits(queuedForAI);
      logger.debug(
        { documentId, unitCount: translationUnits.length, segmentCount: queuedForAI.length },
        'List-aware translation units built',
      );

      const documentContext: DocumentContext = {
        projectDomain: context.projectMeta.domain,
        projectClient: context.projectMeta.client,
        documentName: document.name,
        documentType: undefined,
      };

      const documentWithSummary = await prisma.document.findUnique({
        where: { id: document.id },
        select: {
          name: true,
          summary: true,
          clusterSummary: true,
          documentDna: {
            select: {
              technicalSchema: true,
              namingConventions: true,
              abbreviationLogic: true,
              entityGroups: true,
            },
          },
        },
      });

      const documentDnaPayloadBatch = await effectiveDnaForPrismaInclude(
        document.projectId,
        documentWithSummary?.documentDna ?? null,
      );

      const documentStyleRules = await getDocumentStyleRules(document.id);
      const documentGlossaryMap = new Map<string, { sourceTerm: string; targetTerm: string; status: string; occurrenceCount: number }>();
      for (const entry of queuedForAI) {
        const matchingTerms = await getDocumentGlossaryForSegment(document.id, entry.segment.sourceText);
        for (const term of matchingTerms) {
          const existing = documentGlossaryMap.get(term.sourceTerm);
          if (!existing || term.status === 'PREFERRED' || (term.status === 'CANDIDATE' && existing.status !== 'PREFERRED')) {
            documentGlossaryMap.set(term.sourceTerm, term);
          }
        }
      }
      const documentGlossary = Array.from(documentGlossaryMap.values())
        .sort((a, b) => {
          const statusPriority = { PREFERRED: 3, CANDIDATE: 2, DEPRECATED: 1 };
          const aPriority = statusPriority[a.status as keyof typeof statusPriority] || 0;
          const bPriority = statusPriority[b.status as keyof typeof statusPriority] || 0;
          if (aPriority !== bPriority) return bPriority - aPriority;
          return b.occurrenceCount - a.occurrenceCount;
        })
        .slice(0, 20)
        .filter(term => term.status !== 'DEPRECATED');

      for (let u = 0; u < translationUnits.length; u += 1) {
        if (isBatchTranslationCancelled(documentId)) {
          logger.info({ documentId }, 'Batch translation cancelled before AI batch call');
          if (updates.length > 0) await prisma.$transaction(updates);
          clearBatchTranslationCancellation(documentId);
          return { documentId, processed: responseLog.length, results: responseLog };
        }

        const unit = translationUnits[u];
        const orchestratorSegments = unit.map((entry) =>
          buildOrchestratorSegment(entry.segment, entry.previous, entry.next, document.name ?? undefined),
        );
        const combinedSourceText = orchestratorSegments.map((s) => s.sourceText).join(' ');
        let filteredGlossary = await getRelevantGlossaryEntries(
          combinedSourceText,
          document.sourceLocale,
          document.targetLocale,
          document.projectId,
          documentContext,
        );
        const dnaGlossaryEntriesBatch = getGlossaryEntriesFromDnaInSource(
          combinedSourceText,
          documentDnaPayloadBatch?.abbreviationLogic as Record<string, unknown> | null | undefined,
        );
        if (dnaGlossaryEntriesBatch.length > 0) {
          const existingTerms = new Set(filteredGlossary.map((e) => e.term));
          for (const e of dnaGlossaryEntriesBatch) {
            if (!existingTerms.has(e.term)) {
              filteredGlossary = [...filteredGlossary, e];
              existingTerms.add(e.term);
            }
          }
        }
        const batchExamples = examplesMap.get(unit[0].segment.id) ?? [];

        const aiResults = await orchestrator.translateSegments({
          provider: context.settings?.provider,
          model: context.settings?.model,
          apiKey: context.apiKey,
          yandexFolderId: context.yandexFolderId,
          segments: orchestratorSegments,
          document: documentWithSummary ? {
            name: documentWithSummary.name,
            summary: documentWithSummary.summary ?? undefined,
            clusterSummary: documentWithSummary.clusterSummary ?? undefined,
          } : undefined,
          documentDna: documentDnaPayloadBatch ?? undefined,
          glossary: filteredGlossary,
          guidelines: context.guidelines,
          tmExamples: batchExamples,
          project: context.projectMeta,
          sourceLocale: document.sourceLocale,
          targetLocale: document.targetLocale,
          temperature: context.settings?.temperature ?? getDefaultTemperature(context.settings?.provider),
          maxTokens: context.settings?.maxTokens ?? 1024,
          glossaryMode,
          documentGlossary: documentGlossary.length > 0 ? documentGlossary : undefined,
          documentStyleRules: documentStyleRules.length > 0 ? documentStyleRules : undefined,
          documentId: document.id,
        });

        const resultMap = new Map(aiResults.map((result) => [result.segmentId, result]));
        unit.forEach((entry) => {
          const aiResult = resultMap.get(entry.segment.id);
          const targetText = aiResult?.targetText ?? entry.segment.sourceText;
          updates.push(
            prisma.segment.update({
              where: { id: entry.segment.id },
              data: {
                targetMt: targetText,
                fuzzyScore: aiResult ? Math.round((aiResult.confidence ?? 0.85) * 100) : null,
                bestTmEntryId: null,
                status: 'MT',
                ...(aiResult && {
                  mtFullPrompt: aiResult.fullPrompt ?? undefined,
                  mtAnalysis: aiResult.analysis ?? undefined,
                }),
              },
            }),
          );
          responseLog.push({ segmentId: entry.segment.id, targetMt: targetText });
        });
      }
    }
  }

  // Check for cancellation one final time
  if (isBatchTranslationCancelled(documentId)) {
    logger.info({ documentId, processed: responseLog.length }, 'Batch translation cancelled, saving partial results');
  }

  if (updates.length > 0) {
    await prisma.$transaction(updates);
  }

  // Clear cancellation flag on completion
  clearBatchTranslationCancellation(documentId);

  return {
    documentId,
    processed: responseLog.length,
    results: responseLog,
  };
};

export const pretranslateDocument = async (
  documentId: string,
  options?: {
    applyAiToLowMatches?: boolean; // Apply AI to segments with < 100% matches
    applyAiToEmptyOnly?: boolean; // Apply AI only to empty segments (no matches at all)
    rewriteConfirmed?: boolean; // Rewrite confirmed segments
    rewriteNonConfirmed?: boolean; // Rewrite non-confirmed but not empty segments
    glossaryMode?: GlossaryMode; // Glossary enforcement mode
    useCritic?: boolean; // Use critic AI workflow for higher quality (slower)
    provider?: string; // Override project AI provider
    model?: string; // Override project AI model
    temperature?: number; // Override AI temperature
    skipTm?: boolean; // Skip Phase 1 (TM matching)
  },
) => {
  const glossaryMode = options?.glossaryMode ?? 'strict_source'; // Default to strict_source if not provided
  
  // Log glossary mode for debugging
  logger.info({
    documentId,
    glossaryMode,
  }, 'Using glossary mode for pretranslation');
  const { createProgress, updateProgress, addResult, completeProgress, cancelProgress, isCancelled, setError, clearProgress, addLogMessage } = await import('./pretranslateProgress');
  
  // Clear any old progress/cancellation flags before starting
  // Note: This is a redundant clear (also done in route handler) but ensures clean state
  clearProgress(documentId);

  const document = await prisma.document.findUnique({
    where: { id: documentId },
    include: {
      segments: {
        orderBy: { segmentIndex: 'asc' },
        select: {
          id: true,
          sourceText: true,
          segmentIndex: true,
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

  // Filter segments based on options
  const excludedByEligibility: { segmentIndex: number; segmentId: string; isEmpty: boolean; isConfirmed: boolean; reason: string }[] = [];
  const eligibleSegments = document.segments.filter((segment) => {
    const isEmpty = !segment.targetFinal && !segment.targetMt;
    const isConfirmed = segment.status === 'CONFIRMED';
    const isNonConfirmedButNotEmpty = !isEmpty && !isConfirmed;

    // Always include empty segments
    if (isEmpty) {
      return true;
    }

    // Include confirmed segments if rewriteConfirmed is true
    if (isConfirmed && options?.rewriteConfirmed) {
      return true;
    }

    // Include non-confirmed but not empty segments if rewriteNonConfirmed is true
    if (isNonConfirmedButNotEmpty && options?.rewriteNonConfirmed) {
      return true;
    }

    // Otherwise exclude – record for debug
    const reason = isConfirmed ? 'confirmed_rewrite_disabled' : 'has_target_rewrite_non_confirmed_disabled';
    excludedByEligibility.push({
      segmentIndex: segment.segmentIndex,
      segmentId: segment.id,
      isEmpty,
      isConfirmed,
      reason,
    });
    return false;
  });

  // Declare variables outside try block so they're accessible in catch
  // Smaller batch size = more frequent saves = better preservation on cancellation
  const SAVE_BATCH_SIZE = 5;
  let pendingUpdates: Prisma.PrismaPromise<unknown>[] = [];
  let lastProgressUpdate = 0;
  const responseLog: Array<{
    segmentId: string;
    method: 'tm' | 'ai';
    targetMt: string | null;
    fuzzyScore?: number;
  }> = [];

  // Build AI context first to get configuration info
  const context = await buildAiContext(
    document.projectId,
    document.sourceLocale,
    document.targetLocale,
  );
  
  // Use overrides if provided, otherwise use project settings
  const effectiveProvider = options?.provider || context.settings?.provider;
  const effectiveModel = options?.model || context.settings?.model;
  const effectiveTemperature = options?.temperature !== undefined 
    ? options.temperature 
    : (context.settings?.temperature ?? getDefaultTemperature(effectiveProvider || 'gemini'));
  
  // Check if AI is properly configured
  const hasAiConfig = context.settings || (options?.provider && options?.model);
  const hasApiKey = !!context.apiKey || (effectiveProvider === 'yandex' && !!context.yandexFolderId);
  
  // Initialize progress tracking with AI configuration info
  // This ensures progress exists even if there are no segments to process
  createProgress(documentId, eligibleSegments.length, {
    provider: effectiveProvider,
    model: effectiveModel,
    configured: hasAiConfig && hasApiKey,
  });

  if (eligibleSegments.length === 0) {
    // Mark as completed immediately if no segments to process
    addLogMessage(documentId, 'ℹ️ No segments to process - all segments are already translated');
    completeProgress(documentId);
    return {
      documentId,
      tmApplied: 0,
      aiApplied: 0,
      totalProcessed: 0,
      results: [],
    };
  }

  // Log AI configuration status (only if we have segments to process)
  if (eligibleSegments.length > 0) {
    if (hasAiConfig && hasApiKey) {
      addLogMessage(documentId, `✅ AI configured: ${effectiveProvider} / ${effectiveModel}`);
    } else if (hasAiConfig && !hasApiKey) {
      addLogMessage(documentId, `⚠️ AI provider/model set but API key missing. AI translations will be skipped.`);
    } else {
      addLogMessage(documentId, `ℹ️ AI not configured. Only TM matches will be applied.`);
    }
    
    addLogMessage(documentId, `🚀 Starting pretranslation: ${eligibleSegments.length} segments to process`);
  }

  try {
    
    // Validate that we have required AI configuration
    if (!effectiveProvider || !effectiveModel) {
      logger.warn({
        documentId,
        hasOverrideProvider: !!options?.provider,
        hasOverrideModel: !!options?.model,
        hasProjectProvider: !!context.settings?.provider,
        hasProjectModel: !!context.settings?.model,
      }, 'Missing AI configuration - cannot perform AI translations');
    }
    
    // Log AI configuration for pretranslation
    logger.info({
      documentId,
      provider: effectiveProvider || 'not configured',
      model: effectiveModel || 'not configured',
      temperature: effectiveTemperature,
      glossaryMode,
      useCritic: options?.useCritic ?? false,
      hasApiKey: !!context.apiKey,
      hasYandexFolderId: !!context.yandexFolderId,
      usingOverride: {
        provider: !!options?.provider,
        model: !!options?.model,
        temperature: options?.temperature !== undefined,
      },
    }, 'Pretranslation starting - AI configuration');
    
    // Store effective values for use in nested scopes
    const aiConfig = {
      provider: effectiveProvider,
      model: effectiveModel,
      temperature: effectiveTemperature,
    };
    
    const queuedForAI: {
      segment: typeof eligibleSegments[number];
      previous?: typeof eligibleSegments[number];
      next?: typeof eligibleSegments[number];
    }[] = [];

    // Step 1: Apply 100% TM matches (skip if skipTm is true)
    if (!options?.skipTm) {
      // Update progress to show we're in Phase 1 (TM Matching)
      updateProgress(documentId, {
        currentPhase: 'tm_matching',
      });
      addLogMessage(documentId, `🚀 Starting Pass 1: Scanning ${eligibleSegments.length} segments for 100% TM matches...`);
      for (let i = 0; i < eligibleSegments.length; i += 1) {
      const segment = eligibleSegments[i];
      
      // Update progress less frequently to prevent UI jumping (every 5 segments or on important milestones)
      const shouldUpdateProgress = i === 0 || i === eligibleSegments.length - 1 || (i - lastProgressUpdate) >= 5;
      if (shouldUpdateProgress) {
        updateProgress(documentId, {
          currentSegment: i + 1,
          currentSegmentId: segment.id,
          currentSegmentText: segment.sourceText.substring(0, 100) + (segment.sourceText.length > 100 ? '...' : ''),
        });
        lastProgressUpdate = i;
      }

      // Check for cancellation AFTER updating progress but BEFORE processing
      // This ensures we save any pending updates before stopping
      const cancelledBeforeProcessing = isCancelled(documentId);
      if (cancelledBeforeProcessing) {
        // Save any pending updates before cancelling
        if (pendingUpdates.length > 0) {
          await prisma.$transaction(pendingUpdates);
          pendingUpdates = [];
        }
        // Don't throw immediately - break out of loop to process queued segments
        break; // Exit loop to allow processing of queued segments
      }

      // eslint-disable-next-line no-await-in-loop
      const tmMatches = await searchTranslationMemory({
        sourceText: segment.sourceText,
        sourceLocale: document.sourceLocale,
        targetLocale: document.targetLocale,
        projectId: document.projectId,
        limit: 1,
        minScore: 100, // Only 100% matches
      });

      const perfectMatch = tmMatches[0];
      if (perfectMatch && perfectMatch.fuzzyScore === 100) {
        const substituted = applyTmMatchWithNumberSubstitution(
          perfectMatch.targetText,
          perfectMatch.sourceText,
          segment.sourceText,
          document.targetLocale,
        );
        const rawTarget = substituted.applied ? substituted.result : perfectMatch.targetText;
        const targetToApply = ensureLeadingSectionFromSegment(rawTarget, segment.sourceText);
        pendingUpdates.push(
          prisma.segment.update({
            where: { id: segment.id },
            data: {
              targetMt: targetToApply,
              targetFinal: targetToApply,
              fuzzyScore: 100,
              bestTmEntryId: perfectMatch.id && perfectMatch.id !== 'linked-' && !perfectMatch.id.startsWith('linked-') ? perfectMatch.id : null,
              status: 'MT',
            },
          }),
        );
        const result = {
          segmentId: segment.id,
          method: 'tm' as const,
          targetMt: targetToApply,
          fuzzyScore: 100,
        };
        responseLog.push(result);
        addResult(documentId, result);
        // Log TM match (but not every single one to avoid spam - log every 10th or important ones)
        if (responseLog.filter((r) => r.method === 'tm').length % 10 === 0 || i === 0 || i === eligibleSegments.length - 1) {
          addLogMessage(documentId, `✅ Applied 100% TM match to Segment #${i + 1} (${responseLog.filter((r) => r.method === 'tm').length} total)`);
        }

        // Save updates immediately to preserve progress on cancellation
        // Save in small batches to balance performance and safety
        if (pendingUpdates.length >= SAVE_BATCH_SIZE) {
          await prisma.$transaction(pendingUpdates);
          pendingUpdates = [];
          // Update progress only after successful save so UI/export never show a count higher than what's in DB
          const currentTmCount = responseLog.filter((r) => r.method === 'tm').length;
          updateProgress(documentId, { tmApplied: currentTmCount, currentSegment: responseLog.length });
        }
        
        // Also check for cancellation after saving to ensure we stop promptly
        if (isCancelled(documentId)) {
          // Save any remaining pending updates before cancelling
          if (pendingUpdates.length > 0) {
            await prisma.$transaction(pendingUpdates);
            pendingUpdates = [];
          }
        // Don't throw immediately - break out of loop to process queued segments
        break; // Exit loop to allow processing of queued segments
        }

        // Update progress at end of loop only when nothing is left pending (so count reflects what's actually saved)
        if (pendingUpdates.length === 0) {
          const currentTmCount = responseLog.filter((r) => r.method === 'tm').length;
          updateProgress(documentId, { tmApplied: currentTmCount, currentSegment: responseLog.length });
        }
      } else {
        // No 100% match - try high fuzzy (90%+) with number substitution so "94% differs only by numbers" gets correct target
        let usedHighFuzzySubstitution = false;
        const highFuzzyMatches = await searchTranslationMemory({
          sourceText: segment.sourceText,
          sourceLocale: document.sourceLocale,
          targetLocale: document.targetLocale,
          projectId: document.projectId,
          limit: 1,
          minScore: 90,
        });
        const highMatch = highFuzzyMatches[0];
        if (highMatch && highMatch.fuzzyScore >= 90) {
          const substituted = applyTmMatchWithNumberSubstitution(
            highMatch.targetText,
            highMatch.sourceText,
            segment.sourceText,
            document.targetLocale,
          );
          if (substituted.applied) {
            const targetToApply = ensureLeadingSectionFromSegment(substituted.result, segment.sourceText);
            pendingUpdates.push(
              prisma.segment.update({
                where: { id: segment.id },
                data: {
                  targetMt: targetToApply,
                  targetFinal: targetToApply,
                  fuzzyScore: highMatch.fuzzyScore,
                  bestTmEntryId: highMatch.id && highMatch.id !== 'linked-' && !String(highMatch.id).startsWith('linked-') ? highMatch.id : null,
                  status: 'MT',
                },
              }),
            );
            responseLog.push({ segmentId: segment.id, method: 'tm' as const, targetMt: targetToApply, fuzzyScore: highMatch.fuzzyScore });
            addResult(documentId, { segmentId: segment.id, method: 'tm' as const, targetMt: targetToApply, fuzzyScore: highMatch.fuzzyScore });
            usedHighFuzzySubstitution = true;
            if (responseLog.filter((r) => r.method === 'tm').length % 10 === 0 || i === 0 || i === eligibleSegments.length - 1) {
              addLogMessage(documentId, `✅ Applied ${highMatch.fuzzyScore}% TM match (numbers adjusted) to Segment #${i + 1}`);
            }
            if (pendingUpdates.length >= SAVE_BATCH_SIZE) {
              await prisma.$transaction(pendingUpdates);
              pendingUpdates = [];
              const currentTmCount = responseLog.filter((r) => r.method === 'tm').length;
              updateProgress(documentId, { tmApplied: currentTmCount, currentSegment: responseLog.length });
            }
            if (pendingUpdates.length === 0) {
              const currentTmCount = responseLog.filter((r) => r.method === 'tm').length;
              updateProgress(documentId, { tmApplied: currentTmCount, currentSegment: responseLog.length });
            }
            if (isCancelled(documentId)) {
              if (pendingUpdates.length > 0) {
                await prisma.$transaction(pendingUpdates);
                pendingUpdates = [];
              }
              break;
            }
          }
        }
        if (!usedHighFuzzySubstitution) {
          // No 100% and no high-fuzzy+substitution - check if we should queue for AI
          const hasLowMatch = tmMatches.length > 0 && tmMatches[0].fuzzyScore < 100;
          const hasNoMatch = tmMatches.length === 0;
          // applyAiToEmptyOnly: queue when segment is still empty after TM (no 100% or 90%+ applied) = no match or low match only
          const shouldApplyAI =
            (options?.applyAiToLowMatches && (hasLowMatch || hasNoMatch)) ||
            (options?.applyAiToEmptyOnly && (hasNoMatch || hasLowMatch));
          if (shouldApplyAI) {
            const neighbors = {
              previous: i > 0 ? eligibleSegments[i - 1] : undefined,
              next: i < eligibleSegments.length - 1 ? eligibleSegments[i + 1] : undefined,
            };
            queuedForAI.push({ segment, previous: neighbors.previous, next: neighbors.next });
          }
        }
      }
    }
    } else {
      // Skip TM matching - queue all eligible segments for AI translation
      addLogMessage(documentId, `⏭️ Skipping Phase 1 (TM matching). ${eligibleSegments.length} eligible segments will be sent directly to AI translation.`);
      
      // Queue all eligible segments for AI translation (they're already filtered by existing options)
      for (let i = 0; i < eligibleSegments.length; i += 1) {
        const segment = eligibleSegments[i];
        const neighbors = {
          previous: i > 0 ? eligibleSegments[i - 1] : undefined,
          next: i < eligibleSegments.length - 1 ? eligibleSegments[i + 1] : undefined,
        };
        queuedForAI.push({ segment, previous: neighbors.previous, next: neighbors.next });
      }
      
      // Update progress to show we're skipping TM phase and going directly to AI
      updateProgress(documentId, {
        currentPhase: 'ai_translation', // Skip directly to AI phase
        tmApplied: 0,
        currentSegment: eligibleSegments.length,
      });
    }

    // Save any remaining pending updates from TM matches before AI processing
    // This is critical - ensure all processed segments are saved before proceeding
    if (pendingUpdates.length > 0) {
      await prisma.$transaction(pendingUpdates);
      pendingUpdates = [];
      // Progress was only updated after batch flushes; update to final count now that all TM updates are saved
      const tmCount = responseLog.filter((r) => r.method === 'tm').length;
      updateProgress(documentId, { tmApplied: tmCount, currentSegment: responseLog.length });
    }

    const tmCount = responseLog.filter((r) => r.method === 'tm').length;
    if (!options?.skipTm) {
      addLogMessage(documentId, `✅ Pass 1 complete: ${tmCount} segments matched with 100% TM, ${queuedForAI.length} segments queued for AI`);
    } else {
      addLogMessage(documentId, `✅ Phase 1 skipped. ${queuedForAI.length} segments queued for AI translation.`);
    }
    
    // Final check for cancellation before starting AI translation
    // If cancelled but we have queued segments, process them first before stopping
    const wasCancelled = isCancelled(documentId);
    // Only throw if cancelled AND no segments to process
    if (wasCancelled && queuedForAI.length === 0) {
      throw new Error('Pretranslation cancelled by user');
    }

    // Step 2: Apply AI translations if requested
    // Allow AI translation if we have either project settings OR overrides provided
    // hasAiConfig is already declared above (line 2328), reuse it
    if (queuedForAI.length > 0 && hasAiConfig) {
      const useCritic = options?.useCritic ?? false;
      if (useCritic) {
        addLogMessage(documentId, `🤖 Starting Pass 2: Sending ${queuedForAI.length} segments to AI (Critic Mode - 3-step workflow)...`);
      } else {
        addLogMessage(documentId, `🤖 Starting Pass 2: Sending ${queuedForAI.length} segments to AI (Batch Mode)...`);
      }
      
      // Update progress to show we're starting AI translation phase
      // This ensures UI shows that AI processing has begun
      const tmCount = responseLog.filter((r) => r.method === 'tm').length;
      const currentAiCount = responseLog.filter((r) => r.method === 'ai').length; // Should be 0 at start of Phase 2
      updateProgress(documentId, {
        currentPhase: 'ai_translation', // Mark that we're now in AI translation phase
        currentSegmentText: `Starting AI translation for ${queuedForAI.length} segments...`,
        aiApplied: currentAiCount, // Show current count (0 at start, will update as segments complete)
        currentSegment: tmCount, // Total completed so far (TM only at this point)
      });
      
      if (useCritic) {
        // Process segments concurrently with critic AI (faster with controlled concurrency)
        // Use p-limit to control concurrency (5 concurrent requests to avoid rate limits)
        const concurrencyLimit = 5;
        const limit = pLimit(concurrencyLimit);
        
        logger.info({
          documentId,
          segmentsCount: queuedForAI.length,
          concurrencyLimit,
          mode: 'critic',
          provider: context.settings?.provider || 'not configured',
          model: context.settings?.model || 'not configured',
        }, 'Starting concurrent critic AI translation');

        // Track completed segments atomically to prevent progress jumping
        let completedCount = 0;
        const completedCountLock = { locked: false };

        // Helper function to handle rate limiting with retry
        const translateSegmentWithRetry = async (
          entry: typeof queuedForAI[number],
          retries = 3,
          baseDelay = 1000,
        ): Promise<{ segmentId: string; targetText: string; confidence?: number; fullPrompt?: string; analysis?: string } | null> => {
          // Check cancellation before starting AI call
          if (isCancelled(documentId)) {
            const segmentIndex = eligibleSegments.findIndex((s) => s.id === entry.segment.id) + 1;
            addLogMessage(documentId, `⏸️ Cancellation detected, skipping Segment #${segmentIndex}`);
            return null; // Skip this segment
          }
          
          for (let attempt = 0; attempt < retries; attempt++) {
            // Check cancellation before each attempt
            if (isCancelled(documentId)) {
              const segmentIndex = eligibleSegments.findIndex((s) => s.id === entry.segment.id) + 1;
              addLogMessage(documentId, `⏸️ Cancellation detected during retry attempt ${attempt + 1}, skipping Segment #${segmentIndex}`);
              return null;
            }
            
            try {
              // Filter glossary by document context first
              const documentContext: DocumentContext = {
                projectDomain: context.projectMeta.domain,
                projectClient: context.projectMeta.client,
                documentName: document.name,
                documentType: undefined,
              };
              // Get relevant glossary entries using vector search + strict filtering (Hybrid Approach)
              const filteredGlossary = await getRelevantGlossaryEntries(
                entry.segment.sourceText,
                document.sourceLocale,
                document.targetLocale,
                document.projectId,
                documentContext,
              );

              // Fetch document with summary and Document DNA
              const documentWithSummary = await prisma.document.findUnique({
                where: { id: document.id },
                select: {
                  name: true,
                  summary: true,
                  clusterSummary: true,
                  documentDna: {
                    select: {
                      technicalSchema: true,
                      namingConventions: true,
                      abbreviationLogic: true,
                      entityGroups: true,
                    },
                  },
                },
              });

              const documentDnaSingle = await effectiveDnaForPrismaInclude(
                document.projectId,
                documentWithSummary?.documentDna ?? null,
              );

              const orchestratorSegment = buildOrchestratorSegment(
                entry.segment,
                entry.previous,
                entry.next,
                document.name ?? undefined,
              );

              const aiResult = await orchestrator.translateWithCritic(
                orchestratorSegment,
                {
                  provider: aiConfig.provider,
                  model: aiConfig.model,
                  apiKey: context.apiKey,
                  yandexFolderId: context.yandexFolderId,
                  glossary: filteredGlossary,
                  guidelines: context.guidelines,
                  document: documentWithSummary ? {
                    name: documentWithSummary.name,
                    summary: documentWithSummary.summary ?? undefined,
                    clusterSummary: documentWithSummary.clusterSummary ?? undefined,
                  } : undefined,
                  documentDna: documentDnaSingle ?? undefined,
                  project: context.projectMeta,
                  sourceLocale: document.sourceLocale,
                  targetLocale: document.targetLocale,
                  temperature: aiConfig.temperature,
                  maxTokens: context.settings?.maxTokens ?? 1024,
                  glossaryMode,
                },
              );

              let targetText = aiResult?.targetText ?? entry.segment.sourceText;

              return {
                segmentId: entry.segment.id,
                targetText,
                confidence: aiResult?.confidence,
                fullPrompt: aiResult?.fullPrompt,
                analysis: aiResult?.analysis,
              };
            } catch (error: any) {
              // Check if it's a rate limit error (429)
              const isRateLimit = error?.status === 429 || 
                                  error?.response?.status === 429 ||
                                  error?.message?.toLowerCase().includes('rate limit') ||
                                  error?.message?.toLowerCase().includes('too many requests');
              
              if (isRateLimit && attempt < retries - 1) {
                // Exponential backoff: 1s, 2s, 4s
                const delay = baseDelay * Math.pow(2, attempt);
                const segmentIndex = eligibleSegments.findIndex((s) => s.id === entry.segment.id) + 1;
                addLogMessage(documentId, `⚠️ Rate limit hit for Segment #${segmentIndex}. Pausing for ${Math.round(delay / 1000)}s before retry ${attempt + 2}/${retries}...`);
                logger.warn({
                  segmentId: entry.segment.id,
                  attempt: attempt + 1,
                  retries,
                  delay,
                  error: error.message,
                }, 'Rate limit hit, retrying with exponential backoff');
                
                await new Promise(resolve => setTimeout(resolve, delay));
                continue; // Retry
              }
              
              // If not rate limit or out of retries, throw
              throw error;
            }
          }
          return null; // All retries exhausted
        };

        // Process all segments concurrently with rate limiting
        const promises = queuedForAI.map((entry, index) => {
          return limit(async () => {
            // Don't check cancellation here - let translateSegmentWithRetry handle it
            // This allows queued segments to be processed even if cancellation was detected
            // The translateSegmentWithRetry function will check cancellation and return null if needed

            try {
              const result = await translateSegmentWithRetry(entry);
              
              if (!result) {
                return null; // Cancelled or failed
              }

              let targetText = result.targetText ?? entry.segment.sourceText;
              if (result.targetText?.trim()) {
                targetText = ensureLeadingSectionFromSegment(result.targetText, entry.segment.sourceText);
              }
              // Add to pending updates (thread-safe - each promise adds to array)
              pendingUpdates.push(
                prisma.segment.update({
                  where: { id: result.segmentId },
                  data: {
                    targetMt: targetText,
                    targetFinal: targetText,
                    fuzzyScore: result.confidence ? Math.round(result.confidence * 100) : null,
                    bestTmEntryId: null,
                    status: 'MT',
                    ...(result.fullPrompt !== undefined && { mtFullPrompt: result.fullPrompt }),
                    ...(result.analysis !== undefined && { mtAnalysis: result.analysis }),
                  },
                }),
              );
              
              const logResult = {
                segmentId: result.segmentId,
                method: 'ai' as const,
                targetMt: targetText,
                fuzzyScore: result.confidence ? Math.round(result.confidence * 100) : undefined,
              };
              responseLog.push(logResult);
              addResult(documentId, logResult);

              // Update progress atomically when segment completes
              // Use a simple lock to prevent race conditions
              while (completedCountLock.locked) {
                await new Promise(resolve => setTimeout(resolve, 1));
              }
              completedCountLock.locked = true;
              
              try {
                completedCount++;
                const tmCount = responseLog.filter((r) => r.method === 'tm').length;
                const totalCompleted = tmCount + completedCount;
                const segmentIndex = eligibleSegments.findIndex((s) => s.id === entry.segment.id) + 1;
                
                // Update progress: currentSegment should be the total completed segments
                // This ensures it only increases, never decreases
                // Update aiApplied immediately to show real-time progress
                updateProgress(documentId, {
                  currentSegment: totalCompleted,
                  currentSegmentId: entry.segment.id,
                  currentSegmentText: entry.segment.sourceText.substring(0, 100) + (entry.segment.sourceText.length > 100 ? '...' : ''),
                  aiApplied: completedCount, // Update immediately after each segment completes
                });
                
                // Log completion (but not every single one to avoid spam - log every 5th or important ones)
                if (completedCount % 5 === 0 || completedCount === 1 || completedCount === queuedForAI.length) {
                  addLogMessage(documentId, `✅ Critic completed translation for Segment #${segmentIndex} (${completedCount}/${queuedForAI.length} AI segments done)`);
                }
              } finally {
                completedCountLock.locked = false;
              }

              return result;
            } catch (error) {
              logger.error({ 
                error, 
                segmentId: entry.segment.id,
                segmentIndex: index,
              }, 'Critic AI translation failed for segment');
              // Continue with next segment even if this one failed
              return null;
            }
          });
        });

        // Wait for all concurrent translations to complete
        const results = await Promise.all(promises);
        
        // Check for cancellation after all promises complete
        const cancelledAfterCritic = isCancelled(documentId);
        
        // CRITICAL: Save any pending updates (whether cancelled or not, save what we have)
        // This ensures all completed translations are preserved even if cancellation occurred
        if (pendingUpdates.length > 0) {
          logger.info({
            documentId,
            pendingUpdatesCount: pendingUpdates.length,
            wasCancelled: cancelledAfterCritic,
          }, 'Pretranslate: Saving pending updates after critic mode (cancellation may have occurred)');
          await prisma.$transaction(pendingUpdates);
          pendingUpdates = [];
          
          // Verify that translations were saved
          const savedCount = responseLog.filter((r) => r.method === 'ai').length;
          logger.info({
            documentId,
            savedTranslations: savedCount,
            wasCancelled: cancelledAfterCritic,
          }, 'Pretranslate: Verified AI translations saved after critic mode');
        }
        
        if (cancelledAfterCritic) {
          logger.info({ 
            documentId,
            completedTranslations: responseLog.filter((r) => r.method === 'ai').length,
          }, 'Pretranslation cancelled - stopping AI translation (critic mode), all completed translations saved');
          addLogMessage(documentId, `⏸️ Cancellation detected. All completed translations (${responseLog.filter((r) => r.method === 'ai').length} segments) have been saved.`);
          // Don't throw - exit gracefully to allow saving what was processed
          // Exit the if block - don't throw, let the code continue to final counts
        }

        // Final progress update (whether cancelled or not)
        // Use completedCount which was tracked atomically
        updateProgress(documentId, { 
          aiApplied: completedCount,
        });

        logger.info({
          documentId,
          totalSegments: queuedForAI.length,
          successful: results.filter(r => r !== null).length,
          failed: results.filter(r => r === null).length,
          wasCancelled: cancelledAfterCritic,
        }, 'Completed concurrent critic AI translation');
      } else {
        // Process AI translations in list-aware units (list blocks grouped, others single-segment)
        const translationUnits = buildTranslationUnits(queuedForAI);
        addLogMessage(documentId, `📦 Processing ${queuedForAI.length} segments in ${translationUnits.length} unit(s) (list-aware)...`);
        /** Segment Context Filter: session expandedTerms is cleared so each run starts fresh; orchestrator updates it after each batch. */
        orchestrator.clearSessionState(document.id);
        let introducedAbbreviations: string[] = [];
        const dnaForValidation = await getEffectiveDocumentDna(document.id);
        const dnaValidation = validateDocumentDnaPayload(dnaForValidation ?? null);
        const cycleCheck = validateDnaForCycles(dnaForValidation ?? null);
        
        // Расширенная валидация DNA-Contract-Validator
        const direction = getTranslationDirection(document.sourceLocale, document.targetLocale);
        const contractValidation = validateDnaContract(dnaForValidation ?? null, direction);
        
        if (!dnaValidation.valid) {
          const msg = `Invalid Document DNA: ${dnaValidation.errors.join('; ')}`;
          addLogMessage(documentId, `❌ ${msg}`);
          setError(documentId, msg);
        } else if (!cycleCheck.valid) {
          const msg = `Document DNA recursion risk: ${cycleCheck.errors.join('; ')}`;
          addLogMessage(documentId, `❌ ${msg}`);
          setError(documentId, msg);
        } else if (contractValidation.status === 'ERROR') {
          // Блокируем перевод при наличии ошибок в DNA-Contract-Validator
          const errorMessages = contractValidation.issues
            .filter(i => i.type === 'error')
            .map(i => i.message);
          const msg = `Document DNA validation failed: ${errorMessages.join('; ')}`;
          addLogMessage(documentId, `❌ ${msg}`);
          setError(documentId, msg);
        } else {
          // Предупреждения логируем, но не блокируем перевод
          if (contractValidation.status === 'WARNING') {
            const warnings = contractValidation.issues
              .filter(i => i.type === 'warning')
              .map(i => i.message);
            addLogMessage(documentId, `⚠️ DNA validation warnings: ${warnings.join('; ')}`);
            logger.warn({ documentId, validation: contractValidation }, 'Document DNA validation warnings');
          }
          const abbrevCount = dnaForValidation?.abbreviationLogic && typeof dnaForValidation.abbreviationLogic === 'object'
            ? Object.keys(dnaForValidation.abbreviationLogic).length
            : 0;
          logger.info({ documentId, abbreviationLogicKeys: abbrevCount, unitCount: translationUnits.length }, 'Pretranslate: DNA valid, starting list-aware unit translation');
        for (let u = 0; u < translationUnits.length; u += 1) {
          // Check for cancellation before each unit
          if (isCancelled(documentId)) {
            if (pendingUpdates.length > 0) {
              await prisma.$transaction(pendingUpdates);
              pendingUpdates = [];
            }
            console.log('Pretranslation cancelled - stopping AI translation unit processing');
            break;
          }

          const batch = translationUnits[u];
          const batchNumber = u + 1;
          const totalBatches = translationUnits.length;
          addLogMessage(documentId, `📦 Processing unit ${batchNumber}/${totalBatches} (${batch.length} segment(s))...`);
          
          const orchestratorSegments = batch.map((entry) =>
            buildOrchestratorSegment(entry.segment, entry.previous, entry.next, document.name ?? undefined),
          );
          
          // Update progress for AI batch - show that we're starting AI translation
          const aiStartIndex = eligibleSegments.findIndex((s) => s.id === batch[0].segment.id);
          const currentAiCountBeforeBatch = responseLog.filter((r) => r.method === 'ai').length;
          if (aiStartIndex >= 0) {
            updateProgress(documentId, {
              currentSegment: aiStartIndex + 1,
              currentSegmentId: batch[0].segment.id,
              currentSegmentText: batch[0].segment.sourceText.substring(0, 100) + (batch[0].segment.sourceText.length > 100 ? '...' : ''),
              aiApplied: currentAiCountBeforeBatch, // Show current count before processing this batch
            });
          }
          
          addLogMessage(documentId, `🤖 Starting AI translation for unit ${batchNumber}/${totalBatches} (${batch.length} segment(s))...`);

          // Filter glossary by document context first
          const documentContext: DocumentContext = {
            projectDomain: context.projectMeta.domain,
            projectClient: context.projectMeta.client,
            documentName: document.name,
            documentType: undefined,
          };
          // Get relevant glossary entries using vector search + strict filtering (Hybrid Approach)
          // For batch processing, use combined source text for vector search
          const combinedSourceText = orchestratorSegments.map(s => s.sourceText).join(' ');
          let filteredGlossary = await getRelevantGlossaryEntries(
            combinedSourceText,
            document.sourceLocale,
            document.targetLocale,
            document.projectId,
            documentContext,
          );

          // Fetch document with summary and Document DNA
          const documentWithSummary = await prisma.document.findUnique({
            where: { id: document.id },
            select: {
              name: true,
              summary: true,
              clusterSummary: true,
              documentDna: {
                select: {
                  technicalSchema: true,
                  namingConventions: true,
                  abbreviationLogic: true,
                  entityGroups: true,
                },
              },
            },
          });

          // Effective DNA (project defaults + document row) — same as single-segment translation path.
          const documentDnaPretranslate = await effectiveDnaForPrismaInclude(
            document.projectId,
            documentWithSummary?.documentDna ?? null,
          );

          // Stage 2: Fetch document-specific context from Analyst Stage
          const documentStyleRules = await getDocumentStyleRules(document.id);
          const documentGlossaryMap = new Map<string, { sourceTerm: string; targetTerm: string; status: string; occurrenceCount: number }>();
          
          for (const segment of orchestratorSegments) {
            const matchingTerms = await getDocumentGlossaryForSegment(document.id, segment.sourceText);
            for (const term of matchingTerms) {
              const existing = documentGlossaryMap.get(term.sourceTerm);
              if (!existing || term.status === 'PREFERRED' || (term.status === 'CANDIDATE' && existing.status !== 'PREFERRED')) {
                documentGlossaryMap.set(term.sourceTerm, term);
              }
            }
          }
          
          const documentGlossary = Array.from(documentGlossaryMap.values())
            .sort((a, b) => {
              const statusPriority = { PREFERRED: 3, CANDIDATE: 2, DEPRECATED: 1 };
              const aPriority = statusPriority[a.status as keyof typeof statusPriority] || 0;
              const bPriority = statusPriority[b.status as keyof typeof statusPriority] || 0;
              if (aPriority !== bPriority) return bPriority - aPriority;
              return b.occurrenceCount - a.occurrenceCount;
            })
            .slice(0, 20)
            .filter(term => term.status !== 'DEPRECATED');

          const dnaGlossaryEntriesProgress = getGlossaryEntriesFromDnaInSource(
            combinedSourceText,
            documentDnaPretranslate?.abbreviationLogic as Record<string, unknown> | null | undefined,
          );
          if (dnaGlossaryEntriesProgress.length > 0) {
            const existingTerms = new Set(filteredGlossary.map((e) => e.term));
            for (const e of dnaGlossaryEntriesProgress) {
              if (!existingTerms.has(e.term)) {
                filteredGlossary = [...filteredGlossary, e];
                existingTerms.add(e.term);
              }
            }
          }

          // Update progress to show we're calling AI (before the actual call)
          // This gives user feedback that AI is working, even if it takes time
          const currentAiCountBefore = responseLog.filter((r) => r.method === 'ai').length;
          updateProgress(documentId, {
            currentSegmentText: `Calling AI for unit ${batchNumber}/${totalBatches} (${batch.length} segment(s))...`,
            aiApplied: currentAiCountBefore,
          });

          // eslint-disable-next-line no-await-in-loop
          const aiResults = await orchestrator.translateSegments({
            provider: aiConfig.provider,
            model: aiConfig.model,
            apiKey: context.apiKey,
            yandexFolderId: context.yandexFolderId,
            document: documentWithSummary ? {
              name: documentWithSummary.name,
              summary: documentWithSummary.summary ?? undefined,
              clusterSummary: documentWithSummary.clusterSummary ?? undefined,
            } : undefined,
            documentDna: documentDnaPretranslate ?? undefined,
            segments: orchestratorSegments,
            glossary: filteredGlossary,
            guidelines: context.guidelines,
            project: context.projectMeta,
            sourceLocale: document.sourceLocale, // Pass explicit source locale from document
            targetLocale: document.targetLocale, // Pass explicit target locale from document
            temperature: aiConfig.temperature,
            maxTokens: context.settings.maxTokens ?? 1024,
            glossaryMode,
            // Stage 2: Document-specific context
            documentGlossary: documentGlossary.length > 0 ? documentGlossary : undefined,
            documentStyleRules: documentStyleRules.length > 0 ? documentStyleRules : undefined,
            documentId: document.id,
            introducedAbbreviations, // Style Governor: already expanded in previous batches
          });

          const resultMap = new Map(aiResults.map((result) => [result.segmentId, result]));
          const fallbackResults = aiResults.filter((r) => r.fallback || r.provider === 'rule-based' || r.provider === 'rule');
          const missingResults = batch.filter((entry) => !resultMap.has(entry.segment.id));
          if (fallbackResults.length > 0 || missingResults.length > 0) {
            addLogMessage(
              documentId,
              `⚠️ AI provider degraded for unit ${batchNumber}/${totalBatches}: ` +
                `${fallbackResults.length} fallback result(s) and ${missingResults.length} missing result(s). ` +
                `Source text was used as a placeholder for affected segments.`,
            );
            logger.warn(
              {
                documentId,
                batchNumber,
                totalBatches,
                fallbackCount: fallbackResults.length,
                missingCount: missingResults.length,
                fallbackProviders: Array.from(new Set(fallbackResults.map((r) => r.provider))),
                missingSegmentIds: missingResults.slice(0, 20).map((e) => e.segment.id),
              },
              'Pretranslate: AI degraded (fallback/missing results)',
            );
          }

          // Persistent state: session expandedTerms (Set) — updated after each batch and passed to next
          const knownAbbrevs = getKnownTargetAbbreviations(documentDnaPretranslate?.abbreviationLogic ?? undefined);
          if (knownAbbrevs.length > 0) {
            const newFromBatch = new Set<string>();
            for (const r of aiResults) {
              if (r.expandedTerms) for (const t of r.expandedTerms) newFromBatch.add(t);
              const text = r.targetText ?? '';
              const re = /\(([A-Z][A-Z0-9]{1,})\)/g;
              let m: RegExpExecArray | null;
              while ((m = re.exec(text)) !== null) {
                if (knownAbbrevs.includes(m[1])) newFromBatch.add(m[1]);
              }
            }
            introducedAbbreviations = [...new Set([...introducedAbbreviations, ...newFromBatch])];
          }
          logger.debug(
            { documentId, unitIndex: batchNumber, expandedTermsCount: introducedAbbreviations.length },
            'Pretranslate: unit completed, expandedTerms updated',
          );

          // Update progress immediately after getting AI results (before saving to DB)
          // This shows real-time progress to the user
          batch.forEach((entry) => {
            const aiResult = resultMap.get(entry.segment.id);
            let targetText = aiResult?.targetText ?? entry.segment.sourceText;
            if (aiResult?.targetText?.trim()) {
              targetText = ensureLeadingSectionFromSegment(aiResult.targetText, entry.segment.sourceText);
            }
            targetText = applyTotalCyrillicBan(targetText, documentDnaPretranslate?.abbreviationLogic as Record<string, unknown> | null | undefined, document.targetLocale);
            targetText = deduplicateFullFormDash(targetText, documentDnaPretranslate?.abbreviationLogic as Record<string, unknown> | null | undefined);
            // Add to pending updates
            pendingUpdates.push(
              prisma.segment.update({
                where: { id: entry.segment.id },
                data: {
                  targetMt: targetText,
                  targetFinal: targetText,
                  fuzzyScore: aiResult ? Math.round((aiResult.confidence ?? 0.85) * 100) : null,
                  bestTmEntryId: null,
                  status: 'MT',
                  ...(aiResult && {
                    mtFullPrompt: aiResult.fullPrompt ?? undefined,
                    mtAnalysis: aiResult.analysis ?? undefined,
                  }),
                },
              }),
            );
            const result = {
              segmentId: entry.segment.id,
              method: 'ai' as const,
              targetMt: targetText,
              fuzzyScore: aiResult ? Math.round((aiResult.confidence ?? 0.85) * 100) : undefined,
            };
            responseLog.push(result);
            addResult(documentId, result);
          });
          
          // Update AI progress immediately after processing batch (before saving to DB)
          // This gives real-time feedback to the user
          // Calculate immediately after adding to responseLog
          const currentAiCount = responseLog.filter((r) => r.method === 'ai').length;
          const tmCount = responseLog.filter((r) => r.method === 'tm').length;
          updateProgress(documentId, { 
            aiApplied: currentAiCount,
            currentSegment: responseLog.length,
            currentSegmentText: `Completed unit ${batchNumber}/${totalBatches}: ${currentAiCount} AI translations so far`,
          });
          
          addLogMessage(documentId, `✅ Unit ${batchNumber}/${totalBatches} complete: ${batch.length} segment(s) translated (Total AI: ${currentAiCount})`);

          // Save AI updates immediately after each batch to preserve on cancellation
          // This is critical - save before checking cancellation for next batch
          if (pendingUpdates.length > 0) {
            await prisma.$transaction(pendingUpdates);
            pendingUpdates = [];
          }
          
          // Check for cancellation AFTER saving this batch's updates
          if (isCancelled(documentId)) {
            logger.info({ 
              documentId,
              completedInThisBatch: batch.length,
              totalAiApplied: currentAiCount,
            }, 'Pretranslation cancelled - stopping after saving current batch');
            break; // Exit loop, updates already saved
          }
        }
        }
      }
    }

    // Save any remaining pending updates
    if (pendingUpdates.length > 0) {
      await prisma.$transaction(pendingUpdates);
      pendingUpdates = [];
    }

    // Reset empty segments (those that were eligible but didn't get a translation) to NEW status
    const processedSegmentIds = new Set(responseLog.map(r => r.segmentId));
    // Find segments that were eligible (empty) but didn't get a translation
    const emptySegments = eligibleSegments.filter(s => {
      const wasEmpty = !s.targetFinal && !s.targetMt;
      const wasProcessed = processedSegmentIds.has(s.id);
      return wasEmpty && !wasProcessed;
    });
    
    if (emptySegments.length > 0) {
      await prisma.segment.updateMany({
        where: {
          id: { in: emptySegments.map(s => s.id) },
        },
        data: {
          targetMt: null,
          targetFinal: null,
          fuzzyScore: null,
          bestTmEntryId: null,
          status: 'NEW',
        },
      });
    }

    const tmApplied = responseLog.filter((r) => r.method === 'tm').length;
    const aiApplied = responseLog.filter((r) => r.method === 'ai').length;

    // Check if cancelled after processing
    if (isCancelled(documentId)) {
      // CRITICAL: Ensure all pending updates are saved before returning
      // This ensures all completed translations are preserved even after cancellation
      if (pendingUpdates.length > 0) {
        logger.info({
          documentId,
          pendingUpdatesCount: pendingUpdates.length,
        }, 'Pretranslate: Saving final pending updates before cancellation');
        await prisma.$transaction(pendingUpdates);
        pendingUpdates = [];
      }
      
      // Verify that completed translations were saved
      const sampleSegmentId = responseLog[0]?.segmentId;
      if (sampleSegmentId) {
        const sampleSegment = await prisma.segment.findUnique({
          where: { id: sampleSegmentId },
          select: { id: true, targetMt: true, targetFinal: true, status: true },
        });
        logger.info({
          documentId,
          sampleSegmentId,
          hasTargetMt: !!sampleSegment?.targetMt,
          hasTargetFinal: !!sampleSegment?.targetFinal,
          status: sampleSegment?.status,
          totalCompleted: responseLog.length,
        }, 'Pretranslate: Verified completed translations saved after cancellation');
      }
      
      // Update progress with final counts before cancelling
      updateProgress(documentId, {
        tmApplied,
        aiApplied,
        currentSegment: responseLog.length,
      });
      
      addLogMessage(documentId, `⏸️ Pretranslation cancelled. ${tmApplied} TM matches and ${aiApplied} AI translations were saved.`);
      
      logger.info({
        documentId,
        tmApplied,
        aiApplied,
        totalProcessed: responseLog.length,
        resultsCount: responseLog.length,
      }, 'Pretranslate: Cancelled - all completed translations saved');
      
      cancelProgress(documentId);
      return {
        documentId,
        tmApplied,
        aiApplied,
        totalProcessed: responseLog.length,
        results: responseLog,
      };
    }

    // Ensure all database transactions are committed before marking as complete
    // Add a small delay to ensure all writes are flushed to database
    await new Promise(resolve => setTimeout(resolve, 500));
    
    // Verify that segments were actually saved by checking a sample
    const sampleSegmentId = responseLog[0]?.segmentId;
    if (sampleSegmentId) {
      const sampleSegment = await prisma.segment.findUnique({
        where: { id: sampleSegmentId },
        select: { id: true, targetMt: true, targetFinal: true, status: true },
      });
      logger.info({
        documentId,
        sampleSegmentId,
        hasTargetMt: !!sampleSegment?.targetMt,
        hasTargetFinal: !!sampleSegment?.targetFinal,
        status: sampleSegment?.status,
      }, 'Pretranslate: Verified sample segment was saved to database');
    }
    
    completeProgress(documentId);
    const finalTmCount = responseLog.filter((r) => r.method === 'tm').length;
    const finalAiCount = responseLog.filter((r) => r.method === 'ai').length;
    addLogMessage(documentId, `🎉 Pretranslation complete! ${finalTmCount} TM matches and ${finalAiCount} AI translations applied`);

    logger.info({
      documentId,
      tmApplied: finalTmCount,
      aiApplied: finalAiCount,
      totalProcessed: responseLog.length,
      sampleSegmentId,
    }, 'Pretranslate: Completed successfully, all segments saved to database');

    return {
      documentId,
      tmApplied,
      aiApplied,
      totalProcessed: responseLog.length,
      results: responseLog,
    };
  } catch (error: any) {
    // Updates are already saved incrementally, but ensure any remaining pending updates are saved
    if (pendingUpdates.length > 0) {
      try {
        await prisma.$transaction(pendingUpdates);
        pendingUpdates = [];
      } catch (txError) {
        console.error('Error saving final updates after cancellation:', txError);
      }
    }

    if (error.message === 'Pretranslation cancelled by user' || isCancelled(documentId)) {
      const tmApplied = responseLog.filter((r) => r.method === 'tm').length;
      const aiApplied = responseLog.filter((r) => r.method === 'ai').length;
      // Update progress with saved counts BEFORE cancelling to preserve counts
      updateProgress(documentId, {
        tmApplied,
        aiApplied,
        currentSegment: responseLog.length,
      });
      cancelProgress(documentId);
      return {
        documentId,
        tmApplied,
        aiApplied,
        totalProcessed: responseLog.length,
        results: responseLog,
      };
    }
    const errorMessage = error.message || 'Unknown error';
    setError(documentId, errorMessage);
    addLogMessage(documentId, `❌ Error: ${errorMessage}`);
    throw error;
  }
};

/** Segment shape used for patch-translate queue (same as pretranslate AI phase). */
type PatchTranslateEntry = {
  segment: { id: string; sourceText: string; segmentIndex: number };
  previous?: { sourceText: string } | null;
  next?: { sourceText: string } | null;
};

/**
 * Retranslate only the given segments (e.g. after DNA change). Uses same AI batch loop as
 * pretranslate, with introducedAbbreviations computed from segments before the first affected.
 */
export const patchTranslate = async (
  documentId: string,
  affectedSegmentIds: string[],
  options?: {
    glossaryMode?: GlossaryMode;
    useCritic?: boolean;
    provider?: string;
    model?: string;
    temperature?: number;
  },
) => {
  const glossaryMode = options?.glossaryMode ?? 'strict_source';
  const { createProgress, updateProgress, addResult, completeProgress, cancelProgress, isCancelled, setError, clearProgress, addLogMessage } = await import('./pretranslateProgress');
  clearProgress(documentId);

  if (affectedSegmentIds.length === 0) {
    return { documentId, aiApplied: 0, totalProcessed: 0, results: [] };
  }

  const document = await prisma.document.findUnique({
    where: { id: documentId },
    select: { id: true, name: true, projectId: true, sourceLocale: true, targetLocale: true },
  });
  if (!document) {
    throw ApiError.notFound('Document not found');
  }

  const affectedSegments = await prisma.segment.findMany({
    where: { id: { in: affectedSegmentIds }, documentId },
    select: { id: true, sourceText: true, segmentIndex: true, targetMt: true, targetFinal: true, status: true },
    orderBy: { segmentIndex: 'asc' },
  });
  if (affectedSegments.length !== affectedSegmentIds.length) {
    throw ApiError.badRequest('One or more segment IDs do not belong to this document');
  }

  const minIndex = affectedSegments[0].segmentIndex;
  const maxIndex = affectedSegments[affectedSegments.length - 1].segmentIndex;
  const neighborSegments = await prisma.segment.findMany({
    where: {
      documentId,
      segmentIndex: { gte: minIndex - 1, lte: maxIndex + 1 },
    },
    select: { id: true, sourceText: true, segmentIndex: true },
    orderBy: { segmentIndex: 'asc' },
  });
  const segmentByIndex = new Map(neighborSegments.map((s) => [s.segmentIndex, s]));

  const firstAffectedIndex = minIndex;
  const documentDna = await getEffectiveDocumentDna(documentId);
  // Consistency: DNA snapshot is frozen for the entire patch run. Normalize once and use only this snapshot in the loop (no refetch).
  const frozenDna = normalizeDocumentDnaPayloadOrNull(documentDna) ?? documentDna ?? null;
  const cycleCheck = validateDnaForCycles(frozenDna);
  if (!cycleCheck.valid) {
    const msg = `Document DNA: ${cycleCheck.errors.join('; ')}`;
    addLogMessage(documentId, `❌ ${msg}`);
    setError(documentId, msg);
    completeProgress(documentId);
    return { documentId, aiApplied: 0, totalProcessed: 0, results: [] };
  }
  const knownAbbrevs = getKnownTargetAbbreviations((frozenDna?.abbreviationLogic as Record<string, unknown>) ?? undefined);
  let introducedAbbreviations: string[] = [];
  if (firstAffectedIndex > 0 && knownAbbrevs.length > 0) {
    const segmentsBefore = await prisma.segment.findMany({
      where: {
        documentId,
        segmentIndex: { lt: firstAffectedIndex },
        OR: [{ targetFinal: { not: null } }, { targetMt: { not: null } }],
      },
      select: { targetFinal: true, targetMt: true },
      orderBy: { segmentIndex: 'asc' },
    });
    const seen = new Set<string>();
    const re = /\(([A-Z][A-Z0-9]{1,})\)/g;
    for (const seg of segmentsBefore) {
      const text = (seg.targetFinal ?? seg.targetMt) ?? '';
      let m: RegExpExecArray | null;
      while ((m = re.exec(text)) !== null) {
        if (knownAbbrevs.includes(m[1]) && !seen.has(m[1])) {
          seen.add(m[1]);
          introducedAbbreviations.push(m[1]);
        }
      }
    }
  }

  const queuedForAI: PatchTranslateEntry[] = [];
  for (const segment of affectedSegments) {
    const prev = segmentByIndex.get(segment.segmentIndex - 1);
    const next = segmentByIndex.get(segment.segmentIndex + 1);
    queuedForAI.push({
      segment: { id: segment.id, sourceText: segment.sourceText, segmentIndex: segment.segmentIndex },
      previous: prev ? { sourceText: prev.sourceText } : undefined,
      next: next ? { sourceText: next.sourceText } : undefined,
    });
  }

  const SAVE_BATCH_SIZE = 5;
  let pendingUpdates: Prisma.PrismaPromise<unknown>[] = [];
  const responseLog: Array<{ segmentId: string; method: 'ai'; targetMt: string | null; fuzzyScore?: number }> = [];

  try {
    const context = await buildAiContext(
      document.projectId,
      document.sourceLocale,
      document.targetLocale,
    );
    const effectiveProvider = options?.provider || context.settings?.provider;
    const effectiveModel = options?.model || context.settings?.model;
    const effectiveTemperature = options?.temperature !== undefined
      ? options.temperature
      : (context.settings?.temperature ?? getDefaultTemperature(effectiveProvider || 'gemini'));
    const hasAiConfig = context.settings || (options?.provider && options?.model);
    const hasApiKey = !!context.apiKey || (effectiveProvider === 'yandex' && !!context.yandexFolderId);

    createProgress(documentId, queuedForAI.length, {
      provider: effectiveProvider,
      model: effectiveModel,
      configured: hasAiConfig && hasApiKey,
    });
    addLogMessage(documentId, `🚀 Patch translation: ${queuedForAI.length} segments`);
    if (!effectiveProvider || !effectiveModel) {
      addLogMessage(documentId, `⚠️ AI not configured. Patch translation requires AI.`);
      completeProgress(documentId);
      return { documentId, aiApplied: 0, totalProcessed: 0, results: responseLog };
    }

    const dnaValidation = validateDocumentDnaPayload(frozenDna ?? null);
    if (!dnaValidation.valid) {
      const msg = `Invalid Document DNA: ${dnaValidation.errors.join('; ')}`;
      addLogMessage(documentId, `❌ ${msg}`);
      setError(documentId, msg);
      completeProgress(documentId);
      throw new Error(msg);
    }

    const useCritic = options?.useCritic ?? false;
    if (useCritic) {
      addLogMessage(documentId, `🤖 Patch translate (Critic Mode) not implemented for batch; using batch mode.`);
    }
    updateProgress(documentId, {
      currentPhase: 'ai_translation',
      currentSegmentText: `Starting AI for ${queuedForAI.length} segments...`,
      aiApplied: 0,
      currentSegment: 0,
    });

    orchestrator.clearSessionState(document.id);
    const batchSize = 10;
    const aiConfig = {
      provider: effectiveProvider!,
      model: effectiveModel!,
      apiKey: context.apiKey,
      yandexFolderId: context.yandexFolderId,
      temperature: effectiveTemperature,
    };

    for (let i = 0; i < queuedForAI.length; i += batchSize) {
      if (isCancelled(documentId)) {
        if (pendingUpdates.length > 0) {
          await prisma.$transaction(pendingUpdates);
          pendingUpdates = [];
        }
        break;
      }
      const batch = queuedForAI.slice(i, i + batchSize);
      const batchNumber = Math.floor(i / batchSize) + 1;
      const totalBatches = Math.ceil(queuedForAI.length / batchSize);
      addLogMessage(documentId, `📦 Batch ${batchNumber}/${totalBatches} (${batch.length} segments)...`);

      const orchestratorSegments = batch.map((entry) =>
        buildOrchestratorSegment(entry.segment, entry.previous, entry.next, document.name ?? undefined),
      );
      updateProgress(documentId, {
        currentSegment: i,
        currentSegmentId: batch[0].segment.id,
        currentSegmentText: batch[0].segment.sourceText.substring(0, 100) + (batch[0].segment.sourceText.length > 100 ? '...' : ''),
        aiApplied: responseLog.length,
      });

      const documentContext: DocumentContext = {
        projectDomain: context.projectMeta.domain,
        projectClient: context.projectMeta.client,
        documentName: document.name,
        documentType: undefined,
      };
      const combinedSourceText = orchestratorSegments.map((s) => s.sourceText).join(' ');
      const filteredGlossary = await getRelevantGlossaryEntries(
        combinedSourceText,
        document.sourceLocale,
        document.targetLocale,
        document.projectId,
        documentContext,
      );
      const documentWithSummary = await prisma.document.findUnique({
        where: { id: document.id },
        select: { name: true, summary: true, clusterSummary: true },
      });
      const documentDnaPretranslate = frozenDna
        ? {
            technicalSchema: frozenDna.technicalSchema as Record<string, unknown> | null | undefined,
            namingConventions: frozenDna.namingConventions as Record<string, unknown> | null | undefined,
            abbreviationLogic: frozenDna.abbreviationLogic as Record<string, unknown> | null | undefined,
            entityGroups: frozenDna.entityGroups as Record<string, unknown> | null | undefined,
          }
        : undefined;
      const documentStyleRules = await getDocumentStyleRules(document.id);
      const documentGlossaryMap = new Map<string, { sourceTerm: string; targetTerm: string; status: string; occurrenceCount: number }>();
      for (const segment of orchestratorSegments) {
        const matchingTerms = await getDocumentGlossaryForSegment(document.id, segment.sourceText);
        for (const term of matchingTerms) {
          const existing = documentGlossaryMap.get(term.sourceTerm);
          if (!existing || term.status === 'PREFERRED' || (term.status === 'CANDIDATE' && existing.status !== 'PREFERRED')) {
            documentGlossaryMap.set(term.sourceTerm, term);
          }
        }
      }
      const documentGlossary = Array.from(documentGlossaryMap.values())
        .sort((a, b) => {
          const statusPriority = { PREFERRED: 3, CANDIDATE: 2, DEPRECATED: 1 };
          const aP = statusPriority[a.status as keyof typeof statusPriority] || 0;
          const bP = statusPriority[b.status as keyof typeof statusPriority] || 0;
          if (aP !== bP) return bP - aP;
          return b.occurrenceCount - a.occurrenceCount;
        })
        .slice(0, 20)
        .filter((term) => term.status !== 'DEPRECATED');

      const aiResults = await orchestrator.translateSegments({
        provider: aiConfig.provider,
        model: aiConfig.model,
        apiKey: context.apiKey,
        yandexFolderId: context.yandexFolderId,
        document: documentWithSummary
          ? { name: documentWithSummary.name, summary: documentWithSummary.summary ?? undefined, clusterSummary: documentWithSummary.clusterSummary ?? undefined }
          : undefined,
        documentDna: documentDnaPretranslate ?? undefined,
        segments: orchestratorSegments,
        glossary: filteredGlossary,
        guidelines: context.guidelines,
        project: context.projectMeta,
        sourceLocale: document.sourceLocale,
        targetLocale: document.targetLocale,
        temperature: aiConfig.temperature,
        maxTokens: context.settings?.maxTokens ?? 1024,
        glossaryMode,
        documentGlossary: documentGlossary.length > 0 ? documentGlossary : undefined,
        documentStyleRules: documentStyleRules.length > 0 ? documentStyleRules : undefined,
        documentId: document.id,
        introducedAbbreviations,
      });

      const knownAbbrevsBatch = getKnownTargetAbbreviations(documentDnaPretranslate?.abbreviationLogic ?? undefined);
      if (knownAbbrevsBatch.length > 0) {
        const newFromBatch = new Set<string>();
        for (const r of aiResults) {
          if (r.expandedTerms) for (const t of r.expandedTerms) newFromBatch.add(t);
          const text = r.targetText ?? '';
          const re = /\(([A-Z][A-Z0-9]{1,})\)/g;
          let mm: RegExpExecArray | null;
          while ((mm = re.exec(text)) !== null) {
            if (knownAbbrevsBatch.includes(mm[1])) newFromBatch.add(mm[1]);
          }
        }
        introducedAbbreviations = [...new Set([...introducedAbbreviations, ...newFromBatch])];
      }

      const resultMap = new Map(aiResults.map((r) => [r.segmentId, r]));
      const fallbackResults = aiResults.filter((r) => r.fallback || r.provider === 'rule-based' || r.provider === 'rule');
      const missingResults = batch.filter((entry) => !resultMap.has(entry.segment.id));
      if (fallbackResults.length > 0 || missingResults.length > 0) {
        addLogMessage(
          documentId,
          `⚠️ AI provider degraded for batch ${batchNumber}/${totalBatches}: ` +
            `${fallbackResults.length} fallback result(s) and ${missingResults.length} missing result(s). ` +
            `Source text was used as a placeholder for affected segments.`,
        );
        logger.warn(
          {
            documentId,
            batchNumber,
            totalBatches,
            fallbackCount: fallbackResults.length,
            missingCount: missingResults.length,
            fallbackProviders: Array.from(new Set(fallbackResults.map((r) => r.provider))),
            missingSegmentIds: missingResults.slice(0, 20).map((e) => e.segment.id),
          },
          'PatchTranslate: AI degraded (fallback/missing results)',
        );
      }
      batch.forEach((entry) => {
        const aiResult = resultMap.get(entry.segment.id);
        let targetText = aiResult?.targetText ?? entry.segment.sourceText;
        if (aiResult?.targetText?.trim()) {
          targetText = ensureLeadingSectionFromSegment(aiResult.targetText, entry.segment.sourceText);
        }
        targetText = applyTotalCyrillicBan(targetText, documentDnaPretranslate?.abbreviationLogic as Record<string, unknown> | null | undefined, document.targetLocale);
        targetText = deduplicateFullFormDash(targetText, documentDnaPretranslate?.abbreviationLogic as Record<string, unknown> | null | undefined);
        pendingUpdates.push(
          prisma.segment.update({
            where: { id: entry.segment.id },
            data: {
              targetMt: targetText,
              targetFinal: targetText,
              fuzzyScore: aiResult ? Math.round((aiResult.confidence ?? 0.85) * 100) : null,
              bestTmEntryId: null,
              status: 'MT',
              ...(aiResult && {
                mtFullPrompt: aiResult.fullPrompt ?? undefined,
                mtAnalysis: aiResult.analysis ?? undefined,
              }),
            },
          }),
        );
        const result = {
          segmentId: entry.segment.id,
          method: 'ai' as const,
          targetMt: targetText,
          fuzzyScore: aiResult ? Math.round((aiResult.confidence ?? 0.85) * 100) : undefined,
        };
        responseLog.push(result);
        addResult(documentId, result);
      });

      const currentAiCount = responseLog.length;
      updateProgress(documentId, {
        aiApplied: currentAiCount,
        currentSegment: currentAiCount,
        currentSegmentText: `Batch ${batchNumber}/${totalBatches} done: ${currentAiCount} segments`,
      });
      addLogMessage(documentId, `✅ Batch ${batchNumber}/${totalBatches} complete (${currentAiCount} total)`);

      if (pendingUpdates.length > 0) {
        await prisma.$transaction(pendingUpdates);
        pendingUpdates = [];
      }
      if (isCancelled(documentId)) break;
    }

    if (pendingUpdates.length > 0) {
      await prisma.$transaction(pendingUpdates);
      pendingUpdates = [];
    }
    const aiApplied = responseLog.length;
    completeProgress(documentId);
    addLogMessage(documentId, `🎉 Patch translation complete: ${aiApplied} segments updated`);
    return { documentId, aiApplied, totalProcessed: aiApplied, results: responseLog };
  } catch (err: unknown) {
    if (pendingUpdates.length > 0) {
      try {
        await prisma.$transaction(pendingUpdates);
        pendingUpdates = [];
      } catch (_) {}
    }
    const message = err instanceof Error ? err.message : 'Unknown error';
    setError(documentId, message);
    addLogMessage(documentId, `❌ ${message}`);
    if (isCancelled(documentId)) {
      cancelProgress(documentId);
      return { documentId, aiApplied: responseLog.length, totalProcessed: responseLog.length, results: responseLog };
    }
    throw err;
  }
};

export const createAIRequest = async (
  documentId: string,
  type: 'TRANSLATION' | 'QA' | 'SUMMARY',
  payload: Record<string, unknown>,
) => {
  const document = await prisma.document.findUnique({ where: { id: documentId } });
  if (!document) {
    throw ApiError.notFound('Document not found');
  }
  return prisma.aIRequest.create({
    data: {
      documentId,
      type,
      status: 'QUEUED',
      payload: payload as any,
    },
  });
};

export const getAIRequest = async (requestId: string) => {
  const request = await prisma.aIRequest.findUnique({
    where: { id: requestId },
    include: { document: true },
  });
  if (!request) {
    throw ApiError.notFound('AI request not found');
  }
  return request;
};

export const listAIRequests = async (documentId?: string) => {
  return prisma.aIRequest.findMany({
    where: documentId ? { documentId } : undefined,
    orderBy: { createdAt: 'desc' },
    include: { document: { select: { id: true, name: true } } },
  });
};

export const updateAIRequestStatus = async (
  requestId: string,
  status: 'QUEUED' | 'RUNNING' | 'COMPLETED' | 'FAILED',
  result?: Record<string, unknown>,
) => {
  const request = await prisma.aIRequest.findUnique({ where: { id: requestId } });
  if (!request) {
    throw ApiError.notFound('AI request not found');
  }
  return prisma.aIRequest.update({
    where: { id: requestId },
    data: {
      status,
      result: result as any,
      completedAt: status === 'COMPLETED' || status === 'FAILED' ? new Date() : undefined,
    },
  });
};

type DirectTranslationRequest = {
  sourceText: string;
  sourceLocale: string;
  targetLocale: string;
  projectId?: string;
  provider?: string;
  model?: string;
  temperature?: number;
  maxTokens?: number;
  glossaryMode?: GlossaryMode;
};

export const translateTextDirectly = async (request: DirectTranslationRequest) => {
  const context = request.projectId && request.sourceLocale && request.targetLocale
    ? await buildAiContext(request.projectId, request.sourceLocale, request.targetLocale)
    : request.projectId
    ? await buildAiContext(request.projectId)
    : null;
  
  const provider = request.provider ?? context?.settings?.provider;
  const model = request.model ?? context?.settings?.model;
  const apiKey = context?.apiKey; // Use project-specific API key if available
  const temperature = request.temperature ?? context?.settings?.temperature ?? getDefaultTemperature(provider);
  const maxTokens = request.maxTokens ?? context?.settings?.maxTokens ?? 1024;
  const glossaryMode = request.glossaryMode ?? 'strict_source';
  const glossary = context?.glossary ?? [];
  const guidelines = context?.guidelines ?? [];
  const projectMeta = context?.projectMeta ?? {
    sourceLang: request.sourceLocale,
    targetLang: request.targetLocale,
  };

  // Classic RAG: Retrieve TM examples for AI context
  let tmExamples: TmExample[] = [];
  if (request.projectId) {
    try {
      const exampleMatches = await searchTranslationMemory({
        sourceText: request.sourceText,
        sourceLocale: request.sourceLocale,
        targetLocale: request.targetLocale,
        projectId: request.projectId,
        limit: 5, // Get top 5 examples
        minScore: 50, // Lower threshold for examples
        vectorSimilarity: 60, // Include semantic matches
      });
      
      tmExamples = exampleMatches.map((match) => ({
        sourceText: match.sourceText,
        targetText: match.targetText,
        fuzzyScore: match.fuzzyScore,
        searchMethod: match.searchMethod || 'fuzzy',
      }));

      // Log examples for debugging
      if (tmExamples.length > 0) {
        logger.info({
          sourceText: request.sourceText.substring(0, 50),
          exampleCount: tmExamples.length,
          topExample: tmExamples[0] ? {
            source: tmExamples[0].sourceText.substring(0, 50),
            target: tmExamples[0].targetText.substring(0, 50),
            score: tmExamples[0].fuzzyScore,
            method: tmExamples[0].searchMethod,
          } : null,
        }, 'Retrieved TM examples for Classic RAG (direct translation)');
      }
    } catch (error) {
      logger.warn({ error }, 'Failed to retrieve TM examples for direct translation');
    }
  }

  // Get relevant glossary entries using vector search + strict filtering (Hybrid Approach)
  // For direct translation without document, we can only filter by project domain/client
  const projectContext: DocumentContext = {
    projectDomain: projectMeta.domain,
    projectClient: projectMeta.client,
    documentName: undefined,
    documentType: undefined,
  };
  
  // Use vector search if projectId is available, otherwise fallback to traditional filtering
  let filteredGlossary: OrchestratorGlossaryEntry[];
  if (request.projectId && request.sourceLocale && request.targetLocale) {
    filteredGlossary = await getRelevantGlossaryEntries(
      request.sourceText,
      request.sourceLocale,
      request.targetLocale,
      request.projectId,
      projectContext,
    );
  } else {
    // Fallback: use traditional filtering if no projectId or locales
    const contextFilteredGlossary = filterGlossaryByContext(glossary, projectContext);
    filteredGlossary = filterGlossaryBySourceText(contextFilteredGlossary, request.sourceText, request.sourceLocale || 'en');
  }

  const segment: OrchestratorSegment = {
    segmentId: 'direct-translation',
    sourceText: request.sourceText,
    previousText: undefined,
    nextText: undefined,
    documentName: undefined,
  };

  const aiResult = await orchestrator.translateSingleSegment(segment, {
    provider,
    model,
    apiKey,
    yandexFolderId: context?.yandexFolderId,
    glossary: filteredGlossary,
    guidelines,
    tmExamples, // Pass examples for RAG
    project: projectMeta,
    sourceLocale: request.sourceLocale, // Pass explicit source locale
    targetLocale: request.targetLocale, // Pass explicit target locale
    temperature,
    maxTokens,
    glossaryMode, // Pass glossary mode to orchestrator
  });

  return {
    targetText: aiResult.targetText,
    provider: aiResult.provider,
    model: aiResult.model,
    confidence: aiResult.confidence,
    usage: aiResult.usage,
  };
};

// Interactive Critic Workflow - Step 1: Generate Draft
export const generateDraftTranslation = async (request: {
  sourceText: string;
  projectId?: string;
  sourceLocale?: string;
  targetLocale?: string;
  provider?: string;
  model?: string;
  apiKey?: string;
  temperature?: number;
  maxTokens?: number;
}) => {
  const context = request.projectId && request.sourceLocale && request.targetLocale
    ? await buildAiContext(request.projectId, request.sourceLocale, request.targetLocale)
    : request.projectId
    ? await buildAiContext(request.projectId)
    : null;
  
  const provider = request.provider ?? context?.settings?.provider;
  const model = request.model ?? context?.settings?.model;
  const apiKey = request.apiKey ?? context?.apiKey;
  const temperature = request.temperature ?? context?.settings?.temperature ?? getDefaultTemperature(provider);
  const maxTokens = request.maxTokens ?? context?.settings?.maxTokens ?? 1024;
  const glossary = context?.glossary ?? [];
  const guidelines = context?.guidelines ?? [];
  const projectMeta = context?.projectMeta ?? {
    sourceLang: request.sourceLocale,
    targetLang: request.targetLocale,
  };

  // Get TM examples for RAG (but don't use them as direct matches)
  let tmExamples: TmExample[] = [];
  if (request.projectId && request.sourceLocale && request.targetLocale) {
    try {
      const exampleMatches = await searchTranslationMemory({
        sourceText: request.sourceText,
        sourceLocale: request.sourceLocale,
        targetLocale: request.targetLocale,
        projectId: request.projectId,
        limit: 5,
        minScore: 50,
        vectorSimilarity: 60,
      });
      
      tmExamples = exampleMatches.map((match) => ({
        sourceText: match.sourceText,
        targetText: match.targetText,
        fuzzyScore: match.fuzzyScore,
        searchMethod: match.searchMethod || 'fuzzy',
      }));
    } catch (error) {
      logger.warn({ error }, 'Failed to retrieve TM examples for draft generation');
    }
  }

  const result = await orchestrator.generateDraft(request.sourceText, {
    provider,
    model,
    apiKey,
    yandexFolderId: context?.yandexFolderId,
    glossary,
    guidelines,
    tmExamples,
    project: projectMeta,
    sourceLocale: request.sourceLocale,
    targetLocale: request.targetLocale,
    temperature,
    maxTokens,
  });

  return result;
};

// Interactive Critic Workflow - Step 2: Run Critique
export const runCritiqueCheck = async (request: {
  sourceText: string;
  draftText: string;
  projectId?: string;
  sourceLocale?: string;
  targetLocale?: string;
  provider?: string;
  model?: string;
  apiKey?: string;
  maxTokens?: number;
}) => {
  const context = request.projectId && request.sourceLocale && request.targetLocale
    ? await buildAiContext(request.projectId, request.sourceLocale, request.targetLocale)
    : request.projectId
    ? await buildAiContext(request.projectId)
    : null;
  
  const provider = request.provider ?? context?.settings?.provider;
  const model = request.model ?? context?.settings?.model;
  const apiKey = request.apiKey ?? context?.apiKey;
  
  logger.debug({
    provider,
    model,
    requestProvider: request.provider,
    requestModel: request.model,
    contextProvider: context?.settings?.provider,
    contextModel: context?.settings?.model,
  }, 'runCritiqueCheck: Initial model selection');
  
  // Filter glossary by locale if provided
  let glossary = context?.glossary ?? [];
  if (request.sourceLocale && request.targetLocale && glossary.length > 0) {
    // Get filtered glossary entries from database
    const filteredEntries = await prisma.glossaryEntry.findMany({
      where: {
        OR: [
          { projectId: request.projectId ?? null },
          { projectId: null }, // Global entries
        ],
        sourceLocale: request.sourceLocale,
        targetLocale: request.targetLocale,
      },
      select: {
        sourceTerm: true,
        targetTerm: true,
        sourceLocale: true,
        targetLocale: true,
        isForbidden: true,
        notes: true,
        contextRules: true,
      },
    });
    
    glossary = mapGlossaryEntries(filteredEntries, request.sourceLocale, request.targetLocale);
    
    logger.debug({
      originalGlossaryCount: context?.glossary?.length || 0,
      filteredGlossaryCount: glossary.length,
      sourceLocale: request.sourceLocale,
      targetLocale: request.targetLocale,
    }, 'Filtered glossary by locale for critique');
  }

  logger.info({
    glossaryCount: glossary.length,
    glossarySample: glossary.slice(0, 3).map(g => ({ term: g.term, translation: g.translation })),
    sourceTextLength: request.sourceText.length,
    draftTextLength: request.draftText.length,
    sourceLocale: request.sourceLocale,
    targetLocale: request.targetLocale,
  }, 'Running critique check with glossary');

  // Use much higher maxTokens for critic (prompts are very long with detailed instructions)
  // Gemini API supports up to 8192 output tokens
  const criticMaxTokens = request.maxTokens ? Math.max(request.maxTokens, 8192) : 8192;
  
  // Auto-switch Gemini models to gemini-1.5-pro for critic workflow to avoid thoughts token consumption
  // CRITICAL: Also switch gemini-pro because it often falls back to gemini-2.5-flash
  // which uses thoughts and consumes all output tokens
  // This is done here as well as in runCritique to ensure it works in all code paths
  let criticModel = model;
  if (provider === 'gemini') {
    const modelLower = (model || '').toLowerCase();
    // Check if it's a flash model (these use thoughts aggressively)
    const isFlashModel = modelLower.includes('flash');
    // Check if it's gemini-pro (often falls back to gemini-2.5-flash)
    const isGeminiPro = modelLower === 'gemini-pro' || (modelLower.includes('gemini-pro') && !modelLower.includes('2.5-pro'));
    // Don't switch if already using gemini-2.5-pro (it's the best available option)
    const isAlready25Pro = modelLower.includes('2.5-pro') && !isFlashModel;
    
    if ((isFlashModel || isGeminiPro) && !isAlready25Pro) {
      // Use gemini-2.5-pro instead of gemini-1.5-pro because gemini-1.5-pro is not available
      // gemini-2.5-pro may use thoughts but less aggressively than gemini-2.5-flash
      const reason = isFlashModel 
        ? 'Gemini Flash models use thoughts which can consume all output tokens'
        : 'gemini-pro often falls back to gemini-2.5-flash which uses thoughts';
      logger.warn({
        originalModel: model,
        fallbackModel: 'gemini-2.5-pro',
        reason,
        isFlashModel,
        isGeminiPro,
        isAlready25Pro,
        note: 'Using gemini-2.5-pro (gemini-1.5-pro not available)',
      }, 'Switching to gemini-2.5-pro for critique check (gemini-1.5-pro not available)');
      criticModel = 'gemini-2.5-pro';
    }
  }
  
  const result = await orchestrator.runCritique(
    request.sourceText,
    request.draftText,
    glossary,
    { 
      provider, 
      model: criticModel, 
      apiKey,
      yandexFolderId: context?.yandexFolderId,
      sourceLocale: request.sourceLocale,
      targetLocale: request.targetLocale,
      maxTokens: criticMaxTokens,
    },
  );

  return result;
};

// Interactive Critic Workflow - Step 3: Fix Translation
export const fixTranslationWithErrors = async (request: {
  sourceText: string;
  draftText: string;
  errors: Array<{ term: string; expected: string; found: string; severity: string }>;
  projectId?: string;
  sourceLocale?: string;
  targetLocale?: string;
  provider?: string;
  model?: string;
  apiKey?: string;
  temperature?: number;
  maxTokens?: number;
}) => {
  const context = request.projectId && request.sourceLocale && request.targetLocale
    ? await buildAiContext(request.projectId, request.sourceLocale, request.targetLocale)
    : request.projectId
    ? await buildAiContext(request.projectId)
    : null;
  
  const provider = request.provider ?? context?.settings?.provider;
  const model = request.model ?? context?.settings?.model;
  const apiKey = request.apiKey ?? context?.apiKey;
  const temperature = request.temperature ?? context?.settings?.temperature ?? getDefaultTemperature(provider);
  const maxTokens = request.maxTokens ?? context?.settings?.maxTokens ?? 1024;
  const glossary = context?.glossary ?? [];
  const guidelines = context?.guidelines ?? [];
  const projectMeta = context?.projectMeta ?? {};
  
  // Get locales from request or project context
  const sourceLocale = request.sourceLocale ?? projectMeta.sourceLang ?? 'ru';
  const targetLocale = request.targetLocale ?? projectMeta.targetLang ?? 'en';

  const result = await orchestrator.fixTranslation(
    request.sourceText,
    request.draftText,
    request.errors,
    {
      provider,
      model,
      apiKey,
      yandexFolderId: context?.yandexFolderId,
      temperature,
      maxTokens,
      glossary,
      sourceLocale,
      targetLocale,
    },
  );

  return result;
};

export type PostEditQACheck = {
  segment: string;
  issue: string;
  severity: 'warning' | 'error';
  suggestion: string;
};

export type PostEditQAResult = {
  checks: PostEditQACheck[];
};

type PostEditQARequest = {
  sourceText: string;
  targetText: string;
  sourceLocale: string;
  targetLocale: string;
  projectId?: string;
  provider?: string;
  model?: string;
  glossary?: Array<{ sourceTerm: string; targetTerm: string; isForbidden?: boolean }>;
};

export const runPostEditQA = async (request: PostEditQARequest): Promise<PostEditQAResult> => {
  const context = request.projectId && request.sourceLocale && request.targetLocale
    ? await buildAiContext(request.projectId, request.sourceLocale, request.targetLocale)
    : request.projectId
    ? await buildAiContext(request.projectId)
    : null;
  
  const provider = request.provider ?? context?.settings?.provider ?? 'gemini';
  const model = request.model ?? context?.settings?.model;
  const apiKey = context?.apiKey;
  const temperature = 0.1; // Low temperature for consistent QA checks
  const maxTokens = 2048; // Enough for detailed checks

  // Build glossary list for the prompt
  const glossaryEntries = request.glossary ?? (context?.glossary ? context.glossary.map((g) => ({
    sourceTerm: g.term,
    targetTerm: g.translation,
    isForbidden: g.forbidden ?? false,
  })) : []);
  const glossaryText = glossaryEntries.length > 0
    ? glossaryEntries.map((g) => `- "${g.sourceTerm}" → "${g.targetTerm}"${g.isForbidden ? ' (FORBIDDEN)' : ''}`).join('\n')
    : 'No glossary terms provided.';

  // Build the QA prompt
  const qaPrompt = `You are a Post-Edit QA Agent for bilingual translations.

Your task:
Review the translation ("targetText") against the original ("sourceText") and return a structured list of issues.

You MUST:
- Focus on correctness, consistency, terminology, numbers, units, and structure.
- Use the glossary STRICTLY when provided.
- Be concise and technical in descriptions and suggestions.
- Work reliably for Russian ↔ English, but also support other language pairs.

YOUR OUTPUT FORMAT (VERY IMPORTANT):
You MUST respond **only** with a single valid JSON object, with this structure:

{
  "checks": [
    {
      "segment": "<short fragment of the target text or term>",
      "issue": "<what is wrong and why it is wrong>",
      "severity": "warning" or "error",
      "suggestion": "<recommended corrected wording in the target language>"
    }
  ]
}

Rules for JSON:
- Do NOT wrap JSON in markdown code fences. No \`\`\` at all.
- No comments, no trailing commas.
- If there are NO issues, return: { "checks": [] }

Field meanings:
- "segment": a short snippet from the TARGET text where the problem occurs (or the problematic term/phrase).
- "issue": clear, human-readable explanation of the problem, in English. Mention the source term if relevant.
- "severity":
  - "error" = serious error (wrong term, meaning change, mistranslation, wrong number, broken tag, etc.).
  - "warning" = non-critical issue (style, preferred terminology, minor inconsistency).
- "suggestion": provide a concrete corrected version in the TARGET language. If the issue is about a term, include the correct term in context.

WHAT TO CHECK:

1) Glossary and terminology
- If glossary is provided, all glossary terms from sourceText MUST be translated exactly as in the glossary.
- If a different translation is used where a glossary term exists, this is an "error".
- If multiple inconsistent translations of the same term appear, mark them as "warning" and suggest the glossary or dominant consistent form.
- Flag forbidden or undesired variants, if they are explicitly mentioned or obviously conflict with the glossary.

2) Meaning and critical mistranslation
- Check that the core meaning of the source is preserved.
- Flag as "error" any mistranslation that:
  - reverses meaning,
  - omits critical information,
  - adds information not present in the source,
  - misrepresents technical or legal content.
- In "issue", briefly explain what was distorted.
- In "suggestion", provide the corrected translation fragment.

3) Numbers, dates, and units
- Compare all numbers in sourceText and targetText.
- Flag as "error":
  - changed numbers,
  - missing numbers,
  - added numbers that are not justified.
- Check units of measure (kV, MW, kWh, %, km, etc.) and dates.
- Check decimal separators and thousand separators if they obviously conflict with targetLocale norms.

4) Structure, tags, placeholders (if present)
- If the text contains tags, placeholders, or structured markers (e.g. {0}, %s, <tag>…</tag>, XML-like structures):
  - They MUST appear in the targetText and must not be altered.
  - Flag as "error" any:
    - removed tags/placeholders,
    - added tags/placeholders,
    - reordered or malformed tags/placeholders.
- If segments are clearly delimited (e.g. numbered items, bullet points), check that the structure is preserved.

5) Consistency inside the text
- Check that repeated phrases, terms, and names are translated consistently.
- If the same expression appears multiple times with different translations without a clear reason, mark as "warning" and suggest a consistent option.
- Check that naming of entities (companies, departments, projects, equipment) is consistent.

6) Style and register (technical/business)
- Target style should be formal, technical/business-like.
- Flag as "warning":
  - overly colloquial language,
  - inconsistent register (mixing very casual and very formal in one document),
  - obvious style clashes with standard technical/business English.
- Do NOT enforce subjective stylistic preferences; only flag clear deviations from professional formal style.

7) Omissions and additions
- Flag as "error":
  - important sentences or clauses missing in the translation,
  - whole items in lists omitted,
  - critical conditions or restrictions left out.
- Flag as "error" or "warning" (depending on impact) if the translator adds content that significantly changes the meaning or introduces unwarranted assumptions.

HOW TO DECIDE SEVERITY:

Treat as **error**:
- Glossary term is not used when it should be.
- Wrong or misleading technical term.
- Wrong or altered number, unit, or date.
- Broken or missing tags/placeholders (if present).
- Strong mistranslation that changes meaning.
- Omission or serious addition that affects legal/technical content.

Treat as **warning**:
- Inconsistent but still understandable terminology.
- Style issues (too colloquial, slightly awkward).
- Minor redundancies or slightly clumsy phrasing that does not change meaning.

OUTPUT BEHAVIOR EXAMPLES:

If you find a glossary violation:
{
  "checks": [
    {
      "segment": "rehabilitation of the substation",
      "issue": "Glossary term 'реконструкция' must be translated as 'rehabilitation'. The current translation uses a different term.",
      "severity": "error",
      "suggestion": "rehabilitation of the substation"
    }
  ]
}

If there are multiple issues, return them all in the "checks" array.

If NO issues are found:
{
  "checks": []
}

IMPORTANT CONSTRAINTS:
- ALWAYS return ONLY the JSON object as described.
- NO extra text, NO explanations outside of JSON.
- NO markdown fences (no \`\`\`).
- Ensure the JSON is syntactically valid.
- Prefer fewer, clear, high-quality checks over many vague ones.

Source Text (${request.sourceLocale}):
${request.sourceText}

Target Text (${request.targetLocale}):
${request.targetText}

${glossaryText !== 'No glossary terms provided.' ? `Glossary Terms:
${glossaryText}` : 'No glossary terms provided.'}

Analyze the translation and return ONLY the JSON object with all detected issues.`;

  try {
    const aiProvider = getProvider(provider, apiKey, context?.yandexFolderId);
    
    const response = await aiProvider.callModel({
      prompt: qaPrompt,
      model,
      temperature,
      maxTokens,
      segments: [{ segmentId: 'qa-check', sourceText: request.sourceText }],
    });

    // Parse the JSON response
    let outputText = response.outputText.trim();
    
    // Remove markdown code blocks if present
    if (outputText.startsWith('```json')) {
      outputText = outputText.replace(/^```json\n?/, '').replace(/\n?```$/, '');
    } else if (outputText.startsWith('```')) {
      outputText = outputText.replace(/^```\n?/, '').replace(/\n?```$/, '');
    }

    const parsed = JSON.parse(outputText) as PostEditQAResult;
    
    // Validate structure
    if (!parsed.checks || !Array.isArray(parsed.checks)) {
      logger.warn({ outputText }, 'Invalid QA response structure');
      return { checks: [] };
    }

    // Validate each check
    const validChecks = parsed.checks.filter((check) => {
      return (
        typeof check.segment === 'string' &&
        typeof check.issue === 'string' &&
        (check.severity === 'warning' || check.severity === 'error') &&
        typeof check.suggestion === 'string'
      );
    });

    logger.info(
      {
        sourceText: request.sourceText.substring(0, 50),
        checkCount: validChecks.length,
      },
      'Post-Edit QA completed',
    );

    return { checks: validChecks };
  } catch (error) {
    logger.error({ error, sourceText: request.sourceText.substring(0, 50) }, 'Post-Edit QA failed');
    // Return empty checks on error
    return { checks: [] };
  }
};

export const testAICredentials = async (provider: string, apiKey?: string, yandexFolderId?: string) => {
  const { env } = await import('../utils/env');
  
  try {
    // Validate API key presence
    if (!apiKey && provider !== 'yandex') {
      return {
        success: false,
        message: `API key is required for ${provider}`,
        provider,
        hasApiKey: false,
        hasYandexFolderId: !!yandexFolderId,
        error: 'Missing API key',
      };
    }
    
    if (provider === 'yandex' && (!apiKey || !yandexFolderId)) {
      return {
        success: false,
        message: 'Both API key and Folder ID are required for Yandex GPT',
        provider,
        hasApiKey: !!apiKey,
        hasYandexFolderId: !!yandexFolderId,
        error: 'Missing API key or Folder ID',
      };
    }
    
    const aiProvider = getProvider(provider, apiKey, yandexFolderId);
    
    // Create a simple test request
    const testRequest = {
      prompt: 'Translate "Hello" to Spanish. Return JSON: [{"segment_id":"test","target_mt":"Hola"}]',
      segments: [{ segmentId: 'test', sourceText: 'Hello' }],
      model: undefined,
      temperature: 0.2,
      maxTokens: 100,
    };
    
    logger.info({ provider, hasApiKey: !!apiKey, hasYandexFolderId: !!yandexFolderId }, 'Testing AI credentials');
    
    const response = await aiProvider.callModel(testRequest);
    
    // Check if we got a valid response (not a mock)
    const isMock = response.usage?.metadata?.mock === true;
    
    if (isMock) {
      logger.warn({ provider }, 'Credentials test returned mock response - credentials may be invalid');
    }
    
    return {
      success: !isMock,
      message: isMock 
        ? 'Credentials are invalid or missing. Using mock response.' 
        : 'Credentials are valid.',
      provider,
      hasApiKey: !!apiKey,
      hasYandexFolderId: !!yandexFolderId,
      usage: response.usage,
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    const errorStack = error instanceof Error ? error.stack : undefined;
    
    // Check if it's a permission error (403)
    const isPermissionError = errorMessage.toLowerCase().includes('permission') || 
                             errorMessage.toLowerCase().includes('denied') ||
                             errorMessage.includes('403');
    
    // Check if it's an authentication error (401)
    const isAuthError = errorMessage.includes('401') || 
                       errorMessage.toLowerCase().includes('unauthorized') ||
                       errorMessage.toLowerCase().includes('invalid api key') ||
                       errorMessage.toLowerCase().includes('authentication');
    
    let userMessage = errorMessage;
    if (isPermissionError) {
      userMessage = `Permission denied: The API key and Folder ID are valid, but the service account doesn't have permission to access the Yandex Cloud resources (folder, cloud, or organization). Please check IAM roles and permissions in Yandex Cloud.`;
    } else if (isAuthError) {
      userMessage = `Authentication failed: The API key or Folder ID is invalid. Please check your credentials.`;
    }
    
    logger.error({
      error: errorMessage,
      errorStack,
      provider,
      hasApiKey: !!apiKey,
      hasYandexFolderId: !!yandexFolderId,
      isPermissionError,
      isAuthError,
    }, 'Failed to test AI credentials');
    
    return {
      success: false,
      message: userMessage,
      provider,
      hasApiKey: !!apiKey,
      hasYandexFolderId: !!yandexFolderId,
      error: errorMessage,
    };
  }
};

/**
 * Get debug information for a segment to help understand translation decisions
 */
export const getSegmentDebugInfo = async (segmentId: string) => {
  const segment = await getSegmentWithDocument(segmentId);
  if (!segment || !segment.document) {
    throw ApiError.notFound('Segment not found');
  }

  const context = await buildAiContext(segment.document.projectId);
  
  // 1. Get TM matches (all matches, not just the best one)
  const tmMatches = await searchTranslationMemory({
    sourceText: segment.sourceText,
    sourceLocale: segment.document.sourceLocale,
    targetLocale: segment.document.targetLocale,
    projectId: segment.document.projectId,
    limit: 10, // Get top 10 matches for debugging
    minScore: 0, // Get all matches, even low scores
  });

  // 2. Get neighbor segments for context
  const neighborSegments = await prisma.segment.findMany({
    where: {
      documentId: segment.document.id,
      segmentIndex: {
        in: [segment.segmentIndex - 1, segment.segmentIndex + 1],
      },
    },
    select: { segmentIndex: true, sourceText: true, targetFinal: true, targetMt: true },
  });
  const previous = neighborSegments.find((item) => item.segmentIndex === segment.segmentIndex - 1);
  const next = neighborSegments.find((item) => item.segmentIndex === segment.segmentIndex + 1);

  // 3. Get glossary entries relevant to this segment
  const documentContext: DocumentContext = {
    projectDomain: context.projectMeta.domain,
    projectClient: context.projectMeta.client,
    documentName: segment.document.name,
    documentType: undefined,
  };
  const filteredGlossary = await getRelevantGlossaryEntries(
    segment.sourceText,
    segment.document.sourceLocale,
    segment.document.targetLocale,
    segment.document.projectId,
    documentContext,
  );

  // Map to API format for display
  const relevantGlossaryEntries = filteredGlossary.map(entry => ({
    sourceTerm: entry.term,
    targetTerm: entry.translation,
    isForbidden: entry.forbidden || false,
    notes: entry.notes,
  }));

  // 4. Build the prompt that would be used for translation
  const orchestratorSegment = buildOrchestratorSegment(segment, previous, next, segment.document.name ?? undefined);
  
  // Get TM examples for RAG (using default settings)
  const tmExamples = tmMatches.slice(0, 5).map((match) => ({
    sourceText: match.sourceText,
    targetText: match.targetText,
    fuzzyScore: match.fuzzyScore,
    searchMethod: match.searchMethod || 'fuzzy',
  }));

  // Fetch document with summary and Document DNA
  const documentWithSummary = await prisma.document.findUnique({
    where: { id: segment.document.id },
    select: {
      name: true,
      summary: true,
      clusterSummary: true,
      documentDna: {
        select: {
          technicalSchema: true,
          namingConventions: true,
          abbreviationLogic: true,
          entityGroups: true,
        },
      },
    },
  });

  const documentDnaDebug = documentWithSummary?.documentDna
    ? {
        technicalSchema: documentWithSummary.documentDna.technicalSchema as Record<string, unknown> | null | undefined,
        namingConventions: documentWithSummary.documentDna.namingConventions as Record<string, unknown> | null | undefined,
        abbreviationLogic: documentWithSummary.documentDna.abbreviationLogic as Record<string, unknown> | null | undefined,
        entityGroups: documentWithSummary.documentDna.entityGroups as Record<string, unknown> | null | undefined,
      }
    : undefined;

  const prompt = orchestrator.buildPromptForSegment(orchestratorSegment, {
    segments: [orchestratorSegment],
    project: context.projectMeta,
    guidelines: context.guidelines,
    glossary: filteredGlossary,
    tmExamples,
    sourceLocale: segment.document.sourceLocale,
    targetLocale: segment.document.targetLocale,
    document: documentWithSummary ? {
      name: documentWithSummary.name,
      summary: documentWithSummary.summary ?? undefined,
      clusterSummary: documentWithSummary.clusterSummary ?? undefined,
    } : undefined,
    documentDna: documentDnaDebug,
  });

  return {
    segment: {
      id: segment.id,
      segmentIndex: segment.segmentIndex,
      sourceText: segment.sourceText,
      targetMt: segment.targetMt,
      targetFinal: segment.targetFinal,
      fuzzyScore: segment.fuzzyScore,
      bestTmEntryId: segment.bestTmEntryId,
    },
    tmMatches: tmMatches.map(match => ({
      id: match.id,
      sourceText: match.sourceText,
      targetText: match.targetText,
      fuzzyScore: match.fuzzyScore,
      searchMethod: match.searchMethod || 'fuzzy',
      scope: match.scope,
    })),
    glossaryTerms: relevantGlossaryEntries,
    context: {
      previous: previous ? {
        segmentIndex: previous.segmentIndex,
        sourceText: previous.sourceText,
        targetText: previous.targetFinal || previous.targetMt,
      } : null,
      next: next ? {
        segmentIndex: next.segmentIndex,
        sourceText: next.sourceText,
        targetText: next.targetFinal || next.targetMt,
      } : null,
    },
    prompt,
    document: {
      name: segment.document.name,
      sourceLocale: segment.document.sourceLocale,
      targetLocale: segment.document.targetLocale,
    },
  };
};
