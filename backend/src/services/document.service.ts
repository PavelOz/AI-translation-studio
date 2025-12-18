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

export const listDocuments = (projectId?: string) =>
  prisma.document.findMany({
    where: projectId ? { projectId } : undefined,
    include: { project: true },
  });

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
  return prisma.document.delete({ where: { id: documentId } });
};

