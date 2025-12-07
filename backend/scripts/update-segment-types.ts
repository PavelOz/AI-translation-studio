import { prisma } from '../src/db/prisma';

async function updateSegmentTypes() {
  console.log('Updating segment types for existing segments...');
  
  const result = await prisma.$executeRawUnsafe(
    `UPDATE "Segment" SET "segmentType" = 'paragraph' WHERE "segmentType" IS NULL`
  );
  
  console.log(`Updated ${result} segments with default type 'paragraph'`);
  
  const stats = await prisma.$queryRawUnsafe<Array<{ type: string; count: bigint }>>(
    `SELECT "segmentType" as type, COUNT(*) as count FROM "Segment" GROUP BY "segmentType"`
  );
  
  console.log('\nSegment type distribution:');
  stats.forEach((stat) => {
    console.log(`  ${stat.type || 'NULL'}: ${stat.count}`);
  });
  
  await prisma.$disconnect();
}

updateSegmentTypes().catch(console.error);






