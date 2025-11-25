# RAG Implementation Plan: Vector Embeddings for Translation Memory

## Executive Summary

This plan outlines the implementation of **Retrieval-Augmented Generation (RAG)** using vector embeddings to enhance the Translation Memory (TM) system. The goal is to improve translation quality by enabling semantic similarity search, which finds conceptually similar translations even when exact word matches don't exist.

---

## 1. Architecture Overview

### Current Architecture
```
User Query → Fuzzy Search (Levenshtein) → TM Results → AI Translation
```

### Enhanced Architecture (RAG)
```
User Query → [Vector Search + Fuzzy Search] → Hybrid Results → Reranking → AI Translation
                ↓
         Embedding Generation
                ↓
         Vector Database (pgvector)
```

### Key Components

1. **Embedding Service**: Generates vector embeddings for source text
2. **Vector Database**: Stores and searches embeddings (using PostgreSQL pgvector extension)
3. **Hybrid Search**: Combines vector similarity + fuzzy matching
4. **Reranking**: Improves result quality by cross-encoder scoring
5. **Fallback System**: Maintains current fuzzy search as backup

---

## 2. Technology Choices

### 2.1 Embedding Model Options

| Option | Pros | Cons | Cost | Recommendation |
|--------|------|------|------|----------------|
| **OpenAI text-embedding-3-small** | High quality, multilingual, easy API | Requires API key, per-request cost | ~$0.02/1M tokens | ✅ **Recommended** |
| **OpenAI text-embedding-3-large** | Best quality | More expensive | ~$0.13/1M tokens | For premium tier |
| **Sentence Transformers (local)** | Free, no API calls | Requires GPU, setup complexity | Free (compute cost) | For self-hosted |
| **Cohere embed-english-v3.0** | Good quality | English-focused | ~$0.10/1M tokens | Alternative |

**Decision**: Start with **OpenAI text-embedding-3-small** (1536 dimensions)
- Best balance of quality, cost, and multilingual support
- Can switch models later without schema changes

### 2.2 Vector Database Options

| Option | Pros | Cons | Recommendation |
|--------|------|------|----------------|
| **pgvector (PostgreSQL extension)** | Native integration, no new DB, ACID compliance | Requires PostgreSQL 11+ | ✅ **Recommended** |
| **Pinecone** | Managed service, easy scaling | Additional service, cost | For large scale |
| **Qdrant** | Open source, good performance | Requires separate service | Alternative |
| **Chroma** | Lightweight, Python-focused | Less mature | Not recommended |

**Decision**: Use **pgvector** extension
- Already using PostgreSQL
- No additional infrastructure
- Seamless integration with Prisma
- Free (no additional cost)

### 2.3 Reranking Options

| Option | Pros | Cons | Recommendation |
|--------|------|------|----------------|
| **Cross-encoder (local)** | Best accuracy | Requires model hosting | ✅ **Phase 2** |
| **Cohere Rerank API** | Easy integration | API cost | Alternative |
| **Skip reranking** | Simple, fast | Lower quality | ✅ **Phase 1** |

**Decision**: 
- **Phase 1**: Skip reranking (keep simple)
- **Phase 2**: Add cross-encoder reranking if needed

---

## 3. Database Schema Changes

### 3.1 Prisma Schema Updates

```prisma
// Add to TranslationMemoryEntry model
model TranslationMemoryEntry {
  // ... existing fields ...
  
  // NEW: Vector embedding for semantic search
  sourceEmbedding    Unsupported("vector(1536)")?  // pgvector type
  embeddingModel    String?                        // Track which model was used
  embeddingVersion  String?                        // Track model version
  embeddingUpdatedAt DateTime?                     // When embedding was generated
  
  // Index for vector similarity search
  @@index([sourceEmbedding(ops: vector_cosine_ops)], type: Hnsw, map: "tm_source_embedding_idx")
}

// Add to Segment model (for contextual retrieval)
model Segment {
  // ... existing fields ...
  
  // NEW: Optional embedding for document-level semantic search
  sourceEmbedding    Unsupported("vector(1536)")?
  embeddingModel    String?
  embeddingUpdatedAt DateTime?
  
  @@index([sourceEmbedding(ops: vector_cosine_ops)], type: Hnsw, map: "segment_source_embedding_idx")
}
```

### 3.2 Migration Strategy

**Step 1**: Enable pgvector extension
```sql
CREATE EXTENSION IF NOT EXISTS vector;
```

**Step 2**: Add embedding columns (nullable initially)
```sql
ALTER TABLE "TranslationMemoryEntry" 
ADD COLUMN "sourceEmbedding" vector(1536),
ADD COLUMN "embeddingModel" TEXT,
ADD COLUMN "embeddingVersion" TEXT,
ADD COLUMN "embeddingUpdatedAt" TIMESTAMP;
```

**Step 3**: Create vector indexes (after populating some embeddings)
```sql
CREATE INDEX tm_source_embedding_idx 
ON "TranslationMemoryEntry" 
USING hnsw (sourceEmbedding vector_cosine_ops);
```

---

## 4. Implementation Phases

### Phase 1: Foundation (Week 1-2)
**Goal**: Basic vector search working alongside fuzzy search

#### Tasks:
1. **Setup & Dependencies**
   - Install `pgvector` extension in PostgreSQL
   - Add `@prisma/extension-pgvector` or use raw SQL for vector operations
   - Add OpenAI SDK for embeddings (`openai` package)
   - Update Prisma schema with embedding fields

2. **Embedding Service**
   - Create `backend/src/services/embedding.service.ts`
   - Functions:
     - `generateEmbedding(text: string): Promise<number[]>`
     - `generateEmbeddingsBatch(texts: string[]): Promise<number[][]>`
   - Add caching for embeddings (avoid regenerating)
   - Add error handling and retries

3. **Database Integration**
   - Create migration for embedding columns
   - Add helper functions for vector operations:
     - `storeEmbedding(entryId: string, embedding: number[])`
     - `searchByVector(queryEmbedding: number[], limit: number, filters)`

4. **Hybrid Search**
   - Update `searchTranslationMemory()` in `tm.service.ts`
   - Combine vector search + fuzzy search
   - Merge and deduplicate results
   - Maintain backward compatibility (fallback to fuzzy if no embeddings)

#### Success Criteria:
- ✅ Can generate embeddings for TM entries
- ✅ Can search using vector similarity
- ✅ Hybrid search returns better results than fuzzy alone
- ✅ No breaking changes to existing API

---

### Phase 2: Batch Processing & Migration (Week 3)
**Goal**: Generate embeddings for existing TM entries

#### Tasks:
1. **Background Job System**
   - Create `backend/src/jobs/embedding-generation.ts`
   - Process TM entries in batches (100 at a time)
   - Rate limiting (respect OpenAI API limits)
   - Progress tracking

2. **Migration Script**
   - Script to generate embeddings for all existing entries
   - Resume capability (skip already-embedded entries)
   - Error handling and logging

3. **Real-time Embedding**
   - Auto-generate embeddings when new TM entries are created
   - Update embeddings when entries are modified
   - Queue system for high-volume imports

#### Success Criteria:
- ✅ All existing TM entries have embeddings
- ✅ New entries automatically get embeddings
- ✅ Migration can resume after interruption

---

### Phase 3: Enhanced Search (Week 4)
**Goal**: Optimize search quality and performance

#### Tasks:
1. **Search Optimization**
   - Tune hybrid search weights (vector vs fuzzy)
   - Implement result deduplication
   - Add result scoring normalization

2. **Contextual Retrieval**
   - Retrieve semantically similar segments from document
   - Use for better consistency in AI translation
   - Add to `buildOrchestratorSegment()` context

3. **Caching Strategy**
   - Cache query embeddings (same query = same embedding)
   - Cache search results (with TTL)
   - Invalidate cache on TM updates

#### Success Criteria:
- ✅ Search is faster than before
- ✅ Results are more relevant
- ✅ Better translation consistency

---

### Phase 4: Advanced Features (Optional, Week 5+)
**Goal**: Add reranking and advanced RAG features

#### Tasks:
1. **Reranking**
   - Implement cross-encoder reranking
   - Reorder results by semantic relevance
   - A/B test quality improvement

2. **Multi-hop Retrieval**
   - Iterative query refinement
   - Expand search based on initial results

3. **Analytics**
   - Track embedding usage
   - Measure quality improvements
   - Cost monitoring

---

## 5. Code Structure

### New Files

```
backend/src/
├── services/
│   ├── embedding.service.ts          # Embedding generation
│   └── vector-search.service.ts      # Vector search operations
├── jobs/
│   └── embedding-generation.ts       # Background job for batch processing
├── utils/
│   └── pgvector.ts                   # pgvector helper functions
└── migrations/
    └── add-embeddings.ts              # Migration script
```

### Modified Files

```
backend/src/services/
├── tm.service.ts                      # Add hybrid search
└── ai.service.ts                      # Use enhanced TM results

backend/prisma/
└── schema.prisma                       # Add embedding fields
```

---

## 6. API Changes

### 6.1 New Endpoints

```typescript
// Generate embeddings for existing entries
POST /api/tm/generate-embeddings
Body: { entryIds?: string[], batchSize?: number }
Response: { jobId: string, totalEntries: number }

// Check embedding generation progress
GET /api/tm/embedding-status
Response: { 
  totalEntries: number,
  embeddedEntries: number,
  progress: number,
  status: 'idle' | 'processing' | 'completed'
}

// Force regenerate embedding for entry
POST /api/tm/entries/:id/regenerate-embedding
```

### 6.2 Enhanced Search Options

```typescript
// Existing endpoint enhanced
POST /api/tm/search
Body: {
  sourceText: string,
  sourceLocale: string,
  targetLocale: string,
  projectId?: string,
  limit?: number,
  minScore?: number,
  // NEW options:
  useVectorSearch?: boolean,      // Default: true if embeddings available
  hybridWeight?: number,           // 0-1, weight for vector vs fuzzy (default: 0.7)
  semanticThreshold?: number       // Minimum cosine similarity (default: 0.7)
}
```

---

## 7. Migration Strategy

### 7.1 Zero-Downtime Migration

1. **Add columns** (nullable, no breaking changes)
2. **Generate embeddings** (background process, doesn't block)
3. **Enable vector search** (feature flag, gradual rollout)
4. **Monitor performance** (compare results)
5. **Optimize** (tune weights, indexes)

### 7.2 Rollback Plan

- Keep fuzzy search as primary fallback
- Feature flag to disable vector search
- Can remove embedding columns if needed (data loss acceptable)

### 7.3 Data Migration Script

```typescript
// backend/scripts/migrate-embeddings.ts
async function migrateEmbeddings() {
  const totalEntries = await prisma.translationMemoryEntry.count({
    where: { sourceEmbedding: null }
  });
  
  const batchSize = 100;
  let processed = 0;
  
  while (processed < totalEntries) {
    const entries = await prisma.translationMemoryEntry.findMany({
      where: { sourceEmbedding: null },
      take: batchSize,
      select: { id: true, sourceText: true }
    });
    
    const embeddings = await generateEmbeddingsBatch(
      entries.map(e => e.sourceText)
    );
    
    await Promise.all(
      entries.map((entry, i) =>
        prisma.translationMemoryEntry.update({
          where: { id: entry.id },
          data: {
            sourceEmbedding: embeddings[i],
            embeddingModel: 'text-embedding-3-small',
            embeddingVersion: '1.0',
            embeddingUpdatedAt: new Date()
          }
        })
      )
    );
    
    processed += entries.length;
    console.log(`Processed ${processed}/${totalEntries}`);
    
    // Rate limiting
    await sleep(1000); // 1 second between batches
  }
}
```

---

## 8. Testing Strategy

### 8.1 Unit Tests

- Embedding generation
- Vector search functions
- Hybrid search merging logic
- Error handling

### 8.2 Integration Tests

- End-to-end search flow
- Migration script
- API endpoints

### 8.3 Quality Tests

- Compare fuzzy vs vector vs hybrid results
- Measure translation quality improvement
- A/B test with real translations

### 8.4 Performance Tests

- Search latency (target: <200ms)
- Batch processing throughput
- Database query performance

---

## 9. Cost Analysis

### 9.1 Embedding Generation Costs

**Assumptions:**
- Average segment length: 20 words = ~30 tokens
- 1M tokens = $0.02 (text-embedding-3-small)
- 1000 TM entries = ~30,000 tokens = $0.0006

**One-time Migration:**
- 10,000 entries: ~$0.006
- 100,000 entries: ~$0.06
- 1,000,000 entries: ~$0.60

**Ongoing Costs:**
- New entries: ~$0.0006 per 1000 entries
- Query embeddings: ~$0.0006 per 1000 searches
- **Total monthly**: ~$1-5 for typical usage

### 9.2 Storage Costs

- Each embedding: 1536 dimensions × 4 bytes = 6KB
- 100,000 entries: ~600MB
- **Negligible** compared to existing database

### 9.3 Infrastructure Costs

- **pgvector**: Free (PostgreSQL extension)
- **No additional services**: $0

**Total Estimated Monthly Cost: $1-10** (mostly OpenAI API)

---

## 10. Risk Mitigation

### 10.1 Technical Risks

| Risk | Impact | Mitigation |
|------|--------|------------|
| pgvector not available | High | Check PostgreSQL version, provide upgrade guide |
| Embedding API failures | Medium | Retry logic, fallback to fuzzy search |
| Performance degradation | Medium | Index optimization, query tuning |
| Migration failures | Low | Resume capability, error logging |

### 10.2 Business Risks

| Risk | Impact | Mitigation |
|------|--------|------------|
| Increased API costs | Low | Cost monitoring, usage limits |
| Quality not improved | Medium | A/B testing, gradual rollout |
| User confusion | Low | Feature flag, clear documentation |

---

## 11. Success Metrics

### 11.1 Quality Metrics

- **Translation Quality Score**: Measure improvement in AI translations
- **TM Match Rate**: % of segments with good TM matches (target: +20%)
- **User Satisfaction**: Feedback on translation suggestions

### 11.2 Performance Metrics

- **Search Latency**: <200ms (target)
- **Search Accuracy**: Better than fuzzy alone (measured by user acceptance)
- **Coverage**: % of queries benefiting from vector search

### 11.3 Business Metrics

- **Cost per Translation**: Should decrease (better matches = less AI usage)
- **Time Saved**: Faster translation workflow
- **Adoption Rate**: % of users using enhanced search

---

## 12. Timeline

| Phase | Duration | Deliverables |
|-------|----------|--------------|
| **Phase 1: Foundation** | 2 weeks | Basic vector search working |
| **Phase 2: Migration** | 1 week | All entries have embeddings |
| **Phase 3: Optimization** | 1 week | Production-ready search |
| **Phase 4: Advanced** | 2 weeks | Reranking, analytics |
| **Total** | **4-6 weeks** | Full RAG implementation |

---

## 13. Dependencies

### 13.1 External Services

- ✅ OpenAI API (already integrated)
- ✅ PostgreSQL 11+ (already using)
- ⚠️ pgvector extension (needs installation)

### 13.2 New Packages

```json
{
  "dependencies": {
    "openai": "^4.0.0",              // Embedding generation
    "@prisma/extension-pgvector": "^0.1.0"  // Prisma pgvector support
  }
}
```

### 13.3 Database Requirements

- PostgreSQL 11+ (for pgvector)
- pgvector extension installed
- Sufficient disk space (embeddings are small)

---

## 14. Rollout Plan

### 14.1 Feature Flags

```typescript
// backend/src/utils/featureFlags.ts
export const featureFlags = {
  vectorSearch: {
    enabled: process.env.ENABLE_VECTOR_SEARCH === 'true',
    hybridWeight: parseFloat(process.env.VECTOR_HYBRID_WEIGHT || '0.7'),
    minSimilarity: parseFloat(process.env.VECTOR_MIN_SIMILARITY || '0.7')
  }
};
```

### 14.2 Gradual Rollout

1. **Week 1**: Internal testing (10% of searches)
2. **Week 2**: Beta users (50% of searches)
3. **Week 3**: All users (100% of searches)
4. **Week 4**: Monitor and optimize

### 14.3 Monitoring

- Track embedding generation success rate
- Monitor search performance
- Measure quality improvements
- Alert on cost spikes

---

## 15. Future Enhancements

### 15.1 Short-term (3-6 months)

- Multi-language embedding models
- Document-level semantic search
- Glossary term embeddings
- Segment similarity clustering

### 15.2 Long-term (6-12 months)

- Fine-tuned embedding models
- Domain-specific embeddings
- Active learning (improve embeddings from user feedback)
- Cross-project knowledge sharing

---

## 16. Questions & Decisions Needed

### 16.1 Open Questions

1. **Embedding Model**: Confirm OpenAI text-embedding-3-small?
2. **Hybrid Weight**: What ratio vector:fuzzy? (suggested: 70:30)
3. **Migration Priority**: Generate embeddings for all entries or on-demand?
4. **Feature Flag**: Enable by default or opt-in?

### 16.2 Decisions Required

- [ ] Approve technology choices
- [ ] Approve timeline (4-6 weeks)
- [ ] Approve budget (~$10/month ongoing)
- [ ] Approve database migration plan
- [ ] Approve rollout strategy

---

## 17. Next Steps

1. **Review this plan** with team
2. **Install pgvector** extension in development database
3. **Set up OpenAI API** for embeddings (if not already)
4. **Create feature branch** (`feature/vector-embeddings`)
5. **Start Phase 1** implementation

---

## Appendix: Example Code Structure

### Embedding Service

```typescript
// backend/src/services/embedding.service.ts
import OpenAI from 'openai';

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

export async function generateEmbedding(text: string): Promise<number[]> {
  const response = await openai.embeddings.create({
    model: 'text-embedding-3-small',
    input: text,
  });
  return response.data[0].embedding;
}

export async function generateEmbeddingsBatch(
  texts: string[]
): Promise<number[][]> {
  const response = await openai.embeddings.create({
    model: 'text-embedding-3-small',
    input: texts,
  });
  return response.data.map(item => item.embedding);
}
```

### Vector Search Service

```typescript
// backend/src/services/vector-search.service.ts
import { prisma } from '../db/prisma';

export async function searchByVector(
  queryEmbedding: number[],
  options: {
    projectId?: string;
    sourceLocale?: string;
    targetLocale?: string;
    limit?: number;
    minSimilarity?: number;
  }
) {
  const embeddingStr = `[${queryEmbedding.join(',')}]`;
  
  // Use raw SQL for vector similarity search
  const results = await prisma.$queryRaw<Array<{
    id: string;
    sourceText: string;
    targetText: string;
    similarity: number;
  }>>`
    SELECT 
      id,
      "sourceText",
      "targetText",
      1 - (sourceEmbedding <=> ${embeddingStr}::vector) as similarity
    FROM "TranslationMemoryEntry"
    WHERE 
      sourceEmbedding IS NOT NULL
      ${options.projectId ? `AND "projectId" = ${options.projectId}` : ''}
      ${options.sourceLocale ? `AND "sourceLocale" = ${options.sourceLocale}` : ''}
      ${options.targetLocale ? `AND "targetLocale" = ${options.targetLocale}` : ''}
      AND (1 - (sourceEmbedding <=> ${embeddingStr}::vector)) >= ${options.minSimilarity || 0.7}
    ORDER BY sourceEmbedding <=> ${embeddingStr}::vector
    LIMIT ${options.limit || 10}
  `;
  
  return results;
}
```

---

**Document Version**: 1.0  
**Last Updated**: 2025-01-20  
**Author**: AI Translation Studio Team



