import type { DocumentFileType, DocumentStatus } from '@prisma/client';
import { prisma } from '../db/prisma';
import { ApiError } from '../utils/apiError';

export type CreateDocumentInput = {
  projectId: string;
  name: string;
  filename?: string;
  fileType?: DocumentFileType;
  sourceLocale: string;
  targetLocale: string;
  storagePath: string;
  wordCount: number;
  totalSegments?: number;
  totalWords?: number;
};

export type DocumentSortField = 'name' | 'size' | 'createdAt' | 'fileType';
export type DocumentSortOrder = 'asc' | 'desc';

export const listDocuments = (
  projectId?: string,
  sortBy: DocumentSortField = 'createdAt',
  sortOrder: DocumentSortOrder = 'desc',
) => {
  // Map sort fields to Prisma field names
  const orderByField: Record<DocumentSortField, string> = {
    name: 'name',
    size: 'totalWords', // Using totalWords as a proxy for file size
    createdAt: 'createdAt',
    fileType: 'fileType',
  };

  return prisma.document.findMany({
    where: projectId ? { projectId } : undefined,
    include: { project: true },
    orderBy: {
      [orderByField[sortBy]]: sortOrder,
    },
  });
};

export const createDocument = (input: CreateDocumentInput) =>
  prisma.document.create({
    data: {
      ...input,
      filename: input.filename ?? input.name,
      fileType: input.fileType,
      totalSegments: input.totalSegments ?? 0,
      totalWords: input.totalWords ?? input.wordCount,
      status: 'NEW',
    },
  });

export const getDocument = async (documentId: string) => {
  const document = await prisma.document.findUnique({
    where: { id: documentId },
    include: { segments: true },
  });
  if (!document) {
    throw ApiError.notFound('Document not found');
  }
  return document;
};

export const updateDocumentStatus = (documentId: string, status: DocumentStatus) =>
  prisma.document.update({
    where: { id: documentId },
    data: { status },
  });

export const updateDocument = async (
  documentId: string,
  data: { name?: string; filename?: string; sourceLocale?: string; targetLocale?: string; status?: DocumentStatus },
) => {
  const document = await prisma.document.findUnique({ where: { id: documentId } });
  if (!document) {
    throw ApiError.notFound('Document not found');
  }
  return prisma.document.update({
    where: { id: documentId },
    data,
  });
};

export const deleteDocument = async (documentId: string) => {
  const document = await prisma.document.findUnique({ where: { id: documentId } });
  if (!document) {
    throw ApiError.notFound('Document not found');
  }

  // Delete physical file
  const fs = await import('fs/promises');
  try {
    await fs.unlink(document.storagePath);
  } catch (error) {
    // File may not exist, continue with deletion
  }

  // Manual cascade deletion in transaction to avoid foreign key violations
  return prisma.$transaction(async (tx) => {
    // Delete in order: child records first, then parent
    // 1. Fetch all segment IDs for this document
    const segments = await tx.segment.findMany({ 
      where: { documentId }, 
      select: { id: true } 
    });
    const segmentIds = segments.map((s) => s.id);
    
    // 2. Delete quality metrics
    await tx.qualityMetric.deleteMany({ where: { segmentId: { in: segmentIds } } });
    
    // 3. Delete segments
    await tx.segment.deleteMany({ where: { documentId } });
    
    // 4. Delete AI requests
    await tx.aIRequest.deleteMany({ where: { documentId } });
    
    // 5. Delete chat messages (for document and segments)
    await tx.chatMessage.deleteMany({ where: { documentId } });
    await tx.chatMessage.deleteMany({ where: { segmentId: { in: segmentIds } } });
    
    // 6. Finally, delete the document itself
    return tx.document.delete({ where: { id: documentId } });
  });
};

