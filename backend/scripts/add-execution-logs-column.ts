/**
 * Script to add executionLogs column to DocumentAnalysis table
 * Run with: npx ts-node scripts/add-execution-logs-column.ts
 */

import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function addExecutionLogsColumn() {
  console.log('🔍 Checking if executionLogs column exists...\n');

  try {
    // Check if column exists
    const columnCheck = await prisma.$queryRaw<Array<{ column_name: string }>>`
      SELECT column_name 
      FROM information_schema.columns 
      WHERE table_name = 'DocumentAnalysis' 
        AND column_name = 'executionLogs'
    `;

    if (columnCheck && columnCheck.length > 0) {
      console.log('✅ executionLogs column already exists!\n');
      return;
    }

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
    console.log('💡 Restart your backend server and run a new analysis to see logs.\n');
  } catch (error: any) {
    console.error('❌ Error adding column:', error.message);
    console.error('\nFull error:', error);
    process.exit(1);
  } finally {
    await prisma.$disconnect();
  }
}

addExecutionLogsColumn();




