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
  summary?: string;
};

export const listDocuments = (projectId?: string) =>
  prisma.document.findMany({
    where: projectId ? { projectId } : undefined,
    include: { project: true },
  });

export type ListDocumentsPaginatedResult = {
  documents: Awaited<ReturnType<typeof listDocuments>>;
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
};

export const listDocumentsPaginated = async (
  projectId: string,
  page = 1,
  pageSize = 20,
): Promise<ListDocumentsPaginatedResult> => {
  const skip = (page - 1) * pageSize;
  const [documents, total] = await Promise.all([
    prisma.document.findMany({
      where: { projectId },
      include: { project: true, profile: { select: { id: true, name: true } } },
      orderBy: { createdAt: 'desc' },
      skip,
      take: pageSize,
    }),
    prisma.document.count({ where: { projectId } }),
  ]);
  return {
    documents,
    page,
    pageSize,
    total,
    totalPages: Math.max(1, Math.ceil(total / pageSize)),
  };
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
      summary: input.summary,
    },
  });

export const getDocument = async (documentId: string) => {
  const document = await prisma.document.findUnique({
    where: { id: documentId },
    include: {
      segments: true,
      profile: { select: { id: true, name: true } },
    },
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
  data: {
    name?: string;
    filename?: string;
    sourceLocale?: string;
    targetLocale?: string;
    status?: DocumentStatus;
    profileId?: string | null;
  },
) => {
  const document = await prisma.document.findUnique({ where: { id: documentId } });
  if (!document) {
    throw ApiError.notFound('Document not found');
  }
  return prisma.document.update({
    where: { id: documentId },
    data,
    include: {
      profile: { select: { id: true, name: true } },
    },
  });
};

export const deleteDocument = async (documentId: string) => {
  const document = await prisma.document.findUnique({ where: { id: documentId } });
  if (!document) {
    throw ApiError.notFound('Document not found');
  }
  return prisma.document.delete({ where: { id: documentId } });
};

