# RAG Implementation: Next Steps

## Current Status ✅

### Completed Phases

**Phase 1: Foundation** ✅
- ✅ Vector embeddings infrastructure (pgvector)
- ✅ Database schema with embedding columns
- ✅ HNSW indexes for fast similarity search
- ✅ Embedding service (OpenAI integration)
- ✅ Hybrid search (vector + fuzzy)
- ✅ UI controls (similarity sliders, search method badges)

**Phase 2: Embedding Generation** ✅
- ✅ Background job for generating embeddings
- ✅ Progress tracking and cancellation
- ✅ API endpoints for monitoring
- ✅ **Current Coverage: 88.8%** (48,211 / 54,261 entries)
- ⚠️ **Remaining: 6,050 entries** (~1-2 hours to complete)

---

## Phase 3: Enhanced Search (Next Steps) 🚀

### Priority 1: Complete Embedding Generation

**Goal**: Reach 100% coverage for all TM entries

**Action**:
```bash
cd backend
npx ts-node scripts/generate-all-embeddings.ts
```

**Monitor**:
```bash
# Check completion status
npx ts-node scripts/check-embedding-completion.ts

# Real-time monitoring
npx ts-node scripts/monitor-embeddings.ts
```

**Estimated Time**: 1-2 hours

---

### Priority 2: Search Optimization

**Goal**: Improve search quality and performance

#### 2.1 Tune Hybrid Search Weights

Currently, hybrid search merges vector and fuzzy results, but we can optimize:

**Tasks**:
- [ ] Add configurable weights for vector vs fuzzy scores
- [ ] Implement weighted scoring: `finalScore = (vectorScore * vectorWeight) + (fuzzyScore * fuzzyWeight)`
- [ ] A/B test different weight combinations (e.g., 70% vector, 30% fuzzy)
- [ ] Add UI control for weight adjustment

**Files to Modify**:
- `backend/src/services/tm.service.ts` - Hybrid merge logic
- `frontend/src/components/editor/TMSuggestionsPanel.tsx` - Add weight slider

**Default Weights** (suggested):
- Vector: 0.7 (semantic similarity is more important)
- Fuzzy: 0.3 (text similarity confirms the match)

#### 2.2 Result Scoring Normalization

**Tasks**:
- [ ] Normalize vector similarity (0-1) and fuzzy score (0-100) to same scale
- [ ] Implement combined score calculation
- [ ] Sort results by combined score

**Current Issue**: Vector similarity is 0-1, fuzzy score is 0-100, making comparison difficult.

**Solution**: Normalize both to 0-100 scale before merging.

#### 2.3 Performance Optimization

**Tasks**:
- [ ] Add query result caching (TTL: 5 minutes)
- [ ] Cache query embeddings (same text = same embedding)
- [ ] Optimize vector search queries (limit early termination)
- [ ] Add database query performance monitoring

**Files to Create**:
- `backend/src/services/search-cache.service.ts` - Caching layer

---

### Priority 3: Contextual Retrieval

**Goal**: Use vector search to find semantically similar segments within the document for better AI translation consistency

#### 3.1 Document-Level Vector Search

**Current State**: AI translation uses neighbor segments (previous/next) for context.

**Enhancement**: Use vector search to find semantically similar segments in the same document.

**Tasks**:
- [ ] Generate embeddings for document segments (on document upload)
- [ ] Create `searchSimilarSegments()` function
- [ ] Retrieve top 3-5 semantically similar segments
- [ ] Add to AI context in `buildOrchestratorSegment()`

**Benefits**:
- Better translation consistency within document
- Handles cases where similar concepts appear in different parts
- Improves terminology consistency

**Files to Modify**:
- `backend/src/services/segment.service.ts` - Add embedding generation
- `backend/src/services/ai.service.ts` - Add similar segments to context
- `backend/src/ai/orchestrator.ts` - Include similar segments in prompt

**Example**:
```typescript
// Find semantically similar segments in document
const similarSegments = await searchSimilarSegments({
  segmentId: currentSegment.id,
  documentId: document.id,
  limit: 5,
  minSimilarity: 0.7
});

// Add to AI context
const aiContext = {
  ...existingContext,
  similarSegments: similarSegments.map(s => ({
    source: s.sourceText,
    target: s.targetFinal || s.targetMt
  }))
};
```

#### 3.2 Cross-Document Semantic Search

**Future Enhancement**: Find similar segments across projects for domain-specific consistency.

---

### Priority 4: Caching Strategy

**Goal**: Reduce API calls and improve response times

#### 4.1 Query Embedding Cache

**Tasks**:
- [ ] Cache generated embeddings for query text
- [ ] Use text hash as cache key
- [ ] TTL: 24 hours (embeddings don't change)

**Implementation**:
```typescript
// backend/src/services/embedding.service.ts
const queryEmbeddingCache = new Map<string, { embedding: number[], timestamp: number }>();
const QUERY_CACHE_TTL = 24 * 60 * 60 * 1000; // 24 hours

async function generateEmbedding(text: string, isQuery: boolean = false): Promise<number[]> {
  if (isQuery) {
    const cacheKey = hashText(text);
    const cached = queryEmbeddingCache.get(cacheKey);
    if (cached && Date.now() - cached.timestamp < QUERY_CACHE_TTL) {
      return cached.embedding;
    }
  }
  // ... generate embedding
}
```

#### 4.2 Search Results Cache

**Tasks**:
- [ ] Cache search results with query parameters as key
- [ ] TTL: 5 minutes (TM can change)
- [ ] Invalidate cache on TM updates

**Implementation**:
```typescript
// backend/src/services/search-cache.service.ts
const searchCache = new Map<string, { results: TmSearchResult[], timestamp: number }>();
const SEARCH_CACHE_TTL = 5 * 60 * 1000; // 5 minutes

function getCacheKey(options: TmSearchOptions): string {
  return `${options.sourceText}:${options.sourceLocale}:${options.targetLocale}:${options.projectId || 'global'}`;
}
```

**Cache Invalidation**:
- On TM entry create/update/delete
- On TMX import
- Manual cache clear endpoint

---

## Phase 4: Advanced Features (Future) 🔮

### 4.1 Reranking (Optional)

**Goal**: Improve result relevance using cross-encoder models

**Tasks**:
- [ ] Research reranking options (Cohere API vs local model)
- [ ] Implement reranking service
- [ ] Reorder hybrid results by semantic relevance
- [ ] A/B test quality improvement

**Cost Consideration**: 
- Cohere Rerank API: ~$0.10 per 1,000 searches
- Local model: Free but requires GPU

### 4.2 Multi-hop Retrieval (Optional)

**Goal**: Chain multiple searches for complex queries

**Tasks**:
- [ ] Implement query expansion based on initial results
- [ ] Use retrieved matches to find related entries
- [ ] Combine results from multiple hops

### 4.3 Analytics & Monitoring

**Tasks**:
- [ ] Track embedding usage and costs
- [ ] Measure quality improvements (user acceptance rate)
- [ ] Monitor search performance (latency, cache hit rate)
- [ ] Dashboard for RAG metrics

---

## Implementation Order

### Week 1: Complete & Optimize
1. ✅ Complete embedding generation (Priority 1)
2. ✅ Search optimization (Priority 2.1, 2.2)
3. ✅ Performance optimization (Priority 2.3)

### Week 2: Contextual Retrieval
4. ✅ Document-level vector search (Priority 3.1)
5. ✅ Caching strategy (Priority 4)

### Week 3: Advanced Features (Optional)
6. ⏸️ Reranking (Phase 4.1)
7. ⏸️ Analytics dashboard (Phase 4.3)

---

## Success Metrics

### Quality Metrics
- **TM Match Rate**: Target +20% improvement
- **Translation Quality**: User acceptance rate >85%
- **Search Relevance**: Hybrid matches preferred over fuzzy-only

### Performance Metrics
- **Search Latency**: <200ms (with caching)
- **Cache Hit Rate**: >60% for frequent queries
- **API Cost**: <$10/month (OpenAI embeddings)

### Coverage Metrics
- **Embedding Coverage**: 100% of TM entries
- **Segment Embeddings**: 100% of document segments (for contextual retrieval)

---

## Quick Start: Next Immediate Steps

1. **Complete Embedding Generation**:
   ```bash
   cd backend
   npx ts-node scripts/generate-all-embeddings.ts
   ```

2. **Test Hybrid Search**:
   - Open editor
   - Test with different segments
   - Verify hybrid matches appear
   - Adjust similarity thresholds

3. **Start Search Optimization**:
   - Implement weighted scoring
   - Add result normalization
   - Test performance improvements

---

## Questions to Consider

1. **Weight Configuration**: Should vector/fuzzy weights be:
   - Fixed (70/30)?
   - User-configurable?
   - Adaptive based on query?

2. **Contextual Retrieval**: How many similar segments?
   - 3-5 segments (recommended)
   - Configurable per project?

3. **Caching Strategy**: 
   - Cache all queries or only frequent ones?
   - What TTL for different cache types?

4. **Reranking**: 
   - Worth the cost/complexity?
   - When to implement?

---

**Last Updated**: 2025-11-21  
**Status**: Phase 3 Ready to Start



