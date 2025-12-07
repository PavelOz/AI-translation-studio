# Glossary Embeddings Guide

This guide explains how to generate embeddings for glossary entries to enable semantic phrase-based matching.

## Overview

Glossary embeddings enable semantic search for glossary terms, allowing the system to find similar phrases even when the exact wording doesn't match. This is especially useful for multi-word phrases and terminology variations.

## Prerequisites

1. **OpenAI API Key**: Make sure `OPENAI_API_KEY` is set in your `.env` file
2. **Database**: Ensure PostgreSQL with pgvector extension is running
3. **Migrations**: Run database migrations to ensure glossary embedding columns exist

## Generating Embeddings

### Check Current Status

First, check how many glossary entries already have embeddings:

```bash
cd backend
npx ts-node scripts/check-glossary-embeddings.ts
```

This will show:
- Total glossary entries
- Entries with embeddings
- Entries without embeddings
- Coverage percentage

### Generate Embeddings for All Entries

To generate embeddings for all glossary entries that don't have them:

```bash
cd backend
npx ts-node scripts/generate-glossary-embeddings.ts
```

This script will:
- Process entries in batches of 50
- Show real-time progress updates
- Display success/failure counts
- Estimate completion time

### Generate Embeddings for Specific Project

You can also generate embeddings programmatically for a specific project:

```typescript
import { generateEmbeddingsForExistingGlossaryEntries } from './src/services/embedding-generation.service';

const progressId = await generateEmbeddingsForExistingGlossaryEntries({
  projectId: 'your-project-id',
  batchSize: 50,
});
```

## How It Works

1. **Batch Processing**: Entries are processed in batches (default: 50) to optimize API usage
2. **Embedding Generation**: Uses OpenAI's `text-embedding-3-small` model (1536 dimensions)
3. **Storage**: Embeddings are stored in the `sourceEmbedding` column of `GlossaryEntry` table
4. **Caching**: The embedding service uses in-memory caching to avoid regenerating embeddings for duplicate terms

## Automatic Generation

Embeddings are automatically generated when:
- A new glossary entry is created
- A glossary entry's `sourceTerm` is updated

This happens in the background and won't block the API response.

## Monitoring Progress

While the generation script is running, you'll see progress updates every 2 seconds:

```
Progress update: {
  processed: 150,
  total: 500,
  succeeded: 148,
  failed: 2,
  status: 'running',
  rate: '2.5 entries/sec',
  eta: '140s'
}
```

## Troubleshooting

### Generation Stops Halfway

If embedding generation stops before completing all entries, it's usually due to:

1. **Rate Limits (429 errors)**: 
   - The script now includes automatic retry logic with exponential backoff (2s, 4s, 6s delays)
   - Increased delay between batches from 100ms to 500ms
   - The script will retry up to 3 times before marking a batch as failed
   - **Solution**: Wait a few minutes and re-run the script - it will continue from where it left off

2. **API Key Issues**:
   - Invalid or expired API key will stop the process
   - **Solution**: Check your `OPENAI_API_KEY` in `.env` file

3. **Network Issues**:
   - Transient network errors may cause batches to fail
   - **Solution**: Re-run the script - it will skip entries that already have embeddings

### No Embeddings Generated

- **Check API Key**: Ensure `OPENAI_API_KEY` is set correctly
- **Check Logs**: Look for error messages in the console
- **Check Database**: Verify entries exist and have non-empty `sourceTerm` values

### Slow Generation

- **Rate Limiting**: The script includes a 500ms delay between batches (increased from 100ms)
- **Batch Size**: Default is 50 entries per batch. You can adjust `batchSize` in the script (smaller = slower but more reliable)
- **API Limits**: Check your OpenAI API rate limits
- **Retry Delays**: Rate limit errors trigger exponential backoff delays (2s, 4s, 6s)

### Failed Entries

Some entries may fail to generate embeddings if:
- The `sourceTerm` is empty or invalid
- The API request fails after retries (network issues, rate limits, etc.)
- The embedding response is malformed
- Database storage fails for individual entries

Failed entries are logged but don't stop the process. You can re-run the script to retry failed entries - it will skip entries that already have embeddings.

### Resuming After Interruption

The script is designed to be resumable:
- Entries that already have embeddings are automatically skipped
- Simply re-run the script to continue processing remaining entries
- Progress is tracked in real-time, so you can see how many are left

## Usage in Application

Once embeddings are generated, the glossary search will automatically use semantic matching:

- **Exact Matches**: Still work as before (100% similarity)
- **Semantic Matches**: Find similar phrases even with different wording (75%+ similarity threshold)
- **Hybrid Matches**: Entries found by both exact and semantic search

The frontend `GlossaryPanel` component will show match type badges:
- 🟢 **Exact**: Exact substring match
- 🟣 **Semantic**: Semantic similarity match (with percentage)
- 🔵 **Hybrid**: Found by both methods

## Cost Estimation

Using OpenAI's `text-embedding-3-small` model:
- **Cost**: ~$0.02 per 1M tokens
- **Average**: ~10-50 tokens per glossary term
- **1000 entries**: ~$0.001 - $0.001 (very cheap)

Most glossary entries are short phrases, so costs are minimal.

## Next Steps

After generating embeddings:
1. Test semantic search in the glossary panel
2. Verify that phrase variations are being found
3. Adjust similarity threshold if needed (default: 75%)

