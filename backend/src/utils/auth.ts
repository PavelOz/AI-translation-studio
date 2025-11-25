import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import type { UserRole } from '@prisma/client';
import { env } from './env';
import { ApiError } from './apiError';

export const hashPassword = async (password: string) => {
  const salt = await bcrypt.genSalt(10);
  return bcrypt.hash(password, salt);
};

export const comparePassword = (password: string, hash: string) => bcrypt.compare(password, hash);

type TokenPayload = {
  userId: string;
  role: UserRole;
};

export const signToken = (payload: TokenPayload) =>
  jwt.sign(payload, env.jwtSecret, { expiresIn: '12h' });

export const verifyToken = (token: string) => {
  try {
    return jwt.verify(token, env.jwtSecret) as TokenPayload;
  } catch {
    throw ApiError.unauthorized();
  }
};

