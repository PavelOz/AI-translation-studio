import { Router } from 'express';
import { z } from 'zod';
import { registerUser, authenticateUser, getCurrentUser } from '../services/auth.service';
import { asyncHandler } from '../utils/asyncHandler';
import { requireAuth, AuthenticatedRequest } from '../utils/authMiddleware';

const registerSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8),
  name: z.string(),
  role: z.enum(['ADMIN', 'PROJECT_MANAGER', 'LINGUIST']),
});

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string(),
});

export const authRoutes = Router();

authRoutes.post(
  '/register',
  asyncHandler(async (req, res) => {
    const payload = registerSchema.parse(req.body);
    const user = await registerUser(payload);
    res.status(201).json(user);
  }),
);

authRoutes.post(
  '/login',
  asyncHandler(async (req, res) => {
    const payload = loginSchema.parse(req.body);
    const result = await authenticateUser(payload.email, payload.password);
    res.json(result);
  }),
);

authRoutes.get(
  '/me',
  requireAuth,
  asyncHandler(async (req: AuthenticatedRequest, res) => {
    const user = await getCurrentUser(req.user!.userId);
    res.json(user);
  }),
);

authRoutes.post(
  '/logout',
  requireAuth,
  asyncHandler(async (_req, res) => {
    // Stateless JWT logout: client should discard token.
    res.status(204).send();
  }),
);

