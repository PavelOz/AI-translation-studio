# How to Get Hybrid Matches

## What is a Hybrid Match?

A **hybrid match** occurs when the **same entry** is found by **both** vector search (semantic) and fuzzy search (textual). This means:

1. ✅ The entry matches semantically (similar meaning) - found by vector search
2. ✅ The entry matches textually (similar text) - found by fuzzy search
3. ✅ Both searches found the **exact same entry** (same ID in database)

## Why You're Seeing Vector but Not Hybrid

**Vector matches** appear when:
- An entry is semantically similar (similar meaning, different wording)
- Example: "Политика Гарантии Банка" matches "Политика банковских гарантий"

**Hybrid matches** appear when:
- An entry is BOTH semantically AND textually similar
- Example: "Политика Гарантии Банка" matches "Политика Гарантии Банка" (exact or very close match)

## How to Get Hybrid Matches

### 1. Use Segments That Are Very Close to Existing TM Entries

Hybrid matches work best when your source text is:
- **Exact match** or **very close** to an existing TM entry
- Example: If TM has "В отчетном году частота в ЕЭС Казахстана стабильно поддерживалась"
- Your segment: "В отчетном году частота в ЕЭС Казахстана стабильно поддерживалась" → **Hybrid match!**

### 2. Adjust Thresholds

**Recommended settings for hybrid matches:**

- **Vector Similarity**: 40-60 (lower = more semantic matches)
- **Minimum Match Score**: 70-85 (higher = more textual matches)
- **Both thresholds need to be met** for hybrid matches

### 3. Test with These Segments

Try segments that are:
- **Exact or near-exact matches** from your TM
- **Slightly modified versions** of existing TM entries
- **Same phrases** with minor word order changes

### Example Scenarios

#### Scenario 1: Exact Match → Hybrid
- **TM Entry**: "Проект был определен как Проект Категории "A" согласно"
- **Your Segment**: "Проект был определен как Проект Категории "A" согласно"
- **Result**: ✅ Hybrid match (found by both vector and fuzzy)

#### Scenario 2: Very Close Match → Hybrid
- **TM Entry**: "Все природоохранные мероприятия, которые должны быть выполнены"
- **Your Segment**: "Все природоохранные мероприятия, которые должны быть выполнены в срок"
- **Result**: ✅ Hybrid match (found by both, slight difference)

#### Scenario 3: Semantic Only → Vector Only
- **TM Entry**: "Политика банковских гарантий"
- **Your Segment**: "Политика Гарантии Банка"
- **Result**: ✅ Vector match only (same meaning, different wording)

#### Scenario 4: Textual Only → Fuzzy Only
- **TM Entry**: "Проект влечет за собой отвод земель"
- **Your Segment**: "Проект влечет за собой отвод земель и связанные с"
- **Result**: ✅ Fuzzy match only (similar text, but vector threshold not met)

## Tips for Testing

1. **Lower Vector Similarity** (30-50) to get more semantic matches
2. **Raise Minimum Match Score** (75-90) to get more textual matches
3. **Use segments from your test DOCX** - they're designed to match your TM
4. **Check the logs** - you'll see "hybrid: X" in the final results count

## Why Hybrid Matches Are Valuable

Hybrid matches are the **most reliable** because they indicate:
- ✅ High semantic similarity (meaning matches)
- ✅ High textual similarity (wording matches)
- ✅ **Double confirmation** from two different search methods

This makes them ideal for **auto-applying** translations with high confidence!



