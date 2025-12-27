/**
 * Script to check if execution logs are being saved
 * Run with: npx ts-node scripts/check-execution-logs.ts <documentId>
 */

import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function checkExecutionLogs(documentId?: string) {
  console.log('🔍 Checking execution logs in database...\n');

  try {
    if (documentId) {
      // Check specific document
      const analysis = await prisma.documentAnalysis.findUnique({
        where: { documentId },
        select: {
          documentId: true,
          status: true,
          executionLogs: true,
        },
      });

      if (!analysis) {
        console.log(`❌ No analysis found for documentId: ${documentId}\n`);
        return;
      }

      console.log(`📄 Document: ${documentId}`);
      console.log(`📊 Status: ${analysis.status}`);
      
      const logs = (analysis.executionLogs as any) || [];
      console.log(`📝 Logs count: ${Array.isArray(logs) ? logs.length : 'NOT AN ARRAY'}`);
      
      if (Array.isArray(logs) && logs.length > 0) {
        console.log('\n📋 Log stages:');
        const stages = new Set(logs.map((log: any) => log.stage));
        stages.forEach(stage => {
          const count = logs.filter((log: any) => log.stage === stage).length;
          console.log(`  - ${stage}: ${count} logs`);
        });
        
        console.log('\n📋 Sample logs (first 3):');
        logs.slice(0, 3).forEach((log: any, i: number) => {
          console.log(`  ${i + 1}. [${log.level}] ${log.stage}: ${log.message.substring(0, 60)}...`);
        });
      } else {
        console.log('\n⚠️  No logs found in executionLogs field');
        console.log('   This could mean:');
        console.log('   1. Logs were not saved during extraction');
        console.log('   2. The column exists but is empty');
        console.log('   3. Check backend logs for warnings about executionLogs');
      }
    } else {
      // Check all analyses
      const analyses = await prisma.documentAnalysis.findMany({
        select: {
          documentId: true,
          status: true,
          executionLogs: true,
        },
        orderBy: { updatedAt: 'desc' },
        take: 10,
      });

      console.log(`📊 Found ${analyses.length} recent analyses\n`);

      analyses.forEach((analysis, i) => {
        const logs = (analysis.executionLogs as any) || [];
        const logCount = Array.isArray(logs) ? logs.length : 0;
        console.log(`${i + 1}. Document: ${analysis.documentId}`);
        console.log(`   Status: ${analysis.status}, Logs: ${logCount}`);
        if (logCount > 0) {
          const stages = new Set(logs.map((log: any) => log.stage));
          console.log(`   Stages: ${Array.from(stages).join(', ')}`);
        }
        console.log('');
      });
    }

    // Check if column exists
    console.log('🔍 Checking if executionLogs column exists...');
    const columnCheck = await prisma.$queryRaw<Array<{ column_name: string }>>`
      SELECT column_name 
      FROM information_schema.columns 
      WHERE table_name = 'DocumentAnalysis' 
        AND column_name = 'executionLogs'
    `;
    
    if (columnCheck && columnCheck.length > 0) {
      console.log('✅ executionLogs column exists\n');
    } else {
      console.log('❌ executionLogs column does NOT exist!\n');
      console.log('   Run: ALTER TABLE "DocumentAnalysis" ADD COLUMN IF NOT EXISTS "executionLogs" JSONB;\n');
    }
  } catch (error: any) {
    console.error('❌ Error:', error.message);
    console.error('\nFull error:', error);
  } finally {
    await prisma.$disconnect();
  }
}

const documentId = process.argv[2];
checkExecutionLogs(documentId);




