import { prisma } from '../db/prisma';
import { logger } from '../utils/logger';
import { generateEmbedding } from './embedding.service';
import { searchGlossaryByVector } from './vector-search.service';
import { env } from '../utils/env';
import type { GlossaryEntry as PrismaGlossaryEntry } from '@prisma/client';

export type GlossarySearchResult = {
  id: string;
  sourceTerm: string;
  targetTerm: string;
  sourceLocale: string;
  targetLocale: string;
  isForbidden: boolean;
  similarity: number;
  matchMethod: 'exact' | 'semantic' | 'hybrid';
};

export type GlossarySearchOptions = {
  sourceText: string;
  sourceLocale?: string;
  targetLocale?: string;
  projectId?: string;
  minSimilarity?: number; // For semantic matching (0-1)
  useSemanticSearch?: boolean; // Whether to use semantic search (default: true for phrases)
};

/**
 * Search glossary entries using both exact and semantic matching
 * For single words: uses exact matching
 * For phrases: uses semantic matching with exact fallback
 */
export async function searchGlossaryEntries(
  options: GlossarySearchOptions,
): Promise<GlossarySearchResult[]> {
  const {
    sourceText,
    sourceLocale,
    targetLocale,
    projectId,
    minSimilarity = 0.75, // Default 75% similarity for phrases
    useSemanticSearch = true,
  } = options;

  if (!sourceText || !sourceText.trim()) {
    return [];
  }

  const results: GlossarySearchResult[] = [];
  const sourceLower = sourceText.toLowerCase().trim();

  // Build WHERE clause for exact matching
  const whereClause: any = {};
  if (projectId) {
    whereClause.OR = [
      { projectId },
      { projectId: null }, // Include global entries
    ];
  }
  if (sourceLocale) {
    whereClause.sourceLocale = sourceLocale;
  }
  if (targetLocale) {
    whereClause.targetLocale = targetLocale;
  }

  // Strategy 1: Exact substring matching (always check this first)
  const exactMatches = await prisma.glossaryEntry.findMany({
    where: whereClause,
    select: {
      id: true,
      sourceTerm: true,
      targetTerm: true,
      sourceLocale: true,
      targetLocale: true,
      isForbidden: true,
    },
  });

  // Check for exact matches
  for (const entry of exactMatches) {
    const termLower = entry.sourceTerm.toLowerCase();
    
    // Check if sourceTerm appears in sourceText (exact substring match)
    if (sourceLower.includes(termLower)) {
      // Check if it's a whole word match (for single words) or phrase match
      const isSingleWord = !termLower.includes(' ');
      const isWholeWordMatch = isSingleWord
        ? new RegExp(`\\b${termLower.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(sourceText)
        : true; // For phrases, substring match is acceptable

      if (isWholeWordMatch || !isSingleWord) {
        results.push({
          id: entry.id,
          sourceTerm: entry.sourceTerm,
          targetTerm: entry.targetTerm,
          sourceLocale: entry.sourceLocale,
          targetLocale: entry.targetLocale,
          isForbidden: entry.isForbidden,
          similarity: 1.0, // Exact match = 100%
          matchMethod: 'exact',
        });
      }
    }
  }

  // Strategy 2: Semantic matching (for phrases and variations)
  if (useSemanticSearch && env.openAiApiKey) {
    try {
      // Generate embedding for source text
      const queryEmbedding = await generateEmbedding(sourceText, true);

      // Search using vector similarity
      const semanticMatches = await searchGlossaryByVector(queryEmbedding, {
        projectId,
        sourceLocale,
        targetLocale,
        limit: 10,
        minSimilarity,
      });

      // Add semantic matches that weren't already found by exact matching
      const exactMatchIds = new Set(results.map((r) => r.id));
      
      for (const match of semanticMatches) {
        if (exactMatchIds.has(match.id)) {
          // Update existing result to mark as hybrid
          const existingIndex = results.findIndex((r) => r.id === match.id);
          if (existingIndex >= 0) {
            results[existingIndex].matchMethod = 'hybrid';
            // Keep higher similarity (exact = 1.0)
          }
        } else {
          // New semantic match
          results.push({
            ...match,
            matchMethod: 'semantic',
          });
        }
      }
    } catch (error: any) {
      logger.warn(
        {
          error: error.message,
          sourceText: sourceText.substring(0, 50),
        },
        'Semantic glossary search failed, using exact matches only',
      );
      // Continue with exact matches only
    }
  }

  // Sort results: exact matches first, then by similarity
  results.sort((a, b) => {
    // Exact matches first
    if (a.matchMethod === 'exact' && b.matchMethod !== 'exact') return -1;
    if (b.matchMethod === 'exact' && a.matchMethod !== 'exact') return 1;
    
    // Then by similarity (higher first)
    return b.similarity - a.similarity;
  });

  return results;
}

/**
 * Find relevant glossary entries for a source text
 * Returns entries that should be enforced in translation
 */
export async function findRelevantGlossaryEntries(
  sourceText: string,
  options: {
    projectId?: string;
    sourceLocale?: string;
    targetLocale?: string;
    minSimilarity?: number;
  },
): Promise<Array<{
  id: string;
  sourceTerm: string;
  targetTerm: string;
  isForbidden: boolean;
  similarity: number;
  matchMethod: 'exact' | 'semantic' | 'hybrid';
}>> {
  const matches = await searchGlossaryEntries({
    sourceText,
    ...options,
    useSemanticSearch: true,
  });

  // Filter to only high-confidence matches
  // For exact matches: always include
  // For semantic matches: only include if similarity >= 0.8 (80%)
  return matches
    .filter((match) => match.matchMethod === 'exact' || match.similarity >= 0.8)
    .map((match) => ({
      id: match.id,
      sourceTerm: match.sourceTerm,
      targetTerm: match.targetTerm,
      isForbidden: match.isForbidden,
      similarity: match.similarity,
      matchMethod: match.matchMethod,
    }));
}

