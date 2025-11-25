/**
 * Debug script to find why vector search returns 0 results
 */

import { PrismaClient } from '@prisma/client';
import { generateEmbedding } from '../src/services/embedding.service';
import { searchByVector } from '../src/services/vector-search.service';
import { logger } from '../src/utils/logger';

const prisma = new PrismaClient();

async function debugVectorSearch() {
  console.log('\n🔍 Debugging Vector Search Issue...\n');

  try {
    // 1. Check what locales exist in the database
    console.log('1. Checking locales in database...');
    const locales = await prisma.$queryRawUnsafe<Array<{
      sourceLocale: string;
      targetLocale: string;
      count: bigint;
      withEmbedding: bigint;
    }>>(
      `SELECT 
        "sourceLocale", 
        "targetLocale", 
        COUNT(*)::bigint as count,
        COUNT(CASE WHEN "sourceEmbedding" IS NOT NULL THEN 1 END)::bigint as "withEmbedding"
       FROM "TranslationMemoryEntry"
       GROUP BY "sourceLocale", "targetLocale"
       ORDER BY count DESC
       LIMIT 10`
    );

    console.log('   Locales with entries:');
    locales.forEach((l, i) => {
      console.log(`   ${i + 1}. ${l.sourceLocale} -> ${l.targetLocale}: ${Number(l.count).toLocaleString()} entries (${Number(l.withEmbedding).toLocaleString()} with embeddings)`);
    });

    // 2. Check project-specific vs global entries
    console.log('\n2. Checking project-specific vs global entries...');
    const projectStats = await prisma.$queryRawUnsafe<Array<{
      projectId: string | null;
      count: bigint;
      withEmbedding: bigint;
    }>>(
      `SELECT 
        "projectId",
        COUNT(*)::bigint as count,
        COUNT(CASE WHEN "sourceEmbedding" IS NOT NULL THEN 1 END)::bigint as "withEmbedding"
       FROM "TranslationMemoryEntry"
       GROUP BY "projectId"
       ORDER BY count DESC
       LIMIT 5`
    );

    console.log('   Project distribution:');
    projectStats.forEach((p, i) => {
      console.log(`   ${i + 1}. ProjectId: ${p.projectId || 'NULL (global)'}: ${Number(p.count).toLocaleString()} entries (${Number(p.withEmbedding).toLocaleString()} with embeddings)`);
    });

    // 3. Test vector search with exact locale from database
    if (locales.length > 0) {
      const testLocale = locales[0];
      console.log(`\n3. Testing vector search with locale: ${testLocale.sourceLocale} -> ${testLocale.targetLocale}`);
      
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
           AND "sourceLocale" = $1
           AND "targetLocale" = $2
         LIMIT 1`,
        testLocale.sourceLocale,
        testLocale.targetLocale
      );

      if (sampleEntry.length > 0) {
        const entry = sampleEntry[0];
        console.log(`   Sample entry: "${entry.sourceText.substring(0, 60)}..."`);
        console.log(`   Locales: ${entry.sourceLocale} -> ${entry.targetLocale}`);
        console.log(`   ProjectId: ${entry.projectId || 'NULL'}`);

        // Test search with exact locale
        const queryEmbedding = await generateEmbedding(entry.sourceText, true);
        
        console.log('\n   Testing with exact locale (no projectId filter):');
        const results1 = await searchByVector(queryEmbedding, {
          sourceLocale: entry.sourceLocale,
          targetLocale: entry.targetLocale,
          limit: 5,
          minSimilarity: 0.5,
        });
        console.log(`   ✅ Found ${results1.length} matches`);

        // Test search with simplified locale
        console.log('\n   Testing with simplified locale "ru" -> "en" (no projectId filter):');
        const results2 = await searchByVector(queryEmbedding, {
          sourceLocale: 'ru',
          targetLocale: 'en',
          limit: 5,
          minSimilarity: 0.5,
        });
        console.log(`   ✅ Found ${results2.length} matches`);

        // Test search with projectId filter
        if (entry.projectId) {
          console.log(`\n   Testing with projectId filter: ${entry.projectId}`);
          const results3 = await searchByVector(queryEmbedding, {
            projectId: entry.projectId,
            sourceLocale: entry.sourceLocale,
            targetLocale: entry.targetLocale,
            limit: 5,
            minSimilarity: 0.5,
          });
          console.log(`   ✅ Found ${results3.length} matches`);
        }

        // Test search without locale filter
        console.log('\n   Testing WITHOUT locale filter:');
        const results4 = await searchByVector(queryEmbedding, {
          limit: 5,
          minSimilarity: 0.5,
        });
        console.log(`   ✅ Found ${results4.length} matches`);
      }
    }

    // 4. Test with the actual search parameters from logs
    console.log('\n4. Testing with actual search parameters from logs...');
    console.log('   Parameters: projectId=c25864c7-49cb-4554-afa6-fc40fce9ef93, sourceLocale=ru, targetLocale=en');
    
    // Get a sample entry matching these criteria
    const testEntry = await prisma.$queryRawUnsafe<Array<{
      id: string;
      sourceText: string;
      sourceLocale: string;
      targetLocale: string;
      projectId: string | null;
    }>>(
      `SELECT id, "sourceText", "sourceLocale", "targetLocale", "projectId"
       FROM "TranslationMemoryEntry"
       WHERE "sourceEmbedding" IS NOT NULL
         AND ("projectId" = $1::uuid OR "projectId" IS NULL)
         AND (LOWER("sourceLocale"::text) LIKE LOWER($2::text || '%') OR "sourceLocale" = $2)
         AND (LOWER("targetLocale"::text) LIKE LOWER($3::text || '%') OR "targetLocale" = $3)
       LIMIT 1`,
      'c25864c7-49cb-4554-afa6-fc40fce9ef93',
      'ru',
      'en'
    );

    if (testEntry.length > 0) {
      const entry = testEntry[0];
      console.log(`   Found test entry: "${entry.sourceText.substring(0, 60)}..."`);
      console.log(`   Actual locales: ${entry.sourceLocale} -> ${entry.targetLocale}`);
      
      const queryEmbedding = await generateEmbedding(entry.sourceText, true);
      
      // Test with the exact parameters from the logs
      const results = await searchByVector(queryEmbedding, {
        projectId: 'c25864c7-49cb-4554-afa6-fc40fce9ef93',
        sourceLocale: 'ru',
        targetLocale: 'en',
        limit: 20,
        minSimilarity: 0.5,
      });
      console.log(`   ✅ Found ${results.length} matches with these parameters`);
      
      if (results.length === 0) {
        console.log('\n   ⚠️  ISSUE FOUND: No matches with these parameters!');
        console.log('   This suggests locale matching is too strict.');
      }
    } else {
      console.log('   ⚠️  No entries found matching the search criteria');
    }

    console.log('\n✅ Debug complete!\n');

  } catch (error: any) {
    console.error('\n❌ Error:', error.message);
    console.error('Stack:', error.stack?.substring(0, 300));
  } finally {
    await prisma.$disconnect();
  }
}

debugVectorSearch().catch(console.error);



