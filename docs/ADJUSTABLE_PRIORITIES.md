# Adjustable Priorities for TM Matches, Glossary, and Guidelines

## Overview

The system now supports **adjustable priorities** for different translation sources:
- **TM Examples** (Translation Memory matches)
- **Glossary** (Terminology)
- **Guidelines** (Translation rules)

Users can configure how much emphasis the AI should place on each source, allowing fine-tuning of translation behavior.

---

## How It Works

### Priority Scale (0-100)

- **90-100**: **CRITICAL** - Highest priority, must follow exactly
- **80-89**: **HIGH** - Important, strong emphasis
- **60-79**: **MEDIUM-HIGH** - Standard emphasis
- **40-59**: **MEDIUM** - Reference only
- **0-39**: **LOW** - Minimal emphasis

### Default Priorities

```typescript
{
  tmExamples: 80,   // High priority - learn from past translations
  glossary: 90,      // Highest priority - must be exact
  guidelines: 70     // Medium-high priority - style and rules
}
```

---

## Priority Effects

### 1. Prompt Section Order

Sections are **ordered by priority** (highest first):
- Glossary (90) → Examples (80) → Guidelines (70)

**Example**: If you set Glossary to 50 and Examples to 95:
- Examples (95) → Guidelines (70) → Glossary (50)

### 2. Prompt Emphasis

**High Priority (80-100)**:
- 🚨 CRITICAL or ⚠️ IMPORTANT headers
- Strong language: "MUST use", "EXACT terminology"
- Multiple reminders

**Medium Priority (60-79)**:
- Standard headers: "=== SECTION ==="
- Moderate language: "should use", "preferred"
- Single reminder

**Low Priority (40-59)**:
- Reference headers: "=== SECTION (Reference) ==="
- Soft language: "consider using"
- No reminders

### 3. Example: Glossary Priority

**Priority 90** (Default):
```
🚨 CRITICAL GLOSSARY (HIGHEST PRIORITY - MUST USE EXACTLY):
- term1 => translation1
- term2 => translation2

⚠️ You MUST use these exact translations. Do NOT use alternatives.
```

**Priority 70**:
```
=== GLOSSARY ===
Glossary (preferred translations):
- term1 => translation1
- term2 => translation2
```

**Priority 50**:
```
=== GLOSSARY (Reference) ===
Consider these translations:
- term1 => translation1
- term2 => translation2
```

---

## Configuration

### API Endpoint

**POST** `/api/ai/projects/:projectId/ai-settings`

**Request Body**:
```json
{
  "provider": "openai",
  "model": "gpt-4o-mini",
  "temperature": 0.2,
  "maxTokens": 1024,
  "priorities": {
    "tmExamples": 80,
    "glossary": 90,
    "guidelines": 70
  }
}
```

### Schema Validation

```typescript
{
  tmExamples: number (0-100, optional),
  glossary: number (0-100, optional),
  guidelines: number (0-100, optional)
}
```

---

## Use Cases

### Use Case 1: Strict Glossary Enforcement

**Scenario**: Legal translation where terminology must be exact

**Configuration**:
```json
{
  "priorities": {
    "glossary": 100,    // Maximum priority
    "tmExamples": 60,   // Lower priority
    "guidelines": 50    // Reference only
  }
}
```

**Result**: AI prioritizes glossary terms above all else

---

### Use Case 2: Learn from TM Examples

**Scenario**: Technical translation where past translations are most reliable

**Configuration**:
```json
{
  "priorities": {
    "tmExamples": 95,   // Highest priority
    "glossary": 80,     // Still important
    "guidelines": 60    // Lower priority
  }
}
```

**Result**: AI learns heavily from TM examples, uses glossary when applicable

---

### Use Case 3: Style-Focused Translation

**Scenario**: Marketing translation where style guidelines are most important

**Configuration**:
```json
{
  "priorities": {
    "guidelines": 90,   // Highest priority
    "tmExamples": 70,  // Medium-high
    "glossary": 60     // Medium
  }
}
```

**Result**: AI follows style guidelines strictly, adapts terminology as needed

---

### Use Case 4: Balanced Approach

**Scenario**: General translation with balanced priorities

**Configuration**:
```json
{
  "priorities": {
    "glossary": 85,     // High priority
    "tmExamples": 75,   // Medium-high
    "guidelines": 70    // Medium-high
  }
}
```

**Result**: Balanced emphasis on all sources

---

## Implementation Details

### Storage

Priorities are stored in `ProjectAISetting.config.priorities`:
```json
{
  "config": {
    "priorities": {
      "tmExamples": 80,
      "glossary": 90,
      "guidelines": 70
    }
  }
}
```

### Retrieval

Priorities are extracted in `buildAiContext()`:
```typescript
if (settings?.config && typeof settings.config === 'object') {
  const config = settings.config as Record<string, unknown>;
  if (config.priorities && typeof config.priorities === 'object') {
    priorities = config.priorities as TranslationPriorityConfig;
  }
}
```

### Usage

Priorities are passed to orchestrator:
```typescript
await orchestrator.translateSingleSegment(segment, {
  // ... other options ...
  priorities: context.priorities, // Pass priority configuration
});
```

### Prompt Building

Sections are built with priority-based emphasis:
```typescript
const guidelineText = this.buildGuidelineSection(guidelines, priorities.guidelines);
const glossaryText = this.buildGlossarySection(glossary, priorities.glossary);
const examplesText = this.buildTranslationExamplesSection(tmExamples, priorities.tmExamples);
```

Then ordered by priority:
```typescript
const sections = [
  { text: glossaryText, priority: priorities.glossary },
  { text: examplesText, priority: priorities.tmExamples },
  { text: guidelineText, priority: priorities.guidelines },
].sort((a, b) => b.priority - a.priority);
```

---

## Examples

### Example 1: High TM Priority

**Configuration**:
```json
{ "tmExamples": 95, "glossary": 80, "guidelines": 60 }
```

**Prompt Structure**:
1. **TRANSLATION EXAMPLES** (95) - 🚨 CRITICAL
2. **GLOSSARY** (80) - ⚠️ IMPORTANT
3. **GUIDELINES** (60) - Standard

**Effect**: AI learns heavily from examples, uses glossary when applicable

---

### Example 2: High Glossary Priority

**Configuration**:
```json
{ "glossary": 100, "tmExamples": 70, "guidelines": 50 }
```

**Prompt Structure**:
1. **GLOSSARY** (100) - 🚨 CRITICAL - MUST USE EXACTLY
2. **TRANSLATION EXAMPLES** (70) - Standard
3. **GUIDELINES** (50) - Reference

**Effect**: AI prioritizes glossary terms above all else

---

### Example 3: Low TM Priority

**Configuration**:
```json
{ "tmExamples": 40, "glossary": 90, "guidelines": 80 }
```

**Prompt Structure**:
1. **GLOSSARY** (90) - 🚨 CRITICAL
2. **GUIDELINES** (80) - ⚠️ IMPORTANT
3. **TRANSLATION EXAMPLES** (40) - Reference only

**Effect**: AI uses glossary and guidelines primarily, examples as reference

---

## Testing

### Test Configuration

1. **Set Priorities**:
   ```bash
   POST /api/ai/projects/{projectId}/ai-settings
   {
     "priorities": {
       "tmExamples": 80,
       "glossary": 90,
       "guidelines": 70
     }
   }
   ```

2. **Translate Segment**: Use AI translation

3. **Check Logs**: Verify priorities are used

4. **Compare Results**: Test with different priority configurations

---

## Best Practices

### Recommended Configurations

**Legal/Technical Translation**:
- Glossary: 95-100 (must be exact)
- TM Examples: 70-80 (learn from past)
- Guidelines: 60-70 (style rules)

**Marketing/Creative Translation**:
- Guidelines: 90-100 (style is critical)
- TM Examples: 70-80 (learn from past)
- Glossary: 60-70 (terminology reference)

**General Translation**:
- Glossary: 85-90 (important)
- TM Examples: 75-80 (learn from past)
- Guidelines: 70-75 (style rules)

---

## Troubleshooting

### Issue: AI Not Following Glossary

**Solution**: Increase glossary priority to 90-100

### Issue: AI Copying TM Examples Too Strictly

**Solution**: 
- Lower TM examples priority to 60-70
- Increase guidelines priority to 80-90

### Issue: AI Ignoring Guidelines

**Solution**: Increase guidelines priority to 80-90

---

## Future Enhancements

### 1. Per-Segment Priorities

Allow different priorities for different segment types

### 2. Dynamic Priorities

Adjust priorities based on segment content or context

### 3. Priority Presets

Pre-configured priority sets for common scenarios:
- Legal: Glossary 100, Examples 70, Guidelines 60
- Marketing: Guidelines 100, Examples 80, Glossary 70
- Technical: Glossary 95, Examples 85, Guidelines 70

### 4. UI Controls

Add sliders in project settings to adjust priorities visually

---

## Summary

✅ **Adjustable priorities** allow fine-tuning of AI translation behavior

✅ **Priority affects**:
- Prompt section order
- Emphasis level (headers, language)
- Reminders and instructions

✅ **Default priorities**:
- Glossary: 90 (highest)
- TM Examples: 80 (high)
- Guidelines: 70 (medium-high)

✅ **Configuration** via API: `POST /api/ai/projects/:projectId/ai-settings`

---

**Status**: ✅ Implemented and Ready for Testing



