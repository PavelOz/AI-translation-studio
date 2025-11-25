# Debugging History: Classic RAG Not Working

## Problem Statement

**Issue**: AI translation was not using hybrid match examples from Translation Memory.

**Example**:
- **Source**: "Политика Гарантии Банка"
- **Hybrid Match (100%)**: "Bank Safeguard Policy"
- **AI Translation**: "Bank Guarantee Policy" ❌ (Wrong - should be "Bank Safeguard Policy")

**Expected Behavior**: AI should learn from the hybrid match example and translate as "Bank Safeguard Policy".

---

## Initial Investigation

### Step 1: Verify RAG Implementation

**Thought Process**: 
- We implemented Classic RAG in `runSegmentMachineTranslation()` 
- Examples should be retrieved and passed to the orchestrator
- Prompt should include examples with strong instructions

**Check**: Verified that `runSegmentMachineTranslation()` had RAG code:
```typescript
// Classic RAG: Retrieve TM examples for AI context
let tmExamples: TmExample[] = [];
if (tmAllowed) {
  const exampleMatches = await searchTranslationMemory({...});
  tmExamples = exampleMatches.map(...);
}
```

**Result**: ✅ Code was present in `runSegmentMachineTranslation()`

---

### Step 2: Check Logs

**Thought Process**:
- Added logging to see if examples are being retrieved
- Should see: "Retrieved TM examples for Classic RAG"

**Logs Checked**:
```
[2025-11-22 00:29:22.375] Final hybrid search results
  topScores: [
    { score: 100, method: "hybrid", text: "Политика Гарантии Банка" }
  ]
[2025-11-22 00:29:24.604] POST /api/ai/translate
[2025-11-22 00:29:26.112] AI translation chunk completed
```

**Observation**: 
- ✅ Hybrid match found (100%)
- ❌ **NO log message** "Retrieved TM examples for Classic RAG"
- ❌ Request went to `/api/ai/translate` (not `/api/segments/:id/mt`)

**Hypothesis**: The frontend is using `/api/ai/translate` endpoint, which doesn't have RAG!

---

### Step 3: Find the Actual Endpoint

**Thought Process**:
- User is translating via UI
- Request goes to `/api/ai/translate`
- This is different from `/api/segments/:id/mt`
- Need to check what `/api/ai/translate` does

**Investigation**:
```bash
grep -r "/api/ai/translate" backend/src
```

**Found**: `backend/src/routes/ai.routes.ts`
```typescript
aiRoutes.post('/translate', asyncHandler(async (req, res) => {
  const payload = translateSchema.parse(req.body);
  const result = await translateTextDirectly(payload);
  res.json(result);
}));
```

**Root Cause Identified**: 
- `/api/ai/translate` calls `translateTextDirectly()`
- `translateTextDirectly()` does NOT retrieve TM examples
- Only `runSegmentMachineTranslation()` had RAG support

---

## Root Cause Analysis

### Why Two Different Endpoints?

**Architecture**:
1. **`/api/segments/:id/mt`** → `runSegmentMachineTranslation()`
   - Used for translating segments in documents
   - Has full RAG support ✅
   - Saves to database

2. **`/api/ai/translate`** → `translateTextDirectly()`
   - Used for direct translation (e.g., AI chat panel)
   - No RAG support ❌
   - Returns translation only

**Why This Happened**:
- Classic RAG was implemented only for segment translation
- Direct translation endpoint was overlooked
- Frontend uses `/api/ai/translate` for AI chat panel

---

## Solution Implementation

### Step 1: Add RAG to `translateTextDirectly()`

**Code Changes**:
```typescript
export const translateTextDirectly = async (request: DirectTranslationRequest) => {
  // ... existing context building ...
  
  // Classic RAG: Retrieve TM examples for AI context
  let tmExamples: TmExample[] = [];
  if (request.projectId) {
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
      searchMethod: match.searchMethod,
    }));
  }

  const aiResult = await orchestrator.translateSingleSegment(segment, {
    // ... other options ...
    tmExamples, // Pass examples for RAG ✅
  });
}
```

**Key Points**:
- Only retrieve examples if `projectId` is provided
- Use same thresholds as segment translation (50% minScore, 60% vector)
- Pass examples to orchestrator
- Added error handling (try/catch)

---

### Step 2: Enhanced Prompt Instructions (Previous Changes)

**Previous Enhancements Made**:
1. **Lowered threshold**: 70% → 60% for high-quality match emphasis
2. **Always emphasize hybrid**: Hybrid matches trigger strong instructions regardless of score
3. **Stronger language**: Added emojis and explicit "MUST" instructions
4. **Examples at top**: Moved examples section to beginning of prompt
5. **Direct segment reference**: Added example reference in segment payload

**Prompt Structure**:
```
🚨 CRITICAL INSTRUCTION: HIGH-QUALITY TRANSLATION MEMORY MATCH FOUND 🚨

You have a 100% match from verified translation memory:
  Source: "Политика Гарантии Банка"
  Target: "Bank Safeguard Policy"
  Match Type: HYBRID (semantic + text)

⚠️ MANDATORY REQUIREMENTS:
1. You MUST use the EXACT terminology from "Bank Safeguard Policy"
2. If the source text is similar to "Политика Гарантии Банка", 
   your translation MUST closely match "Bank Safeguard Policy"
3. Do NOT use alternative translations (e.g., if example says "Safeguard", 
   do NOT use "Guarantee")
...
```

---

## Debugging Process Summary

### Timeline

1. **Initial Report**: AI not using hybrid match examples
2. **First Check**: Verified RAG code exists in `runSegmentMachineTranslation()`
3. **Log Analysis**: Noticed no "Retrieved TM examples" log
4. **Endpoint Discovery**: Found request goes to `/api/ai/translate`
5. **Root Cause**: `translateTextDirectly()` doesn't have RAG
6. **Solution**: Added RAG support to `translateTextDirectly()`

### Key Learnings

1. **Multiple Translation Paths**: 
   - Segment translation (`/api/segments/:id/mt`)
   - Direct translation (`/api/ai/translate`)
   - Both need RAG support

2. **Logging is Critical**:
   - Logs revealed the actual endpoint being used
   - Missing logs indicated missing functionality

3. **Frontend Behavior**:
   - UI might use different endpoints than expected
   - Need to check actual API calls, not just code

4. **Hybrid Match Quality**:
   - 100% hybrid match should be followed exactly
   - Prompt needs to be very explicit

---

## Verification Steps

### After Fix

**Expected Behavior**:
1. Request to `/api/ai/translate` with "Политика Гарантии Банка"
2. System retrieves hybrid match: "Bank Safeguard Policy" (100%)
3. Log shows: "Retrieved TM examples for Classic RAG (direct translation)"
4. Prompt includes strong instructions to use "Bank Safeguard Policy"
5. AI translates as "Bank Safeguard Policy" ✅

**Logs to Check**:
```
[INFO] Retrieved TM examples for Classic RAG (direct translation)
  topExample: {
    source: "Политика Гарантии Банка",
    target: "Bank Safeguard Policy",
    score: 100,
    method: "hybrid"
  }
```

---

## Additional Improvements Made

### 1. Enhanced Prompt Instructions

**Changes**:
- Lowered threshold to 60% (or hybrid matches always)
- Added emojis for visibility (🚨 ⚠️)
- Made instructions more explicit ("MUST", "EXACT")
- Added example reference directly in segment payload

### 2. Better Error Handling

**Added**:
```typescript
try {
  const exampleMatches = await searchTranslationMemory({...});
  // ...
} catch (error) {
  logger.warn({ error }, 'Failed to retrieve TM examples');
  // Continue without examples (graceful degradation)
}
```

### 3. Comprehensive Logging

**Added Logs**:
- When examples are retrieved
- Top example details (source, target, score, method)
- When examples are missing
- Errors during retrieval

---

## Testing Checklist

- [x] Verify hybrid match is found (100%)
- [x] Check logs show example retrieval
- [x] Verify examples are passed to orchestrator
- [x] Check prompt includes examples
- [ ] Test AI translation uses example terminology
- [ ] Verify works for both endpoints:
  - [ ] `/api/segments/:id/mt`
  - [ ] `/api/ai/translate`

---

## Future Considerations

### 1. Consistency Across Endpoints

**Issue**: Multiple translation endpoints might have different behavior

**Solution**: 
- Create shared RAG function
- Use in all translation endpoints
- Ensure consistent behavior

### 2. Prompt Optimization

**Current**: Very explicit instructions (good for now)

**Future**: 
- A/B test different prompt styles
- Measure which instructions work best
- Optimize based on user feedback

### 3. Example Quality Filtering

**Current**: Uses top 5 examples with 50%+ threshold

**Future**:
- Filter by search method (prefer hybrid)
- Weight examples by score
- Limit examples by relevance

### 4. Caching

**Current**: Retrieves examples on every request

**Future**:
- Cache examples for frequently translated text
- Invalidate cache on TM updates
- Reduce API calls

---

## Conclusion

**Problem**: AI not using hybrid match examples

**Root Cause**: `/api/ai/translate` endpoint didn't have RAG support

**Solution**: Added RAG support to `translateTextDirectly()`

**Status**: ✅ Fixed - Ready for testing

**Next Steps**: 
1. Test with real translations
2. Verify AI follows examples
3. Monitor logs for any issues
4. Optimize prompt if needed

---

**Date**: 2025-11-22  
**Duration**: ~30 minutes  
**Complexity**: Medium  
**Impact**: High (affects all direct translations)



