# Using Vector Search to Enhance AI Translations

## Current State

**Current Flow**:
1. Search TM for matches (≥70% threshold)
2. If match found → Use TM directly (no AI)
3. If NO match → Call AI with context (glossary, guidelines, neighbors)

**Problem**: Even when vector search finds semantically similar matches (60-69%), they're ignored. The AI doesn't see these examples.

## Proposed Enhancement: RAG-Enhanced AI Translation

### Concept

Use vector search results as **few-shot examples** in the AI prompt, even when they don't meet the 70% threshold. This teaches the AI:
- Domain-specific terminology
- Translation style
- Contextual patterns
- Project-specific phrasing

### Implementation

#### Step 1: Retrieve Vector Examples

When AI translation is needed, retrieve top 3-5 vector/hybrid matches (even if <70%):

```typescript
// In runSegmentMachineTranslation()
const tmExamples = await searchTranslationMemory({
  sourceText: segment.sourceText,
  sourceLocale: segment.document.sourceLocale,
  targetLocale: segment.document.targetLocale,
  projectId: segment.document.projectId,
  limit: 5,  // Get more examples
  minScore: 50,  // Lower threshold for examples
  vectorSimilarity: 60,  // Include semantic matches
});
```

#### Step 2: Add Examples to AI Prompt

Enhance the orchestrator prompt to include TM examples:

```typescript
// In buildBatchPrompt()
private buildTranslationExamplesSection(tmExamples: TmSearchResult[]) {
  if (!tmExamples || tmExamples.length === 0) {
    return 'No translation examples available.';
  }
  
  return [
    '=== TRANSLATION EXAMPLES (Learn from these) ===',
    'These are similar translations from your translation memory:',
    tmExamples
      .slice(0, 5)  // Top 5 examples
      .map((ex, i) => 
        `${i + 1}. Source: "${ex.sourceText}"\n   Target: "${ex.targetText}"\n   Match: ${ex.fuzzyScore}% (${ex.searchMethod})`
      )
      .join('\n\n'),
    '',
    'Use these examples to guide your translation style, terminology, and phrasing.',
  ].join('\n');
}
```

#### Step 3: Enhanced Prompt Structure

```
You are a professional technical/legal translator.

=== TRANSLATION TASK ===
Translate from Russian to English.

=== TRANSLATION EXAMPLES (Learn from these) ===
1. Source: "Проект влечет за собой отвод земель"
   Target: "The project entails land acquisition"
   Match: 80% (hybrid)

2. Source: "Связанные с этим мероприятия"
   Target: "Associated impacts"
   Match: 75% (vector)

[... more examples ...]

Use these examples to guide your translation style.

=== GLOSSARY ===
[...]

=== SEGMENTS TO TRANSLATE ===
[...]
```

### Benefits

1. **Better Terminology**: AI learns domain-specific terms from examples
2. **Style Consistency**: Matches project translation style
3. **Context Awareness**: Semantic matches provide relevant context
4. **Quality Improvement**: Even 60% matches help guide the AI

### Example Scenario

**Segment to translate**: "Проект предусматривает мероприятия по охране окружающей среды"

**Vector search finds**:
- "Проект влечет за собой отвод земель" → "The project entails land acquisition" (75% semantic)
- "Мероприятия по охране природы" → "Environmental protection measures" (70% semantic)

**AI sees these examples** and learns:
- Use "entails" for "предусматривает"
- Use "measures" for "мероприятия"
- Use "environmental protection" for "охрана окружающей среды"

**Result**: Better translation that matches project style!

---

## Alternative: Actual Fine-Tuning

### What It Means

Train a custom model specifically on your TM data. This is more complex but can be more effective.

### Requirements

1. **Data Preparation**:
   - Export TM entries as training pairs
   - Format: `{"input": "source", "output": "target"}`
   - Need: 1,000+ high-quality pairs minimum

2. **Fine-Tuning Service**:
   - OpenAI Fine-Tuning API (for GPT models)
   - Google Vertex AI (for Gemini)
   - Custom training infrastructure

3. **Cost**:
   - OpenAI: ~$0.008 per 1K tokens (training)
   - Ongoing: Same as base model
   - One-time: $50-500 depending on dataset size

4. **Process**:
   ```bash
   # Prepare data
   openai tools fine_tunes.prepare_data -f training_data.jsonl
   
   # Start fine-tuning
   openai api fine_tunes.create -t training_data.jsonl -m gpt-4o-mini
   
   # Use fine-tuned model
   openai api completions.create -m ft:gpt-4o-mini:org:model-name
   ```

### Pros & Cons

**Pros**:
- Model "remembers" your translations
- Better consistency
- Can handle domain-specific patterns

**Cons**:
- Expensive ($50-500 one-time)
- Requires 1,000+ examples
- Model versioning complexity
- Slower to update (need retraining)

---

## Recommendation

**Start with RAG Enhancement** (Option 1):
- ✅ Easy to implement
- ✅ No additional cost
- ✅ Immediate benefits
- ✅ Works with any AI provider
- ✅ Easy to update (just add examples)

**Consider Fine-Tuning Later** (Option 2):
- If you have 10,000+ high-quality pairs
- If you need extreme consistency
- If RAG enhancement isn't enough

---

## Implementation Plan

### Phase 1: RAG Enhancement (This Week)

1. **Modify `runSegmentMachineTranslation()`**:
   - Retrieve TM examples even when <70%
   - Pass examples to orchestrator

2. **Enhance `AIOrchestrator.buildBatchPrompt()`**:
   - Add `tmExamples` parameter
   - Include examples section in prompt

3. **Test**:
   - Compare translations with/without examples
   - Measure quality improvement

### Phase 2: Fine-Tuning (Future)

1. **Data Export**:
   - Export confirmed translations as training data
   - Filter for high-quality pairs (confirmed, edited)

2. **Fine-Tuning Setup**:
   - Choose provider (OpenAI recommended)
   - Prepare training data
   - Run fine-tuning job

3. **Integration**:
   - Add fine-tuned model option
   - A/B test vs base model

---

## Code Changes Needed

### 1. Update `ai.service.ts`

```typescript
export const runSegmentMachineTranslation = async (
  segmentId: string,
  options?: MachineTranslationOptions,
) => {
  // ... existing code ...
  
  // Always get TM examples for AI context (even if <70%)
  const tmExamples = await searchTranslationMemory({
    sourceText: segment.sourceText,
    sourceLocale: segment.document.sourceLocale,
    targetLocale: segment.document.targetLocale,
    projectId: segment.document.projectId,
    limit: 5,
    minScore: 50,  // Lower threshold for examples
    vectorSimilarity: 60,
  });

  if (!translationText) {
    const aiResult = await orchestrator.translateSingleSegment(
      buildOrchestratorSegment(segment, previous, next, segment.document.name),
      {
        // ... existing options ...
        tmExamples: tmExamples.slice(0, 5),  // Pass examples
      },
    );
    // ...
  }
};
```

### 2. Update `orchestrator.ts`

```typescript
export type TranslateSegmentsOptions = {
  // ... existing fields ...
  tmExamples?: Array<{
    sourceText: string;
    targetText: string;
    fuzzyScore: number;
    searchMethod?: 'fuzzy' | 'vector' | 'hybrid';
  }>;
};

private buildTranslationExamplesSection(tmExamples?: Array<...>) {
  // Implementation above
}

private buildBatchPrompt(batch: OrchestratorSegment[], options: TranslateSegmentsOptions) {
  // ... existing code ...
  const examplesText = this.buildTranslationExamplesSection(options.tmExamples);
  
  return [
    // ... existing sections ...
    examplesText,
    // ... rest of prompt ...
  ].join('\n');
}
```

---

## Expected Results

### Quality Metrics

- **Terminology Accuracy**: +15-20% improvement
- **Style Consistency**: +25% improvement
- **User Acceptance**: +10-15% improvement

### Cost Impact

- **No additional cost** (same API calls)
- **Slightly longer prompts** (but better results)

---

## Next Steps

1. ✅ Review this plan
2. ✅ Implement RAG enhancement
3. ✅ Test with real translations
4. ✅ Measure quality improvement
5. ⏸️ Consider fine-tuning if needed



