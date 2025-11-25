# TM Search and AI Translation Accuracy Improvements

**Date:** November 2025  
**Status:** Analysis and Recommendations

---

## Executive Summary

This document analyzes the current implementation of Translation Memory (TM) search and AI translation accuracy, identifies potential issues, and proposes concrete improvements to enhance relevancy and accuracy.

---

## 1. Current TM Search Implementation Analysis

### 1.1 How TM Search Currently Works

**Three Search Methods:**

1. **Fuzzy Search** (Text-based):
   - Uses Levenshtein distance (70% weight)
   - Token overlap ratio (30% weight)
   - Pre-filters candidates by length and word overlap
   - Scores all candidates and filters by `minScore` threshold

2. **Vector Search** (Semantic):
   - Uses OpenAI embeddings (1536 dimensions)
   - Cosine similarity search
   - Filters by `minSimilarity` threshold (default 0.7 = 70%)

3. **Hybrid Search**:
   - Combines fuzzy + vector results
   - Deduplicates entries found by both methods
   - Marks as 'hybrid' if found by both

### 1.2 Identified Issues

#### Issue 1: Pre-filtering Too Aggressive
**Location:** `tm.service.ts` lines 313-350

**Problem:**
```typescript
// Current pre-filtering logic
const sourceWords = normalizedSource.split(/\s+/).filter(Boolean);
const candidateWords = normalizedCandidate.split(/\s+/).filter(Boolean);
const wordOverlap = candidateWords.filter(w => sourceWords.includes(w)).length;
const wordOverlapRatio = wordOverlap / Math.max(sourceWords.length, candidateWords.length, 1);

// Filters out candidates with < 30% word overlap BEFORE scoring
if (wordOverlapRatio < 0.3) {
  continue; // Skip this candidate
}
```

**Impact:**
- May filter out semantically similar but lexically different translations
- Example: "Проект влечет за собой отвод земель" vs "Проект предусматривает изъятие земельных участков"
  - Different words but similar meaning
  - Would be filtered out before scoring

**Recommendation:**
- Reduce word overlap threshold from 30% to 15-20%
- Or remove pre-filtering entirely and rely on fuzzy score
- Let vector search handle semantic similarity

#### Issue 2: No Domain/Client Filtering
**Location:** `tm.service.ts` search function

**Problem:**
- Search doesn't prioritize entries from same client/domain
- Project-specific entries aren't weighted higher
- Global entries compete equally with project entries

**Impact:**
- Less relevant matches may appear before project-specific ones
- Example: Legal domain entry might appear before technical domain entry

**Recommendation:**
- Add domain/client matching to scoring
- Boost score by +5-10% for matching domain
- Boost score by +5-10% for matching client
- Prioritize project entries over global entries

#### Issue 3: Fuzzy Score Formula May Not Be Optimal
**Location:** `utils/fuzzy.ts` line 48

**Current Formula:**
```typescript
const score = Math.round((levenshteinRatio * 0.7 + tokenOverlapRatio * 0.3) * 100);
```

**Problem:**
- Levenshtein distance is character-based, may not capture semantic similarity
- Token overlap is word-based, better for terminology
- 70/30 split may not be optimal for all languages

**Recommendation:**
- Consider language-specific weights
- For languages with rich morphology (Russian, German), increase token overlap weight
- For languages with simpler morphology (English), current ratio may be fine
- Add configurable weights per language pair

#### Issue 4: Vector Search Threshold Too High
**Location:** `vector-search.service.ts` line 33

**Current:**
```typescript
const minSimilarity = options.minSimilarity ?? 0.7; // Default 70% similarity
```

**Problem:**
- 70% similarity threshold may be too strict
- Many relevant semantic matches may be filtered out
- User-adjustable threshold (50-100%) but default is high

**Recommendation:**
- Lower default to 0.6 (60%)
- Add adaptive threshold based on result count
- If few results, lower threshold automatically

#### Issue 5: No Quality Scoring
**Location:** `tm.service.ts` scoring logic

**Problem:**
- Doesn't consider:
  - Usage count (how often entry was used)
  - Entry age (newer entries may be more relevant)
  - Confirmation status (confirmed entries are more reliable)
  - Match history (entries that matched well before)

**Recommendation:**
- Add quality boost factors:
  - Usage count: +1% per 10 uses (max +10%)
  - Recent usage: +5% if used in last 30 days
  - Confirmed source: +5% if from confirmed segment

#### Issue 6: Hybrid Merge Logic
**Location:** `tm.service.ts` lines 500-600

**Problem:**
- Hybrid matches may not be properly prioritized
- Vector results converted to fuzzy score (0-100) may lose precision
- Merge logic may not optimally combine scores

**Recommendation:**
- For hybrid matches, use weighted average:
  - `hybridScore = (fuzzyScore * 0.6 + vectorScore * 0.4)`
- Prioritize hybrid matches over pure fuzzy/vector
- Add explicit "hybrid boost" (+5-10%)

---

## 2. Current AI Translation Implementation Analysis

### 2.1 How AI Translation Currently Works

**Prompt Structure:**
1. Translation task description
2. Translation examples (top 5 TM matches) - RAG
3. Project context
4. Translation guidelines
5. Glossary
6. Final reminder (if high-quality match exists)
7. Segments to translate

**Context Provided:**
- TM examples (top 5, min 50% match)
- Glossary entries (up to 200)
- Guidelines (project rules)
- Neighbor segments (previous/next)
- Project metadata (client, domain)

### 2.2 Identified Issues

#### Issue 1: Examples Section Too Generic
**Location:** `ai/orchestrator.ts` lines 100-129

**Current:**
```typescript
return [
  '=== TRANSLATION EXAMPLES (Learn from these) ===',
  'These are similar translations from your translation memory...',
  'IMPORTANT:',
  '- Use the terminology and phrasing style from these examples',
  '- Match the translation approach shown above',
  // ... generic instructions
];
```

**Problem:**
- Doesn't emphasize high-quality matches enough
- Doesn't distinguish between 50% and 95% matches
- Generic instructions may not be strong enough

**Recommendation:**
- Add match quality-based instructions:
  - 90%+ matches: "CRITICAL: Use this example's terminology exactly"
  - 75-89%: "IMPORTANT: Follow this example's style closely"
  - 50-74%: "Consider this example for terminology"
- Add explicit examples showing how to adapt
- Emphasize hybrid matches more strongly

#### Issue 2: No Explicit Terminology Enforcement
**Location:** `ai/orchestrator.ts` prompt building

**Problem:**
- Glossary is listed but not emphasized enough
- No explicit instruction to check glossary first
- AI may use alternative terms even when glossary exists

**Recommendation:**
- Add explicit glossary check instruction:
  ```
  CRITICAL: Before translating, check the glossary below.
  If a term appears in the glossary, you MUST use the exact translation specified.
  Do NOT use synonyms or alternatives.
  ```
- List glossary terms that appear in source text
- Add glossary violations to QA checks

#### Issue 3: Guidelines Not Strong Enough
**Location:** `ai/orchestrator.ts` lines 77-99

**Current:**
```typescript
private buildGuidelineSection(guidelines?: string[]) {
  if (!guidelines || guidelines.length === 0) {
    return '1. Follow standard professional translation practices.\n2. Preserve formatting, tags, and placeholders.';
  }
  return guidelines.map((rule, index) => `${index + 1}. ${rule}`).join('\n');
}
```

**Problem:**
- Guidelines are just listed, not emphasized
- No priority or criticality indication
- May be ignored if examples suggest different approach

**Recommendation:**
- Add emphasis based on guideline type:
  - Term-specific rules: "CRITICAL TERMINOLOGY RULE"
  - Style rules: "IMPORTANT STYLE GUIDELINE"
  - General rules: "GUIDELINE"
- Add explicit instruction: "Guidelines override examples if they conflict"
- Extract and emphasize term-specific rules (e.g., "переводи X - Y")

#### Issue 4: Temperature May Be Too Low
**Location:** `ai/orchestrator.ts` line 300

**Current:**
```typescript
temperature: options.temperature ?? 0.2,
```

**Problem:**
- Temperature 0.2 is very low (deterministic)
- May not adapt well to context
- May be too rigid with examples

**Recommendation:**
- Increase default to 0.3-0.4 for better adaptation
- Make temperature configurable per project
- Use lower temperature (0.1-0.2) for technical/legal
- Use higher temperature (0.4-0.5) for creative content

#### Issue 5: No Post-Translation Validation
**Location:** `ai/service.ts` translation functions

**Problem:**
- AI translation is returned as-is
- No validation against glossary
- No check for guideline compliance
- No quality scoring

**Recommendation:**
- Add post-translation validation:
  - Check glossary terms are used correctly
  - Verify guidelines are followed
  - Score translation quality
- Flag violations for user review
- Suggest corrections automatically

#### Issue 6: Limited Context Window
**Location:** `ai/orchestrator.ts` prompt building

**Problem:**
- Only includes top 5 TM examples
- May miss relevant examples ranked 6-10
- Neighbor segments may not provide enough context

**Recommendation:**
- Increase examples to top 10 (if available)
- Add document-level context (document summary, title)
- Include more neighbor segments (previous 2, next 2)
- Add document type context (legal, technical, marketing)

---

## 3. Proposed Improvements

### 3.1 TM Search Improvements

#### Improvement 1: Enhanced Scoring Algorithm

**File:** `backend/src/utils/fuzzy.ts`

**Changes:**
```typescript
export type FuzzyScoreBreakdown = {
  score: number;
  levenshteinRatio: number;
  tokenOverlapRatio: number;
  domainMatch?: boolean;
  clientMatch?: boolean;
  qualityBoost?: number;
};

export const computeFuzzyScore = (
  source: string, 
  candidate: string,
  options?: {
    domainMatch?: boolean;
    clientMatch?: boolean;
    usageCount?: number;
    isProjectEntry?: boolean;
  }
): FuzzyScoreBreakdown => {
  // ... existing calculation ...
  
  let qualityBoost = 0;
  
  // Domain match boost
  if (options?.domainMatch) {
    qualityBoost += 5;
  }
  
  // Client match boost
  if (options?.clientMatch) {
    qualityBoost += 5;
  }
  
  // Project entry boost
  if (options?.isProjectEntry) {
    qualityBoost += 3;
  }
  
  // Usage count boost (1% per 10 uses, max 10%)
  if (options?.usageCount) {
    qualityBoost += Math.min(10, Math.floor(options.usageCount / 10));
  }
  
  const finalScore = Math.min(100, baseScore + qualityBoost);
  
  return {
    score: finalScore,
    levenshteinRatio,
    tokenOverlapRatio,
    domainMatch: options?.domainMatch,
    clientMatch: options?.clientMatch,
    qualityBoost,
  };
};
```

#### Improvement 2: Relaxed Pre-filtering

**File:** `backend/src/services/tm.service.ts`

**Changes:**
```typescript
// Reduce word overlap threshold from 30% to 15%
const MIN_WORD_OVERLAP_RATIO = 0.15; // Was 0.3

// Or remove pre-filtering entirely for vector results
if (entry.searchMethod === 'vector') {
  // Don't pre-filter vector results, they're already semantically similar
  // Score them directly
} else {
  // Apply pre-filtering only to fuzzy candidates
  if (wordOverlapRatio < MIN_WORD_OVERLAP_RATIO) {
    continue;
  }
}
```

#### Improvement 3: Adaptive Vector Threshold

**File:** `backend/src/services/vector-search.service.ts`

**Changes:**
```typescript
export async function searchByVector(
  queryEmbedding: number[],
  options: {
    // ... existing options
    adaptiveThreshold?: boolean; // New option
  },
): Promise<Array<TranslationMemoryEntry & { similarity: number }>> {
  let minSimilarity = options.minSimilarity ?? 0.6; // Lower default to 0.6
  
  if (options.adaptiveThreshold) {
    // First try with strict threshold
    let results = await searchWithThreshold(minSimilarity);
    
    // If few results, lower threshold
    if (results.length < 5 && minSimilarity > 0.5) {
      minSimilarity = Math.max(0.5, minSimilarity - 0.1);
      results = await searchWithThreshold(minSimilarity);
    }
    
    return results;
  }
  
  return searchWithThreshold(minSimilarity);
}
```

#### Improvement 4: Enhanced Hybrid Scoring

**File:** `backend/src/services/tm.service.ts`

**Changes:**
```typescript
// When merging fuzzy and vector results
const hybridScore = (fuzzyScore: number, vectorScore: number): number => {
  // Weighted average: fuzzy 60%, vector 40%
  const baseScore = (fuzzyScore * 0.6) + (vectorScore * 100 * 0.4);
  
  // Hybrid boost: +5% for being found by both methods
  return Math.min(100, baseScore + 5);
};

// Mark as hybrid and apply boost
if (foundByBoth) {
  result.searchMethod = 'hybrid';
  result.fuzzyScore = hybridScore(result.fuzzyScore, vectorResult.similarity);
}
```

### 3.2 AI Translation Improvements

#### Improvement 1: Quality-Based Example Instructions

**File:** `backend/src/ai/orchestrator.ts`

**Changes:**
```typescript
private buildTranslationExamplesSection(tmExamples?: TmExample[]) {
  if (!tmExamples || tmExamples.length === 0) {
    return 'No translation examples available. Use your best judgment based on the glossary and guidelines.';
  }

  const topExamples = tmExamples.slice(0, 10); // Increase to 10
  
  // Group examples by quality
  const criticalExamples = topExamples.filter(ex => ex.fuzzyScore >= 90);
  const importantExamples = topExamples.filter(ex => ex.fuzzyScore >= 75 && ex.fuzzyScore < 90);
  const referenceExamples = topExamples.filter(ex => ex.fuzzyScore < 75);
  
  const examplesText = topExamples
    .map((ex, i) => {
      const methodLabel = ex.searchMethod === 'hybrid' ? 'HYBRID (semantic + text match)' 
        : ex.searchMethod === 'vector' ? 'semantic match'
        : 'text match';
      
      let qualityLabel = '';
      if (ex.fuzzyScore >= 90) {
        qualityLabel = '🚨 CRITICAL MATCH';
      } else if (ex.fuzzyScore >= 75) {
        qualityLabel = '⚠️ HIGH QUALITY';
      }
      
      return `Example ${i + 1}${qualityLabel ? ` (${qualityLabel})` : ''}:\n  Source: "${ex.sourceText}"\n  Target: "${ex.targetText}"\n  Match Quality: ${ex.fuzzyScore}% (${methodLabel})`;
    })
    .join('\n\n');

  let instructions: string[] = [
    '=== TRANSLATION EXAMPLES (Learn from these) ===',
    '',
  ];
  
  if (criticalExamples.length > 0) {
    instructions.push(
      '🚨 CRITICAL MATCHES (90%+):',
      'These examples are nearly identical to your source text.',
      'You MUST use the exact terminology and phrasing from these examples.',
      'Only adapt if the source text has minor differences.',
      '',
    );
  }
  
  if (importantExamples.length > 0) {
    instructions.push(
      '⚠️ HIGH QUALITY MATCHES (75-89%):',
      'These examples are very similar to your source text.',
      'Follow their terminology and style closely.',
      'Adapt the structure to match your source text exactly.',
      '',
    );
  }
  
  if (referenceExamples.length > 0) {
    instructions.push(
      'REFERENCE EXAMPLES (50-74%):',
      'These examples are somewhat similar.',
      'Use them for terminology and style guidance.',
      'Do not copy them directly - adapt to your source text.',
      '',
    );
  }
  
  instructions.push(
    examplesText,
    '',
    'CRITICAL RULES:',
    '1. For 90%+ matches: Use terminology EXACTLY as shown',
    '2. For hybrid matches: These are most reliable - follow them closely',
    '3. Always translate ONLY what is in your source text - do not add extra information',
    '4. If examples show different terminology, prefer the one from highest-scoring example',
  );
  
  return instructions.join('\n');
}
```

#### Improvement 2: Enhanced Glossary Enforcement

**File:** `backend/src/ai/orchestrator.ts`

**Changes:**
```typescript
private buildGlossarySection(glossary?: OrchestratorGlossaryEntry[], sourceText?: string) {
  if (!glossary || glossary.length === 0) {
    return 'No glossary enforcement required.';
  }
  
  // Find glossary terms that appear in source text
  const sourceLower = sourceText?.toLowerCase() || '';
  const relevantTerms = glossary.filter(entry => 
    sourceLower.includes(entry.term.toLowerCase())
  );
  
  const allEntries = glossary
    .slice(0, 200)
    .map(
      (entry) =>
        `- ${entry.term} => ${entry.translation}${entry.forbidden ? ' (FORBIDDEN TERM: do not translate differently)' : ''}${
          entry.notes ? ` | Notes: ${entry.notes}` : ''
        }`,
    )
    .join('\n');
  
  let section = [
    '=== GLOSSARY (MUST BE ENFORCED) ===',
    '',
  ];
  
  if (relevantTerms.length > 0) {
    section.push(
      '🚨 TERMS FOUND IN SOURCE TEXT (MUST USE EXACTLY):',
      relevantTerms.map(term => `- "${term.term}" MUST be translated as "${term.translation}"`).join('\n'),
      '',
    );
  }
  
  section.push(
    'Full Glossary:',
    allEntries,
    '',
    'CRITICAL:',
    '1. If a term appears in the glossary, you MUST use the exact translation specified',
    '2. Do NOT use synonyms, alternatives, or variations',
    '3. Glossary terms override all other sources (examples, guidelines)',
    '4. If unsure, check the glossary first',
  );
  
  return section.join('\n');
}
```

#### Improvement 3: Post-Translation Validation

**File:** `backend/src/services/ai.service.ts`

**New Function:**
```typescript
async function validateAITranslation(
  sourceText: string,
  targetText: string,
  glossary: OrchestratorGlossaryEntry[],
  guidelines: string[],
): Promise<{
  isValid: boolean;
  violations: Array<{
    type: 'glossary' | 'guideline' | 'format';
    severity: 'error' | 'warning';
    message: string;
    suggestion?: string;
  }>;
}> {
  const violations: Array<{
    type: 'glossary' | 'guideline' | 'format';
    severity: 'error' | 'warning';
    message: string;
    suggestion?: string;
  }> = [];
  
  // Check glossary compliance
  for (const entry of glossary) {
    const sourceLower = sourceText.toLowerCase();
    if (sourceLower.includes(entry.term.toLowerCase())) {
      const targetLower = targetText.toLowerCase();
      if (!targetLower.includes(entry.translation.toLowerCase())) {
        violations.push({
          type: 'glossary',
          severity: entry.forbidden ? 'error' : 'warning',
          message: `Glossary term "${entry.term}" should be translated as "${entry.translation}"`,
          suggestion: `Replace with "${entry.translation}"`,
        });
      }
    }
  }
  
  // Check for formatting tags
  const sourceTags = sourceText.match(/<[^>]+>/g) || [];
  const targetTags = targetText.match(/<[^>]+>/g) || [];
  if (sourceTags.length !== targetTags.length) {
    violations.push({
      type: 'format',
      severity: 'error',
      message: `Formatting tags mismatch: source has ${sourceTags.length}, target has ${targetTags.length}`,
    });
  }
  
  return {
    isValid: violations.filter(v => v.severity === 'error').length === 0,
    violations,
  };
}
```

#### Improvement 4: Adaptive Temperature

**File:** `backend/src/services/ai.service.ts`

**Changes:**
```typescript
const getOptimalTemperature = (
  projectDomain?: string,
  defaultTemp?: number,
): number => {
  if (defaultTemp !== undefined) {
    return defaultTemp;
  }
  
  // Domain-based defaults
  const domainDefaults: Record<string, number> = {
    'legal': 0.1,
    'technical': 0.15,
    'medical': 0.1,
    'marketing': 0.4,
    'creative': 0.5,
  };
  
  return domainDefaults[projectDomain?.toLowerCase() || ''] ?? 0.3;
};
```

---

## 4. Implementation Priority

### Phase 1: Quick Wins (High Impact, Low Effort)
1. ✅ Relax pre-filtering threshold (30% → 15%)
2. ✅ Lower vector search default threshold (0.7 → 0.6)
3. ✅ Enhance example instructions with quality labels
4. ✅ Add glossary term highlighting in prompt

### Phase 2: Medium Effort (High Impact)
1. ✅ Add domain/client matching to scoring
2. ✅ Implement hybrid score boost
3. ✅ Add post-translation validation
4. ✅ Increase examples from 5 to 10

### Phase 3: Advanced (Medium Impact, Higher Effort)
1. ✅ Add usage count to scoring
2. ✅ Implement adaptive thresholds
3. ✅ Add language-specific fuzzy weights
4. ✅ Implement quality boost factors

---

## 5. Testing Recommendations

### 5.1 TM Search Testing

**Test Cases:**
1. **Exact Match**: Should return 100% score
2. **High Similarity (90%+)**: Should appear first
3. **Semantic Match**: Vector search should find semantically similar but lexically different
4. **Domain Match**: Same domain should boost score
5. **Project vs Global**: Project entries should rank higher

**Metrics:**
- Precision@5: Are top 5 results relevant?
- Recall: Are all relevant results found?
- Ranking quality: Are best matches ranked first?

### 5.2 AI Translation Testing

**Test Cases:**
1. **Glossary Compliance**: Does AI use glossary terms?
2. **Example Following**: Does AI follow high-quality examples?
3. **Guideline Adherence**: Are guidelines followed?
4. **Terminology Consistency**: Is terminology consistent across segments?

**Metrics:**
- Glossary compliance rate
- Example following rate (for 90%+ matches)
- User edit rate (lower = better)
- QA error rate

---

## 6. Monitoring and Metrics

### 6.1 TM Search Metrics

Track:
- Average match score
- Search result count
- User acceptance rate (apply vs ignore)
- Hybrid match rate
- Vector vs fuzzy match distribution

### 6.2 AI Translation Metrics

Track:
- Glossary compliance rate
- Example following rate
- Post-validation violation rate
- User edit distance (how much users change AI output)
- Translation quality score

---

## Conclusion

The proposed improvements address key accuracy and relevancy issues:

1. **TM Search**: Better scoring, relaxed filtering, quality boosts
2. **AI Translation**: Stronger instructions, better context, validation

Implementation should be phased, starting with quick wins and progressing to advanced features.

**Next Steps:**
1. Review and approve improvements
2. Implement Phase 1 improvements
3. Test with real data
4. Measure impact
5. Iterate based on results



