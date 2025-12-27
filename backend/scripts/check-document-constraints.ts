import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function checkDocumentConstraints() {
  try {
    // Check all foreign key constraints on Document
    const result = await prisma.$queryRawUnsafe(`
      SELECT 
        tc.table_name, 
        tc.constraint_name,
        kcu.column_name,
        ccu.table_name as references_table,
        rc.delete_rule,
        CASE 
          WHEN rc.delete_rule = 'CASCADE' THEN '✅ CASCADE'
          ELSE '❌ ' || rc.delete_rule
        END as status
      FROM information_schema.table_constraints AS tc 
      JOIN information_schema.key_column_usage AS kcu
        ON tc.constraint_name = kcu.constraint_name
        AND tc.table_schema = kcu.table_schema
      JOIN information_schema.constraint_column_usage AS ccu
        ON ccu.constraint_name = tc.constraint_name
        AND ccu.table_schema = tc.table_schema
      LEFT JOIN information_schema.referential_constraints AS rc
        ON tc.constraint_name = rc.constraint_name
      WHERE tc.constraint_type = 'FOREIGN KEY' 
        AND ccu.table_name = 'Document'
      ORDER BY tc.table_name;
    `);

    console.log('Foreign Key Constraints on Document:');
    console.log(JSON.stringify(result, null, 2));

    // Check if DocumentAnalysis exists and what constraints it has
    const documentAnalysisCheck = await prisma.$queryRawUnsafe(`
      SELECT 
        table_name,
        column_name,
        data_type
      FROM information_schema.columns
      WHERE table_name = 'DocumentAnalysis'
        AND table_schema = 'public'
      ORDER BY ordinal_position;
    `);

    console.log('\nDocumentAnalysis table structure:');
    console.log(JSON.stringify(documentAnalysisCheck, null, 2));

    // Check DocumentAnalysis foreign keys
    const documentAnalysisFKs = await prisma.$queryRawUnsafe(`
      SELECT 
        tc.table_name, 
        tc.constraint_name,
        kcu.column_name,
        ccu.table_name as references_table,
        rc.delete_rule
      FROM information_schema.table_constraints AS tc 
      JOIN information_schema.key_column_usage AS kcu
        ON tc.constraint_name = kcu.constraint_name
        AND tc.table_schema = kcu.table_schema
      JOIN information_schema.constraint_column_usage AS ccu
        ON ccu.constraint_name = tc.constraint_name
        AND ccu.table_schema = tc.table_schema
      LEFT JOIN information_schema.referential_constraints AS rc
        ON tc.constraint_name = rc.constraint_name
      WHERE tc.constraint_type = 'FOREIGN KEY' 
        AND tc.table_name = 'DocumentAnalysis'
      ORDER BY tc.table_name;
    `);

    console.log('\nDocumentAnalysis Foreign Keys:');
    console.log(JSON.stringify(documentAnalysisFKs, null, 2));
  } catch (error: any) {
    console.error('Error:', error.message);
  } finally {
    await prisma.$disconnect();
  }
}

checkDocumentConstraints();




