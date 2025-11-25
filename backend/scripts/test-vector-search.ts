import { PrismaClient } from '@prisma/client';
import { searchTranslationMemory } from '../src/services/tm.service';
import { generateEmbedding } from '../src/services/embedding.service';
import { searchByVector } from '../src/services/vector-search.service';
import { getEmbeddingStats } from '../src/services/vector-search.service';

const prisma = new PrismaClient();

async function testVectorSearch() {
  console.log('🔍 Testing Vector Search with Embeddings...\n');

  try {
    // Check embedding stats
    console.log('1. Checking embedding coverage...');
    const stats = await getEmbeddingStats();
    console.log(`   Total entries: ${stats.total}`);
    console.log(`   With embeddings: ${stats.withEmbedding}`);
    console.log(`   Coverage: ${stats.coverage}%\n`);

    if (stats.withEmbedding === 0) {
      console.log('⚠️  No embeddings found. Please generate embeddings first.\n');
      return;
    }

    // Get some sample entries to test with
    console.log('2. Fetching sample entries for testing...');
    const sampleEntries = await prisma.$queryRawUnsafe<Array<{
      id: string;
      sourceText: string;
      targetText: string;
      sourceLocale: string;
      targetLocale: string;
    }>>(
      `SELECT id, "sourceText", "targetText", "sourceLocale", "targetLocale" 
       FROM "TranslationMemoryEntry" 
       WHERE "sourceEmbedding" IS NOT NULL 
       ORDER BY RANDOM() 
       LIMIT 5`
    );

    if (sampleEntries.length === 0) {
      console.log('⚠️  No entries with embeddings found.\n');
      return;
    }

    console.log(`   Found ${sampleEntries.length} sample entries\n`);

    // Test each sample
    for (let i = 0; i < sampleEntries.length; i++) {
      const sample = sampleEntries[i];
      console.log(`\n${'='.repeat(80)}`);
      console.log(`Test ${i + 1}/${sampleEntries.length}`);
      console.log(`${'='.repeat(80)}`);
      console.log(`\n📝 Source Text (${sample.sourceLocale}):`);
      console.log(`   "${sample.sourceText.substring(0, 100)}${sample.sourceText.length > 100 ? '...' : ''}"`);
      console.log(`\n🎯 Target Text (${sample.targetLocale}):`);
      console.log(`   "${sample.targetText.substring(0, 100)}${sample.targetText.length > 100 ? '...' : ''}"`);

      // Test 1: Vector search only
      console.log(`\n🔵 Vector Search Results:`);
      try {
        const queryEmbedding = await generateEmbedding(sample.sourceText, true);
        const vectorResults = await searchByVector(queryEmbedding, {
          sourceLocale: sample.sourceLocale,
          targetLocale: sample.targetLocale,
          limit: 5,
          minSimilarity: 0.7, // 70% similarity
        });

        if (vectorResults.length > 0) {
          console.log(`   Found ${vectorResults.length} matches:`);
          vectorResults.forEach((result, idx) => {
            const similarity = Math.round(result.similarity * 100);
            const isExact = result.id === sample.id;
            const matchType = isExact ? '✅ EXACT MATCH' : '   Similar';
            console.log(`   ${idx + 1}. ${matchType} (${similarity}% similarity)`);
            console.log(`      Source: "${result.sourceText.substring(0, 80)}${result.sourceText.length > 80 ? '...' : ''}"`);
            console.log(`      Target: "${result.targetText.substring(0, 80)}${result.targetText.length > 80 ? '...' : ''}"`);
          });
        } else {
          console.log('   No matches found (similarity threshold: 70%)');
        }
      } catch (error: any) {
        console.log(`   ❌ Error: ${error.message}`);
      }

      // Test 2: Hybrid search (vector + fuzzy)
      console.log(`\n🟢 Hybrid Search Results (Vector + Fuzzy):`);
      try {
        const hybridResults = await searchTranslationMemory({
          sourceText: sample.sourceText,
          sourceLocale: sample.sourceLocale,
          targetLocale: sample.targetLocale,
          limit: 5,
          minScore: 70,
        });

        if (hybridResults.length > 0) {
          console.log(`   Found ${hybridResults.length} matches:`);
          hybridResults.forEach((result, idx) => {
            const isExact = result.id === sample.id;
            const matchType = isExact ? '✅ EXACT MATCH' : '   Match';
            const source = result.scope === 'project' ? 'project' : 'global';
            console.log(`   ${idx + 1}. ${matchType} (${result.fuzzyScore}% score, ${source})`);
            console.log(`      Source: "${result.sourceText.substring(0, 80)}${result.sourceText.length > 80 ? '...' : ''}"`);
            console.log(`      Target: "${result.targetText.substring(0, 80)}${result.targetText.length > 80 ? '...' : ''}"`);
          });

          // Check if exact match was found
          const foundExact = hybridResults.some(r => r.id === sample.id);
          if (foundExact) {
            const rank = hybridResults.findIndex(r => r.id === sample.id) + 1;
            console.log(`\n   ✅ Exact match found at rank #${rank}`);
          } else {
            console.log(`\n   ⚠️  Exact match not in top ${hybridResults.length} results`);
          }
        } else {
          console.log('   No matches found');
        }
      } catch (error: any) {
        console.log(`   ❌ Error: ${error.message}`);
      }

      // Test 3: Semantic similarity (different wording, same meaning)
      console.log(`\n🟡 Semantic Similarity Test:`);
      try {
        // Create a semantically similar but textually different query
        const similarQuery = sample.sourceText.length > 50 
          ? sample.sourceText.substring(0, 30) + '...' + sample.sourceText.substring(sample.sourceText.length - 20)
          : sample.sourceText;

        const semanticResults = await searchTranslationMemory({
          sourceText: similarQuery,
          sourceLocale: sample.sourceLocale,
          targetLocale: sample.targetLocale,
          limit: 3,
          minScore: 60,
        });

        if (semanticResults.length > 0) {
          console.log(`   Query: "${similarQuery.substring(0, 80)}..."`);
          console.log(`   Found ${semanticResults.length} matches:`);
          semanticResults.forEach((result, idx) => {
            const isExact = result.id === sample.id;
            const matchType = isExact ? '✅ SEMANTIC MATCH' : '   Similar';
            console.log(`   ${idx + 1}. ${matchType} (${result.fuzzyScore}% score)`);
            console.log(`      Source: "${result.sourceText.substring(0, 60)}..."`);
          });
        } else {
          console.log('   No semantic matches found');
        }
      } catch (error: any) {
        console.log(`   ❌ Error: ${error.message}`);
      }

      // Small delay between tests
      await new Promise(resolve => setTimeout(resolve, 500));
    }

    // Performance test
    console.log(`\n${'='.repeat(80)}`);
    console.log('Performance Test');
    console.log(`${'='.repeat(80)}`);
    
    const testQuery = sampleEntries[0].sourceText;
    console.log(`\n📊 Testing search performance with query:`);
    console.log(`   "${testQuery.substring(0, 80)}..."`);

    // Time vector search
    const vectorStart = Date.now();
    try {
      const queryEmbedding = await generateEmbedding(testQuery, true);
      const vectorResults = await searchByVector(queryEmbedding, {
        sourceLocale: sampleEntries[0].sourceLocale,
        targetLocale: sampleEntries[0].targetLocale,
        limit: 10,
        minSimilarity: 0.7,
      });
      const vectorTime = Date.now() - vectorStart;
      console.log(`\n   Vector Search: ${vectorTime}ms (found ${vectorResults.length} results)`);
    } catch (error: any) {
      console.log(`\n   Vector Search: Failed - ${error.message}`);
    }

    // Time hybrid search
    const hybridStart = Date.now();
    try {
      const hybridResults = await searchTranslationMemory({
        sourceText: testQuery,
        sourceLocale: sampleEntries[0].sourceLocale,
        targetLocale: sampleEntries[0].targetLocale,
        limit: 10,
        minScore: 70,
      });
      const hybridTime = Date.now() - hybridStart;
      console.log(`   Hybrid Search: ${hybridTime}ms (found ${hybridResults.length} results)`);
    } catch (error: any) {
      console.log(`   Hybrid Search: Failed - ${error.message}`);
    }

    console.log(`\n${'='.repeat(80)}`);
    console.log('✅ Vector Search Test Complete!');
    console.log(`${'='.repeat(80)}\n`);

  } catch (error: any) {
    console.error('\n❌ Test failed:', error.message);
    throw error;
  } finally {
    await prisma.$disconnect();
  }
}

testVectorSearch().catch((e) => {
  console.error('Fatal error:', e);
  process.exit(1);
});



