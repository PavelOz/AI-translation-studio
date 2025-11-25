import { Router } from 'express';
import { authRoutes } from './auth.routes';
import { projectRoutes } from './projects.routes';
import { documentRoutes } from './documents.routes';
import { segmentRoutes } from './segments.routes';
import { tmRoutes } from './tm.routes';
import { glossaryRoutes } from './glossary.routes';
import { aiRoutes } from './ai.routes';
import { chatRoutes } from './chat.routes';
import { reportRoutes } from './reports.routes';
import { healthRoutes } from './health.routes';

export const routes = Router();

routes.use('/health', healthRoutes);
routes.use('/auth', authRoutes);
routes.use('/projects', projectRoutes);
routes.use('/documents', documentRoutes);
routes.use('/segments', segmentRoutes);
routes.use('/tm', tmRoutes);
routes.use('/glossary', glossaryRoutes);
routes.use('/ai', aiRoutes);
routes.use('/chat', chatRoutes);
routes.use('/reports', reportRoutes);

