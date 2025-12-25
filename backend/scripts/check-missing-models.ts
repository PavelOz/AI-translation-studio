import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function checkTables() {
  try {
    const result = await prisma.$queryRawUnsafe(`
      SELECT table_name 
      FROM information_schema.tables 
      WHERE table_schema = 'public' 
        AND table_name IN ('DocumentAnalysis', 'DocumentGlossaryEntry', 'DocumentStyleRule')
      ORDER BY table_name;
    `);

    console.log('Tables found in database:');
    console.log(JSON.stringify(result, null, 2));

    // Check columns for DocumentAnalysis if it exists
    const docAnalysisColumns = await prisma.$queryRawUnsafe(`
      SELECT column_name, data_type 
      FROM information_schema.columns 
      WHERE table_name = 'DocumentAnalysis' 
        AND table_schema = 'public'
      ORDER BY ordinal_position;
    `);

    if (Array.isArray(docAnalysisColumns) && docAnalysisColumns.length > 0) {
      console.log('\nDocumentAnalysis columns:');
      console.log(JSON.stringify(docAnalysisColumns, null, 2));
    }

    // Check DocumentGlossaryEntry columns
    const docGlossaryColumns = await prisma.$queryRawUnsafe(`
      SELECT column_name, data_type, is_nullable
      FROM information_schema.columns 
      WHERE table_name = 'DocumentGlossaryEntry' 
        AND table_schema = 'public'
      ORDER BY ordinal_position;
    `);

    if (Array.isArray(docGlossaryColumns) && docGlossaryColumns.length > 0) {
      console.log('\nDocumentGlossaryEntry columns:');
      console.log(JSON.stringify(docGlossaryColumns, null, 2));
    }

    // Check DocumentStyleRule columns
    const docStyleColumns = await prisma.$queryRawUnsafe(`
      SELECT column_name, data_type, is_nullable
      FROM information_schema.columns 
      WHERE table_name = 'DocumentStyleRule' 
        AND table_schema = 'public'
      ORDER BY ordinal_position;
    `);

    if (Array.isArray(docStyleColumns) && docStyleColumns.length > 0) {
      console.log('\nDocumentStyleRule columns:');
      console.log(JSON.stringify(docStyleColumns, null, 2));
    }
  } catch (error: any) {
    console.error('Error:', error.message);
  } finally {
    await prisma.$disconnect();
  }
}

checkTables();

