# Classic RAG Explained

## What is Classic RAG?

**RAG = Retrieval-Augmented Generation**

Classic RAG is a pattern where you:
1. **Retrieve** relevant context from a knowledge base
2. **Augment** the LLM prompt with that context
3. **Generate** a response using the LLM

### Classic RAG Flow

```
User Query
    ↓
[Retrieval] → Search knowledge base (vector search)
    ↓
[Augmentation] → Add retrieved context to prompt
    ↓
[Generation] → LLM generates answer using context
    ↓
Response
```

### Example: Q&A System

**User asks**: "What is the company's refund policy?"

**Step 1: Retrieval**
- Search knowledge base (documents, FAQs, policies)
- Find relevant chunks: "Refund Policy: Customers can request refunds within 30 days..."

**Step 2: Augmentation**
- Build prompt:
```
Context:
"Refund Policy: Customers can request refunds within 30 days of purchase..."

Question: What is the company's refund policy?

Answer:
```

**Step 3: Generation**
- LLM generates answer using the context
- Response: "According to our refund policy, customers can request refunds within 30 days..."

---

## Classic RAG vs Our Current Implementation

### Our Current RAG (Translation Memory Search)

**What we're doing**:
- ✅ Retrieval: Vector search in TM database
- ✅ Augmentation: Results shown to user in UI
- ❌ Generation: **NOT using LLM** - just showing matches

**Flow**:
```
User selects segment
    ↓
[Retrieval] → Vector search TM database
    ↓
[Results] → Show matches to user (fuzzy/vector/hybrid)
    ↓
User manually applies match
```

**This is RAG for search, not for generation!**

---

### Classic RAG for Translation (What We Should Do)

**What classic RAG would be**:
- ✅ Retrieval: Vector search finds similar translations
- ✅ Augmentation: Add examples to AI prompt
- ✅ Generation: LLM translates using those examples

**Flow**:
```
User requests AI translation
    ↓
[Retrieval] → Vector search TM for similar segments
    ↓
[Augmentation] → Add top 3-5 examples to prompt
    ↓
[Generation] → LLM translates using examples as context
    ↓
Translation (learned from examples)
```

**This is true RAG!**

---

## Classic RAG Architecture

### Components

1. **Knowledge Base** (Vector Database)
   - Your TM entries (source → target pairs)
   - Embedded as vectors
   - Indexed for fast similarity search

2. **Retrieval System**
   - Vector search (semantic similarity)
   - Hybrid search (vector + fuzzy)
   - Returns top-k most relevant examples

3. **Augmentation Layer**
   - Formats retrieved examples
   - Adds to prompt template
   - Provides context to LLM

4. **Generation System**
   - LLM (GPT-4, Gemini, etc.)
   - Generates translation using context
   - Learns from examples

### Prompt Template (Classic RAG)

```
You are a professional translator.

=== CONTEXT (Translation Examples) ===
Here are similar translations from your translation memory:

Example 1:
  Source: "Проект влечет за собой отвод земель"
  Target: "The project entails land acquisition"
  Similarity: 85%

Example 2:
  Source: "Связанные мероприятия"
  Target: "Associated impacts"
  Similarity: 78%

[... more examples ...]

=== TASK ===
Translate the following segment using the examples above as guidance:

Source: "Проект предусматривает мероприятия по охране окружающей среды"
Target: [Your translation here]

=== GUIDELINES ===
- Use terminology from the examples
- Match the translation style
- Follow project guidelines
```

---

## Comparison: Different RAG Patterns

### Pattern 1: Search-Only RAG (What We Have Now)

```
Query → Vector Search → Results → User selects
```

**Use case**: Finding similar translations
**LLM used**: ❌ No
**This is**: Information retrieval, not generation

### Pattern 2: Classic RAG (What We Should Add)

```
Query → Vector Search → Examples → LLM Prompt → Translation
```

**Use case**: AI translation with context
**LLM used**: ✅ Yes
**This is**: True RAG - retrieval + generation

### Pattern 3: Advanced RAG (Future)

```
Query → Multi-hop Search → Reranking → Examples → LLM → Post-processing
```

**Use case**: Complex translation with multiple passes
**LLM used**: ✅ Yes (multiple times)
**This is**: Advanced RAG with refinement

---

## Why Classic RAG is Better for Translation

### Current Approach (Search-Only)
- User sees matches
- User manually applies
- No learning from examples
- Time-consuming

### Classic RAG Approach
- AI sees examples automatically
- AI learns from examples
- Better translation quality
- Faster workflow

### Example Comparison

**Segment**: "Проект предусматривает мероприятия по охране окружающей среды"

**Current (Search-Only)**:
1. Search finds: "Проект влечет за собой отвод земель" → "The project entails land acquisition" (75%)
2. User sees match
3. User manually adapts translation
4. Result: Manual work, inconsistent

**Classic RAG**:
1. Search finds same example (75%)
2. AI sees example in prompt
3. AI learns: "entails" for "предусматривает", "measures" for "мероприятия"
4. AI generates: "The project entails environmental protection measures"
5. Result: Automatic, consistent, better quality

---

## Implementation: Classic RAG for Translation

### Step 1: Retrieval (Already Done ✅)

```typescript
// We already have this!
const examples = await searchTranslationMemory({
  sourceText: segment.sourceText,
  limit: 5,
  minScore: 50,  // Lower threshold for examples
  vectorSimilarity: 60,
});
```

### Step 2: Augmentation (Need to Add)

```typescript
function buildRAGPrompt(segment: Segment, examples: TmSearchResult[]) {
  const examplesText = examples
    .map((ex, i) => 
      `Example ${i + 1}:\n` +
      `  Source: "${ex.sourceText}"\n` +
      `  Target: "${ex.targetText}"\n` +
      `  Similarity: ${ex.fuzzyScore}% (${ex.searchMethod})`
    )
    .join('\n\n');

  return `
You are a professional translator.

=== TRANSLATION EXAMPLES ===
${examplesText}

=== TASK ===
Translate the following segment using the examples above as guidance:

Source: "${segment.sourceText}"
Target: [Your translation]

=== GUIDELINES ===
- Use terminology from the examples
- Match the translation style
- Follow project guidelines
`;
}
```

### Step 3: Generation (Already Have LLM ✅)

```typescript
// We already have this!
const translation = await orchestrator.translateSingleSegment(
  segment,
  {
    prompt: ragPrompt,  // Use RAG-enhanced prompt
    // ... other options
  }
);
```

---

## Benefits of Classic RAG

### 1. Better Quality
- AI learns from examples
- Domain-specific terminology
- Consistent style

### 2. Faster Workflow
- Automatic context injection
- Less manual work
- Fewer edits needed

### 3. Scalability
- More examples = better translations
- TM grows = quality improves
- Self-improving system

### 4. Cost Efficiency
- Same API calls
- Better results
- Less post-editing

---

## Classic RAG vs Fine-Tuning

| Aspect | Classic RAG | Fine-Tuning |
|--------|-------------|-------------|
| **Setup** | Easy (just add to prompt) | Complex (training pipeline) |
| **Cost** | $0 (same API calls) | $50-500 one-time |
| **Update Speed** | Instant (new examples) | Slow (retrain model) |
| **Flexibility** | High (change examples) | Low (fixed model) |
| **Data Needed** | Any amount | 1,000+ pairs minimum |
| **Best For** | Dynamic, evolving TM | Static, large datasets |

**Recommendation**: Start with Classic RAG, consider fine-tuning later if needed.

---

## Summary

### What We Have Now
- ✅ Vector search (retrieval)
- ✅ Hybrid search (vector + fuzzy)
- ❌ **NOT using results for generation** (just showing to user)

### What Classic RAG Would Be
- ✅ Vector search (retrieval)
- ✅ Add examples to prompt (augmentation)
- ✅ LLM generates using examples (generation)

### The Key Difference

**Current**: RAG for **search** (finding matches)
**Classic RAG**: RAG for **generation** (using matches to improve AI translation)

---

## Next Steps

1. ✅ Understand classic RAG pattern
2. ✅ Implement retrieval (already done)
3. ⏭️ **Implement augmentation** (add examples to prompt)
4. ⏭️ **Test generation** (compare with/without examples)
5. ⏭️ **Measure improvement** (quality metrics)

**Ready to implement classic RAG?** It's the natural next step after vector search!



