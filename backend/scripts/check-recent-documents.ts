import { prisma } from '../src/db/prisma';

async function checkRecentDocuments() {
  try {
    // Get all documents
    const documents = await prisma.document.findMany({
      take: 10,
      orderBy: { createdAt: 'desc' },
      include: {
        project: {
          select: { id: true, name: true }
        },
        _count: {
          select: {
            segments: true,
            glossaryEntries: true
          }
        }
      }
    });

    console.log(`Found ${documents.length} recent documents:\n`);
    
    documents.forEach((doc, index) => {
      console.log(`${index + 1}. ${doc.name} (${doc.id})`);
      console.log(`   Project: ${doc.project?.name || 'No project'} (${doc.projectId})`);
      console.log(`   Segments: ${doc._count.segments}, Glossary entries: ${doc._count.glossaryEntries}`);
      console.log(`   Created: ${doc.createdAt}`);
      console.log('');
    });

    // Check for orphaned analysis records
    const allAnalyses = await prisma.documentAnalysis.findMany({
      include: {
        document: {
          select: { id: true, name: true }
        }
      }
    });

    const orphanedAnalyses = allAnalyses.filter(a => !a.document);
    if (orphanedAnalyses.length > 0) {
      console.log(`\n⚠️  Found ${orphanedAnalyses.length} orphaned analysis records (document deleted but analysis remains)`);
    } else {
      console.log('\n✅ No orphaned analysis records found');
    }

  } catch (error) {
    console.error('Error:', error);
  } finally {
    await prisma.$disconnect();
  }
}

checkRecentDocuments();



