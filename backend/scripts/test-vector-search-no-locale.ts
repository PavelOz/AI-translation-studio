/**
 * Test vector search without locale filtering to see if that's the issue
 */

import { PrismaClient } from '@prisma/client';
import { generateEmbedding } from '../src/services/embedding.service';
import { logger } from '../src/utils/logger';

const prisma = new PrismaClient();

async function testWithoutLocaleFilter() {
  console.log('\n🔍 Testing Vector Search Without Locale Filter...\n');

  try {
    // Get a sample entry
    const sampleEntry = await prisma.$queryRawUnsafe<Array<{
      id: string;
      sourceText: string;
      sourceLocale: string;
      targetLocale: string;
      projectId: string | null;
    }>>(
      `SELECT id, "sourceText", "sourceLocale", "targetLocale", "projectId" 
       FROM "TranslationMemoryEntry" 
       WHERE "sourceEmbedding" IS NOT NULL 
       LIMIT 1`
    );

    if (sampleEntry.length === 0) {
      console.log('❌ No entries with embeddings found!\n');
      return;
    }

    const entry = sampleEntry[0];
    console.log(`Sample entry:`);
    console.log(`  Source: "${entry.sourceText.substring(0, 80)}..."`);
    console.log(`  Locales: ${entry.sourceLocale} -> ${entry.targetLocale}`);
    console.log(`  ProjectId: ${entry.projectId || 'null'}\n`);

    // Generate embedding
    const queryEmbedding = await generateEmbedding(entry.sourceText, true);
    const embeddingStr = `[${queryEmbedding.join(',')}]`;

    // Test 1: Search WITHOUT locale filtering
    console.log('1. Testing WITHOUT locale filter...');
    const queryNoLocale = `
      SELECT 
        id,
        "sourceText",
        "targetText",
        "sourceLocale",
        "targetLocale",
        "projectId",
        1 - ("sourceEmbedding" <=> $1::vector) as similarity
      FROM "TranslationMemoryEntry"
      WHERE "sourceEmbedding" IS NOT NULL
        AND (1 - ("sourceEmbedding" <=> $1::vector)) >= $2
      ORDER BY "sourceEmbedding" <=> $1::vector
      LIMIT $3
    `;

    const resultsNoLocale = await prisma.$queryRawUnsafe<Array<{
      id: string;
      sourceText: string;
      similarity: number;
      sourceLocale: string;
      targetLocale: string;
    }>>(
      queryNoLocale,
      embeddingStr,
      0.5, // 50% similarity
      10
    );

    console.log(`   ✅ Found ${resultsNoLocale.length} matches`);
    resultsNoLocale.slice(0, 5).forEach((r, i) => {
      console.log(`   ${i + 1}. "${r.sourceText.substring(0, 60)}..." (${(r.similarity * 100).toFixed(1)}%, ${r.sourceLocale}->${r.targetLocale})`);
    });

    // Test 2: Search WITH locale filtering (current implementation)
    console.log('\n2. Testing WITH locale filter (current implementation)...');
    const queryWithLocale = `
      SELECT 
        id,
        "sourceText",
        "targetText",
        "sourceLocale",
        "targetLocale",
        "projectId",
        1 - ("sourceEmbedding" <=> $1::vector) as similarity
      FROM "TranslationMemoryEntry"
      WHERE "sourceEmbedding" IS NOT NULL
        AND LOWER("sourceLocale"::text) = LOWER($4::text)
        AND LOWER("targetLocale"::text) = LOWER($5::text)
        AND (1 - ("sourceEmbedding" <=> $1::vector)) >= $2
      ORDER BY "sourceEmbedding" <=> $1::vector
      LIMIT $3
    `;

    const resultsWithLocale = await prisma.$queryRawUnsafe<Array<{
      id: string;
      sourceText: string;
      similarity: number;
    }>>(
      queryWithLocale,
      embeddingStr,
      0.5, // 50% similarity
      10,
      entry.sourceLocale,
      entry.targetLocale
    );

    console.log(`   ✅ Found ${resultsWithLocale.length} matches`);
    if (resultsWithLocale.length > 0) {
      resultsWithLocale.slice(0, 5).forEach((r, i) => {
        console.log(`   ${i + 1}. "${r.sourceText.substring(0, 60)}..." (${(r.similarity * 100).toFixed(1)}%)`);
      });
    } else {
      console.log(`   ⚠️  No matches with locale filter!`);
      console.log(`   This suggests locale filtering is too strict.\n`);
    }

    // Test 3: Check what locales exist
    console.log('3. Checking available locales...');
    const locales = await prisma.$queryRawUnsafe<Array<{
      sourceLocale: string;
      targetLocale: string;
      count: bigint;
    }>>(
      `SELECT "sourceLocale", "targetLocale", COUNT(*)::bigint as count
       FROM "TranslationMemoryEntry"
       WHERE "sourceEmbedding" IS NOT NULL
       GROUP BY "sourceLocale", "targetLocale"
       ORDER BY count DESC
       LIMIT 10`
    );

    console.log(`   Top locales with embeddings:`);
    locales.forEach((l, i) => {
      console.log(`   ${i + 1}. ${l.sourceLocale} -> ${l.targetLocale}: ${Number(l.count).toLocaleString()} entries`);
    });

    console.log('\n✅ Test complete!\n');

  } catch (error: any) {
    console.error('\n❌ Test failed:', error.message);
    console.error('Stack:', error.stack?.substring(0, 300));
  } finally {
    await prisma.$disconnect();
  }
}

testWithoutLocaleFilter().catch(console.error);



