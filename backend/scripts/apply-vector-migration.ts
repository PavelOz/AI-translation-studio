import { PrismaClient } from '@prisma/client';
import * as fs from 'fs';
import * as path from 'path';

const prisma = new PrismaClient();

async function applyMigration() {
  console.log('🔍 Checking vector migration status...\n');

  try {
    // Check if columns exist
    const columnCheck = await prisma.$queryRawUnsafe<Array<{ column_name: string }>>(`
      SELECT column_name 
      FROM information_schema.columns 
      WHERE table_name = 'TranslationMemoryEntry' 
        AND column_name IN ('sourceEmbedding', 'embeddingModel', 'embeddingVersion', 'embeddingUpdatedAt')
    `);

    console.log(`Found ${columnCheck.length} embedding columns in TranslationMemoryEntry`);

    if (columnCheck.length < 4) {
      console.log('\n📝 Applying migration SQL...\n');
      
      const migrationPath = path.join(__dirname, '../prisma/migrations/20251121154338_add_vector_embeddings/migration.sql');
      const migrationSQL = fs.readFileSync(migrationPath, 'utf-8');
      
      // Split by semicolons and execute each statement
      const statements = migrationSQL
        .split(';')
        .map(s => s.trim())
        .filter(s => s.length > 0 && !s.startsWith('--'));
      
      for (const statement of statements) {
        try {
          await prisma.$executeRawUnsafe(statement);
          console.log(`✅ Executed: ${statement.substring(0, 50)}...`);
        } catch (error: any) {
          // Ignore "already exists" errors
          if (error.message?.includes('already exists') || error.message?.includes('duplicate')) {
            console.log(`⚠️  Skipped (already exists): ${statement.substring(0, 50)}...`);
          } else {
            console.error(`❌ Error: ${error.message}`);
            throw error;
          }
        }
      }
      
      console.log('\n✅ Migration applied successfully!\n');
    } else {
      console.log('✅ Migration already applied!\n');
    }

    // Verify indexes
    const indexCheck = await prisma.$queryRawUnsafe<Array<{ indexname: string }>>(`
      SELECT indexname 
      FROM pg_indexes 
      WHERE tablename = 'TranslationMemoryEntry' 
        AND indexname LIKE '%embedding%'
    `);

    console.log(`Found ${indexCheck.length} vector indexes:`);
    indexCheck.forEach(idx => console.log(`  - ${idx.indexname}`));

    // Check pgvector extension
    const extensionCheck = await prisma.$queryRawUnsafe<Array<{ extname: string }>>(`
      SELECT extname 
      FROM pg_extension 
      WHERE extname = 'vector'
    `);

    if (extensionCheck.length > 0) {
      console.log('\n✅ pgvector extension is installed');
    } else {
      console.log('\n⚠️  pgvector extension not found - attempting to install...');
      await prisma.$executeRawUnsafe('CREATE EXTENSION IF NOT EXISTS vector;');
      console.log('✅ pgvector extension installed');
    }

  } catch (error: any) {
    console.error('\n❌ Migration failed:', error.message);
    throw error;
  } finally {
    await prisma.$disconnect();
  }
}

applyMigration().catch((e) => {
  console.error('Fatal error:', e);
  process.exit(1);
});



