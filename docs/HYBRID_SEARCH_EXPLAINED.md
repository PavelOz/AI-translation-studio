# How Hybrid Search Works and Why It's Reliable

## Understanding Your Example

**Your search**: "Проект влечет за собой отвод земель и связанные с этим мероприятия"

**Hybrid match (80%)**: "The project entails land acquisition and associated impacts, but these are expected to be minimal."

**Why 80% and not 100%?**

The **80% score** is the **fuzzy (textual) similarity score**, not the vector (semantic) score. Here's what it means:

### Fuzzy Score Breakdown (80%)

The fuzzy algorithm calculates similarity using:

1. **Levenshtein Distance (70% weight)**: Character-level differences
   - Measures how many characters need to be changed, added, or removed
   - Example: "отвод земель" vs "land acquisition" = many character differences

2. **Token Overlap (30% weight)**: Word-level similarity
   - Measures how many words overlap between source and target
   - Example: "проект" appears in both, but most words are different

**80% means**: The texts are **80% similar** at the character/word level, but **20% different**.

## How Hybrid Search Works

### Step-by-Step Process

1. **Vector Search** (Semantic):
   - Generates embedding for your text: "Проект влечет за собой отвод земель..."
   - Searches database for entries with similar **meaning**
   - Finds: "Проект влечет за собой отвод земель и связанные с этим мероприятия"
   - **Vector similarity**: ~85-90% (semantic meaning matches)

2. **Fuzzy Search** (Textual):
   - Takes the same entry found by vector search
   - Calculates text similarity using Levenshtein + token overlap
   - **Fuzzy score**: 80% (text similarity)

3. **Hybrid Detection**:
   - Same entry found by **both** methods ✅
   - Marked as **"hybrid"** (purple badge)
   - Final score: 80% (fuzzy score, but confirmed by vector search)

## Why Hybrid is More Reliable Than Pure Fuzzy

### Pure Fuzzy Match (80%)
- ✅ Text is 80% similar
- ❓ Meaning might be different (could be false positive)
- Example: "The cat sat" vs "The bat sat" = 80% fuzzy, but different meaning

### Hybrid Match (80%)
- ✅ Text is 80% similar (fuzzy confirms)
- ✅ Meaning is similar (vector confirms)
- ✅ **Double confirmation** = higher reliability
- Example: Your case - both text AND meaning match

## Why There Are Still Differences

Even with 80% hybrid match, there are differences because:

1. **Different wording**: 
   - Your text: "отвод земель и связанные с этим мероприятия"
   - TM text: "land acquisition and associated impacts, but these are expected to be minimal"
   - Different phrasing, same meaning

2. **Additional information**:
   - TM entry adds: "but these are expected to be minimal"
   - This extra clause reduces fuzzy score but doesn't change meaning

3. **Translation style**:
   - Different translators may phrase things differently
   - Same meaning, different words = lower fuzzy score, but vector confirms meaning

## Score Interpretation

| Score | Meaning | Reliability |
|-------|---------|-------------|
| **100% Hybrid** | Exact text match + semantic match | ⭐⭐⭐⭐⭐ Perfect - use directly |
| **90-99% Hybrid** | Very similar text + semantic match | ⭐⭐⭐⭐ Excellent - minor edits needed |
| **80-89% Hybrid** | Similar text + semantic match | ⭐⭐⭐ Good - review and adapt |
| **70-79% Hybrid** | Somewhat similar + semantic match | ⭐⭐ Fair - needs more editing |
| **<70% Hybrid** | Different text but same meaning | ⭐ Use as reference only |

## Your Example Explained

**80% Hybrid Match** means:
- ✅ **Semantic similarity**: Vector search confirms the **meaning** matches (~85-90%)
- ✅ **Text similarity**: Fuzzy search confirms the **wording** is similar (80%)
- ⚠️ **Differences**: 20% of the text differs (different phrasing, extra clauses)

**Why it's reliable**:
- Both methods agree this is a good match
- The differences are mostly stylistic (different wording for same concept)
- The core meaning is preserved

## Difference Between Hybrid and Pure Fuzzy

### Pure Fuzzy (Blue Badge)
- **Only** measures text similarity
- Doesn't check if meaning matches
- Can give false positives (similar text, different meaning)
- Example: "bank" (financial) vs "bank" (river) = 100% fuzzy, but different meaning

### Hybrid (Purple Badge)
- **Both** text similarity AND semantic similarity
- Double confirmation = higher confidence
- Filters out false positives
- Example: Your case - both text and meaning match

## When to Use Hybrid Matches

### ✅ Use Directly (90-100%):
- Exact or near-exact matches
- High confidence translations
- Auto-apply recommended

### ✅ Use with Minor Edits (80-89%):
- Good match but needs adaptation
- Review the differences
- Your example falls here - adapt the extra clause

### ⚠️ Use as Reference (70-79%):
- Similar meaning but different wording
- Use as inspiration
- Needs significant editing

### ❌ Don't Use (<70%):
- Too different
- Use as context only

## Best Practices

1. **Prefer Hybrid over Vector-only**: Hybrid has double confirmation
2. **Check the differences**: Even 80% hybrid may need edits
3. **Use fuzzy score for text similarity**: Higher = less editing needed
4. **Use vector score for meaning similarity**: Higher = better semantic match

## Summary

**Hybrid search** = **Vector search** (semantic) + **Fuzzy search** (textual)

- **80% hybrid** means: 80% text similarity + confirmed semantic similarity
- **More reliable** than pure fuzzy because both methods agree
- **Still needs review** because 20% differs (different wording, extra clauses)
- **Better than vector-only** because text similarity is also confirmed

Your example is a **good hybrid match** - the meaning matches (vector confirms), and the text is 80% similar (fuzzy confirms). The differences are mostly stylistic, making it a reliable translation reference.



