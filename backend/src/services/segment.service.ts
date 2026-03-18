import type { SegmentStatus } from '@prisma/client';
import { prisma } from '../db/prisma';
import { ApiError } from '../utils/apiError';
import { upsertTranslationMemoryEntry } from './tm.service';
import { splitIntoSentences, stripFormattingTags } from '../utils/segmentation';
import { logger } from '../utils/logger';

type SegmentUpdateInput = {
  targetMt?: string | null;
  targetFinal?: string | null;
  status?: SegmentStatus;
  fuzzyScore?: number | null;
  bestTmEntryId?: string | null;
  confirmedById?: string | null;
  confirmedAt?: Date | null;
  timeSpentSeconds?: number | null;
  mtFullPrompt?: string | null;
  mtAnalysis?: string | null;
};

/**
 * Smart Save: Save TM entries as sentences if alignment matches, otherwise as paragraph
 * 
 * Strategy:
 * - Split source and target into sentences
 * - If sentence counts match: save each sentence pair with entryType: 'sentence'
 * - If counts don't match: save as paragraph with entryType: 'paragraph'
 */
async function saveToTranslationMemory(
  sourceText: string,
  targetText: string,
  sourceLocale: string,
  targetLocale: string,
  projectId: string | null,
  userId: string,
  clientName?: string | null,
  domain?: string | null,
): Promise<void> {
  // Strip formatting tags ({{0}}, {{/0}}, etc.) before processing
  // This ensures TM entries are saved without formatting markers for better matching
  const cleanSourceText = stripFormattingTags(sourceText);
  const cleanTargetText = stripFormattingTags(targetText);
  
  // Split source and target into sentences
  const sourceSentences = splitIntoSentences(cleanSourceText, sourceLocale);
  const targetSentences = splitIntoSentences(cleanTargetText, targetLocale);

  // Condition A: Perfect Alignment - sentence counts match
  if (sourceSentences.length === targetSentences.length && sourceSentences.length > 0) {
    // Save BOTH the paragraph AND each sentence individually
    // This allows users to see both paragraph-level and sentence-level matches in the UI
    const savePromises: Promise<any>[] = [];
    
    // 1. Save the full paragraph (for paragraph-level matching)
    savePromises.push(
      upsertTranslationMemoryEntry({
        projectId: projectId ?? undefined,
        sourceLocale,
        targetLocale,
        sourceText: cleanSourceText.trim(),
        targetText: cleanTargetText.trim(),
        createdById: userId,
        clientName: clientName ?? undefined,
        domain: domain ?? undefined,
        matchRate: 1,
        entryType: 'paragraph',
      })
    );
    
    // 2. Save each sentence pair individually (for sentence-level matching)
    for (let index = 0; index < sourceSentences.length; index++) {
      const sourceSentence = sourceSentences[index];
      const targetSentence = targetSentences[index];
      
      // Only save if both sentences are non-empty
      // Strip formatting tags from sentences before saving
      const cleanSourceSentence = stripFormattingTags(sourceSentence).trim();
      const cleanTargetSentence = stripFormattingTags(targetSentence).trim();
      
      if (cleanSourceSentence.length > 0 && cleanTargetSentence.length > 0) {
        savePromises.push(
          upsertTranslationMemoryEntry({
            projectId: projectId ?? undefined,
            sourceLocale,
            targetLocale,
            sourceText: cleanSourceSentence,
            targetText: cleanTargetSentence,
            createdById: userId,
            clientName: clientName ?? undefined,
            domain: domain ?? undefined,
            matchRate: 1,
            entryType: 'sentence',
          })
        );
      }
    }

    await Promise.all(savePromises);
    
    console.log(`Saved 1 paragraph + ${sourceSentences.length} sentence pair(s) to TM`);
  } else {
    // Condition B: Mismatch/Blob - save as paragraph
    // Strip formatting tags before saving
    await upsertTranslationMemoryEntry({
      projectId: projectId ?? undefined,
      sourceLocale,
      targetLocale,
      sourceText: cleanSourceText.trim(),
      targetText: cleanTargetText.trim(),
      createdById: userId,
      clientName: clientName ?? undefined,
      domain: domain ?? undefined,
      matchRate: 1,
      entryType: 'paragraph',
    });
    
    console.log(`Saved paragraph to TM (entryType: 'paragraph') - sentence counts: source=${sourceSentences.length}, target=${targetSentences.length}`);
  }
}

export const getDocumentSegments = async (documentId: string, page = 1, pageSize = 200) => {
  const skip = (page - 1) * pageSize;
  const [segments, total] = await Promise.all([
    prisma.segment.findMany({
      where: { documentId },
      orderBy: { segmentIndex: 'asc' },
      skip,
      take: pageSize,
    }),
    prisma.segment.count({ where: { documentId } }),
  ]);
  return {
    segments,
    page,
    pageSize,
    total,
    totalPages: Math.max(1, Math.ceil(total / pageSize)),
  };
};

const PAGINATED_SCAN_PAGE_SIZE = 10000;

/**
 * Find segment ids and segmentIndex for segments whose sourceText contains any of the given terms (case-insensitive).
 * Uses paginated scan for large documents to avoid huge queries.
 */
export const findSegmentIdsContainingTerms = async (
  documentId: string,
  terms: string[],
): Promise<Array<{ id: string; segmentIndex: number }>> => {
  if (terms.length === 0) return [];
  const normalizedTerms = terms.map((t) => t.trim().toLowerCase()).filter(Boolean);
  if (normalizedTerms.length === 0) return [];

  const result: Array<{ id: string; segmentIndex: number }> = [];
  let skip = 0;

  while (true) {
    const chunk = await prisma.segment.findMany({
      where: { documentId },
      orderBy: { segmentIndex: 'asc' },
      skip,
      take: PAGINATED_SCAN_PAGE_SIZE,
      select: { id: true, segmentIndex: true, sourceText: true },
    });
    if (chunk.length === 0) break;
    for (const seg of chunk) {
      const lower = (seg.sourceText ?? '').toLowerCase();
      if (normalizedTerms.some((t) => lower.includes(t))) {
        result.push({ id: seg.id, segmentIndex: seg.segmentIndex });
      }
    }
    if (chunk.length < PAGINATED_SCAN_PAGE_SIZE) break;
    skip += PAGINATED_SCAN_PAGE_SIZE;
  }

  return result;
};

export const updateSegment = async (segmentId: string, data: SegmentUpdateInput) => {
  const segment = await prisma.segment.findUnique({
    where: { id: segmentId },
    include: { document: { include: { project: true } } },
  });
  if (!segment) {
    throw ApiError.notFound('Segment not found');
  }

  const updated = await prisma.segment.update({
    where: { id: segmentId },
    data,
  });

  // Track propagation info for response
  let propagatedCount = 0;

  // If segment is confirmed and has targetFinal: save to TM (optional) and run auto-propagation (always)
  if (data.status === 'CONFIRMED' && updated.targetFinal && updated.targetFinal.trim()) {
    // 1) Save to TM (non-blocking: skip if no userId or on error; do not block propagation)
    try {
      const confirmedSegment = await prisma.segment.findUnique({
        where: { id: segmentId },
        select: { confirmedById: true },
      });
      let userId = confirmedSegment?.confirmedById;
      if (!userId) {
        const projectMember = await prisma.projectMember.findFirst({
          where: { projectId: segment.document.projectId },
          select: { userId: true },
        });
        userId = projectMember?.userId;
      }
      if (userId) {
        await saveToTranslationMemory(
          updated.sourceText,
          updated.targetFinal.trim(),
          segment.document.sourceLocale,
          segment.document.targetLocale,
          segment.document.projectId,
          userId,
          segment.document.project.clientName,
          segment.document.project.domain,
        );
      } else {
        console.warn(`Cannot add segment ${segmentId} to TM: no user ID available`);
      }
    } catch (tmError) {
      console.error('Failed to add confirmed segment to TM:', tmError);
    }

    // 2) Auto-propagation: always run in its own try so TM failure or missing userId does not skip it
    try {
        const autoPropSettings = await getAutoPropagationSettings(segment.document.projectId);

        if (autoPropSettings.enabled) {
          const similarSegments = await findSimilarSegmentsInDocument(
            segment.documentId,
            updated.sourceText,
            segmentId,
            autoPropSettings.similarityThreshold,
          );

          if (similarSegments.length > 0) {
            // Apply translation to similar segments with smart number/date replacement
            const propagationUpdates: Array<{ id: string; targetFinal: string; status: SegmentStatus; fuzzyScore: number }> = [];
            for (const similar of similarSegments) {
              let targetFinal = updated.targetFinal!;
              let appliedNumberReplacement = false;

              if (similar.differsOnlyByNumbers) {
                const { applied, result } = replaceNumbersAndDates(
                  updated.targetFinal!,
                  updated.sourceText,
                  similar.sourceText,
                  segment.document.targetLocale,
                );
                if (applied && isValidReplacement(updated.targetFinal!, result, updated.sourceText, similar.sourceText)) {
                  targetFinal = result;
                  appliedNumberReplacement = true;
                } else if (!applied) {
                  const fallback = replaceLeadingSectionNumber(updated.targetFinal!, similar.sourceText);
                  if (fallback !== updated.targetFinal! && isValidReplacement(updated.targetFinal!, fallback, updated.sourceText, similar.sourceText)) {
                    targetFinal = fallback;
                    appliedNumberReplacement = true;
                  }
                }
              } else {
                // Text differs (e.g. "Монтаж" vs "Подвеска") - still replace leading section number so target matches similar source
                const fallback = replaceLeadingSectionNumber(updated.targetFinal!, similar.sourceText);
                if (fallback !== updated.targetFinal! && isValidReplacement(updated.targetFinal!, fallback, updated.sourceText, similar.sourceText)) {
                  targetFinal = fallback;
                  appliedNumberReplacement = true;
                }
              }

              // Ensure target leading section number matches similar segment's source (fixes wrong number when replaceNumbersAndDates/applied path didn't substitute)
              const similarSectionMatch = similar.sourceText.match(LEADING_SECTION_NUMBER);
              if (similarSectionMatch) {
                const similarSection = similarSectionMatch[1];
                if (!targetFinal.startsWith(similarSection)) {
                  const fixed = replaceLeadingSectionNumber(targetFinal, similar.sourceText);
                  if (fixed !== targetFinal && isValidReplacement(targetFinal, fixed, updated.sourceText, similar.sourceText)) {
                    targetFinal = fixed;
                    appliedNumberReplacement = true;
                  }
                }
              }

              const actualSimilarity = Math.round(similar.similarity * 100);
              const propagationMarker = appliedNumberReplacement ? 2000 : 1000;
              propagationUpdates.push({
                id: similar.id,
                targetFinal,
                status: 'EDITED' as SegmentStatus,
                fuzzyScore: propagationMarker + actualSimilarity,
              });
            }

            if (propagationUpdates.length > 0) {
              await bulkUpdateSegments(propagationUpdates);
              propagatedCount = propagationUpdates.length;
              logger.info(
                {
                  documentId: segment.documentId,
                  confirmedSegmentId: segmentId,
                  propagatedCount: propagationUpdates.length,
                  similarityThreshold: autoPropSettings.similarityThreshold,
                  similarSegmentIds: propagationUpdates.map((u) => u.id),
                },
                'Auto-propagated confirmed translation to similar segments',
              );
            }
          }
        }
    } catch (propagationError) {
      logger.warn(
        { segmentId, error: (propagationError as Error).message },
        'Failed to auto-propagate to similar segments (non-critical)',
      );
    }
  }

  // Add propagation metadata to response (as a custom property that won't conflict with Prisma types)
  return {
    ...updated,
    _meta: propagatedCount > 0 ? { propagatedCount } : undefined,
  } as typeof updated & { _meta?: { propagatedCount: number } };
};

export const bulkUpsertSegments = (
  segments: Array<{ documentId: string; segmentIndex: number; sourceText: string; targetMt?: string | null }>,
) =>
  prisma.$transaction(
    segments.map((segment) =>
      prisma.segment.upsert({
        where: {
          documentId_segmentIndex: {
            documentId: segment.documentId,
            segmentIndex: segment.segmentIndex,
          },
        },
        update: {
          sourceText: segment.sourceText,
          targetMt: segment.targetMt ?? undefined,
        },
        create: {
          ...segment,
          status: 'NEW',
        },
      }),
    ),
  );

export const getSegment = async (segmentId: string) => {
  const segment = await prisma.segment.findUnique({
    where: { id: segmentId },
    include: { document: true, qualityMetric: true },
  });
  if (!segment) {
    throw ApiError.notFound('Segment not found');
  }
  return segment;
};

export const bulkUpdateSegments = async (updates: Array<{ id: string } & SegmentUpdateInput>) => {
  // First, get all segments with their documents to check for confirmed status
  const segmentIds = updates.map((u) => u.id);
  const segments = await prisma.segment.findMany({
    where: { id: { in: segmentIds } },
    include: { document: { include: { project: true } } },
  });

  const segmentMap = new Map(segments.map((s) => [s.id, s]));

  const results = await prisma.$transaction(
    updates.map((update) => {
      const { id, ...data } = update;
      return prisma.segment.update({
        where: { id },
        data,
        include: { document: { include: { project: true } } },
      });
    }),
  );

  // Add confirmed segments to TM
  const tmPromises = results
    .filter((updated) => {
      const original = segmentMap.get(updated.id);
      return (
        updated.status === 'CONFIRMED' &&
        updated.targetFinal &&
        updated.targetFinal.trim() &&
        original?.status !== 'CONFIRMED' // Only if newly confirmed
      );
    })
    .map(async (updated) => {
      // Get userId from confirmedById or fallback to project member
      let userId = updated.confirmedById;
      if (!userId) {
        const projectMember = await prisma.projectMember.findFirst({
          where: { projectId: updated.document.projectId },
          select: { userId: true },
        });
        userId = projectMember?.userId;
      }
      
      if (!userId) {
        console.warn(`Cannot add segment ${updated.id} to TM: no user ID available`);
        return null;
      }

      // Smart Save: Save as sentences if alignment matches, otherwise as paragraph
      return saveToTranslationMemory(
        updated.sourceText,
        updated.targetFinal!.trim(),
        updated.document.sourceLocale,
        updated.document.targetLocale,
        updated.document.projectId,
        userId,
        updated.document.project.clientName,
        updated.document.project.domain,
      ).catch((error) => {
        console.error(`Failed to add segment ${updated.id} to TM:`, error);
        return null;
      });
    });

  await Promise.all(tmPromises);

  return results;
};

export const searchSegments = async (documentId: string, query: string) => {
  return prisma.segment.findMany({
    where: {
      documentId,
      OR: [
        { sourceText: { contains: query, mode: 'insensitive' } },
        { targetFinal: { contains: query, mode: 'insensitive' } },
        { targetMt: { contains: query, mode: 'insensitive' } },
      ],
    },
    orderBy: { segmentIndex: 'asc' },
  });
};

export const getSegmentWithDocument = (segmentId: string) =>
  prisma.segment.findUnique({
    where: { id: segmentId },
    include: {
      document: {
        select: { id: true, name: true, sourceLocale: true, targetLocale: true, projectId: true },
      },
    },
  });

type NumberOrDateToken = { value: string; type: 'number' | 'date' | 'phone'; index: number };

function isInsideSpan(index: number, length: number, spans: Array<{ index: number; value: string }>): boolean {
  return spans.some(s => index >= s.index && index + length <= s.index + s.value.length);
}

/**
 * Extract numbers, dates, and phone numbers from text.
 * Phones are extracted first so digit sequences inside them are not treated as separate numbers.
 * Date+time (e.g. 18.11.2025 15:18:02) is matched as one token so time is replaced with the date.
 */
function extractNumbersAndDates(text: string): NumberOrDateToken[] {
  const results: NumberOrDateToken[] = [];

  // 1. Match phone numbers first (whole token; no locale formatting on replace)
  const phoneRegex = /\+\d{1,4}[\s().-]*\d{2,4}[\s().-]*\d{2,4}[\s().-]*\d{2,4}([\s.-]*\d{2,4})?/g;
  const phoneSpans: Array<{ index: number; value: string }> = [];
  let match;
  while ((match = phoneRegex.exec(text)) !== null) {
    const value = match[0];
    results.push({ value, type: 'phone', index: match.index });
    phoneSpans.push({ index: match.index, value });
  }

  // 2. Match dates (with optional time) before numbers so "18.11.2025 15:18:02" is one token.
  // Use backreference so both separators must be the same (avoids "2025/1-8" as one date).
  // Require (?:^|(?<![/\d])) before and (?![\d/]) after so we don't match dates embedded in
  // contract numbers (e.g. "32/20/26" or "1/20/26" inside "891321/2026/1-8").
  const dateTimeRegex = /(?:^|(?<![/\d]))(\d{1,2}([./-])\d{1,2}\2\d{2,4}(?:\s+\d{1,2}:\d{2}(?::\d{2})?)?|\d{4}([./-])\d{1,2}\3\d{1,2}(?:\s+\d{1,2}:\d{2}(?::\d{2})?)?)(?![\d/])/g;
  const dateSpans: Array<{ index: number; value: string }> = [];
  while ((match = dateTimeRegex.exec(text)) !== null) {
    if (isInsideSpan(match.index, match[0].length, phoneSpans)) continue;
    const beforeMatch = text.substring(Math.max(0, match.index - 10), match.index);
    const afterMatch = text.substring(match.index + match[0].length, match.index + match[0].length + 1);
    const datePart = (match[0].trim().split(/\s+/)[0] ?? '').trim();
    const isSectionNumber = (
      (match.index === 0 || /^[\s.]*$/.test(beforeMatch)) &&
      afterMatch === '.' &&
      /^\d{1,2}\.\d{1,2}\.\d{1,2}$/.test(datePart)
    );
    if (isSectionNumber) continue;
    results.push({ value: match[0], type: 'date', index: match.index });
    dateSpans.push({ index: match.index, value: match[0] });
  }

  const excludeSpans = [...phoneSpans, ...dateSpans];

  // 3. Match numbers (integers, decimals, percentages) but skip those inside phone or date
  const numberRegex = /(\d+[.,]?\d*%?|\d+[.,]\d+)/g;
  while ((match = numberRegex.exec(text)) !== null) {
    if (isInsideSpan(match.index, match[0].length, excludeSpans)) continue;
    results.push({
      value: match[0],
      type: 'number',
      index: match.index,
    });
  }

  // Merge consecutive number matches that form a subsection number (X.X.X e.g. 5.1.8, 5.1.12)
  // so segment and target token counts align (e.g. segment "5.1"+"8"+"5.1" -> "5.1.8"+"5.1" to match target "5.1.12"+"5.1").
  const merged: NumberOrDateToken[] = [];
  let i = 0;
  while (i < results.length) {
    const a = results[i];
    if (a.type !== 'number') {
      merged.push(a);
      i += 1;
      continue;
    }
    const hasNext = i + 1 < results.length && results[i + 1].type === 'number';
    const gapStart = a.index + a.value.length;
    const gap = hasNext ? text.substring(gapStart, results[i + 1].index) : '';
    const canMergeNext =
      hasNext &&
      /^\d{1,2}\.\d{1,2}$/.test(a.value) &&
      /^\d{1,2}$/.test(results[i + 1].value) &&
      (gap === '.' || gap === ' ' || gap === '' || /^\s+$/.test(gap));
    const sectionValue = canMergeNext ? `${a.value}.${results[i + 1].value}` : null;
    if (sectionValue && /^\d{1,2}\.\d{1,2}\.\d{1,2}$/.test(sectionValue)) {
      merged.push({ value: sectionValue, type: 'number', index: a.index });
      i += 2;
    } else {
      merged.push(a);
      i += 1;
    }
  }
  results.length = 0;
  results.push(...merged);

  // Merge two consecutive number tokens separated by a dot to form clause/section ref (e.g. "1" + "." + "1" -> "1.1")
  // so segment and target token counts align (e.g. "пункте 1.1" / "clause 1.3" and "разделе 10" / "section 18").
  const clauseMerged: NumberOrDateToken[] = [];
  i = 0;
  while (i < results.length) {
    const a = results[i];
    if (a.type !== 'number') {
      clauseMerged.push(a);
      i += 1;
      continue;
    }
    const hasNext = i + 1 < results.length && results[i + 1].type === 'number';
    const gapStart = a.index + a.value.length;
    const gap = hasNext ? text.substring(gapStart, results[i + 1].index) : '';
    const dotOnly = /^\.\s*$|^\.$/.test(gap);
    const canMergeClause =
      hasNext &&
      dotOnly &&
      /^\d{1,2}$/.test(a.value) &&
      /^\d{1,2}$/.test(results[i + 1].value);
    if (canMergeClause) {
      clauseMerged.push({ value: `${a.value}.${results[i + 1].value}`, type: 'number', index: a.index });
      i += 2;
    } else {
      clauseMerged.push(a);
      i += 1;
    }
  }
  results.length = 0;
  results.push(...clauseMerged);

  // Merge space-separated digit groups that form one amount (e.g. "1 676 502 220,83" -> one token)
  const spaceMerged: NumberOrDateToken[] = [];
  i = 0;
  while (i < results.length) {
    const a = results[i];
    if (a.type !== 'number') {
      spaceMerged.push(a);
      i += 1;
      continue;
    }
    let j = i;
    while (j + 1 < results.length && results[j + 1].type === 'number') {
      const gapStart = results[j].index + results[j].value.length;
      const gap = text.substring(gapStart, results[j + 1].index);
      if (!/^\s+$/.test(gap)) break;
      j += 1;
    }
    if (j > i) {
      const first = results[i];
      const last = results[j];
      const span = text.substring(first.index, last.index + last.value.length);
      const normalized = span.replace(/\s+/g, '').replace(/,(\d+)$/, '.$1');
      spaceMerged.push({ value: normalized, type: 'number', index: first.index });
      i = j + 1;
    } else {
      spaceMerged.push(a);
      i += 1;
    }
  }

  // Merge comma-separated digit groups (e.g. "1,675,857,278.83" in target -> one token)
  // so segment and target have the same token count for amount substitution.
  const amountMerged: NumberOrDateToken[] = [];
  i = 0;
  while (i < spaceMerged.length) {
    const a = spaceMerged[i];
    if (a.type !== 'number') {
      amountMerged.push(a);
      i += 1;
      continue;
    }
    let j = i;
    while (j + 1 < spaceMerged.length && spaceMerged[j + 1].type === 'number') {
      const gapStart = spaceMerged[j].index + spaceMerged[j].value.length;
      const gap = text.substring(gapStart, spaceMerged[j + 1].index);
      if (!/^,+$/.test(gap)) break;
      j += 1;
    }
    if (j > i) {
      const first = spaceMerged[i];
      const last = spaceMerged[j];
      const span = text.substring(first.index, last.index + last.value.length);
      const normalized = span.replace(/,/g, '');
      amountMerged.push({ value: normalized, type: 'number', index: first.index });
      i = j + 1;
    } else {
      amountMerged.push(a);
      i += 1;
    }
  }

  return amountMerged.sort((a, b) => a.index - b.index);
}

/**
 * Check if two texts differ only by numbers/dates
 */
function differsOnlyByNumbers(source1: string, source2: string): boolean {
  // Normalize by replacing numbers/dates with placeholders
  const normalize = (text: string) => {
    let normalized = text;
    const numbersAndDates = extractNumbersAndDates(text);
    
    // Replace from end to start to preserve indices
    for (let i = numbersAndDates.length - 1; i >= 0; i--) {
      const item = numbersAndDates[i];
      normalized = normalized.substring(0, item.index) + 
                   `[${item.type}]` + 
                   normalized.substring(item.index + item.value.length);
    }
    return normalized;
  };
  
  const norm1 = normalize(source1);
  const norm2 = normalize(source2);
  
  // If normalized texts are identical (case-insensitive, trimmed), they differ only by numbers/dates
  return norm1.toLowerCase().trim() === norm2.toLowerCase().trim();
}

/**
 * Format date (and optional time) according to target locale conventions.
 * If input is "DD.MM.YYYY HH:MM:SS", the time is preserved and appended after the formatted date.
 */
function formatDateForLocale(dateStr: string, locale: string): string {
  try {
    const trimmed = dateStr.trim();
    const dateTimeParts = trimmed.split(/\s+(?=\d{1,2}:\d{2})/); // split before "HH:MM" or "HH:MM:SS"
    const dateOnly = dateTimeParts[0] ?? trimmed;
    const timePart = dateTimeParts[1]; // e.g. "15:18:02" or "15:18"

    // Parse common date formats (date part only)
    let date: Date | null = null;

    // Try DD.MM.YYYY or DD/MM/YYYY
    const ddmmyyyy = dateOnly.match(/^(\d{1,2})[./-](\d{1,2})[./-](\d{4})$/);
    if (ddmmyyyy) {
      const day = parseInt(ddmmyyyy[1]);
      const month = parseInt(ddmmyyyy[2]);
      const year = parseInt(ddmmyyyy[3]);
      // Check if it's US format (MM/DD) or European (DD/MM) based on locale
      if (locale.toLowerCase().startsWith('en-us') && month <= 12 && day <= 12) {
        // Ambiguous - try US format first
        date = new Date(year, month - 1, day);
        if (date.getMonth() !== month - 1 || date.getDate() !== day) {
          // Try European format
          date = new Date(year, day - 1, month);
        }
      } else {
        // European format (DD/MM)
        date = new Date(year, month - 1, day);
      }
    }

    // Try YYYY-MM-DD
    if (!date) {
      const yyyymmdd = dateOnly.match(/^(\d{4})[./-](\d{1,2})[./-](\d{1,2})$/);
      if (yyyymmdd) {
        date = new Date(parseInt(yyyymmdd[1]), parseInt(yyyymmdd[2]) - 1, parseInt(yyyymmdd[3]));
      }
    }
    
    // Try 2-digit year formats
    if (!date) {
      const ddmmyy = dateOnly.match(/^(\d{1,2})[./-](\d{1,2})[./-](\d{2})$/);
      if (ddmmyy) {
        const year = parseInt(ddmmyy[3]);
        const fullYear = year < 50 ? 2000 + year : 1900 + year; // Assume 2000s for years < 50
        if (locale.toLowerCase().startsWith('en-us')) {
          date = new Date(fullYear, parseInt(ddmmyy[1]) - 1, parseInt(ddmmyy[2]));
        } else {
          date = new Date(fullYear, parseInt(ddmmyy[2]) - 1, parseInt(ddmmyy[1]));
        }
      }
    }
    
    if (!date || isNaN(date.getTime())) {
      return dateStr; // Return original if parsing fails
    }

    // Format according to locale
    const localeMap: Record<string, Intl.DateTimeFormatOptions> = {
      'en': { day: '2-digit', month: '2-digit', year: 'numeric' },
      'en-us': { month: '2-digit', day: '2-digit', year: 'numeric' },
      'ru': { day: '2-digit', month: '2-digit', year: 'numeric' },
      'de': { day: '2-digit', month: '2-digit', year: 'numeric' },
      'fr': { day: '2-digit', month: '2-digit', year: 'numeric' },
    };

    const localeKey = locale.toLowerCase().split('-')[0];
    const options = localeMap[locale.toLowerCase()] || localeMap[localeKey] || {
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
    };

    let formatted: string;
    try {
      const formatter = new Intl.DateTimeFormat(locale, options);
      formatted = formatter.format(date);
    } catch {
      formatted = `${date.getDate().toString().padStart(2, '0')}.${(date.getMonth() + 1).toString().padStart(2, '0')}.${date.getFullYear()}`;
    }
    // Preserve time part if present (e.g. 15:18:02)
    if (timePart && /^\d{1,2}:\d{2}(:\d{2})?$/.test(timePart.trim())) {
      return `${formatted} ${timePart.trim()}`;
    }
    return formatted;
  } catch {
    return dateStr; // Return original on error
  }
}

/** Month names (EN) to detect date context so we don't add thousands to years (e.g. "10 September 2025" not "2,025") */
const MONTH_NAME_IN_TARGET = /\b(January|February|March|April|May|June|July|August|September|October|November|December)\b/i;
/** Numeric date (e.g. 10.09.2025 or 10/09/2025) so year stays "2025" not "2,025" */
const NUMERIC_DATE_IN_TARGET = /\d{1,2}[./-]\d{1,2}[./-]/;
/** Year-context hints (e.g. "for 2023 year", "in 2024", "fiscal year 2025") so year stays "2023" not "2,023" */
const YEAR_CONTEXT_IN_TARGET = /\b(fiscal\s+year|fy|year|года|год)\b/i;
/** Strong English pattern used in our legal templates: "stipulated for 2023" */
const STIPULATED_FOR_YEAR = /\bstipulated\s+for\s+\d{4}\b/i;

/**
 * Format number according to target locale conventions.
 * Optional context.targetSnippet: when the number is a 4-digit integer and the snippet looks like a date
 * (month name or numeric DD.MM/DD-MM/DD/MM), format without thousands grouping so "2025" stays "2025".
 */
function formatNumberForLocale(
  numberStr: string,
  locale: string,
  context?: { targetSnippet?: string },
): string {
  try {
    const hasPercent = numberStr.includes('%');
    const numStr = numberStr.replace('%', '').trim();
    const normalizedNumStr = numStr.replace(',', '.');
    const num = parseFloat(normalizedNumStr);
    if (isNaN(num)) {
      return numberStr;
    }
    const isInteger = Number.isInteger(num);
    const snippet = context?.targetSnippet ?? '';
    const inYearOrDateContext =
      snippet &&
      isInteger &&
      num >= 1000 &&
      num <= 2999 &&
      (
        MONTH_NAME_IN_TARGET.test(snippet) ||
        NUMERIC_DATE_IN_TARGET.test(snippet) ||
        YEAR_CONTEXT_IN_TARGET.test(snippet) ||
        STIPULATED_FOR_YEAR.test(snippet)
      );
    const formatter = new Intl.NumberFormat(locale, {
      minimumFractionDigits: (normalizedNumStr.includes('.') || normalizedNumStr.includes(',')) ? 2 : 0,
      maximumFractionDigits: 2,
      useGrouping: inYearOrDateContext ? false : true,
    });
    let formatted = formatter.format(num);
    if (hasPercent) {
      formatted += '%';
    }
    return formatted;
  } catch {
    return numberStr;
  }
}

/** Section number pattern (e.g. 11.04.05) - do not format as decimal, use as-is */
const SECTION_NUMBER_PATTERN = /^\d{1,2}\.\d{1,2}\.\d{1,2}$/;
/** Section number at start of text (with optional trailing dot/space) */
const LEADING_SECTION_NUMBER = /^\s*(\d{1,2}\.\d{1,2}\.\d{1,2})[.\s]/;
const TARGET_LEADING_SECTION = /^(\s*)(\d{1,2}\.\d{1,2}\.\d{1,2})([.\s])/;

/**
 * Replace only the leading section number (XX.XX.XX) in target with the one from similar source.
 * Used when full token-based replacement doesn't apply (e.g. different tokenization).
 */
function replaceLeadingSectionNumber(targetText: string, similarSourceText: string): string {
  const matchSource = similarSourceText.match(LEADING_SECTION_NUMBER);
  const matchTarget = targetText.match(TARGET_LEADING_SECTION);
  if (!matchSource || !matchTarget) return targetText;
  const [, prefix, , suffix] = matchTarget;
  return targetText.replace(TARGET_LEADING_SECTION, `${prefix}${matchSource[1]}${suffix}`);
}

/**
 * Target already has leading clause X.X.X — allow closing guillemot » after the number (e.g. «3.3.3» 50)
 * so we do not prepend twice.
 */
const TARGET_HAS_LEADING_SECTION =
  /^[\s\uFEFF]*[\u00AB\u201C\u201E\u201F"]?\s*\d{1,2}\.\d{1,2}\.\d{1,2}(?:[.\s\u00BB]+|(?=\s+\S)|$)/;

/** Collapse «5.1.4. 5.1.4. or 5.1.4. 5.1.4. at segment start (duplicate clause from TM + prepend). */
function dedupeLeadingClauseRepeat(text: string): string {
  let s = text;
  s = s.replace(
    /^([\s\uFEFF]*)(«\s*)(\d{1,2}\.\d{1,2}\.\d{1,2})\.\s+\3\.\s+/i,
    '$1$2$3. ',
  );
  s = s.replace(/^([\s\uFEFF]*)(\d{1,2}\.\d{1,2}\.\d{1,2})\.\s+\2\.\s+/i, '$1$2. ');
  return s;
}

/**
 * Extract canonical leading clause prefix «X.X.X. (or same opening quote as source) from segment.
 * Uses stripped text so {{0}}«3.3.3» … works. Handles «3.3.3» immediately before word (» not matched by old [.\s]+).
 */
function leadingClausePrefixFromSegmentSource(segmentSource: string): string | null {
  if (!segmentSource) return null;
  const s = (stripFormattingTags(segmentSource) || '').trimStart();
  if (!s) return null;
  const m = s.match(
    /^([\s\uFEFF]*)([\u00AB\u201C\u201E\u201F"]?)\s*(\d{1,2}\.\d{1,2}\.\d{1,2})(?:[.\s\u00BB]+|(?=\s+\S)|$)/,
  );
  if (m?.[3]) {
    const q = m[2] || '\u00AB';
    return `${q}${m[3]}. `;
  }
  const numOnly = s.match(/^\s*(\d{1,2}\.\d{1,2}\.\d{1,2})(?:[.\s\u00BB]+|(?=\s+\S)|$)/);
  if (numOnly) return `«${numOnly[1]}. `;
  return null;
}

/**
 * If segment source starts with a leading section prefix (e.g. «3.3.3. or 3.3.3. ) and target does not, prepend it.
 * Exported so pretranslate can apply it with the exact segment.sourceText after TM substitution.
 * Fallback: if the main regex fails (e.g. encoding), try matching number at start and preserve leading quote from segment.
 */
export function ensureLeadingSectionFromSegment(targetText: string, segmentSource: string): string {
  if (!segmentSource || !targetText) return targetText;

  const segmentLeadingPrefix = leadingClausePrefixFromSegmentSource(segmentSource);
  const segmentNumMatch = segmentLeadingPrefix?.match(/(\d{1,2}\.\d{1,2}\.\d{1,2})/);
  const segmentNums = segmentNumMatch?.[1] ?? null;
  const cleanTarget = (stripFormattingTags(targetText) || targetText).trimStart();
  const targetHasLeading =
    TARGET_HAS_LEADING_SECTION.test(cleanTarget) || TARGET_HAS_LEADING_SECTION.test(targetText.trimStart());

  // TM often returns "5.1.4. In…" while source has «5.1.4. — prepend would yield «5.1.4. 5.1.4.
  if (segmentLeadingPrefix && segmentNums && cleanTarget.length > 0) {
    const esc = segmentNums.replace(/\./g, '\\.');
    const bareLead = new RegExp(`^${esc}\\.\\s+`);
    if (bareLead.test(cleanTarget) && !/^[\s\uFEFF]*[\u00AB\u201C\u201E\u201F"]/i.test(cleanTarget)) {
      const rest = cleanTarget.replace(bareLead, '');
      const out = `${segmentLeadingPrefix}${rest}`;
      return dedupeLeadingClauseRepeat(out);
    }
  }

  if (targetHasLeading) {
    return dedupeLeadingClauseRepeat(targetText);
  }

  if (segmentLeadingPrefix && targetText.trim().length > 0) {
    return dedupeLeadingClauseRepeat(`${segmentLeadingPrefix}${targetText.trimStart()}`);
  }
  return dedupeLeadingClauseRepeat(targetText);
}

/**
 * Replace clause (X.Y) and section (N) in target with values from segment when segment has "пункте 1.1" / "разделе 10".
 * When segment has a leading section number (e.g. "«3.3.3. ") and target does not, prepend that full prefix (including «).
 * Call as post-pass so clause/section are fixed even when token-based substitution ran or was skipped.
 */
function applyClauseSectionFromSegment(targetText: string, segmentSource: string): string {
  const cleanSegment = stripFormattingTags(segmentSource);
  const segmentLeadingPrefix = leadingClausePrefixFromSegmentSource(segmentSource);
  const targetHasLeading = targetText.match(TARGET_HAS_LEADING_SECTION);
  let out = targetText;
  if (segmentLeadingPrefix && !targetHasLeading && out.trim().length > 0) {
    out = `${segmentLeadingPrefix}${out.trimStart()}`;
  }
  // Clause: "пункте 1.1" or "пункте 1. 1" or "п. 1.1" -> 1.1
  const clauseMatch = cleanSegment.match(/(?:пункте|п\.)\s*(\d{1,2})\s*[.,]\s*(\d{1,2})/i)
    || cleanSegment.match(/(?:пункте|п\.)\s*(\d{1,2}[.,]\d{1,2})/i);
  const segmentClause = clauseMatch
    ? (clauseMatch[2] != null ? `${clauseMatch[1]}.${clauseMatch[2]}` : clauseMatch[1].replace(',', '.'))
    : null;
  // Section: "разделе 10" or "раздел 10"
  const sectionMatch = cleanSegment.match(/разделе?\s*(\d+)/i);
  const segmentSection = sectionMatch ? sectionMatch[1] : null;

  const targetClauseMatch = out.match(/clause\s+(\d{1,2}\.\d{1,2})\b/i);
  const targetSectionMatch = out.match(/section\s+(\d+)\b/i);
  const targetClause = targetClauseMatch ? targetClauseMatch[1] : null;
  const targetSection = targetSectionMatch ? targetSectionMatch[1] : null;

  if (segmentClause && targetClause && segmentClause !== targetClause) {
    out = out.replace(
      new RegExp(`(clause\\s+)${targetClause.replace(/\./g, '\\.')}\\b`, 'gi'),
      `$1${segmentClause}`,
    );
  }
  if (segmentSection && targetSection && segmentSection !== targetSection) {
    out = out.replace(
      new RegExp(`(section\\s+)${targetSection}\\b`, 'gi'),
      `$1${segmentSection}`,
    );
  }
  return dedupeLeadingClauseRepeat(out);
}

/**
 * Replace numbers/dates in target text with corresponding values from source segment text.
 * Returns { applied: false } when token counts don't match (caller may try section-number-only fallback).
 */
/** Match time in already-localized target (e.g. "18 November 2025 14:43:48") */
const TIME_IN_TARGET = /\d{1,2}:\d{2}(?::\d{2})?/;
/** Target date phrase "DD Month YYYY" so we can replace with segment date (fixes wrong month from TM) */
const TARGET_DATE_PHRASE = /\b(\d{1,2})\s+(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{4})\b/i;
/** Russian month names (genitive) -> month number for "29 октября 2025 года" */
const RU_MONTH_GENITIVE: Record<string, number> = {
  января: 1, февраля: 2, марта: 3, апреля: 4, мая: 5, июня: 6,
  июля: 7, августа: 8, сентября: 9, октября: 10, ноября: 11, декабря: 12,
};

function parseSegmentDateToDDMMYYYY(segmentText: string): string | null {
  const t = segmentText.trim();
  const numeric = t.match(/(\d{1,2})[./-](\d{1,2})[./-](\d{4})/);
  if (numeric) return `${numeric[1].padStart(2, '0')}.${numeric[2].padStart(2, '0')}.${numeric[3]}`;
  const ru = t.match(/(\d{1,2})\s+(\S+)\s+(\d{4})/);
  if (ru) {
    const monthKey = ru[2].toLowerCase().replace(/\.$/, '');
    const month = RU_MONTH_GENITIVE[monthKey];
    if (month != null) return `${ru[1].padStart(2, '0')}.${String(month).padStart(2, '0')}.${ru[3]}`;
  }
  return null;
}

function formatDatePhraseForLocale(ddMmYyyy: string, locale: string): string {
  const [d, m, y] = ddMmYyyy.split('.');
  const date = new Date(parseInt(y, 10), parseInt(m, 10) - 1, parseInt(d, 10));
  if (isNaN(date.getTime())) return ddMmYyyy;
  try {
    return new Intl.DateTimeFormat(locale, { day: 'numeric', month: 'long', year: 'numeric' }).format(date);
  } catch {
    return ddMmYyyy;
  }
}

function replaceNumbersAndDates(
  targetText: string,
  sourceText: string,
  sourceSegmentText: string,
  targetLocale: string,
): { applied: boolean; result: string } {
  const cleanSource = stripFormattingTags(sourceText);
  const cleanSourceSegment = stripFormattingTags(sourceSegmentText);
  let cleanTarget = stripFormattingTags(targetText);
  const sourceNumbers = extractNumbersAndDates(cleanSource);
  const sourceSegmentNumbers = extractNumbersAndDates(cleanSourceSegment);

  // Replace full date phrase in target with segment date so month is correct (e.g. "29 September 2025" -> "29 October 2025")
  const targetDateMatch = cleanTarget.match(TARGET_DATE_PHRASE);
  const segmentDateStr = parseSegmentDateToDDMMYYYY(cleanSourceSegment);
  if (targetDateMatch && segmentDateStr) {
    const formatted = formatDatePhraseForLocale(segmentDateStr, targetLocale || 'en');
    cleanTarget = cleanTarget.replace(TARGET_DATE_PHRASE, formatted);
  }

  const targetNumbers = extractNumbersAndDates(cleanTarget);

  // Special case: both sources have a single date+time token, target is already localized (e.g. "18 November 2025 18:40:47")
  // Replace the full date+time in target with segment's date+time so day/month come from segment, not TM
  if (
    sourceNumbers.length === 1 &&
    sourceSegmentNumbers.length === 1 &&
    sourceNumbers[0].type === 'date' &&
    sourceSegmentNumbers[0].type === 'date' &&
    cleanTarget.match(TIME_IN_TARGET)
  ) {
    const segmentDateValue = sourceSegmentNumbers[0].value;
    const timeMatch = segmentDateValue.match(TIME_IN_TARGET);
    const dateOnly = (segmentDateValue.trim().split(/\s+(?=\d{1,2}:\d{2})/)[0]) ?? segmentDateValue.trim();
    const ddMmYyyy = parseSegmentDateToDDMMYYYY(dateOnly);
    const formattedDate = ddMmYyyy
      ? formatDatePhraseForLocale(ddMmYyyy, targetLocale || 'en')
      : formatDateForLocale(dateOnly, targetLocale || 'en');
    const newDateAndTime = timeMatch ? `${formattedDate} ${timeMatch[0]}` : formattedDate;
    const targetDateTimePattern = /\b\d{1,2}\s+(January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{4}\s+\d{1,2}:\d{2}(?::\d{2})?/i;
    if (targetDateTimePattern.test(cleanTarget)) {
      const r = cleanTarget.replace(targetDateTimePattern, newDateAndTime);
      return { applied: true, result: applyClauseSectionFromSegment(r, sourceSegmentText) };
    }
    if (timeMatch) {
      const r = cleanTarget.replace(TIME_IN_TARGET, timeMatch[0]);
      return { applied: true, result: applyClauseSectionFromSegment(r, sourceSegmentText) };
    }
    const r = formatDateForLocale(segmentDateValue, targetLocale || 'en');
    return { applied: true, result: applyClauseSectionFromSegment(r, sourceSegmentText) };
  }

  // Require only segment and target to have the same token count so we can substitute segment numbers into target.
  // TM source may have different structure (e.g. different wording) and is not used for the mapping.
  const sameCount = targetNumbers.length === sourceSegmentNumbers.length && sourceSegmentNumbers.length > 0;
  if (!sameCount) {
    // Fallback 1: replace subsection numbers (X.X.Y e.g. 5.1.8, 5.1.12) so "sub-clause 5.1.12" -> "sub-clause 5.1.8"
    const subsectionPattern = /\d{1,2}\.\d{1,2}\.\d{1,2}/g;
    const segmentSubsections = cleanSourceSegment.match(subsectionPattern) || [];
    const targetSubsections = cleanTarget.match(subsectionPattern) || [];
    if (
      segmentSubsections.length > 0 &&
      segmentSubsections.length === targetSubsections.length
    ) {
      let fallbackResult = cleanTarget;
      for (let i = 0; i < targetSubsections.length; i++) {
        if (targetSubsections[i] !== segmentSubsections[i]) {
          const re = new RegExp(targetSubsections[i].replace(/\./g, '\\.'), 'g');
          fallbackResult = fallbackResult.replace(re, segmentSubsections[i]);
        }
      }
      if (fallbackResult !== cleanTarget) {
        return { applied: true, result: applyClauseSectionFromSegment(fallbackResult, sourceSegmentText) };
      }
    }
    // Fallback 2: replace clause (X.Y) and section (N) when segment has "пункте 1.1" / "разделе 10" and target has "clause 1.3" / "section 18"
    const segmentClauseMatch = cleanSourceSegment.match(/(?:пункте|п\.)\s*(\d{1,2}[.,]\d{1,2})/i);
    const segmentSectionMatch = cleanSourceSegment.match(/разделе?\s*(\d+)/i);
    const targetClauseMatch = cleanTarget.match(/clause\s+(\d{1,2}\.\d{1,2})\b/i);
    const targetSectionMatch = cleanTarget.match(/section\s+(\d+)\b/i);
    const segmentClause = segmentClauseMatch ? segmentClauseMatch[1].replace(',', '.') : null;
    const segmentSection = segmentSectionMatch ? segmentSectionMatch[1] : null;
    const targetClause = targetClauseMatch ? targetClauseMatch[1] : null;
    const targetSection = targetSectionMatch ? targetSectionMatch[1] : null;
    let clauseSectionResult = cleanTarget;
    if (segmentClause && targetClause && segmentClause !== targetClause) {
      clauseSectionResult = clauseSectionResult.replace(
        new RegExp(`(clause\\s+)${targetClause.replace(/\./g, '\\.')}\\b`, 'gi'),
        `$1${segmentClause}`,
      );
    }
    if (segmentSection && targetSection && segmentSection !== targetSection) {
      clauseSectionResult = clauseSectionResult.replace(
        new RegExp(`(section\\s+)${targetSection}\\b`, 'gi'),
        `$1${segmentSection}`,
      );
    }
    if (clauseSectionResult !== cleanTarget) {
      return { applied: true, result: applyClauseSectionFromSegment(clauseSectionResult, sourceSegmentText) };
    }
    return { applied: false, result: targetText };
  }

  let result = cleanTarget;
  const sortedTargetNumbers = [...targetNumbers].sort((a, b) => b.index - a.index);

  for (const targetNum of sortedTargetNumbers) {
    const targetIndex = targetNumbers.indexOf(targetNum);

    if (targetIndex >= 0 && targetIndex < sourceSegmentNumbers.length) {
      const segmentToken = sourceSegmentNumbers[targetIndex];
      const segmentValue = segmentToken.value;
      const sourceType = segmentToken.type;
      const start = targetNum.index;
      const end = targetNum.index + targetNum.value.length;

      if (targetNum.type === 'phone' && sourceType === 'phone') {
        result = result.substring(0, start) + segmentValue + result.substring(end);
      } else if (targetNum.type === 'date' && sourceType === 'date') {
        const formattedDate = formatDateForLocale(segmentValue, targetLocale);
        result = result.substring(0, start) + formattedDate + result.substring(end);
      } else if (targetNum.type === 'number' && sourceType === 'number') {
        const targetVal = targetNum.value;
        const isPlainInteger = (s: string) => /^\d+$/.test(s.replace(/%/g, ''));
        const targetSnippet = result.substring(Math.max(0, start - 60), end + 60);
        const replacement =
          SECTION_NUMBER_PATTERN.test(segmentValue)
            ? segmentValue
            : isPlainInteger(segmentValue) && isPlainInteger(targetVal)
              ? segmentValue
              : formatNumberForLocale(segmentValue, targetLocale, { targetSnippet });
        result = result.substring(0, start) + replacement + result.substring(end);
      }
    }
  }

  result = applyClauseSectionFromSegment(result, sourceSegmentText);
  return { applied: true, result };
}

/**
 * Return the TM target with numbers/dates from the segment source substituted in when possible.
 * Tries substitution whenever segment and TM have the same number of number/date tokens (e.g.
 * amount, tyin, 2027, 12, 20), so a 92% match from a similar clause gets the right figures.
 */
export function applyTmMatchWithNumberSubstitution(
  tmTarget: string,
  tmSource: string,
  segmentSource: string,
  targetLocale: string,
): { applied: boolean; result: string } {
  const { applied, result } = replaceNumbersAndDates(tmTarget, tmSource, segmentSource, targetLocale);
  if (!applied) {
    // Still try clause/section fix on raw TM target (e.g. "clause 1.3" / "section 18" -> segment "пункте 1.1" / "разделе 10")
    const clauseSectionFixed = applyClauseSectionFromSegment(tmTarget, segmentSource);
    if (clauseSectionFixed !== tmTarget && isValidReplacement(tmTarget, clauseSectionFixed, tmSource, segmentSource)) {
      return { applied: true, result: clauseSectionFixed };
    }
    return { applied: false, result: tmTarget };
  }
  if (!isValidReplacement(tmTarget, result, tmSource, segmentSource)) {
    return { applied: false, result: tmTarget };
  }
  // Final pass: ensure leading section (e.g. «3.3.3. ) and clause/section from segment are applied
  const finalResult = applyClauseSectionFromSegment(result, segmentSource);
  return { applied: true, result: finalResult };
}

/**
 * Apply TM match to a segment using backend substitution (numbers, dates, clause/section, leading «X.X.X.).
 * Used when the user applies a TM suggestion from the panel so the same logic as pretranslate runs.
 */
export async function applyTmMatchForSegment(
  segmentId: string,
  tmTarget: string,
  tmSource: string,
): Promise<{ targetText: string }> {
  const segment = await getSegment(segmentId);
  const document = segment.document as { targetLocale: string };
  if (!document?.targetLocale) {
    return { targetText: tmTarget };
  }
  const substituted = applyTmMatchWithNumberSubstitution(
    tmTarget,
    tmSource,
    segment.sourceText,
    document.targetLocale,
  );
  const targetText = ensureLeadingSectionFromSegment(
    substituted.applied ? substituted.result : tmTarget,
    segment.sourceText,
  );
  return { targetText };
}

/**
 * Validate that a replacement result is reasonable
 * Returns false if the replacement is clearly wrong (e.g., section numbers were incorrectly replaced)
 */
function isValidReplacement(
  originalTarget: string,
  replacedTarget: string,
  originalSource: string,
  newSource: string,
): boolean {
  // Check if replacement contains obviously wrong patterns
  // 1. Check for malformed numbers (e.g., "108/11/20010" instead of "11.08.01")
  const malformedNumberPattern = /\d{3,}\/\d{1,2}\/\d{4,}/; // Pattern like "108/11/20010"
  if (malformedNumberPattern.test(replacedTarget) && !malformedNumberPattern.test(originalTarget)) {
    return false;
  }
  
  // 2. Reject mangled section numbers (e.g. "111.045.00" instead of "11.04.05")
  const mangledSectionPattern = /^\d{3,}[./]\d{3,}[./]\d{1,2}\b/;
  if (mangledSectionPattern.test(replacedTarget) && !mangledSectionPattern.test(originalTarget)) {
    return false;
  }

  // 3. Check if section numbers (XX.XX.XX pattern) were incorrectly replaced
  const sectionNumberPattern = /^\d{1,2}\.\d{1,2}\.\d{1,2}\./; // Pattern like "11.08.01."
  const originalHasSectionNumber = sectionNumberPattern.test(originalSource);
  const newHasSectionNumber = sectionNumberPattern.test(newSource);
  
  if (originalHasSectionNumber && newHasSectionNumber) {
    // Both have section numbers - they should be preserved, not replaced
    const originalSectionMatch = originalSource.match(sectionNumberPattern);
    const newSectionMatch = newSource.match(sectionNumberPattern);
    if (originalSectionMatch && newSectionMatch) {
      const originalSection = originalSectionMatch[0];
      const newSection = newSectionMatch[0];
      // If section numbers are different, check if they were incorrectly replaced in target
      if (originalSection !== newSection) {
        // Check if the section number in target was incorrectly modified
        const targetSectionPattern = /^\d{1,2}[./]\d{1,2}[./]\d{1,2}[./]/;
        const targetSectionMatch = replacedTarget.match(targetSectionPattern);
        if (targetSectionMatch) {
          // If target section doesn't match new source section, replacement is wrong
          const targetSection = targetSectionMatch[0].replace(/[./]/g, '.');
          if (targetSection !== newSection) {
            return false;
          }
        }
      }
    }
  }
  
  // 4. Check if the replacement is too different from original (more than 50% length change)
  const lengthDiff = Math.abs(replacedTarget.length - originalTarget.length);
  const maxLength = Math.max(originalTarget.length, replacedTarget.length);
  if (maxLength > 0 && lengthDiff / maxLength > 0.5) {
    return false;
  }
  
  // 5. Check for suspicious patterns: if original had a simple number and replacement has a complex date-like pattern
  const simpleNumberPattern = /^\d{1,2}\.\d{1,2}\.\d{1,2}$/;
  const complexDatePattern = /\d{3,}[./-]\d{1,2}[./-]\d{4,}/;
  if (simpleNumberPattern.test(originalSource) && complexDatePattern.test(replacedTarget)) {
    return false;
  }

  // 6. Reject subsection number with trailing digits (e.g. "5.1.5.1000" or "5.1.5.1000of" when segment has "5.1.5")
  const subsectionWithTrailingDigits = /\d{1,2}\.\d{1,2}\.\d{1,2}\.\d+/;
  if (subsectionWithTrailingDigits.test(replacedTarget) && !subsectionWithTrailingDigits.test(originalTarget)) {
    return false;
  }

  // 7. Reject clause number corrupted to decimal (e.g. "5.10" when segment has "5.1" for clause 5.1)
  const clauseInSegment = newSource.match(/\b(\d{1,2})\.(\d)\b/);
  if (clauseInSegment) {
    const [, major, minor] = clauseInSegment;
    const wrongDecimal = new RegExp(`\\b${major}\\.${minor}\\d+\\b`);
    if (wrongDecimal.test(replacedTarget) && !wrongDecimal.test(originalTarget)) {
      return false;
    }
  }

  // 8. Reject when segment and TM source have different entity names (e.g. " - ТОО «ЭнергоСтройПроект»" vs " - ABM-Building 2007")
  const entityNew = extractEntityAfterDash(newSource);
  const entityOrig = extractEntityAfterDash(originalSource);
  if (
    entityNew &&
    entityOrig &&
    entityNew.length > 2 &&
    entityOrig.length > 2 &&
    !differsOnlyByNumbers(entityNew, entityOrig)
  ) {
    return false;
  }

  // 9. Reject when segment and TM source have different district/location (e.g. "район Алматы" vs "район Sarayshyk")
  const districtNew = extractDistrictName(newSource);
  const districtOrig = extractDistrictName(originalSource);
  if (
    districtNew &&
    districtOrig &&
    districtNew.length > 1 &&
    districtOrig.length > 1 &&
    !differsOnlyByNumbers(districtNew, districtOrig)
  ) {
    return false;
  }

  // If we reach here and nothing was rejected, replacement is acceptable
  if (originalTarget === replacedTarget) {
    return true;
  }

  return true;
}

/** Extract the entity part after " - " and before "," (e.g. company name in "1.1.2 «X» - CompanyName, having...") */
function extractEntityAfterDash(text: string): string | null {
  const match = text.match(/\s-\s+([^,]+)/);
  return match ? match[1].trim() : null;
}

/** Extract district/location name (e.g. "район Алматы" -> "Алматы", "district Sarayshyk" -> "Sarayshyk") */
function extractDistrictName(text: string): string | null {
  const match = text.match(/(?:район|district)\s+([^,]+)/i);
  return match ? match[1].trim() : null;
}

/**
 * Calculate Levenshtein distance between two strings
 */
function levenshteinDistance(a: string, b: string): number {
  const matrix: number[][] = [];
  for (let i = 0; i <= b.length; i++) {
    matrix[i] = [i];
  }
  for (let j = 0; j <= a.length; j++) {
    matrix[0][j] = j;
  }
  for (let i = 1; i <= b.length; i++) {
    for (let j = 1; j <= a.length; j++) {
      if (b.charAt(i - 1) === a.charAt(j - 1)) {
        matrix[i][j] = matrix[i - 1][j - 1];
      } else {
        matrix[i][j] = Math.min(
          matrix[i - 1][j - 1] + 1,
          matrix[i][j - 1] + 1,
          matrix[i - 1][j] + 1,
        );
      }
    }
  }
  return matrix[b.length][a.length];
}

/**
 * Get auto-propagation settings from project AI settings
 */
export const getAutoPropagationSettings = async (projectId: string): Promise<{
  enabled: boolean;
  similarityThreshold: number;
}> => {
  const aiSettings = await prisma.projectAISetting.findUnique({
    where: { projectId },
    select: { config: true },
  });

  // Default settings
  const defaults = {
    enabled: true,
    similarityThreshold: 0.95, // 95% similarity
  };

  if (!aiSettings?.config || typeof aiSettings.config !== 'object') {
    return defaults;
  }

  const config = aiSettings.config as Record<string, unknown>;
  const autoPropagation = config.autoPropagation;

  if (!autoPropagation || typeof autoPropagation !== 'object') {
    return defaults;
  }

  const settings = autoPropagation as Record<string, unknown>;
  return {
    enabled: typeof settings.enabled === 'boolean' ? settings.enabled : defaults.enabled,
    similarityThreshold: typeof settings.similarityThreshold === 'number'
      ? Math.max(0.5, Math.min(1.0, settings.similarityThreshold)) // Clamp between 0.5 and 1.0
      : defaults.similarityThreshold,
  };
};

/**
 * Find similar segments in the same document by source text similarity
 */
export const findSimilarSegmentsInDocument = async (
  documentId: string,
  sourceText: string,
  excludeSegmentId: string,
  similarityThreshold: number = 0.95,
): Promise<Array<{ 
  id: string; 
  sourceText: string; 
  similarity: number;
  differsOnlyByNumbers?: boolean;
}>> => {
  const allSegments = await prisma.segment.findMany({
    where: {
      documentId,
      id: { not: excludeSegmentId },
      status: { not: 'CONFIRMED' }, // Only propagate to non-confirmed segments
    },
    select: {
      id: true,
      sourceText: true,
    },
  });

  if (allSegments.length === 0) {
    return [];
  }

  // Normalize text for comparison (remove formatting, lowercase, trim)
  const normalize = (text: string) => 
    stripFormattingTags(text).toLowerCase().trim();
  
  const normalizedSource = normalize(sourceText);
  if (normalizedSource.length === 0) {
    return [];
  }

  const similarSegments: Array<{ 
    id: string; 
    sourceText: string; 
    similarity: number;
    differsOnlyByNumbers?: boolean;
  }> = [];

  const addedIds = new Set<string>();

  for (const segment of allSegments) {
    const normalizedSegment = normalize(segment.sourceText);
    if (normalizedSegment.length === 0) continue;

    const onlyNumbersDiff = differsOnlyByNumbers(normalizedSource, normalizedSegment);
    const maxLen = Math.max(normalizedSource.length, normalizedSegment.length);
    const distance = levenshteinDistance(normalizedSource, normalizedSegment);
    const similarity = 1 - distance / maxLen;
    const effectiveThreshold = onlyNumbersDiff ? Math.max(0.7, similarityThreshold - 0.1) : similarityThreshold;

    if (similarity >= effectiveThreshold || onlyNumbersDiff) {
      addedIds.add(segment.id);
      similarSegments.push({
        id: segment.id,
        sourceText: segment.sourceText,
        similarity: onlyNumbersDiff ? 0.99 : similarity,
        differsOnlyByNumbers: onlyNumbersDiff,
      });
    }
  }

  // Also propagate to segments with the same leading section number (e.g. 11.02.05.)
  const confirmedSectionMatch = normalizedSource.match(LEADING_SECTION_NUMBER);
  if (confirmedSectionMatch) {
    const sectionPrefix = confirmedSectionMatch[1];
    const restAfterSection = normalizedSource.replace(LEADING_SECTION_NUMBER, '');

    for (const segment of allSegments) {
      if (addedIds.has(segment.id)) continue;
      const normalizedSegment = normalize(segment.sourceText);
      if (normalizedSegment.length === 0) continue;
      const segSectionMatch = normalizedSegment.match(LEADING_SECTION_NUMBER);

      if (segSectionMatch && segSectionMatch[1] === sectionPrefix) {
        addedIds.add(segment.id);
        similarSegments.push({
          id: segment.id,
          sourceText: segment.sourceText,
          similarity: 0.85,
          differsOnlyByNumbers: false,
        });
      } else if (segSectionMatch && restAfterSection.length > 0) {
        // Same structure, different section number (e.g. 11.07.05 vs 11.08.05): same text after the number
        const segRest = normalizedSegment.replace(LEADING_SECTION_NUMBER, '');
        if (segRest === restAfterSection) {
          addedIds.add(segment.id);
          similarSegments.push({
            id: segment.id,
            sourceText: segment.sourceText,
            similarity: 0.95,
            differsOnlyByNumbers: true, // only section number differs, we'll replace it
          });
        }
      }
    }
  }

  return similarSegments.sort((a, b) => b.similarity - a.similarity);
};


