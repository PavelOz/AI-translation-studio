/**
 * Script to check and add executionLogs column to DocumentAnalysis table
 * Uses raw SQL to bypass Prisma client issues
 * Run with: node -r ts-node/register scripts/fix-execution-logs.ts
 */

import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function fixExecutionLogs() {
  console.log('🔍 Checking executionLogs column status...\n');

  try {
    // Check if column exists using raw SQL
    const columnCheck = await prisma.$queryRawUnsafe<Array<{ column_name: string }>>(`
      SELECT column_name 
      FROM information_schema.columns 
      WHERE table_name = 'DocumentAnalysis' 
        AND column_name = 'executionLogs'
    `);

    if (columnCheck && columnCheck.length > 0) {
      console.log('✅ executionLogs column already exists in database!\n');
      
      // Check if there are any logs
      const result = await prisma.$queryRawUnsafe<Array<{ executionLogs: any; documentId: string; status: string }>>(`
        SELECT "documentId", "status", "executionLogs" 
        FROM "DocumentAnalysis" 
        ORDER BY "updatedAt" DESC 
        LIMIT 5
      `);
      
      console.log(`📊 Found ${result.length} recent analyses:\n`);
      result.forEach((row, i) => {
        const logs = row.executionLogs;
        const logCount = Array.isArray(logs) ? logs.length : 0;
        console.log(`  ${i + 1}. Document: ${row.documentId}`);
        console.log(`     Status: ${row.status}, Logs: ${logCount}`);
        if (logCount > 0) {
          const stages = new Set((logs as any[]).map((log: any) => log.stage));
          console.log(`     Stages: ${Array.from(stages).join(', ')}`);
        }
        console.log('');
      });
      
      console.log('💡 If logs are still showing as 0, you may need to:');
      console.log('   1. Run a new extraction (logs are only saved during extraction)');
      console.log('   2. Check backend logs for warnings about executionLogs');
      console.log('   3. Ensure the backend server has been restarted after adding the column\n');
      
      return;
    }

    console.log('❌ executionLogs column does NOT exist in database!\n');
    console.log('📝 Adding executionLogs column...\n');

    // Add the column
    await prisma.$executeRawUnsafe(`
      ALTER TABLE "DocumentAnalysis" 
      ADD COLUMN IF NOT EXISTS "executionLogs" JSONB;
    `);

    // Set default to empty array for existing rows
    await prisma.$executeRawUnsafe(`
      UPDATE "DocumentAnalysis" 
      SET "executionLogs" = '[]'::jsonb 
      WHERE "executionLogs" IS NULL;
    `);

    console.log('✅ Successfully added executionLogs column!\n');
    console.log('📊 The column is now ready to store execution logs.\n');
    console.log('⚠️  IMPORTANT: You need to:');
    console.log('   1. Regenerate Prisma client: npx prisma generate');
    console.log('   2. Restart your backend server');
    console.log('   3. Run a NEW extraction to see logs (previous extractions won\'t have logs)\n');
  } catch (error: any) {
    console.error('❌ Error:', error.message);
    console.error('\nFull error:', error);
    process.exit(1);
  } finally {
    await prisma.$disconnect();
  }
}

fixExecutionLogs();


