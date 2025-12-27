import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function findBlockingConstraints() {
  try {
    // Get a specific project ID that's failing
    const projects = await prisma.project.findMany({ take: 1 });
    if (projects.length === 0) {
      console.log('No projects found');
      return;
    }
    
    const projectId = projects[0].id;
    console.log(`Checking project: ${projectId}`);

    // Check all tables that might have foreign keys
    const allFKs = await prisma.$queryRawUnsafe(`
      SELECT 
        tc.table_name, 
        tc.constraint_name,
        kcu.column_name,
        ccu.table_name as references_table,
        ccu.column_name as references_column,
        rc.delete_rule,
        CASE 
          WHEN rc.delete_rule = 'CASCADE' THEN '✅ CASCADE'
          WHEN rc.delete_rule = 'RESTRICT' THEN '❌ RESTRICT'
          WHEN rc.delete_rule = 'NO ACTION' THEN '❌ NO ACTION'
          ELSE '⚠️ ' || rc.delete_rule
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
        AND (ccu.table_name = 'Project' OR ccu.table_name = 'Document')
      ORDER BY ccu.table_name, tc.table_name;
    `);

    console.log('\nAll Foreign Key Constraints (Project and Document):');
    console.log(JSON.stringify(allFKs, null, 2));

    // Check for any tables with projectId that don't have foreign keys
    const tablesWithProjectId = await prisma.$queryRawUnsafe(`
      SELECT 
        table_name,
        column_name,
        data_type
      FROM information_schema.columns
      WHERE column_name IN ('projectId', 'project_id')
        AND table_schema = 'public'
      ORDER BY table_name;
    `);

    console.log('\nAll tables with projectId column:');
    console.log(JSON.stringify(tablesWithProjectId, null, 2));

    // Try to find what's blocking by checking what records exist for this project
    console.log('\nChecking what data exists for this project:');
    
    const documentCount = await prisma.document.count({ where: { projectId } });
    console.log(`Documents: ${documentCount}`);
    
    const segmentCount = await prisma.segment.count({ 
      where: { document: { projectId } } 
    });
    console.log(`Segments: ${segmentCount}`);
    
    const aiRequestCount = await prisma.aIRequest.count({
      where: { document: { projectId } }
    });
    console.log(`AIRequests: ${aiRequestCount}`);

  } catch (error: any) {
    console.error('Error:', error.message);
    console.error(error.stack);
  } finally {
    await prisma.$disconnect();
  }
}

findBlockingConstraints();




