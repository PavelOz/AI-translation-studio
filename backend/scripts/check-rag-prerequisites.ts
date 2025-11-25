import { PrismaClient } from '@prisma/client';
import { config } from 'dotenv';
import { existsSync } from 'fs';
import { join } from 'path';

config();

const prisma = new PrismaClient();

async function checkPrerequisites() {
  console.log('🔍 Checking RAG Implementation Prerequisites...\n');
  
  const checks = {
    database: false,
    postgresVersion: false,
    pgvectorExtension: false,
    openaiKey: false,
    openaiPackage: false,
    envFile: false,
  };

  const results: Array<{ name: string; status: '✅' | '❌' | '⚠️'; message: string }> = [];

  // 1. Check .env file exists
  console.log('1. Checking .env file...');
  const envPath = join(__dirname, '../.env');
  checks.envFile = existsSync(envPath);
  if (checks.envFile) {
    results.push({ name: '.env file', status: '✅', message: 'Found .env file' });
  } else {
    results.push({ name: '.env file', status: '❌', message: '.env file not found' });
  }

  // 2. Check OpenAI API Key
  console.log('2. Checking OpenAI API Key...');
  const openaiKey = process.env.OPENAI_API_KEY;
  checks.openaiKey = !!openaiKey && openaiKey.startsWith('sk-');
  if (checks.openaiKey && openaiKey) {
    results.push({ 
      name: 'OpenAI API Key', 
      status: '✅', 
      message: `Found API key (${openaiKey.substring(0, 7)}...)` 
    });
  } else {
    results.push({ 
      name: 'OpenAI API Key', 
      status: '❌', 
      message: 'OPENAI_API_KEY not found or invalid in .env' 
    });
  }

  // 3. Check OpenAI npm package
  console.log('3. Checking OpenAI npm package...');
  try {
    require.resolve('openai');
    checks.openaiPackage = true;
    results.push({ name: 'OpenAI npm package', status: '✅', message: 'openai package installed' });
  } catch (e) {
    checks.openaiPackage = false;
    results.push({ 
      name: 'OpenAI npm package', 
      status: '❌', 
      message: 'openai package not installed. Run: npm install openai' 
    });
  }

  // 4. Check database connection
  console.log('4. Checking database connection...');
  try {
    await prisma.$connect();
    checks.database = true;
    results.push({ name: 'Database connection', status: '✅', message: 'Successfully connected to database' });
  } catch (e: any) {
    checks.database = false;
    results.push({ 
      name: 'Database connection', 
      status: '❌', 
      message: `Failed to connect: ${e.message}` 
    });
    await prisma.$disconnect();
    printResults(results);
    return;
  }

  // 5. Check PostgreSQL version
  console.log('5. Checking PostgreSQL version...');
  try {
    const versionResult = await prisma.$queryRaw<Array<{ version: string }>>`
      SELECT version()
    `;
    const version = versionResult[0].version;
    const versionMatch = version.match(/PostgreSQL (\d+)/);
    if (versionMatch) {
      const majorVersion = parseInt(versionMatch[1]);
      checks.postgresVersion = majorVersion >= 11;
      if (checks.postgresVersion) {
        results.push({ 
          name: 'PostgreSQL version', 
          status: '✅', 
          message: `PostgreSQL ${majorVersion} (pgvector requires 11+)` 
        });
      } else {
        results.push({ 
          name: 'PostgreSQL version', 
          status: '❌', 
          message: `PostgreSQL ${majorVersion} (pgvector requires 11+)` 
        });
      }
    } else {
      results.push({ 
        name: 'PostgreSQL version', 
        status: '⚠️', 
        message: `Could not parse version: ${version}` 
      });
    }
  } catch (e: any) {
    results.push({ 
      name: 'PostgreSQL version', 
      status: '❌', 
      message: `Error checking version: ${e.message}` 
    });
  }

  // 6. Check pgvector extension
  console.log('6. Checking pgvector extension...');
  try {
    // Try to create extension (will fail if not available, but won't error if already exists)
    await prisma.$executeRaw`CREATE EXTENSION IF NOT EXISTS vector`;
    
    // Check if extension exists
    const extResult = await prisma.$queryRaw<Array<{ extname: string }>>`
      SELECT extname FROM pg_extension WHERE extname = 'vector'
    `;
    
    if (extResult.length > 0) {
      checks.pgvectorExtension = true;
      results.push({ name: 'pgvector extension', status: '✅', message: 'pgvector extension is installed' });
    } else {
      checks.pgvectorExtension = false;
      results.push({ 
        name: 'pgvector extension', 
        status: '❌', 
        message: 'pgvector extension not found. Install it first.' 
      });
    }
  } catch (e: any) {
    checks.pgvectorExtension = false;
    const errorMsg = e.message.toLowerCase();
    if (errorMsg.includes('extension') || errorMsg.includes('vector')) {
      results.push({ 
        name: 'pgvector extension', 
        status: '❌', 
        message: `pgvector not available: ${e.message}` 
      });
    } else {
      results.push({ 
        name: 'pgvector extension', 
        status: '⚠️', 
        message: `Could not check: ${e.message}` 
      });
    }
  }

  await prisma.$disconnect();
  
  // Print results
  printResults(results);
  
  // Summary
  console.log('\n' + '='.repeat(60));
  console.log('📊 SUMMARY');
  console.log('='.repeat(60));
  
  const allGood = Object.values(checks).every(v => v === true);
  const critical = checks.database && checks.openaiKey && checks.postgresVersion;
  
  if (allGood) {
    console.log('✅ All prerequisites met! Ready to implement RAG.');
  } else if (critical) {
    console.log('⚠️  Critical prerequisites met, but some optional items missing:');
    if (!checks.pgvectorExtension) {
      console.log('   - pgvector extension needs to be installed');
    }
    if (!checks.openaiPackage) {
      console.log('   - OpenAI npm package needs to be installed');
    }
  } else {
    console.log('❌ Some critical prerequisites are missing:');
    if (!checks.database) console.log('   - Database connection failed');
    if (!checks.openaiKey) console.log('   - OpenAI API key missing');
    if (!checks.postgresVersion) console.log('   - PostgreSQL version too old');
  }
  
  console.log('\n');
}

function printResults(results: Array<{ name: string; status: '✅' | '❌' | '⚠️'; message: string }>) {
  console.log('\n' + '='.repeat(60));
  console.log('📋 CHECK RESULTS');
  console.log('='.repeat(60));
  
  results.forEach(({ name, status, message }) => {
    console.log(`${status} ${name.padEnd(25)} ${message}`);
  });
}

checkPrerequisites().catch(console.error);

