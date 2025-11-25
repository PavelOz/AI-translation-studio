import type { Request, Response, NextFunction } from 'express';
import { verifyToken } from './auth';
import { ApiError } from './apiError';

export interface AuthenticatedRequest extends Request {
  user?: {
    userId: string;
    role: string;
  };
}

export const requireAuth = (req: AuthenticatedRequest, _res: Response, next: NextFunction) => {
  try {
    const header = req.headers.authorization;
    if (!header) {
      return next(ApiError.unauthorized());
    }

    const [, token] = header.split(' ');
    if (!token) {
      return next(ApiError.unauthorized());
    }

    const payload = verifyToken(token);
    req.user = payload;
    next();
  } catch (error) {
    next(error);
  }
};

