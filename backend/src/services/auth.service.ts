import type { UserRole } from '@prisma/client';
import { prisma } from '../db/prisma';
import { ApiError } from '../utils/apiError';
import { hashPassword, comparePassword, signToken } from '../utils/auth';

export type RegisterInput = {
  email: string;
  password: string;
  name: string;
  role: UserRole;
};

export const registerUser = async ({ email, password, name, role }: RegisterInput) => {
  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) {
    throw ApiError.badRequest('Email already in use');
  }

  const passwordHash = await hashPassword(password);
  const user = await prisma.user.create({
    data: { email, passwordHash, name, role },
    select: { id: true, email: true, name: true, role: true },
  });

  return user;
};

export const authenticateUser = async (email: string, password: string) => {
  const user = await prisma.user.findUnique({ where: { email } });
  if (!user) {
    throw ApiError.unauthorized('Invalid credentials');
  }

  const valid = await comparePassword(password, user.passwordHash);
  if (!valid) {
    throw ApiError.unauthorized('Invalid credentials');
  }

  const token = signToken({ userId: user.id, role: user.role });
  const safeUser = { id: user.id, email: user.email, name: user.name, role: user.role };

  return { token, user: safeUser };
};

export const getCurrentUser = async (userId: string) => {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, email: true, name: true, role: true },
  });
  if (!user) {
    throw ApiError.notFound('User not found');
  }
  return user;
};

