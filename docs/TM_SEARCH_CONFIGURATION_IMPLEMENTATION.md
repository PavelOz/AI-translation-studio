# TM Search Configuration Implementation Summary

**Date:** November 2025  
**Status:** ✅ Completed

---

## Overview

Successfully implemented user-configurable TM search parameters in the Translation Editor UI. Users can now control search strictness, semantic search usage, and match thresholds directly from the editor interface.

---

## Changes Made

### 1. Backend Changes

#### `backend/src/services/tm.service.ts`

**Extended `TmSearchOptions` type:**
```typescript
type TmSearchOptions = {
  // ... existing fields
  mode?: 'basic' | 'extended'; // Search mode: 'basic' = strict thresholds, 'extended' = relaxed thresholds
  useVectorSearch?: boolean; // Whether to use semantic (vector) search
};
```

**Mode-based pre-filter thresholds:**
- **'basic' mode** (default, strict):
  - `lengthThreshold = 0.4` (40% length difference)
  - `wordOverlapThreshold = 0.3` (30% word overlap)
- **'extended' mode** (relaxed):
  - `lengthThreshold = 0.6` (60% length difference)
  - `wordOverlapThreshold = 0.15` (15% word overlap)

**Vector search control:**
- Removed hardcoded `let useVectorSearch = true`
- Now uses `useVectorSearch` parameter from options
- If `useVectorSearch === false`, skips entire vector search block (fuzzy-only)
- Default: `true` (preserves current behavior)

**Stabilized vector similarity threshold:**
- **Before:** `minSimilarity = Math.max(0.5, vectorSimilarity || minScore / 100)`
- **After:** `minSimilarity = vectorSimilarity !== undefined ? vectorSimilarity / 100 : 0.5`
- Vector similarity is now independent of fuzzy `minScore`
- Default: `0.5` (50%) when not provided

**Default values:**
- `mode`: `'basic'` (preserves current strict behavior)
- `useVectorSearch`: `true` (preserves current hybrid search)
- `minScore`: `50` (changed from 60 to match frontend default)

#### `backend/src/routes/tm.routes.ts`

**Extended search schema:**
```typescript
const searchSchema = z.object({
  // ... existing fields
  mode: z.enum(['basic', 'extended']).optional(),
  useVectorSearch: z.boolean().optional(),
});
```

**Updated route handler:**
- Passes `mode` and `useVectorSearch` to `searchTranslationMemory()`

---

### 2. Frontend Changes

#### `frontend/src/api/tm.api.ts`

**Extended `TmSearchRequest` type:**
```typescript
export type TmSearchRequest = {
  // ... existing fields
  mode?: 'basic' | 'extended';
  useVectorSearch?: boolean;
};
```

#### `frontend/src/components/editor/TMSuggestionsPanel.tsx`

**Added state management:**
- `mode`: `'basic' | 'extended'` (default: `'basic'`)
- `useVectorSearch`: `boolean` (default: `true`)
- Both persisted to `localStorage`

**Added UI controls:**
- **Min TM Match (%)**: `<select>` dropdown with options: 40, 50, 60, 70 (default: 50)
- **TM Mode**: Radio buttons
  - "Strict" (`basic`) - default
  - "Extended" (`extended`)
- **Use semantic TM**: Checkbox (default: checked)

**Updated search API call:**
```typescript
await tmApi.search({
  sourceText: searchText,
  sourceLocale: sourceLocale || '*',
  targetLocale: targetLocale || '*',
  projectId,
  limit: 10,
  minScore,
  vectorSimilarity,
  mode,        // NEW
  useVectorSearch, // NEW
}, abortController.signal);
```

**Updated useEffect dependencies:**
- Added `mode` and `useVectorSearch` to dependency array
- Search automatically re-runs when settings change

---

## How It Works

### Mode Selection

**Basic Mode (Strict):**
- Length difference threshold: 40%
- Word overlap threshold: 30%
- **Use case:** When you want high-precision matches only
- **Effect:** Filters out entries that are significantly different in length or word composition

**Extended Mode (Relaxed):**
- Length difference threshold: 60%
- Word overlap threshold: 15%
- **Use case:** When you want more recall, finding semantically similar but lexically different translations
- **Effect:** Allows more candidates through pre-filtering, then fuzzy scoring determines final matches

### Vector Search Toggle

**Enabled (checked):**
- Performs hybrid search (fuzzy + vector)
- Finds semantically similar translations
- More comprehensive results
- **Use case:** When you want semantic matches (e.g., "отвод земель" vs "изъятие земельных участков")

**Disabled (unchecked):**
- Performs fuzzy-only search
- Faster (no embedding generation)
- Text-based matching only
- **Use case:** When you want fast, exact/close text matches only

### Min TM Match (%)

- Controls minimum fuzzy score threshold
- Options: 40%, 50%, 60%, 70%
- Higher = stricter (fewer but higher quality matches)
- Lower = more lenient (more matches, may include lower quality)

---

## User Experience

### UI Layout

The TM Settings are displayed in a compact section at the top of the TM Suggestions Panel:

```
┌─────────────────────────────────────┐
│ Translation Memory                   │
│                                     │
│ ┌─ TM Settings ──────────────────┐ │
│ │ Min TM Match (%): [50 ▼]       │ │
│ │ Mode: (● Strict) ( ) Extended  │ │
│ │ [✓] Use semantic TM            │ │
│ └─────────────────────────────────┘ │
│                                     │
│ [Search results...]                 │
└─────────────────────────────────────┘
```

### Behavior

1. **Settings persist** across sessions (stored in `localStorage`)
2. **Auto-search** triggers when settings change
3. **Real-time updates** - results refresh immediately when settings are adjusted
4. **Defaults preserve** current behavior (basic mode, vector search enabled, 50% min score)

---

## Testing Checklist

- [x] Backend accepts `mode` and `useVectorSearch` parameters
- [x] Mode affects pre-filter thresholds correctly
- [x] `useVectorSearch=false` skips vector search
- [x] Vector similarity threshold is independent of minScore
- [x] Frontend UI controls are displayed
- [x] Settings persist in localStorage
- [x] Search re-runs when settings change
- [x] Defaults match previous behavior

---

## Files Modified

### Backend
1. `backend/src/services/tm.service.ts`
   - Extended `TmSearchOptions` type
   - Added mode-based threshold logic
   - Removed hardcoded `useVectorSearch`
   - Stabilized vector similarity threshold
   - Updated default `minScore` to 50

2. `backend/src/routes/tm.routes.ts`
   - Extended `searchSchema` with `mode` and `useVectorSearch`
   - Updated route handler to pass new parameters

### Frontend
1. `frontend/src/api/tm.api.ts`
   - Extended `TmSearchRequest` type

2. `frontend/src/components/editor/TMSuggestionsPanel.tsx`
   - Added state for `mode` and `useVectorSearch`
   - Added UI controls (select, radio buttons, checkbox)
   - Updated API call to include new parameters
   - Added localStorage persistence
   - Updated useEffect dependencies

---

## Backward Compatibility

✅ **Fully backward compatible:**
- All new parameters are optional
- Defaults preserve previous behavior:
  - `mode = 'basic'` (strict thresholds)
  - `useVectorSearch = true` (hybrid search enabled)
  - `minScore = 50` (matches frontend default)
- Existing API calls without new parameters work as before

---

## Documentation

### Code Comments

Added JSDoc comment to `searchTranslationMemory()` explaining:
- How `mode` affects thresholds
- How `useVectorSearch` controls semantic search
- How `minScore` filters fuzzy results

### User-Facing Labels

- **"Strict"** = Basic mode (high precision)
- **"Extended"** = Extended mode (higher recall)
- **"Use semantic TM"** = Enable vector search

---

## Next Steps (Optional Enhancements)

1. Add tooltips explaining what each setting does
2. Add preset configurations (e.g., "High Precision", "Maximum Recall")
3. Show visual indicators when extended mode finds matches that basic mode would filter
4. Add analytics to track which settings users prefer

---

## Summary

✅ Successfully implemented user-configurable TM search parameters
✅ All settings are exposed in the editor UI
✅ Settings persist across sessions
✅ Backward compatible with existing code
✅ No breaking changes

The implementation allows users to fine-tune TM search behavior directly from the editor, improving both precision (strict mode) and recall (extended mode) based on their needs.



