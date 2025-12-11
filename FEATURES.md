# AI Translation Studio - Core Features Documentation

This document explains the technical logic behind key features of the AI Translation Studio. It serves as a "User Manual" for understanding how the system makes translation decisions.

---

## Table of Contents

1. [Glossary Logic](#glossary-logic)
2. [TM Hybrid Search](#tm-hybrid-search)
3. [Inspector Panel](#inspector-panel)
4. [AI Orchestrator](#ai-orchestrator)

---

## Glossary Logic

The glossary system ensures that only relevant terminology is sent to the AI model, reducing token waste and improving translation accuracy.

### Three-Stage Filtering Process

#### Stage 1: Direction Matching & Swapping

**Location:** `backend/src/services/ai.service.ts` - `mapGlossaryEntries()`

**What it does:**
- Compares each glossary entry's language pair with the document's language pair
- Ensures glossary terms are oriented correctly for the translation direction

**Logic:**
1. **Exact Match:** If entry direction matches document direction (e.g., both are `en → ru`), use the entry as-is
2. **Bidirectional Match:** If entry direction is reversed (e.g., entry is `ru → en` but document is `en → ru`), swap the terms:
   - Entry source term becomes the glossary term
   - Entry target term becomes the glossary translation
3. **No Match:** If entry direction doesn't match either way, discard it

**Example:**
- Document: English → Russian (`en → ru`)
- Glossary Entry: `барабан → drum` (Russian → English, `ru → en`)
- Result: Entry is swapped to `drum → барабан` (English → Russian) ✅

**Why this matters:** Without direction checking, you might send Russian terms when translating English text, wasting tokens and confusing the model.

---

#### Stage 2: Context Filtering

**Location:** `backend/src/services/ai.service.ts` - `filterGlossaryByContext()`

**What it does:**
- Filters glossary entries based on document context (domain, client, document type)
- Uses context rules defined in glossary entries (e.g., "useOnlyIn", "excludeFrom")

**Logic:**
- Checks if entry's context rules match the document's context
- Only includes entries that are relevant to the current document's domain/client/type

**Example:**
- Document: Legal domain, Client: "Acme Corp"
- Glossary Entry: `{term: "valve", contextRules: {useOnlyIn: ["technical"]}}`
- Result: Entry is excluded (legal ≠ technical) ❌

---

#### Stage 3: Source Text Filtering with Stemming

**Location:** `backend/src/services/ai.service.ts` - `filterGlossaryBySourceText()`  
**Stemming Logic:** `backend/src/utils/stemming.ts`

**What it does:**
- Filters glossary entries to only include terms that actually appear in the segment's source text
- Uses stemming to handle word variations (plurals, case endings)

**Stemming Rules:**

**English Stemming:**
- Plurals: `companies → company`, `boxes → box`, `cars → car`
- Verb forms: `running → run`, `walked → walk`
- Handles irregular forms: `companies → company` (not `compani`)

**Russian Stemming:**
- Case endings: `компаний → компания` (genitive → nominative)
- Plural forms: `компаниям → компания` (dative plural → nominative)
- Handles multiple cases: genitive, dative, instrumental, prepositional

**Matching Logic:**
1. **Exact Match:** Check if term appears in source text (case-insensitive)
2. **Stem Match:** If no exact match, stem both the term and each word in source text
3. **Stem Comparison:** Match if stems are identical or one contains the other (for compound words)

**Example:**
- Source Text: `"Companies House"`
- Glossary Entry: `company → компания`
- Process:
  1. Exact match: `"Companies"` ≠ `"company"` ❌
  2. Stem `"Companies"` → `"company"` ✅
  3. Stem `"company"` → `"company"` ✅
  4. Match found! Entry is included ✅

**Why this matters:** Without stemming, `"Companies House"` wouldn't match `"company"` in the glossary, missing important terminology.

---

### Complete Glossary Flow

```
1. Load all glossary entries (up to 200)
   ↓
2. Filter by direction (match or swap)
   ↓
3. Filter by document context (domain/client/type)
   ↓
4. Filter by source text presence (with stemming)
   ↓
5. Send filtered glossary to AI (only relevant terms)
```

**Result:** Only glossary terms that are:
- Correctly oriented for translation direction
- Relevant to document context
- Actually present in the source text (accounting for word variations)

---

## TM Hybrid Search

The Translation Memory (TM) search combines semantic (vector) and text-based (fuzzy) matching to find the best translation examples.

### Two-Path Search Strategy

#### Path 1: Vector Search (Semantic Meaning)

**Location:** `backend/src/services/vector-search.service.ts`

**What it does:**
- Uses AI embeddings to find semantically similar translations
- Finds matches based on meaning, not exact text similarity

**Process:**
1. Generate embedding for query text (1536-dimensional vector)
2. Search database using cosine similarity
3. Return matches above similarity threshold (default: 50%)

**Example:**
- Query: `"The project involves land acquisition"`
- TM Entry: `"Проект предусматривает изъятие земельных участков"`
- Vector similarity: 85% (high semantic match despite different wording)

**Score Conversion:**
- Vector similarity (0-1) is converted to fuzzyScore (0-100) for consistency
- Example: 0.85 similarity → 85% fuzzyScore

---

#### Path 2: Fuzzy Search (Text Similarity)

**Location:** `backend/src/services/tm.service.ts`

**What it does:**
- Uses Levenshtein distance and token overlap to find textually similar translations
- Finds matches based on character/word similarity

**Process:**
1. Pre-filter candidates by length and word overlap (fast checks)
2. Calculate fuzzy score: `(levenshteinRatio * 0.7 + tokenOverlapRatio * 0.3) * 100`
3. Return matches above minimum score threshold (default: 50%)

**Example:**
- Query: `"The project involves land acquisition"`
- TM Entry: `"The project involves land acquisition process"`
- Fuzzy score: 78% (high text match, minor difference)

---

### Hybrid Merge Logic: Max(Vector, Fuzzy)

**Location:** `backend/src/services/tm.service.ts` - Lines 581-663

**What it does:**
- Combines results from both search methods
- Uses the maximum score when the same entry is found by both methods

**Process:**

1. **Add Vector Results:**
   - Include if: `vectorSimilarity >= minVectorSimilarity` OR `fuzzyScore >= minScore`
   - This ensures vector matches aren't excluded by high fuzzy thresholds
   - Mark as `searchMethod: 'vector'`

2. **Add Fuzzy Results:**
   - Include if: `fuzzyScore >= minScore`
   - Mark as `searchMethod: 'fuzzy'`

3. **Merge & Deduplicate:**
   - If same entry found by both methods:
     - Use the higher score
     - Mark as `searchMethod: 'hybrid'`
   - If entry found by only one method, keep it as-is

4. **Final Sorting:**
   - Sort by scope (project entries first, then global)
   - Then by score (highest first)

**Example Scenario:**

**Entry A:** Found by vector (90% semantic), fuzzy (40% text)
- Vector score: 90%
- Fuzzy score: 40%
- **Result:** Included with 90% score, marked as `'vector'` ✅
- **Why:** High semantic similarity overrides low text similarity

**Entry B:** Found by both methods
- Vector score: 75%
- Fuzzy score: 85%
- **Result:** Included with 85% score, marked as `'hybrid'` ✅
- **Why:** Maximum of both scores is used

**Entry C:** Found by fuzzy only (60% text)
- Fuzzy score: 60%
- **Result:** Included with 60% score, marked as `'fuzzy'` ✅

---

### Thresholds

**Vector Similarity Threshold:**
- Default: 50% (0.5)
- Configurable via `vectorSimilarity` parameter
- Independent of fuzzy `minScore`
- Lower = more semantic matches (broader search)

**Fuzzy Minimum Score:**
- Default: 50%
- Configurable via `minScore` parameter
- Independent of vector similarity
- Higher = stricter text matching (fewer matches)

**Why Two Thresholds:**
- Vector search finds semantically similar but textually different matches
- Fuzzy search finds textually similar but semantically different matches
- Using separate thresholds allows fine-tuning of each search type

---

### Search Scope

**Location:** `backend/src/services/tm.service.ts` - `fetchScopedEntries()`

**What it does:**
- Searches both project-specific and global TM entries
- Prioritizes project entries in results

**Logic:**
- If `projectId` is provided:
  - Search project TM entries (`projectId = provided`)
  - Search global TM entries (`projectId = null`)
  - Combine both sets
- If no `projectId`:
  - Search only global TM entries

**Sorting Priority:**
1. Project entries (higher priority)
2. Global entries (lower priority)
3. Within each scope: highest score first

---

## Inspector Panel

The Inspector Panel provides transparency into translation decisions by showing exactly what data was used to generate a translation.

**Location:** `frontend/src/components/editor/DebugInspectorPanel.tsx`  
**Backend:** `backend/src/services/ai.service.ts` - `getSegmentDebugInfo()`

### What It Shows

#### 1. TM Matches

**Data Source:** `searchTranslationMemory()` with `limit: 10`, `minScore: 0`

**Displays:**
- All TM matches found (up to 10)
- Match score (percentage)
- Search method: `[TEXT MATCH]` (fuzzy) or `[MEANING MATCH]` (vector/hybrid)
- Color coding:
  - 🟢 Green = Text match (fuzzy) - "Edit this slightly"
  - 🔵 Blue = Meaning match (vector) - "Use for context/inspiration"
- Scope (project or global)
- Source and target text of each match

**Why this matters:** You can see if the system found exact matches or semantic matches, helping you understand translation quality expectations.

---

#### 2. Glossary Terms

**Data Source:** Filtered glossary entries (after all three filtering stages)

**Displays:**
- Source term → Target term
- Forbidden status (if term should not be used)
- Notes (if any)
- Only shows terms that:
  - Match translation direction
  - Match document context
  - Appear in source text (with stemming)

**Why this matters:** You can verify that only relevant glossary terms were sent to the AI, not the entire project glossary.

---

#### 3. Context (Previous/Next Segments)

**Data Source:** Neighbor segments from the same document

**Displays:**
- Previous segment (if exists): source text, target text
- Next segment (if exists): source text, target text
- Segment index numbers

**Why this matters:** Shows the context the AI used to understand the current segment's place in the document.

---

#### 4. Final Prompt

**Data Source:** `orchestrator.buildPromptForSegment()`

**Displays:**
- Complete prompt sent to the AI model
- Includes all sections: guidelines, glossary, examples, context, segments
- Copy-to-clipboard button for easy inspection
- Character count

**Why this matters:** You can see exactly what instructions and data the AI received, helping debug translation issues.

---

### Data Flow

```
User clicks segment
   ↓
Frontend calls GET /api/segments/:segmentId/debug
   ↓
Backend: getSegmentDebugInfo()
   ├─→ Search TM (10 matches, all scores)
   ├─→ Get neighbor segments
   ├─→ Filter glossary (direction → context → source text)
   └─→ Build prompt using orchestrator
   ↓
Return JSON with all debug data
   ↓
Frontend displays in collapsible panel
```

---

## AI Orchestrator

The AI Orchestrator builds comprehensive prompts that guide the AI model to produce accurate, context-aware translations.

**Location:** `backend/src/ai/orchestrator.ts`

### Prompt Building Process

The orchestrator builds prompts in a specific order, ensuring all context is properly structured.

#### Step 1: Build Context Sections

**Project Context:**
- Project name, client, domain
- Project summary/description
- Document name and summary (if available)
- Cluster summary (if document is part of a cluster)

**Document Context:**
- Document name
- Document summary
- Cluster summary (broader context)

---

#### Step 2: Build Guidelines Section

**Source:** Project guidelines (from `ProjectGuideline` table)

**Format:**
```
=== TRANSLATION GUIDELINES ===
Follow ALL guidelines strictly:
1. [Guideline 1]
2. [Guideline 2]
...
```

**Purpose:** Provides project-specific translation rules and preferences.

---

#### Step 3: Build Glossary Section

**Source:** Filtered glossary entries (after all three filtering stages)

**Format:**
```
=== GLOSSARY ===
Glossary (must be enforced exactly):
- "term1" → "translation1" (FORBIDDEN)
- "term2" → "translation2"
...
```

**Purpose:** Ensures consistent terminology and prevents forbidden terms.

---

#### Step 4: Build Translation Examples Section

**Source:** TM matches (used as RAG examples)

**Format:**
```
=== TRANSLATION EXAMPLES ===
Here are similar translations from your Translation Memory:

Example 1 (85% similarity):
Source: [source text]
Target: [target text]

Guidelines:
- Use these as reference for style and terminology
- Adapt the examples to fit the current segment context
```

**Purpose:** Provides real examples of how similar text was translated before (RAG - Retrieval Augmented Generation).

---

#### Step 5: Build Natural Language Instructions

**Source:** Language-specific instructions based on target language

**For UK English:**
- Prefer UK vocabulary (lift, boot, pavement)
- Use UK spelling conventions
- Maintain formal, professional tone

**For US English:**
- Use US vocabulary (elevator, trunk, sidewalk)
- Use US spelling conventions
- Maintain professional tone

**For Other Languages:**
- Language-specific instructions
- Address formatting rules (if applicable)

---

#### Step 6: Build Segments Payload

**Format:**
```json
[
  {
    "segment_id": "seg-123",
    "source": "Source text to translate",
    "neighbors": {
      "previous": "Previous segment text",
      "next": "Next segment text"
    },
    "summary": "Document summary (if available)"
  }
]
```

**Purpose:** Provides the actual text to translate with context from neighboring segments.

---

### Complete Prompt Structure

```
You are a professional technical/legal translator.

=== TRANSLATION TASK ===
YOUR TASK: Translate text from [Source Language] to [Target Language].
SOURCE LANGUAGE: [Language] (code: [code])
TARGET LANGUAGE: [Language] (code: [code])
TRANSLATION DIRECTION: [Source] → [Target]

[Natural Language Instructions]

CRITICAL RULES:
1. Input text is written in [Source Language]
2. You MUST translate it to [Target Language]
3. Output text MUST be written in [Target Language] ONLY
...

=== PROJECT CONTEXT ===
Project: [Name] | Client: [Client] | Domain: [Domain]
Project summary: [Summary]
Document: [Document Name]
Document summary: [Summary]

=== TRANSLATION EXAMPLES ===
[TM Examples with similarity scores]

=== TRANSLATION GUIDELINES ===
[Project Guidelines]

=== GLOSSARY ===
[Filtered Glossary Terms]

=== OUTPUT FORMAT ===
[{"segment_id":"<id>","target_mt":"<translation>"}]

=== SEGMENTS TO TRANSLATE ===
[JSON array of segments with neighbors]
```

---

### Key Design Principles

1. **Explicit Direction:** Multiple reminders about source/target language to prevent model confusion
2. **Context First:** Project and document context appear early in the prompt
3. **Examples Before Rules:** TM examples provide style reference before strict guidelines
4. **Glossary Enforcement:** Glossary terms are clearly marked as "must be enforced exactly"
5. **Neighbor Context:** Previous/next segments help maintain consistency within the document

---

## Summary

### Glossary Logic
- **Three-stage filtering:** Direction → Context → Source Text (with stemming)
- **Stemming:** Handles word variations (plurals, case endings) for English and Russian
- **Result:** Only relevant, correctly-oriented terms are sent to AI

### TM Hybrid Search
- **Two-path search:** Vector (semantic) + Fuzzy (text)
- **Merge logic:** Max(Vector, Fuzzy) score when both find the same entry
- **Separate thresholds:** Vector similarity and fuzzy minScore are independent
- **Scope:** Searches both project and global TM, prioritizes project entries

### Inspector Panel
- **Transparency:** Shows exactly what data was used for translation
- **Four sections:** TM matches, Glossary terms, Context segments, Final prompt
- **Color coding:** Green = text match, Blue = meaning match

### AI Orchestrator
- **Structured prompts:** Context → Examples → Guidelines → Glossary → Segments
- **Language-specific:** Adapts instructions based on target language
- **RAG integration:** Uses TM examples as translation references

---

**Last Updated:** 2025-12-07  
**Maintainer:** Update this file when adding new features or changing core logic.



