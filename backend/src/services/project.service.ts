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
  const project = await prisma.project.findUnique({ where: { id: projectId } });
  if (!project) {
    throw ApiError.notFound('Project not found');
  }
  return prisma.project.delete({ where: { id: projectId } });
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

