import { prisma } from '../src/db/prisma';

async function checkTmData() {
  try {
    console.log('Checking Translation Memory data...\n');

    // Count total entries
    const totalCount = await prisma.translationMemoryEntry.count();
    console.log(`Total TM entries: ${totalCount}`);

    if (totalCount === 0) {
      console.log('\n⚠️  No TM entries found in database!');
      console.log('You need to:');
      console.log('  1. Import a TMX file, or');
      console.log('  2. Add entries manually, or');
      console.log('  3. Confirm some segments to auto-add them to TM');
      return;
    }

    // Count by project
    const projectCount = await prisma.translationMemoryEntry.count({
      where: { projectId: { not: null } },
    });
    const globalCount = await prisma.translationMemoryEntry.count({
      where: { projectId: null },
    });
    console.log(`  - Project-specific: ${projectCount}`);
    console.log(`  - Global: ${globalCount}`);

    // Count by locale pairs
    const localePairs = await prisma.translationMemoryEntry.groupBy({
      by: ['sourceLocale', 'targetLocale'],
      _count: true,
    });

    console.log('\nLocale pairs:');
    localePairs.forEach((pair) => {
      console.log(`  ${pair.sourceLocale} → ${pair.targetLocale}: ${pair._count} entries`);
    });

    // Sample entries
    const samples = await prisma.translationMemoryEntry.findMany({
      take: 5,
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        sourceLocale: true,
        targetLocale: true,
        sourceText: true,
        targetText: true,
        projectId: true,
      },
    });

    console.log('\nSample entries (latest 5):');
    samples.forEach((entry, idx) => {
      console.log(`\n${idx + 1}. ${entry.sourceLocale} → ${entry.targetLocale}`);
      console.log(`   Source: ${entry.sourceText.substring(0, 60)}...`);
      console.log(`   Target: ${entry.targetText.substring(0, 60)}...`);
      console.log(`   Project: ${entry.projectId || 'Global'}`);
    });

    // Check embeddings (using raw query since Prisma might not expose vector type directly)
    try {
      const embeddingResult = await prisma.$queryRaw<Array<{ count: bigint }>>`
        SELECT COUNT(*) as count 
        FROM "TranslationMemoryEntry" 
        WHERE "sourceEmbedding" IS NOT NULL
      `;
      const withEmbeddings = Number(embeddingResult[0]?.count || 0);
      console.log(`\nEntries with embeddings: ${withEmbeddings} / ${totalCount}`);
    } catch (error: any) {
      console.log(`\nCould not check embeddings: ${error.message}`);
    }

  } catch (error) {
    console.error('Error checking TM data:', error);
  } finally {
    await prisma.$disconnect();
  }
}

checkTmData();

