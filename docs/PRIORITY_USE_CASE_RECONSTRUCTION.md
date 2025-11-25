# Priority Use Case: Overriding TM Examples with Guidelines

## Scenario

You have:
- **Guideline**: "переводи реконструкция и однокоренные слова - rehabilitation"
  (translate "реконструкция" and related words as "rehabilitation")
- **100% Hybrid TM Match**: "Expansion/reconstruction of the Shymkent substation"
  for "Расширение/реконструкция подстанции Шымкент"

**Goal**: Make AI translate "реконструкция" as "rehabilitation" instead of "reconstruction" from the TM example.

---

## Solution: Adjust Priorities

### Recommended Priority Configuration

```json
{
  "guidelines": 95,    // CRITICAL - Highest priority
  "glossary": 90,      // HIGH - Still important
  "tmExamples": 65    // MEDIUM - Lower priority to allow override
}
```

### Why This Works

1. **Guidelines Priority (95)**: 
   - Appears FIRST in the prompt
   - Gets 🚨 CRITICAL emphasis
   - AI receives: "⚠️ MANDATORY REQUIREMENTS: Follow these guidelines strictly"
   - The instruction "переводи реконструкция... как rehabilitation" becomes mandatory

2. **TM Examples Priority (65)**:
   - Appears AFTER guidelines
   - Gets MEDIUM emphasis
   - AI receives: "Use these examples as reference, but guidelines take precedence"

3. **Result**: 
   - AI sees the guideline FIRST and with STRONG emphasis
   - AI sees the TM example SECOND with MODERATE emphasis
   - AI prioritizes the guideline instruction over the TM example

---

## How to Apply

### Option 1: Via Editor (Quick Access)

1. Open the editor
2. Click "Priorities" button in AI Translation panel
3. Set priorities:
   - **Guidelines**: 95
   - **Glossary**: 90
   - **TM Examples**: 65
4. Click "Save & Apply"
5. Translate the segment

### Option 2: Via Project Settings

1. Go to Project Settings → AI Settings
2. Scroll to "Translation Priorities"
3. Set priorities:
   - **Guidelines**: 95
   - **Glossary**: 90
   - **TM Examples**: 65
4. Click "Save Settings"

---

## Expected Behavior

### Before Priority Adjustment

**Prompt Order** (default priorities):
1. Glossary (90) - CRITICAL
2. TM Examples (80) - HIGH
3. Guidelines (70) - MEDIUM-HIGH

**AI Behavior**:
- Sees TM example first: "Expansion/reconstruction..."
- Follows TM example: Uses "reconstruction"
- May ignore guideline: Doesn't apply "rehabilitation"

### After Priority Adjustment

**Prompt Order** (adjusted priorities):
1. Guidelines (95) - 🚨 CRITICAL
2. Glossary (90) - ⚠️ IMPORTANT
3. TM Examples (65) - MEDIUM

**AI Behavior**:
- Sees guideline FIRST: "переводи реконструкция... как rehabilitation"
- Receives CRITICAL instruction: "MUST follow these guidelines"
- Sees TM example SECOND with lower emphasis
- Prioritizes guideline: Uses "rehabilitation" instead of "reconstruction"
- Result: "Expansion/rehabilitation of the Shymkent substation"

---

## Alternative: Use Glossary Instead

**Even Better Solution**: Add to Glossary

If "реконструкция" should ALWAYS be "rehabilitation" in this project:

1. Add to Glossary:
   - Source: "реконструкция"
   - Target: "rehabilitation"
   - Mark as "Forbidden" (if you want to prevent alternatives)

2. Keep priorities balanced:
   ```json
   {
     "glossary": 95,     // CRITICAL - Glossary is highest
     "guidelines": 85,   // HIGH - Still important
     "tmExamples": 75    // MEDIUM-HIGH - Learn from examples
   }
   ```

**Why Glossary is Better**:
- Glossary entries are more explicit
- Can mark as "forbidden" to prevent alternatives
- Easier to manage and update
- More reliable than guidelines for specific terms

---

## Priority Levels Explained

### Guidelines Priority: 95 (CRITICAL)

**Prompt Effect**:
```
🚨 CRITICAL GUIDELINES (HIGHEST PRIORITY - MUST FOLLOW):
1. переводи реконструкция и однокоренные слова - rehabilitation
2. [other guidelines...]

⚠️ You MUST follow these guidelines strictly.
```

**AI Behavior**:
- Treats guidelines as mandatory
- Prioritizes guideline instructions over examples
- Applies guideline terminology even if examples differ

### TM Examples Priority: 65 (MEDIUM)

**Prompt Effect**:
```
=== TRANSLATION EXAMPLES (Learn from these) ===
These are similar translations from your translation memory...

IMPORTANT:
- Use the terminology and phrasing style from these examples
- Match the translation approach shown above
- CRITICAL: Translate ONLY what is in your source text
```

**AI Behavior**:
- Uses examples as reference
- Adapts examples to match guidelines
- Doesn't override guidelines when conflicts occur

---

## Testing

### Test Translation

**Source**: "Расширение/реконструкция подстанции Шымкент"

**Expected Output** (with Guidelines priority 95):
- ✅ "Expansion/rehabilitation of the Shymkent substation"
- ❌ NOT "Expansion/reconstruction of the Shymkent substation"

### Verification Steps

1. Set priorities as recommended
2. Translate the segment
3. Check if "rehabilitation" is used instead of "reconstruction"
4. If not working, try:
   - Increase Guidelines to 100
   - Decrease TM Examples to 50
   - Check if guideline is properly formatted

---

## Troubleshooting

### Issue: AI Still Uses "reconstruction"

**Solutions**:
1. **Increase Guidelines Priority**: Try 100 (maximum)
2. **Decrease TM Examples Priority**: Try 50 (lower)
3. **Check Guideline Format**: Ensure it's clear and explicit
4. **Add to Glossary**: More reliable than guidelines for specific terms

### Issue: AI Ignores Both

**Solutions**:
1. **Check Priority Order**: Ensure Guidelines appears first
2. **Verify Guideline Text**: Make sure it's in the guidelines list
3. **Test with Direct Instruction**: Try "ALWAYS translate реконструкция as rehabilitation"

---

## Summary

✅ **YES, priorities can override TM examples**

**Recommended Configuration**:
- Guidelines: 95 (CRITICAL)
- Glossary: 90 (HIGH)
- TM Examples: 65 (MEDIUM)

**Result**: AI prioritizes guideline instruction over TM example, translating "реконструкция" as "rehabilitation" instead of "reconstruction".

**Better Alternative**: Add "реконструкция" → "rehabilitation" to Glossary with high priority (95).

---

**Status**: ✅ Ready to Test



