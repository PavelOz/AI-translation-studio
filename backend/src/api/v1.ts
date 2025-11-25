import { Router } from 'express';
import { routes } from '../routes';

export const apiV1 = Router();

apiV1.use('/', routes);

