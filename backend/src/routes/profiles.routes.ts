import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../utils/asyncHandler';
import { requireAuth, AuthenticatedRequest } from '../utils/authMiddleware';
import {
  listProfiles,
  getProfile,
  createProfile,
  updateProfile,
  deleteProfile,
} from '../services/profile.service';

const createProfileSchema = z.object({
  name: z.string().min(1, 'Name is required'),
  expertRole: z.string().optional(),
  instructions: z.string().optional(),
  terminologyJSON: z.unknown().optional(),
});

const updateProfileSchema = z.object({
  name: z.string().min(1).optional(),
  expertRole: z.string().optional(),
  instructions: z.string().optional(),
  terminologyJSON: z.unknown().optional(),
});

export const profileRoutes = Router();

profileRoutes.use(requireAuth);

profileRoutes.get(
  '/',
  asyncHandler(async (_req: AuthenticatedRequest, res) => {
    const profiles = await listProfiles();
    res.json(profiles);
  }),
);

profileRoutes.get(
  '/:profileId',
  asyncHandler(async (req, res) => {
    const profile = await getProfile(req.params.profileId);
    res.json(profile);
  }),
);

profileRoutes.post(
  '/',
  asyncHandler(async (req: AuthenticatedRequest, res) => {
    const payload = createProfileSchema.parse(req.body);
    const profile = await createProfile({
      name: payload.name,
      expertRole: payload.expertRole,
      instructions: payload.instructions,
      terminologyJSON: payload.terminologyJSON,
    });
    res.status(201).json(profile);
  }),
);

profileRoutes.patch(
  '/:profileId',
  asyncHandler(async (req, res) => {
    const payload = updateProfileSchema.parse(req.body);
    const profile = await updateProfile(req.params.profileId, {
      name: payload.name,
      expertRole: payload.expertRole,
      instructions: payload.instructions,
      terminologyJSON: payload.terminologyJSON,
    });
    res.json(profile);
  }),
);

profileRoutes.delete(
  '/:profileId',
  asyncHandler(async (req, res) => {
    await deleteProfile(req.params.profileId);
    res.status(204).send();
  }),
);
