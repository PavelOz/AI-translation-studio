# Guideline Term-Specific Translation Rules

## Overview

The system now automatically detects **term-specific translation rules** in guidelines and gives them **highest priority** (priority 100), ensuring they override TM examples and other sources.

---

## Supported Formats

The system recognizes these patterns in guidelines:

### Format 1: Russian Instruction
```
переводи реконструкция и однокоренные слова - rehabilitation
```
**Pattern**: `переводи [term] - [translation]`

### Format 2: Russian with "как"
```
переводи реконструкция как rehabilitation
```
**Pattern**: `переводи [term] как [translation]`

### Format 3: English Instruction
```
translate reconstruction as rehabilitation
```
**Pattern**: `translate [term] as [translation]`

### Format 4: Colon Format
```
реконструкция: rehabilitation
```
**Pattern**: `[term]: [translation]`

### Format 5: Dash Format
```
реконструкция - rehabilitation
```
**Pattern**: `[term] - [translation]`

---

## How It Works

### 1. Detection

When guidelines are processed, the system:
- Scans each guideline rule
- Detects term-specific patterns using regex
- Separates them from general guidelines

### 2. Formatting

Term-specific rules are formatted with:
- 🚨 CRITICAL TERMINOLOGY RULES header
- Enhanced formatting: `🚨 TRANSLATE [term] → [translation]`
- Explicit override instructions

### 3. Priority

Term-specific rules automatically get:
- **Priority 100** (highest possible)
- Appear **FIRST** in the prompt (before glossary, TM examples, etc.)
- **MANDATORY** override instructions

---

## Example

### Input Guideline

```
переводи реконструкция и однокоренные слова - rehabilitation
```

### Generated Prompt Section

```
🚨 CRITICAL TERMINOLOGY RULES (MUST OVERRIDE ALL OTHER SOURCES):
1. 🚨 TRANSLATE реконструкция и однокоренные слова → rehabilitation

⚠️ MANDATORY: These terminology rules MUST be applied even if translation memory examples suggest different translations.
If a TM example uses different terminology, you MUST replace it with the terminology specified above.
```

### Result

Even if there's a 100% TM match saying "reconstruction", the AI will use "rehabilitation" because:
1. Term rule appears FIRST in prompt
2. Gets CRITICAL priority (100)
3. Has explicit override instructions
4. TM examples appear AFTER with lower priority

---

## Use Case: реконструкция → rehabilitation

### Scenario

- **Guideline**: "переводи реконструкция и однокоренные слова - rehabilitation"
- **TM Example**: "Expansion/reconstruction of the Shymkent substation" (100% hybrid match)
- **Source**: "Расширение/реконструкция подстанции Шымкент"

### Expected Behavior

**Before Enhancement**:
- AI sees TM example first
- Uses "reconstruction" from TM example
- ❌ Result: "Expansion/reconstruction of the Shymkent substation"

**After Enhancement**:
- AI sees term rule FIRST with CRITICAL priority
- Overrides TM example terminology
- ✅ Result: "Expansion/rehabilitation of the Shymkent substation"

---

## Adding Term Rules

### Via Project Guidelines

1. Go to Project Settings → Guidelines
2. Add a guideline rule in one of the supported formats:
   ```
   переводи реконструкция - rehabilitation
   ```
3. Save guidelines
4. The system will automatically detect and prioritize it

### Format Tips

- Use clear, explicit format: `переводи [term] - [translation]`
- Include related words: `переводи X и однокоренные слова - Y`
- One rule per line
- Can mix with general guidelines

---

## Priority Order

When term rules are detected, prompt order becomes:

1. **🚨 CRITICAL TERMINOLOGY RULES** (Priority 100) ← **ALWAYS FIRST**
2. Glossary (Priority 90)
3. TM Examples (Priority 80)
4. General Guidelines (Priority 70)

---

## Troubleshooting

### Issue: Term rule not detected

**Check**:
- Format matches one of the supported patterns
- No extra characters breaking the pattern
- Rule is in the guidelines list

**Solution**: Use explicit format: `переводи [term] - [translation]`

### Issue: AI still uses TM example

**Check**:
- Term rule appears in prompt (check logs)
- Rule format is correct
- No typos in term or translation

**Solution**: 
- Verify rule appears with "CRITICAL TERMINOLOGY RULES" header
- Check prompt order (term rules should be first)
- Try more explicit format

---

## Best Practices

### 1. Use Glossary for Single Terms

For simple term mappings, **Glossary is better**:
- More reliable
- Can mark as "forbidden"
- Easier to manage

### 2. Use Guidelines for Complex Rules

For rules like:
- "переводи X и однокоренные слова - Y" (includes related words)
- Context-dependent rules
- Style preferences

### 3. Format Clearly

Use explicit format:
```
переводи реконструкция - rehabilitation
```

Not:
```
реконструкция should be rehabilitation (unclear)
```

---

## Summary

✅ **Term-specific rules in guidelines are automatically detected**

✅ **Get highest priority (100) and appear FIRST in prompt**

✅ **Override TM examples and other sources**

✅ **Supported formats**: Russian instructions, English instructions, colon/dash formats

✅ **Use for**: Complex rules, related words, context-dependent translations

---

**Status**: ✅ Implemented and Ready to Use



