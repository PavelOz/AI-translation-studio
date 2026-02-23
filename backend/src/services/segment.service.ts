import type { SegmentStatus } from '@prisma/client';
import { prisma } from '../db/prisma';
import { ApiError } from '../utils/apiError';
import { upsertTranslationMemoryEntry } from './tm.service';
import { splitIntoSentences, stripFormattingTags } from '../utils/segmentation';

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

  // If segment is confirmed and has targetFinal, add/update it in TM with "Update" flag
  if (data.status === 'CONFIRMED' && updated.targetFinal && updated.targetFinal.trim()) {
    try {
      // Get the confirmedById from the updated segment or use a default system user
      // We need to fetch the updated segment to get confirmedById
      const confirmedSegment = await prisma.segment.findUnique({
        where: { id: segmentId },
        select: { confirmedById: true },
      });
      
      // If no confirmedById, try to get from project members or use first admin
      let userId = confirmedSegment?.confirmedById;
      if (!userId) {
        const projectMember = await prisma.projectMember.findFirst({
          where: { projectId: segment.document.projectId },
          select: { userId: true },
        });
        userId = projectMember?.userId;
      }
      
      if (!userId) {
        console.warn(`Cannot add segment ${segmentId} to TM: no user ID available`);
        return updated;
      }

      // Smart Save: Save as sentences if alignment matches, otherwise as paragraph
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
    } catch (error) {
      // Log error but don't fail the segment update
      console.error('Failed to add confirmed segment to TM:', error);
    }
  }

  return updated;
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


