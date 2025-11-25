# Debugging Guideline Term Rules

## Issue: Guidelines Not Overriding TM Examples

If term-specific rules in guidelines are not working, check the following:

---

## 1. Check Guideline Format

### ✅ Correct Formats

```
переводи реконструкция и однокоренные слова - rehabilitation
переводи реконструкция как rehabilitation
реконструкция - rehabilitation
реконструкция: rehabilitation
```

### ❌ Incorrect Formats

```
Реконструкция должна быть rehabilitation (too vague)
Use rehabilitation for реконструкция (wrong order)
```

---

## 2. Check Pattern Matching

The system detects these patterns:
- `переводи X - Y`
- `переводи X как Y`
- `translate X as Y`
- `X: Y`
- `X - Y` (Russian - English)

**Test your guideline**:
- Must contain "переводи" OR match dash/colon pattern
- Must have clear separator: `-`, `как`, `as`, or `:`

---

## 3. Check Logs

Look for debug logs:
```
Detected term-specific rules in guidelines
termRulesCount: 1
termRules: ["переводи реконструкция - rehabilitation"]
```

If you don't see this log, the pattern isn't matching.

---

## 4. Check Prompt Order

Term rules should appear FIRST in the prompt:
1. 🚨 CRITICAL TERMINOLOGY RULES (Priority 100)
2. Glossary (Priority 90)
3. TM Examples (Priority 80)
4. General Guidelines (Priority 70)

---

## 5. Verify Guideline Storage

Check how guidelines are stored:

**Via API**:
```bash
GET /api/ai/projects/{projectId}/guidelines
```

**Expected format**:
```json
{
  "rules": [
    {
      "title": "переводи реконструкция - rehabilitation"
    }
  ]
}
```

Or:
```json
{
  "rules": [
    "переводи реконструкция - rehabilitation"
  ]
}
```

---

## 6. Test Pattern Matching

Create a test script to verify pattern matching:

```typescript
const rule = "переводи реконструкция и однокоренные слова - rehabilitation";
const patterns = [
  /переводи\s+(.+?)\s*[-–—]\s*(.+)/i,
  /переводи\s+(.+?)\s+как\s+(.+)/i,
];

for (const pattern of patterns) {
  if (pattern.test(rule)) {
    console.log("MATCH:", rule.match(pattern));
  }
}
```

---

## 7. Common Issues

### Issue: Pattern Not Matching

**Cause**: Extra spaces, wrong separator, or format mismatch

**Solution**: Use exact format:
```
переводи реконструкция - rehabilitation
```

### Issue: Guidelines Not in Prompt

**Cause**: Guidelines not being passed to orchestrator

**Solution**: Check `context.guidelines` is populated

### Issue: AI Still Uses TM Example

**Cause**: Term rules not appearing first or not strong enough

**Solution**: 
- Check prompt order (term rules should be first)
- Verify term rules have priority 100
- Check if AI is seeing the rules (check full prompt in logs)

---

## 8. Manual Test

1. Add guideline: `переводи реконструкция - rehabilitation`
2. Check logs for "Detected term-specific rules"
3. Translate segment with "реконструкция"
4. Check if "rehabilitation" is used instead of "reconstruction"

---

## 9. Alternative: Use Glossary

If guidelines still don't work, **use Glossary instead**:

1. Add to Glossary:
   - Source: `реконструкция`
   - Target: `rehabilitation`
   - Mark as "Forbidden"

2. Glossary has priority 90 and is more reliable

---

## 10. Debug Steps

1. **Check guideline format** - must match pattern
2. **Check logs** - look for "Detected term-specific rules"
3. **Check prompt** - term rules should appear first
4. **Check priority** - term rules should have priority 100
5. **Test translation** - verify AI uses correct term

---

## Still Not Working?

1. Check backend logs for pattern matching
2. Verify guideline is stored correctly
3. Check if guidelines are passed to orchestrator
4. Verify prompt contains term rules
5. Try adding to Glossary instead (more reliable)

---

**Status**: Debugging Guide



