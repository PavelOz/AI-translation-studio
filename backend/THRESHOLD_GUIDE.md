# Translation Memory Search Threshold Guide

## Understanding the Two Thresholds

### 1. Fuzzy Match Threshold (Blue Slider)
- **What it does**: Filters text-based fuzzy matches
- **Range**: 0-100%
- **How it works**: Uses Levenshtein distance and token overlap
- **Best for**: Finding exact or near-exact text matches

### 2. Vector Similarity Threshold (Green Slider)
- **What it does**: Filters semantic (vector) matches
- **Range**: 50-100%
- **How it works**: Uses embedding similarity (cosine similarity)
- **Best for**: Finding semantically similar matches even if wording differs

## Recommended Settings

### To See Vector Matches (Green Badges)
**Settings:**
- Vector Similarity: **50-60%** (low)
- Fuzzy Match: **0-50%** (low to medium)

**Why**: Vector matches might have low fuzzy scores (different wording) but high semantic similarity. Lower thresholds allow these through.

### To See Hybrid Matches (Purple Badges)
**Settings:**
- Vector Similarity: **50-70%** (low to medium)
- Fuzzy Match: **50-70%** (medium)

**Why**: Hybrid matches are found by BOTH methods. You need both thresholds low enough to allow matches from both sources.

### To See Only High-Quality Matches
**Settings:**
- Vector Similarity: **70-80%** (high)
- Fuzzy Match: **80-90%** (high)

**Why**: Higher thresholds filter out low-quality matches, showing only the best results.

## Current Filtering Logic

Vector results are included if they meet **EITHER** threshold:
- Vector similarity >= Vector Similarity Threshold, OR
- Fuzzy score >= Fuzzy Match Threshold

This means:
- **Low Vector + Low Fuzzy**: Shows many matches (vector, fuzzy, and hybrid)
- **Low Vector + High Fuzzy**: Shows vector matches (even with low fuzzy scores)
- **High Vector + Low Fuzzy**: Shows fuzzy matches (even with low vector similarity)
- **High Vector + High Fuzzy**: Shows only high-quality matches from both methods

## Example Scenarios

### Scenario 1: "Find semantic matches even if wording differs"
- Vector Similarity: **50%**
- Fuzzy Match: **60%**
- **Result**: You'll see green "Vector" badges for semantically similar matches

### Scenario 2: "Show all possible matches"
- Vector Similarity: **50%**
- Fuzzy Match: **0%**
- **Result**: Maximum matches from both methods, including hybrid

### Scenario 3: "Only show high-confidence matches"
- Vector Similarity: **75%**
- Fuzzy Match: **85%**
- **Result**: Only very similar matches from both methods

## Troubleshooting

### No Vector Matches Showing?
1. Check if embeddings are generated: Run `npx ts-node scripts/check-embedding-completion.ts`
2. Lower Vector Similarity to 50%
3. Lower Fuzzy Match to 50% or below
4. Check backend logs for "Vector search returned X raw matches"

### No Hybrid Matches Showing?
- Hybrid matches require the same entry to be found by BOTH methods
- Lower both thresholds to 50-60%
- Ensure you have entries with both good fuzzy AND vector similarity

### Too Many Low-Quality Matches?
- Increase Vector Similarity to 70%+
- Increase Fuzzy Match to 70%+
- This filters out weaker matches

## Quick Reference

| Goal | Vector Similarity | Fuzzy Match | Expected Results |
|------|-------------------|-------------|------------------|
| See semantic matches | 50% | 50% | Vector + Hybrid |
| Maximum matches | 50% | 0% | All types |
| High quality only | 75% | 85% | Best matches |
| Balance | 60% | 60% | Good mix |



