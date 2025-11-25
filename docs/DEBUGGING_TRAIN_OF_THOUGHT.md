# Train of Thought: Debugging Classic RAG Issue

## Initial Problem

**User Report**: "AI still uses 'Bank Guarantee Policy' instead of 'Bank Safeguard Policy' from hybrid match"

**My First Thought**: 
- We just implemented Classic RAG
- Examples should be retrieved and included in prompt
- Prompt has strong instructions
- Why isn't it working?

---

## Hypothesis 1: Examples Not Being Retrieved

**Thought**: Maybe examples aren't being found or retrieved

**Check**: Look at code - examples retrieval is in `runSegmentMachineTranslation()`

**Code Check**:
```typescript
const exampleMatches = await searchTranslationMemory({
  limit: 5,
  minScore: 50,
  vectorSimilarity: 60,
});
```

**Result**: ✅ Code looks correct

**Next Thought**: Maybe the search isn't finding the hybrid match?

**Check Logs**: User provided logs showing hybrid match IS found (100%)

**Conclusion**: ❌ Hypothesis 1 is wrong - examples ARE being found

---

## Hypothesis 2: Examples Not Being Passed to AI

**Thought**: Maybe examples are retrieved but not passed to orchestrator?

**Check Code**: 
```typescript
const aiResult = await orchestrator.translateSingleSegment(segment, {
  tmExamples, // ✅ This is present
  // ...
});
```

**Result**: ✅ Code looks correct

**Next Thought**: Maybe the prompt isn't strong enough?

**Check Prompt**: We added very explicit instructions with emojis

**Result**: ✅ Prompt looks strong

**Conclusion**: ❌ Hypothesis 2 is wrong - examples should be passed

---

## Hypothesis 3: Wrong Endpoint Being Used

**Thought**: Wait... what if the frontend is using a different endpoint?

**Check Logs Again**:
```
POST /api/ai/translate  ← This is NOT /api/segments/:id/mt!
```

**Aha Moment**: 
- User is using `/api/ai/translate`
- We implemented RAG in `runSegmentMachineTranslation()` 
- But `/api/ai/translate` calls `translateTextDirectly()`
- `translateTextDirectly()` doesn't have RAG!

**Check**: Look for `translateTextDirectly()` function

**Found**: It exists but doesn't retrieve TM examples

**Conclusion**: ✅ **ROOT CAUSE FOUND!**

---

## Why This Happened

**Architecture Understanding**:

1. **Segment Translation** (`/api/segments/:id/mt`):
   - Used in editor for translating document segments
   - Calls `runSegmentMachineTranslation()`
   - Has RAG support ✅

2. **Direct Translation** (`/api/ai/translate`):
   - Used in AI chat panel
   - Calls `translateTextDirectly()`
   - No RAG support ❌

**Why We Missed It**:
- Focused on segment translation (main use case)
- Didn't realize frontend uses different endpoint for AI chat
- Assumed all translation goes through same path

---

## Solution Design

**Thought Process**:

1. **Option 1**: Make `translateTextDirectly()` call `runSegmentMachineTranslation()`
   - ❌ Too coupled
   - ❌ Different return types
   - ❌ Different use cases

2. **Option 2**: Extract RAG logic to shared function
   - ✅ Better architecture
   - ⚠️ More refactoring needed
   - ⚠️ Takes more time

3. **Option 3**: Add RAG directly to `translateTextDirectly()`
   - ✅ Quick fix
   - ✅ Same logic as segment translation
   - ✅ Minimal changes

**Decision**: Option 3 (quick fix now, refactor later if needed)

---

## Implementation Details

### What to Add

**Thought**: What does RAG need?
1. Retrieve TM examples
2. Map to `TmExample[]` format
3. Pass to orchestrator
4. Add logging for debugging

**Code Structure**:
```typescript
// 1. Retrieve examples (if projectId provided)
let tmExamples: TmExample[] = [];
if (request.projectId) {
  const exampleMatches = await searchTranslationMemory({...});
  tmExamples = exampleMatches.map(...);
}

// 2. Pass to orchestrator
const aiResult = await orchestrator.translateSingleSegment(segment, {
  tmExamples, // ✅ Add this
  // ...
});
```

**Edge Cases to Consider**:
- What if `projectId` is not provided? → Skip RAG (OK)
- What if search fails? → Try/catch, continue without examples
- What if no examples found? → Empty array, orchestrator handles it

---

## Verification Strategy

**Thought**: How do we verify it works?

1. **Check Logs**: Should see "Retrieved TM examples for Classic RAG (direct translation)"
2. **Check Example**: Should show hybrid match with 100% score
3. **Test Translation**: AI should use "Bank Safeguard Policy"

**Log Pattern to Look For**:
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

## Why Prompt Enhancements Were Needed

**Previous Changes Made**:

1. **Lowered Threshold** (70% → 60%):
   - **Thought**: Some good matches might be below 70%
   - **Reason**: Want to catch more examples

2. **Always Emphasize Hybrid**:
   - **Thought**: Hybrid matches are most reliable
   - **Reason**: Even if score is lower, hybrid = double confirmation

3. **Stronger Language**:
   - **Thought**: AI might ignore subtle hints
   - **Reason**: Need explicit "MUST" and "EXACT" instructions

4. **Examples at Top**:
   - **Thought**: AI reads prompt sequentially
   - **Reason**: Examples seen first = more impact

5. **Direct Segment Reference**:
   - **Thought**: Add example directly in segment payload
   - **Reason**: Extra reminder right where AI sees the text

---

## Lessons Learned

### 1. Check Actual API Calls

**Mistake**: Assumed frontend uses `/api/segments/:id/mt`

**Lesson**: Always check logs to see actual endpoints being called

**Action**: Check network tab or backend logs first

### 2. Multiple Translation Paths

**Mistake**: Only implemented RAG in one endpoint

**Lesson**: System has multiple ways to translate - all need RAG

**Action**: Audit all translation endpoints

### 3. Logging is Critical

**Mistake**: Didn't have logging in `translateTextDirectly()`

**Lesson**: Logs reveal what's actually happening

**Action**: Add comprehensive logging to all translation functions

### 4. Test Real User Flows

**Mistake**: Tested segment translation, not AI chat

**Lesson**: Test actual user workflows, not just code paths

**Action**: Test all UI translation features

---

## Future Improvements

### 1. Shared RAG Function

**Current**: RAG logic duplicated in two places

**Future**:
```typescript
async function retrieveRAGExamples(
  sourceText: string,
  sourceLocale: string,
  targetLocale: string,
  projectId?: string
): Promise<TmExample[]> {
  // Shared logic
}
```

**Benefit**: Single source of truth, easier to maintain

### 2. RAG Configuration

**Current**: Hardcoded thresholds (50%, 60%)

**Future**: Make configurable per project or user

**Benefit**: Users can tune RAG behavior

### 3. Example Quality Metrics

**Current**: Just use top 5 examples

**Future**: Track which examples help most

**Benefit**: Optimize example selection

### 4. A/B Testing

**Current**: One prompt style

**Future**: Test different prompt styles

**Benefit**: Find optimal instructions

---

## Debugging Methodology

### Steps Followed

1. **Understand the Problem**: What's happening vs what should happen
2. **Check Code**: Verify implementation exists
3. **Check Logs**: See what's actually happening
4. **Identify Discrepancy**: Find mismatch between code and reality
5. **Root Cause**: Understand why discrepancy exists
6. **Solution**: Fix the root cause
7. **Verify**: Test that fix works

### Key Questions Asked

- ✅ Is the code present? → Yes
- ✅ Are examples retrieved? → Need to check logs
- ✅ Are examples passed to AI? → Need to verify
- ✅ Which endpoint is used? → Check logs
- ✅ Does that endpoint have RAG? → No!

### Debugging Tools Used

1. **Code Reading**: Checked implementation
2. **Log Analysis**: Found actual endpoint
3. **Grep**: Found function definitions
4. **Code Search**: Found all translation endpoints

---

## Conclusion

**Problem**: AI not using hybrid match examples

**Root Cause**: `/api/ai/translate` endpoint didn't have RAG support

**Solution**: Added RAG support to `translateTextDirectly()`

**Time to Fix**: ~30 minutes

**Complexity**: Medium (required understanding architecture)

**Impact**: High (affects all direct translations)

**Status**: ✅ Fixed and ready for testing

---

**Key Insight**: Always check what endpoints are actually being called, not just what you think should be called!



