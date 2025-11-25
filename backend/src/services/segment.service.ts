import type { SegmentStatus } from '@prisma/client';
import { prisma } from '../db/prisma';
import { ApiError } from '../utils/apiError';
import { upsertTranslationMemoryEntry } from './tm.service';

type SegmentUpdateInput = {
  targetMt?: string | null;
  targetFinal?: string | null;
  status?: SegmentStatus;
  fuzzyScore?: number | null;
  bestTmEntryId?: string | null;
  confirmedById?: string | null;
  confirmedAt?: Date | null;
  timeSpentSeconds?: number | null;
};

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

      await upsertTranslationMemoryEntry({
        projectId: segment.document.projectId,
        sourceLocale: segment.document.sourceLocale,
        targetLocale: segment.document.targetLocale,
        sourceText: updated.sourceText,
        targetText: updated.targetFinal.trim(),
        createdById: userId,
        clientName: segment.document.project.clientName,
        domain: segment.document.project.domain,
        matchRate: 1, // Confirmed segments are 100% matches
      });
    } catch (error) {
      // Log error but don't fail the segment update
      console.error('Failed to add confirmed segment to TM:', error);
    }
  }

  return updated;
};

export const bulkUpsertSegments = (
  segments: Array<{ documentId: string; segmentIndex: number; sourceText: string; targetMt?: string | null; segmentType?: string }>,
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
          // Only update segmentType if it's provided, otherwise keep existing value
          ...(segment.segmentType !== undefined && { segmentType: segment.segmentType }),
        },
        create: {
          ...segment,
          status: 'NEW',
          segmentType: segment.segmentType ?? 'paragraph',
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

      return upsertTranslationMemoryEntry({
        projectId: updated.document.projectId,
        sourceLocale: updated.document.sourceLocale,
        targetLocale: updated.document.targetLocale,
        sourceText: updated.sourceText,
        targetText: updated.targetFinal!.trim(),
        createdById: userId,
        clientName: updated.document.project.clientName,
        domain: updated.document.project.domain,
        matchRate: 1,
      }).catch((error) => {
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


