# TM Search Function - Files to Review

**For External Developer Review**

This guide lists all files related to the Translation Memory (TM) search functionality, organized by layer and importance.

---

## 📋 Quick Overview

The TM search function implements three search methods:
1. **Fuzzy Search** - Text-based similarity (Levenshtein distance + token overlap)
2. **Vector Search** - Semantic similarity using embeddings
3. **Hybrid Search** - Combines both methods

---

## 🔴 Core Files (Must Review)

### Backend - Core Search Logic

#### 1. `backend/src/services/tm.service.ts` ⭐ **MOST IMPORTANT**
**Purpose:** Main TM search service - implements all search logic
**Key Functions:**
- `searchTranslationMemory()` - Main search function (lines ~150-600)
- `fetchScopedEntries()` - Fetches candidates from database
- Hybrid merge logic - Combines fuzzy + vector results
- Pre-filtering logic - Optimizes performance

**What to look for:**
- Search flow: Vector search → Fuzzy search → Hybrid merge
- Scoring algorithm calls
- Result filtering and sorting
- Caching implementation

**Lines of Interest:**
- Lines 44-163: Type definitions and helper functions
- Lines 164-600: Main search function
- Lines 450-535: Hybrid merge logic

---

#### 2. `backend/src/utils/fuzzy.ts` ⭐ **CRITICAL**
**Purpose:** Fuzzy matching algorithm implementation
**Key Functions:**
- `computeFuzzyScore()` - Calculates similarity score (0-100%)

**What to look for:**
- Levenshtein distance calculation (70% weight)
- Token overlap calculation (30% weight)
- Score formula: `(levenshteinRatio * 0.7 + tokenOverlapRatio * 0.3) * 100`

**Lines of Interest:**
- Lines 19-55: Complete scoring algorithm

---

#### 3. `backend/src/services/vector-search.service.ts` ⭐ **IMPORTANT**
**Purpose:** Vector/semantic search using embeddings
**Key Functions:**
- `searchByVector()` - Performs cosine similarity search
- `storeEmbedding()` - Stores embeddings for entries

**What to look for:**
- PostgreSQL pgvector queries
- Cosine similarity calculation
- Locale filtering logic

**Lines of Interest:**
- Lines 18-150: Vector search implementation
- Lines 90-120: SQL query construction

---

### Backend - API Layer

#### 4. `backend/src/routes/tm.routes.ts`
**Purpose:** API endpoints for TM operations
**Key Endpoint:**
- `POST /api/tm/search` - Search endpoint (lines ~80-100)

**What to look for:**
- Request validation schema
- Authentication middleware
- Response format

**Lines of Interest:**
- Lines 28-36: Search request schema
- Lines 80-100: Search route handler

---

### Frontend - API Client

#### 5. `frontend/src/api/tm.api.ts`
**Purpose:** Frontend API client for TM operations
**Key Functions:**
- `searchTM()` - Calls backend search endpoint

**What to look for:**
- Request parameters
- Response type definitions
- Error handling

---

### Frontend - UI Component

#### 6. `frontend/src/components/editor/TMSuggestionsPanel.tsx` ⭐ **UI IMPORTANT**
**Purpose:** UI component that displays TM search results
**Key Features:**
- Real-time search as user types
- Displays fuzzy/vector/hybrid matches
- Apply button to use matches
- Adjustable thresholds (sliders)

**What to look for:**
- Search trigger logic
- Result display and formatting
- User interaction handlers

**Lines of Interest:**
- Search API call logic
- Result rendering
- Apply match functionality

---

## 🟡 Supporting Files (Good to Review)

### Backend - Supporting Services

#### 7. `backend/src/services/embedding.service.ts`
**Purpose:** Generates embeddings for text (used by vector search)
**Key Functions:**
- `generateEmbedding()` - Creates vector embedding using OpenAI API

**When to review:** If you need to understand how embeddings are created

---

#### 8. `backend/src/services/ai.service.ts`
**Purpose:** Uses TM search for AI translation (RAG)
**Key Functions:**
- `runSegmentMachineTranslation()` - Calls TM search for examples (lines ~302-400)

**When to review:** To see how TM search integrates with AI translation

**Lines of Interest:**
- Lines 346-380: TM example retrieval for RAG

---

### Database Schema

#### 9. `backend/prisma/schema.prisma`
**Purpose:** Database schema definition
**Key Models:**
- `TranslationMemoryEntry` - TM entry model (lines ~182-210)
- Fields: `sourceEmbedding` (vector type), `sourceText`, `targetText`, etc.

**When to review:** To understand data structure and indexes

**Lines of Interest:**
- Lines 182-210: TranslationMemoryEntry model
- Index definitions for performance

---

## 🟢 Optional Files (Reference Only)

### Backend - Utilities

#### 10. `backend/src/utils/languages.ts`
**Purpose:** Language utilities
**When to review:** To understand locale handling

---

#### 11. `backend/src/services/embedding-generation.service.ts`
**Purpose:** Batch embedding generation for existing entries
**When to review:** To understand how embeddings are generated in bulk

---

## 📊 File Dependency Flow

```
API Request
    ↓
tm.routes.ts (API endpoint)
    ↓
tm.service.ts (Main search logic)
    ├──→ fuzzy.ts (Fuzzy scoring)
    ├──→ vector-search.service.ts (Vector search)
    │       └──→ embedding.service.ts (Generate embeddings)
    └──→ Database (Prisma queries)
            ↓
    Results merged and returned
            ↓
frontend/src/api/tm.api.ts (API client)
            ↓
TMSuggestionsPanel.tsx (UI display)
```

---

## 🔍 Key Code Sections to Review

### 1. Main Search Function Entry Point
**File:** `backend/src/services/tm.service.ts`
**Function:** `searchTranslationMemory()` (starts around line 164)

**Flow:**
1. Check cache
2. Generate embedding (if vector search enabled)
3. Perform vector search
4. Perform fuzzy search
5. Merge results (hybrid)
6. Query linked TMX files (if no matches)
7. Sort and return results

### 2. Fuzzy Scoring Algorithm
**File:** `backend/src/utils/fuzzy.ts`
**Function:** `computeFuzzyScore()`

**Algorithm:**
- Normalize text (lowercase, trim)
- Calculate Levenshtein distance ratio
- Calculate token overlap ratio
- Combine: `(levenshtein * 0.7 + tokenOverlap * 0.3) * 100`

### 3. Vector Search Query
**File:** `backend/src/services/vector-search.service.ts`
**Function:** `searchByVector()`

**SQL Query:**
```sql
SELECT id, sourceText, targetText, ...
  1 - (sourceEmbedding <=> $1::vector) as similarity
FROM "TranslationMemoryEntry"
WHERE sourceEmbedding IS NOT NULL
  AND similarity >= $2
ORDER BY sourceEmbedding <=> $1::vector
LIMIT $3
```

### 4. Hybrid Merge Logic
**File:** `backend/src/services/tm.service.ts`
**Lines:** ~450-535

**Process:**
1. Add vector results to map
2. Add fuzzy results to map
3. Mark duplicates as 'hybrid'
4. Sort by scope (project first) then score

---

## 📝 Review Checklist

For understanding TM search, review in this order:

- [ ] **Step 1:** Read `backend/src/utils/fuzzy.ts` - Understand scoring algorithm
- [ ] **Step 2:** Read `backend/src/services/vector-search.service.ts` - Understand semantic search
- [ ] **Step 3:** Read `backend/src/services/tm.service.ts` lines 164-600 - Understand main search flow
- [ ] **Step 4:** Read `backend/src/routes/tm.routes.ts` - Understand API interface
- [ ] **Step 5:** Read `frontend/src/api/tm.api.ts` - Understand frontend API calls
- [ ] **Step 6:** Read `frontend/src/components/editor/TMSuggestionsPanel.tsx` - Understand UI integration

---

## 🎯 Quick Start for External Developer

**If you only have time for 3 files:**

1. **`backend/src/services/tm.service.ts`** - Complete search implementation
2. **`backend/src/utils/fuzzy.ts`** - Scoring algorithm
3. **`frontend/src/components/editor/TMSuggestionsPanel.tsx`** - How it's used

**If you want to understand the full flow:**

1. Start with `tm.routes.ts` (API entry point)
2. Follow to `tm.service.ts` (main logic)
3. Check `fuzzy.ts` and `vector-search.service.ts` (algorithms)
4. Review `TMSuggestionsPanel.tsx` (UI)

---

## 📚 Related Documentation

- `docs/ACCURACY_IMPROVEMENTS.md` - Analysis of current implementation and proposed improvements
- `docs/APPLICATION_DOCUMENTATION.md` - Complete application documentation (section 7.2 covers TM)

---

## 🔧 Testing the Search Function

**API Endpoint:**
```
POST /api/tm/search
Content-Type: application/json
Authorization: Bearer <token>

{
  "sourceText": "Проект влечет за собой отвод земель",
  "sourceLocale": "ru",
  "targetLocale": "en",
  "projectId": "optional-uuid",
  "limit": 20,
  "minScore": 50,
  "vectorSimilarity": 70
}
```

**Response:**
```json
{
  "results": [
    {
      "id": "uuid",
      "sourceText": "...",
      "targetText": "...",
      "fuzzyScore": 85,
      "searchMethod": "hybrid",
      "scope": "project",
      "similarity": {
        "score": 85,
        "levenshteinRatio": 0.82,
        "tokenOverlapRatio": 0.90
      }
    }
  ],
  "total": 10
}
```

---

## 💡 Key Concepts

**Fuzzy Score (0-100%):**
- Based on text similarity
- 100% = exact match
- 90%+ = very similar
- 70-89% = similar
- 50-69% = somewhat similar
- <50% = different

**Vector Similarity (0-1):**
- Based on semantic meaning
- 1.0 = identical meaning
- 0.8+ = very similar meaning
- 0.6-0.8 = similar meaning
- <0.6 = different meaning

**Hybrid Match:**
- Found by both fuzzy and vector search
- Most reliable (validated by both methods)
- Gets priority boost

**Search Scope:**
- `project` - Project-specific entries (higher priority)
- `global` - Global entries (available to all projects)

---

## ❓ Common Questions

**Q: How are results ranked?**
A: First by scope (project > global), then by score (highest first)

**Q: What's the difference between fuzzy and vector search?**
A: Fuzzy = text similarity, Vector = semantic similarity

**Q: Why hybrid matches?**
A: They're validated by both methods, so more reliable

**Q: How is performance optimized?**
A: Pre-filtering, caching, early termination, linked TMX files only queried if no DB matches

---

**Last Updated:** November 2025



