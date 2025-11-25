# Translation Memory Search Methods Explained

## Overview

The Translation Memory search uses **two different methods** to find matches, which can work together:

1. **Fuzzy Search** (Text-based)
2. **Vector Search** (Semantic/Meaning-based)

## 1. Fuzzy Search (Blue Badge: 📝 Fuzzy)

### How it works:
- Compares **text similarity** using algorithms like:
  - Levenshtein distance (character differences)
  - Token overlap (word matching)
  - Dice coefficient (n-gram similarity)

### What it finds:
- **Exact matches**: "Hello world" = "Hello world" (100%)
- **Near-exact matches**: "Hello world" ≈ "Hello word" (90%)
- **Similar text**: "The cat sat" ≈ "The cat sits" (85%)

### Example:
```
Source: "The quick brown fox"
Fuzzy finds: "The quick brown fox jumps" (high score - similar text)
Fuzzy finds: "A quick brown fox" (medium score - similar words)
Fuzzy WON'T find: "A fast dark animal" (low score - different words)
```

### When to use:
- Looking for exact or near-exact text matches
- When you want similar wording
- For terminology consistency

---

## 2. Vector Search (Green Badge: 🔍 Vector)

### How it works:
- Uses **AI embeddings** (vector representations) to find **semantic similarity**
- Compares the **meaning** of text, not just the words
- Uses cosine similarity between embedding vectors

### What it finds:
- **Semantically similar** text even with different wording
- Matches based on **meaning**, not exact text

### Example:
```
Source: "The quick brown fox"
Vector finds: "A fast dark animal" (high semantic similarity - same meaning!)
Vector finds: "The speedy tan canine" (medium similarity - related meaning)
Vector WON'T find: "Hello world" (low similarity - different meaning)
```

### When to use:
- Looking for translations with similar meaning but different wording
- When you want to find related concepts
- For finding contextually similar segments

---

## 3. Hybrid Search (Purple Badge: 🔀 Hybrid)

### How it works:
- **Same entry found by BOTH methods**
- The system runs both fuzzy and vector search
- If the same translation memory entry appears in both results, it's marked as "hybrid"

### What it means:
- **High confidence match** - both text similarity AND semantic similarity agree
- Usually the **best quality** matches
- Most reliable for reuse

### Example:
```
Source: "The quick brown fox"

Fuzzy search finds: "The quick brown fox jumps" (text similarity: 95%)
Vector search finds: "The quick brown fox jumps" (semantic similarity: 92%)

Result: 🔀 Hybrid badge (found by both methods)
```

### When to use:
- Looking for the most reliable matches
- When you want high-confidence translations
- For quality assurance

---

## Visual Comparison

### Example Search: "The cat sat on the mat"

| Match Text | Fuzzy Score | Vector Score | Method | Why |
|------------|-------------|--------------|--------|-----|
| "The cat sat on the mat" | 100% | 98% | 🔀 Hybrid | Exact match - both methods agree |
| "The cat sits on the mat" | 95% | 96% | 🔀 Hybrid | Very similar - both methods find it |
| "A cat sat on a mat" | 75% | 85% | 🔀 Hybrid | Similar meaning - both find it |
| "The feline sat on the rug" | 40% | 90% | 🔍 Vector | Different words, same meaning |
| "The cat sat on the floor" | 60% | 70% | 📝 Fuzzy | Similar text structure |
| "Hello world" | 10% | 15% | ❌ None | Completely different |

---

## How They Work Together

1. **Vector search** runs first (finds semantic matches)
2. **Fuzzy search** runs second (finds text matches)
3. **Results are merged**:
   - If same entry found by both → 🔀 Hybrid
   - If only vector found it → 🔍 Vector
   - If only fuzzy found it → 📝 Fuzzy

---

## Which Should You Use?

### Use **Fuzzy** (lower threshold) when:
- ✅ You want exact or near-exact text matches
- ✅ Terminology must match exactly
- ✅ Looking for similar sentence structure

### Use **Vector** (lower threshold) when:
- ✅ You want semantically similar translations
- ✅ Different wording is acceptable
- ✅ Looking for related concepts or context

### Use **Hybrid** (both thresholds balanced) when:
- ✅ You want the most reliable matches
- ✅ Both text AND meaning should match
- ✅ Highest quality translations

---

## Real-World Example

**Source text**: "В отчетном году частота в ЕЭС Казахстана стабильно поддерживалась"

### Fuzzy Search finds:
- "В отчетном году частота..." (95% - similar text)
- "В прошлом году частота..." (80% - similar structure)

### Vector Search finds:
- "В отчетном году частота..." (98% - same meaning)
- "В течение года частота в энергосистеме..." (85% - similar meaning, different words)

### Hybrid finds:
- "В отчетном году частота..." (found by BOTH - highest confidence)

---

## Summary

- **📝 Fuzzy** = Text similarity (words match)
- **🔍 Vector** = Semantic similarity (meaning matches)
- **🔀 Hybrid** = Both agree (best quality)

**Best practice**: Use balanced thresholds (50-60% each) to see all three types and choose the best match for your needs!



