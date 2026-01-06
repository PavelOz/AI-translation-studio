import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function checkAllConstraints() {
  try {
    // Check ALL foreign key constraints in the database
    const allConstraints = await prisma.$queryRawUnsafe(`
      SELECT 
        tc.table_name, 
        tc.constraint_name,
        kcu.column_name,
        ccu.table_name as references_table,
        rc.delete_rule,
        CASE 
          WHEN rc.delete_rule = 'CASCADE' THEN '✅'
          WHEN rc.delete_rule = 'RESTRICT' THEN '❌ RESTRICT'
          WHEN rc.delete_rule = 'NO ACTION' THEN '❌ NO ACTION'
          WHEN rc.delete_rule = 'SET NULL' THEN '⚠️ SET NULL'
          ELSE '❓ ' || COALESCE(rc.delete_rule, 'NULL')
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
        AND tc.table_schema = 'public'
      ORDER BY ccu.table_name, tc.table_name;
    `);

    console.log('ALL Foreign Key Constraints in Database:');
    console.log(JSON.stringify(allConstraints, null, 2));

    // Find any RESTRICT or NO ACTION constraints
    const problematicConstraints = (allConstraints as any[]).filter(
      (c: any) => c.delete_rule !== 'CASCADE' && c.delete_rule !== 'SET NULL'
    );

    if (problematicConstraints.length > 0) {
      console.log('\n⚠️ PROBLEMATIC CONSTRAINTS (Not CASCADE):');
      console.log(JSON.stringify(problematicConstraints, null, 2));
    } else {
      console.log('\n✅ All constraints are CASCADE or SET NULL');
    }

  } catch (error: any) {
    console.error('Error:', error.message);
    console.error(error.stack);
  } finally {
    await prisma.$disconnect();
  }
}

checkAllConstraints();





