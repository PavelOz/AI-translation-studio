/**
 * Spot-check translated segments for a document: remaining Cyrillic, "X – X" pattern.
 * Optional dev/QA tool. Usage: npx ts-node src/scripts/spot-check-translation.ts <documentId>
 *
 * Requires DATABASE_URL and documentId as first argument.
 */

import { prisma } from '../db/prisma';
import { getDocumentDna } from '../services/analysis.service';

const CYRILLIC_REGEX = /[\u0400-\u04FF]/;

/** Pattern: same phrase on both sides of dash (e.g. "National Dispatch Center – National Dispatch Center"). */
function findDuplicateDash(text: string): boolean {
  const dashRe = /\s+[–-]\s+/g;
  let m: RegExpExecArray | null;
  const parts: string[] = [];
  let lastEnd = 0;
  while ((m = dashRe.exec(text)) !== null) {
    const left = text.slice(lastEnd, m.index).trim();
    const rightStart = m.index + m[0].length;
    const nextDash = text.slice(rightStart).search(/\s+[–-]\s+/);
    const rightEnd = nextDash >= 0 ? rightStart + nextDash : text.length;
    const right = text.slice(rightStart, rightEnd).trim();
    const leftNorm = left.replace(/\s+/g, ' ').toLowerCase();
    const rightNorm = right.replace(/\s+/g, ' ').toLowerCase();
    if (leftNorm === rightNorm && leftNorm.length > 2) return true;
    lastEnd = rightEnd;
  }
  return false;
}

async function main() {
  const documentId = process.argv[2];
  if (!documentId) {
    console.error('Usage: npx ts-node src/scripts/spot-check-translation.ts <documentId>');
    process.exit(1);
  }

  const doc = await prisma.document.findUnique({
    where: { id: documentId },
    select: { id: true, name: true },
  });
  if (!doc) {
    console.error('Document not found:', documentId);
    process.exit(1);
  }

  const segments = await prisma.segment.findMany({
    where: { documentId },
    orderBy: { segmentIndex: 'asc' },
    select: { id: true, segmentIndex: true, targetFinal: true },
  });

  const report = {
    documentId,
    documentName: doc.name,
    totalSegments: segments.length,
    withCyrillic: [] as string[],
    withDuplicateDash: [] as string[],
  };

  for (const seg of segments) {
    const text = seg.targetFinal ?? '';
    if (CYRILLIC_REGEX.test(text)) {
      report.withCyrillic.push(seg.id);
    }
    if (findDuplicateDash(text)) {
      report.withDuplicateDash.push(seg.id);
    }
  }

  const dna = await getDocumentDna(documentId);
  const abbrevCount = dna?.abbreviationLogic && typeof dna.abbreviationLogic === 'object'
    ? Object.keys(dna.abbreviationLogic).length
    : 0;

  console.log(JSON.stringify({
    ...report,
    abbreviationLogicKeys: abbrevCount,
    summary: {
      segmentsWithCyrillic: report.withCyrillic.length,
      segmentsWithDuplicateDash: report.withDuplicateDash.length,
    },
  }, null, 2));
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
