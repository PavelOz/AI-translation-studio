/**
 * Find a document by name (e.g. "Приложение 3") and set its profile to KEGOC if missing.
 * Prints documentId and how to regenerate DNA (API or UI).
 *
 * Usage from backend:
 *   npx ts-node scripts/regenerate-dna-by-name.ts "Приложение 3"
 */
import { prisma } from '../src/db/prisma';

const DOCUMENT_NAME = process.argv[2] ?? 'Приложение 3';

async function main() {
  let doc = await prisma.document.findFirst({
    where: { name: { contains: DOCUMENT_NAME, mode: 'insensitive' } },
    select: { id: true, name: true, profileId: true, profile: { select: { id: true, name: true } } },
  });
  if (!doc) {
    doc = await prisma.document.findFirst({
      where: { name: { contains: 'Приложение', mode: 'insensitive' } },
      select: { id: true, name: true, profileId: true, profile: { select: { id: true, name: true } } },
    });
  }
  if (!doc) {
    console.error(`Document not found: "${DOCUMENT_NAME}"`);
    const list = await prisma.document.findMany({ take: 20, select: { name: true } });
    console.log('Sample document names:', list.map((d) => d.name));
    process.exit(1);
  }

  if (!doc.profileId) {
    const kegoc = await prisma.profile.findFirst({
      where: { name: { equals: 'KEGOC', mode: 'insensitive' } },
      select: { id: true },
    });
    if (kegoc) {
      await prisma.document.update({
        where: { id: doc.id },
        data: { profileId: kegoc.id },
      });
      console.log(`Set document profile to KEGOC (${kegoc.id})`);
    } else {
      console.warn('KEGOC profile not found; DNA will be generated without profile.');
    }
  } else {
    console.log('Document already has profile:', doc.profile?.name ?? doc.profileId);
  }

  console.log(`Document: ${doc.name} (id: ${doc.id})`);
  console.log('\nTo regenerate DNA:');
  console.log('  • In the UI: open this document, go to Analysis/DNA and click "Regenerate".');
  console.log(`  • Or API (with auth): POST /api/documents/${doc.id}/dna/regenerate`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
