/**
 * Debug script to test vector search and see what's happening
 */

import { PrismaClient } from '@prisma/client';
import { generateEmbedding } from '../src/services/embedding.service';
import { searchByVector } from '../src/services/vector-search.service';
import { logger } from '../src/utils/logger';

const prisma = new PrismaClient();

async function testVectorSearch() {
  console.log('\n🔍 Testing Vector Search Debug...\n');

  try {
    // 1. Check if we have entries with embeddings
    console.log('1. Checking entries with embeddings...');
    const entriesWithEmbeddings = await prisma.$queryRawUnsafe<Array<{ count: bigint }>>(
      `SELECT COUNT(*)::bigint as count FROM "TranslationMemoryEntry" WHERE "sourceEmbedding" IS NOT NULL`
    );
    const count = Number(entriesWithEmbeddings[0].count);
    console.log(`   ✅ Found ${count.toLocaleString()} entries with embeddings\n`);

    if (count === 0) {
      console.log('❌ No entries have embeddings! Vector search cannot work.\n');
      console.log('💡 Run: npx ts-node scripts/generate-all-embeddings.ts\n');
      return;
    }

    // 2. Get a sample entry to test with
    console.log('2. Getting sample entries...');
    const sampleEntries = await prisma.$queryRawUnsafe<Array<{
      id: string;
      sourceText: string;
      targetText: string;
      sourceLocale: string;
      targetLocale: string;
      projectId: string | null;
    }>>(
      `SELECT id, "sourceText", "targetText", "sourceLocale", "targetLocale", "projectId" 
       FROM "TranslationMemoryEntry" 
       WHERE "sourceEmbedding" IS NOT NULL 
       LIMIT 5`
    );
    console.log(`   ✅ Found ${sampleEntries.length} sample entries\n`);

    if (sampleEntries.length === 0) {
      console.log('❌ No sample entries found!\n');
      return;
    }

    // 3. Test generating an embedding
    console.log('3. Testing embedding generation...');
    const testText = sampleEntries[0].sourceText;
    console.log(`   Test text: "${testText.substring(0, 100)}${testText.length > 100 ? '...' : ''}"`);
    
    try {
      const queryEmbedding = await generateEmbedding(testText, true);
      console.log(`   ✅ Generated embedding: ${queryEmbedding.length} dimensions\n`);
    } catch (error: any) {
      console.log(`   ❌ Failed to generate embedding: ${error.message}\n`);
      return;
    }

    // 4. Test vector search with different thresholds
    console.log('4. Testing vector search...');
    const queryEmbedding = await generateEmbedding(testText, true);
    
    for (const threshold of [0.5, 0.6, 0.7, 0.8]) {
      console.log(`\n   Testing with similarity threshold: ${threshold} (${threshold * 100}%)`);
      
      try {
        const results = await searchByVector(queryEmbedding, {
          sourceLocale: sampleEntries[0].sourceLocale,
          targetLocale: sampleEntries[0].targetLocale,
          projectId: sampleEntries[0].projectId || undefined,
          limit: 10,
          minSimilarity: threshold,
        });

        console.log(`   ✅ Found ${results.length} matches`);
        if (results.length > 0) {
          console.log(`   Top match: "${results[0].sourceText.substring(0, 60)}..." (similarity: ${(results[0].similarity * 100).toFixed(1)}%)`);
        }
      } catch (error: any) {
        console.log(`   ❌ Error: ${error.message}`);
        console.log(`   Stack: ${error.stack?.substring(0, 200)}`);
      }
    }

    // 5. Test with a different text (semantic similarity)
    console.log('\n5. Testing semantic similarity...');
    if (sampleEntries.length > 1) {
      const differentText = sampleEntries[1].sourceText;
      console.log(`   Searching for: "${differentText.substring(0, 100)}${differentText.length > 100 ? '...' : ''}"`);
      console.log(`   Against: "${testText.substring(0, 100)}${testText.length > 100 ? '...' : ''}"`);
      
      const differentEmbedding = await generateEmbedding(differentText, true);
      const results = await searchByVector(differentEmbedding, {
        sourceLocale: sampleEntries[0].sourceLocale,
        targetLocale: sampleEntries[0].targetLocale,
        projectId: sampleEntries[0].projectId || undefined,
        limit: 5,
        minSimilarity: 0.5,
      });

      console.log(`   ✅ Found ${results.length} matches`);
      results.forEach((r, i) => {
        console.log(`   ${i + 1}. "${r.sourceText.substring(0, 60)}..." (similarity: ${(r.similarity * 100).toFixed(1)}%)`);
      });
    }

    console.log('\n✅ Vector search test complete!\n');

  } catch (error: any) {
    console.error('\n❌ Test failed:', error.message);
    console.error('Stack:', error.stack);
  } finally {
    await prisma.$disconnect();
  }
}

testVectorSearch().catch(console.error);



