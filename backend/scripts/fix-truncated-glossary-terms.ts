/**
 * Script to fix truncated glossary terms in the database
 * 
 * This script identifies and fixes terms that appear to be truncated
 * (e.g., "JSC \"KE" instead of "JSC \"KEGOC\"")
 * 
 * Usage: 
 *   npm run fix:truncated-terms (from backend directory)
 *   OR: npx ts-node scripts/fix-truncated-glossary-terms.ts (from backend directory)
 */

import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

interface TruncatedTerm {
  id: string;
  sourceTerm: string;
  targetTerm: string;
  targetTermLength: number;
  sourceLocale: string;
  targetLocale: string;
}

async function findTruncatedTerms(): Promise<TruncatedTerm[]> {
  const entries = await prisma.glossaryEntry.findMany({
    where: {
      targetLocale: 'en',
    },
    select: {
      id: true,
      sourceTerm: true,
      targetTerm: true,
      sourceLocale: true,
      targetLocale: true,
    },
  });

  const truncated: TruncatedTerm[] = [];

  for (const entry of entries) {
    const targetLength = entry.targetTerm.length;
    const sourceLength = entry.sourceTerm.length;
    
    // Heuristics for detecting truncation:
    // 1. Target term is suspiciously short compared to source (less than 30% of source length)
    // 2. Target term ends with incomplete words (e.g., "KE" instead of "KEGOC")
    // 3. Target term is less than 10 characters but source is longer
    const isSuspiciouslyShort = targetLength < sourceLength * 0.3 && sourceLength > 10;
    const endsWithIncompleteWord = /[A-Z]{1,2}"?$/.test(entry.targetTerm) && !entry.targetTerm.endsWith('"');
    const veryShort = targetLength < 10 && sourceLength > 15;
    
    if (isSuspiciouslyShort || (endsWithIncompleteWord && veryShort)) {
      truncated.push({
        id: entry.id,
        sourceTerm: entry.sourceTerm,
        targetTerm: entry.targetTerm,
        targetTermLength: targetLength,
        sourceLocale: entry.sourceLocale,
        targetLocale: entry.targetLocale,
      });
    }
  }

  return truncated;
}

async function fixTerm(entry: TruncatedTerm): Promise<boolean> {
  // Try to find a better translation by:
  // 1. Looking for similar terms in the same glossary
  // 2. Using AI to retranslate (if needed)
  
  // For now, we'll just log the truncated terms
  // Manual fix or AI retranslation can be done separately
  console.log(`Truncated term found:`, {
    id: entry.id,
    sourceTerm: entry.sourceTerm,
    currentTarget: entry.targetTerm,
    length: entry.targetTermLength,
  });
  
  return false; // Return false to indicate manual fix needed
}

async function main() {
  console.log('Searching for truncated glossary terms...');
  
  const truncated = await findTruncatedTerms();
  
  console.log(`Found ${truncated.length} potentially truncated terms`);
  
  if (truncated.length > 0) {
    console.log('\nTruncated terms:');
    truncated.slice(0, 20).forEach((entry, index) => {
      console.log(`${index + 1}. Source: "${entry.sourceTerm}" -> Target: "${entry.targetTerm}" (${entry.targetTermLength} chars)`);
    });
    
    if (truncated.length > 20) {
      console.log(`... and ${truncated.length - 20} more`);
    }
    
    console.log('\n⚠️  These terms need manual review and correction.');
    console.log('You can update them via the glossary API or UI.');
  } else {
    console.log('No truncated terms found.');
  }
}

main()
  .catch((error) => {
    console.error('Error:', error);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
