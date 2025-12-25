import { prisma } from '../src/db/prisma';

const documentId = 'f67ff8e7-6c0a-40a8-80bb-6abca5141562';

async function checkDocument() {
  try {
    // Check if document exists
    const document = await prisma.document.findUnique({
      where: { id: documentId },
      include: {
        project: {
          select: { id: true, name: true }
        }
      }
    });

    if (document) {
      console.log('✅ Document found:');
      console.log(JSON.stringify(document, null, 2));
    } else {
      console.log('❌ Document not found');
      
      // Check if there are any related records
      const analysis = await prisma.documentAnalysis.findUnique({
        where: { documentId }
      });
      
      const segments = await prisma.segment.findMany({
        where: { documentId },
        take: 1
      });
      
      const glossaryEntries = await prisma.documentGlossaryEntry.findMany({
        where: { documentId },
        take: 1
      });
      
      console.log('\nRelated records:');
      console.log(`- Analysis: ${analysis ? 'Found' : 'Not found'}`);
      console.log(`- Segments: ${segments.length > 0 ? `Found ${segments.length} (showing first)` : 'Not found'}`);
      console.log(`- Glossary entries: ${glossaryEntries.length > 0 ? `Found ${glossaryEntries.length} (showing first)` : 'Not found'}`);
      
      if (analysis) {
        console.log('\n⚠️  Analysis record exists but document is missing - possible cascade delete issue');
      }
    }
  } catch (error) {
    console.error('Error:', error);
  } finally {
    await prisma.$disconnect();
  }
}

checkDocument();

