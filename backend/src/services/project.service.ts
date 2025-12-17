import type { ProjectStatus, UserRole } from '@prisma/client';
import { prisma } from '../db/prisma';
import { ApiError } from '../utils/apiError';

export type CreateProjectInput = {
  name: string;
  description?: string;
  clientName?: string;
  sourceLocale: string;
  sourceLang?: string;
  targetLocales: string[];
  targetLang?: string;
  domain?: string;
  dueDate?: Date;
  createdById: string;
};

export const listProjects = async (userId: string) =>
  prisma.project.findMany({
    where: {
      members: {
        some: {
          userId,
        },
      },
    },
    include: {
      documents: true,
    },
  });

export const createProject = async ({
  name,
  description,
  clientName,
  sourceLocale,
  sourceLang,
  targetLocales,
  targetLang,
  domain,
  dueDate,
  createdById,
}: CreateProjectInput) => {
  // Verify that the user exists before creating the project
  const user = await prisma.user.findUnique({
    where: { id: createdById },
  });

  if (!user) {
    throw ApiError.notFound(`User with ID ${createdById} not found`);
  }

  return prisma.project.create({
    data: {
      name,
      description,
      clientName,
      domain,
      sourceLocale,
      sourceLang: sourceLang ?? sourceLocale,
      targetLocales,
      targetLang: targetLang ?? targetLocales[0],
      dueDate,
      status: 'PLANNING',
      members: {
        create: {
          userId: createdById,
          role: 'PROJECT_MANAGER',
        },
      },
    },
    include: {
      members: true,
    },
  });
};

export const updateProjectStatus = async (projectId: string, status: ProjectStatus) => {
  return prisma.project.update({
    where: { id: projectId },
    data: { status },
  });
};

export const getProject = async (projectId: string) => {
  const project = await prisma.project.findUnique({
    where: { id: projectId },
    include: { documents: true, members: { include: { user: true } } },
  });
  if (!project) {
    throw ApiError.notFound('Project not found');
  }
  return project;
};

export type UpdateProjectInput = {
  name?: string;
  description?: string;
  clientName?: string;
  sourceLang?: string;
  sourceLocale?: string;
  targetLocales?: string[];
  targetLang?: string;
  domain?: string;
  dueDate?: Date;
};

export const updateProject = async (projectId: string, data: UpdateProjectInput) => {
  const project = await prisma.project.findUnique({ where: { id: projectId } });
  if (!project) {
    throw ApiError.notFound('Project not found');
  }
  return prisma.project.update({
    where: { id: projectId },
    data: {
      ...data,
      dueDate: data.dueDate,
    },
  });
};

export const deleteProject = async (projectId: string) => {
  const project = await prisma.project.findUnique({ 
    where: { id: projectId },
    include: { documents: true },
  });
  if (!project) {
    throw ApiError.notFound('Project not found');
  }

  // Delete physical files for all documents
  const fs = await import('fs/promises');
  for (const document of project.documents) {
    try {
      await fs.unlink(document.storagePath);
    } catch (error) {
      // File may not exist, continue with deletion
    }
  }

  // Manual cascade deletion in transaction to avoid foreign key violations
  return prisma.$transaction(async (tx) => {
    // Delete in order: child records first, then parent
    // 1. Translation Memory entries and files
    await tx.translationMemoryEntry.deleteMany({ where: { projectId } });
    await tx.translationMemoryFile.deleteMany({ where: { projectId } });
    
    // 2. Documents (which cascade segments, AI requests, etc. if relations have onDelete: Cascade)
    // But we need to manually handle segments and AI requests
    const documents = await tx.document.findMany({ where: { projectId }, select: { id: true } });
    for (const doc of documents) {
      // Delete segments and their related records
      const segments = await tx.segment.findMany({ where: { documentId: doc.id }, select: { id: true } });
      const segmentIds = segments.map((s) => s.id);
      
      // Delete quality metrics
      await tx.qualityMetric.deleteMany({ where: { segmentId: { in: segmentIds } } });
      
      // Delete segments
      await tx.segment.deleteMany({ where: { documentId: doc.id } });
      
      // Delete AI requests
      await tx.aIRequest.deleteMany({ where: { documentId: doc.id } });
      
      // Delete chat messages for document
      await tx.chatMessage.deleteMany({ where: { documentId: doc.id } });
    }
    
    // Delete documents
    await tx.document.deleteMany({ where: { projectId } });
    
    // 3. Project members
    await tx.projectMember.deleteMany({ where: { projectId } });
    
    // 4. Glossary entries
    await tx.glossaryEntry.deleteMany({ where: { projectId } });
    
    // 5. Reports
    await tx.report.deleteMany({ where: { projectId } });
    
    // 6. Project AI settings (has @unique on projectId)
    await tx.projectAISetting.deleteMany({ where: { projectId } });
    
    // 7. Project guidelines (has @unique on projectId)
    await tx.projectGuideline.deleteMany({ where: { projectId } });
    
    // 8. Chat messages
    await tx.chatMessage.deleteMany({ where: { projectId } });
    
    // 9. Finally, delete the project itself
    return tx.project.delete({ where: { id: projectId } });
  });
};

export const addProjectMember = async (projectId: string, userId: string, role: UserRole) => {
  const project = await prisma.project.findUnique({ where: { id: projectId } });
  if (!project) {
    throw ApiError.notFound('Project not found');
  }
  return prisma.projectMember.create({
    data: { projectId, userId, role },
    include: { user: true },
  });
};

export const removeProjectMember = async (projectId: string, userId: string) => {
  const member = await prisma.projectMember.findUnique({
    where: { projectId_userId: { projectId, userId } },
  });
  if (!member) {
    throw ApiError.notFound('Project member not found');
  }
  return prisma.projectMember.delete({
    where: { projectId_userId: { projectId, userId } },
  });
};

export const getProjectMembers = async (projectId: string) => {
  return prisma.projectMember.findMany({
    where: { projectId },
    include: { user: true },
  });
};

