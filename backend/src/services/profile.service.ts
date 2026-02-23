import { prisma } from '../db/prisma';
import { ApiError } from '../utils/apiError';

export type CreateProfileInput = {
  name: string;
  expertRole?: string;
  instructions?: string;
  terminologyJSON?: unknown;
};

export type UpdateProfileInput = {
  name?: string;
  expertRole?: string;
  instructions?: string;
  terminologyJSON?: unknown;
};

export const listProfiles = async () =>
  prisma.profile.findMany({
    orderBy: { name: 'asc' },
    select: {
      id: true,
      name: true,
      expertRole: true,
      instructions: true,
      terminologyJSON: true,
    },
  });

export const getProfile = async (id: string) => {
  const profile = await prisma.profile.findUnique({
    where: { id },
    select: {
      id: true,
      name: true,
      expertRole: true,
      instructions: true,
      terminologyJSON: true,
    },
  });
  if (!profile) {
    throw ApiError.notFound('Profile not found');
  }
  return profile;
};

export const createProfile = async (data: CreateProfileInput) =>
  prisma.profile.create({
    data: {
      name: data.name.trim(),
      expertRole: data.expertRole?.trim() ?? '',
      instructions: data.instructions?.trim() ?? '',
      terminologyJSON: data.terminologyJSON ?? undefined,
    },
    select: {
      id: true,
      name: true,
      expertRole: true,
      instructions: true,
      terminologyJSON: true,
    },
  });

export const updateProfile = async (id: string, data: UpdateProfileInput) => {
  await getProfile(id);
  return prisma.profile.update({
    where: { id },
    data: {
      ...(data.name !== undefined && { name: data.name.trim() }),
      ...(data.expertRole !== undefined && { expertRole: data.expertRole.trim() }),
      ...(data.instructions !== undefined && { instructions: data.instructions.trim() }),
      ...(data.terminologyJSON !== undefined && { terminologyJSON: data.terminologyJSON }),
    },
    select: {
      id: true,
      name: true,
      expertRole: true,
      instructions: true,
      terminologyJSON: true,
    },
  });
};

export const deleteProfile = async (id: string) => {
  await getProfile(id);
  await prisma.profile.delete({ where: { id } });
};
