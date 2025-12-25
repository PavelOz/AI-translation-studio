import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function checkConstraints() {
  try {
    // Query to check all foreign key constraints on Project
    const result = await prisma.$queryRawUnsafe(`
      SELECT 
        tc.table_name, 
        tc.constraint_name,
        kcu.column_name,
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
        AND ccu.table_name = 'Project'
      ORDER BY tc.table_name;
    `);

    console.log('Foreign Key Constraints on Project:');
    console.log(JSON.stringify(result, null, 2));

    // Also check for any tables that might have projectId but no foreign key constraint
    const tablesWithProjectId = await prisma.$queryRawUnsafe(`
      SELECT 
        table_name,
        column_name
      FROM information_schema.columns
      WHERE column_name = 'projectId'
        AND table_schema = 'public'
        AND table_name != 'Project'
      ORDER BY table_name;
    `);

    console.log('\nTables with projectId column:');
    console.log(JSON.stringify(tablesWithProjectId, null, 2));
  } catch (error: any) {
    console.error('Error:', error.message);
  } finally {
    await prisma.$disconnect();
  }
}

checkConstraints();

